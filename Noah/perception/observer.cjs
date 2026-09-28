// Noah/perception/observer.cjs
//
// Builds a structured Observation of the active guest page by fusing the three
// perception layers:
//
//   Layer 1  semantic   AX tree (roles/names/states) + element geometry + page text
//   Layer 2  visual     screenshot + FrameGeometry (only when requested)
//   Layer 3  hints      canvas coverage, AX poverty, editable surfaces, secret fields
//
// Observation shape (spec §22):
//   { id, url, title, origin, loading, readyState, viewport:{width,height,devicePixelRatio,zoomFactor,
//     scrollX,scrollY,scrollWidth,scrollHeight}, tabs[], frames[], elements[] (interactiveElements),
//     accessibilityTree{nodeCount,interactiveCount}, pageText{viewport,content}, screenshot?,
//     dialog?, focused?, hints{}, security{findings,tainted} }
//
// The model never receives this object raw: agent/context.cjs renders and
// compresses it under a token budget.

"use strict";

const ax = require("./ax.cjs");
const { captureFrame, captureRegion } = require("./screenshot.cjs");
const { recognizeText } = require("./ocr.cjs");
const color = require("./color.cjs");

const CONCURRENCY = 24;

// Runs inside Noah's isolated world of the main frame. Must never throw.
const SCAN_SCRIPT = `(() => {
  try {
    const t0 = performance.now();
    const vw = innerWidth, vh = innerHeight;
    const vis = (el) => { try { return el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true; } catch (e) { return true; } };
    const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; };
    const inView = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;

    // ---- visible text (what is actually on screen right now)
    const lines = []; let cur = ""; let lastTop = null; let nodes = 0;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement; if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName; if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return NodeFilter.FILTER_REJECT;
        return /\\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      if (++nodes > 6000 || performance.now() - t0 > 40) break;
      const p = n.parentElement;
      const range = document.createRange(); range.selectNodeContents(n);
      const rc = range.getBoundingClientRect();
      if (!inView({ width: rc.width, height: rc.height, top: rc.top, bottom: rc.bottom, left: rc.left, right: rc.right })) continue;
      if (!vis(p)) continue;
      const s = n.nodeValue.replace(/\\s+/g, " ").trim();
      if (lastTop !== null && Math.abs(rc.top - lastTop) > 6) { if (cur) lines.push(cur); cur = ""; }
      cur += (cur ? " " : "") + s; lastTop = rc.top;
      if (lines.length > 220) break;
    }
    if (cur) lines.push(cur);
    const viewportText = lines.join("\\n").slice(0, 9000);

    // ---- main content text (may extend beyond the viewport)
    let contentText = "";
    try {
      const main = document.querySelector("main, [role=main], article") || document.body;
      contentText = (main && main.innerText || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 14000);
    } catch (e) {}

    // ---- canvas / visual-only surfaces
    let canvasArea = 0, canvasCount = 0;
    for (const c of document.querySelectorAll("canvas")) {
      const r = rectOf(c); if (!inView({ width: r.width, height: r.height, top: r.y, bottom: r.y + r.height, left: r.x, right: r.x + r.width })) continue;
      canvasCount++;
      const w = Math.min(r.x + r.width, vw) - Math.max(r.x, 0), h = Math.min(r.y + r.height, vh) - Math.max(r.y, 0);
      if (w > 0 && h > 0) canvasArea += w * h;
    }
    const canvasCoverage = Math.min(1, canvasArea / Math.max(1, vw * vh));

    // ---- secret inputs (rects) so they can be masked/flagged
    const secretRects = [];
    for (const el of document.querySelectorAll('input[type=password], input[autocomplete^="cc-"], input[autocomplete="one-time-code"], input[name*="card" i], input[name*="cvv" i], input[name*="ssn" i]')) {
      const r = rectOf(el); if (r.width > 0 && r.height > 0) secretRects.push({ x: r.x, y: r.y, width: r.width, height: r.height, kind: el.type === "password" ? "password" : "payment" });
    }
    const hasPassword = !!document.querySelector("input[type=password]");
    const hasPayment = !!document.querySelector('input[autocomplete^="cc-"], input[name*="card" i], input[name*="cvv" i]');

    // ---- focus / editing surfaces
    const ae = document.activeElement;
    let focused = null;
    if (ae && ae !== document.body && ae !== document.documentElement) {
      focused = {
        tag: ae.tagName.toLowerCase(), type: ae.type || undefined, role: ae.getAttribute && ae.getAttribute("role") || undefined,
        label: (ae.getAttribute && (ae.getAttribute("aria-label") || ae.getAttribute("placeholder") || ae.getAttribute("name") || ae.id)) || undefined,
        editable: !!ae.isContentEditable || ae.tagName === "TEXTAREA" || (ae.tagName === "INPUT" && !/^(button|submit|checkbox|radio|reset|image|file)$/.test(ae.type || "")),
        valueLength: typeof ae.value === "string" ? ae.value.length : undefined,
        isPassword: ae.type === "password",
      };
      if (ae.tagName === "IFRAME") focused.tag = "iframe";
    }
    const editableCount = document.querySelectorAll('[contenteditable=""],[contenteditable="true"],textarea,input:not([type=hidden]):not([type=button]):not([type=submit])').length;

    let selection = ""; try { selection = String(getSelection()).slice(0, 300); } catch (e) {}
    const de = document.documentElement;
    return {
      ok: true, url: location.href, title: document.title || "", readyState: document.readyState,
      scrollX: Math.round(scrollX), scrollY: Math.round(scrollY),
      scrollWidth: de.scrollWidth, scrollHeight: de.scrollHeight, innerWidth: vw, innerHeight: vh, dpr: devicePixelRatio,
      viewportText, contentText, canvasCount, canvasCoverage, secretRects, hasPassword, hasPayment, focused,
      editableCount, selection, iframeCount: document.querySelectorAll("iframe").length,
      lang: de.lang || "", scanMs: Math.round(performance.now() - t0), textNodes: nodes,
    };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
})()`;

// Which QUESTION does each radio / checkbox answer?  The accessibility tree only knows when the page marks the group up
// (<fieldset><legend>, role=radiogroup + aria-labelledby). Most hand-made quiz and survey pages do not: a bold <div> with the question,
// then labelled radios, nothing tying the two together - so the agent showed a model twenty options named "36", "42", "48"... with no
// question on any of them, and the model (or the form module) could only guess. This reads the structure that IS there: controls sharing
// a `name` are one question, and its text is what sits between the previous control and this group's first one, outside the option
// labels. Returns one row per control: [cx, cy, w, h, group, question, checked, required] in viewport CSS px (matched to AX elements by
// position, the same way link hrefs are).
const CHOICE_SCAN = `(() => {
  try {
    const CHOICE = 'input[type=radio],input[type=checkbox],[role=radio],[role=checkbox],[role=menuitemradio],[role=menuitemcheckbox]';
    const all = Array.from(document.querySelectorAll(CHOICE)).slice(0, 500);
    const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
    // native <select>s: the accessibility tree lists a closed dropdown as one "combobox" with only its current value, none of its options
    const selects = [];
    for (const s of Array.from(document.querySelectorAll('select')).slice(0, 100)) {
      const r = s.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
      selects.push([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), Math.round(r.width), Math.round(r.height),
        Array.from(s.options).slice(0, 200).map((o) => [clean(o.label || o.text).slice(0, 120), !!o.selected, !!o.disabled]), !!s.multiple]);
    }
    const vis = (el) => { try { return el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true; } catch (e) { return true; } };

    // Text answer boxes (<textarea>, text-like <input>): which problem/question sits next to each? A page of 30 problems that gives every
    // answer box the same placeholder ("Write your complete solution here...") looks like ONE question to the accessibility tree.
    // The question is the nearest preceding block of text, stopping at anything that holds another control. \`explicit\` = the page
    // labelled this control itself (<label>, aria-label, aria-labelledby, title): then the accessibility name is the better source.
    const CONTROL = 'input,textarea,select,button,[contenteditable=""],[contenteditable="true"],[role=textbox],' + CHOICE;
    const hasControl = (n) => !!(n.matches && (n.matches(CONTROL) || n.querySelector(CONTROL)));
    const NOISE = /^(?:\\d+\\s*(?:\\/|of)\\s*\\d+.*|\\d+\\s*(?:characters?|chars?|words?)\\b.*|saved|draft saved|required|optional|\\*|max\\b.*|word count.*)$/i;
    const questionBefore = (el) => {
      let cur = el;
      for (let hop = 0; hop < 5 && cur && cur !== document.body && cur !== document.documentElement; hop++, cur = cur.parentElement) {
        for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) {
          if (hasControl(s)) return '';          // that is another question's territory
          if (!vis(s)) continue;
          const t = clean(s.innerText || s.textContent);
          if (t.length >= 6 && !NOISE.test(t)) return t.length > 400 ? t.slice(0, 399) + '…' : t;
        }
      }
      return '';
    };
    const texts = [];
    const TEXTUAL = 'textarea,input:not([type]),input[type=text],input[type=email],input[type=tel],input[type=url],input[type=number],input[type=search]';
    for (const el of Array.from(document.querySelectorAll(TEXTUAL)).slice(0, 300)) {
      const r = el.getBoundingClientRect(); if (r.width < 20 || r.height < 10 || !vis(el)) continue;
      const explicit = !!((el.labels && el.labels.length) || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title'));
      texts.push([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), Math.round(r.width), Math.round(r.height), questionBefore(el), explicit]);
    }
    if (!all.length) return { choices: [], selects, texts };
    const order = new Map(all.map((el, i) => [el, i]));

    // the text that belongs to an option (its <label>, or the bare text right after a control up to the next <br>/block/control)
    const optionText = new WeakSet();
    const ownText = new Map(); // control -> its own loose text (a bare <input> has no accessible name without a <label>)
    for (const el of all) {
      let own = '';
      for (let s = el.nextSibling; s; s = s.nextSibling) {
        if (s.nodeType === 3) { optionText.add(s); own += ' ' + s.nodeValue; continue; }
        if (s.nodeType !== 1 || s.tagName === 'BR' || s.matches(CHOICE) || s.querySelector(CHOICE)) break;
        if (getComputedStyle(s).display.startsWith('inline')) { for (const w = document.createTreeWalker(s, NodeFilter.SHOW_TEXT); w.nextNode();) { optionText.add(w.currentNode); own += ' ' + w.currentNode.nodeValue; } } else break;
      }
      ownText.set(el, clean(own));
    }

    // group: same-named radios/checkboxes in one form are ONE question; custom widgets group by their ARIA/fieldset ancestor; else alone
    const groups = new Map();
    for (const el of all) {
      let key;
      if (el.tagName === 'INPUT' && el.name) key = (el.form ? 'form' + Array.prototype.indexOf.call(document.forms, el.form) : 'doc') + '|' + el.type + '|' + el.name;
      else key = el.closest('[role=radiogroup],[role=group],fieldset') || el;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(el);
    }

    const lca = (els) => { let a = els[0]; while (a && !els.every((e) => a.contains(e))) a = a.parentElement; return a; };
    const questionOf = (els) => {
      const first = els[0];
      const fi = order.get(first);
      // nearest control BEFORE this group that belongs to some other group: the question is the text after it (flat forms have no wrapper)
      let prev = null;
      for (let i = fi - 1; i >= 0; i--) if (!els.includes(all[i])) { prev = all[i]; break; }
      let c = lca(els);
      if (!c || c === first) c = first.parentElement;
      for (let hop = 0; hop < 6 && c && c !== document.body && c !== document.documentElement; hop++, c = c.parentElement) {
        const parts = [];
        const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT, { acceptNode(n) {
          const p = n.parentElement; if (!p || !/\\S/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
          const tag = p.tagName; if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'OPTION' || tag === 'BUTTON') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT; } });
        let n;
        while ((n = w.nextNode())) {
          if (first.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) break;              // reached the options
          if (prev && !(prev.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;  // belongs to an earlier question
          if (optionText.has(n) || !vis(n.parentElement)) continue;
          let isOption = false;
          for (let a = n.parentElement; a && a !== c; a = a.parentElement) if (a.tagName === 'LABEL' || a.matches(CHOICE) || a.querySelector(CHOICE)) { isOption = true; break; }
          if (!isOption) parts.push(clean(n.nodeValue));
        }
        const t = clean(parts.join(' '));
        if (t) return t.length > 300 ? t.slice(0, 299) + '…' : t;
        // nothing at this level: widen (text of another question is already excluded by the "after prev / before first" limits)
      }
      return '';
    };

    const rows = [];
    let gi = 0;
    let prevQ = '', prevId = -1, prevType = '';
    const t0 = performance.now();
    for (const els of groups.values()) {
      let q = performance.now() - t0 > 250 ? '' : questionOf(els); // time budget: a huge page degrades to "no question text", never to a slow observation
      let id = gi++;
      const type = els[0].type || els[0].getAttribute('role') || '';
      // "Tick all that apply": checkboxes with DIFFERENT names under one title. No text of their own between them = the same question.
      if (!q && prevQ && type === prevType) { q = prevQ; id = prevId; gi--; }
      else { prevQ = q; prevId = id; prevType = type; }
      for (const el of els) {
        const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
        rows.push([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), Math.round(r.width), Math.round(r.height), id, q,
          !!(el.checked || el.getAttribute('aria-checked') === 'true'), !!(el.required || el.getAttribute('aria-required') === 'true'),
          (el.labels && el.labels.length ? '' : (ownText.get(el) || '').slice(0, 120))]);
      }
    }
    return { choices: rows, selects, texts };
  } catch (e) { return { choices: [], selects: [], texts: [] }; }
})()`;

// Deep scan: pointer-cursor elements the AX tree does not expose (div "buttons").
const CLICKABLE_SCAN = `(() => {
  try {
    const vw = innerWidth, vh = innerHeight; const out = []; const seen = new Set();
    const all = document.body ? document.body.querySelectorAll("*") : [];
    let count = 0;
    for (const el of all) {
      if (++count > 5000) break;
      const tag = el.tagName; if (tag === "BODY" || tag === "HTML" || tag === "A" || tag === "BUTTON" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") continue;
      const r = el.getBoundingClientRect(); if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      const cs = getComputedStyle(el); if (cs.cursor !== "pointer" || cs.visibility === "hidden" || cs.pointerEvents === "none") continue;
      const p = el.parentElement; if (p && getComputedStyle(p).cursor === "pointer" && p.tagName !== "BODY") continue; // only the outermost pointer element
      if (el.closest("a,button,[role=button],[role=link],input,select,textarea,[role=tab],[role=menuitem]")) continue;
      const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.getAttribute("alt") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
      out.push({ el, label, area: r.width * r.height });
      if (out.length > 200) break;
    }
    out.sort((a, b) => b.area - a.area);
    globalThis.__noahClickables = out.slice(0, 40).map(o => o.el);
    return out.slice(0, 40).map(o => o.label);
  } catch (e) { return []; }
})()`;

// A toolbar icon that is only a <div title="Ellipse"> (no <button>, no role, no aria-label) is invisible to the accessibility
// tree: Chromium gives a plain, non-interactive <div> the role "generic", which Noah (like any AX-based agent) treats as
// noise, not a control - even though the element has a perfectly good name sitting right on it in the "title" attribute
// (jspaint's whole toolbar - Pencil, Ellipse, Fill With Color, ... - is built exactly this way). Promote small,
// visible, title-only elements that are not already a real control, so they become clickable by that name.
// A <canvas> can never carry text of its own - a drawing surface, a chart, a game board - so the ONLY way one can
// ever be findable by name at all is a title/aria-label the page's own author put on it. Unlike TITLE_SCAN (deliberately
// capped at toolbar-icon size, since a big unlabelled div could be anything), a canvas that carries an explicit label
// is exactly the element an agent needs the position of (e.g. to know where the drawing area is), so this scan
// allows any reasonable size and is a separate, narrower rule: canvas elements ONLY, and ONLY when the author
// bothered to name it - never invents a name from a canvas's absence of content.
const NAMED_CANVAS_SCAN = `(() => {
  try {
    const vw = innerWidth, vh = innerHeight; const out = [];
    for (const el of document.querySelectorAll("canvas[title], canvas[aria-label]")) {
      const label = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
      if (!label || label.length > 80) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.width > 4000 || r.height > 4000) continue;
      let cs; try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      out.push({ el, label, inView });
    }
    const top = out.slice(0, 20);
    globalThis.__noahNamedCanvases = top.map((o) => o.el);
    return top.map((o) => ({ label: o.label, inView: o.inView }));
  } catch (e) { return []; }
})()`;

const TITLE_SCAN = `(() => {
  try {
    const vw = innerWidth, vh = innerHeight; const out = []; let seen = 0;
    for (const el of document.querySelectorAll("[title]")) {
      if (++seen > 3000) break;
      const title = (el.getAttribute("title") || "").trim();
      if (!title || title.length > 80) continue;
      if (el.closest("a,button,input,select,textarea,[role],[aria-label],[contenteditable]")) continue; // already a real control
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6 || r.width > 300 || r.height > 300) continue;
      let cs; try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (cs.visibility === "hidden" || cs.display === "none" || cs.pointerEvents === "none") continue;
      try { if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue; } catch (e) {}
      const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      out.push({ el, title, area: r.width * r.height, inView });
    }
    out.sort((a, b) => a.area - b.area); // small icon-like elements are more likely a real control than a big wrapper
    const top = out.slice(0, 60);
    globalThis.__noahTitled = top.map((o) => o.el);
    return top.map((o) => ({ title: o.title, inView: o.inView }));
  } catch (e) { return []; }
})()`;

// A colour-picker swatch (a paint program's palette, any custom colour picker) is normally a bare, unlabelled
// coloured square: jspaint's are literally `<div class="swatch color-button" data-color="rgb(0,0,255)"><canvas></canvas></div>`
// - no text, no title, no aria-label, nothing an accessibility tree or OCR could ever read as "blue". Two cheap,
// targeted passes (never the full-page walk _addClickables does): elements carrying a data-color-style attribute
// (the common convention for custom colour pickers), and small <canvas> swatches sampled directly. The actual
// naming (RGB -> "blue") happens in Node via perception/color.cjs; this script only reports the raw colour string.
const SWATCH_SCAN = `(() => {
  try {
    const vw = innerWidth, vh = innerHeight; const out = []; const seen = new Set();
    const add = (el, colorStr) => {
      if (!colorStr || seen.has(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.width > 90 || r.height > 90) return;
      let cs; try { cs = getComputedStyle(el); } catch (e) { return; }
      if (cs.visibility === "hidden" || cs.display === "none") return;
      if ((el.innerText || "").trim()) return; // has real text: a normal labelled control, not a bare swatch
      seen.add(el);
      const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      out.push({ el, colorStr, area: r.width * r.height, inView });
    };
    for (const el of document.querySelectorAll("[data-color],[data-colour],[data-value],[data-hex],[data-swatch]")) {
      add(el, el.getAttribute("data-color") || el.getAttribute("data-colour") || el.getAttribute("data-value") || el.getAttribute("data-hex") || el.getAttribute("data-swatch"));
    }
    for (const el of document.querySelectorAll("canvas")) {
      // jspaint's own swatches (and any similarly-built colour picker) are exactly a [data-color] div WRAPPING a
      // canvas: without this, the div is reported by the pass above AND this canvas child is reported again by
      // this pass, as two separate "same" swatches with identical names - an unresolvable, silent 50/50 ambiguity.
      if (seen.has(el) || el.closest("[data-color],[data-colour],[data-value],[data-hex],[data-swatch]")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.width > 60 || r.height > 60) continue;
      try {
        const ctx = el.getContext && el.getContext("2d", { willReadFrequently: true });
        if (!ctx) continue;
        const d = ctx.getImageData(Math.round(el.width / 2), Math.round(el.height / 2), 1, 1).data;
        if (d[3] < 200) continue; // mostly transparent: not a solid swatch
        add(el, "rgb(" + d[0] + "," + d[1] + "," + d[2] + ")");
      } catch (e) { /* tainted/no 2D context: skip, never throw */ }
    }
    out.sort((a, b) => a.area - b.area);
    const top = out.slice(0, 40);
    globalThis.__noahSwatches = top.map((o) => o.el);
    return top.map((o) => ({ colorStr: o.colorStr, inView: o.inView }));
  } catch (e) { return []; }
})()`;

// Code editors (Ace, CodeMirror, Monaco) draw their text in their own DOM and take input through a hidden 1px <textarea>, so
// the accessibility tree contains no editor at all and an agent asked to "write a program on the page" finds nothing to click.
const EDITOR_SCAN = `(() => {
  try {
    const found = [];
    const add = (kind, nodes) => {
      for (const el of nodes) {
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (r.width < 200 || r.height < 60 || cs.visibility === "hidden" || cs.display === "none") continue;
        if (found.some((f) => f.el.contains(el) || el.contains(f.el))) continue;
        found.push({ el, kind, area: r.width * r.height, inView: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth });
      }
    };
    add("Ace", document.querySelectorAll(".ace_editor"));
    add("CodeMirror", document.querySelectorAll(".CodeMirror, .cm-editor"));
    add("Monaco", document.querySelectorAll(".monaco-editor"));
    found.sort((a, b) => b.area - a.area);
    const top = found.slice(0, 4);
    globalThis.__noahEditors = top.map((f) => f.el);
    return top.map((f) => ({ kind: f.kind, inView: f.inView }));
  } catch (e) { return []; }
})()`;

// Locate visible text that has no accessible role (draggable cards, canvas-adjacent labels, styled divs).
const textScanScript = (query) => `(() => {
  try {
    const q = ${JSON.stringify(String(query).toLowerCase().slice(0, 120))};
    const vw = innerWidth, vh = innerHeight; const found = []; let seen = 0;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (++seen > 20000) break;
      const v = n.nodeValue; if (!v || v.length > 400 || v.toLowerCase().indexOf(q) < 0) continue;
      const el = n.parentElement; if (!el) continue;
      const tag = el.tagName; if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
      try { if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue; } catch (e) {}
      const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
      const exact = v.trim().toLowerCase() === q ? 0 : 1;
      const inView = (r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) ? 0 : 1;
      found.push({ el, label: v.replace(/\\s+/g, ' ').trim().slice(0, 80), exact, inView, area: r.width * r.height });
    }
    found.sort((a, b) => a.inView - b.inView || a.exact - b.exact || a.area - b.area);
    globalThis.__noahText = found.slice(0, 5).map((f) => f.el);
    return found.slice(0, 5).map((f) => ({ label: f.label, exact: f.exact === 0, inView: f.inView === 0 }));
  } catch (e) { return []; }
})()`;

function originOf(url) {
  try {
    const u = new URL(url);
    return u.origin === "null" ? u.protocol : u.origin;
  } catch (_) {
    return "";
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function quadToRect(q) {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

class Observer {
  /**
   * @param {object} deps
   * @param {import('../browser/cdp.cjs').CdpSession} deps.cdp
   * @param {ax.RefTable} deps.refs
   * @param {{ list: () => any[] }} [deps.tabs]
   * @param {() => Promise<object>} [deps.shellInfo]
   * @param {object} [deps.scanner]   injection scanner (safety/injection.cjs)
   */
  constructor({ cdp, refs, tabs, shellInfo, scanner, config = {}, log = () => {} }) {
    this.cdp = cdp;
    this.refs = refs || new ax.RefTable();
    this.tabs = tabs;
    this.shellInfo = shellInfo;
    this.scanner = scanner;
    this.config = config;
    this.log = log;
    this.seq = 0;
    this.last = null; // last Observation
    this._navSeen = cdp.navigationCount;
    this._axEnabled = false;
    cdp.on("navigated", () => {
      // A new document: old refs and the cached observation describe a page that no longer exists.
      this.refs.reset();
      this.last = null;
    });
  }

  async ensureAx() {
    if (this._axEnabled) return;
    await this.cdp.ensureDomain("Accessibility");
    this._axEnabled = true;
  }

  async disable() {
    this._axEnabled = false;
    await this.cdp.disableDomain("Accessibility").catch(() => {});
    for (const c of this.cdp.children.values()) await this.cdp.disableDomain("Accessibility", c.sessionId).catch(() => {});
  }

  // -------------------------------------------------------------------- frames

  async _frames() {
    const { frameTree } = await this.cdp.send("Page.getFrameTree");
    const out = [];
    const walk = (node, parentId, depth) => {
      const f = node.frame;
      out.push({ id: f.id, parentId: parentId || null, url: f.url, name: f.name || "", depth, origin: originOf(f.url) });
      for (const c of node.childFrames || []) if (out.length < 12) walk(c, f.id, depth + 1);
    };
    walk(frameTree, null, 0);
    // Out-of-process iframes are NOT part of the root session's frame tree; they exist only as child
    // targets. Ask each child session for its own tree (its root frame carries the parent's frame id).
    for (const child of [...this.cdp.children.values()]) {
      if (child.type !== "iframe" || out.some((f) => f.id === child.frameId)) continue;
      try {
        const t = await this.cdp.send("Page.getFrameTree", {}, { sessionId: child.sessionId, timeoutMs: 3000 });
        const parent = out.find((f) => f.id === t.frameTree.frame.parentId);
        const base = parent ? parent.depth + 1 : 1;
        const add = (node, parentId, depth) => {
          const f = node.frame;
          if (out.length < 16) out.push({ id: f.id, parentId: parentId || null, url: f.url || child.url, name: f.name || "", depth, origin: originOf(f.url || child.url), oopif: !parentId || depth === base });
          for (const c of node.childFrames || []) add(c, f.id, depth + 1);
        };
        add(t.frameTree, t.frameTree.frame.parentId || out[0].id, base);
      } catch (err) {
        this.log("child frame tree failed:", err.message);
      }
    }
    const mainOrigin = out[0]?.origin;
    for (const f of out) f.crossOrigin = f.depth > 0 && f.origin !== mainOrigin;
    return out;
  }

  _sessionFor(frameId) {
    for (const c of this.cdp.children.values()) if (c.frameId === frameId) return c.sessionId;
    return undefined; // root session
  }

  /** Offset of a frame's viewport origin inside the TOP viewport (CSS px). */
  async _frameOffset(frame, framesById, cache) {
    if (!frame.parentId) return { x: 0, y: 0 };
    if (cache.has(frame.id)) return cache.get(frame.id);
    let off = { x: 0, y: 0 };
    try {
      const parent = framesById.get(frame.parentId);
      const pOff = parent ? await this._frameOffset(parent, framesById, cache) : { x: 0, y: 0 };
      if (!this._sessionFor(frame.id)) {
        // Same-process frame: Blink already reports quads in the top-level viewport, so only the
        // offsets of out-of-process ancestors (already in pOff) apply.
        off = pOff;
      } else {
        // OOPIF: its own session reports quads in ITS viewport. Offset = the <iframe> element's content
        // origin as seen by the parent's session, plus the parent's own offset.
        const parentSession = this._sessionFor(frame.parentId);
        const owner = await this.cdp.send("DOM.getFrameOwner", { frameId: frame.id }, { sessionId: parentSession });
        const box = await this.cdp.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }, { sessionId: parentSession });
        off = { x: box.model.content[0] + pOff.x, y: box.model.content[1] + pOff.y };
      }
    } catch (err) {
      this.log("frame offset failed:", err.message);
    }
    cache.set(frame.id, off);
    return off;
  }

  // ---------------------------------------------------------------------- AX

  async _axForFrame(frame) {
    const sessionId = this._sessionFor(frame.id);
    if (sessionId) {
      await this.cdp.ensureDomain("Accessibility", sessionId).catch(() => {});
      await this.cdp.ensureDomain("DOM", sessionId).catch(() => {});
    }
    const params = sessionId || !frame.parentId ? {} : { frameId: frame.id };
    const res = await this.cdp.send("Accessibility.getFullAXTree", params, { sessionId, timeoutMs: 10000 });
    return res.nodes || [];
  }

  /**
   * The AX tree often has no URL for a link (YouTube results, many SPAs), so the agent could not tell a video from a
   * channel or an ad. Read the real hrefs of the on-screen anchors in one page call and attach them to the AX links by
   * position. Best effort: main frame only, never throws.
   */
  async _fillLinkHrefs(elements) {
    const need = elements.filter((e) => e.role === "link" && !e.href && e.rect && !e._sessionId && (!e._frameId || e._frameId === this.cdp.mainFrameId));
    if (!need.length) return;
    try {
      const anchors = await this.cdp.evaluate(
        `(() => { const out = []; const vh = innerHeight, vw = innerWidth;
          for (const a of document.querySelectorAll("a[href]")) {
            const r = a.getBoundingClientRect(); if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
            out.push([a.href, Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), Math.round(r.width), Math.round(r.height)]);
            if (out.length >= 600) break; }
          return out; })()`,
        { timeoutMs: 3000 }
      );
      if (!Array.isArray(anchors) || !anchors.length) return;
      for (const el of need) {
        const cx = el.rect.x + el.rect.width / 2;
        const cy = el.rect.y + el.rect.height / 2;
        let best = null;
        let bestD = Infinity;
        for (const [href, ax, ay, aw, ah] of anchors) {
          const d = Math.hypot(ax - cx, ay - cy);
          if (d < bestD && d <= Math.max(6, Math.min(aw, ah, el.rect.width, el.rect.height) * 0.4)) {
            best = href;
            bestD = d;
          }
        }
        if (best) el.href = String(best).slice(0, 160);
      }
    } catch (_) {
      /* hrefs are an enhancement; the elements are usable without them */
    }
  }

  /**
   * Tie each radio / checkbox to the question it answers (see CHOICE_SCAN) and to its group, so a model - or the form module - is
   * told "option '42' of question '1. What is 6 × 7?'" rather than a bare "42". `el.question` is the full text; `el.ctx` (shown on
   * the element's line) is a shortened copy, and only replaced when the page's own markup gave none or a truncated one. Main frame
   * only; best effort, never throws (the elements are usable without it, just less well described).
   */
  async _fillChoiceQuestions(elements) {
    const mainFrame = (e) => e.rect && !e._sessionId && (!e._frameId || e._frameId === this.cdp.mainFrameId);
    const need = elements.filter((e) => /^(radio|checkbox|menuitemradio|menuitemcheckbox)$/.test(e.role) && mainFrame(e));
    const needSelect = elements.filter((e) => /^(combobox|listbox|PopUpButton|MenuListPopup)$/.test(e.role) && mainFrame(e));
    const needText = elements.filter((e) => /^(textbox|searchbox)$/.test(e.role) && mainFrame(e));
    if (!need.length && !needSelect.length && !needText.length) return;
    try {
      const scan = await this.cdp.evaluate(CHOICE_SCAN, { timeoutMs: 3000 });
      const rows = (scan && scan.choices) || [];
      // Text boxes: attach the problem/question that sits next to each. A page of 30 problems can give every box the same placeholder;
      // to the accessibility tree that is ONE question. The page's own name is kept unless it is empty or shared by several boxes, or the
      // box is unlabelled and the text beside it genuinely reads like a question (so a heading such as "Registration" never replaces a
      // field's own "Email").
      const textRows = (scan && scan.texts) || [];
      const pairs = [];
      for (const el of needText) {
        const cx = el.rect.x + el.rect.width / 2;
        const cy = el.rect.y + el.rect.height / 2;
        const hit = textRows.find((t) => Math.hypot(t[0] - cx, t[1] - cy) <= Math.max(4, Math.min(t[2], t[3], el.rect.width, el.rect.height) * 0.5));
        if (hit) pairs.push([el, hit]);
      }
      const nameCount = new Map();
      for (const [el] of pairs) nameCount.set(el.name || "", (nameCount.get(el.name || "") || 0) + 1);
      for (const [el, hit] of pairs) {
        const question = String(hit[4] || "");
        if (!question || question === el.name) continue;
        const generic = !el.name || nameCount.get(el.name) > 1;
        if (generic || (!hit[5] && ax.looksLikeQuestionText(question))) {
          el.question = question;
          if (!el.ctx) el.ctx = ax.collapse(question, 90);
        }
      }
      // A native <select> is ONE combobox to the accessibility tree, whose options it does not list. Attach the real ones by position.
      for (const el of needSelect) {
        const cx = el.rect.x + el.rect.width / 2;
        const cy = el.rect.y + el.rect.height / 2;
        const hit = ((scan && scan.selects) || []).find((s) => Math.hypot(s[0] - cx, s[1] - cy) <= Math.max(4, Math.min(s[2], s[3], el.rect.width, el.rect.height) * 0.5));
        if (hit && hit[4].length) {
          el.options = hit[4].map(([name, selected, disabled]) => ({ name, selected, disabled }));
          el.multiple = !!hit[5];
        }
      }
      if (!need.length || !rows.length) return;
      for (const el of need) {
        const cx = el.rect.x + el.rect.width / 2;
        const cy = el.rect.y + el.rect.height / 2;
        let best = null;
        let bestD = Infinity;
        for (const row of rows) {
          const d = Math.hypot(row[0] - cx, row[1] - cy);
          if (d < bestD && d <= Math.max(4, Math.min(row[2], row[3], el.rect.width, el.rect.height) * 0.5)) {
            best = row;
            bestD = d;
          }
        }
        if (!best) continue;
        el.group = "g" + best[4];
        if (!el.name && best[8]) el.name = ax.collapse(best[8], 120); // unlabelled control: its loose neighbouring text is its name
        const question = String(best[5] || "");
        if (question) {
          el.question = question;
          const have = String(el.ctx || "").replace(/…$/, "");
          if (!el.ctx || question.startsWith(have)) el.ctx = ax.collapse(question, 90);
        } else if (el.ctx) {
          el.question = el.ctx;
        }
      }
    } catch (_) {
      /* an enhancement; never blocks an observation */
    }
  }

  async _attachGeometry(elements, frameOffsets, viewport) {
    const cap = this.config.maxGeometry || 380;
    const candidates = elements.filter((e) => e.interactive || e.heading).slice(0, cap);
    await mapLimit(candidates, CONCURRENCY, async (el) => {
      const sessionId = el._sessionId;
      try {
        const res = await this.cdp.send("DOM.getContentQuads", { backendNodeId: el.backendNodeId }, { sessionId, timeoutMs: 3000 });
        if (!res.quads || !res.quads.length) return;
        // pick the largest quad (inline elements can return several)
        let best = null;
        for (const q of res.quads) {
          const r = quadToRect(q);
          if (!best || r.width * r.height > best.width * best.height) best = r;
        }
        if (!best) return;
        const off = frameOffsets.get(el._frameId) || { x: 0, y: 0 };
        el.rect = { x: best.x + off.x, y: best.y + off.y, width: best.width, height: best.height };
      } catch (_) {
        /* not rendered / detached: no rect */
      }
    });
    return candidates.length;
  }

  // ------------------------------------------------------------------ observe

  /**
   * @param {object} [o]
   * @param {boolean} [o.screenshot=false]
   * @param {boolean} [o.deep=false]        also scan for pointer-cursor elements without AX roles
   * @param {object}  [o.screenshotOptions]
   */
  async observe({ screenshot = false, deep = false, screenshotOptions = {} } = {}) {
    const t0 = Date.now();
    const cdp = this.cdp;
    if (cdp.dialog) return this._dialogObservation(t0);
    await this.ensureAx();
    const frames = await this._frames();
    const framesById = new Map(frames.map((f) => [f.id, f]));
    const offsetCache = new Map();

    const shotP = screenshot
      ? captureFrame(cdp, { ...screenshotOptions, shellInfo: this.shellInfo }).catch((err) => {
          this.log("screenshot failed:", err.message);
          return null;
        })
      : Promise.resolve(null);
    await cdp.ensureFreshWorld();
    const scanP = cdp.evaluate(SCAN_SCRIPT, { timeoutMs: 6000 }).catch((err) => ({ ok: false, error: err.message }));
    const axP = Promise.all(frames.map((f) => this._axForFrame(f).then((nodes) => ({ frame: f, nodes })).catch((err) => ({ frame: f, nodes: [], error: err.message }))));
    const [shot, scan, axResults] = await Promise.all([shotP, scanP, axP]);

    // ---- elements
    const elements = [];
    let nodeCount = 0;
    for (const { frame, nodes } of axResults) {
      const key = this.refs.frameKeyFor(frame.id, !frame.parentId);
      const res = ax.analyzeFrame(nodes, { frameKey: key });
      nodeCount += res.nodeCount;
      const sessionId = this._sessionFor(frame.id);
      for (const el of res.elements) {
        el._frameId = frame.id;
        el._sessionId = sessionId;
        elements.push(el);
      }
    }
    const frameOffsets = new Map();
    for (const f of frames) frameOffsets.set(f.id, await this._frameOffset(f, framesById, offsetCache));
    const metrics = shot?.metrics || (await cdp.layoutMetrics());
    const measured = await this._attachGeometry(elements, frameOffsets, metrics);
    await this._fillLinkHrefs(elements);
    await this._fillChoiceQuestions(elements);

    // Assign refs after geometry so numbering follows document order but stays stable across calls.
    for (const el of elements) if (el.interactive || el.heading || (el.rect && el.name)) this.refs.assign(el, { rect: el.rect });

    await this._addCodeEditors(elements);
    await this._addTitledButtons(elements);
    await this._addColorSwatches(elements);
    await this._addNamedCanvases(elements);

    // ---- deep scan (div-buttons)
    if (deep) await this._addClickables(elements, metrics);

    // ---- secret fields: mask + flag by overlap
    const secretRects = scan?.secretRects || [];
    for (const el of elements) {
      if (!el.rect || !el.interactive) continue;
      const cx = el.rect.x + el.rect.width / 2;
      const cy = el.rect.y + el.rect.height / 2;
      if (secretRects.some((r) => cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height)) {
        el.secret = true;
        if (el.value !== undefined) el.value = "••••";
      }
    }

    // ---- viewport classification & hints
    const vp = { width: metrics.width, height: metrics.height };
    const inViewInteractive = elements.filter(
      (e) => e.interactive && e.rect && e.rect.width > 0 && e.rect.height > 0 && e.rect.y < vp.height && e.rect.y + e.rect.height > 0 && e.rect.x < vp.width && e.rect.x + e.rect.width > 0
    );
    const hints = { reasons: [] };
    hints.canvas = { count: scan?.canvasCount || 0, coverage: Math.round((scan?.canvasCoverage || 0) * 100) / 100 };
    if (hints.canvas.coverage >= 0.3) hints.reasons.push(`canvas covers ${Math.round(hints.canvas.coverage * 100)}% of the viewport (content is drawn, not in the DOM)`);
    // Few controls on the WHOLE page AND little text on screen => the content is probably drawn, not marked up.
    // (Counting only the viewport would misfire on a normal page seen through a small window.)
    const totalInteractive = elements.filter((e) => e.interactive).length;
    hints.axPoverty = inViewInteractive.length < 3 && totalInteractive < 5 && (scan?.viewportText || "").length < 300;
    if (hints.axPoverty) hints.reasons.push(`only ${totalInteractive} interactive elements and little text are exposed (content is likely drawn, not marked up)`);
    if ((scan?.editableCount || 0) > 0 && (scan?.canvasCoverage || 0) > 0.15) hints.reasons.push("editable surface over a canvas (Docs/Sheets/Figma-style)");
    hints.preferVision = hints.reasons.length > 0;
    hints.hasPassword = !!scan?.hasPassword;
    hints.hasPayment = !!scan?.hasPayment;

    // The browser's own idea of the page URL is authoritative: the in-page scan can run in a stale/child document that
    // still says "about:blank" while the real page (title "YouTube") has loaded, which blinded URL-based decisions.
    const wcUrl = this.cdp.wc.getURL();
    const url = wcUrl && wcUrl !== "about:blank" ? wcUrl : scan?.url || wcUrl;
    const obs = {
      id: ++this.seq,
      ts: Date.now(),
      url,
      title: scan?.title || this.cdp.wc.getTitle(),
      origin: originOf(url),
      loading: this.cdp.wc.isLoading(),
      readyState: scan?.readyState,
      viewport: {
        width: metrics.width,
        height: metrics.height,
        devicePixelRatio: scan?.dpr || 1,
        zoomFactor: shot?.geometry?.zoomFactor || (this.cdp.wc.getZoomFactor ? this.cdp.wc.getZoomFactor() : 1),
        scrollX: metrics.scrollX,
        scrollY: metrics.scrollY,
        scrollWidth: scan?.scrollWidth || metrics.contentWidth,
        scrollHeight: scan?.scrollHeight || metrics.contentHeight,
      },
      tabs: this.tabs ? await Promise.resolve(this.tabs.list()).catch(() => []) : [],
      frames,
      elements,
      accessibilityTree: { nodeCount, interactiveCount: elements.filter((e) => e.interactive).length, inViewport: inViewInteractive.length, measured },
      pageText: { viewport: scan?.viewportText || "", content: scan?.contentText || "" },
      focused: scan?.focused || null,
      selection: scan?.selection || "",
      dialog: cdp.dialog || null,
      hints,
      screenshot: shot || null,
      timing: { totalMs: 0, scanMs: scan?.scanMs, captureMs: shot?.captureMs, axNodes: nodeCount },
      security: { findings: [], tainted: false },
    };

    if (this.scanner) {
      const corpus = [
        ["title", obs.title],
        ["url", url],
        ["page_text", obs.pageText.viewport],
        ["content_text", obs.pageText.content.slice(0, 6000)],
        ["element_names", elements.slice(0, 200).map((e) => e.name).filter(Boolean).join(" | ")],
      ];
      const res = this.scanner.scanMany(corpus);
      obs.security = { findings: res.findings, tainted: res.tainted, score: res.score };
    }
    obs.timing.totalMs = Date.now() - t0;
    this.last = obs;
    return obs;
  }

  /** While a JS dialog is open the page cannot be read; report only what is knowable. */
  async _dialogObservation(t0) {
    const url = this.cdp.wc.getURL();
    const obs = {
      id: ++this.seq, ts: Date.now(), url, title: this.cdp.wc.getTitle(), origin: originOf(url), loading: false, readyState: "blocked",
      viewport: { width: 0, height: 0, devicePixelRatio: 1, zoomFactor: 1, scrollX: 0, scrollY: 0, scrollWidth: 0, scrollHeight: 0 },
      tabs: this.tabs ? await Promise.resolve(this.tabs.list()).catch(() => []) : [], frames: [], elements: [],
      accessibilityTree: { nodeCount: 0, interactiveCount: 0, inViewport: 0, measured: 0 }, pageText: { viewport: "", content: "" },
      focused: null, selection: "", dialog: this.cdp.dialog, hints: { reasons: ["a JavaScript dialog is blocking the page: use handle_dialog"], canvas: { count: 0, coverage: 0 } },
      screenshot: null, timing: { totalMs: Date.now() - t0 }, security: { findings: [], tainted: false },
    };
    this.last = obs;
    return obs;
  }

  /**
   * Fallback for {text:"…"} targets that match no accessible control: find the
   * visible text node's element in the DOM, give it a stable ref, measure it.
   * Returns element records shaped like AX elements (role "text").
   */
  async locateText(query, { limit = 4 } = {}) {
    const out = [];
    try {
      if (this.cdp.dialog) return out;
      const infos = await this.cdp.evaluate(textScanScript(query), { timeoutMs: 5000 });
      if (!Array.isArray(infos) || !infos.length) return out;
      const contextId = await this.cdp.isolatedWorld();
      for (let i = 0; i < Math.min(limit, infos.length); i++) {
        try {
          const ev = await this.cdp.send("Runtime.evaluate", { expression: `__noahText[${i}]`, contextId, returnByValue: false, silent: true });
          if (!ev.result?.objectId) continue;
          const node = await this.cdp.send("DOM.describeNode", { objectId: ev.result.objectId });
          const backendNodeId = node.node.backendNodeId;
          const q = await this.cdp.send("DOM.getContentQuads", { backendNodeId });
          this.cdp.send("Runtime.releaseObject", { objectId: ev.result.objectId }).catch(() => {});
          if (!q.quads?.length) continue;
          const rect = quadToRect(q.quads[0]);
          const el = {
            frameKey: "", backendNodeId, role: "text", name: infos[i].label, states: {}, interactive: true, rect,
            order: 200000 + i, depth: 0, _frameId: this.cdp.mainFrameId, synthetic: true, viewportPos: infos[i].inView ? "in" : "below",
            score: infos[i].exact ? 90 : 60,
          };
          this.refs.assign(el, { rect });
          out.push(el);
        } catch (_) {
          /* skip */
        }
      }
    } catch (err) {
      this.log("locateText failed:", err.message);
    }
    return out;
  }

  /**
   * Last-resort fallback for {text:"…"} targets that match nothing in the AX tree AND no real DOM text node
   * either (locateText above): search the OCR reading of the most recent SCREENSHOT for a matching line. This
   * is the one path that reaches content with no DOM representation at all - canvas-drawn UI, text baked into
   * an image - the same category Anthropic's own browser-use tool falls back to screenshot+coordinates for
   * (see docs/RESEARCH.md). Uses perception/ocr.cjs (local, free, keyless Tesseract - no vision-capable model
   * or API key required, since this only needs to answer "where is this text", not "what actions make sense").
   * Returns [] (never throws) when no screenshot has been captured yet, or nothing matches - callers already
   * treat an empty locateText()-style result as "not found".
   */
  async locateOcrText(query, { limit = 4 } = {}) {
    const shot = this.last?.screenshot;
    const q = String(query || "").toLowerCase().trim();
    if (!shot || !q) return [];
    try {
      const lines = await recognizeText(Buffer.from(shot.base64, "base64"));
      const scored = lines
        .map((l) => {
          const t = l.text.toLowerCase();
          const score = t === q ? 95 : t.includes(q) || q.includes(t) ? 70 : 0;
          return { l, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      const out = [];
      for (let i = 0; i < scored.length; i++) {
        const { l, score } = scored[i];
        const topLeft = shot.geometry.imageToViewport(l.rect.x, l.rect.y);
        const bottomRight = shot.geometry.imageToViewport(l.rect.x + l.rect.width, l.rect.y + l.rect.height);
        const rect = { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
        const el = {
          frameKey: "", role: "text", name: l.text, states: {}, interactive: true, rect,
          order: 300000 + i, depth: 0, _frameId: this.cdp.mainFrameId, synthetic: true, ocrSource: true, score,
        };
        this.refs.assign(el, { rect, ocr: true });
        out.push(el);
      }
      return out;
    } catch (err) {
      this.log("locateOcrText failed:", err.message);
      return [];
    }
  }

  /**
   * Add the page's code editors (Ace / CodeMirror / Monaco) to the element list as multi-line textboxes, so they can be
   * clicked, typed into and named like any other field. One cheap page call; best effort, never throws.
   */
  async _addCodeEditors(elements) {
    try {
      if (this.cdp.dialog) return;
      const found = await this.cdp.evaluate(EDITOR_SCAN, { timeoutMs: 3000 });
      if (!Array.isArray(found) || !found.length) return;
      const contextId = await this.cdp.isolatedWorld();
      for (let i = 0; i < found.length; i++) {
        try {
          const ev = await this.cdp.send("Runtime.evaluate", { expression: `globalThis.__noahEditors[${i}]`, contextId, returnByValue: false, silent: true });
          if (!ev.result?.objectId) continue;
          const node = await this.cdp.send("DOM.describeNode", { objectId: ev.result.objectId });
          this.cdp.send("Runtime.releaseObject", { objectId: ev.result.objectId }).catch(() => {});
          const backendNodeId = node.node.backendNodeId;
          if (elements.some((e) => e.backendNodeId === backendNodeId && !e._sessionId)) continue;
          const q = await this.cdp.send("DOM.getContentQuads", { backendNodeId });
          if (!q.quads?.length) continue;
          const rect = quadToRect(q.quads[0]);
          const el = {
            frameKey: "", backendNodeId, role: "textbox", name: `Code editor (${found[i].kind})`, states: { multiline: true }, interactive: true,
            rect, order: 150000 + i, depth: 0, _frameId: this.cdp.mainFrameId, synthetic: true, editor: found[i].kind, viewportPos: found[i].inView ? "in" : "below",
          };
          this.refs.assign(el, { rect });
          elements.push(el);
        } catch (_) {
          /* skip this one */
        }
      }
    } catch (err) {
      this.log("code editor scan failed:", err.message);
    }
  }

  /**
   * Promote small <div title="…">-only "buttons" (no ARIA role, so invisible to the accessibility tree - jspaint's whole
   * toolbar is built this way) into named, clickable elements. Cheap (bounded by the number of [title] elements on the
   * page, not a full-DOM walk); best effort, never throws.
   */
  async _addTitledButtons(elements) {
    try {
      if (this.cdp.dialog) return;
      const found = await this.cdp.evaluate(TITLE_SCAN, { timeoutMs: 3000 });
      if (!Array.isArray(found) || !found.length) return;
      const contextId = await this.cdp.isolatedWorld();
      for (let i = 0; i < found.length; i++) {
        try {
          const ev = await this.cdp.send("Runtime.evaluate", { expression: `globalThis.__noahTitled[${i}]`, contextId, returnByValue: false, silent: true });
          if (!ev.result?.objectId) continue;
          const node = await this.cdp.send("DOM.describeNode", { objectId: ev.result.objectId });
          this.cdp.send("Runtime.releaseObject", { objectId: ev.result.objectId }).catch(() => {});
          const backendNodeId = node.node.backendNodeId;
          if (elements.some((e) => e.backendNodeId === backendNodeId && !e._sessionId)) continue;
          const q = await this.cdp.send("DOM.getContentQuads", { backendNodeId });
          if (!q.quads?.length) continue;
          const rect = quadToRect(q.quads[0]);
          const el = {
            frameKey: "", backendNodeId, role: "button", name: found[i].title, states: {}, interactive: true,
            rect, order: 160000 + i, depth: 0, _frameId: this.cdp.mainFrameId, synthetic: true, viewportPos: found[i].inView ? "in" : "below",
          };
          this.refs.assign(el, { rect });
          elements.push(el);
        } catch (_) {
          /* skip this one */
        }
      }
    } catch (err) {
      this.log("titled-button scan failed:", err.message);
    }
  }

  /**
   * Add colour-picker swatches (a paint program's palette, any custom colour picker) to the element list, named by
   * their actual colour ("blue color swatch") so "click the blue swatch" / "color blue" can find them - they carry
   * no text, title or aria-label of their own for anything else to match. Cheap, targeted scan (see SWATCH_SCAN);
   * best effort, never throws.
   */
  async _addColorSwatches(elements) {
    try {
      if (this.cdp.dialog) return;
      const found = await this.cdp.evaluate(SWATCH_SCAN, { timeoutMs: 3000 });
      if (!Array.isArray(found) || !found.length) return;
      const contextId = await this.cdp.isolatedWorld();
      for (let i = 0; i < found.length; i++) {
        const rgba = color.parseCssColor(found[i].colorStr);
        if (!rgba) continue; // could not read it as a solid colour: not a real swatch, don't guess
        try {
          const ev = await this.cdp.send("Runtime.evaluate", { expression: `globalThis.__noahSwatches[${i}]`, contextId, returnByValue: false, silent: true });
          if (!ev.result?.objectId) continue;
          const node = await this.cdp.send("DOM.describeNode", { objectId: ev.result.objectId });
          this.cdp.send("Runtime.releaseObject", { objectId: ev.result.objectId }).catch(() => {});
          const backendNodeId = node.node.backendNodeId;
          if (elements.some((e) => e.backendNodeId === backendNodeId && !e._sessionId)) continue;
          const q = await this.cdp.send("DOM.getContentQuads", { backendNodeId });
          if (!q.quads?.length) continue;
          const rect = quadToRect(q.quads[0]);
          const el = {
            frameKey: "", backendNodeId, role: "button", name: color.swatchLabel(rgba), states: {}, interactive: true,
            rect, order: 170000 + i, depth: 0, _frameId: this.cdp.mainFrameId, synthetic: true, swatchColor: rgba.slice(0, 3), viewportPos: found[i].inView ? "in" : "below",
          };
          this.refs.assign(el, { rect });
          elements.push(el);
        } catch (_) {
          /* skip this one */
        }
      }
    } catch (err) {
      this.log("colour swatch scan failed:", err.message);
    }
  }

  /**
   * Add <canvas> elements that carry their own title/aria-label (a drawing surface, a chart, a game board) so
   * their position is findable by that name - a canvas can never have text content, so this is the only way an
   * agent could ever locate one otherwise. See NAMED_CANVAS_SCAN. Best effort, never throws.
   */
  async _addNamedCanvases(elements) {
    try {
      if (this.cdp.dialog) return;
      const found = await this.cdp.evaluate(NAMED_CANVAS_SCAN, { timeoutMs: 3000 });
      if (!Array.isArray(found) || !found.length) return;
      const contextId = await this.cdp.isolatedWorld();
      for (let i = 0; i < found.length; i++) {
        try {
          const ev = await this.cdp.send("Runtime.evaluate", { expression: `globalThis.__noahNamedCanvases[${i}]`, contextId, returnByValue: false, silent: true });
          if (!ev.result?.objectId) continue;
          const node = await this.cdp.send("DOM.describeNode", { objectId: ev.result.objectId });
          this.cdp.send("Runtime.releaseObject", { objectId: ev.result.objectId }).catch(() => {});
          const backendNodeId = node.node.backendNodeId;
          if (elements.some((e) => e.backendNodeId === backendNodeId && !e._sessionId)) continue;
          const q = await this.cdp.send("DOM.getContentQuads", { backendNodeId });
          if (!q.quads?.length) continue;
          const rect = quadToRect(q.quads[0]);
          const el = {
            frameKey: "", backendNodeId, role: "canvas", name: found[i].label, states: {}, interactive: true,
            rect, order: 180000 + i, depth: 0, _frameId: this.cdp.mainFrameId, synthetic: true, viewportPos: found[i].inView ? "in" : "below",
          };
          this.refs.assign(el, { rect });
          elements.push(el);
        } catch (_) {
          /* skip this one */
        }
      }
    } catch (err) {
      this.log("named-canvas scan failed:", err.message);
    }
  }

  async _addClickables(elements, metrics) {
    try {
      const labels = await this.cdp.evaluate(CLICKABLE_SCAN, { timeoutMs: 5000 });
      if (!Array.isArray(labels) || !labels.length) return;
      const contextId = await this.cdp.isolatedWorld();
      for (let i = 0; i < labels.length; i++) {
        try {
          const ev = await this.cdp.send("Runtime.evaluate", { expression: `__noahClickables[${i}]`, contextId, returnByValue: false, silent: true });
          if (!ev.result?.objectId) continue;
          const node = await this.cdp.send("DOM.describeNode", { objectId: ev.result.objectId });
          const backendNodeId = node.node.backendNodeId;
          if (elements.some((e) => e.backendNodeId === backendNodeId && !e._sessionId)) continue;
          const q = await this.cdp.send("DOM.getContentQuads", { backendNodeId });
          if (!q.quads?.length) continue;
          const rect = quadToRect(q.quads[0]);
          const el = {
            frameKey: "", backendNodeId, role: "clickable", name: labels[i] || "(unlabelled clickable)", states: {}, interactive: true,
            rect, order: 100000 + i, depth: 0, _frameId: this.cdp.mainFrameId, synthetic: true,
          };
          this.refs.assign(el, { rect });
          elements.push(el);
          this.cdp.send("Runtime.releaseObject", { objectId: ev.result.objectId }).catch(() => {});
        } catch (_) {
          /* skip */
        }
      }
    } catch (err) {
      this.log("deep scan failed:", err.message);
    }
  }

  // ---------------------------------------------------- targeted operations

  /** Fresh viewport rect for a ref (scrolls into view first when asked). */
  async measureRef(ref, { scrollIntoView = true } = {}) {
    const rec = this.refs.get(ref);
    if (!rec) return { ok: false, code: "unknown_ref", error: `ref ${ref} is unknown for this page. Call read_page to get fresh refs.` };
    if (rec.ocr) {
      // OCR-sourced pseudo-elements (see locateOcrText) have no backing DOM node, so there is nothing for
      // DOM.getContentQuads to measure - the rect captured at OCR time (already mapped through that
      // screenshot's own FrameGeometry) IS the answer. Staleness is caught the same way any coordinate/vision
      // target already is (browser-controller's stale-frame check on scroll/navigation), not by re-measuring.
      if (!rec.rect) return { ok: false, code: "not_rendered", error: `OCR text ${ref} ("${rec.name}") has no stored position`, rec };
      return { ok: true, rect: rec.rect, rec, sessionId: undefined };
    }
    const sessionId = rec.frameKey ? this._sessionFor(this._frameIdForKey(rec.frameKey)) : undefined;
    try {
      if (scrollIntoView) await this.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: rec.backendNodeId }, { sessionId });
      const res = await this.cdp.send("DOM.getContentQuads", { backendNodeId: rec.backendNodeId }, { sessionId });
      if (!res.quads?.length) return { ok: false, code: "not_rendered", error: `element ${ref} (${rec.role} "${rec.name}") has no visible box`, rec };
      let best = null;
      for (const q of res.quads) {
        const r = quadToRect(q);
        if (!best || r.width * r.height > best.rect.width * best.rect.height) best = { rect: r, quad: q };
      }
      // frame offset (recomputed fresh: the iframe may have scrolled)
      let off = { x: 0, y: 0 };
      if (rec.frameKey) {
        const frames = await this._frames();
        const map = new Map(frames.map((f) => [f.id, f]));
        const fid = this._frameIdForKey(rec.frameKey);
        if (fid && map.get(fid)) off = await this._frameOffset(map.get(fid), map, new Map());
      }
      const rect = { x: best.rect.x + off.x, y: best.rect.y + off.y, width: best.rect.width, height: best.rect.height };
      return { ok: true, rect, quad: best.quad, offset: off, rec, sessionId };
    } catch (err) {
      const stale = /No node with given id|Could not find node|does not belong|Node with given id/i.test(err.message);
      return { ok: false, code: stale ? "stale_ref" : "measure_failed", error: stale ? `ref ${ref} is stale (the page changed). Call read_page for fresh refs.` : err.message, rec };
    }
  }

  _frameIdForKey(frameKey) {
    for (const [frameId, key] of this.refs._frames) if (key === frameKey) return frameId;
    return null;
  }

  /**
   * In-page hit testing (document.elementFromPoint, piercing same-origin iframes and open shadow roots), run in
   * Noah's isolated world. Coordinates are CSS px in the viewport, so it is correct at any zoom and DPR - unlike
   * DOM.getNodeForLocation, whose coordinate unit is not viewport CSS px (verified empirically at DPR 2 / zoom 1.5).
   */
  static get HIT_HELPERS() {
    return `
      const __deepest = (doc, px, py) => {
        let el = doc.elementFromPoint(px, py);
        for (let guard = 0; el && guard < 8; guard++) {
          if (el.shadowRoot && el.shadowRoot.elementFromPoint) { const inner = el.shadowRoot.elementFromPoint(px, py); if (inner && inner !== el) { el = inner; continue; } }
          if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
            try { const d = el.contentDocument; if (d) { const r = el.getBoundingClientRect(); const inner = __deepest(d, px - r.left - el.clientLeft, py - r.top - el.clientTop); if (inner) return inner; } } catch (e) {}
          }
          break;
        }
        return el;
      };
      const __describe = (el) => {
        if (!el) return null;
        const c = el.closest ? (el.closest('button,a,[role=button],[role=link],input,select,textarea,label,[onclick]') || el) : el;
        const f = c.closest ? c.closest('form') : null;
        return { tag: (c.tagName || '').toLowerCase(), type: c.type || null, role: (c.getAttribute && c.getAttribute('role')) || null,
                 text: ((c.getAttribute && c.getAttribute('aria-label')) || c.innerText || c.value || c.title || c.alt || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
                 href: c.href || null, formHasPassword: !!(f && f.querySelector('input[type=password]')), formHasPayment: !!(f && f.querySelector('input[autocomplete^="cc-"],input[name*="card" i]')),
                 formAction: f ? f.action : null, isPassword: c.type === 'password' };
      };`;
  }

  /**
   * For candidate click points on a target node: which one (if any) actually lands on the target (or a
   * descendant / its label)? One CDP round trip. Also reports pointer-events:none targets, which a real click
   * would pass straight through.
   * @returns {{ index:number, pointerEventsNone:boolean, blocker:object|null }}
   */
  async probePoints(targetBackendNodeId, points, sessionId) {
    const contextId = await this.cdp.isolatedWorld(undefined, sessionId);
    const { object } = await this.cdp.send("DOM.resolveNode", { backendNodeId: targetBackendNodeId, executionContextId: contextId }, { sessionId });
    try {
      const res = await this.cdp.send(
        "Runtime.callFunctionOn",
        {
          objectId: object.objectId,
          functionDeclaration: `function(points) { ${Observer.HIT_HELPERS}
            const cs = getComputedStyle(this);
            let first = null;
            for (let i = 0; i < points.length; i++) {
              const hit = __deepest(document, points[i][0], points[i][1]);
              const match = !!hit && (this === hit || this.contains(hit) || (hit.closest && hit.closest('label') && hit.closest('label').control === this) ||
                (hit.getRootNode && hit.getRootNode().host && this.contains(hit.getRootNode().host)));
              if (match) return { index: i, pointerEventsNone: cs.pointerEvents === 'none', blocker: null };
              if (!first) first = __describe(hit);
            }
            return { index: -1, pointerEventsNone: cs.pointerEvents === 'none', blocker: first };
          }`,
          arguments: [{ value: points }],
          returnByValue: true,
          silent: true,
        },
        { sessionId }
      );
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || "probe failed");
      return res.result.value;
    } finally {
      this.cdp.send("Runtime.releaseObject", { objectId: object.objectId }, { sessionId }).catch(() => {});
    }
  }

  /** Describe the element under a viewport point (used to risk-classify coordinate/vision clicks). */
  async describePoint(x, y) {
    try {
      return await this.cdp.evaluate(`(() => { ${Observer.HIT_HELPERS} return __describe(__deepest(document, ${+x}, ${+y})); })()`, { timeoutMs: 3000 });
    } catch (_) {
      return null;
    }
  }

  /** Cheap state fingerprint for verification (no AX walk, no screenshot). */
  async fingerprint() {
    // A blocking JS dialog freezes the page's main thread; evaluating would hang until it is handled.
    if (this.cdp.dialog) {
      return { dialog: this.cdp.dialog.type, url: this.cdp.wc.getURL(), title: this.cdp.wc.getTitle(), loading: false, at: Date.now(), tabCount: this.tabs ? (await Promise.resolve(this.tabs.list()).catch(() => [])).length : undefined };
    }
    const scan = await this.cdp
      .evaluate(
        `(() => { try { const b = document.body; const t = (b && b.innerText || "").slice(0, 6000); let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
          const ae = document.activeElement; return { url: location.href, title: document.title, ready: document.readyState, sx: Math.round(scrollX), sy: Math.round(scrollY),
            textHash: h, textLen: t.length, nodes: document.getElementsByTagName("*").length,
            active: ae && ae !== b ? (ae.tagName + "|" + (ae.id || "") + "|" + (typeof ae.value === "string" ? ae.value.length + ":" + ae.value.slice(-24) : "")) : "",
            sel: String(getSelection()).length,
            iframes: Array.from(document.querySelectorAll("iframe")).map((f) => { try { const d = f.contentDocument; return d ? d.title + "#" + ((d.body && d.body.innerText) || "").length : "x"; } catch (e) { return "x"; } }).join(",") }; } catch (e) { return { error: String(e) }; } })()`,
        { timeoutMs: 4000 }
      )
      .catch(() => ({ error: "eval failed" }));
    // Same-origin iframes are inside the main frame's DOM; out-of-process ones need their own session.
    let frames = scan?.iframes || "";
    for (const child of this.cdp.children.values()) {
      if (child.type !== "iframe") continue;
      const part = await this.cdp
        .evaluate(`(() => { const t = (document.body ? document.body.innerText : "").slice(0, 2000); let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return document.title + "#" + h + "#" + t.length; })()`, { frameId: child.frameId, sessionId: child.sessionId, timeoutMs: 1500 })
        .catch(() => "");
      frames += "|" + part;
    }
    return { ...scan, frames, tabCount: this.tabs ? (await Promise.resolve(this.tabs.list()).catch(() => [])).length : undefined, dialog: this.cdp.dialog ? this.cdp.dialog.type : null, loading: this.cdp.wc.isLoading(), at: Date.now() };
  }

  async zoom(regionViewport, opts) {
    return captureRegion(this.cdp, regionViewport, opts);
  }
}

module.exports = { Observer, SCAN_SCRIPT, originOf, quadToRect, mapLimit };
