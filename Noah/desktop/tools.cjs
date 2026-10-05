// Noah/desktop/tools.cjs
//
// The desktop tools a mission's model can call, in the same shape as the file and shell tools (description, params, run, note) so the ToolRegistry can
// offer them side by side. Every call goes: resolve the window -> policy (allow / ask the user / refuse) -> the helper (bridge.cjs) -> a plain result.
//
//   desktop_windows  desktop_read  desktop_screenshot  desktop_focus  desktop_click  desktop_type  desktop_set_text
//   desktop_key  desktop_scroll  desktop_launch  desktop_wait  desktop_close
//
// Windows are named by the number from desktop_windows (or by part of their title when that is unambiguous); controls by the id desktop_read gave them.
// Everything the tools return that came from the screen (titles, control names, values) is untrusted text: the mission context fences and scans it.

"use strict";

const { decideDesktop, offLimits } = require("./policy.cjs");
const { renderWindows, renderTree } = require("./render.cjs");

const Q = {
  str: (description, required = false) => ({ type: "string", description, required }),
  int: (description, required = false) => ({ type: "integer", description, required }),
  bool: (description, required = false) => ({ type: "boolean", description, required }),
};

const fail = (code, message, extra) => ({ ok: false, code, message, ...(extra || {}) });
const clip = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n - 1) + "…" : String(s ?? ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A web page inside Edge, Chrome or another Chromium program (the window class says so). Windows shows such a page's controls slowly and not always at all, so for those
// windows the way to find something is the picture: its text is read (OCR) and the click lands on the text.
// the kinds of control whose name says what a click on them does (a Document, a Pane or a Group is named after its page or its parent: not a clue)
const NAMED_THINGS = new Set(["Button", "SplitButton", "ListItem", "MenuItem", "Hyperlink", "CheckBox", "RadioButton", "TabItem", "TreeItem", "DataItem", "ComboBox", "Edit", "Text", "Slider", "Spinner"]);
const isWeb = (w) => /^Chrome_WidgetWin/.test(String((w && w.class) || ""));

// a title that was cut short for display ("... - Microsoft Ed...") still names its window
const ELLIPSIS = new RegExp("(" + String.fromCharCode(0x2026) + "|\\.\\.\\.)\\s*$");
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function editDistance(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/**
 * Where `want` is written in the text lines OCR read from a picture: [{ text, rect, frac, score }], exact matches first, then by position (top to bottom, left to right).
 * `frac` is how far along its line the match is (0-1), so the click lands on the words and not on the middle of a long line. One wrong letter in six is forgiven: OCR misreads now and then.
 */
function findText(lines, want) {
  const w = norm(want);
  if (!w) return [];
  const wantWords = w.split(" ");
  const out = [];
  const union = (ws) => {
    const x0 = Math.min(...ws.map((k) => k.rect.x)), y0 = Math.min(...ws.map((k) => k.rect.y));
    return { x: x0, y: y0, width: Math.max(...ws.map((k) => k.rect.x + k.rect.width)) - x0, height: Math.max(...ws.map((k) => k.rect.y + k.rect.height)) - y0 };
  };
  for (const l of lines || []) {
    if (!l || !l.rect) continue;
    const words = (l.words || []).map((k) => ({ ...k, n: norm(k.text) })).filter((k) => k.n && k.rect);
    // 1. the exact words, each with its own box (a line can run across two columns of a window)
    if (words.length) {
      let hit = null;
      for (let k = 0; k + wantWords.length <= words.length && !hit; k++) {
        const span = words.slice(k, k + wantWords.length);
        const exact = span.every((s, i) => s.n === wantWords[i] || (wantWords.length === 1 && s.n.includes(wantWords[i])));
        if (exact) hit = { span, score: 0 };
        else if (w.length >= 5 && span.every((s, i) => editDistance(s.n, wantWords[i]) <= Math.floor(wantWords[i].length / 6))) hit = { span, score: 1 }; // OCR misreads a letter now and then
      }
      if (hit) { out.push({ text: hit.span.map((s) => s.text).join(" "), rect: union(hit.span), frac: 0.5, score: hit.score, line: l.text }); continue; }
    }
    // 2. no words (or no match among them): along the line, by characters
    const t = norm(l.text);
    if (!t) continue;
    const i = t.indexOf(w);
    if (i >= 0 && !words.length) { out.push({ text: l.text, rect: l.rect, frac: Math.min(0.95, Math.max(0.05, (i + w.length / 2) / t.length)), score: 0, line: l.text }); continue; }
    if (words.length || w.length < 5) continue;
    const maxd = Math.floor(w.length / 6);
    const tw = t.split(" ");
    const n = wantWords.length;
    for (let k = 0; k + n <= tw.length; k++) {
      const cand = tw.slice(k, k + n).join(" ");
      if (editDistance(cand, w) <= maxd) {
        const at = tw.slice(0, k).join(" ").length + (k > 0 ? 1 : 0);
        out.push({ text: l.text, rect: l.rect, frac: Math.min(0.95, Math.max(0.05, (at + cand.length / 2) / t.length)), score: 1, line: l.text });
        break;
      }
    }
  }
  return out.sort((a, b) => a.score - b.score || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

/** What the picture of a window says, top to bottom: so a failed search for words can show the model what IS there (a different tab, a list scrolled elsewhere, a blank page). */
function readableText(lines, maxChars = 700) {
  const seen = (lines || []).filter((l) => l && l.rect && String(l.text || "").trim().length >= 2).slice().sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const parts = [];
  let used = 0;
  for (const l of seen) {
    const t = clip(String(l.text).replace(/\s+/g, " ").trim(), 40);
    if (used + t.length + 3 > maxChars) break;
    parts.push(t);
    used += t.length + 3;
  }
  return parts.join(" | ");
}

/** Lines that contain a long-enough word of what was asked for ("Ansuman" for "Ansuman Bhattacharjee"): offered to the model, never clicked on its behalf (it could be another person). */
function closeMatches(lines, want) {
  const words = norm(want).split(" ").filter((w) => w.length >= 4).sort((a, b) => b.length - a.length).slice(0, 3);
  const out = [];
  for (const w of words) {
    for (const f of findText(lines, w)) {
      const text = clip(String(f.line || f.text).replace(/\s+/g, " ").trim(), 50);
      if (!out.some((o) => o.text === text)) out.push({ text, x: Math.round(f.rect.x), y: Math.round(f.rect.y) });
    }
  }
  return out.slice(0, 3).map((o) => `"${o.text}" (at ${o.x},${o.y})`).join("; ");
}

const WIN = { window: Q.int("the window's number from desktop_windows"), title: Q.str("or part of the window's title, if it matches exactly one window") };

const DESKTOP_DEFS = {
  desktop_windows: {
    description: "List the windows open on the user's desktop (number, title, program, which one is in front). Start here, and again after launching or closing something.",
    params: {},
    run: (t, a, o) => t.desktop.windows(a, o),
    note: (a, r) => (r.ok ? `desktop_windows (${r.count} windows)` : `desktop_windows failed: ${r.code}`),
  },
  desktop_read: {
    description: "Read what is INSIDE a window: its buttons, fields, menus, text and their state, each with an id you can click or type into. Use it before acting and again after, to check what really happened. For a web page in a browser the page's controls are listed when Windows exposes them (it often does not): then use desktop_screenshot, and desktop_click with text.",
    params: { ...WIN, depth: Q.int("how many levels deep, 1-12 (default 8)"), max: Q.int("most controls to read, up to 600 (default 250)") },
    run: (t, a, o) => t.desktop.read(a, o),
    note: (a, r) => (r.ok ? `desktop_read "${clip(r.title, 40)}" (${r.controls} controls)` : `desktop_read failed: ${r.code}`),
  },
  desktop_screenshot: {
    description: "Look at one window as a PICTURE (attached to your next message). Use it when desktop_read does not show what you need: a game, a canvas, a web page. A web page's picture has a faint grid with coordinates every 100 pixels. To click something by what it SAYS use desktop_click with text; give x and y (in this picture's pixels) only for something with no words, such as an icon.",
    params: { ...WIN },
    run: (t, a, o) => t.desktop.screenshot(a, o),
    note: (a, r) => (r.ok ? `desktop_screenshot "${clip(r.title, 40)}" (${r.width}x${r.height})` : `desktop_screenshot failed: ${r.code}`),
  },
  desktop_focus: {
    description: "Bring a window to the front. (The tools that type or press keys do this for you.)",
    params: { ...WIN },
    run: (t, a, o) => t.desktop.focus(a, o),
    note: (a, r) => (r.ok ? `desktop_focus "${clip(r.title, 40)}"` : `desktop_focus failed: ${r.code}`),
  },
  desktop_click: {
    description: "Click something. BEST: by what it says (text: a contact's name, a button's label): Noah finds that text on the window and clicks it. Or a control by its id from desktop_read (its own action is used when it has one: press, tick, select), or, for something with no words, a spot in your last screenshot (x, y in the picture's pixels). Controls that send, delete, buy or change something ask the user first.",
    params: { text: Q.str("the words on what to click, e.g. a contact's name or a button's label"), nth: Q.int("which one, if the words appear more than once: 1 = the top-most (default 1)"), element: Q.str("control id from desktop_read, e.g. e12"), ...WIN, x: Q.int("x in your last screenshot of that window"), y: Q.int("y in your last screenshot of that window"), double: Q.bool("double-click"), right: Q.bool("right-click"), mouse: Q.bool("use a real mouse click even if the control has its own action") },
    run: (t, a, o) => t.desktop.click(a, o),
    note: (a, r) => (r.ok ? `desktop_click ${r.name ? `"${clip(r.name, 40)}"` : "a spot"} (${r.method})` : `desktop_click failed: ${r.code}`),
  },
  desktop_type: {
    description: "Type text with the keyboard into a window: into the control named by element, or wherever the cursor is (click the box first). Never into a password field. A line break in a chat or mail window sends the message, so that asks the user. This uses the keyboard, so Noah waits until the user has stopped using the computer; desktop_set_text does not need that when the field allows it.",
    params: { text: Q.str("what to type (a new line is Enter)", true), ...WIN, element: Q.str("control id to click into first") },
    run: (t, a, o) => t.desktop.type(a, o),
    note: (a, r) => (r.ok ? `desktop_type ${r.typed} characters` : `desktop_type failed: ${r.code}`),
  },
  desktop_set_text: {
    description: "Replace the whole content of a text field directly, by its id (no keyboard and no mouse, so it works while the user is busy and when the window is behind others: PREFER it). Not for password fields.",
    params: { element: Q.str("control id from desktop_read", true), text: Q.str("the new content", true) },
    run: (t, a, o) => t.desktop.setText(a, o),
    note: (a, r) => (r.ok ? "desktop_set_text" : `desktop_set_text failed: ${r.code}`),
  },
  desktop_key: {
    description: "Press a key or combination in a window, for example ctrl+s (cmd+s on a Mac), ctrl+a, enter, tab, f5. Shortcuts that close or delete ask the user; the Windows key and system shortcuts are refused.",
    params: { combo: Q.str("e.g. ctrl+s", true), ...WIN },
    run: (t, a, o) => t.desktop.key(a, o),
    note: (a, r) => (r.ok ? `desktop_key ${a.combo}` : `desktop_key failed: ${r.code}`),
  },
  desktop_scroll: {
    description: "Scroll a window with the mouse wheel (negative = down, positive = up).",
    params: { ...WIN, clicks: Q.int("wheel clicks, -20 to 20 (default -3)") },
    run: (t, a, o) => t.desktop.scroll(a, o),
    note: (a, r) => (r.ok ? `desktop_scroll ${r.scrolled}` : `desktop_scroll failed: ${r.code}`),
  },
  desktop_launch: {
    description: "Start an installed app by name (as in the Start menu). It waits for the app's window and returns it. A program that is not in the Start menu asks the user; one from a download folder is refused.",
    params: { app: Q.str("the app's name, e.g. Excel"), file: Q.str("or the full path of a program (asks the user)") },
    run: (t, a, o) => t.desktop.launch(a, o),
    note: (a, r) => (r.ok ? `desktop_launch ${clip(r.app || a.file, 40)}` : `desktop_launch failed: ${r.code}`),
  },
  desktop_wait: {
    description: "Wait for a window to appear, by part of its title and/or its program name. Use after an action that opens something.",
    params: { title: Q.str("part of the title"), process: Q.str("program name, e.g. notepad"), seconds: Q.int("how long to wait, 1-30 (default 8)") },
    run: (t, a, o) => t.desktop.wait(a, o),
    note: (a, r) => (r.ok ? `desktop_wait found "${clip(r.title, 40)}"` : `desktop_wait failed: ${r.code}`),
  },
  desktop_close: {
    description: "Close a window as its X button would (the program may ask about saving). Always asks the user.",
    params: { ...WIN },
    run: (t, a, o) => t.desktop.close(a, o),
    note: (a, r) => (r.ok ? `desktop_close "${clip(r.title, 40)}"` : `desktop_close failed: ${r.code}`),
  },
};

const LOOKING = new Set(["desktop_windows", "desktop_read", "desktop_screenshot", "desktop_wait", "desktop_focus"]);

class DesktopTools {
  /**
   * @param {object} o
   * @param {import('./bridge.cjs').DesktopBridge} o.bridge
   * @param {(req: object) => Promise<boolean>} [o.confirm]   asks the user (the confirmation card)
   * @param {() => string} [o.getMode]
   */
  constructor({ bridge, confirm, getMode = () => "autonomous", state = null, appsTtlMs = 10 * 60_000, now = Date.now, ocr = null, idleNeededMs = 2500, maxIdleWaitMs = 10 * 60_000, restoreAfterMs = 4000, confirmWaitMs = 15 * 60_000, notify = () => {}, pause = sleep, takeOver = true } = {}) {
    this.bridge = bridge;
    this.ocr = ocr || (async (buf) => { try { return await require("../perception/ocr.cjs").recognizeText(buf); } catch (_) { return []; } });
    this.idleNeededMs = idleNeededMs; // Noah takes over the mouse and keyboard only after the user has left them alone this long
    this.maxIdleWaitMs = maxIdleWaitMs;
    this.restoreAfterMs = restoreAfterMs;
    this.confirmWaitMs = confirmWaitMs; // a card may wait long: the task runs in the background and the user may not look at once
    this.notify = notify; // told when Noah is about to take over the mouse and keyboard, or has stopped
    this.pause = pause; // (not called `wait`: that is the desktop_wait tool)
    // true (the default): Noah takes the mouse and keyboard at once, shows the Stop bar, and does not give up when the user's hand nudges the mouse; false: Noah waits until the user is
    // still, stops the moment they touch anything, and puts their window back after a few quiet seconds
    this.takeOver = !!takeOver;
    this._clickFails = 0;
    this._launchMisses = new Map(); // app -> how many times it was started and no window of it ever showed up
    this._stopped = false;
    this._restoreTo = null; // the window the user had in front before Noah brought another one forward
    this._restoreTimer = null;
    this.state = state; // the mission's state: told when something outside the files changes, so earlier checks go stale
    this.confirm = confirm || (async () => false);
    this.getMode = getMode;
    this.appsTtlMs = appsTtlMs;
    this.now = now;
    this._elements = new Map(); // control id -> { name, type, password, window }
    this._shots = new Map(); // window number -> { x, y, scale, width, height }
    this._apps = null;
    this._appsAt = 0;
    this.pendingImages = [];
  }

  /** Would this tool change anything? ("act" vs "inspect") */
  static isMutating(name) {
    return name in DESKTOP_DEFS && !LOOKING.has(name);
  }

  /** The desktop changed: any success check made before is now out of date. */
  _changed() {
    try { if (this.state && this.state.recordExternalChange) this.state.recordExternalChange(); } catch (_) { /* a note must never break an action */ }
  }

  /** The pictures taken since the last model message: handed over once, so a picture is sent with one message and not kept. */
  takeImages() {
    const i = this.pendingImages;
    this.pendingImages = [];
    return i;
  }

  /** Emergency stop: whatever the helper is typing or moving stops at once. */
  stop() {
    this._stopped = true;
    if (this._restoreTimer) { clearTimeout(this._restoreTimer); this._restoreTimer = null; }
    this.bridge.stop();
  }

  /** The task is over: put the user's window back, and say that Noah has let go of the mouse and keyboard. */
  async finish() {
    if (this._restoreTimer) { clearTimeout(this._restoreTimer); this._restoreTimer = null; }
    if (!this._stopped) await this._restoreFront();
    this._takeover("idle");
  }

  _takeover(state, text) {
    try { this.notify({ state, text: text || "" }); } catch (_) { /* telling the panel must never break an action */ }
  }

  /**
   * Noah works in the BACKGROUND: it takes over the mouse or keyboard only while the user is not using them. This waits (saying so) until they have been still for a moment,
   * and gives up after a long time rather than for ever.
   */
  async _whenUserIdle(what) {
    if (this.takeOver || this.idleNeededMs <= 0) { this._takeover("active", what); return; }
    const t0 = this.now();
    let said = false;
    for (;;) {
      if (this._stopped) throw Object.assign(new Error("stopped"), { name: "DesktopError", code: "aborted" });
      let idle = null;
      try { idle = (await this.bridge.userIdle()).idleMs; } catch (err) { if (err && err.code === "aborted") throw err; return; } // a helper that cannot tell: go ahead (it stops by itself if the user takes over)
      if (!Number.isFinite(idle) || idle >= this.idleNeededMs) { this._takeover("active", what); return; }
      if (!said) { said = true; this._takeover("waiting", "Waiting for you to stop using the computer"); }
      if (this.now() - t0 > this.maxIdleWaitMs) throw Object.assign(new Error("You kept using the computer, so Noah did not take it over. Ask again when you are away, or do this yourself."), { name: "DesktopError", code: "user_busy" });
      await this.pause(Math.min(1000, Math.max(200, this.idleNeededMs - idle)));
    }
  }

  /** Bring the user's own window back once Noah has not needed the screen for a few seconds (not if the user has moved on themselves). */
  _scheduleRestore() {
    if (this._restoreTimer) clearTimeout(this._restoreTimer);
    if (!this._restoreTo || this._stopped || this.takeOver) return; // (in take-over mode the user's window comes back once, when the task ends)
    this._restoreTimer = setTimeout(() => { this._restoreTimer = null; this._restoreFront().then(() => this._takeover("idle")).catch(() => {}); }, this.restoreAfterMs);
    if (this._restoreTimer.unref) this._restoreTimer.unref();
  }

  async _restoreFront() {
    const r = this._restoreTo;
    this._restoreTo = null;
    if (!r) return;
    try {
      const idle = (await this.bridge.userIdle()).idleMs;
      if (Number.isFinite(idle) && idle < 1500) return; // the user is at the keyboard: whatever they are looking at is theirs
      const list = await this._allWindows();
      const front = list.find((w) => w.foreground);
      if (!front || front.window !== r.focused) return; // they have already moved to something else
      if (!list.some((w) => w.window === r.window)) return; // the window they had has gone
      await this.bridge.focus(r.window);
    } catch (_) { /* putting the window back is a courtesy: never an error */ }
  }

  // ------------------------------------------------------------------------------------------------------------------------ plumbing
  async _wrap(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err && err.name === "DesktopError") {
        const hint = {
          not_foreground: " Bring the window to the front with desktop_focus, then try again.",
          stale: " Read the window again with desktop_read to get current ids.",
          no_window: " Call desktop_windows to see what is open.",
          password_field: " Do not try to get round this: ask the user to type it themselves.",
          focus_failed: " Ask the user to click that window, then try again.",
          input_blocked: " That program may be running as administrator, which blocks Noah's input. Tell the user.",
          user_busy: " The user is using the computer: Noah stopped to stay out of their way. Wait a moment and try again (Noah waits for them to be still before taking over).",
          covered: " Something else is on top of that spot. Take a new screenshot to see what, or choose a spot that is visible.",
          outside_window: " That spot is not inside the window: check the picture's size and your x and y.",
        }[err.code] || "";
        return fail(err.code, err.message + hint, err.listText ? { text: err.listText } : undefined);
      }
      return fail("tool_error", clip((err && err.message) || String(err), 200));
    }
  }

  async _allWindows() {
    return this.bridge.windows();
  }

  /** Window by number or by (unique) part of the title. */
  async _resolve({ window, title } = {}) {
    const list = await this._allWindows();
    if (window) {
      const w = list.find((x) => x.window === window) || (await this.bridge.windows({ all: true })).find((x) => x.window === window);
      if (!w) throw Object.assign(new Error("that window is not open any more: call desktop_windows"), { name: "DesktopError", code: "no_window" });
      return w;
    }
    if (title) {
      const n = String(title).toLowerCase().replace(ELLIPSIS, "").trim();
      const hits = list.filter((x) => String(x.title).toLowerCase().includes(n));
      if (hits.length === 1) return hits[0];
      const listText = renderWindows((hits.length ? hits : list).slice(0, 8));
      throw Object.assign(new Error(hits.length ? `"${clip(title, 60)}" matches ${hits.length} windows (listed below). Use the number.` : `no open window has "${clip(title, 60)}" in its title (the open windows are listed below).`), { name: "DesktopError", code: hits.length ? "ambiguous" : "no_window", listText });
    }
    throw Object.assign(new Error('which window? give "window" (a number from desktop_windows) or "title"'), { name: "DesktopError", code: "no_window" });
  }

  async _gate(a, summary) {
    const v = decideDesktop(a, { mode: this.getMode() });
    if (v.decision === "deny") return fail("policy_denied", `Noah will not do this: ${v.why}. Do not try to get the same effect another way.`);
    if (v.decision === "confirm") {
      let allowed = false;
      try { allowed = await this.confirm({ summary, why: v.why, risk: v.risk, timeoutMs: this.confirmWaitMs }); } catch (_) { allowed = false; }
      if (!allowed) return fail("user_denied", "The user declined this. Do not do it another way: explain, offer an alternative, or stop.");
    }
    return null;
  }

  _remember(hwnd, nodes) {
    for (const [id, v] of this._elements) if (v.window === hwnd) this._elements.delete(id);
    for (const n of nodes) this._elements.set(n.element, { name: n.name, type: n.type, password: !!n.password, window: hwnd });
    if (this._elements.size > 8000) this._elements.clear();
  }

  _el(id) {
    return this._elements.get(String(id || "")) || null;
  }

  async _front(win) {
    await this._whenUserIdle(`Using ${clip(win.title, 40)}`);
    const r = await this.bridge.focus(win.window);
    if (r && r.previous && !this._restoreTo) this._restoreTo = { window: r.previous, focused: win.window }; // what the user was looking at: only the FIRST change counts
    this._scheduleRestore();
    return r;
  }

  /** What is at a screen point, or null. (So a click can be judged by what it would press, not by its numbers.) */
  async _hitAt(x, y) {
    try { const h = await this.bridge.elementAt(x, y); return h && h.found ? h : null; } catch (err) { if (err && err.code === "aborted") throw err; return null; }
  }

  // ------------------------------------------------------------------------------------------------------------------------ looking
  async windows() {
    return this._wrap(async () => {
      const list = (await this._allWindows()).map((w) => (offLimits(w, { reading: true }) ? { ...w, title: "(off-limits window: not shown)" } : w));
      return { ok: true, count: list.length, text: renderWindows(list) };
    });
  }

  async read(a) {
    return this._wrap(async () => {
      const win = await this._resolve(a);
      const denied = await this._gate({ op: "read", window: win });
      if (denied) return denied;
      const depth = Math.max(1, Math.min(a.depth || 8, 12));
      const max = Math.max(10, Math.min(a.max || 250, 600));
      if (isWeb(win)) {
        // a web page: its controls are listed only if Windows gives them quickly (a strict time limit), the browser's own buttons are not worth the time
        let page = null;
        try { page = await this.bridge.interactive(win.window, { maxNodes: Math.min(max, 150), budgetMs: 4000 }); } catch (err) { if (err && err.code === "aborted") throw err; }
        const nodes = page ? page.nodes : [];
        if (page) this._remember(win.window, nodes);
        const listing = nodes.length ? renderTree({ window: win.window, title: page.title, nodes: nodes.map((n) => ({ ...n, depth: 0, parent: -1 })), truncated: page.truncated }) : `Window [${win.window}] "${clip(win.title, 90)}": no controls could be read.`;
        const hint = nodes.length > 5
          ? "This is a web page: the list above is what Windows exposed (it may be partial). To click something by its words use desktop_click with text; look at the page with desktop_screenshot."
          : "This is a web page and Windows exposes almost nothing of it. Look at it with desktop_screenshot, click something by its words with desktop_click and text, type with desktop_type after clicking the box.";
        return { ok: true, window: win.window, title: win.title, controls: nodes.length, truncated: !!(page && page.truncated), text: listing + "\n" + hint };
      }
      const tree = await this.bridge.tree(win.window, { maxDepth: depth, maxNodes: max });
      this._remember(win.window, tree.nodes);
      return { ok: true, window: win.window, title: tree.title, controls: tree.nodes.length, truncated: !!tree.truncated, text: renderTree(tree) };
    });
  }

  async screenshot(a) {
    return this._wrap(async () => {
      const win = await this._resolve(a);
      const denied = await this._gate({ op: "screenshot", window: win });
      if (denied) return denied;
      const grid = isWeb(win) || !!a.grid;
      const shot = await this.bridge.screenshot({ window: win.window, maxWidth: 1280, grid });
      this._shots.set(win.window, { x: shot.x, y: shot.y, scale: shot.scale, width: shot.width, height: shot.height });
      this.pendingImages = [{ mime: shot.mime, base64: shot.base64, width: shot.width, height: shot.height, title: win.title }]; // only the newest picture is kept
      return { ok: true, window: win.window, title: win.title, width: shot.width, height: shot.height, note: `The picture is attached to your next message. Use window ${win.window} for what comes next (a page's title changes). ${shot.grid ? "It has a faint grid, with coordinates every 100 pixels. " : ""}To click something with words on it, use desktop_click with text; for an icon give x and y in the picture's pixels (0,0 is its top-left corner).` };
    });
  }

  async focus(a) {
    return this._wrap(async () => {
      const win = await this._resolve(a);
      const denied = await this._gate({ op: "focus", window: win });
      if (denied) return denied;
      const w = await this._front(win);
      return { ok: true, window: w.window, title: w.title };
    });
  }

  async wait(a) {
    return this._wrap(async () => {
      if (!a.title && !a.process) return fail("invalid_arguments", "wait for what? give title and/or process");
      const seconds = Math.max(1, Math.min(a.seconds || 8, 30));
      const w = await this.bridge.waitWindow({ title: a.title || "", process: a.process || "", waitMs: seconds * 1000 });
      const bad = offLimits(w, { reading: true });
      if (bad) return fail("policy_denied", `Noah will not look at that window: ${bad}`);
      return { ok: true, window: w.window, title: w.title, process: w.process };
    });
  }

  // ------------------------------------------------------------------------------------------------------------------------ acting
  async click(a) {
    const r = await this._click(a);
    if (r && r.ok) this._clickFails = 0;
    else if (r && r.code !== "user_denied" && r.code !== "policy_denied" && r.code !== "aborted") {
      this._clickFails++;
      if (this._clickFails >= 3) r.message += ` That is ${this._clickFails} clicks in a row that have not worked: stop repeating it. Look again (desktop_read or desktop_screenshot), try other words, or tell the user what you can see and ask them.`;
    }
    return r;
  }

  async _click(a) {
    return this._wrap(async () => {
      if (a.text !== undefined && a.text !== null && String(a.text).trim() && !a.element && a.x === undefined) return this._clickText(a);
      const info = a.element ? this._el(a.element) : null;
      const win = await this._resolve(a.element && info && !a.window && !a.title ? { window: info.window } : a);
      if (a.element) {
        const denied = await this._gate({ op: "click", window: win, element: info || { name: "" } }, `Click "${clip(info ? info.name : a.element, 50)}" in ${clip(win.title, 50)} (${win.process})`);
        if (denied) return denied;
        const send = () => this.bridge.click({ element: a.element, double: !!a.double, right: !!a.right, mouse: !!a.mouse, ...(this.takeOver ? { force: true } : {}) });
        let r;
        try { r = await send(); } catch (err) {
          if (!(err && err.code === "not_foreground")) throw err;
          await this._front(win); // the control has no action of its own, so it needs a real click: bring its window forward (once the user is still) and try again
          r = await send();
        }
        this._changed();
        if (r.method === "mouse") this._scheduleRestore();
        return { ok: true, method: r.method, name: r.name, note: "Read the window again to see what changed." };
      }
      if (a.x === undefined || a.y === undefined) return fail("invalid_arguments", "click what? give text (the words on it), an element id from desktop_read, or x and y from a screenshot");
      const shot = this._shots.get(win.window);
      if (!shot) return fail("no_screenshot", "take a screenshot of that window first (desktop_screenshot), then give x and y in its pixels");
      const sx = shot.x + Math.round(a.x / shot.scale);
      const sy = shot.y + Math.round(a.y / shot.scale);
      return this._clickSpot(win, sx, sy, { double: !!a.double, right: !!a.right });
    });
  }

  /** A click at a screen point: judged by what is THERE (its name, whether it is a password field), then made once the user is still. */
  async _clickSpot(win, sx, sy, { double = false, right = false, name = "", via = "spot" } = {}) {
    const hit = await this._hitAt(sx, sy);
    if (hit && hit.password) return fail("password_field", "That spot is a password field: Noah never clicks into one. Do not try to get round this: ask the user to do it themselves.");
    const real = hit && hit.name && NAMED_THINGS.has(hit.type) ? String(hit.name) : ""; // over a web page Windows answers with the whole page (named after its title): that says nothing about what is pressed
    const what = name || real;
    const element = what ? { name: what, type: hit && hit.type } : undefined;
    const denied = await this._gate({ op: "click", window: win, element, spot: true }, `Click ${what ? `"${clip(what, 50)}"` : "a spot"} in ${clip(win.title, 50)} (${win.process})`);
    if (denied) return denied;
    await this._front(win);
    const r = await this.bridge.click({ window: win.window, x: sx, y: sy, double, right, ...(this.takeOver ? { force: true } : {}) });
    this._changed();
    this._scheduleRestore();
    const named = name || (real ? clip(real.replace(/\s+/g, " "), 60) : "");
    return { ok: true, method: r.method, name: named || r.name, at: { x: sx, y: sy }, hit: real ? { name: clip(real.replace(/\s+/g, " "), 60), type: hit.type } : null, via, note: "Take a new screenshot or read the window to see what changed." };
  }

  /**
   * Click something by the words on it. A program that shows its controls quickly gets its control clicked (most exact); a web page, or a control that is not listed,
   * is found by READING THE PICTURE of the window and clicking the middle of those words.
   */
  async _clickText(a) {
    const win = await this._resolve(a);
    const want = String(a.text).trim();
    const nth = Math.max(1, Math.floor(Number(a.nth) || 1));
    const wantNorm = norm(want);

    // (1) a control with that name (not for a web page: reading those is slow, and the picture is the better way)
    if (!isWeb(win)) {
      let page = null;
      try { page = await this.bridge.interactive(win.window, { maxNodes: 150, budgetMs: 3000 }); } catch (err) { if (err && err.code === "aborted") throw err; }
      if (page && page.nodes && page.nodes.length) {
        this._remember(win.window, page.nodes);
        const hits = page.nodes.filter((n) => norm(n.name).includes(wantNorm) && n.enabled !== false);
        if (hits.length === 1 || (hits.length > 1 && a.nth)) return this._click({ element: hits[Math.min(nth, hits.length) - 1].element, window: win.window, double: a.double, right: a.right, mouse: a.mouse });
        if (hits.length > 1) return fail("ambiguous", `"${clip(want, 40)}" names ${hits.length} controls: ${hits.slice(0, 6).map((n, i) => `${i + 1}: ${n.type} "${clip(n.name, 50)}"`).join("; ")}. Say which with nth, or click by element id.`);
      }
    }

    // (2) the words in the picture
    const denied = await this._gate({ op: "screenshot", window: win });
    if (denied) return denied;
    const shot = await this.bridge.screenshot({ window: win.window, maxWidth: 2000 });
    const lines = await this.ocr(Buffer.from(shot.base64, "base64"));
    const found = findText(lines, want);
    if (!found.length) {
      const near = closeMatches(lines, want);
      const readable = readableText(lines);
      return fail("text_not_found", `I could not find "${clip(want, 50)}" written on that window (reading the picture).${near ? ` Close matches (not clicked, it could be someone else): ${near}. Click one with its shorter words if it is the right one.` : ""} ${readable ? `What I can read there: ${readable}.` : "I can read almost no text there: the page may be blank, still loading, covered, or not the one you expect."} If what you want is not in that list it is not on screen: scroll, use the page's search box, or switch to the right tab first. Take a desktop_screenshot to see what is there, or click it by x and y.`);
    }
    if (found.length > 1 && !a.nth) return fail("ambiguous", `"${clip(want, 40)}" appears ${found.length} times: ${found.slice(0, 6).map((f, i) => `${i + 1}: "${clip(f.text, 50)}" (at ${Math.round(f.rect.x)},${Math.round(f.rect.y)})`).join("; ")}. Say which with nth (1 = the top-most).`);
    const pick = found[Math.min(nth, found.length) - 1];
    const px = pick.rect.x + pick.rect.width * pick.frac;
    const py = pick.rect.y + pick.rect.height / 2;
    const sx = shot.x + Math.round(px / shot.scale);
    const sy = shot.y + Math.round(py / shot.scale);
    return this._clickSpot(win, sx, sy, { double: !!a.double, right: !!a.right, name: clip(pick.text, 60), via: "text" });
  }

  async type(a) {
    return this._wrap(async () => {
      const info = a.element ? this._el(a.element) : null;
      const win = await this._resolve(a.element && info && !a.window && !a.title ? { window: info.window } : a);
      const denied = await this._gate({ op: "type", window: win, element: info || undefined, text: a.text }, `Type ${String(a.text).length} characters into ${clip(win.title, 50)} (${win.process})`);
      if (denied) return denied;
      await this._front(win);
      const r = await this.bridge.type(win.window, a.text, { element: a.element, ...(this.takeOver ? { force: true } : {}) });
      this._changed();
      this._scheduleRestore();
      return { ok: true, typed: r.typed, note: "Read the window again to check the text arrived." };
    });
  }

  async setText(a) {
    return this._wrap(async () => {
      const info = this._el(a.element);
      if (!info) return fail("stale", "unknown control: read the window again with desktop_read to get current ids");
      const win = await this._resolve({ window: info.window });
      const denied = await this._gate({ op: "setText", window: win, element: info, text: a.text }, `Set the field "${clip(info.name, 40)}" in ${clip(win.title, 50)} (${win.process})`);
      if (denied) return denied;
      const r = await this.bridge.setText(a.element, a.text);
      this._changed();
      return { ok: true, method: r.method };
    });
  }

  async key(a) {
    return this._wrap(async () => {
      const win = await this._resolve(a);
      const denied = await this._gate({ op: "key", window: win, combo: a.combo }, `Press ${a.combo} in ${clip(win.title, 50)} (${win.process})`);
      if (denied) return denied;
      await this._front(win);
      await this.bridge.key(win.window, a.combo, this.takeOver ? { force: true } : undefined);
      this._changed();
      this._scheduleRestore();
      return { ok: true, pressed: a.combo, note: "Read the window again to see what changed." };
    });
  }

  async scroll(a) {
    return this._wrap(async () => {
      const win = await this._resolve(a);
      const denied = await this._gate({ op: "scroll", window: win }, `Scroll ${clip(win.title, 50)}`);
      if (denied) return denied;
      await this._front(win);
      const r = await this.bridge.scroll({ window: win.window, clicks: a.clicks === undefined ? -3 : a.clicks, ...(this.takeOver ? { force: true } : {}) });
      this._changed();
      this._scheduleRestore();
      return { ok: true, scrolled: r.scrolled };
    });
  }

  async close(a) {
    return this._wrap(async () => {
      const win = await this._resolve(a);
      const denied = await this._gate({ op: "close", window: win }, `Close ${clip(win.title, 50)} (${win.process})`);
      if (denied) return denied;
      const r = await this.bridge.closeWindow(win.window);
      this._changed();
      return { ok: true, title: win.title, closed: !!r.closed, note: r.closed ? "" : "It is still open (the program may be asking about unsaved work): read the window to see." };
    });
  }

  // ------------------------------------------------------------------------------------------------------------------------ starting apps
  async _installed() {
    if (this._apps && this.now() - this._appsAt < this.appsTtlMs) return this._apps;
    this._apps = await this.bridge.apps();
    this._appsAt = this.now();
    return this._apps;
  }

  /** @returns {Promise<{ name: string, id: string } | { error: string }>} */
  async _findApp(name) {
    const apps = await this._installed();
    const n = String(name).toLowerCase().trim();
    const exact = apps.filter((x) => x.name.toLowerCase() === n);
    if (exact.length) return exact[0];
    const starts = apps.filter((x) => x.name.toLowerCase().startsWith(n));
    if (starts.length === 1) return starts[0];
    const has = apps.filter((x) => x.name.toLowerCase().includes(n));
    if (has.length === 1) return has[0];
    const pool = starts.length ? starts : has;
    if (pool.length) return { error: `"${name}" matches several apps: ${pool.slice(0, 8).map((x) => x.name).join(", ")}. Use the exact name.` };
    return { error: `no installed app is called "${name}".` };
  }

  async launch(a) {
    return this._wrap(async () => {
      if (!a.app && !a.file) return fail("invalid_arguments", "launch what? give app (a name) or file (a path)");
      let target;
      let label;
      if (a.app) {
        const found = await this._findApp(a.app);
        if (found.error) return fail("no_such_app", found.error);
        target = { appName: found.name, fromStartMenu: true };
        label = found.name;
        var launchArgs = { appId: found.id };
      } else {
        target = { file: a.file, appName: String(a.file).split(/[\\/]/).pop() };
        label = target.appName;
        launchArgs = { file: a.file };
      }
      const denied = await this._gate({ op: "launch", target }, `Open ${label}`);
      if (denied) return denied;
      // Starting an app again and again, when its window never shows up in the list, does nothing but keep the computer busy (a real Mac test: Chrome was open but its windows could not be
      // read, so the agent started it over and over and the Mac heated up): after two such tries it is told to stop and tell the user.
      const misses = this._launchMisses.get(label) || 0;
      if (misses >= 2) return fail("repeat_blocked", `You have already started "${clip(label, 60)}" ${misses} times and no window of it ever showed up in the list of windows, so starting it again will not help. Do not start it again. Tell the user what you see: if "${clip(label, 60)}" is open on their screen, Jonah may not be allowed to read its windows (on a Mac the Accessibility permission can go stale after Jonah is updated: remove Jonah from that list in the Privacy settings and add it back); otherwise it did not open.`);
      const before = new Set((await this._allWindows()).map((w) => w.window));
      await this.bridge.launch(launchArgs);
      this._changed();
      let fresh = [];
      // reading every window of every app is not cheap: look a few times with growing gaps (about 9 s in all), not 28 times in a row
      for (const gap of [300, 500, 700, 900, 1200, 1500, 1800, 2000]) {
        if (fresh.length) break;
        await this.pause(gap);
        fresh = (await this._allWindows()).filter((w) => !before.has(w.window));
      }
      if (fresh.length) this._launchMisses.delete(label); else this._launchMisses.set(label, misses + 1);
      if (!fresh.length) return { ok: true, app: label, note: "It was started but no new window has appeared yet (it may be starting, or it reused a window that was already open): call desktop_wait or desktop_windows." };
      const shown = fresh.map((w) => (offLimits(w, { reading: true }) ? { ...w, title: "(off-limits window: not shown)" } : w));
      return { ok: true, app: label, window: fresh[0].window, text: renderWindows(shown) };
    });
  }

  /** What the goal verifier needs to check a desktop criterion: read-only, no policy questions (it only looks). */
  verifierEnv() {
    return { windows: () => this.bridge.windows(), tree: (window) => this.bridge.tree(window, { maxDepth: 10, maxNodes: 500 }) };
  }
}

module.exports = { DesktopTools, DESKTOP_DEFS, findText, isWeb, readableText, closeMatches };
