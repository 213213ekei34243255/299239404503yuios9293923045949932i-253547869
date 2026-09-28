// Noah/protocol/actions.cjs
//
// The strict, extensible action protocol (spec §21). One registry is the
// single source of truth for: validation, the JSON schema handed to models as
// a function-calling tool, safety classification hints, and executor routing.
//
// Adding an action = one entry in ACTIONS + one handler in
// agent/action-executor.cjs. Unknown actions are rejected before they can
// reach any controller.

"use strict";

const MAX_BATCH = 5;
const MAX_TEXT = 5000;

// category: how the executor/perception layer treats it.
//   nav        navigation and tabs
//   pointer    mouse (drives the visible cursor)
//   keyboard   keyboard input
//   read       read-only perception (no page mutation)
//   file       upload/download
//   control    agent-level (wait, ask_user)
const ACTIONS = {
  click:        { category: "pointer",  mutates: true,  cursor: "CLICKING",        target: "required", doc: "Left-click a target." },
  double_click: { category: "pointer",  mutates: true,  cursor: "DOUBLE_CLICKING", target: "required", doc: "Double-click a target." },
  right_click:  { category: "pointer",  mutates: true,  cursor: "RIGHT_CLICKING",  target: "required", doc: "Right-click a target (context menu)." },
  hover:        { category: "pointer",  mutates: false, cursor: "HOVERING",        target: "required", doc: "Move the pointer over a target without clicking (reveals hover menus)." },
  move:         { category: "pointer",  mutates: false, cursor: "MOVING",          target: "required", doc: "Move the pointer to a target." },
  mouse_down:   { category: "pointer",  mutates: true,  cursor: "DRAGGING",        target: "optional", doc: "Press and hold the mouse button (custom drags). Pair with mouse_up." },
  mouse_up:     { category: "pointer",  mutates: true,  cursor: "DRAGGING",        target: "optional", doc: "Release the mouse button." },
  drag:         { category: "pointer",  mutates: true,  cursor: "DRAGGING",        target: "from_to",  doc: "Press at `from`, drag to `to`, release." },
  scroll:       { category: "pointer",  mutates: false, cursor: "SCROLLING",       target: "optional", doc: "Scroll with the mouse wheel at a point (defaults to viewport centre)." },
  scroll_to:    { category: "pointer",  mutates: false, cursor: "SCROLLING",       target: "required", doc: "Scroll an element (ref or text) into view." },
  type:         { category: "keyboard", mutates: true,  cursor: "TYPING",          target: "optional", doc: "Type text at the current focus (or click `target` first)." },
  key_press:    { category: "keyboard", mutates: true,  cursor: "TYPING",          target: "none",     doc: "Press one key (Enter, Tab, Escape, ArrowDown, PageDown, a, ...)." },
  hotkey:       { category: "keyboard", mutates: true,  cursor: "TYPING",          target: "none",     doc: "Press a chord, e.g. keys:['ctrl','a'] or combo:'ctrl+shift+t'." },
  key_down:     { category: "keyboard", mutates: true,  cursor: "TYPING",          target: "none",     doc: "Hold a key down." },
  key_up:       { category: "keyboard", mutates: true,  cursor: "TYPING",          target: "none",     doc: "Release a key." },
  select_all:   { category: "keyboard", mutates: false, cursor: "TYPING",          target: "none",     doc: "Select all in the focused field/page." },
  copy:         { category: "keyboard", mutates: false, cursor: "TYPING",          target: "none",     doc: "Copy the current selection." },
  paste:        { category: "keyboard", mutates: true,  cursor: "TYPING",          target: "none",     doc: "Paste clipboard content Noah copied earlier in this task." },
  form_input:   { category: "keyboard", mutates: true,  cursor: "TYPING",          target: "required", doc: "Set a form control's value directly (select, checkbox, range, input)." },
  navigate:     { category: "nav",      mutates: true,  cursor: null,              target: "none",     doc: "Load an http(s) URL in the current tab." },
  back:         { category: "nav",      mutates: true,  cursor: null,              target: "none",     doc: "Go back in history." },
  forward:      { category: "nav",      mutates: true,  cursor: null,              target: "none",     doc: "Go forward in history." },
  reload:       { category: "nav",      mutates: true,  cursor: null,              target: "none",     doc: "Reload the page." },
  new_tab:      { category: "nav",      mutates: true,  cursor: null,              target: "none",     doc: "Open a new tab (optionally at a URL) and switch to it." },
  close_tab:    { category: "nav",      mutates: true,  cursor: null,              target: "none",     doc: "Close a tab (default: current)." },
  switch_tab:   { category: "nav",      mutates: true,  cursor: null,              target: "none",     doc: "Activate a tab by tab_id or by a query matching title/url ('the amazon tab')." },
  wait:         { category: "control",  mutates: false, cursor: "WAITING",         target: "none",     doc: "Wait for time or a condition (text appears/disappears, URL contains)." },
  screenshot:   { category: "read",     mutates: false, cursor: "THINKING",        target: "none",     doc: "Request a visual observation. With `region` [x0,y0,x1,y1] it zooms into that area at full resolution (coordinates stay in full-screenshot space)." },
  read_page:    { category: "read",     mutates: false, cursor: "THINKING",        target: "none",     doc: "Re-read the page: filter 'interactive'|'all'|'text', optional ref subtree." },
  find_element: { category: "read",     mutates: false, cursor: "THINKING",        target: "none",     doc: "Search the page for elements matching a description; returns refs." },
  upload_file:  { category: "file",     mutates: true,  cursor: null,              target: "required", doc: "Attach a local file to a file input (ref)." },
  download_file:{ category: "file",     mutates: true,  cursor: null,              target: "optional", doc: "Download a URL or the file behind a target." },
  handle_dialog:{ category: "nav",      mutates: true,  cursor: null,              target: "none",     doc: "Accept/dismiss a JavaScript dialog (alert/confirm/prompt/beforeunload)." },
  ask_user:     { category: "control",  mutates: false, cursor: "WAITING",         target: "none",     doc: "Stop and ask the user a question or for a decision." },
};

const ALIASES = {
  press: "key_press", press_key: "key_press", keypress: "key_press", key: "key_press", pressKey: "key_press",
  doubleclick: "double_click", "double-click": "double_click", doubleClick: "double_click",
  rightclick: "right_click", "right-click": "right_click", rightClick: "right_click",
  mouse_move: "move", mousemove: "move", move_mouse: "move", left_click: "click", tap: "click",
  left_click_drag: "drag", drag_and_drop: "drag", dragdrop: "drag",
  scroll_down: "scroll", scroll_up: "scroll",
  goto: "navigate", go_to: "navigate", open: "navigate", open_url: "navigate", visit: "navigate", navigate_to: "navigate",
  go_back: "back", goBack: "back", go_forward: "forward", goForward: "forward", refresh: "reload",
  newtab: "new_tab", createTab: "new_tab", create_tab: "new_tab", open_tab: "new_tab", closeTab: "close_tab", switchTab: "switch_tab",
  type_text: "type", input_text: "type", write: "type", enter_text: "type", fill: "type",
  shortcut: "hotkey", key_combination: "hotkey", key_combo: "hotkey", selectAll: "select_all",
  sleep: "wait", pause: "wait", capture: "screenshot", zoom: "screenshot", take_screenshot: "screenshot",
  observe: "read_page", extract: "read_page", get_page_text: "read_page", find: "find_element",
  upload: "upload_file", download: "download_file", dialog: "handle_dialog", ask: "ask_user",
  set_value: "form_input", select_option: "form_input", formInput: "form_input",
};

const DIRECTIONS = ["up", "down", "left", "right"];
const MODIFIERS = ["shift", "ctrl", "control", "alt", "meta", "cmd", "command", "mod"];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Normalise a model-provided target into { type, ... } or null. */
function normalizeTarget(raw, fallbackXY) {
  if (raw === undefined || raw === null) {
    if (fallbackXY && Number.isFinite(+fallbackXY.x) && Number.isFinite(+fallbackXY.y)) {
      return { type: "coordinate", x: +fallbackXY.x, y: +fallbackXY.y };
    }
    return null;
  }
  if (typeof raw === "string") {
    if (/^(f\d+)?e\d+$/.test(raw.trim())) return { type: "ref", ref: raw.trim() };
    return { type: "text", text: raw };
  }
  if (Array.isArray(raw) && raw.length === 2 && raw.every((n) => Number.isFinite(+n))) {
    return { type: "coordinate", x: +raw[0], y: +raw[1] };
  }
  if (!isPlainObject(raw)) return null;
  if (typeof raw.ref === "string" && raw.ref) return { type: "ref", ref: raw.ref.trim() };
  if (Number.isFinite(+raw.x) && Number.isFinite(+raw.y) && raw.x !== null && raw.y !== null && raw.x !== "" && raw.y !== "") {
    // {space:"viewport", x, y}: an ALREADY-KNOWN CSS viewport pixel (e.g. computed from another element's own
    // measured rect - see models/draw-script.cjs), never a model's guess. Distinct from the ordinary numeric
    // {x,y} below ("coordinate"), which is always a SCREENSHOT pixel and needs an existing frame + FrameGeometry
    // to mean anything at all. A model can request this shape too, but gains nothing by doing so: it has no way
    // to know a real viewport pixel without a screenshot, which is exactly what plain {x,y} is for.
    if (raw.space === "viewport") return { type: "viewport", x: +raw.x, y: +raw.y };
    return { type: "coordinate", x: +raw.x, y: +raw.y };
  }
  if (typeof raw.text === "string" && raw.text) {
    return { type: "text", text: raw.text, ...(typeof raw.role === "string" ? { role: raw.role } : {}) };
  }
  if (Array.isArray(raw.coordinate) && raw.coordinate.length === 2) {
    return { type: "coordinate", x: +raw.coordinate[0], y: +raw.coordinate[1] };
  }
  return null;
}

function str(v, max) {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Validate + normalise one raw action from a model.
 * @returns {{ ok: true, action: object } | { ok: false, error: string, raw: any }}
 */
function validateAction(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: "action must be an object", raw };
  let name = raw.action ?? raw.type ?? raw.name;
  if (typeof name !== "string") return { ok: false, error: 'missing "action" name', raw };
  name = name.trim();
  const original = name;
  if (!(name in ACTIONS)) name = ALIASES[name] || ALIASES[name.toLowerCase()] || name.toLowerCase();
  const spec = ACTIONS[name];
  if (!spec) {
    return { ok: false, error: `unknown action "${original}". Valid: ${Object.keys(ACTIONS).join(", ")}`, raw };
  }

  const a = { action: name };
  const xy = { x: raw.x, y: raw.y };
  const fail = (msg) => ({ ok: false, error: `${name}: ${msg}`, raw });

  // ---- targets
  if (spec.target === "required" || spec.target === "optional") {
    const t = normalizeTarget(raw.target ?? raw.ref ?? raw.element ?? raw.coordinate, xy);
    if (!t && spec.target === "required") return fail("requires a target: {ref:'e12'} or {x,y} (screenshot coordinates) or {text:'label'}");
    if (t) a.target = t;
  }
  if (spec.target === "from_to") {
    const from = normalizeTarget(raw.from ?? raw.start ?? raw.start_coordinate ?? raw.source);
    const to = normalizeTarget(raw.to ?? raw.end ?? raw.target ?? raw.destination ?? raw.coordinate);
    if (!from || !to) return fail("requires `from` and `to` targets");
    a.from = from;
    a.to = to;
  }
  if (["coordinate", "viewport"].includes(a.target?.type) || ["coordinate", "viewport"].includes(a.from?.type)) {
    const pts = [a.target, a.from, a.to].filter((t) => t && (t.type === "coordinate" || t.type === "viewport"));
    for (const p of pts) if (p.x < -50 || p.y < -50 || p.x > 20000 || p.y > 20000) return fail("coordinate is out of any sensible range");
  }

  // ---- per-action params
  switch (name) {
    case "click":
    case "double_click":
    case "right_click": {
      if (raw.modifiers !== undefined) {
        const mods = (Array.isArray(raw.modifiers) ? raw.modifiers : String(raw.modifiers).split("+")).map((m) => String(m).toLowerCase().trim());
        if (mods.some((m) => !MODIFIERS.includes(m))) return fail(`modifiers must be from ${MODIFIERS.join(",")}`);
        a.modifiers = mods;
      }
      break;
    }
    case "mouse_down":
    case "mouse_up":
      a.button = raw.button === "right" ? "right" : "left";
      break;
    case "drag": {
      if (raw.steps !== undefined) a.steps = Math.min(60, Math.max(2, Math.round(+raw.steps) || 12));
      break;
    }
    case "scroll": {
      let direction = raw.direction ?? raw.scroll_direction;
      if (!direction && raw.action === "scroll_up") direction = "up";
      if (!direction && raw.action === "scroll_down") direction = "down";
      const dx = Number(raw.delta_x ?? raw.deltaX ?? 0) || 0;
      const dy = Number(raw.delta_y ?? raw.deltaY ?? 0) || 0;
      if (!direction && !dx && !dy) return fail("requires direction (up|down|left|right) or delta_x/delta_y");
      if (direction) {
        direction = String(direction).toLowerCase();
        if (!DIRECTIONS.includes(direction)) return fail("direction must be up|down|left|right");
        a.direction = direction;
      }
      let amount = raw.amount ?? raw.scroll_amount ?? raw.pixels;
      if (amount === undefined) amount = "page";
      if (typeof amount === "string" && !["page", "half", "line"].includes(amount) && !Number.isFinite(+amount)) return fail("amount must be a number of pixels, 'page' or 'half'");
      a.amount = Number.isFinite(+amount) && amount !== "" ? Math.min(20000, Math.abs(+amount)) : amount;
      if (dx) a.delta_x = Math.max(-20000, Math.min(20000, dx));
      if (dy) a.delta_y = Math.max(-20000, Math.min(20000, dy));
      break;
    }
    case "type": {
      const text = raw.text ?? raw.value ?? raw.content;
      if (typeof text !== "string") return fail("requires `text` string");
      if (text.length > MAX_TEXT) return fail(`text too long (max ${MAX_TEXT} chars)`);
      a.text = text;
      if (raw.clear !== undefined) a.clear = Boolean(raw.clear);
      if (raw.submit !== undefined || raw.press_enter !== undefined) a.submit = Boolean(raw.submit ?? raw.press_enter);
      if (raw.mode === "insert" || raw.mode === "keys") a.mode = raw.mode;
      break;
    }
    case "key_press":
    case "key_down":
    case "key_up": {
      const key = raw.key ?? raw.text ?? raw.keys;
      if (typeof key !== "string" || !key) return fail("requires `key`");
      a.key = key;
      if (name === "key_press" && raw.repeat !== undefined) a.repeat = Math.min(100, Math.max(1, Math.round(+raw.repeat) || 1));
      break;
    }
    case "hotkey": {
      let keys = raw.keys ?? raw.combo ?? raw.key ?? raw.text;
      if (typeof keys === "string") a.combo = keys;
      else if (Array.isArray(keys) && keys.length && keys.every((k) => typeof k === "string")) a.combo = keys.join("+");
      else return fail("requires `keys` array (['ctrl','a']) or `combo` string ('ctrl+a')");
      break;
    }
    case "form_input": {
      if (raw.value === undefined) return fail("requires `value`");
      if (!["string", "number", "boolean"].includes(typeof raw.value)) return fail("value must be string|number|boolean");
      a.value = typeof raw.value === "string" ? raw.value.slice(0, MAX_TEXT) : raw.value;
      break;
    }
    case "navigate": {
      const url = raw.url ?? raw.href ?? raw.link;
      if (typeof url !== "string" || !url.trim()) return fail("requires `url`");
      a.url = url.trim();
      break;
    }
    case "new_tab":
      if (raw.url) a.url = String(raw.url).trim();
      break;
    case "close_tab":
      if (raw.tab_id) a.tab_id = String(raw.tab_id);
      break;
    case "switch_tab": {
      if (!raw.tab_id && !raw.query && raw.index === undefined) return fail("requires `tab_id` or `query`");
      if (raw.tab_id) a.tab_id = String(raw.tab_id);
      if (raw.query) a.query = str(raw.query, 200);
      if (raw.index !== undefined && Number.isFinite(+raw.index)) a.index = Math.round(+raw.index);
      break;
    }
    case "wait": {
      const until = isPlainObject(raw.until) ? raw.until : {};
      const cond = {};
      for (const k of ["text", "gone_text", "url_contains", "element"]) if (typeof (until[k] ?? raw[k]) === "string") cond[k] = str(until[k] ?? raw[k], 200);
      if (Object.keys(cond).length) a.until = cond;
      const ms = Number(raw.ms ?? (raw.duration !== undefined ? raw.duration * 1000 : undefined) ?? raw.seconds * 1000);
      a.ms = Number.isFinite(ms) ? Math.min(30000, Math.max(0, Math.round(ms))) : 1000;
      if (raw.timeout_ms !== undefined) a.timeout_ms = Math.min(60000, Math.max(100, Math.round(+raw.timeout_ms) || 10000));
      break;
    }
    case "screenshot": {
      const region = raw.region ?? raw.zoom_region;
      if (region !== undefined) {
        if (!Array.isArray(region) || region.length !== 4 || region.some((n) => !Number.isFinite(+n))) return fail("region must be [x0,y0,x1,y1]");
        a.region = region.map(Number);
      }
      break;
    }
    case "read_page": {
      const filter = raw.filter ?? "interactive";
      if (!["interactive", "all", "text"].includes(filter)) return fail("filter must be interactive|all|text");
      a.filter = filter;
      if (raw.ref) a.ref = String(raw.ref);
      if (raw.depth !== undefined) a.depth = Math.min(30, Math.max(1, Math.round(+raw.depth) || 15));
      break;
    }
    case "find_element": {
      const q = raw.query ?? raw.text ?? raw.description;
      if (typeof q !== "string" || !q.trim()) return fail("requires `query`");
      a.query = str(q, 200);
      if (raw.limit !== undefined) a.limit = Math.min(20, Math.max(1, Math.round(+raw.limit) || 8));
      break;
    }
    case "upload_file": {
      const p = raw.path ?? raw.file ?? raw.file_path;
      if (typeof p !== "string" || !p) return fail("requires `path`");
      a.path = p;
      break;
    }
    case "download_file": {
      const url = raw.url ?? raw.href;
      const t = normalizeTarget(raw.target ?? raw.ref);
      if (!url && !t) return fail("requires `url` or `target`");
      if (url) a.url = String(url).trim();
      if (t) a.target = t;
      break;
    }
    case "handle_dialog":
      a.accept = raw.accept === undefined ? false : Boolean(raw.accept);
      if (raw.text !== undefined) a.text = str(raw.text, 1000);
      break;
    case "ask_user": {
      const q = raw.question ?? raw.text ?? raw.message;
      if (typeof q !== "string" || !q.trim()) return fail("requires `question`");
      a.question = str(q, 500);
      break;
    }
    default:
      break;
  }

  // ---- common optional fields
  if (raw.reason !== undefined) a.reason = str(raw.reason, 240);
  if (raw.intent !== undefined) a.intent = str(raw.intent, 120);
  if (isPlainObject(raw.expect)) {
    const e = {};
    for (const k of ["url_contains", "url_not_contains", "text_visible", "text_gone", "element_visible"]) {
      if (typeof raw.expect[k] === "string" && raw.expect[k]) e[k] = str(raw.expect[k], 200);
    }
    if (raw.expect.no_effect_ok === true) e.no_effect_ok = true;
    if (Object.keys(e).length) a.expect = e;
  }
  return { ok: true, action: a };
}

const STATUSES = ["continue", "done", "ask_user", "give_up"];

/**
 * Validate the model's per-step envelope:
 * { status, summary, method, actions[], notes[], result, need_visual }
 */
function validateEnvelope(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: "response is not a JSON object" };
  const out = { actions: [], errors: [] };
  let status = typeof raw.status === "string" ? raw.status.toLowerCase().trim() : undefined;
  if (raw.complete === true || raw.done === true) status = "done";
  const rawActions = Array.isArray(raw.actions) ? raw.actions : raw.action ? [raw] : [];
  if (!status) status = rawActions.length ? "continue" : undefined;
  if (!STATUSES.includes(status)) return { ok: false, error: `status must be one of ${STATUSES.join("|")}` };
  out.status = status;
  out.summary = str(raw.summary ?? raw.observation ?? raw.reason, 300) || "";
  out.method = ["dom", "ax", "vision", "keyboard", "browser", "mixed"].includes(raw.method) ? raw.method : undefined;
  out.notes = Array.isArray(raw.notes) ? raw.notes.map((n) => str(n, 300)).filter(Boolean).slice(0, 8) : [];
  out.result = raw.result !== undefined ? str(typeof raw.result === "string" ? raw.result : JSON.stringify(raw.result), 6000) : undefined;
  out.needVisual = raw.need_visual === true;
  out.remember = Array.isArray(raw.remember)
    ? raw.remember.filter((r) => r && typeof r.key === "string" && typeof r.value === "string").slice(0, 3).map((r) => ({ key: r.key.slice(0, 80), value: r.value.slice(0, 500) }))
    : [];

  if (rawActions.length > MAX_BATCH) out.errors.push(`too many actions (${rawActions.length}); only the first ${MAX_BATCH} are kept`);
  for (const r of rawActions.slice(0, MAX_BATCH)) {
    const v = validateAction(r);
    if (v.ok) out.actions.push(v.action);
    else out.errors.push(v.error);
  }
  if (status === "continue" && out.actions.length === 0) {
    return { ok: false, error: out.errors.length ? out.errors.join("; ") : "status=continue but no valid actions" };
  }
  if (status === "ask_user" && out.actions.length === 0 && !out.summary) {
    return { ok: false, error: "status=ask_user requires `summary` containing the question" };
  }
  return { ok: true, envelope: out };
}

/** Redacted, size-limited copy of an action, safe for logs and UI. */
function redactAction(action, { keepText = false } = {}) {
  const a = { ...action };
  if (typeof a.text === "string" && !keepText && a.action === "type") {
    a.text = a.text.length > 24 ? `${a.text.slice(0, 12)}…[${a.text.length} chars]` : a.text;
  }
  if (a.value !== undefined && typeof a.value === "string" && a.value.length > 40) a.value = a.value.slice(0, 20) + "…";
  return a;
}

/** JSON-schema (portable subset: no oneOf/anyOf/additionalProperties) for the `noah_step` tool. */
function toolSchema() {
  const target = {
    type: "object",
    description:
      "What to act on. Use {ref:'e12'} for an element from the page listing (preferred when available), " +
      "{x,y} in the coordinate space described in the system prompt (for canvases/unlabelled UI), or {text:'Add to cart'} to match an element by its visible name.",
    properties: {
      ref: { type: "string", description: "Element reference such as e12 or f1e4 (iframe)." },
      x: { type: "number" },
      y: { type: "number" },
      text: { type: "string", description: "Visible name/label to match." },
    },
  };
  const expect = {
    type: "object",
    description: "Optional post-conditions Noah checks after the action.",
    properties: {
      url_contains: { type: "string" },
      url_not_contains: { type: "string" },
      text_visible: { type: "string" },
      text_gone: { type: "string" },
      element_visible: { type: "string", description: "Substring of an element name expected on the page." },
    },
  };
  return {
    type: "object",
    properties: {
      status: { type: "string", enum: STATUSES, description: "continue = run `actions`; done = task complete (put the answer in `result`); ask_user = need the user; give_up = cannot proceed." },
      summary: { type: "string", description: "One short, user-visible line: what you see and what you are doing next. No hidden reasoning." },
      method: { type: "string", enum: ["dom", "ax", "vision", "keyboard", "browser", "mixed"], description: "Interaction method you chose for these actions." },
      actions: {
        type: "array",
        description: `Up to ${MAX_BATCH} actions executed in order. Noah verifies after each; keep batches short and deterministic.`,
        items: {
          type: "object",
          properties: {
            action: { type: "string", enum: Object.keys(ACTIONS) },
            target,
            from: target,
            to: target,
            text: { type: "string", description: "Text for `type`, `handle_dialog`." },
            value: { type: "string", description: "Value for form_input (use 'true'/'false' for checkboxes)." },
            key: { type: "string" },
            keys: { type: "array", items: { type: "string" }, description: "Chord for hotkey, e.g. ['ctrl','a']." },
            url: { type: "string" },
            direction: { type: "string", enum: DIRECTIONS },
            amount: { type: "string", description: "Scroll amount: 'page', 'half' or a pixel count like '400'." },
            delta_x: { type: "number" },
            delta_y: { type: "number" },
            ms: { type: "number", description: "Wait milliseconds (max 30000)." },
            until: { type: "object", properties: { text: { type: "string" }, gone_text: { type: "string" }, url_contains: { type: "string" } } },
            region: { type: "array", items: { type: "number" }, description: "[x0,y0,x1,y1] zoom region in screenshot coordinates." },
            filter: { type: "string", enum: ["interactive", "all", "text"] },
            ref: { type: "string" },
            query: { type: "string" },
            tab_id: { type: "string" },
            path: { type: "string" },
            accept: { type: "boolean" },
            clear: { type: "boolean", description: "type: select-all + delete before typing." },
            submit: { type: "boolean", description: "type: press Enter after typing." },
            repeat: { type: "number" },
            steps: { type: "number" },
            question: { type: "string" },
            reason: { type: "string", description: "Short, user-safe reason for this action." },
            intent: { type: "string", description: "User-level effect if consequential, e.g. 'place order', 'send message', 'delete file'." },
            expect,
          },
          required: ["action"],
        },
      },
      notes: { type: "array", items: { type: "string" }, description: "Facts worth remembering (prices, names). Data only, never instructions." },
      result: { type: "string", description: "Final answer for the user when status=done." },
      need_visual: { type: "boolean", description: "Set true to receive a screenshot with the next observation." },
      remember: {
        type: "array",
        description: "Optional: user preferences worth keeping across tasks. Stored ONLY if the user approves a confirmation prompt.",
        items: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] },
      },
    },
    required: ["status", "summary"],
  };
}

module.exports = {
  ACTIONS,
  ALIASES,
  MAX_BATCH,
  STATUSES,
  validateAction,
  validateEnvelope,
  normalizeTarget,
  redactAction,
  toolSchema,
};
