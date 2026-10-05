// Noah/desktop/host-mac.js - Noah's eyes and hands on a Mac (Intel and Apple silicon). The macOS twin of host.ps1 + NoahDesktop.cs.
//
// It speaks the SAME protocol as the Windows helper: Node (bridge.cjs) starts it once and sends one JSON request per line, {"id", "op", "args"}; it answers one JSON line
// each, {"id", "ok": true, "result"} or {"id", "ok": false, "code", "error"}; the first line it prints is {"ready": true}. The operations, their arguments and their results are
// the Windows helper's, so tools.cjs, policy.cjs and the mission loop are the same on both systems.
//
// It runs under `osascript -l JavaScript host-mac.js` (JXA, built in to every Mac: one universal program, nothing to compile, nothing extra to sign for Intel or Apple silicon).
// It reads the screen through the Accessibility API (AXUIElement) and acts through it where it can (AXPress, AXValue), and through synthetic mouse events (Core Graphics) and
// System Events keystrokes where it cannot. Screenshots use the system's `screencapture`.
//
// THE FILE HAS TWO PARTS.
//   1. createHost(api): all the logic (window numbers, the safety rules, key combinations, how a tree is described, what each operation answers). It touches nothing of
//      macOS: everything comes through `api`, so it is unit-tested here with a stand-in for macOS (Noah/test/unit/desktop-mac-host.test.cjs).
//   2. makeJxaApi(): the real `api`, built from the macOS frameworks. THIS PART HAS NOT BEEN RUN ON A MAC by its author (it was written on Windows). It follows well-known
//      JXA idioms and is isolated so a fix is a small change; `node Noah/bench/integration/desktop-mac-check.cjs` on a Mac exercises every operation for real.
//
// It also works QUIETLY, like the Windows helper: it can tell when the user is using the keyboard or mouse (userIdle) and stops at once if they start (user_busy), it
// refuses to click where another window is on top (covered), checks the pointer really arrived, and lists a window's pressable controls fast (interactive, elementAt).
// Not done on a Mac: the numbered marks and the coordinate grid drawn on screenshots (screenshot answers grid:false), so the picture is read by its words (OCR) instead.
//
// macOS permissions the user must grant to Jonah (System Settings > Privacy & Security): Accessibility (to read and operate other apps), Screen Recording (to take screenshots),
// and Automation > System Events (to type). The helper says exactly which one is missing, instead of failing in a confusing way.

"use strict";

const SAFE_INT = 1_000_000; // window numbers are pid * 1,000,000 + (title hash) * 1000 + n

class HostError extends Error {
  constructor(message, code = "error") {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

// ------------------------------------------------------------------------------------------------ small pure helpers
const clip = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n - 1) + String.fromCharCode(0x2026) : String(s ?? ""));
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** A short stable number for a title (FNV-1a, 0-999): part of a window's number, so a window that changed places does not become another window. */
function titleHash(title) {
  let h = 0x811c9dc5;
  const s = String(title ?? "");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % 1000;
}
const windowNumber = (pid, title, n) => pid * SAFE_INT + titleHash(title) * 1000 + n;
const decodeWindow = (id) => ({ pid: Math.floor(id / SAFE_INT), hash: Math.floor((id % SAFE_INT) / 1000), n: id % 1000 });

/** Escape everything that is not plain ASCII (the line must survive any console setting). */
const NON_ASCII = new RegExp("[" + String.fromCharCode(0x7f) + "-" + String.fromCharCode(0xffff) + "]", "g"); // DEL and everything above (built from character codes: no invisible character sits in this file)
const asciiJson = (obj) => JSON.stringify(obj).replace(NON_ASCII, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

// ---- reading what macOS hands back
// Found on a real Mac (Monterey): a list macOS returns through an out-parameter (the windows or the children of an app) arrives as a BARE CF reference. Its length cannot be read
// directly (`.count` is undefined, Number() of that is NaN, and a loop to NaN never runs), so every list of windows and controls came back EMPTY with no error: "0 windows" while Chrome
// was open. Such a reference (a FUNCTION object, on that Mac) has to be cast to an Objective-C object first; after the cast, `.count` is a number-like string (Number() reads it), strings
// unwrap to text, and elements can be passed straight back to the accessibility calls (all checked on the real Mac). These read a list or a value any way that works, and never throw. `objc` is JXA's ObjC (a stand-in in tests).
function unwrapAny(v, objc) {
  if (v === undefined || v === null) return undefined;
  let r;
  try { r = objc.unwrap(v); } catch (_) { r = undefined; }
  const kind = typeof r;
  if (kind === "string" || kind === "number" || kind === "boolean") return r; // a plain value (on a real Mac a bare reference unwrapped to a FUNCTION object: that is not a value)
  try { const c = objc.unwrap(objc.castRefToObject(v)); if (c !== undefined && c !== null) return c; } catch (_) { /* not a reference that can be cast */ }
  return kind === "function" ? undefined : r; // never hand a function object on as if it were the value
}
function listOf(v, objc) {
  if (v === undefined || v === null) return [];
  let cast = null;
  const tries = [() => v, () => { if (!cast) { try { cast = objc.castRefToObject(v); } catch (_) { cast = false; } } return cast || null; }];
  for (const get of tries) {
    const o = get();
    if (!o) continue;
    let n = NaN;
    try { n = Number(o.count); } catch (_) { n = NaN; }
    if (!Number.isFinite(n)) { try { n = Number(o.count()); } catch (_) { n = NaN; } } // a method, not a property
    if (!Number.isFinite(n) || n < 0) continue;
    const out = [];
    for (let i = 0; i < n; i++) { try { out.push(o.objectAtIndex(i)); } catch (_) { /* an item that cannot be read is skipped, not fatal */ } }
    return out;
  }
  try { const u = objc.unwrap(v); if (Array.isArray(u)) return u; } catch (_) { /* nothing more to try */ }
  return [];
}
const asBool = (v) => (v === true || v === 1 ? true : v === false || v === 0 ? false : undefined);

// the same rule as the Windows helper: a text field whose name says it holds a secret never shows its value
const SENSITIVE_NAME = /pass(word|code)?|\bpin\b|\botp\b|\bcvv\b|card number|secret|token|api.?key/i;

// the accessibility API describes a point and a size as text ("x:12.0 y:34.0", "w:100.0 h:50.0") when asked for a description: read both forms
const parsePoint = (s) => { const m = /x:\s*(-?[\d.]+)\s+y:\s*(-?[\d.]+)/.exec(String(s ?? "")); return m ? { x: Number(m[1]), y: Number(m[2]) } : null; };
const parseSize = (s) => { const m = /w:\s*(-?[\d.]+)\s+h:\s*(-?[\d.]+)/.exec(String(s ?? "")); return m ? { w: Number(m[1]), h: Number(m[2]) } : null; };

// ---- keys
const MODIFIER = { cmd: "command down", command: "command down", meta: "command down", super: "command down", ctrl: "control down", control: "control down", alt: "option down", option: "option down", opt: "option down", shift: "shift down" };
const KEY_CODE = { enter: 36, return: 36, tab: 48, space: 49, escape: 53, esc: 53, backspace: 51, delete: 51, forwarddelete: 117, del: 117, left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };

/** "cmd+shift+s" -> { mods: ["command down", "shift down"], code: undefined, char: "s" }. The same refusals as the Windows helper: no key, a modifier alone, an unknown key. */
function parseCombo(combo) {
  const parts = String(combo ?? "").toLowerCase().replace(/\s+/g, "").split("+").filter((p, i, a) => p !== "" || i === a.length - 1);
  if (!parts.length || (parts.length === 1 && parts[0] === "")) throw new HostError("which key?", "bad_key");
  const last = parts.pop();
  const mods = [];
  for (const p of parts) {
    if (!MODIFIER[p]) throw new HostError(`'${p}' is not a modifier key`, "bad_key");
    if (!mods.includes(MODIFIER[p])) mods.push(MODIFIER[p]);
  }
  if (MODIFIER[last]) throw new HostError(`'${last}' is a modifier key: end the combination with a letter, number or other key (for example cmd+s)`, "bad_key");
  if (KEY_CODE[last] !== undefined) return { mods, code: KEY_CODE[last] };
  if (last.length === 1) return { mods, char: last };
  throw new HostError(`unknown key '${last}'`, "bad_key");
}

// ---- how a control is described (the Windows helper's words, from macOS accessibility roles)
const ROLE = {
  AXButton: "Button", AXMenuButton: "Button", AXPopUpButton: "ComboBox", AXComboBox: "ComboBox", AXCheckBox: "CheckBox", AXRadioButton: "RadioButton", AXSwitch: "CheckBox",
  AXTextField: "Edit", AXTextArea: "Edit", AXSearchField: "Edit", AXStaticText: "Text", AXLink: "Hyperlink", AXImage: "Image", AXGroup: "Group", AXSplitGroup: "Pane",
  AXScrollArea: "Pane", AXToolbar: "ToolBar", AXMenuBar: "MenuBar", AXMenuBarItem: "MenuItem", AXMenu: "Menu", AXMenuItem: "MenuItem", AXTabGroup: "Tab", AXList: "List",
  AXTable: "Table", AXOutline: "Tree", AXRow: "ListItem", AXCell: "ListItem", AXColumn: "Pane", AXWindow: "Window", AXSheet: "Window", AXDialog: "Window", AXSlider: "Slider",
  AXWebArea: "Document", AXSplitter: "Separator", AXSeparator: "Separator", AXValueIndicator: "Thumb", AXDisclosureTriangle: "Button", AXProgressIndicator: "ProgressBar", AXHeading: "Text",
};
const roleName = (role) => ROLE[role] || String(role || "Custom").replace(/^AX/, "") || "Custom";
// the controls worth listing when looking for something to press or fill in (the Windows helper's "interactive" list), and the ones whose words are in their children
const INTERACTIVE_ROLES = new Set(["AXButton", "AXMenuButton", "AXPopUpButton", "AXComboBox", "AXCheckBox", "AXRadioButton", "AXSwitch", "AXTextField", "AXTextArea", "AXSearchField", "AXLink", "AXRow", "AXCell", "AXMenuItem", "AXMenuBarItem", "AXSlider", "AXDisclosureTriangle"]);
const ROW_ROLES = new Set(["AXRow", "AXCell"]);
const OWN_SLACK_MS = 200; // events Noah sends itself arrive a little before Noah notes the time: this much difference is not "the user"
const EDITABLE = new Set(["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]);
const TOGGLES = new Set(["AXCheckBox", "AXRadioButton", "AXSwitch"]);

/**
 * @param {object} api  everything that touches macOS (see makeJxaApi); a stand-in in the tests
 */
function createHost(api) {
  const state = { windows: new Map(), elements: new Map(), seq: 0 };
  const MAX_ELEMENTS = 6000;

  // macOS 12 and older call it System Preferences > Security & Privacy; macOS 13 and newer, System Settings > Privacy & Security
  const WHERE = "System Settings (System Preferences on older Macs) > Privacy & Security (Security & Privacy)";
  // Jonah is not signed with an Apple certificate, so macOS ties its permissions to the exact build: after an update the old tick in the list is stale
  const STALE_HINT = `This usually means the permission belongs to an older version of Jonah. Open ${WHERE} > Accessibility, select Jonah, press the minus (-) button to remove it, quit Jonah, open it again and say yes when macOS asks.`;
  const needAccess = () => { if (!api.isTrusted()) throw new HostError(`Jonah does not have permission to control this Mac yet. Open ${WHERE} > Accessibility and turn Jonah on, then try again. ${STALE_HINT}`, "accessibility_denied"); };

  // ---------------------------------------------------------------------------------------------------------- windows
  // When macOS refuses (or the permission is stale after an update) an app's window list comes back EMPTY with no error, which looked exactly like "no windows are open": a real Mac
  // test had Chrome open, "0 windows", and the agent launching Chrome again and again while the Mac heated up. So every scan is cross-checked against the windows macOS says are on
  // screen; `mismatch` says which apps have a window on screen that Jonah could not read.
  let mismatch = null;
  const staleError = () => new HostError(`macOS shows open windows (${mismatch.missing.slice(0, 4).join(", ")}) but does not let Jonah read them. ${STALE_HINT}`, "accessibility_stale");

  /** `only`: scan just the apps this says yes to (waiting for ONE app's window must not read every app on the Mac, over and over). */
  function snapshot(only = null) {
    needAccess();
    const all = api.listApps();
    if (!all.length) throw new HostError("Jonah could not get the list of running apps from macOS. Quit Jonah, open it again and try once more.", "no_apps");
    const apps = all.slice().sort((a, b) => Number(b.active) - Number(a.active)).filter((a) => !only || only(a));
    const geometry = api.windowBounds();
    const frontPid = (api.frontmost() || {}).pid;
    const list = [];
    const seen = new Map();
    if (!only) state.windows = new Map();
    else for (const [id, w] of state.windows) if (apps.some((a) => a.pid === w.pid)) state.windows.delete(id);
    const missing = [], matched = [];
    for (const app of apps) {
      const wins = api.axWindows(app.pid);
      const onScreen = geometry.some((g) => g.pid === app.pid && g.w >= 60 && g.h >= 40);
      if (wins.length) matched.push(app.name); else if (onScreen) missing.push(app.name);
      wins.forEach((w, index) => {
        const key = `${app.pid}|${titleHash(w.title)}`;
        const n = seen.get(key) || 0;
        seen.set(key, n + 1);
        const id = windowNumber(app.pid, w.title, n);
        const g = geometry.find((x) => x.pid === app.pid && x.title && x.title === w.title) || (wins.length === 1 ? geometry.find((x) => x.pid === app.pid) : null) || { x: 0, y: 0, w: 0, h: 0 };
        state.windows.set(id, { ref: w.ref, pid: app.pid, index, title: w.title, app });
        list.push({ window: id, title: w.title, class: "AXWindow", pid: app.pid, process: app.name, path: app.path, x: g.x, y: g.y, w: g.w, h: g.h, minimized: !!w.minimized, foreground: frontPid === app.pid && !!w.focused });
      });
    }
    mismatch = missing.length && missing.length >= matched.length ? { missing, matched } : null; // a few odd apps may hide their windows; most of them doing so means the permission
    return list;
  }

  function windowOf(id) {
    const wanted = Number(id);
    if (!Number.isFinite(wanted)) throw new HostError("which window?", "no_window");
    let w = state.windows.get(wanted);
    if (!w) { snapshot(); w = state.windows.get(wanted); }
    if (!w) throw new HostError("that window no longer exists", "no_window");
    return w;
  }
  const infoOf = (id) => snapshot().find((x) => x.window === Number(id));

  const isFront = (w) => api.isFrontWindow(w.pid, w.ref);
  const requireFront = (w, what = "that window") => { if (!isFront(w)) throw new HostError(`${what} is not in front, so nothing was sent to it`, "not_foreground"); };

  // ---- staying out of the user's way: the same rules as the Windows helper. macOS keeps ONE "time since the last keyboard or mouse event", which Noah's own events reset too,
  // so Noah remembers when it last sent something itself: if the latest event arrived when Noah's did, nobody else has touched the computer since.
  const own = { at: 0 };
  const stampOwn = () => { own.at = api.now(); };
  const userTookOver = () => own.at !== 0 && api.idleMs() < (api.now() - own.at) - OWN_SLACK_MS;
  // is the user using the computer RIGHT NOW (within `ms`)? For an action that is not part of a run of Noah's own input, so there is no recent stamp to compare with
  const userActiveWithin = (ms) => { const raw = api.idleMs(); const ours = own.at !== 0 && raw >= (api.now() - own.at) - OWN_SLACK_MS; return !ours && raw < ms; };
  const requireNoUser = (extra = "") => { if (userTookOver()) throw new HostError("you started using the computer, so Noah stopped to stay out of your way" + extra, "user_busy"); };

  // a click lands on whatever is on top at that spot: if that is another program's window the click would go to it
  function requireUncovered(w, x, y) {
    const top = api.windowAt(x, y);
    if (top && top.pid !== w.pid) throw new HostError(`something else is on top of that spot${top.name ? ` (${clip(top.name, 40)})` : ""}, so the click would not reach the window: move or close it, or choose a spot that is visible`, "covered");
  }

  /** A real mouse click at a screen point, checked at every step: the window is in front, the spot is inside it and visible, the pointer really arrived, and the user has not moved in. */
  function clickAt(w, x, y, { right = false, double = false, force = false } = {}) {
    requireFront(w);
    const r = api.windowRect(w.pid, w.index);
    if (!r || x < r.x || y < r.y || x > r.x + r.w || y > r.y + r.h) throw new HostError("that spot is outside the window", "outside_window");
    requireUncovered(w, x, y);
    api.mouseMove(x, y);
    stampOwn();
    api.sleep(80);
    let c = api.cursor();
    // Noah has been given the mouse ("take over"): if the pointer is not where it was sent (a hand nudged it), point again a few times instead of giving up
    for (let tries = 0; force && tries < 3 && (!c || Math.abs(c.x - x) > 4 || Math.abs(c.y - y) > 4); tries++) { api.mouseMove(x, y); stampOwn(); api.sleep(80); c = api.cursor(); }
    if (!c || Math.abs(c.x - x) > 4 || Math.abs(c.y - y) > 4) throw new HostError("someone moved the mouse while Noah was pointing, so it did not click: wait until they are still", "user_busy");
    if (!force) requireNoUser();
    requireFront(w); // the pointer has arrived: is the window still in front, and the spot still visible?
    requireUncovered(w, x, y);
    api.mouseClick(x, y, { right, count: double ? 2 : 1 });
    stampOwn();
  }

  // the words of a list row or cell live in the text inside it (the row itself has no title)
  function rowText(ref) {
    const parts = [];
    const visit = (r, depth) => {
      if (depth > 3) return;
      for (const c of api.axChildren(r)) {
        if (parts.length >= 4) return;
        const a = api.axInfo(c);
        if (a.role === "AXStaticText") { const t = oneLine(a.value || a.title); if (t) parts.push(t); }
        else visit(c, depth + 1);
      }
    };
    visit(ref, 1);
    return parts.join(" ");
  }

  function bringToFront(w) {
    for (let attempt = 1; attempt <= 4; attempt++) {
      api.raiseWindow(w.pid, w.ref);
      api.sleep(attempt * 90);
      if (isFront(w)) return;
    }
    throw new HostError("macOS did not bring that window to the front (another app may be holding focus). Click it yourself, or ask again.", "focus_failed");
  }

  // ---------------------------------------------------------------------------------------------------------- controls
  const nameOf = (a) => oneLine((a.role || "") === "AXStaticText" ? a.value || a.title : a.title || a.description || a.placeholder || a.help || "");
  const describe = (ref, depth, parent, win) => makeNode(api.axInfo(ref), ref, depth, parent, win);

  function makeNode(a, ref, depth, parent, win) {
    const role = a.role || "";
    const type = roleName(role);
    const secret = a.subrole === "AXSecureTextField";
    const name = nameOf(a);
    const id = `e${++state.seq}`;
    state.elements.set(id, { ref, win, role, subrole: a.subrole, name, password: secret });
    if (state.elements.size > MAX_ELEMENTS) state.elements.delete(state.elements.keys().next().value);
    const actions = [];
    if ((a.actions || []).includes("AXPress")) actions.push("invoke");
    if (TOGGLES.has(role)) actions.push("toggle");
    if (EDITABLE.has(role) && a.settable) actions.push("value");
    if (role === "AXScrollArea") actions.push("scroll");
    const n = { element: id, depth, parent, name: clip(name, 200), type, enabled: a.enabled !== false, actions };
    if (secret) { n.password = true; n.value = "(hidden)"; }
    else if (EDITABLE.has(role)) n.value = SENSITIVE_NAME.test(name) ? "(hidden: looks sensitive)" : clip(String(a.value ?? ""), 500);
    else if (role === "AXSlider" && a.value !== undefined) n.value = String(a.value);
    if (TOGGLES.has(role)) n.toggle = a.value === 1 || a.value === true ? "On" : a.value === 2 ? "Indeterminate" : "Off";
    if (a.selected === true) n.selected = true;
    if (a.focused === true) n.focused = true;
    return n;
  }

  function elementOf(id) {
    const e = state.elements.get(String(id));
    if (!e) throw new HostError("that control is from an earlier read of the window: read the window again to get current ids", "stale");
    return e;
  }

  // ---------------------------------------------------------------------------------------------------------- the operations
  const ops = {
    ping: () => "pong",

    windows() {
      let list = snapshot();
      for (let i = 0; mismatch && i < 2; i++) { api.sleep(350); list = snapshot(); } // a window that has only just opened may not be readable for a moment
      if (mismatch) throw staleError();
      return list;
    },

    tree({ window, maxDepth = 8, maxNodes = 250 }) {
      needAccess();
      const w = windowOf(window);
      const nodes = [];
      let truncated = false;
      const walk = (ref, depth, parent) => {
        if (nodes.length >= maxNodes) { truncated = true; return; }
        const n = describe(ref, depth, parent, Number(window));
        const index = nodes.push(n) - 1;
        if (depth >= maxDepth) return;
        for (const child of api.axChildren(ref)) {
          if (nodes.length >= maxNodes) { truncated = true; return; }
          walk(child, depth + 1, index);
        }
      };
      walk(w.ref, 0, -1);
      return { window: Number(window), title: w.title, nodes, truncated };
    },

    screenshot({ window, maxWidth = 1280 }) {
      needAccess();
      const w = windowOf(window);
      if (!api.canRecordScreen()) throw new HostError(`Jonah does not have Screen Recording permission, so it cannot take screenshots. Open ${WHERE} > Screen Recording (it is further down the list), turn Jonah on, quit Jonah, open it again and try again.`, "screen_recording_denied");
      const r = api.windowRect(w.pid, w.index);
      if (!r || !(r.w > 0) || !(r.h > 0)) throw new HostError("could not measure that window", "no_window");
      const shot = api.capture(r, Math.max(200, Math.min(Number(maxWidth) || 1280, 3000)));
      return { mime: "image/png", base64: shot.base64, width: shot.width, height: shot.height, sourceWidth: shot.sourceWidth, sourceHeight: shot.sourceHeight, scale: shot.width / r.w, x: r.x, y: r.y, grid: false, marks: false };
    },

    focus({ window }) {
      needAccess();
      const before = snapshot().find((x) => x.foreground); // what the user is looking at now: the caller puts it back when the task is done
      const w = windowOf(window);
      bringToFront(w);
      const info = infoOf(window) || { window: Number(window), title: w.title, pid: w.pid, process: w.app.name, path: w.app.path, foreground: true };
      return { ...info, previous: before && before.window !== Number(window) ? before.window : null };
    },

    click(a) {
      needAccess();
      if (a.element) {
        const e = elementOf(a.element);
        if (e.password) throw new HostError("that is a password field: Noah never clicks into one", "password_field");
        const name = e.name;
        if (a.right) { if (!api.axAction(e.ref, "AXShowMenu")) throw new HostError("that control has no context menu", "not_invokable"); return { method: "menu", name }; }
        if (!a.mouse && api.axAction(e.ref, "AXPress")) {
          if (a.double) { api.sleep(120); api.axAction(e.ref, "AXPress"); }
          return { method: "invoke", name };
        }
        // no action of its own (a row in a list, something a web page handles itself), or a real click was asked for: click the middle of it, which needs its window in front
        const r = api.axRect(e.ref);
        if (!r || !(r.w > 0) || !(r.h > 0)) throw new HostError("that control cannot be pressed (take a screenshot and click a spot instead)", "not_invokable");
        clickAt(windowOf(e.win), Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2), { double: !!a.double, force: !!a.force });
        return { method: "mouse", name };
      }
      const w = windowOf(a.window);
      const x = Number(a.x), y = Number(a.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new HostError("click where? give x and y", "bad_arguments");
      clickAt(w, Math.round(x), Math.round(y), { right: !!a.right, double: !!a.double, force: !!a.force });
      return { method: "mouse", name: "(spot)" };
    },

    scroll({ window, clicks = -3, force }) {
      needAccess();
      const w = windowOf(window);
      requireFront(w);
      const r = api.windowRect(w.pid, w.index);
      if (r) api.mouseMove(Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2));
      stampOwn(); // from here on, any input that is not ours is the user's
      const n = Math.max(-40, Math.min(40, Math.round(Number(clicks) || 0)));
      for (let i = 0; i < Math.abs(n); i++) { if (!force) requireNoUser(); requireFront(w); api.scrollWheel(n > 0 ? 1 : -1); stampOwn(); api.sleep(30); }
      return { scrolled: n };
    },

    setText({ element, text }) {
      needAccess();
      const e = elementOf(element);
      if (e.password) throw new HostError("that is a password field: Noah never types into one", "password_field");
      if (!api.axSetValue(e.ref, String(text ?? ""))) throw new HostError("that control cannot be filled in directly: click it and type instead", "not_settable");
      return { method: "value", now: String(api.axInfo(e.ref).value ?? "") };
    },

    type({ window, text, element, force }) {
      needAccess();
      const w = windowOf(window);
      const s = String(text ?? "");
      if (element) {
        const e = elementOf(element);
        if (e.password) throw new HostError("that is a password field: Noah never types into one", "password_field");
        api.axFocus(e.ref);
      }
      bringToFront(w);
      const focusedIsSecret = () => { const f = api.axFocusedElement(w.pid); return !!f && f.subrole === "AXSecureTextField"; };
      if (focusedIsSecret()) throw new HostError("the cursor is in a password field: Noah never types into one", "password_field");
      let typed = 0;
      const chars = Array.from(s);
      const cut = (err) => { err.message += typed > 0 ? ` (${typed} of ${chars.length} characters had already been typed)` : ""; return err; };
      stampOwn(); // from here on, any input that is not ours is the user's
      for (const ch of chars) {
        try { if (!force) requireNoUser(); requireFront(w, "the window"); } catch (e) { throw cut(e); } // before EVERY character: if the user types or clicks elsewhere, typing stops
        if (typed % 20 === 19 && focusedIsSecret()) throw cut(new HostError("the cursor moved into a password field: stopped", "password_field"));
        if (ch === "\n") api.keyCode(36, []);
        else if (ch === "\t") api.keyCode(48, []);
        else if (ch !== "\r") api.keystroke(ch, []);
        stampOwn();
        typed++;
      }
      return { typed };
    },

    key({ window, combo, force }) {
      needAccess();
      const k = parseCombo(combo);
      const w = windowOf(window);
      requireFront(w, "the window");
      if (!force && userActiveWithin(1000)) throw new HostError("you are using the computer, so Noah did not press the key: wait until you are still", "user_busy");
      if (k.code !== undefined) api.keyCode(k.code, k.mods);
      else api.keystroke(k.char, k.mods);
      stampOwn();
      return { pressed: String(combo) };
    },

    launch({ appId, file }) {
      if (!appId && !file) throw new HostError("launch what? give appId or file", "bad_arguments");
      const pid = api.launch(appId ? { path: String(appId) } : { path: String(file) });
      return { started: true, pid: pid ?? null };
    },

    close({ window }) {
      needAccess();
      const w = windowOf(window);
      const same = (x) => x.pid === w.pid && x.title === w.title; // windows with one title are told apart only by their order, so closing the first renumbers the next: count them instead
      const before = snapshot().filter(same).length;
      if (!api.closeWindow(w.ref)) throw new HostError("that window has no close button", "not_closable");
      api.sleep(300);
      return { closed: snapshot().filter(same).length < before };
    },

    /** How long since the USER last used the keyboard or mouse. What Noah itself sent does not count: right after Noah's own action the answer is "a long time". */
    userIdle() {
      const raw = api.idleMs();
      const ours = own.at !== 0 && raw >= (api.now() - own.at) - OWN_SLACK_MS;
      return { idleMs: ours ? 3_600_000 : Math.round(raw), own: ours };
    },

    /** The controls of a window that can be pressed or filled in, flat, within a time limit (a big window cannot hold the task up). */
    interactive({ window, maxNodes = 150, budgetMs = 4000 }) {
      needAccess();
      const w = windowOf(window);
      const t0 = api.now();
      const cap = Math.max(10, Math.min(Number(maxNodes) || 150, 400));
      const nodes = [];
      let truncated = false;
      const walk = (ref, depth) => {
        if (truncated) return;
        if (nodes.length >= cap || api.now() - t0 > (Number(budgetMs) || 4000)) { truncated = true; return; }
        let a = api.axInfo(ref);
        const role = a.role || "";
        let descend = true;
        if (INTERACTIVE_ROLES.has(role)) {
          if (ROW_ROLES.has(role) && !nameOf(a)) { const text = rowText(ref); if (text) a = { ...a, title: text }; }
          const named = !!nameOf(a);
          if (named || EDITABLE.has(role) || TOGGLES.has(role)) {
            const n = makeNode(a, ref, 0, -1, Number(window));
            delete n.depth; delete n.parent;
            nodes.push(n);
          }
          descend = ROW_ROLES.has(role) && !named; // a button or a named row is a leaf for this purpose
        }
        if (descend && depth < 14) for (const child of api.axChildren(ref)) walk(child, depth + 1);
      };
      walk(w.ref, 0);
      return { window: Number(window), title: w.title, nodes, truncated };
    },

    /** What is at a screen point (so a click can be judged by what it would press, not by its numbers). */
    elementAt({ x, y }) {
      needAccess();
      const px = Number(x), py = Number(y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) throw new HostError("where? give x and y", "no_target");
      const ref = api.axElementAt(px, py);
      if (!ref) return { found: false };
      let a = api.axInfo(ref);
      if (ROW_ROLES.has(a.role) && !nameOf(a)) a = { ...a, title: rowText(ref) };
      const d = { found: true, name: nameOf(a), type: roleName(a.role), enabled: a.enabled !== false };
      if (a.subrole === "AXSecureTextField") d.password = true;
      return d;
    },

    cursor: () => api.cursor(),

    waitWindow({ title = "", process = "", waitMs = 8000 }) {
      needAccess();
      const t = String(title).toLowerCase(), p = String(process).toLowerCase();
      const until = api.now() + Math.max(500, Number(waitMs) || 8000);
      const only = p ? (app) => String(app.name).toLowerCase().includes(p) : null; // reading every app's windows every few hundred ms is what made a Mac hot
      for (;;) {
        const hit = snapshot(only).find((x) => (!t || String(x.title).toLowerCase().includes(t)) && (!p || String(x.process).toLowerCase() === p));
        if (hit) return hit;
        if (api.now() >= until) {
          if (mismatch) throw staleError(); // the window IS there; Jonah is not being allowed to read it: say so instead of "it did not appear"
          throw new HostError("no such window appeared in time", "timeout");
        }
        api.sleep(700);
      }
    },

    apps: () => api.installedApps(),
  };

  /** One request line (already parsed) -> one reply object. Never throws. */
  function handle(req) {
    const id = req && req.id;
    try {
      const op = ops[req && req.op];
      if (!op || !Object.prototype.hasOwnProperty.call(ops, req.op)) throw new HostError(`unknown operation '${req && req.op}'`, "bad_op");
      return { id, ok: true, result: op(req.args || {}) };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (e instanceof HostError) return { id, ok: false, code: e.code, error: msg };
      if (/-1743|not authori[sz]ed to send Apple events|errAEEventNotPermitted/i.test(msg)) return { id, ok: false, code: "automation_denied", error: "Jonah does not have permission to control System Events (needed to type). Open System Settings (System Preferences on older Macs) > Privacy & Security (Security & Privacy) > Automation, allow Jonah to control System Events, then try again." };
      return { id, ok: false, code: "error", error: clip(msg, 300) };
    }
  }

  return { handle, ops, state };
}

// ================================================================================================ the real macOS layer (JXA)
// NOT RUN BY ITS AUTHOR: see the header. Each function is small and does one thing, so a fix after the first run on a Mac is local.
function makeJxaApi() {
  ObjC.import("Cocoa");
  ObjC.import("ApplicationServices");
  ObjC.import("CoreGraphics");
  ObjC.import("Foundation");
  const se = Application("System Events");
  const sh = Application.currentApplication();
  sh.includeStandardAdditions = true;

  const unwrap = (o) => unwrapAny(o, ObjC);
  const str = (o) => { const v = unwrap(o); return v == null || typeof v === "object" ? "" : String(v); };
  const quote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const tmpDir = () => str($.NSTemporaryDirectory()).replace(/\/$/, "");
  const sleepMs = (ms) => { $.NSThread.sleepForTimeInterval(ms / 1000); };

  const axApp = (pid) => { const el = $.AXUIElementCreateApplication(pid); $.AXUIElementSetMessagingTimeout(el, 1.5); return el; };
  const asObject = (v) => { try { return ObjC.castRefToObject(v); } catch (_) { return v; } };
  const same = (a, b) => { try { return !!a && !!b && !!$.CFEqual(a, b); } catch (_) { return false; } }; // two references to the same window? (a comparison that fails is "no", never an error)
  const attr = (el, name) => { const r = Ref(); const e = $.AXUIElementCopyAttributeValue(el, $(name), r); return e === 0 && r[0] !== undefined && r[0] !== null ? asObject(r[0]) : undefined; };
  const attrBool = (el, name) => asBool(unwrap(attr(el, name))) === true;
  const arrayOf = (list) => listOf(list, ObjC);
  const actionNames = (el) => { const r = Ref(); const e = $.AXUIElementCopyActionNames(el, r); if (e !== 0 || !r[0]) return []; return arrayOf(r[0]).map((x) => str(x)).filter(Boolean); };
  const frontApp = () => $.NSWorkspace.sharedWorkspace.frontmostApplication;

  function postMouse(type, x, y, button, clickState) {
    const ev = $.CGEventCreateMouseEvent($(), type, $.CGPointMake(x, y), button);
    if (clickState) $.CGEventSetIntegerValueField(ev, $.kCGMouseEventClickState, clickState);
    $.CGEventPost($.kCGHIDEventTap, ev);
  }

  return {
    isTrusted: () => !!$.AXIsProcessTrusted(),
    canRecordScreen() {
      // (on a real Mac $.CGPreflightScreenCaptureAccess was undefined: the old code then said "yes" and screenshots came back without other apps' windows)
      try { if (typeof $.CGPreflightScreenCaptureAccess !== "function") ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]); return !!$.CGPreflightScreenCaptureAccess(); } catch (_) { /* before macOS 10.15 there is no such permission, or it cannot be bound: look at the windows instead */ }
      try { // other apps' windows have no names unless Screen Recording is allowed
        const info = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID))) || [];
        const others = info.filter((w) => w.kCGWindowLayer === 0 && w.kCGWindowBounds && w.kCGWindowBounds.Width > 60 && w.kCGWindowOwnerName !== "Jonah");
        return !others.length || others.some((w) => !!w.kCGWindowName);
      } catch (_) { return true; }
    },
    sleep: sleepMs,
    now: () => Date.now(),

    listApps() {
      const out = [];
      for (const a of arrayOf($.NSWorkspace.sharedWorkspace.runningApplications)) {
        if (Number(a.activationPolicy) !== 0) continue; // regular apps only (not menu-bar helpers and daemons)
        out.push({ pid: Number(a.processIdentifier), name: str(a.localizedName), path: str(a.bundleURL && a.bundleURL.path), bundleId: str(a.bundleIdentifier), active: !!a.active, hidden: !!a.hidden });
      }
      return out;
    },
    frontmost() { const a = frontApp(); return a ? { pid: Number(a.processIdentifier), name: str(a.localizedName) } : null; },

    axWindows(pid) {
      const app = axApp(pid);
      const focused = attr(app, "AXFocusedWindow");
      return arrayOf(attr(app, "AXWindows")).map((w) => ({ ref: w, title: str(attr(w, "AXTitle")), minimized: attrBool(w, "AXMinimized"), focused: attrBool(w, "AXMain") || same(focused, w) }));
    },
    isFrontWindow(pid, ref) {
      const a = frontApp();
      if (!a || Number(a.processIdentifier) !== pid) return false;
      const fw = attr(axApp(pid), "AXFocusedWindow");
      return same(fw, ref);
    },
    raiseWindow(pid, ref) {
      $.AXUIElementPerformAction(ref, $("AXRaise"));
      $.AXUIElementSetAttributeValue(ref, $("AXMain"), $.kCFBooleanTrue);
      const ra = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
      if (ra) { try { ra.activateWithOptions($.NSApplicationActivateIgnoringOtherApps); } catch (_) { /* macOS 14: activate() below */ } try { ra.activate; } catch (_) { /* ignored */ } }
    },

    // window geometry: the on-screen list needs no permission for sizes; titles often need Screen Recording, so a window is matched by pid and title (best effort, display only)
    windowBounds() {
      const out = [];
      const info = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID))) || [];
      for (const w of info) {
        if (w.kCGWindowLayer !== 0 || !w.kCGWindowBounds) continue;
        out.push({ pid: w.kCGWindowOwnerPID, title: w.kCGWindowName || "", x: Math.round(w.kCGWindowBounds.X), y: Math.round(w.kCGWindowBounds.Y), w: Math.round(w.kCGWindowBounds.Width), h: Math.round(w.kCGWindowBounds.Height) });
      }
      return out;
    },
    windowRect(pid, index) {
      const p = se.processes.whose({ unixId: pid })[0];
      const w = p.windows[index];
      const pos = w.position(), size = w.size();
      return { x: Math.round(pos[0]), y: Math.round(pos[1]), w: Math.round(size[0]), h: Math.round(size[1]) };
    },

    axChildren: (ref) => arrayOf(attr(ref, "AXChildren")),
    axInfo(ref) {
      const names = actionNames(ref);
      const sr = Ref();
      const settable = $.AXUIElementIsAttributeSettable(ref, $("AXValue"), sr) === 0 && sr[0] === true;
      const rawValue = attr(ref, "AXValue");
      const value = unwrap(rawValue);
      return {
        role: str(attr(ref, "AXRole")), subrole: str(attr(ref, "AXSubrole")), title: str(attr(ref, "AXTitle")), description: str(attr(ref, "AXDescription")), help: str(attr(ref, "AXHelp")),
        placeholder: str(attr(ref, "AXPlaceholderValue")), value: typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined,
        enabled: asBool(unwrap(attr(ref, "AXEnabled"))), focused: asBool(unwrap(attr(ref, "AXFocused"))), selected: asBool(unwrap(attr(ref, "AXSelected"))), actions: names, settable,
      };
    },
    axAction: (ref, name) => $.AXUIElementPerformAction(ref, $(name)) === 0,
    axSetValue: (ref, text) => $.AXUIElementSetAttributeValue(ref, $("AXValue"), $(text)) === 0,
    axFocus: (ref) => $.AXUIElementSetAttributeValue(ref, $("AXFocused"), $.kCFBooleanTrue) === 0,
    axFocusedElement(pid) {
      const f = attr(axApp(pid), "AXFocusedUIElement");
      return f ? { subrole: str(attr(f, "AXSubrole")), role: str(attr(f, "AXRole")) } : null;
    },
    closeWindow(ref) { const b = attr(ref, "AXCloseButton"); return !!b && $.AXUIElementPerformAction(b, $("AXPress")) === 0; },

    keystroke(ch, mods) { se.keystroke(ch, mods && mods.length ? { using: mods } : {}); },
    keyCode(code, mods) { se.keyCode(code, mods && mods.length ? { using: mods } : {}); },
    mouseMove(x, y) { postMouse($.kCGEventMouseMoved, x, y, $.kCGMouseButtonLeft); },
    mouseClick(x, y, { right, count }) {
      const down = right ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown, up = right ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp, button = right ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;
      for (let i = 1; i <= count; i++) { postMouse(down, x, y, button, i); sleepMs(30); postMouse(up, x, y, button, i); sleepMs(60); }
    },
    scrollWheel(dy) { const ev = $.CGEventCreateScrollWheelEvent2($(), $.kCGScrollEventUnitLine, 1, dy, 0, 0); $.CGEventPost($.kCGHIDEventTap, ev); },
    cursor() { const p = $.CGEventGetLocation($.CGEventCreate($())); return { x: Math.round(p.x), y: Math.round(p.y) }; },

    // seconds since the last keyboard or mouse event of any kind (hardware, or sent by a program: Noah tells its own apart in createHost)
    idleMs() { return Number($.CGEventSourceSecondsSinceLastEventType($.kCGEventSourceStateCombinedSessionState, 4294967295)) * 1000; }, // 4294967295 is "any input event"
    // the program whose window is on top at a screen point (the list is front to back; only ordinary windows count, not the Dock, the menu bar or Noah's own Stop bar)
    windowAt(x, y) {
      const info = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID))) || [];
      for (const w of info) {
        if (w.kCGWindowLayer !== 0 || !w.kCGWindowBounds) continue;
        const b = w.kCGWindowBounds;
        if (x >= b.X && y >= b.Y && x <= b.X + b.Width && y <= b.Y + b.Height) return { pid: w.kCGWindowOwnerPID, name: w.kCGWindowOwnerName || "" };
      }
      return null;
    },
    axElementAt(x, y) { const r = Ref(); const e = $.AXUIElementCopyElementAtPosition($.AXUIElementCreateSystemWide(), x, y, r); return e === 0 ? r[0] : null; },
    axRect(ref) {
      const p = attr(ref, "AXPosition"), s = attr(ref, "AXSize");
      if (!p || !s) return null;
      const pt = parsePoint(str($.CFCopyDescription(p))), sz = parseSize(str($.CFCopyDescription(s)));
      return pt && sz ? { x: pt.x, y: pt.y, w: sz.w, h: sz.h } : null;
    },

    capture(rect, maxWidth) {
      const file = `${tmpDir()}/noah-shot-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`;
      try {
        sh.doShellScript(`/usr/sbin/screencapture -x -t png -R${rect.x},${rect.y},${rect.w},${rect.h} ${quote(file)}`);
        const dims = (f) => { const t = sh.doShellScript(`/usr/bin/sips -g pixelWidth -g pixelHeight ${quote(f)}`); return { w: Number((/pixelWidth:\s*(\d+)/.exec(t) || [])[1]), h: Number((/pixelHeight:\s*(\d+)/.exec(t) || [])[1]) }; };
        const source = dims(file);
        if (!(source.w > 0)) throw new HostError("the screenshot could not be taken", "screenshot_failed");
        if (source.w > maxWidth) sh.doShellScript(`/usr/bin/sips --resampleWidth ${Math.round(maxWidth)} ${quote(file)} --out ${quote(file)}`);
        const out = dims(file);
        const base64 = str($.NSData.dataWithContentsOfFile($(file)).base64EncodedStringWithOptions(0));
        return { base64, width: out.w, height: out.h, sourceWidth: source.w, sourceHeight: source.h };
      } finally {
        try { $.NSFileManager.defaultManager.removeItemAtPathError($(file), $()); } catch (_) { /* gone */ }
      }
    },

    launch({ path }) {
      const before = new Set(this.listApps().map((a) => a.pid));
      sh.doShellScript(`/usr/bin/open ${quote(path)}`);
      for (let i = 0; i < 20; i++) { sleepMs(150); const fresh = this.listApps().find((a) => !before.has(a.pid)); if (fresh) return fresh.pid; }
      return null;
    },
    installedApps() {
      const home = str($.NSHomeDirectory());
      const dirs = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", `${home}/Applications`];
      const out = [];
      for (const dir of dirs) {
        const entries = $.NSFileManager.defaultManager.contentsOfDirectoryAtPathError($(dir), $());
        if (!entries) continue;
        for (const e of arrayOf(entries)) { const n = str(e); if (/\.app$/.test(n)) out.push({ name: n.replace(/\.app$/, ""), id: `${dir}/${n}` }); }
      }
      return out;
    },
  };
}

// ================================================================================================ the program
function main() {
  ObjC.import("Foundation");
  const api = makeJxaApi();
  const host = createHost(api);
  const stdout = $.NSFileHandle.fileHandleWithStandardOutput;
  const say = (obj) => stdout.writeData($(asciiJson(obj) + "\n").dataUsingEncoding($.NSUTF8StringEncoding));
  say({ ready: true });
  const stdin = $.NSFileHandle.fileHandleWithStandardInput;
  let buffer = "";
  for (;;) {
    const data = stdin.availableData; // blocks until the bridge writes a line; empty when the bridge has closed the pipe
    if (!data || Number(data.length) === 0) break;
    buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let req;
      try { req = JSON.parse(line); } catch (_) { say({ id: null, ok: false, code: "bad_request", error: "that line is not JSON" }); continue; }
      say(host.handle(req));
    }
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { unwrapAny, listOf, asBool, createHost, HostError, parseCombo, titleHash, windowNumber, decodeWindow, asciiJson, roleName, parsePoint, parseSize, SENSITIVE_NAME, KEY_CODE, MODIFIER, INTERACTIVE_ROLES, OWN_SLACK_MS };
} else {
  main();
}
