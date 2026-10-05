// Noah/test/unit/desktop-guard.test.cjs - the user's brake while Noah works on the computer, without getting in the way (Noah/desktop/guard.cjs).
//   * the global Ctrl+Alt+X shortcut is armed for the whole computer task
//   * a small bar shows ONLY while Noah takes over the mouse or keyboard (or waits for the user to stop using them); the mouse goes through it except over its Stop button
//     (the main process watches the pointer, because a click-through window hears nothing of the pointer arriving)
//   * nothing comes to the front by itself: a finished task or a card waiting for the user's OK is a notification (clicking it opens Jonah) and a taskbar flash
// Electron is replaced by stand-ins here, so every branch can be hit. The real thing is checked in real Electron by Noah/bench/integration/desktop-guard-check.cjs.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");
const { createDesktopGuard, attachDesktopGuard, SHORTCUT, PILL_HTML, pillHtml, keyName } = require("../../desktop/guard.cjs");
const { decideDesktop } = require("../../desktop/policy.cjs");
const { EventBus } = require("../../events.cjs");

function standIns({ registers = true, registerThrows = false, loadFails = false, platform = "win32" } = {}) {
  const made = [];
  class FakeWindow {
    constructor(options) {
      this.options = options; this.order = []; this.destroyed = false; this.shown = []; this.sent = []; this.closed = 0; this.alwaysOnTop = null; this.loaded = null; this.ignore = null; this.workspaces = null;
      this.webContents = { send: (channel, text) => this.sent.push([channel, text]), executeJavaScript: async () => ({ x: 280, y: 4, w: 70, h: 28 }) };
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      made.push(this);
    }
    setAlwaysOnTop(on, level) { this.alwaysOnTop = [on, level]; }
    setIgnoreMouseEvents(ignore, o) { this.ignore = [ignore, o]; this.order.push("ignore"); }
    setOpacity(o) { this.opacity = o; this.order.push("opacity"); }
    setVisibleOnAllWorkspaces(on, o) { this.workspaces = [on, o]; }
    loadURL(url) { this.loaded = url; return loadFails ? Promise.reject(new Error("no page")) : Promise.resolve(); }
    showInactive() { this.shown.push("inactive"); this.order.push("show"); }
    show() { this.shown.push("normal"); }
    isDestroyed() { return this.destroyed; }
    getBounds() { return this.bounds; }
    close() { this.closed++; this.destroyed = true; }
  }
  const shortcuts = new Map();
  const globalShortcut = {
    register: (accel, cb) => { if (registerThrows) throw new Error("denied"); if (!registers) return false; shortcuts.set(accel, cb); return true; },
    unregister: (accel) => shortcuts.delete(accel),
  };
  const handlers = new Map();
  const ipcMain = {
    on: (ch, fn) => handlers.set(ch, fn),
    removeListener: (ch, fn) => { if (handlers.get(ch) === fn) handlers.delete(ch); },
  };
  const pointer = { x: 10, y: 10 };
  const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), getCursorScreenPoint: () => ({ x: pointer.x, y: pointer.y }) };
  const stops = [];
  const logs = [];
  const timers = new Map();
  let nextTimer = 1;
  const every = (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; };
  const stopEvery = (id) => timers.delete(id);
  const tick = () => { for (const t of [...timers.values()]) t.fn(); };
  const guard = createDesktopGuard({ electron: { BrowserWindow: FakeWindow, screen, globalShortcut }, ipcMain, onStop: () => stops.push(1), log: (m) => logs.push(m), platform, every, stopEvery });
  return { guard, made, shortcuts, handlers, stops, logs, pointer, timers, tick };
}
const settle = () => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------------------------------------------ the bar and the shortcut
test("nothing is on screen and no shortcut is held until a computer task starts", () => {
  const s = standIns();
  assert.deepEqual([s.guard.isShowing(), s.guard.isArmed(), s.guard.shortcutActive(), s.made.length, s.shortcuts.size], [false, false, false, 0, 0]);
});

test("arming holds the shortcut for the whole task and shows NOTHING", async () => {
  const s = standIns();
  s.guard.arm();
  await settle();
  assert.deepEqual([s.guard.isArmed(), s.guard.shortcutActive(), s.guard.isShowing(), s.made.length], [true, true, false, 0]);
  assert.ok(s.shortcuts.has(SHORTCUT));
  s.guard.arm();
  assert.equal(s.shortcuts.size, 1, "arming twice is harmless");
  s.shortcuts.get(SHORTCUT)();
  assert.equal(s.stops.length, 1, "the shortcut stops the task");
});

test("the bar is small, bottom right above the taskbar, never takes the keyboard focus, lets the mouse through, and has a locked-down page", async () => {
  const s = standIns();
  s.guard.show("Waiting for you to stop using the computer");
  await settle();
  assert.equal(s.made.length, 1);
  const w = s.made[0];
  assert.equal(w.options.focusable, false, "if it could take focus it would break what Noah is typing");
  assert.equal(w.options.alwaysOnTop, true);
  assert.deepEqual(w.alwaysOnTop, [true, "screen-saver"], "above full-screen apps too");
  assert.deepEqual(w.ignore, [true, undefined], "the mouse goes THROUGH the bar (so it never sits between Noah or the user and what is underneath)");
  assert.equal(w.options.frame, false);
  assert.equal(w.options.skipTaskbar, true);
  assert.notEqual(w.options.transparent, true, "a transparent always-on-top bar hung Electron's main process on a real machine (see guard.cjs)");
  assert.match(w.options.backgroundColor, /^#[0-9a-f]{6}$/i, "so it has a solid colour of its own");
  assert.equal(w.options.show, false, "created hidden, shown only after the page has loaded");
  assert.deepEqual(w.shown, ["inactive"], "shown without activating (stealing focus)");
  assert.deepEqual([w.options.webPreferences.contextIsolation, w.options.webPreferences.sandbox, w.options.webPreferences.nodeIntegration], [true, true, false]);
  assert.equal(path.basename(w.options.webPreferences.preload), "pill-preload.cjs");
  assert.ok(w.options.width <= 400 && w.options.height <= 40, "small");
  assert.equal(w.options.x, 1920 - w.options.width - 16, "right edge");
  assert.equal(w.options.y, 1040 - w.options.height - 12, "just above the taskbar");
  assert.match(decodeURIComponent(w.loaded), /^data:text\/html/);
  assert.deepEqual(w.sent.at(-1), ["noah:pill-text", "Waiting for you to stop using the computer"]);
  assert.equal(s.guard.isArmed(), true, "showing the bar also arms the shortcut");
  assert.equal(w.workspaces, null, "(only a Mac needs the bar on every space)");
});

test("click-through is switched on only AFTER the bar has been shown (a window made click-through before its first paint showed no content at all), and the bar is not invisibly thin", async () => {
  const s = standIns();
  s.guard.show("x");
  await settle();
  const w = s.made[0];
  assert.deepEqual(w.order.slice(0, 3), ["show", "opacity", "ignore"], "shown first, then made click-through");
  assert.equal(w.opacity, 0.99);
  assert.deepEqual(w.ignore, [true, undefined]);
  assert.equal(w.order.filter((x) => x === "ignore").length, 1, "and not at creation as well");
});

test("on a Mac the bar also appears over full-screen apps and tells the user Control+Option+X", async () => {
  const s = standIns({ platform: "darwin" });
  s.guard.show();
  await settle();
  assert.deepEqual(s.made[0].workspaces, [true, { visibleOnFullScreen: true }]);
  assert.match(decodeURIComponent(s.made[0].loaded), /Control\+Option\+X/);
  assert.match(pillHtml("darwin"), /Control\+Option\+X/);
  assert.match(pillHtml("win32"), /Ctrl\+Alt\+X/);
  assert.equal(keyName("darwin"), "Control+Option+X");
  assert.equal(keyName("win32"), "Ctrl+Alt+X");
});

test("the page is self-contained: no remote files, and its words are text and never markup", () => {
  assert.doesNotMatch(PILL_HTML, /https?:|src\s*=|@import|url\(/i, "nothing is fetched from anywhere");
  assert.match(PILL_HTML, /noahPill\.stop\(\)/);
  assert.match(PILL_HTML, /textContent/);
  assert.doesNotMatch(PILL_HTML, /innerHTML/);
});

test("who may press Stop: the shortcut, and the bar's own button; no other window can stop (or fake-stop) the task through those messages", async () => {
  const s = standIns();
  s.guard.show();
  await settle();
  s.handlers.get("noah:pill-stop")({ sender: s.made[0].webContents });
  assert.equal(s.stops.length, 1);
  s.handlers.get("noah:pill-stop")({ sender: { some: "other window" } });
  assert.equal(s.stops.length, 1, "another window's message is ignored");
  s.shortcuts.get(SHORTCUT)();
  assert.equal(s.stops.length, 2);
});

test("the bar takes the mouse only while the pointer is over the Stop button, and lets it through again when it leaves", async () => {
  const s = standIns();
  s.guard.show();
  await settle();
  const w = s.made[0];
  assert.equal(s.timers.size, 1, "the pointer is being watched while the bar shows");
  const button = { x: w.bounds.x + 280 + 35, y: w.bounds.y + 4 + 14 };
  s.tick();
  assert.deepEqual(w.ignore, [true, undefined], "pointer elsewhere: click-through");
  Object.assign(s.pointer, button);
  s.tick();
  assert.deepEqual(w.ignore, [false, undefined], "over the button: the mouse is taken, so the click lands on Stop");
  Object.assign(s.pointer, { x: w.bounds.x + 20, y: w.bounds.y + 14 });
  s.tick();
  assert.deepEqual(w.ignore, [true, undefined], "over the words (not the button): the mouse goes through to whatever is underneath");
  Object.assign(s.pointer, { x: w.bounds.x + 280 - 3, y: w.bounds.y + 4 + 14 });
  s.tick();
  assert.deepEqual(w.ignore, [false, undefined], "a few pixels of slack around the button, so a click that is slightly off still stops");
  Object.assign(s.pointer, { x: w.bounds.x + 280 - 12, y: w.bounds.y + 4 + 14 });
  s.tick();
  assert.deepEqual(w.ignore, [true, undefined], "but not more than that");
});

test("the slack around the button is a few pixels on every side, and no more", async () => {
  const s = standIns();
  s.guard.show();
  await settle();
  const w = s.made[0];
  const left = w.bounds.x + 280, right = left + 70, top = w.bounds.y + 4, bottom = top + 28, midX = left + 35, midY = top + 14;
  const at = (x, y) => { Object.assign(s.pointer, { x, y }); s.tick(); return w.ignore[0]; };
  assert.equal(at(right + 3, midY), false, "just right of the button: taken");
  assert.equal(at(right + 10, midY), true, "well right of it: through");
  assert.equal(at(midX, top - 3), false, "just above: taken");
  assert.equal(at(midX, top - 10), true, "well above: through");
  assert.equal(at(midX, bottom + 3), false, "just below: taken");
  assert.equal(at(midX, bottom + 10), true, "well below: through");
  assert.equal(at(left, top), false, "the button's own corner: taken");
  assert.equal(at(right, bottom), false, "the opposite corner: taken");
});

test("a bar destroyed from outside and replaced at once leaves ONE pointer watcher, watching the NEW bar", async () => {
  const s = standIns();
  s.guard.show();
  await settle();
  s.made[0].destroyed = true;
  s.guard.show();
  await settle();
  assert.equal(s.made.length, 2);
  assert.equal(s.timers.size, 1, "the old watcher is replaced, not added to");
  const w = s.made[1];
  Object.assign(s.pointer, { x: w.bounds.x + 280 + 35, y: w.bounds.y + 4 + 14 });
  s.tick();
  assert.deepEqual(w.ignore, [false, undefined]);
});

test("the pointer is no longer watched once the bar is gone (hidden, ended, disposed, replaced, or destroyed under it)", async () => {
  for (const how of ["hideBar", "hide", "dispose"]) {
    const s = standIns();
    s.guard.show();
    await settle();
    assert.equal(s.timers.size, 1, how);
    s.guard[how]();
    assert.equal(s.timers.size, 0, how + ": no timer is left running");
  }
  const s = standIns();
  s.guard.show();
  await settle();
  s.made[0].destroyed = true;
  s.tick();
  assert.equal(s.timers.size, 0, "a bar that was destroyed from outside stops being watched");
  s.guard.hideBar();
  s.guard.show();
  await settle();
  assert.equal(s.timers.size, 1, "the next bar is watched afresh, one timer only");
});

test("the bar's words are one line, cut to a sensible length; with no bar showing they are ignored; showing again reuses the bar", async () => {
  const s = standIns();
  s.guard.setText("nothing to show it on");
  assert.equal(s.made.length, 0);
  s.guard.show("one");
  await settle();
  s.guard.show("two");
  await settle();
  assert.equal(s.made.length, 1, "one bar");
  assert.deepEqual(s.made[0].sent.map((x) => x[1]), ["one", "two"]);
  s.guard.setText("line one\nline two\t\t  with   spaces " + "y".repeat(200));
  const sent = s.made[0].sent.at(-1)[1];
  assert.doesNotMatch(sent, /[\n\t]|\s{2}/);
  assert.equal(sent.length, 60);
  s.guard.setText(undefined);
  assert.equal(s.made[0].sent.at(-1)[1], "");
});

test("hiding the bar keeps the shortcut armed; ending the task releases everything; a later task starts clean", async () => {
  const s = standIns();
  s.guard.show();
  await settle();
  const w = s.made[0];
  s.guard.hideBar();
  assert.deepEqual([w.closed, s.guard.isShowing(), s.guard.isArmed(), s.guard.shortcutActive(), s.shortcuts.size], [1, false, true, true, 1]);
  s.guard.hideBar();
  assert.equal(w.closed, 1, "hiding twice is harmless");
  s.guard.show();
  await settle();
  assert.equal(s.made.length, 2, "a new bar when Noah takes over again");
  s.guard.hide();
  assert.deepEqual([s.made[1].closed, s.guard.isArmed(), s.guard.shortcutActive(), s.shortcuts.size], [1, false, false, 0]);
  s.handlers.get("noah:pill-stop")({ sender: s.made[1].webContents });
  assert.equal(s.stops.length, 0, "a closed bar can no longer stop anything");
  s.guard.hide();
  s.guard.show();
  await settle();
  assert.deepEqual([s.made.length, s.shortcuts.size], [3, 1], "the next task gets a fresh bar and shortcut");
});

test("if another program already holds Ctrl+Alt+X the bar still works, and the log says why", async () => {
  for (const opts of [{ registers: false }, { registerThrows: true }]) {
    const s = standIns(opts);
    s.guard.show();
    await settle();
    assert.equal(s.guard.shortcutActive(), false);
    assert.equal(s.guard.isShowing(), true, "the Stop button is still there");
    assert.ok(s.logs.some((l) => /Control\+Alt\+X/.test(l) && /could not be registered/.test(l)), JSON.stringify(s.logs));
    s.handlers.get("noah:pill-stop")({ sender: s.made[0].webContents });
    assert.equal(s.stops.length, 1);
  }
});

test("a page that fails to load is logged, not thrown, and the shortcut is still the user's way out", async () => {
  const s = standIns({ loadFails: true });
  s.guard.show();
  await settle();
  assert.ok(s.logs.some((l) => /stop bar failed to load/.test(l)));
  assert.equal(s.guard.shortcutActive(), true);
  s.shortcuts.get(SHORTCUT)();
  assert.equal(s.stops.length, 1);
});

test("disposing releases everything: the bar, the shortcut and both message handlers", async () => {
  const s = standIns();
  s.guard.show();
  await settle();
  s.guard.dispose();
  assert.deepEqual([s.guard.isShowing(), s.shortcuts.size, s.handlers.size], [false, 0, 0]);
});

test("the shortcut Noah is told about is one Noah cannot press itself, on either system", () => {
  for (const combo of [SHORTCUT.toLowerCase().replace("control", "ctrl"), "control+option+x", "option+control+x"]) {
    assert.equal(decideDesktop({ op: "key", window: { process: "notepad", title: "Untitled - Notepad" }, combo }, { mode: "autonomous" }).decision, "deny", combo);
  }
});

test("the bar's page can only say stop and hear what Noah is doing: nothing else of Electron or Node is exposed to it", () => {
  const exposed = {};
  const sent = [];
  const listeners = [];
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: { send: (ch, ...a) => sent.push([ch, ...a]), on: (ch, fn) => listeners.push([ch, fn]) },
  };
  const original = Module._load;
  Module._load = function (request, ...rest) { return request === "electron" ? fakeElectron : original.call(this, request, ...rest); };
  try {
    const file = require.resolve("../../desktop/pill-preload.cjs");
    delete require.cache[file];
    require(file);
    delete require.cache[file];
  } finally { Module._load = original; }
  assert.deepEqual(Object.keys(exposed), ["noahPill"]);
  assert.deepEqual(Object.keys(exposed.noahPill).sort(), ["onText", "stop"]);
  exposed.noahPill.stop();
  assert.deepEqual(sent, [["noah:pill-stop"]]);
  const heard = [];
  exposed.noahPill.onText((t) => heard.push(t));
  assert.equal(listeners[0][0], "noah:pill-text");
  listeners[0][1]({}, 42);
  assert.deepEqual(heard, ["42"], "whatever arrives is turned into text");
});

// ------------------------------------------------------------------------------------------------ following the task, without ever coming to the front
function wired({ focusWindow = null, handle = Buffer.from([0x78, 0x56, 0x34, 0x12, 0, 0, 0, 0]), notify, bar } = {}) {
  const s = standIns();
  const bus = new EventBus();
  const front = [];
  const mainWindow = {
    destroyed: false, minimized: false,
    isDestroyed() { return this.destroyed; }, isMinimized() { return this.minimized; },
    getNativeWindowHandle() { return handle; },
    restore() { front.push("restore"); this.minimized = false; }, show() { front.push("show"); }, moveTop() { front.push("moveTop"); }, focus() { front.push("focus"); }, flashFrame(on) { front.push(`flash:${on}`); },
  };
  const logs = [];
  const toasts = [];
  const detach = attachDesktopGuard({ guard: s.guard, bus, mainWindow, log: (m) => logs.push(m), focusWindow, notify: notify || ((n) => toasts.push(n)), ...(bar ? { bar } : {}) });
  return { ...s, bus, mainWindow, front, detach, logs, toasts, emit: (event, rest = {}) => bus.publish(event, rest) };
}

test("quiet mode (bar: takeover): a computer task arms the shortcut and shows nothing; a project task does neither", async () => {
  const w = wired({ bar: "takeover" });
  w.emit("mission_started", { objective: "fix the tests", desktop: false });
  w.emit("desktop_takeover", { state: "active" });
  await settle();
  assert.deepEqual([w.guard.isArmed(), w.guard.isShowing()], [false, false], "a project task has no business on the user's screen; and a stray takeover event is ignored");
  w.emit("mission_started", { objective: "open notepad", desktop: true });
  await settle();
  assert.deepEqual([w.guard.isArmed(), w.guard.shortcutActive(), w.guard.isShowing(), w.made.length], [true, true, false, 0], "the shortcut is armed, and NOTHING is shown while Noah works in the background");
});

test("quiet mode (bar: takeover): the bar shows only while Noah takes over the mouse or keyboard (or waits for the user), says which, and goes when Noah lets go", async () => {
  const w = wired({ bar: "takeover" });
  w.emit("mission_activity", { text: "Looked at the open windows" });
  assert.equal(w.made.length, 0, "in quiet mode a step on its own shows nothing");
  w.emit("mission_started", { desktop: true });
  w.emit("desktop_takeover", { state: "waiting", text: "Waiting for you to stop using the computer" });
  await settle();
  assert.equal(w.guard.isShowing(), true);
  assert.equal(w.made[0].sent.at(-1)[1], "Waiting for you to stop using the computer");
  w.emit("desktop_takeover", { state: "active", text: "Using Notepad" });
  assert.equal(w.made.length, 1, "the same bar");
  assert.equal(w.made[0].sent.at(-1)[1], "Using Notepad");
  w.emit("desktop_takeover", { state: "active" });
  assert.equal(w.made[0].sent.at(-1)[1], "Noah is using your computer", "a default wording");
  w.emit("mission_activity", { text: "Clicked Save" });
  assert.equal(w.made[0].sent.at(-1)[1], "Noah is using your computer", "in quiet mode the steps do not rewrite the bar: it says only what the takeover says");
  w.emit("desktop_takeover", { state: "idle" });
  assert.deepEqual([w.guard.isShowing(), w.guard.isArmed(), w.guard.shortcutActive()], [false, true, true], "the bar is gone, the shortcut stays armed");
});

test("by default the Stop bar shows for the WHOLE computer task, from its start, says what Noah is doing step by step, and goes when the task ends", async () => {
  const w = wired();
  w.emit("mission_started", { objective: "message Ansuman", desktop: true });
  await settle();
  assert.deepEqual([w.guard.isArmed(), w.guard.isShowing(), w.made.length], [true, true, 1], "visible at once, before any step");
  assert.equal(w.made[0].sent.at(-1)[1], "Noah is working on your computer");
  w.emit("mission_activity", { text: "Looked at the open windows (4 windows)", pending: false });
  assert.equal(w.made[0].sent.at(-1)[1], "Looked at the open windows (4 windows)", "what Noah just did");
  w.emit("mission_activity", { text: 'Clicked "Ansuman Bhattacharjee"' });
  assert.equal(w.made[0].sent.at(-1)[1], 'Clicked "Ansuman Bhattacharjee"');
  w.emit("desktop_takeover", { state: "active", text: "Using WhatsApp" });
  assert.equal(w.made[0].sent.at(-1)[1], "Using WhatsApp");
  w.emit("desktop_takeover", { state: "waiting", text: "Waiting for you to stop using the computer" });
  w.emit("desktop_takeover", { state: "idle" });
  assert.equal(w.guard.isShowing(), true, "Noah letting go of the mouse between steps does not hide the bar: the task is still running");
  assert.equal(w.made.length, 1, "one bar all along");
  w.emit("mission_finished", { status: "succeeded", summary: "Sent." });
  assert.deepEqual([w.guard.isShowing(), w.guard.isArmed(), w.guard.shortcutActive()], [false, false, false], "the task is over: the bar and the shortcut are gone");
});

test("the bar is for computer tasks only: a project task or a web task shows none, and a step with no words changes nothing", async () => {
  const w = wired();
  w.emit("mission_started", { objective: "fix the tests", desktop: false });
  w.emit("mission_activity", { text: "Ran the tests" });
  await settle();
  assert.deepEqual([w.guard.isShowing(), w.made.length], [false, 0]);
  w.emit("mission_started", { desktop: true });
  w.emit("mission_activity", { text: "" });
  w.emit("mission_activity", {});
  await settle();
  assert.equal(w.made[0].sent.at(-1)[1], "Noah is working on your computer");
});

test("a step announced while the bar is still loading is not lost: the page gets the newest words once it is ready", async () => {
  const w = wired();
  w.emit("mission_started", { desktop: true });
  w.emit("mission_activity", { text: "Brought WhatsApp to the front" }); // before the page has loaded (loadURL has not resolved yet)
  await settle();
  assert.equal(w.made[0].sent.at(-1)[1], "Brought WhatsApp to the front");
});

test("NOTHING comes to the front by itself: a card waiting for the user's OK is a notification and a taskbar flash, and clicking the notification is what opens Jonah", async () => {
  const asked = [];
  const w = wired({ focusWindow: async (hwnd) => { asked.push(hwnd); } });
  w.emit("mission_started", { desktop: true });
  w.emit("confirm_request", { id: "c1", summary: 'Click "Send" in WhatsApp (msedge)' });
  assert.deepEqual(w.front, ["flash:true"], "only the taskbar button flashes: no show, no focus, no raise");
  assert.deepEqual(asked, [], "and the desktop helper was not asked to bring Jonah forward either");
  assert.deepEqual([w.toasts.length, w.toasts[0].title, w.toasts[0].body], [1, "Noah needs your OK", 'Click "Send" in WhatsApp (msedge)']);
  w.mainWindow.minimized = true;
  w.toasts[0].onClick();
  assert.deepEqual(w.front.slice(1), ["restore", "show", "moveTop", "focus"], "the USER clicked the notification: now Jonah opens");
  assert.deepEqual(asked, [0x12345678], "through the desktop helper too, with Jonah's own window handle");
});

test("a card from the browser agent, or with no computer task running, gets no notification", () => {
  const w = wired();
  w.emit("confirm_request", { id: "c1", summary: "Click Buy" });
  assert.deepEqual([w.front, w.toasts.length], [[], 0]);
});

test("when a computer task ends on its own the user gets a notification with the answer's first words, not a window in their face; after their own Stop, nothing", async () => {
  for (const [status, title] of [["succeeded", "Noah finished"], ["blocked_input", "Noah stopped and needs you"], ["budget_paused", "Noah stopped and needs you"], ["impossible", "Noah stopped and needs you"]]) {
    const w = wired();
    w.emit("mission_started", { desktop: true });
    w.emit("desktop_takeover", { state: "active" });
    await settle();
    w.emit("mission_finished", { status, summary: status === "succeeded" ? "You have 1 unseen message from Sunil BSNL." : "", reason: "It could not do it." });
    assert.deepEqual([w.guard.isShowing(), w.guard.isArmed(), w.shortcuts.size], [false, false, 0], `${status}: the bar and the shortcut are gone`);
    assert.deepEqual(w.front, ["flash:true"], `${status}: only the taskbar flashes`);
    assert.equal(w.toasts[0].title, title, status);
    assert.equal(w.toasts[0].body, status === "succeeded" ? "You have 1 unseen message from Sunil BSNL." : "It could not do it.", status);
  }
  const stopped = wired();
  stopped.emit("mission_started", { desktop: true });
  stopped.emit("mission_finished", { status: "cancelled" });
  assert.deepEqual([stopped.toasts.length, stopped.front], [0, []], "the user pressed Stop themselves: they are already looking");
  const project = wired();
  project.emit("mission_started", { desktop: false });
  project.emit("mission_finished", { status: "succeeded", summary: "Fixed." });
  assert.deepEqual([project.toasts.length, project.front], [0, []], "a project task is not announced from here");
  const late = wired();
  late.emit("mission_started", { desktop: true });
  late.emit("mission_finished", { status: "succeeded", summary: "Done" });
  late.toasts.length = 0; late.front.length = 0;
  late.emit("mission_result", { status: "succeeded", text: "Done" });
  assert.deepEqual([late.toasts.length, late.front], [0, []], "the service's own result event comes after: nothing is announced twice");
});

test("a long answer is cut in the notification, to one line", () => {
  const w = wired();
  w.emit("mission_started", { desktop: true });
  w.emit("mission_finished", { status: "succeeded", summary: "Line one.\n\n" + "word ".repeat(100) });
  assert.ok(w.toasts[0].body.length <= 140);
  assert.doesNotMatch(w.toasts[0].body, /\n/);
});

test("opening Jonah never breaks the task: a destroyed window, a refusal, a failing helper, a failing notification are logged", async () => {
  const w = wired({ focusWindow: () => Promise.reject(new Error("the helper is gone")) });
  w.emit("mission_started", { desktop: true });
  w.emit("confirm_request", { id: "c1", summary: "x" });
  w.mainWindow.destroyed = true;
  w.toasts[0].onClick();
  assert.equal(w.front.includes("show"), false, "a destroyed main window is left alone");
  w.mainWindow.destroyed = false;
  w.toasts[0].onClick();
  await settle();
  assert.ok(w.logs.some((l) => /the helper could not bring Jonah to the front: the helper is gone/.test(l)), JSON.stringify(w.logs));
  w.mainWindow.focus = () => { throw new Error("the system said no"); };
  w.toasts[0].onClick();
  assert.ok(w.logs.some((l) => /could not bring Jonah to the front: the system said no/.test(l)));
  const bad = wired({ notify: () => { throw new Error("no notifications here"); } });
  bad.emit("mission_started", { desktop: true });
  bad.emit("confirm_request", { id: "c1", summary: "x" });
  assert.ok(bad.logs.some((l) => /could not show a notification: no notifications here/.test(l)));
  assert.equal(bad.guard.isArmed(), true, "and the task carries on");
});

test("a 32-bit window handle is read as 32-bit, a 64-bit as 64-bit", async () => {
  const asked = [];
  const small = wired({ focusWindow: async (hwnd) => { asked.push(hwnd); }, handle: Buffer.from([0x21, 0x43, 0x65, 0x07]) });
  small.emit("mission_started", { desktop: true });
  small.emit("confirm_request", { id: "c", summary: "x" });
  small.toasts[0].onClick();
  assert.deepEqual(asked, [0x07654321]);
});

test("after detaching, task events no longer move anything", async () => {
  const w = wired();
  w.detach();
  w.emit("mission_started", { desktop: true });
  w.emit("desktop_takeover", { state: "active" });
  await settle();
  assert.deepEqual([w.made.length, w.guard.isArmed()], [0, false]);
});
