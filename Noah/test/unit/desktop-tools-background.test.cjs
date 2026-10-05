// Noah/test/unit/desktop-tools-background.test.cjs - the computer agent working QUIETLY and clicking ACCURATELY (Noah/desktop/tools.cjs).
//   * it takes over the mouse and keyboard only while the user is not using them, says so, and gives up rather than waiting for ever
//   * it puts the user's own window back afterwards, but never over something the user has moved on to
//   * a click by words goes to the control with that name when Windows lists it, otherwise to the words found in a picture of the window; the click point is exact
//   * a click at a spot is judged by what is there (a password field is refused; a messaging window asks first), and every refusal explains itself
// A fake helper stands in for the real one (the real helper is checked against real windows in desktop-bridge.test.cjs and Noah/bench/integration/desktop-web-check.cjs).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DesktopTools, findText, isWeb, readableText, closeMatches } = require("../../desktop/tools.cjs");
const { DesktopError } = require("../../desktop/bridge.cjs");

const win = (window, title, process, extra = {}) => ({ window, title, process, path: `C:\\Windows\\${process}.exe`, pid: window, x: 10, y: 10, w: 600, h: 400, foreground: false, minimized: false, class: "", ...extra });
const NOTEPAD = win(101, "Untitled - Notepad", "notepad");
const OTHER = win(102, "Budget - Excel", "EXCEL");
const EDGE_WA = win(201, "WhatsApp - Microsoft Edge", "msedge", { class: "Chrome_WidgetWin_1" });
const EDGE_NEWS = win(202, "News - Microsoft Edge", "msedge", { class: "Chrome_WidgetWin_1" });

const node = (element, type, name, extra = {}) => ({ element, name, type, enabled: true, actions: [], ...extra });
const SHOT = { mime: "image/png", base64: "UEZBS0VQSUNUVVJF".repeat(20), width: 1000, height: 600, sourceWidth: 1000, sourceHeight: 600, scale: 0.5, x: 100, y: 200 };

class FakeBridge {
  constructor({ windows = [NOTEPAD, OTHER], idle = [10_000], interactive = null, hits = {}, previous = 102 } = {}) {
    this._windows = windows; this.idleSeq = idle; this.idleAt = 0; this.page = interactive; this.hits = hits; this.previous = previous;
    this.calls = []; this.stopped = 0; this.failWith = null; this.idleThrows = null; this.shotArgs = []; this.interactiveArgs = [];
  }
  _maybeFail(op) { if (this.failWith && this.failWith.op === op) { const f = this.failWith; if (f.once) this.failWith = null; throw new DesktopError(f.message || "boom", f.code); } }
  async windows() { this.calls.push(["windows"]); return this._windows.map((w) => ({ ...w })); }
  async userIdle() { this.calls.push(["userIdle"]); if (this.idleThrows) throw this.idleThrows; const v = this.idleSeq[Math.min(this.idleAt++, this.idleSeq.length - 1)]; return { idleMs: v }; }
  async interactive(window, o) { this.calls.push(["interactive", window]); this.interactiveArgs.push(o); this._maybeFail("interactive"); return this.page ? { window, title: "t", truncated: false, ...this.page } : { window, title: "t", nodes: [], truncated: false }; }
  async tree(window) { this.calls.push(["tree", window]); return { window, title: "t", nodes: [node("e1", "Window", "t")], truncated: false }; }
  async elementAt(x, y) { this.calls.push(["elementAt", x, y]); const h = this.hits[`${x},${y}`] || this.hits.any; return h ? { found: true, ...h } : { found: false }; }
  async screenshot(a) { this.calls.push(["screenshot", a.window]); this.shotArgs.push(a); return { ...SHOT, grid: !!a.grid }; }
  async focus(window) { this.calls.push(["focus", window]); this._maybeFail("focus"); const w = this._windows.find((x) => x.window === window) || NOTEPAD; return { ...w, previous: this.previous }; }
  async click(a) { this.calls.push(["click", a]); this._maybeFail("click"); return { method: a.element ? "invoke" : "mouse", name: a.element ? "Greet" : "(spot)" }; }
  async type(window, text, o) { this.calls.push(["type", window, text]); this.typeArgs = o; return { typed: text.length }; }
  async key(window, combo, o) { this.calls.push(["key", window, combo]); this.keyArgs = o; return { pressed: combo }; }
  async scroll(a) { this.calls.push(["scroll", a]); this.scrollArgs = a; return { scrolled: a.clicks }; }
  async setText(element, text) { this.calls.push(["setText", element, text]); return { method: "value" }; }
  stop() { this.stopped++; }
}

function make({ bridge = new FakeBridge(), answer = true, ocr = async () => [], extra = {} } = {}) {
  const asked = [], notes = [], clock = { t: 0 }, pauses = [];
  const t = new DesktopTools({
    bridge, getMode: () => "autonomous", ocr,
    confirm: async (req) => { asked.push(req); return typeof answer === "function" ? answer(req) : answer; },
    notify: (n) => notes.push(n),
    now: () => clock.t,
    pause: async (ms) => { pauses.push(ms); clock.t += ms; },
    restoreAfterMs: 60_000, // a timer test sets its own
    takeOver: false, // these tests are about the QUIET mode (waiting for the user); the take-over mode has its own tests at the end
    ...extra,
  });
  return { t, bridge, asked, notes, clock, pauses };
}
const calls = (b, op) => b.calls.filter((c) => c[0] === op);
const line = (text, x, y, w, h, words) => ({ text, rect: { x, y, width: w, height: h }, ...(words ? { words } : {}) });
const word = (text, x, y, w, h) => ({ text, rect: { x, y, width: w, height: h } });

// ------------------------------------------------------------------------------------------------ staying out of the user's way
test("Noah waits until the user has been still, says it is waiting, then says it is working; nothing is touched before then", async () => {
  const bridge = new FakeBridge({ idle: [100, 400, 1200, 3000] });
  const { t, notes, pauses } = make({ bridge });
  const r = await t.focus({ window: 101 });
  assert.equal(r.ok, true);
  assert.deepEqual(notes.map((n) => n.state), ["waiting", "active"], "the panel is told once that Noah is waiting, then that it has taken over");
  assert.match(notes[0].text, /Waiting for you to stop using the computer/);
  assert.match(notes[1].text, /Using Untitled - Notepad/);
  assert.equal(pauses.length, 3, "it looked again after each short pause");
  assert.ok(pauses.every((p) => p >= 200 && p <= 1000), "short pauses, so it reacts soon after the user stops");
  const order = bridge.calls.map((c) => c[0]);
  assert.ok(order.lastIndexOf("userIdle") < order.indexOf("focus"), "the window is brought forward only AFTER the user was still");
});

test("with the user already still there is no waiting and no 'waiting' message", async () => {
  const { t, notes, pauses } = make({ bridge: new FakeBridge({ idle: [9000] }) });
  await t.focus({ window: 101 });
  assert.deepEqual(notes.map((n) => n.state), ["active"]);
  assert.equal(pauses.length, 0);
});

test("every action that takes the mouse or keyboard waits for the user; actions that only read or use the accessibility tree do not", async () => {
  const mk = () => make({ bridge: new FakeBridge({ idle: [0, 0, 5000], interactive: { nodes: [node("e2", "Button", "Save", { actions: ["invoke"] })] } }) });
  for (const [what, run] of [
    ["focus", (t) => t.focus({ window: 101 })],
    ["type", (t) => t.type({ window: 101, text: "hi" })],
    ["key", (t) => t.key({ window: 101, combo: "ctrl+s" })],
  ]) {
    const { t, pauses, bridge } = mk();
    const r = await run(t);
    assert.equal(r.ok, true, `${what}: ${JSON.stringify(r)}`);
    assert.ok(pauses.length >= 1, `${what} waited for the user`);
    assert.equal(calls(bridge, "userIdle").length >= 2, true, what);
  }
  const { t, bridge, pauses } = make({ bridge: new FakeBridge({ idle: [0], interactive: { nodes: [node("e2", "Button", "Save", { actions: ["invoke"] })] } }) });
  await t.read({ window: 101 });
  await t.windows();
  await t.screenshot({ window: 101 });
  await t.setText({ element: "e2", text: "x" }).catch(() => {});
  assert.equal(pauses.length, 0, "reading, listing and screenshots never wait for the user");
  assert.equal(calls(bridge, "userIdle").length, 0, "and do not even ask whether the user is busy");
});

test("an invoke click on a control that has its own action does not wait for the user (it never touches the mouse); a real mouse click does", async () => {
  const b = new FakeBridge({ idle: [0, 0, 5000] });
  const { t, pauses } = make({ bridge: b });
  await t.read({ window: 101 });
  t._elements.set("e3", { name: "Save", type: "Button", password: false, window: 101 });
  await t.click({ element: "e3" });
  assert.equal(pauses.length, 0, "pressed through the accessibility tree: the user is not disturbed");
  // the control has no action: the helper says it needs the window in front, so Noah waits for the user, brings it forward, and tries again
  let first = true;
  b.click = async function (a) { this.calls.push(["click", a]); if (first) { first = false; throw new DesktopError("needs to be in front", "not_foreground"); } return { method: "mouse", name: "Row" }; };
  const r = await t.click({ element: "e3" });
  assert.equal(r.ok, true);
  assert.equal(r.method, "mouse");
  assert.ok(pauses.length >= 1, "it waited for the user before taking over the mouse");
  assert.equal(calls(b, "focus").length, 1);
  assert.equal(calls(b, "click").length, 3, "the first press, the failed press, and the retry");
});

test("if the user keeps working, Noah gives up after the limit with a message that says what to do, and has touched nothing", async () => {
  const bridge = new FakeBridge({ idle: [0] });
  const { t, notes } = make({ bridge, extra: { maxIdleWaitMs: 5000 } });
  const r = await t.type({ window: 101, text: "hello" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "user_busy");
  assert.match(r.message, /kept using the computer/);
  assert.match(r.message, /Wait a moment and try again/, "the model is told what to do next");
  assert.equal(calls(bridge, "focus").length + calls(bridge, "click").length + calls(bridge, "type").length, 0, "nothing was done");
  assert.equal(notes.filter((n) => n.state === "waiting").length, 1, "the waiting message is not repeated every second");
});

test("a Stop while Noah is waiting for the user ends the wait at once", async () => {
  const bridge = new FakeBridge({ idle: [0] });
  const { t } = make({ bridge, extra: { pause: async () => { t.stop(); } } });
  const r = await t.focus({ window: 101 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "aborted");
  assert.equal(bridge.stopped, 1);
  assert.equal(calls(bridge, "focus").length, 0);
});

test("a helper that cannot tell how long the user has been idle does not block the task; a helper that is stopped does", async () => {
  const b1 = new FakeBridge();
  b1.idleThrows = new Error("not supported");
  const { t: t1 } = make({ bridge: b1 });
  assert.equal((await t1.focus({ window: 101 })).ok, true);
  const b2 = new FakeBridge();
  b2.idleThrows = new DesktopError("stopped", "aborted");
  const { t: t2 } = make({ bridge: b2 });
  assert.equal((await t2.focus({ window: 101 })).code, "aborted");
  const { t: t3, bridge: b3 } = make({ bridge: new FakeBridge({ idle: [0] }), extra: { idleNeededMs: 0 } });
  assert.equal((await t3.focus({ window: 101 })).ok, true, "with the wait switched off nothing is asked");
  assert.equal(calls(b3, "userIdle").length, 0);
});

test("the Stop bar words: 'waiting' and 'working' come through the notify channel, and finishing says Noah has let go", async () => {
  const { t, notes } = make({ bridge: new FakeBridge({ idle: [9000] }) });
  await t.type({ window: 101, text: "x" });
  assert.deepEqual(notes.map((n) => n.state), ["active"]);
  await t.finish();
  assert.deepEqual(notes.map((n) => n.state), ["active", "idle"]);
  const { t: quiet } = make({ extra: { notify: () => { throw new Error("panel gone"); } } });
  await assert.doesNotReject(() => quiet.focus({ window: 101 }), "a failing panel never breaks an action");
});

// ------------------------------------------------------------------------------------------------ giving the user their window back
test("when the task ends, the window the user had in front is put back (only if it is still Noah's window in front, and the user is not typing)", async () => {
  // Noah brought Notepad (101) forward; the user had Excel (102)
  const mkWins = (frontId) => [win(101, "Untitled - Notepad", "notepad", { foreground: frontId === 101 }), win(102, "Budget - Excel", "EXCEL", { foreground: frontId === 102 })];
  {
    const bridge = new FakeBridge({ windows: mkWins(101), idle: [9000], previous: 102 });
    const { t } = make({ bridge });
    await t.focus({ window: 101 });
    assert.equal(calls(bridge, "focus").length, 1);
    await t.finish();
    assert.deepEqual(calls(bridge, "focus").map((c) => c[1]), [101, 102], "Excel is back in front");
  }
  {
    const bridge = new FakeBridge({ windows: mkWins(102), idle: [9000], previous: 102 });
    const { t } = make({ bridge });
    await t.focus({ window: 101 });
    await t.finish();
    assert.equal(calls(bridge, "focus").length, 1, "the user already moved on to something else (the window in front is not Noah's): leave it");
  }
  {
    const bridge = new FakeBridge({ windows: mkWins(101), idle: [9000, 100], previous: 102 });
    const { t } = make({ bridge });
    await t.focus({ window: 101 });
    await t.finish();
    assert.equal(calls(bridge, "focus").length, 1, "the user is at the keyboard right now: whatever they are looking at is theirs");
  }
  {
    const bridge = new FakeBridge({ windows: [mkWins(101)[0]], idle: [9000], previous: 102 });
    const { t } = make({ bridge });
    await t.focus({ window: 101 });
    await t.finish();
    assert.equal(calls(bridge, "focus").length, 1, "the user's window was closed meanwhile: nothing to put back");
  }
  {
    const bridge = new FakeBridge({ windows: mkWins(101), idle: [9000], previous: null });
    const { t } = make({ bridge });
    await t.focus({ window: 101 });
    await t.finish();
    assert.equal(calls(bridge, "focus").length, 1, "Noah was already in front: nothing to put back");
  }
});

test("only the FIRST window the user had counts, however many windows Noah visits; a stopped task does not touch the user's windows", async () => {
  const wins = [win(101, "Untitled - Notepad", "notepad"), win(103, "Other", "other", { foreground: true }), win(102, "Budget - Excel", "EXCEL")];
  const bridge = new FakeBridge({ windows: wins, idle: [9000], previous: 102 });
  const { t } = make({ bridge });
  await t.focus({ window: 101 });
  bridge.previous = 101; // the second visit would "remember" Notepad as what the user had: it must not
  await t.focus({ window: 103 });
  assert.deepEqual(t._restoreTo, { window: 102, focused: 101 });
  const b2 = new FakeBridge({ windows: [win(101, "Untitled - Notepad", "notepad", { foreground: true }), OTHER], idle: [9000], previous: 102 });
  const { t: t2 } = make({ bridge: b2 });
  await t2.focus({ window: 101 });
  t2.stop();
  await t2.finish();
  assert.equal(calls(b2, "focus").length, 1, "after a Stop the user's window is left exactly as it is");
});

test("a few seconds after Noah last needed the screen, the user's window comes back by itself", async () => {
  const wins = [win(101, "Untitled - Notepad", "notepad", { foreground: true }), OTHER];
  const bridge = new FakeBridge({ windows: wins, idle: [9000], previous: 102 });
  const { t, notes } = make({ bridge, extra: { restoreAfterMs: 30 } });
  await t.focus({ window: 101 });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(calls(bridge, "focus").map((c) => c[1]), [101, 102]);
  assert.equal(notes.at(-1).state, "idle", "and Noah says it has let go");
  // another action moves the timer on
  const b2 = new FakeBridge({ windows: wins, idle: [9000], previous: 102 });
  const { t: t2 } = make({ bridge: b2, extra: { restoreAfterMs: 80 } });
  await t2.focus({ window: 101 });
  await new Promise((r) => setTimeout(r, 50));
  await t2.key({ window: 101, combo: "ctrl+s" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls(b2, "focus").length, 2, "still working (just a focus and the key's own), so not yet restored");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls(b2, "focus").at(-1)[1], 102);
  // stopping cancels it
  const b3 = new FakeBridge({ windows: wins, idle: [9000], previous: 102 });
  const { t: t3 } = make({ bridge: b3, extra: { restoreAfterMs: 30 } });
  await t3.focus({ window: 101 });
  t3.stop();
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(calls(b3, "focus").length, 1);
});

// ------------------------------------------------------------------------------------------------ finding the text
test("findText: exact words get their own box, a phrase spans words, and the click lands ON the words of a long line", () => {
  const lines = [line("Ansuman Kumar 10:42 pm", 0, 100, 400, 20, [word("Ansuman", 0, 100, 80, 20), word("Kumar", 90, 100, 60, 20), word("10:42", 300, 100, 50, 20), word("pm", 360, 100, 40, 20)])];
  const one = findText(lines, "Ansuman");
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].rect, { x: 0, y: 100, width: 80, height: 20 });
  const two = findText(lines, "ansuman kumar");
  assert.deepEqual(two[0].rect, { x: 0, y: 100, width: 150, height: 20 }, "the box covers both words");
  assert.equal(findText(lines, "pm")[0].rect.x, 360, "the time at the far end of the line is found at ITS place, not the middle of the line");
  assert.deepEqual(findText(lines, "  "), [], "nothing asked for, nothing found");
  assert.deepEqual(findText(lines, "Sunil"), []);
});

test("findText: a letter misread by OCR is forgiven in longer words only; exact matches rank before near ones, then top to bottom", () => {
  const lines = [
    line("Ansumon", 0, 300, 90, 20, [word("Ansumon", 0, 300, 90, 20)]), // OCR read "a" as "o": one wrong letter in seven
    line("Ansuman", 0, 200, 80, 20, [word("Ansuman", 0, 200, 80, 20)]),
    line("Ansuman", 0, 100, 80, 20, [word("Ansuman", 0, 100, 80, 20)]),
  ];
  const r = findText(lines, "Ansuman");
  assert.deepEqual(r.map((x) => x.rect.y), [100, 200, 300], "exact ones first (top to bottom), the near-match last");
  assert.deepEqual(r.map((x) => x.score), [0, 0, 1]);
  assert.deepEqual(findText([line("Sav", 0, 0, 30, 10, [word("Sav", 0, 0, 30, 10)])], "Save"), [], "a short word must be exact");
  assert.deepEqual(findText([line("Ansurnan", 0, 0, 80, 10, [word("Ansurnan", 0, 0, 80, 10)])], "Ansuman"), [], "two wrong letters are not forgiven: it could be a different person");
  assert.equal(findText([line("Settings", 0, 0, 80, 10, [word("Settings", 0, 0, 80, 10)])], "Setting").length, 1, "a single word may be part of a longer one (a button 'Settings' for 'setting')");
});

test("findText: lines without word boxes are searched by characters, so the click still lands on the words; punctuation does not matter", () => {
  const lines = [line("Send message to Ansuman now", 0, 0, 270, 20)];
  const r = findText(lines, "ansuman");
  assert.equal(r.length, 1);
  const t = "send message to ansuman now";
  const expected = (t.indexOf("ansuman") + 3.5) / t.length;
  assert.ok(Math.abs(r[0].frac - expected) < 1e-9, `frac ${r[0].frac} vs ${expected}`);
  assert.equal(findText([line("Hello, World!!", 0, 0, 100, 10)], "hello world").length, 1);
  assert.equal(findText([null, {}, { text: "x" }], "x").length, 0, "damaged lines are skipped");
  assert.equal(findText([line("Ansurnan Kumar", 0, 0, 140, 10)], "Ansuman Kumar").length, 1, "a near match across a whole line is found (the click goes to the phrase's place)");
});

// ------------------------------------------------------------------------------------------------ clicking by words
test("click by words on an ordinary program uses the control with that name (the most exact way), and never takes a picture", async () => {
  const page = { nodes: [node("e2", "Button", "Save", { actions: ["invoke"] }), node("e3", "Button", "Save as...", { actions: ["invoke"] }), node("e4", "Button", "Cancel", { actions: ["invoke"] }), node("e5", "Button", "Print", { enabled: false })] };
  const { t, bridge } = make({ bridge: new FakeBridge({ interactive: page }) });
  const r = await t.click({ window: 101, text: "cancel" });
  assert.equal(r.ok, true);
  assert.deepEqual(calls(bridge, "click")[0][1], { element: "e4", double: false, right: false, mouse: false });
  assert.equal(calls(bridge, "screenshot").length, 0);
  assert.equal(bridge.interactiveArgs[0].budgetMs <= 3000, true, "reading the controls has a strict time limit");
  const dis = await t.click({ window: 101, text: "print" });
  assert.equal(dis.ok, false, "a disabled control is not clicked; the picture is tried and finds nothing");
  assert.equal(dis.code, "text_not_found");
});

test("two controls with the same words: the model must say which (nth), and is told what the choices are", async () => {
  const page = { nodes: [node("e2", "Button", "Save", { actions: ["invoke"] }), node("e3", "Button", "Save as...", { actions: ["invoke"] })] };
  const { t, bridge } = make({ bridge: new FakeBridge({ interactive: page }) });
  const r = await t.click({ window: 101, text: "save" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "ambiguous");
  assert.match(r.message, /names 2 controls/);
  assert.match(r.message, /1: Button "Save"; 2: Button "Save as\.\.\."/);
  assert.equal(calls(bridge, "click").length, 0, "nothing was clicked while it was unclear");
  const second = await t.click({ window: 101, text: "save", nth: 2 });
  assert.equal(second.ok, true);
  assert.equal(calls(bridge, "click")[0][1].element, "e3");
  const beyond = await t.click({ window: 101, text: "save", nth: 9 });
  assert.equal(beyond.ok, true);
  assert.equal(calls(bridge, "click")[1][1].element, "e3", "an nth beyond the end means the last one, not an error and not a wrong control");
});

test("a web page is never read control by control: its words are read from a picture of the window, and the click lands on those words, to the pixel", async () => {
  const lines = [line("Chats", 10, 20, 60, 20, [word("Chats", 10, 20, 60, 20)]), line("Ansuman", 20, 120, 120, 30, [word("Ansuman", 20, 120, 120, 30)]), line("Sunil BSNL", 20, 220, 150, 30, [word("Sunil", 20, 220, 60, 30), word("BSNL", 90, 220, 80, 30)])];
  const bridge = new FakeBridge({ windows: [EDGE_WA, NOTEPAD], idle: [9000], hits: { any: { name: "WhatsApp", type: "Document" } } });
  const { t, asked } = make({ bridge, ocr: async () => lines });
  const r = await t.click({ window: 201, text: "Ansuman" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(calls(bridge, "interactive").length, 0, "no slow reading of the page's controls");
  // the middle of the word's box in the picture: (20 + 120/2, 120 + 30/2) = (80, 135); the picture is half size, taken at (100, 200)
  assert.deepEqual(calls(bridge, "click")[0][1], { window: 201, x: 100 + Math.round(80 / 0.5), y: 200 + Math.round(135 / 0.5), double: false, right: false });
  assert.equal(r.via, "text");
  assert.equal(r.name, "Ansuman", "the result names what was pressed");
  assert.deepEqual(r.at, { x: 260, y: 470 });
  assert.equal(asked.length, 0, "a click on a NAMED thing in a chat is an ordinary click: no card (a spot with no name would ask)");
  const second = await t.click({ window: 201, text: "BSNL" });
  assert.equal(second.at.x, 100 + Math.round((90 + 80 * 0.5) / 0.5), "a word at the end of the line is clicked at its own place");
});

test("when OCR gives a line with no word boxes, the click lands where the words are ALONG the line, not in the middle of it", async () => {
  const text = "Send message to Ansuman now";
  const bridge = new FakeBridge({ windows: [EDGE_NEWS], idle: [9000], hits: { any: { name: "News", type: "Document" } } });
  const { t } = make({ bridge, ocr: async () => [line(text, 20, 120, 270, 20)] });
  const r = await t.click({ window: 202, text: "ansuman", nth: 1 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const frac = (text.toLowerCase().indexOf("ansuman") + 3.5) / text.length; // the middle of the word within the line
  const expectedX = 100 + Math.round((20 + 270 * frac) / 0.5);
  assert.equal(calls(bridge, "click")[0][1].x, expectedX);
  assert.ok(expectedX > 100 + Math.round((20 + 135) / 0.5), "which is well to the right of the middle of the line");
});

test("words that are not on the window, or are on it twice, are reported with what to do (never a guess)", async () => {
  const lines = [line("Notes", 10, 20, 60, 20, [word("Notes", 10, 20, 60, 20)]), line("Notes", 10, 220, 60, 20, [word("Notes", 10, 220, 60, 20)])];
  const bridge = new FakeBridge({ windows: [EDGE_NEWS], idle: [9000] });
  const { t } = make({ bridge, ocr: async () => lines });
  const none = await t.click({ window: 202, text: "Inbox" });
  assert.deepEqual([none.ok, none.code], [false, "text_not_found"]);
  assert.match(none.message, /Take a desktop_screenshot/);
  const two = await t.click({ window: 202, text: "Notes" });
  assert.deepEqual([two.ok, two.code], [false, "ambiguous"]);
  assert.match(two.message, /appears 2 times: 1: "Notes" \(at 10,20\); 2: "Notes" \(at 10,220\)/);
  assert.equal(calls(bridge, "click").length, 0);
  const pick = await t.click({ window: 202, text: "Notes", nth: 2 });
  assert.equal(pick.ok, true);
  assert.equal(calls(bridge, "click")[0][1].y, 200 + Math.round(230 / 0.5), "nth 2 is the lower one");
});

test("the picture used to find words is taken larger than the one the model sees, and OCR trouble is an honest 'not found'", async () => {
  const bridge = new FakeBridge({ windows: [EDGE_NEWS], idle: [9000] });
  const { t } = make({ bridge, ocr: async () => { throw new Error("ocr down"); } });
  const r = await t.click({ window: 202, text: "Inbox" });
  assert.equal(r.ok, false);
  assert.ok(["text_not_found", "tool_error"].includes(r.code), r.code);
  assert.equal(bridge.shotArgs[0].maxWidth, 2000, "bigger than the 1280 sent to the model: small text is read better");
});

test("a click by words in a window Noah may not look at is refused before any picture is taken", async () => {
  const VAULT = win(301, "My vault - Bitwarden", "Bitwarden");
  const bridge = new FakeBridge({ windows: [VAULT], idle: [9000] });
  const { t } = make({ bridge });
  const r = await t.click({ window: 301, text: "Copy password" });
  assert.equal(r.ok, false);
  assert.equal(calls(bridge, "screenshot").length, 0);
  assert.equal(calls(bridge, "click").length, 0);
});

test("an Ansuman-style task: a contact is clicked by name in a native chat window that lists its rows, and in a web chat by the picture", async () => {
  const native = win(401, "Messenger", "messenger");
  const rows = { nodes: [node("e2", "ListItem", "Ansuman Kumar", { actions: ["select"] }), node("e3", "ListItem", "Sunil BSNL", { actions: ["select"] })] };
  const b1 = new FakeBridge({ windows: [native], idle: [9000], interactive: rows });
  const { t: t1, asked } = make({ bridge: b1 });
  const r1 = await t1.click({ window: 401, text: "Ansuman" });
  assert.equal(r1.ok, true);
  assert.equal(calls(b1, "click")[0][1].element, "e2", "the control named Ansuman, not the one below it");
  assert.equal(asked.length, 0);
});

// ------------------------------------------------------------------------------------------------ clicking a spot
test("a click at x,y in the model's picture maps to the right screen point, and needs a picture of that window first", async () => {
  const bridge = new FakeBridge({ windows: [NOTEPAD], idle: [9000], hits: { any: { name: "Save", type: "Button" } } });
  const { t } = make({ bridge });
  const none = await t.click({ window: 101, x: 10, y: 10 });
  assert.deepEqual([none.ok, none.code], [false, "no_screenshot"]);
  const half = await t.click({ window: 101, x: 1 });
  assert.deepEqual([half.ok, half.code], [false, "invalid_arguments"]);
  await t.screenshot({ window: 101 });
  const r = await t.click({ window: 101, x: 300, y: 200 });
  assert.equal(r.ok, true);
  assert.deepEqual(calls(bridge, "click")[0][1], { window: 101, x: 100 + 600, y: 200 + 400, double: false, right: false }, "x / scale + the window's left edge");
  assert.deepEqual(r.at, { x: 700, y: 600 });
  assert.deepEqual(r.hit, { name: "Save", type: "Button" }, "the result says what was really there");
  assert.equal(r.name, "Save");
});

test("a spot that is a password field is refused, and nothing is pressed", async () => {
  const bridge = new FakeBridge({ windows: [NOTEPAD], idle: [9000], hits: { any: { name: "Password", type: "Edit", password: true } } });
  const { t } = make({ bridge });
  await t.screenshot({ window: 101 });
  const r = await t.click({ window: 101, x: 20, y: 20 });
  assert.deepEqual([r.ok, r.code], [false, "password_field"]);
  assert.match(r.message, /ask the user to do it themselves/);
  assert.equal(calls(bridge, "click").length, 0);
});

test("a spot in a messaging window with no real control name asks first; one that is a named control does not", async () => {
  // Windows answers over a web page with the whole page (a Document named after the page): that says nothing about what is pressed
  const bridge = new FakeBridge({ windows: [EDGE_WA], idle: [9000], hits: { any: { name: "WhatsApp", type: "Document" } } });
  const { t, asked } = make({ bridge, answer: false });
  await t.screenshot({ window: 201 });
  const r = await t.click({ window: 201, x: 400, y: 300 });
  assert.deepEqual([r.ok, r.code], [false, "user_denied"]);
  assert.equal(asked.length, 1, "the user was asked");
  assert.equal(asked[0].risk.level, "high");
  assert.match(asked[0].summary, /Click a spot in WhatsApp - Microsoft Edge/, "the card says it is a spot, not a button");
  assert.equal(calls(bridge, "click").length, 0, "declined: nothing was clicked");
  assert.equal(asked[0].timeoutMs, 15 * 60_000, "the card may wait a long time: the task runs in the background and the user may not look at once");

  const named = new FakeBridge({ windows: [EDGE_WA], idle: [9000], hits: { any: { name: "Ansuman Kumar", type: "ListItem" } } });
  const { t: t2, asked: asked2 } = make({ bridge: named, answer: false });
  await t2.screenshot({ window: 201 });
  const r2 = await t2.click({ window: 201, x: 400, y: 300 });
  assert.equal(r2.ok, true, "a click on a named chat row is an ordinary click");
  assert.equal(asked2.length, 0);
  assert.deepEqual(r2.hit, { name: "Ansuman Kumar", type: "ListItem" });

  const send = new FakeBridge({ windows: [EDGE_WA], idle: [9000], hits: { any: { name: "Send", type: "Button" } } });
  const { t: t3, asked: asked3 } = make({ bridge: send, answer: false });
  await t3.screenshot({ window: 201 });
  const r3 = await t3.click({ window: 201, x: 400, y: 300 });
  assert.equal(asked3.length, 1, "pressing a control called Send asks, whatever the window");
  assert.equal(r3.code, "user_denied");
  assert.equal(asked3[0].risk.level, "high");
  assert.equal(calls(send, "click").length, 0);
});

test("the card timeout is configurable, and a card the user answers 'no' is never retried another way", async () => {
  const bridge = new FakeBridge({ windows: [EDGE_WA], idle: [9000], hits: { any: { name: "WhatsApp", type: "Document" } } });
  const { t, asked } = make({ bridge, answer: false, extra: { confirmWaitMs: 123_000 } });
  await t.screenshot({ window: 201 });
  const r = await t.click({ window: 201, x: 400, y: 300 });
  assert.equal(asked[0].timeoutMs, 123_000);
  assert.match(r.message, /Do not do it another way/);
});

test("a hit test that fails does not stop a click: it is judged as a spot with no name", async () => {
  const bridge = new FakeBridge({ windows: [NOTEPAD], idle: [9000] });
  bridge.elementAt = async () => { throw new Error("no answer"); };
  const { t } = make({ bridge });
  await t.screenshot({ window: 101 });
  const r = await t.click({ window: 101, x: 20, y: 20 });
  assert.equal(r.ok, true);
  assert.equal(r.hit, null);
  const b2 = new FakeBridge({ windows: [NOTEPAD], idle: [9000] });
  b2.elementAt = async () => { throw new DesktopError("stopped", "aborted"); };
  const { t: t2 } = make({ bridge: b2 });
  await t2.screenshot({ window: 101 });
  assert.equal((await t2.click({ window: 101, x: 20, y: 20 })).code, "aborted", "but a Stop is a Stop");
});

// ------------------------------------------------------------------------------------------------ when a click goes wrong, the model is told why and what to do
test("refusals from the helper come back with a hint that says what to do next", async () => {
  const cases = [
    ["user_busy", /Wait a moment and try again/],
    ["covered", /Take a new screenshot to see what/],
    ["outside_window", /not inside the window/],
    ["not_foreground", /desktop_focus/],
    ["stale", /desktop_read/],
  ];
  for (const [code, hint] of cases) {
    const bridge = new FakeBridge({ windows: [NOTEPAD], idle: [9000] });
    bridge.failWith = { op: "click", code, message: `helper says ${code}` };
    const { t } = make({ bridge });
    await t.screenshot({ window: 101 });
    const r = await t.click({ window: 101, x: 20, y: 20 });
    assert.deepEqual([r.ok, r.code], [false, code]);
    assert.match(r.message, new RegExp(`helper says ${code}`));
    assert.match(r.message, hint, code);
  }
});

test("typing that is cut short by the user says how far it got; a Stop mid-click is reported as a Stop", async () => {
  const bridge = new FakeBridge({ windows: [NOTEPAD], idle: [9000] });
  bridge.type = async () => { throw new DesktopError("The user used the keyboard, so Noah stopped typing (12 of 40 characters had already been typed).", "user_busy"); };
  const { t } = make({ bridge });
  const r = await t.type({ window: 101, text: "x".repeat(40) });
  assert.equal(r.code, "user_busy");
  assert.match(r.message, /12 of 40 characters had already been typed/, "the model knows part of the text is already there");
});

// ------------------------------------------------------------------------------------------------ reading web pages
test("a web window is read through the time-limited list of controls, with a hint on how to act on it", async () => {
  const many = { nodes: Array.from({ length: 8 }, (_, i) => node(`e${i + 2}`, "ListItem", `Chat ${i}`, { actions: ["select"] })), truncated: false };
  const bridge = new FakeBridge({ windows: [EDGE_WA], interactive: many });
  const { t } = make({ bridge });
  const r = await t.read({ window: 201 });
  assert.equal(r.ok, true);
  assert.equal(calls(bridge, "tree").length, 0, "a web window is not walked as a tree");
  assert.equal(r.controls, 8);
  assert.match(r.text, /Chat 3/);
  assert.match(r.text, /desktop_click with text/);
  assert.equal(bridge.interactiveArgs[0].budgetMs, 4000);
  assert.equal(t._el("e2").name, "Chat 0", "the ids can be used afterwards");

  const few = new FakeBridge({ windows: [EDGE_WA], interactive: { nodes: [node("e2", "Button", "Menu")] } });
  const { t: t2 } = make({ bridge: few });
  const r2 = await t2.read({ window: 201 });
  assert.match(r2.text, /Windows exposes almost nothing of it/);
  assert.match(r2.text, /desktop_screenshot/);

  const broken = new FakeBridge({ windows: [EDGE_WA] });
  broken.failWith = { op: "interactive", code: "timeout", message: "too slow" };
  const { t: t3 } = make({ bridge: broken });
  const r3 = await t3.read({ window: 201 });
  assert.equal(r3.ok, true, "a page Windows will not describe is not an error");
  assert.equal(r3.controls, 0);
  assert.match(r3.text, /no controls could be read/);
  assert.match(r3.text, /desktop_screenshot/);

  const stopped = new FakeBridge({ windows: [EDGE_WA] });
  stopped.failWith = { op: "interactive", code: "aborted", message: "stopped" };
  const { t: t4 } = make({ bridge: stopped });
  assert.equal((await t4.read({ window: 201 })).code, "aborted", "but a Stop is a Stop");
});

test("a native window is walked as a tree", async () => {
  const bridge = new FakeBridge({ windows: [NOTEPAD] });
  const { t } = make({ bridge });
  const r = await t.read({ window: 101 });
  assert.equal(r.ok, true);
  assert.equal(calls(bridge, "tree").length, 1);
  assert.equal(calls(bridge, "interactive").length, 0);
});

test("a screenshot of a web page carries a grid so a spot can be named exactly; a native window only if asked", async () => {
  const bridge = new FakeBridge({ windows: [EDGE_WA, NOTEPAD] });
  const { t } = make({ bridge });
  const web = await t.screenshot({ window: 201 });
  assert.equal(bridge.shotArgs[0].grid, true);
  assert.match(web.note, /faint grid, with coordinates every 100 pixels/);
  const native = await t.screenshot({ window: 101 });
  assert.equal(bridge.shotArgs[1].grid, false);
  assert.doesNotMatch(native.note, /grid/);
  await t.screenshot({ window: 101, grid: true });
  assert.equal(bridge.shotArgs[2].grid, true);
  assert.equal(t.takeImages().length, 1, "only the newest picture is kept, and handed over once");
  assert.equal(t.takeImages().length, 0);
});

test("which windows count as web pages", () => {
  assert.equal(isWeb({ class: "Chrome_WidgetWin_1" }), true);
  assert.equal(isWeb({ class: "Chrome_WidgetWin_0" }), true);
  assert.equal(isWeb({ class: "Notepad" }), false);
  assert.equal(isWeb({}), false);
  assert.equal(isWeb(null), false);
});

test("a change made by a click or by typing is reported to the mission, so earlier checks go stale; reading does not", async () => {
  let changes = 0;
  const bridge = new FakeBridge({ windows: [NOTEPAD], idle: [9000], hits: { any: { name: "Save", type: "Button" } } });
  const { t } = make({ bridge, extra: { state: { recordExternalChange: () => { changes++; } } } });
  await t.read({ window: 101 });
  await t.screenshot({ window: 101 });
  assert.equal(changes, 0);
  await t.click({ window: 101, x: 10, y: 10 });
  await t.type({ window: 101, text: "a" });
  assert.equal(changes, 2);
});

// ------------------------------------------------------------------------------------------------ take-over mode (the default): Noah is given the mouse and keyboard
test("by default Noah takes over right away: it never waits for the user, says it is working, and asks the helper to point again if a hand nudges the mouse", async () => {
  const bridge = new FakeBridge({ windows: [NOTEPAD, OTHER], idle: [0], hits: { any: { name: "Save", type: "Button" } } });
  const { t, notes, pauses } = make({ bridge, extra: { takeOver: true } });
  await t.screenshot({ window: 101 });
  const r = await t.click({ window: 101, x: 40, y: 30 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(pauses.length, 0, "no waiting, although the user used the computer a moment ago");
  assert.equal(calls(bridge, "userIdle").length, 0, "and it did not even ask");
  assert.deepEqual(notes.map((n) => n.state), ["active"], "the Stop bar is told Noah has taken over");
  assert.equal(calls(bridge, "click")[0][1].force, true);
  await t.type({ window: 101, text: "hi" });
  assert.equal(calls(bridge, "type")[0].length >= 3, true);
  const typed = bridge.typeArgs;
  assert.deepEqual(typed, { element: undefined, force: true });
  await t.key({ window: 101, combo: "ctrl+s" });
  assert.deepEqual(bridge.keyArgs, { force: true });
  await t.scroll({ window: 101, clicks: -2 });
  assert.equal(bridge.scrollArgs.force, true);
});

test("in the quiet mode nothing is forced: the helper is told to stop if the user moves in", async () => {
  const bridge = new FakeBridge({ windows: [NOTEPAD, OTHER], idle: [9000], hits: { any: { name: "Save", type: "Button" } } });
  const { t } = make({ bridge });
  await t.screenshot({ window: 101 });
  await t.click({ window: 101, x: 40, y: 30 });
  assert.equal("force" in calls(bridge, "click")[0][1], false);
  await t.type({ window: 101, text: "hi" });
  assert.deepEqual(bridge.typeArgs, { element: undefined });
  assert.equal(bridge.keyArgs, undefined);
});

test("in take-over mode the user's window is put back once, when the task ends, not on a timer while Noah is thinking", async () => {
  const wins = [win(101, "Untitled - Notepad", "notepad", { foreground: true }), OTHER];
  const bridge = new FakeBridge({ windows: wins, idle: [9000], previous: 102 });
  const { t } = make({ bridge, extra: { takeOver: true, restoreAfterMs: 20 } });
  await t.focus({ window: 101 });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(calls(bridge, "focus").length, 1, "no flicker back to the user's window between Noah's steps");
  await t.finish();
  assert.deepEqual(calls(bridge, "focus").map((c) => c[1]), [101, 102], "but at the end it comes back");
});

// ------------------------------------------------------------------------------------------------ what a failed search tells the model (the loop the user saw)
test("when words are not found the model is shown what IS readable, and close matches, so it can change course instead of guessing spots", async () => {
  const lines = [line("WhatsApp Business", 10, 20, 150, 20, [word("WhatsApp", 10, 20, 70, 20), word("Business", 90, 20, 70, 20)]), line("Ansuman Kumar", 20, 120, 130, 20, [word("Ansuman", 20, 120, 70, 20), word("Kumar", 100, 120, 50, 20)]), line("Get started", 10, 300, 90, 20, [word("Get", 10, 300, 30, 20), word("started", 50, 300, 50, 20)])];
  const bridge = new FakeBridge({ windows: [EDGE_WA], idle: [0] });
  const { t } = make({ bridge, ocr: async () => lines, extra: { takeOver: true } });
  const r = await t.click({ window: 201, text: "Ansuman Bhattacharjee" });
  assert.deepEqual([r.ok, r.code], [false, "text_not_found"]);
  assert.match(r.message, /Close matches \(not clicked, it could be someone else\): "Ansuman Kumar" \(at 20,120\)/);
  assert.match(r.message, /What I can read there: WhatsApp Business \| Ansuman Kumar \| Get started\./);
  assert.match(r.message, /scroll, use the page's search box, or switch to the right tab/);
  assert.equal(calls(bridge, "click").length, 0, "a close match is never clicked on the model's behalf");
  const blank = make({ bridge: new FakeBridge({ windows: [EDGE_WA], idle: [0] }), ocr: async () => [] });
  const r2 = await blank.t.click({ window: 201, text: "Anything" });
  assert.match(r2.message, /I can read almost no text there/);
});

test("readableText lists the text top to bottom, cut to a size; closeMatches offers lines with a long word of the request", () => {
  const lines = [line("Zed", 0, 300, 30, 10), line("Alpha beta", 0, 100, 80, 10), line("x", 0, 50, 5, 10), line("Gamma", 0, 200, 50, 10)];
  assert.equal(readableText(lines), "Alpha beta | Gamma | Zed", "top to bottom; one-letter noise is left out");
  const many = Array.from({ length: 200 }, (_, i) => line("word number " + i, 0, i * 10, 90, 10));
  assert.ok(readableText(many).length <= 700);
  assert.equal(readableText([]), "");
  assert.equal(readableText(null), "");
  assert.equal(closeMatches([line("Ansuman Kumar", 5, 6, 90, 10)], "Ansuman Bhattacharjee"), '"Ansuman Kumar" (at 5,6)');
  assert.equal(closeMatches([line("Sunil", 0, 0, 40, 10)], "Ansuman Bhattacharjee"), "");
  assert.equal(closeMatches([line("Ann", 0, 0, 30, 10)], "Ann Lee"), "", "words under four letters are too short to be a clue");
});

test("a window is found by a title that was cut short for display, and a title that changed is explained with the window number to use", async () => {
  const bridge = new FakeBridge({ windows: [EDGE_WA, NOTEPAD], idle: [9000] });
  const { t } = make({ bridge });
  const cut = String.fromCharCode(0x2026);
  const shot = await t.screenshot({ title: "WhatsApp - Microsoft Edge" });
  assert.equal(shot.ok, true);
  assert.match(shot.note, /Use window 201 for what comes next/);
  for (const title of ["WhatsApp - Microsoft E" + cut, "WhatsApp - Microsoft E...", "whatsapp - microsoft e" + cut + "  "]) assert.equal((await t.screenshot({ title })).window, 201, title);
  const gone = await t.screenshot({ title: "Telegram" + cut });
  assert.equal(gone.code, "no_window");
});

test("after three clicks in a row that did not work the model is told to stop repeating and look again; a success or a refusal by the user resets nothing wrongly", async () => {
  const bridge = new FakeBridge({ windows: [EDGE_NEWS], idle: [9000] });
  const { t } = make({ bridge, ocr: async () => [] });
  const msgs = [];
  for (let i = 0; i < 4; i++) msgs.push((await t.click({ window: 202, text: "Nothing here" })).message);
  assert.doesNotMatch(msgs[0], /in a row/);
  assert.doesNotMatch(msgs[1], /in a row/);
  assert.match(msgs[2], /That is 3 clicks in a row that have not worked: stop repeating it/);
  assert.match(msgs[3], /That is 4 clicks in a row/);
  const ok = new FakeBridge({ windows: [EDGE_NEWS], idle: [9000] });
  const w2 = make({ bridge: ok, ocr: async () => [line("Inbox", 10, 10, 50, 10, [word("Inbox", 10, 10, 50, 10)])] });
  await w2.t.click({ window: 202, text: "x1" });
  await w2.t.click({ window: 202, text: "x2" });
  assert.equal((await w2.t.click({ window: 202, text: "Inbox" })).ok, true);
  const after = await w2.t.click({ window: 202, text: "x3" });
  assert.doesNotMatch(after.message, /in a row/, "a click that worked starts the count again");
});

test("a user's refusal is not a failed click: it never triggers the 'stop repeating' message, and a failing click by text is counted once, not twice", async () => {
  const send = new FakeBridge({ windows: [EDGE_WA], idle: [9000], hits: { any: { name: "Send", type: "Button" } } });
  const { t } = make({ bridge: send, answer: false });
  await t.screenshot({ window: 201 });
  for (let i = 0; i < 4; i++) { const r = await t.click({ window: 201, x: 400, y: 300 }); assert.equal(r.code, "user_denied"); assert.doesNotMatch(r.message, /in a row/, "declined by the user, " + i); }
  const page = { nodes: [node("e2", "Button", "Cancel", { actions: ["invoke"] })] };
  const bridge = new FakeBridge({ windows: [NOTEPAD], idle: [9000], interactive: page });
  bridge.failWith = { op: "click", code: "stale", message: "gone" };
  const w = make({ bridge });
  const msgs = [];
  for (let i = 0; i < 3; i++) msgs.push((await w.t.click({ window: 101, text: "cancel" })).message);
  assert.doesNotMatch(msgs[0], /in a row/);
  assert.doesNotMatch(msgs[1], /in a row/, "two failed clicks are two, not four");
  assert.match(msgs[2], /That is 3 clicks in a row/);
});
