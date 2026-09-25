// Noah/perception/ax.cjs
//
// Layer 1 perception (semantic): turn raw `Accessibility.getFullAXTree` nodes
// into a compact, model-friendly element list with STABLE references.
// Pure functions + one small class; no Electron dependency, fully unit-tested.
//
// Design notes
//  * Built from the browser's accessibility tree, not raw DOM, so hidden text
//    (display:none, aria-hidden, off-screen tricks) is naturally excluded
//    (Anthropic's browser-use security guidance).
//  * Refs (e12, f1e4 for iframe 1) are never renumbered within a page load: a
//    backendNodeId keeps its ref even if the tree changes, so refs the model
//    already holds stay meaningful until navigation (Anthropic/Playwright rule).
//  * Geometry is attached separately (async CDP quads) so this file stays pure.

"use strict";

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "tab",
  "menuitem", "menuitemcheckbox", "menuitemradio", "option", "slider", "spinbutton", "listbox",
  "treeitem", "PopUpButton", "ComboBoxMenuButton", "ComboBoxSelect", "DisclosureTriangle",
  "ColorWell", "DateTime", "Date", "Time", "InputTime", "SearchBox", "TextField", "TextFieldWithComboBox",
  "ToggleButton", "Switch", "scrollbar", "MenuListOption", "MenuListPopup", "Details", "gridcell",
]);

const NOISE_ROLES = new Set([
  "generic", "none", "presentation", "InlineTextBox", "LineBreak", "StaticText", "text", "RootWebArea",
  "WebArea", "Iframe", "iframe", "IframePresentational", "paragraph", "Section", "ListMarker", "LabelText",
  "Ignored", "unknown",
]);

const STRUCTURE_ROLES = new Set([
  "heading", "main", "navigation", "banner", "contentinfo", "complementary", "search", "form", "dialog",
  "alertdialog", "alert", "status", "region", "table", "grid", "list", "menu", "menubar", "tablist",
  "toolbar", "article", "radiogroup", "tree",
]);

const ITEM_ROLES = new Set(["listitem", "article", "row", "group", "gridcell", "cell", "treeitem"]);

const STATE_PROPS = [
  "focused", "disabled", "checked", "expanded", "selected", "required", "invalid", "readonly", "pressed",
  "modal", "multiline", "busy", "haspopup", "autocomplete",
];

const SECRET_NAME = /password|passcode|passwd|\bpin\b|secret|cvv|cvc|security code|card number|credit card|ssn|social security|one[- ]time|otp|2fa|verification code/i;

function collapse(s, max) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function propMap(node) {
  const out = {};
  for (const p of node.properties || []) out[p.name] = p.value?.value;
  return out;
}

/**
 * Analyse one frame's AX nodes.
 * @param {object[]} nodes raw CDP AXNode[]
 * @param {object} [opts]
 * @param {string} [opts.frameKey] '' for the main frame, 'f1' etc. for iframes
 * @returns {{ elements: object[], headings: object[], modalRoots: number[], nodeCount: number, interactiveCount: number }}
 */
function analyzeFrame(nodes, { frameKey = "" } = {}) {
  const byId = new Map();
  for (const n of nodes) byId.set(n.nodeId, n);
  const parentOf = new Map();
  for (const n of nodes) for (const c of n.childIds || []) parentOf.set(c, n.nodeId);

  const roots = nodes.filter((n) => !parentOf.has(n.nodeId));
  const elements = [];
  const headings = [];
  const modalRoots = [];
  let order = 0;

  const itemLabelCache = new Map();
  function firstLabelWithin(node, depth = 0) {
    if (itemLabelCache.has(node.nodeId)) return itemLabelCache.get(node.nodeId);
    let label = "";
    const stack = [[node, 0]];
    while (stack.length && !label) {
      const [cur, d] = stack.shift();
      const role = cur.role?.value;
      const name = cur.name?.value;
      if (name && (role === "heading" || role === "link") && !cur.ignored) label = collapse(name, 60);
      if (d < 4) for (const id of cur.childIds || []) if (byId.has(id)) stack.push([byId.get(id), d + 1]);
    }
    itemLabelCache.set(node.nodeId, label);
    return label;
  }

  function visit(node, ctx, depth, inModal) {
    const role = node.role?.value || "unknown";
    const props = propMap(node);
    const name = collapse(node.name?.value, 120);
    let nextCtx = ctx;
    let nextModal = inModal;

    if (!node.ignored) {
      if (props.modal === true || role === "dialog" || role === "alertdialog") {
        if (props.modal === true) {
          modalRoots.push(node.backendDOMNodeId);
          nextModal = true;
        }
      }
      if (ITEM_ROLES.has(role) || STRUCTURE_ROLES.has(role)) {
        let label = name;
        if (!label && ITEM_ROLES.has(role)) label = firstLabelWithin(node);
        if (label && role !== "heading") nextCtx = { label: collapse(label, 50), role, parent: ctx };
      }

      const focusable = props.focusable === true;
      const interactive =
        INTERACTIVE_ROLES.has(role) ||
        (focusable && !NOISE_ROLES.has(role) && !STRUCTURE_ROLES.has(role)) ||
        (role === "textbox") || (props.editable === "plaintext" || props.editable === "richtext");

      if (node.backendDOMNodeId !== undefined && (interactive || role === "heading" || (STRUCTURE_ROLES.has(role) && name))) {
        const states = {};
        for (const k of STATE_PROPS) if (props[k] !== undefined && props[k] !== false && props[k] !== "false") states[k] = props[k];
        const el = {
          frameKey,
          axId: node.nodeId,
          backendNodeId: node.backendDOMNodeId,
          role,
          name,
          value: node.value?.value !== undefined && node.value?.value !== "" ? collapse(node.value.value, 100) : undefined,
          description: node.description?.value ? collapse(node.description.value, 80) : undefined,
          states,
          interactive: !!interactive,
          heading: role === "heading" ? +props.level || undefined : undefined,
          href: role === "link" && props.url ? collapse(props.url, 120) : undefined,
          ctx: nextCtx && nextCtx.label ? nextCtx.label : undefined,
          inModal: nextModal || undefined,
          depth,
          order: order++,
        };
        if (el.interactive && (el.role === "textbox" || el.role === "searchbox" || el.role === "combobox") && SECRET_NAME.test(el.name)) {
          el.secret = true;
          if (el.value !== undefined) el.value = "••••";
        }
        elements.push(el);
        if (role === "heading" && name) headings.push({ level: el.heading, name });
      }
    }
    for (const id of node.childIds || []) {
      const child = byId.get(id);
      if (child) visit(child, nextCtx, depth + (node.ignored ? 0 : 1), nextModal);
    }
  }

  for (const r of roots) visit(r, null, 0, false);
  return {
    elements,
    headings,
    modalRoots,
    nodeCount: nodes.length,
    interactiveCount: elements.filter((e) => e.interactive).length,
  };
}

// ---------------------------------------------------------------------------
// Stable references
// ---------------------------------------------------------------------------

class RefTable {
  constructor() {
    this.reset();
  }

  /** Called on navigation: refs restart because the DOM is a different document. */
  reset() {
    this._byNode = new Map(); // `${frameKey}|${backendNodeId}` -> ref
    this._byRef = new Map(); // ref -> record
    this._counters = new Map(); // frameKey -> next number
    this._frames = new Map(); // frameId -> 'f1'
    this.generation = (this.generation || 0) + 1;
  }

  frameKeyFor(frameId, isMain) {
    if (isMain) return "";
    if (!this._frames.has(frameId)) this._frames.set(frameId, "f" + (this._frames.size + 1));
    return this._frames.get(frameId);
  }

  assign(el, extra = {}) {
    const key = `${el.frameKey}|${el.backendNodeId}`;
    let ref = this._byNode.get(key);
    if (!ref) {
      const n = (this._counters.get(el.frameKey) || 0) + 1;
      this._counters.set(el.frameKey, n);
      ref = `${el.frameKey}e${n}`;
      this._byNode.set(key, ref);
    }
    const prev = this._byRef.get(ref);
    this._byRef.set(ref, {
      ref,
      frameKey: el.frameKey,
      backendNodeId: el.backendNodeId,
      role: el.role,
      name: el.name,
      ctx: el.ctx,
      seenAt: Date.now(),
      firstSeenAt: prev?.firstSeenAt || Date.now(),
      ...extra,
    });
    el.ref = ref;
    return ref;
  }

  get(ref) {
    return this._byRef.get(ref) || null;
  }

  size() {
    return this._byRef.size;
  }
}

/** role+name identity used to re-find an element after its node id went stale. */
function fingerprint(el) {
  return `${el.role}|${String(el.name || "").toLowerCase().slice(0, 60)}|${String(el.ctx || "").toLowerCase().slice(0, 30)}`;
}

function findByFingerprint(fp, elements) {
  const exact = elements.filter((e) => fingerprint(e) === fp);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return exact[0];
  const [role, name] = fp.split("|");
  const loose = elements.filter((e) => e.role === role && String(e.name || "").toLowerCase().slice(0, 60) === name);
  return loose[0] || null;
}

// ---------------------------------------------------------------------------
// Selection / compression
// ---------------------------------------------------------------------------

const ROLE_WEIGHT = {
  textbox: 10, searchbox: 10, combobox: 10, TextField: 10, button: 8, checkbox: 7, radio: 7, switch: 7,
  spinbutton: 7, slider: 6, tab: 6, menuitem: 6, PopUpButton: 8, option: 5, link: 5, listbox: 6, heading: 3,
};

function estimateTokens(text) {
  return Math.ceil(String(text).length / 3.6);
}

/**
 * Format one element as a single compact line.
 *   e12 button "Search" @(840,441) 120x42 [focused] in "Results"
 */
function formatElement(el, { showRect = true } = {}) {
  let s = `${el.ref} ${el.role}`;
  if (el.heading) s += `${el.heading}`;
  if (el.name) s += ` "${el.name.replace(/"/g, "'")}"`;
  if (el.value !== undefined && el.interactive) s += ` value="${String(el.value).replace(/"/g, "'")}"`;
  if (showRect && el.rect) {
    const cx = Math.round(el.rect.x + el.rect.width / 2);
    const cy = Math.round(el.rect.y + el.rect.height / 2);
    s += ` @(${cx},${cy}) ${Math.round(el.rect.width)}x${Math.round(el.rect.height)}`;
  }
  const st = Object.entries(el.states || {}).map(([k, v]) => (v === true ? k : `${k}=${v}`));
  if (st.length) s += ` [${st.join(",")}]`;
  if (el.href) s += ` -> ${el.href}`;
  if (el.ctx) s += ` in "${el.ctx}"`;
  if (el.viewportPos && el.viewportPos !== "in") s += ` (${el.viewportPos})`;
  return s;
}

/**
 * Choose which elements to show the model.
 *  - if a modal dialog is open, only its contents (everything else is inert)
 *  - viewport elements first, capped; a few off-screen ones flagged above/below
 *  - repeated (role,name,ctx) triples collapsed with a count
 * Returns { lines, shown, hidden:{...}, tokens }.
 */
function selectForModel(elements, { viewport, tokenBudget = 3000, maxInView = 90, maxOffscreen = 14, includeHeadings = true } = {}) {
  let list = elements.filter((e) => e.interactive || (includeHeadings && e.heading));
  const modal = list.filter((e) => e.inModal);
  const modalActive = modal.some((e) => e.interactive);
  if (modalActive) list = modal;

  const inView = [];
  const above = [];
  const below = [];
  for (const e of list) {
    if (!e.rect) {
      // no geometry: not rendered (or not measured). Keep only if focused/named interactive.
      if (e.interactive && e.name) below.push(e);
      continue;
    }
    const r = e.rect;
    const vis = r.width > 0 && r.height > 0;
    if (!vis) continue;
    const bottom = r.y + r.height;
    if (bottom < 0) {
      e.viewportPos = "above";
      above.push(e);
    } else if (r.y > viewport.height) {
      e.viewportPos = "below";
      below.push(e);
    } else {
      e.viewportPos = "in";
      inView.push(e);
    }
  }

  const weight = (e) => (ROLE_WEIGHT[e.role] || 4) + (e.states?.focused ? 4 : 0) + (e.name ? 1 : 0);
  let shownIn = inView;
  if (shownIn.length > maxInView) {
    const keep = new Set([...shownIn].sort((a, b) => weight(b) - weight(a)).slice(0, maxInView));
    shownIn = shownIn.filter((e) => keep.has(e));
  }
  const nearBelow = below.sort((a, b) => (a.rect?.y ?? 1e9) - (b.rect?.y ?? 1e9)).slice(0, maxOffscreen);
  const nearAbove = above.sort((a, b) => (b.rect?.y ?? -1e9) - (a.rect?.y ?? -1e9)).slice(0, Math.floor(maxOffscreen / 3));

  // collapse duplicates within the visible set
  const lines = [];
  const seen = new Map();
  const shown = [];
  for (const e of [...nearAbove.reverse(), ...shownIn, ...nearBelow]) {
    const key = `${e.role}|${e.name}|${e.ctx || ""}|${e.viewportPos}`;
    if (e.name && seen.has(key) && e.role !== "textbox") {
      seen.get(key).dupes = (seen.get(key).dupes || 0) + 1;
      continue;
    }
    seen.set(key, e);
    shown.push(e);
  }

  let tokens = 0;
  for (const e of shown) {
    let line = formatElement(e);
    if (e.dupes) line += `  (+${e.dupes} identical)`;
    const t = estimateTokens(line);
    if (tokens + t > tokenBudget) break;
    tokens += t;
    lines.push(line);
  }
  const hidden = {
    offscreenAbove: above.length - nearAbove.length,
    offscreenBelow: below.length - nearBelow.length,
    trimmed: shown.length - lines.length,
    modal: modalActive,
  };
  return { lines, shown: shown.slice(0, lines.length), hidden, tokens };
}

// ---------------------------------------------------------------------------
// Element search (find_element + {text:'...'} targets) — deterministic, no LLM
// ---------------------------------------------------------------------------

const ROLE_HINTS = [
  [/\b(button|btn)\b/i, ["button", "PopUpButton", "ToggleButton"]],
  [/\b(link)\b/i, ["link"]],
  [/\b(field|input|box|textbox|text box|search bar|search field|editor)\b/i, ["textbox", "searchbox", "combobox", "TextField"]],
  [/\b(checkbox|check box)\b/i, ["checkbox"]],
  [/\b(radio)\b/i, ["radio"]],
  [/\b(dropdown|select|menu)\b/i, ["combobox", "PopUpButton", "menuitem", "listbox"]],
  [/\b(tab)\b/i, ["tab"]],
];

const STOP = new Set(["the", "a", "an", "of", "to", "for", "on", "in", "and", "or", "button", "link", "field", "input", "box", "click", "with", "that", "this"]);

function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((t) => t && !STOP.has(t));
}

function scoreMatch(el, query, wantRoles) {
  const name = String(el.name || "").toLowerCase();
  const value = String(el.value || "").toLowerCase();
  const q = String(query).toLowerCase().trim();
  const qt = tokens(query);
  let score = 0;
  if (name === q) score = 100;
  else if (name && name.startsWith(q)) score = 85;
  else if (name && name.includes(q)) score = 70;
  else if (qt.length && name) {
    const nt = new Set(tokens(name));
    const hit = qt.filter((t) => nt.has(t) || name.includes(t)).length;
    score = (hit / qt.length) * 60;
  }
  if (!score && value && value.includes(q)) score = 40;
  if (!score && el.ctx && String(el.ctx).toLowerCase().includes(q)) score = 25;
  if (!score && el.href && String(el.href).toLowerCase().includes(q)) score = 20;
  if (score && wantRoles && wantRoles.includes(el.role)) score += 12;
  if (score && el.viewportPos === "in") score += 4;
  if (score && el.interactive) score += 2;
  // Headings/landmarks are listed for structure; when a heading and a link/button share a name, the control wins.
  if (score && !el.interactive && !/\b(heading|title|section)\b/i.test(query)) score -= 12;
  return score;
}

function findElements(elements, query, { limit = 8, minScore = 20 } = {}) {
  const wantRoles = [];
  for (const [re, roles] of ROLE_HINTS) if (re.test(query)) wantRoles.push(...roles);
  const scored = [];
  for (const el of elements) {
    if (!el.ref) continue;
    const s = scoreMatch(el, query, wantRoles.length ? wantRoles : null);
    if (s >= minScore) scored.push({ el, score: s });
  }
  scored.sort((a, b) => b.score - a.score || (a.el.order ?? 0) - (b.el.order ?? 0));
  return scored.slice(0, limit).map((s) => ({ ...s.el, score: Math.round(s.score) }));
}

/** Indented outline for read_page(filter:'all'): structure + interactive elements. */
function formatTree(elements, { maxLines = 400 } = {}) {
  const lines = [];
  for (const e of elements) {
    if (!e.ref) continue;
    if (lines.length >= maxLines) {
      lines.push("… (truncated; use read_page with a smaller depth or a ref)");
      break;
    }
    lines.push(`${"  ".repeat(Math.min(e.depth || 0, 8))}${formatElement(e, { showRect: true })}`);
  }
  return lines.join("\n");
}

module.exports = {
  INTERACTIVE_ROLES,
  analyzeFrame,
  RefTable,
  fingerprint,
  findByFingerprint,
  selectForModel,
  formatElement,
  formatTree,
  findElements,
  estimateTokens,
  collapse,
  SECRET_NAME,
};
