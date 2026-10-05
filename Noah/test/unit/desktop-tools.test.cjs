// Noah/test/unit/desktop-tools.test.cjs - the desktop tools a mission's model can call (Noah/desktop/tools.cjs), and how their output is rendered (render.cjs).
// A FAKE helper stands in for the real one (that is tested against real windows in desktop-bridge.test.cjs), so every policy and wiring branch can be hit exactly:
// which window is meant, what is refused, what asks the user, what reaches the helper, and what comes back.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DesktopTools, DESKTOP_DEFS } = require("../../desktop/tools.cjs");
const { DesktopError } = require("../../desktop/bridge.cjs");
const { renderWindows, renderTree } = require("../../desktop/render.cjs");

const win = (window, title, process, extra = {}) => ({ window, title, process, path: `C:\\Windows\\${process}.exe`, pid: window, x: 10, y: 10, w: 600, h: 400, foreground: false, minimized: false, ...extra });
const NOTEPAD = win(101, "Untitled - Notepad", "notepad");
const VAULT = win(102, "My vault - Bitwarden", "Bitwarden");
const CLAUDE = win(103, "Claude", "claude");
const DISCORD = win(104, "general - Discord", "Discord");
const SHELL = win(105, "Windows PowerShell", "powershell");
const BANK = win(106, "Netbanking - Google Chrome", "chrome");
const TWO_A = win(107, "Report - Word", "WINWORD");
const TWO_B = win(108, "Report copy - Word", "WINWORD");

const node = (element, type, name, extra = {}) => ({ element, depth: 1, parent: 0, name, type, enabled: true, actions: [], ...extra });
const NOTEPAD_TREE = [
  { element: "e1", depth: 0, parent: -1, name: "Untitled - Notepad", type: "Window", enabled: true, actions: [] },
  node("e2", "Edit", "Text Editor", { value: "", actions: ["value"] }),
  node("e3", "Button", "Save", { actions: ["invoke"] }),
  node("e4", "Button", "Delete everything", { actions: ["invoke"] }),
  node("e5", "Edit", "Second entry", { password: true, value: "(hidden)", actions: ["value"] }),
  node("e6", "Pane", "", { actions: [] }),
  node("e7", "CheckBox", "I agree", { toggle: "Off", actions: ["toggle"] }),
];

class FakeBridge {
  constructor({ windows = [NOTEPAD], trees = { 101: NOTEPAD_TREE }, apps = [] } = {}) {
    this._windows = windows; this.trees = trees; this._apps = apps; this.calls = []; this.stopped = 0; this.opens = null; this.failWith = null;
  }
  _maybeFail(op) { if (this.failWith && this.failWith.op === op) throw new DesktopError(this.failWith.message || "boom", this.failWith.code); }
  async windows() { this.calls.push(["windows"]); return this._windows.map((w) => ({ ...w })); }
  async tree(window) { this.calls.push(["tree", window]); this._maybeFail("tree"); const t = this.trees[window]; if (!t) throw new DesktopError("that window no longer exists", "no_window"); return { window, title: (this._windows.find((w) => w.window === window) || {}).title || "", nodes: t, truncated: false }; }
  async screenshot({ window }) { this.calls.push(["screenshot", window]); return { mime: "image/png", base64: "UEZBS0VQSUNUVVJF".repeat(20), width: 640, height: 400, sourceWidth: 1280, sourceHeight: 800, scale: 0.5, x: 100, y: 200 }; }
  async focus(window) { this.calls.push(["focus", window]); this._maybeFail("focus"); const w = this._windows.find((x) => x.window === window) || NOTEPAD; return { ...w }; }
  async click(a) { this.calls.push(["click", a]); this._maybeFail("click"); return { method: a.element ? "invoke" : "mouse", name: a.element ? "Greet" : "(spot)" }; }
  async type(window, text, o) { this.calls.push(["type", window, text, o && o.element]); this._maybeFail("type"); return { typed: text.length }; }
  async setText(element, text) { this.calls.push(["setText", element, text]); this._maybeFail("setText"); return { method: "value", now: text }; }
  async key(window, combo) { this.calls.push(["key", window, combo]); this._maybeFail("key"); return { pressed: combo }; }
  async scroll(a) { this.calls.push(["scroll", a]); return { scrolled: a.clicks }; }
  async launch(a) { this.calls.push(["launch", a]); if (this.opens) this._windows.push(this.opens()); return { started: true, pid: 9 }; }
  async closeWindow(window) { this.calls.push(["close", window]); return { closed: true }; }
  async waitWindow(o) { this.calls.push(["wait", o]); const w = this._windows.find((x) => (!o.title || x.title.toLowerCase().includes(o.title.toLowerCase())) && (!o.process || x.process.toLowerCase() === o.process.toLowerCase())); if (!w) throw new DesktopError("no window like that appeared", "not_found"); return { ...w }; }
  async apps() { this.calls.push(["apps"]); return this._apps; }
  stop() { this.stopped++; }
}

function tools({ bridge = new FakeBridge(), mode = "autonomous", answer = true, state = null } = {}) {
  const asked = [];
  const t = new DesktopTools({ bridge, getMode: () => mode, state, confirm: async (req) => { asked.push(req); return typeof answer === "function" ? answer(req) : answer; } });
  return { t, bridge, asked };
}
const called = (bridge, op) => bridge.calls.filter((c) => c[0] === op);

// ------------------------------------------------------------------------------------------------ rendering
test("windows are listed with the number to use, what is in front, and long titles cut", () => {
  const text = renderWindows([{ ...NOTEPAD, foreground: true }, { ...win(5, "x".repeat(200), "chrome", { minimized: true }) }]);
  assert.match(text, /^Open windows \(2\); the number in \[ \] is what you pass as "window":/);
  assert.match(text, /\[101\] "Untitled - Notepad" - notepad \(in front\) 600x400/);
  assert.match(text, /\[5\] "x{89}…" - chrome \(minimized\)/);
  assert.equal(renderWindows([]), "No windows are open.");
  const many = renderWindows(Array.from({ length: 50 }, (_, i) => win(i + 1, "w", "p")));
  assert.match(many, /\.\.\. and 10 more$/);
  assert.equal(many.split("\n").length, 1 + 40 + 1, "the header, forty windows and the \"more\" line: the rest are not listed");
  assert.equal(renderWindows(Array.from({ length: 5 }, (_, i) => win(i + 1, "w", "p")), { max: 2 }).split("\n").length, 1 + 2 + 1, "the limit can be set");
  assert.equal(renderWindows([win(1, "line one\nline two", "p")]).split("\n").length, 2, "a newline in a title cannot start a fake line: the list is the header and one line");
});

test("a window's controls read as a short outline: ids, kinds, names, state and what can be done; decoration is left out", () => {
  const text = renderTree({ window: 101, title: "Untitled - Notepad", nodes: NOTEPAD_TREE });
  assert.match(text, /^Window \[101\] "Untitled - Notepad": 7 controls\./);
  assert.match(text, /^ {2}\[e2\] Edit "Text Editor" = "" \{value\}$/m);
  assert.match(text, /^ {2}\[e3\] Button "Save" \{invoke\}$/m);
  assert.match(text, /\[e5\] Edit "Second entry" \(PASSWORD FIELD: Noah never types here\)/);
  assert.doesNotMatch(text, /hidden/, "a password value is never printed, not even the placeholder");
  assert.match(text, /\[e7\] CheckBox "I agree" \(off\) \{toggle\}/);
  assert.doesNotMatch(text, /\[e6\]/, "an unnamed pane that does nothing is not shown");
  const odd = renderTree({ window: 1, title: "t", nodes: [{ element: "e1", depth: 0, parent: -1, name: "W", type: "Window", enabled: true, actions: [] }, node("e2", "Button", "Off", { enabled: false, actions: ["invoke"] }), node("e3", "Button", "Far", { offscreen: true, actions: ["invoke"] }), node("e4", "Edit", "F", { focused: true, value: "hi", actions: ["value"] }), node("e5", "ListItem", "Row", { selected: true, actions: ["select"] })] });
  assert.match(odd, /\[e2\] Button "Off" \(disabled\) \{invoke\}/);
  assert.match(odd, /\[e3\] Button "Far" \(off screen\)/);
  assert.match(odd, /\[e4\] Edit "F" = "hi" \(focused\)/);
  assert.match(odd, /\[e5\] ListItem "Row" \(selected\) \{select\}/);
});

test("a window with very many controls is cut, and says so", () => {
  const many = [{ element: "e0", depth: 0, parent: -1, name: "W", type: "Window", enabled: true, actions: [] }, ...Array.from({ length: 300 }, (_, i) => node(`e${i + 1}`, "Button", `B${i}`, { actions: ["invoke"] }))];
  const text = renderTree({ window: 1, title: "t", nodes: many, truncated: true }, { maxLines: 50 });
  assert.equal(text.split("\n").length <= 53, true);
  assert.match(text, /the window has more than this/);
  assert.match(text, /more controls not shown/);
});

// ------------------------------------------------------------------------------------------------ looking
test("desktop_windows lists what is open, and hides the titles of windows Noah may not look at", async () => {
  const { t } = tools({ bridge: new FakeBridge({ windows: [NOTEPAD, VAULT, CLAUDE, SHELL] }) });
  const r = await t.windows();
  assert.equal(r.ok, true);
  assert.equal(r.count, 4);
  assert.match(r.text, /\[101\] "Untitled - Notepad"/);
  assert.doesNotMatch(r.text, /My vault|Bitwarden vault/, "a password manager's window title is not shown");
  assert.match(r.text, /\[102\] "\(off-limits window: not shown\)" - Bitwarden/);
  assert.match(r.text, /\[103\] "\(off-limits window: not shown\)" - claude/);
  assert.match(r.text, /\[105\] "Windows PowerShell" - powershell/, "a terminal may be looked at");
});

test("desktop_read finds the window by number or by a unique part of its title, reads it, and remembers the control ids", async () => {
  const { t, bridge } = tools();
  const byNumber = await t.read({ window: 101 });
  assert.equal(byNumber.ok, true);
  assert.equal(byNumber.controls, 7);
  assert.match(byNumber.text, /\[e3\] Button "Save"/);
  const byTitle = await t.read({ title: "notepad" });
  assert.equal(byTitle.window, 101, "a unique part of the title is enough, in any case");
  assert.deepEqual(called(bridge, "tree").map((c) => c[1]), [101, 101]);
  assert.equal(t._el("e3").name, "Save");
  assert.equal(t._el("e5").password, true);
  assert.equal(t._el("e99"), null);
});

test("an unclear or missing window is an error that lists the windows as screen text, not inside the message", async () => {
  const { t } = tools({ bridge: new FakeBridge({ windows: [TWO_A, TWO_B, NOTEPAD], trees: {} }) });
  const amb = await t.read({ title: "report" });
  assert.deepEqual([amb.ok, amb.code], [false, "ambiguous"]);
  assert.match(amb.message, /matches 2 windows \(listed below\)/);
  assert.match(amb.text, /\[107\] "Report - Word"/);
  assert.doesNotMatch(amb.message, /Report - Word/, "titles are untrusted: they go in the fenced part, never in Noah's own sentence");
  const none = await t.read({ title: "no such thing" });
  assert.equal(none.code, "no_window");
  assert.match(none.text, /\[101\]/);
  assert.equal((await t.read({})).code, "no_window");
  assert.equal((await t.read({ window: 99999 })).code, "no_window");
});

test("windows Noah may not look at are refused with the reason: a password manager, Noah's own window, the Claude app", async () => {
  const { t, bridge } = tools({ bridge: new FakeBridge({ windows: [NOTEPAD, VAULT, CLAUDE], trees: { 102: NOTEPAD_TREE, 103: NOTEPAD_TREE } }) });
  for (const w of [102, 103]) {
    for (const op of ["read", "screenshot"]) {
      const r = await t[op]({ window: w });
      assert.deepEqual([r.ok, r.code], [false, "policy_denied"], `${op} ${w}`);
      assert.match(r.message, /Do not try to get the same effect another way/);
    }
  }
  assert.equal(called(bridge, "tree").length + called(bridge, "screenshot").length, 0, "the helper was never asked");
});

test("a screenshot is attached to the NEXT message once, only the newest is kept, and the result never carries the picture itself", async () => {
  const { t } = tools();
  const r = await t.screenshot({ window: 101 });
  assert.deepEqual([r.ok, r.width, r.height], [true, 640, 400]);
  assert.doesNotMatch(JSON.stringify(r), /UEZBS0VQ/, "the bytes are not in the result (which is saved and shown)");
  assert.equal(t.pendingImages.length, 1);
  await t.screenshot({ window: 101 });
  assert.equal(t.pendingImages.length, 1, "a second picture replaces the first");
  const taken = t.takeImages();
  assert.equal(taken.length, 1);
  assert.equal(taken[0].mime, "image/png");
  assert.match(taken[0].base64, /^UEZBS0VQ/);
  assert.deepEqual(t.takeImages(), [], "handed over once");
});

test("desktop_wait finds a window by title or program, needs one of them, and will not hand over a window Noah may not look at", async () => {
  const { t } = tools({ bridge: new FakeBridge({ windows: [NOTEPAD, VAULT] }) });
  assert.equal((await t.wait({ title: "notepad", seconds: 2 })).window, 101);
  assert.equal((await t.wait({ process: "NOTEPAD" })).window, 101);
  assert.equal((await t.wait({})).code, "invalid_arguments");
  assert.equal((await t.wait({ title: "vault" })).code, "policy_denied");
  assert.equal((await t.wait({ title: "nothing like this" })).code, "not_found");
});

// ------------------------------------------------------------------------------------------------ acting
test("an ordinary click runs without asking in the user's mode, and asks in a stricter one", async () => {
  const a = tools();
  await a.t.read({ window: 101 });
  const r = await a.t.click({ element: "e3" });
  assert.deepEqual([r.ok, r.method], [true, "invoke"]);
  assert.equal(a.asked.length, 0);
  assert.deepEqual(called(a.bridge, "click")[0][1], { element: "e3", double: false, right: false, mouse: false, force: true }, "Noah has been given the mouse: the helper may point again if a hand nudges it");
  const b = tools({ mode: "supervised" });
  await b.t.read({ window: 101 });
  await b.t.click({ element: "e3" });
  assert.equal(b.asked.length, 1);
  assert.match(b.asked[0].summary, /^Click "Save" in Untitled - Notepad \(notepad\)$/);
});

test("a control that sends or deletes always asks; a refusal means the helper is never called", async () => {
  const a = tools({ answer: false });
  await a.t.read({ window: 101 });
  const r = await a.t.click({ element: "e4" });
  assert.deepEqual([r.ok, r.code], [false, "user_denied"]);
  assert.match(r.message, /The user declined this/);
  assert.equal(a.asked.length, 1);
  assert.equal(a.asked[0].risk.level, "high");
  assert.match(a.asked[0].why, /presses "Delete everything"/);
  assert.equal(called(a.bridge, "click").length, 0);
  const b = tools({ answer: true });
  await b.t.read({ window: 101 });
  assert.equal((await b.t.click({ element: "e4" })).ok, true);
  assert.equal(called(b.bridge, "click").length, 1);
});

test("a click at a spot uses the LAST screenshot: pixels of the picture are turned back into screen positions, and the window is brought forward", async () => {
  const { t, bridge } = tools();
  assert.equal((await t.click({ window: 101, x: 40, y: 30 })).code, "no_screenshot", "no picture yet, so no pixels to point at");
  await t.screenshot({ window: 101 }); // scale 0.5, window at (100, 200)
  const r = await t.click({ window: 101, x: 40, y: 30 });
  assert.equal(r.ok, true);
  assert.deepEqual(called(bridge, "click")[0][1], { window: 101, x: 180, y: 260, double: false, right: false, force: true });
  assert.deepEqual(bridge.calls.map((c) => c[0]).slice(-3), ["windows", "focus", "click"], "focused first, then clicked");
  assert.equal((await t.click({ window: 101 })).code, "invalid_arguments", "click what?");
});

test("typing: the window is brought forward first, a password field is refused, and a line break in a chat window asks", async () => {
  const a = tools();
  await a.t.read({ window: 101 });
  const ok = await a.t.type({ text: "hello", element: "e2" });
  assert.deepEqual([ok.ok, ok.typed], [true, 5]);
  assert.deepEqual(a.bridge.calls.filter((c) => ["focus", "type"].includes(c[0])).map((c) => c[0]), ["focus", "type"]);
  assert.deepEqual(called(a.bridge, "type")[0].slice(1), [101, "hello", "e2"]);
  const pw = await a.t.type({ text: "x", element: "e5" });
  assert.deepEqual([pw.ok, pw.code], [false, "policy_denied"]);
  assert.match(pw.message, /never types into a password field/);
  assert.equal(called(a.bridge, "type").length, 1, "the helper was not asked to type into the password field");
  const chat = tools({ bridge: new FakeBridge({ windows: [DISCORD], trees: {} }), answer: false });
  assert.equal((await chat.t.type({ window: 104, text: "see you at 5" })).ok, true, "words in a chat window are fine");
  const sent = await chat.t.type({ window: 104, text: "see you at 5\n" });
  assert.deepEqual([sent.ok, sent.code], [false, "user_denied"]);
  assert.match(chat.asked[0].why, /line break in a messaging or mail window, which sends the message/);
});

test("set_text refuses a password field and an unknown control; keys that leave the task are refused and closing shortcuts ask", async () => {
  const a = tools({ answer: false });
  await a.t.read({ window: 101 });
  assert.equal((await a.t.setText({ element: "e2", text: "Ada" })).ok, true);
  assert.deepEqual(called(a.bridge, "setText")[0].slice(1), ["e2", "Ada"]);
  assert.equal((await a.t.setText({ element: "e5", text: "x" })).code, "policy_denied");
  assert.equal((await a.t.setText({ element: "e99", text: "x" })).code, "stale");
  assert.equal(called(a.bridge, "setText").length, 1);
  assert.equal((await a.t.key({ window: 101, combo: "ctrl+s" })).ok, true);
  const win = await a.t.key({ window: 101, combo: "win+r" });
  assert.deepEqual([win.ok, win.code], [false, "policy_denied"]);
  assert.match(win.message, /leaves the task/);
  const close = await a.t.key({ window: 101, combo: "alt+f4" });
  assert.deepEqual([close.ok, close.code], [false, "user_denied"]);
  assert.deepEqual(called(a.bridge, "key").map((c) => c[2]), ["ctrl+s"], "only the allowed key reached the helper");
});

test("nothing can be typed or clicked in a terminal, Noah's own window, or the Claude app, in any mode", async () => {
  for (const mode of ["autonomous", "supervised", "strict"]) {
    const { t, bridge } = tools({ mode, bridge: new FakeBridge({ windows: [SHELL, CLAUDE, VAULT], trees: { 105: NOTEPAD_TREE } }), answer: true });
    for (const w of [105, 103, 102]) {
      assert.equal((await t.type({ window: w, text: "dir" })).code, "policy_denied", `type ${w} ${mode}`);
      assert.equal((await t.key({ window: w, combo: "enter" })).code, "policy_denied", `key ${w} ${mode}`);
      assert.equal((await t.close({ window: w })).code, "policy_denied", `close ${w} ${mode}`);
      assert.equal((await t.scroll({ window: w })).code, "policy_denied", `scroll ${w} ${mode}`);
    }
    assert.equal(["type", "key", "close", "scroll"].some((op) => called(bridge, op).length), false);
  }
});

test("closing a window always asks, and scrolling works", async () => {
  const a = tools({ answer: false });
  assert.equal((await a.t.close({ window: 101 })).code, "user_denied");
  assert.equal(called(a.bridge, "close").length, 0);
  const b = tools({ answer: true });
  const r = await b.t.close({ window: 101 });
  assert.deepEqual([r.ok, r.closed], [true, true]);
  assert.deepEqual((await b.t.scroll({ window: 101, clicks: -5 })).scrolled, -5);
  assert.equal(called(b.bridge, "scroll")[0][1].clicks, -5);
  await b.t.scroll({ window: 101 });
  assert.equal(called(b.bridge, "scroll")[1][1].clicks, -3, "three clicks down by default");
});

// ------------------------------------------------------------------------------------------------ starting apps
const APPS = [{ name: "Excel", id: "Microsoft.Office.EXCEL.EXE.15" }, { name: "Google Chrome", id: "Chrome" }, { name: "Google Drive", id: "Drive" }, { name: "Notepad", id: "Microsoft.Notepad" }, { name: "Windows PowerShell", id: "PS" }, { name: "Bitwarden", id: "BW" }];
test("an app is launched by its Start-menu name (exact, or a unique start or part), and its new window is returned", async () => {
  const bridge = new FakeBridge({ windows: [], apps: APPS });
  let next = 200;
  bridge.opens = () => win(++next, next === 201 ? "Book1 - Excel" : "Document1 - Notepad", next === 201 ? "EXCEL" : "notepad");
  const { t } = tools({ bridge });
  const r = await t.launch({ app: "excel" });
  assert.equal(r.ok, true);
  assert.equal(r.app, "Excel");
  assert.equal(r.window, 201);
  assert.match(r.text, /\[201\] "Book1 - Excel" - EXCEL/);
  assert.deepEqual(called(bridge, "launch")[0][1], { appId: "Microsoft.Office.EXCEL.EXE.15" });
  assert.equal((await t.launch({ app: "pad" })).ok, true, "a unique part of the name is enough (Notepad)");
  assert.equal(called(bridge, "apps").length, 1, "the app list is fetched once and kept");
});

test("an unclear or unknown app is an error that names the choices; nothing is started", async () => {
  const bridge = new FakeBridge({ windows: [], apps: APPS });
  const { t } = tools({ bridge });
  const amb = await t.launch({ app: "google" });
  assert.deepEqual([amb.ok, amb.code], [false, "no_such_app"]);
  assert.match(amb.message, /matches several apps: Google Chrome, Google Drive/);
  const none = await t.launch({ app: "photoshopper" });
  assert.match(none.message, /no installed app is called "photoshopper"/);
  assert.equal((await t.launch({})).code, "invalid_arguments");
  assert.equal(called(bridge, "launch").length, 0);
});

test("launching: an off-limits app is refused, a download is refused, an unknown program asks, and a Start-menu app asks in stricter modes", async () => {
  const bridge = new FakeBridge({ windows: [], apps: APPS });
  const a = tools({ bridge, answer: false });
  for (const app of ["Windows PowerShell", "Bitwarden"]) assert.equal((await a.t.launch({ app })).code, "policy_denied", app);
  assert.equal((await a.t.launch({ file: "C:\\Users\\me\\Downloads\\setup.exe" })).code, "policy_denied");
  const unknown = await a.t.launch({ file: "D:\\tools\\thing.exe" });
  assert.deepEqual([unknown.ok, unknown.code], [false, "user_denied"]);
  assert.equal(a.asked[0].summary, "Open thing.exe");
  assert.equal(called(bridge, "launch").length, 0);
  const strict = tools({ bridge: new FakeBridge({ windows: [], apps: APPS }), mode: "supervised", answer: false });
  assert.equal((await strict.t.launch({ app: "Excel" })).code, "user_denied");
  assert.match(strict.asked[0].summary, /^Open Excel$/);
});

test("a launch that opens an off-limits window (a security prompt) does not show its title to the model", async () => {
  const bridge = new FakeBridge({ windows: [NOTEPAD], apps: APPS });
  bridge.launch = async function (a) { this.calls.push(["launch", a]); this._windows.push(win(301, "Book1 - Excel", "EXCEL"), win(302, "Windows Security: enter your PIN", "SecHealthUI")); return { started: true, pid: 9 }; };
  const { t } = tools({ bridge });
  const r = await t.launch({ app: "Excel" });
  assert.equal(r.ok, true);
  assert.equal(r.window, 301);
  assert.match(r.text, /Book1 - Excel/);
  assert.match(r.text, /\(off-limits window: not shown\)/);
  assert.doesNotMatch(r.text, /enter your PIN|Windows Security/, "the title of a window Noah may not look at is not handed over");
});

test("when no new window appears the answer says so honestly instead of pretending", async () => {
  const bridge = new FakeBridge({ windows: [NOTEPAD], apps: APPS });
  const { t } = tools({ bridge });
  t._allWindowsOriginal = t._allWindows;
  // shorten the wait: the real loop polls for about eight seconds
  const realSleep = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => realSleep(fn, Math.min(ms, 1), ...rest);
  try {
    const r = await t.launch({ app: "Excel" });
    assert.equal(r.ok, true);
    assert.equal(r.window, undefined);
    assert.match(r.note, /no new window has appeared yet/);
  } finally { global.setTimeout = realSleep; }
});

// ------------------------------------------------------------------------------------------------ plumbing
test("every successful action that changes something tells the mission, so earlier checks go stale; looking and refusals do not", async () => {
  const calls = [];
  const state = { recordExternalChange: () => calls.push(1) };
  const { t, asked } = tools({ state, answer: false, bridge: new FakeBridge({ windows: [NOTEPAD], trees: { 101: NOTEPAD_TREE }, apps: APPS }) });
  await t.windows(); await t.read({ window: 101 }); await t.screenshot({ window: 101 }); await t.focus({ window: 101 }); await t.wait({ title: "note" });
  assert.equal(calls.length, 0, "looking changes nothing");
  await t.click({ element: "e4" }); // declined
  await t.key({ window: 101, combo: "win+r" }); // refused
  assert.equal(calls.length, 0, "a refused or declined action changes nothing");
  assert.equal(asked.length, 1);
  await t.click({ element: "e3" });
  await t.type({ window: 101, text: "x" });
  await t.setText({ element: "e2", text: "x" });
  await t.key({ window: 101, combo: "ctrl+s" });
  await t.scroll({ window: 101 });
  assert.equal(calls.length, 5);
});

test("a helper error becomes a plain result with what to do next; an unexpected error is a tool error, never a crash", async () => {
  const bridge = new FakeBridge();
  const { t } = tools({ bridge });
  await t.read({ window: 101 });
  bridge.failWith = { op: "click", code: "not_foreground", message: "that control's program is not in front" };
  const nf = await t.click({ element: "e3" });
  assert.deepEqual([nf.ok, nf.code], [false, "not_foreground"]);
  assert.match(nf.message, /Bring the window to the front with desktop_focus/);
  bridge.failWith = { op: "click", code: "stale", message: "that control is gone" };
  assert.match((await t.click({ element: "e3" })).message, /Read the window again with desktop_read/);
  bridge.failWith = { op: "click", code: "input_blocked", message: "Windows did not accept the input" };
  assert.match((await t.click({ element: "e3" })).message, /administrator/);
  bridge.failWith = { op: "tree", code: "weird", message: "x" };
  assert.equal((await t.read({ window: 101 })).code, "weird");
  const raw = { windows: async () => { throw new Error("kaboom"); } };
  const broken = new DesktopTools({ bridge: raw });
  const r = await broken.windows();
  assert.deepEqual([r.ok, r.code], [false, "tool_error"]);
});

test("which tools change things: only looking tools do not", () => {
  for (const name of ["desktop_windows", "desktop_read", "desktop_screenshot", "desktop_wait", "desktop_focus"]) assert.equal(DesktopTools.isMutating(name), false, name);
  for (const name of ["desktop_click", "desktop_type", "desktop_set_text", "desktop_key", "desktop_scroll", "desktop_launch", "desktop_close"]) assert.equal(DesktopTools.isMutating(name), true, name);
  assert.equal(DesktopTools.isMutating("fs_read"), false);
  assert.deepEqual(Object.keys(DESKTOP_DEFS).sort(), ["desktop_click", "desktop_close", "desktop_focus", "desktop_key", "desktop_launch", "desktop_read", "desktop_screenshot", "desktop_scroll", "desktop_set_text", "desktop_type", "desktop_wait", "desktop_windows"]);
});

test("stop() kills the helper, and the verifier gets read-only access to windows and controls", async () => {
  const { t, bridge } = tools();
  t.stop();
  assert.equal(bridge.stopped, 1);
  const env = t.verifierEnv();
  assert.equal((await env.windows()).length, 1);
  assert.equal((await env.tree(101)).nodes.length, 7);
  assert.deepEqual(Object.keys(env).sort(), ["tree", "windows"], "looking only: no click, no type");
});

test("every tool has a description and well-formed parameters (what the model is shown)", () => {
  for (const [name, def] of Object.entries(DESKTOP_DEFS)) {
    assert.ok(def.description.length > 40, name);
    assert.equal(typeof def.run, "function", name);
    assert.equal(typeof def.note, "function", name);
    for (const [k, p] of Object.entries(def.params)) {
      assert.ok(["string", "integer", "boolean"].includes(p.type), `${name}.${k}`);
      assert.ok(p.description && p.description.length > 5, `${name}.${k}`);
    }
  }
  assert.equal(DESKTOP_DEFS.desktop_type.params.text.required, true);
  assert.equal(DESKTOP_DEFS.desktop_key.params.combo.required, true);
});
