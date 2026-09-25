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

    // Assign refs after geometry so numbering follows document order but stays stable across calls.
    for (const el of elements) if (el.interactive || el.heading || (el.rect && el.name)) this.refs.assign(el, { rect: el.rect });

    await this._addCodeEditors(elements);

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
