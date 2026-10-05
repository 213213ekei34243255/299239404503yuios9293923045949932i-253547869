// Noah/test/unit/desktop-mac-host.test.cjs - the Mac helper's LOGIC (Noah/desktop/host-mac.js createHost), the bridge's Mac side, and the permission check.
//
// A stand-in for macOS (apps, windows, an accessibility tree, a keyboard, a mouse and a clock) stands behind `api`, so every rule can be hit exactly: window numbers, the
// refusals (password fields, covered spots, a window that is not in front), working quietly (the user touching the keyboard or mouse stops Noah at once, and Noah's own
// keystrokes are never mistaken for the user's), and what each operation answers.
//
// WHAT THIS DOES NOT PROVE: that the real macOS layer (makeJxaApi) works. That part has never been run on a Mac by its author; `node Noah/bench/integration/desktop-mac-check.cjs`
// run on a Mac checks it for real. These tests prove the logic on top of it, and that the file is valid, ASCII-only JavaScript.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { EventEmitter } = require("events");
const mac = require("../../desktop/host-mac.js");
const { cleanName, createHost, HostError, parseCombo, titleHash, windowNumber, decodeWindow, asciiJson, roleName, parsePoint, parseSize, SENSITIVE_NAME, OWN_SLACK_MS } = mac;
const { DesktopBridge, hostEnv } = require("../../desktop/bridge.cjs");
const { createPermissionCheck, ACCESSIBILITY_REPLY, screenNotice } = require("../../desktop/permissions.cjs");

// ------------------------------------------------------------------------------------------------ a stand-in for macOS
function makeMac() {
  const clock = { t: 5_000_000 };
  const s = {
    clock, log: [], trusted: true, screen: true, keyCost: 70, clickCost: 0, eventLag: 0, axCost: 0, refuseRaise: false, mouseStuck: false,
    lastEvent: clock.t - 60_000, // the most recent keyboard or mouse event of ANY kind (the user's or Noah's)
    mouse: { x: 5, y: 5 },
    front: { pid: 100, ref: "winNotes" },
    overlays: [], hits: {}, hitAny: null, focusedElement: null,
    onSleep: null, afterKey: null, keys: 0,
    nodes: {}, seq: 0,
    apps: [
      { pid: 100, name: "Notes", path: "/Applications/Notes.app", bundleId: "com.apple.Notes", hidden: false },
      { pid: 200, name: "Safari", path: "/Applications/Safari.app", bundleId: "com.apple.Safari", hidden: false },
    ],
    wins: {
      100: [{ ref: "winNotes", title: "Note 1", minimized: false, rect: { x: 100, y: 100, w: 600, h: 400 }, closable: true }],
      200: [{ ref: "winSafari", title: "News", minimized: false, rect: { x: 800, y: 100, w: 500, h: 400 }, closable: true }, { ref: "winSafari2", title: "News", minimized: false, rect: { x: 820, y: 120, w: 500, h: 400 }, closable: true }],
    },
    userTouches() { s.lastEvent = clock.t; },
    userIn(ms) { s.pending = clock.t + ms; }, // the user touches something `ms` after now: seen by the next look at the idle time (so it comes AFTER Noah's own event, as in life)
    pending: null,
  };
  s.node = (info, children = [], rect) => { const ref = `n${++s.seq}`; s.nodes[ref] = { info, children: children.map((c) => (typeof c === "string" ? c : c)), rect }; return ref; };
  const api = {
    isTrusted: () => s.trusted,
    canRecordScreen: () => s.screen,
    sleep: (ms) => { clock.t += ms; if (s.onSleep) s.onSleep(ms); },
    now: () => clock.t,
    listApps: () => s.apps.map((a) => ({ ...a, active: s.front.pid === a.pid })),
    frontmost: () => { const a = s.apps.find((x) => x.pid === s.front.pid); return a ? { pid: a.pid, name: a.name } : null; },
    axWindows: (pid) => (s.wins[pid] || []).map((w) => ({ ref: w.ref, title: w.title, minimized: w.minimized, focused: s.front.ref === w.ref })),
    isFrontWindow: (pid, ref) => s.front.pid === pid && s.front.ref === ref,
    raiseWindow: (pid, ref) => { s.log.push(["raise", ref]); if (!s.refuseRaise) s.front = { pid, ref }; },
    windowBounds: () => Object.entries(s.wins).flatMap(([pid, list]) => list.map((w) => ({ pid: Number(pid), title: w.title, x: w.rect.x, y: w.rect.y, w: w.rect.w, h: w.rect.h }))),
    windowRect: (pid, index) => (s.wins[pid] && s.wins[pid][index] ? s.wins[pid][index].rect : null),
    axChildren: (ref) => (s.nodes[ref] ? s.nodes[ref].children : []),
    axInfo: (ref) => { clock.t += s.axCost; const n = s.nodes[ref]; if (!n) throw new Error("that element is gone"); return { actions: [], ...n.info }; },
    axAction: (ref, name) => { s.log.push(["action", ref, name]); const n = s.nodes[ref]; return !!n && (n.info.actions || []).includes(name); },
    axSetValue: (ref, text) => { s.log.push(["setValue", ref, text]); const n = s.nodes[ref]; if (!n || !n.info.settable) return false; n.info.value = text; return true; },
    axFocus: (ref) => { s.log.push(["focus", ref]); return true; },
    axFocusedElement: () => s.focusedElement,
    closeWindow: (ref) => { const list = Object.values(s.wins).find((l) => l.some((w) => w.ref === ref)); const w = list && list.find((x) => x.ref === ref); if (!w || !w.closable) return false; list.splice(list.indexOf(w), 1); return true; },
    keystroke: (ch, mods) => { clock.t += s.keyCost; s.keys++; s.log.push(["keystroke", ch, mods]); s.lastEvent = clock.t + s.eventLag; if (s.afterKey) s.afterKey(s.keys); },
    keyCode: (code, mods) => { clock.t += s.keyCost; s.keys++; s.log.push(["keyCode", code, mods]); s.lastEvent = clock.t + s.eventLag; if (s.afterKey) s.afterKey(s.keys); },
    mouseMove: (x, y) => { s.log.push(["move", x, y]); if (!s.mouseStuck) s.mouse = { x, y }; s.lastEvent = clock.t + s.eventLag; },
    mouseClick: (x, y, o) => { clock.t += s.clickCost; s.log.push(["click", x, y, o]); s.lastEvent = clock.t + s.eventLag; },
    scrollWheel: (dy) => { clock.t += 20; s.log.push(["scroll", dy]); s.lastEvent = clock.t + s.eventLag; },
    cursor: () => ({ ...s.mouse }),
    idleMs: () => { if (s.pending !== null) { clock.t = Math.max(clock.t, s.pending); s.lastEvent = s.pending; s.pending = null; } return clock.t - s.lastEvent; },
    windowAt: (x, y) => {
      const inside = (r) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
      for (const o of s.overlays) if (inside(o.rect)) return { pid: o.pid, name: o.name };
      const all = Object.entries(s.wins).flatMap(([pid, list]) => list.map((w) => ({ pid: Number(pid), ref: w.ref, rect: w.rect })));
      all.sort((a, b) => Number(b.ref === s.front.ref) - Number(a.ref === s.front.ref));
      const hit = all.find((w) => inside(w.rect));
      return hit ? { pid: hit.pid, name: (s.apps.find((a) => a.pid === hit.pid) || {}).name || "" } : null;
    },
    axElementAt: (x, y) => s.hits[`${x},${y}`] || s.hitAny,
    axRect: (ref) => (s.nodes[ref] ? s.nodes[ref].rect || null : null),
    capture: (rect, maxWidth) => { const sw = rect.w * 2, sh = rect.h * 2; const w = Math.min(sw, maxWidth); return { base64: "UE5H", width: w, height: Math.round((sh * w) / sw), sourceWidth: sw, sourceHeight: sh }; },
    launch: ({ path: p }) => { s.log.push(["launch", p]); return 4242; },
    installedApps: () => [{ name: "Notes", id: "/System/Applications/Notes.app" }],
    cursorOverride: null,
  };
  return { s, api };
}

/** A small window of Notes with a tree: a toolbar button, a text area, a sensitive field, a password field, a checkbox and a list of chats. */
function notesWindow(s) {
  const staticText = (t) => s.node({ role: "AXStaticText", value: t });
  const newNote = s.node({ role: "AXButton", title: "New Note", actions: ["AXPress"] }, [], { x: 120, y: 110, w: 80, h: 24 });
  const iconBtn = s.node({ role: "AXButton", title: "", actions: ["AXPress"] });
  const toolbar = s.node({ role: "AXToolbar" }, [newNote, iconBtn]);
  const body = s.node({ role: "AXTextArea", title: "Body", value: "hello", settable: true });
  const scroll = s.node({ role: "AXScrollArea" }, [body]);
  const sens = s.node({ role: "AXTextField", title: "Password hint", value: "hunter2", settable: true });
  const secure = s.node({ role: "AXTextField", subrole: "AXSecureTextField", title: "Secret", value: "x", settable: true });
  const pin = s.node({ role: "AXCheckBox", title: "Pin note", value: 1, actions: ["AXPress"] });
  const row1 = s.node({ role: "AXRow" }, [s.node({ role: "AXCell" }, [staticText("Ansuman Kumar"), staticText("10:42 pm")])], { x: 110, y: 300, w: 200, h: 40 });
  const row2 = s.node({ role: "AXRow" }, [s.node({ role: "AXCell" }, [staticText("Sunil BSNL")])], { x: 110, y: 340, w: 200, h: 40 });
  const table = s.node({ role: "AXTable" }, [row1, row2]);
  s.nodes.winNotes = { info: { role: "AXWindow", title: "Note 1" }, children: [toolbar, scroll, sens, secure, pin, table], rect: { x: 100, y: 100, w: 600, h: 400 } };
  return { newNote, iconBtn, body, sens, secure, pin, row1, row2, table, toolbar, scroll };
}

function fresh() {
  const m = makeMac();
  const refs = notesWindow(m.s);
  const host = createHost(m.api);
  const call = (op, args = {}) => host.handle({ id: 7, op, args });
  const okc = (op, args) => { const r = call(op, args); assert.equal(r.ok, true, `${op} failed: ${JSON.stringify(r)}`); return r.result; };
  const bad = (op, args, code) => { const r = call(op, args); assert.equal(r.ok, false, `${op} should have failed: ${JSON.stringify(r)}`); if (code) assert.equal(r.code, code, JSON.stringify(r)); return r; };
  const NOTES = windowNumber(100, "Note 1", 0);
  return { ...m, refs, host, call, okc, bad, NOTES };
}
const logOf = (s, kind) => s.log.filter((l) => l[0] === kind);

// ------------------------------------------------------------------------------------------------ the protocol
test("every request gets exactly one answer with its id, and nothing throws", () => {
  const f = fresh();
  assert.deepEqual(f.host.handle({ id: 5, op: "ping" }), { id: 5, ok: true, result: "pong" });
  for (const op of ["nope", "toString", "constructor", "__proto__", "hasOwnProperty", undefined, null, 42]) {
    const r = f.host.handle({ id: 9, op });
    assert.deepEqual([r.id, r.ok, r.code], [9, false, "bad_op"], String(op));
    assert.match(r.error, /unknown operation/);
  }
  assert.equal(f.host.handle(null).ok, false);
  assert.equal(f.host.handle(undefined).code, "bad_op");
  assert.equal(f.host.handle({ id: 1, op: "ping", args: null }).ok, true, "missing arguments are fine");
});

test("what the helper cannot do is reported in words the user can act on, never as a stack trace", () => {
  const g = fresh();
  g.api.keyCode = () => { throw new Error("-1743 errAEEventNotPermitted"); };
  const denied = g.bad("key", { window: g.NOTES, combo: "enter" });
  assert.equal(denied.code, "automation_denied");
  assert.match(denied.error, /Privacy & Security \(Security & Privacy\) > Automation/, "both macOS names: System Preferences on Monterey and older");
  const h = fresh();
  h.api.axInfo = () => { throw new Error("x".repeat(1000)); };
  const long = h.bad("tree", { window: h.NOTES });
  assert.equal(long.code, "error");
  assert.ok(long.error.length <= 300, "an unexpected error is cut short");
});

test("without the Accessibility permission every operation that needs it says exactly where to switch it on, and nothing is touched", () => {
  const f = fresh();
  f.s.trusted = false;
  for (const [op, args] of [["windows", {}], ["tree", { window: f.NOTES }], ["interactive", { window: f.NOTES }], ["elementAt", { x: 1, y: 1 }], ["screenshot", { window: f.NOTES }], ["focus", { window: f.NOTES }], ["click", { x: 1, y: 1, window: f.NOTES }], ["scroll", { window: f.NOTES }], ["setText", { element: "e1", text: "x" }], ["type", { window: f.NOTES, text: "a" }], ["key", { window: f.NOTES, combo: "cmd+s" }], ["close", { window: f.NOTES }], ["waitWindow", { title: "x" }]]) {
    const r = f.bad(op, args, "accessibility_denied");
    assert.match(r.error, /System Settings \(System Preferences on older Macs\) > Privacy & Security \(Security & Privacy\) > Accessibility/, op);
    assert.match(r.error, /press the minus \(-\) button/, `${op}: the stale-permission remedy is in the message`);
  }
  assert.equal(f.s.log.length, 0, "nothing was sent to the computer");
  for (const op of ["ping", "userIdle", "cursor", "apps"]) assert.equal(f.call(op).ok, true, `${op} needs no permission`);
  assert.equal(f.call("launch", { appId: "/Applications/Notes.app" }).ok, true, "starting an app needs none either");
});

// ------------------------------------------------------------------------------------------------ windows
test("windows are numbered pid * 1,000,000 + title hash * 1,000 + n: stable, unique, and the same on every read", () => {
  const f = fresh();
  const list = f.okc("windows");
  assert.equal(list.length, 3);
  const ids = list.map((w) => w.window);
  assert.equal(new Set(ids).size, 3, "unique, even for two windows with the same title");
  const [a, b] = list.filter((w) => w.pid === 200);
  assert.equal(b.window - a.window, 1, "two windows with the same title differ by their position among them");
  assert.deepEqual(decodeWindow(a.window), { pid: 200, hash: titleHash("News"), n: 0 });
  assert.equal(f.okc("windows").map((w) => w.window).join(), ids.join(), "the same numbers on the next read");
  assert.ok(ids.every((n) => Number.isSafeInteger(n)), "small enough for JSON and JavaScript numbers");
  for (const t of ["", "a", "Note 1", "café", "x".repeat(500)]) { const h = titleHash(t); assert.ok(Number.isInteger(h) && h >= 0 && h < 1000, t); assert.equal(h, titleHash(t)); }
  assert.notEqual(windowNumber(100, "Note 1", 0), windowNumber(100, "Note 2", 0));
});

test("a window list says what is in front, who owns each window, where it is, and puts the front app first", () => {
  const f = fresh();
  const list = f.okc("windows");
  assert.equal(list[0].process, "Notes", "the app in front comes first");
  const n = list[0];
  assert.deepEqual([n.title, n.pid, n.foreground, n.minimized, n.x, n.y, n.w, n.h, n.class, n.path], ["Note 1", 100, true, false, 100, 100, 600, 400, "AXWindow", "/Applications/Notes.app"]);
  assert.equal(list.filter((w) => w.foreground).length, 1);
  f.s.front = { pid: 200, ref: "winSafari" };
  const after = f.okc("windows");
  assert.equal(after[0].process, "Safari");
  assert.deepEqual(after.filter((w) => w.foreground).map((w) => w.window), [windowNumber(200, "News", 0)]);
});

test("a window that is not in the list is 'no_window'; one that moved to a new place keeps its number", () => {
  const f = fresh();
  f.bad("tree", { window: 123 }, "no_window");
  f.bad("tree", { window: "abc" }, "no_window");
  f.bad("tree", {}, "no_window");
  f.okc("windows");
  f.s.wins[100][0].rect = { x: 300, y: 300, w: 600, h: 400 };
  assert.equal(f.okc("windows").find((w) => w.pid === 100).window, f.NOTES);
  f.okc("tree", { window: f.NOTES });
});

// ------------------------------------------------------------------------------------------------ reading
// ------------------------------------------------------------------------------------------------ an empty window list must never look like "nothing is open"
// (a real Mac test: Chrome was open, the helper said "0 windows", and the agent launched Chrome again and again while the Mac heated up)
test("when macOS hides the windows of the apps that have them, 'windows' is an ERROR that says what to do, not an empty list", () => {
  const f = fresh();
  f.api.axWindows = () => []; // every app answers "no windows", although macOS shows Notes and Safari windows on screen
  const r = f.bad("windows", {}, "accessibility_stale");
  assert.match(r.error, /macOS shows open windows \((Notes|Safari)/);
  assert.match(r.error, /does not let Jonah read them/);
  assert.match(r.error, /press the minus \(-\) button/);
  assert.match(r.error, /older version of Jonah/);
  assert.ok(logOf(f.s, "click").length + logOf(f.s, "key").length === 0, "nothing was touched");
});

test("a window that has only just opened (macOS cannot read it for a moment) is read on the retry, with no error", () => {
  const f = fresh();
  const real = f.api.axWindows;
  let hidden = true;
  f.api.axWindows = (pid) => (hidden ? [] : real(pid));
  f.s.onSleep = (ms) => { if (ms === 350) hidden = false; };
  const list = f.okc("windows");
  assert.equal(list.length, 3, "all three windows are listed");
});

test("a few odd apps that hide their windows are not an error while the others can be read; a Mac with no apps at all is", () => {
  const f = fresh();
  f.s.apps.push({ pid: 300, name: "Odd", path: "/Applications/Odd.app", bundleId: "x.odd", hidden: false });
  f.s.wins[300] = [{ ref: "winOdd", title: "Odd", minimized: false, rect: { x: 10, y: 10, w: 200, h: 200 }, closable: true }];
  f.s.nodes.winOdd = { info: { role: "AXWindow", title: "Odd" }, children: [] };
  const real = f.api.axWindows;
  f.api.axWindows = (pid) => (pid === 300 ? [] : real(pid)); // one app of three hides its window
  assert.equal(f.okc("windows").length, 3);
  const g = fresh();
  g.api.listApps = () => [];
  const r = g.bad("windows", {}, "no_apps");
  assert.match(r.error, /list of running apps/);
});

test("tiny things on screen (a tooltip, a one-pixel helper window) are not 'an open window': with only those, an empty list is simply an empty list", () => {
  const f = fresh();
  f.s.wins[100][0].rect = { x: 0, y: 0, w: 20, h: 20 };
  for (const w of f.s.wins[200]) w.rect = { x: 5, y: 5, w: 1, h: 1 };
  f.api.axWindows = () => [];
  assert.deepEqual(f.okc("windows"), [], "no error, no windows");
});

test("waiting for ONE app's window does not make the helper forget the windows it already knows of the others", () => {
  const f = fresh();
  f.okc("windows"); // all three windows are known now
  const real = f.api.axWindows;
  let scans = 0;
  f.api.axWindows = (pid) => { scans++; return real(pid); };
  f.okc("waitWindow", { process: "Safari", waitMs: 800 });
  scans = 0;
  f.okc("tree", { window: f.NOTES }); // Notes was not scanned by the wait, but it is still known: no new scan of anything
  assert.equal(scans, 0, "the window numbers of the other apps are still valid");
});

test("waiting for a window reads only that app, slowly, and says WHY when the window is there but unreadable", () => {
  const f = fresh();
  const scanned = [];
  const sleeps = [];
  const real = f.api.axWindows;
  f.api.axWindows = (pid) => { scanned.push(pid); return real(pid); };
  f.s.onSleep = (ms) => sleeps.push(ms);
  const t0 = f.s.clock.t;
  f.bad("waitWindow", { process: "Safari", title: "never there", waitMs: 2500 }, "timeout");
  assert.ok(scanned.length > 0 && scanned.every((p) => p === 200), `only Safari was read, never the other apps: ${[...new Set(scanned)]}`);
  assert.ok(sleeps.filter((m) => m === 700).length >= 2, "polling every 0.7 s, not every 0.25 s");
  assert.ok(sleeps.filter((m) => m === 250).length === 0);
  assert.ok(f.s.clock.t - t0 < 4500, "and it still gives up in about the time asked");
  const g = fresh();
  g.api.axWindows = () => []; // Safari's windows are on screen but cannot be read
  const e = g.bad("waitWindow", { process: "Safari", waitMs: 1500 }, "accessibility_stale");
  assert.match(e.error, /Safari/);
  assert.match(e.error, /press the minus \(-\) button/);
});

test("a window's controls are described the way the Windows helper describes them", () => {
  const f = fresh();
  const t = f.okc("tree", { window: f.NOTES });
  const by = (name) => t.nodes.find((n) => n.name === name);
  assert.equal(t.title, "Note 1");
  assert.equal(t.nodes[0].type, "Window");
  assert.deepEqual([by("New Note").type, by("New Note").actions, by("New Note").enabled], ["Button", ["invoke"], true]);
  assert.deepEqual([by("Body").type, by("Body").value, by("Body").actions], ["Edit", "hello", ["value"]]);
  assert.equal(by("Pin note").type, "CheckBox");
  assert.equal(by("Pin note").toggle, "On");
  assert.deepEqual(by("Pin note").actions, ["invoke", "toggle"]);
  assert.equal(t.nodes.find((n) => n.type === "ToolBar").type, "ToolBar");
  assert.ok(t.nodes.some((n) => n.type === "Table"));
  assert.ok(t.nodes.some((n) => n.type === "Text" && n.name === "Ansuman Kumar"), "static text is named by its words");
  assert.ok(t.nodes.some((n) => n.type === "Pane" && n.actions.includes("scroll")));
  t.nodes.forEach((n, i) => { assert.match(n.element, /^e\d+$/); if (i > 0) assert.ok(n.parent >= 0 && n.parent < i && n.depth === t.nodes[n.parent].depth + 1, "parents come first, depth follows"); });
});

test("a password field's value is never read out, and a field whose NAME says it holds a secret is hidden too", () => {
  const f = fresh();
  const t = f.okc("tree", { window: f.NOTES });
  const secure = t.nodes.find((n) => n.name === "Secret");
  assert.equal(secure.password, true);
  assert.equal(secure.value, "(hidden)");
  const sens = t.nodes.find((n) => n.name === "Password hint");
  assert.match(sens.value, /hidden/);
  assert.doesNotMatch(JSON.stringify(t), /hunter2/, "the value never leaves the helper");
  for (const n of ["Password", "PIN", "Passcode", "OTP", "CVV", "Card number", "API key", "Client secret", "Access token"]) assert.ok(SENSITIVE_NAME.test(n), n);
  for (const n of ["Notes", "Body", "Pinterest", "Title", "Search"]) assert.ok(!SENSITIVE_NAME.test(n), n);
});

test("a tree is cut at the size and depth asked for, and says so", () => {
  const f = fresh();
  const small = f.okc("tree", { window: f.NOTES, maxNodes: 5 });
  assert.equal(small.nodes.length, 5);
  assert.equal(small.truncated, true);
  const shallow = f.okc("tree", { window: f.NOTES, maxDepth: 1 });
  assert.ok(shallow.nodes.every((n) => n.depth <= 1));
  assert.equal(f.okc("tree", { window: f.NOTES }).truncated, false);
});

test("the control ids of an earlier read stay usable until the window is read again, and an unknown id says 'stale'", () => {
  const f = fresh();
  f.okc("tree", { window: f.NOTES });
  f.bad("click", { element: "e99999" }, "stale");
  f.bad("setText", { element: "nope", text: "x" }, "stale");
  f.bad("type", { window: f.NOTES, text: "x", element: "nope" }, "stale");
});

test("interactive lists only controls worth pressing or filling in, flat, with the words of a list row taken from its text", () => {
  const f = fresh();
  const r = f.okc("interactive", { window: f.NOTES });
  assert.equal(r.title, "Note 1");
  assert.equal(r.truncated, false);
  const names = r.nodes.map((n) => n.name);
  assert.deepEqual(names, ["New Note", "Body", "Password hint", "Secret", "Pin note", "Ansuman Kumar 10:42 pm", "Sunil BSNL"]);
  assert.ok(!names.includes(""), "an unnamed icon button is not listed (nothing to find it by)");
  assert.ok(r.nodes.every((n) => n.depth === undefined && n.parent === undefined && /^e\d+$/.test(n.element)), "flat, with usable ids");
  const row = r.nodes.find((n) => /Ansuman/.test(n.name));
  assert.deepEqual([row.type, row.enabled], ["ListItem", true]);
  assert.equal(r.nodes.find((n) => n.name === "Secret").password, true);
  assert.doesNotMatch(JSON.stringify(r), /hunter2/);
});

test("the words of a long list row are the first few pieces of text in it, not all of them", () => {
  const f = fresh();
  const texts = ["One", "Two", "Three", "Four", "Five", "Six"].map((t) => f.s.node({ role: "AXStaticText", value: t }));
  const row = f.s.node({ role: "AXRow" }, [f.s.node({ role: "AXCell" }, texts)], { x: 110, y: 400, w: 200, h: 40 });
  f.s.hits["150,410"] = row;
  assert.equal(f.okc("elementAt", { x: 150, y: 410 }).name, "One Two Three Four");
  const deep = f.s.node({ role: "AXStaticText", value: "Too deep" });
  const rowDeep = f.s.node({ role: "AXRow" }, [f.s.node({ role: "AXCell" }, [f.s.node({ role: "AXGroup" }, [f.s.node({ role: "AXGroup" }, [f.s.node({ role: "AXGroup" }, [deep])])])])]);
  f.s.hits["1,2"] = rowDeep;
  assert.equal(f.okc("elementAt", { x: 1, y: 2 }).name, "", "text buried more than three levels down is not the row's name");
});

test("interactive is time-limited and size-limited, and says when it stopped early", () => {
  const f = fresh();
  f.s.axCost = 400; // every look at a control takes 0.4 s
  const slow = f.okc("interactive", { window: f.NOTES, budgetMs: 1000 });
  assert.equal(slow.truncated, true);
  assert.ok(slow.nodes.length < 7, "it stopped before reading everything");
  assert.ok(f.s.clock.t - 5_000_000 < 3000, "and did not run on");
  f.s.axCost = 0;
  const capped = f.okc("interactive", { window: f.NOTES, maxNodes: 10 });
  assert.equal(capped.nodes.length, 7, "ten is the least it caps at; everything here is listed");
  const tiny = f.okc("interactive", { window: f.NOTES, maxNodes: 1 });
  assert.equal(tiny.nodes.length <= 10, true);
});

test("an id from the interactive list can be pressed", () => {
  const f = fresh();
  const r = f.okc("interactive", { window: f.NOTES });
  const id = r.nodes.find((n) => n.name === "New Note").element;
  const c = f.okc("click", { element: id });
  assert.deepEqual([c.method, c.name], ["invoke", "New Note"]);
});

test("elementAt says what is at a point: its name, kind, whether it is a password field, and the words of a row", () => {
  const f = fresh();
  f.s.hits["130,120"] = f.refs.newNote;
  f.s.hits["150,310"] = f.refs.row1;
  f.s.hits["20,20"] = f.refs.secure;
  assert.deepEqual(f.okc("elementAt", { x: 130, y: 120 }), { found: true, name: "New Note", type: "Button", enabled: true });
  const row = f.okc("elementAt", { x: 150, y: 310 });
  assert.deepEqual([row.name, row.type], ["Ansuman Kumar 10:42 pm", "ListItem"]);
  const pw = f.okc("elementAt", { x: 20, y: 20 });
  assert.equal(pw.password, true);
  assert.deepEqual(f.okc("elementAt", { x: 1, y: 1 }), { found: false });
  f.bad("elementAt", { x: "a", y: 1 }, "no_target");
  f.bad("elementAt", {}, "no_target");
  assert.equal(Object.keys(f.host.state.elements).length, 0, "(nothing is remembered from a hit test)");
});

// ------------------------------------------------------------------------------------------------ focus
test("focus brings a window forward, answers with it, and says which window the user had in front (so it can be put back)", () => {
  const f = fresh();
  const safari = windowNumber(200, "News", 0);
  const r = f.okc("focus", { window: safari });
  assert.equal(r.window, safari);
  assert.equal(r.foreground, true);
  assert.equal(r.previous, f.NOTES, "the user was in Notes");
  assert.equal(f.okc("focus", { window: safari }).previous, null, "already in front: nothing to put back");
  assert.equal(f.okc("focus", { window: f.NOTES }).previous, safari);
});

test("a window that will not come to the front is reported after trying again, not silently", () => {
  const f = fresh();
  f.s.refuseRaise = true;
  const r = f.bad("focus", { window: windowNumber(200, "News", 0) }, "focus_failed");
  assert.match(r.error, /another app may be holding focus/);
  assert.equal(logOf(f.s, "raise").length, 4, "four attempts");
});

// ------------------------------------------------------------------------------------------------ clicking
test("a control with its own action is pressed through the accessibility tree, without the mouse or the window in front", () => {
  const f = fresh();
  f.s.front = { pid: 200, ref: "winSafari" }; // Notes is NOT in front
  const t = f.okc("tree", { window: f.NOTES });
  const id = t.nodes.find((n) => n.name === "New Note").element;
  const r = f.okc("click", { element: id });
  assert.deepEqual([r.method, r.name], ["invoke", "New Note"]);
  assert.equal(logOf(f.s, "click").length + logOf(f.s, "move").length, 0, "the mouse never moved");
  const dbl = f.okc("click", { element: id, double: true });
  assert.equal(logOf(f.s, "action").length, 3, "a double press is two presses");
  const right = f.bad("click", { element: id, right: true }, "not_invokable");
  assert.match(right.error, /no context menu/);
});

test("a control with no action of its own (a list row) is clicked with the mouse at its middle, once its window is in front", () => {
  const f = fresh();
  f.okc("focus", { window: windowNumber(200, "News", 0) });
  const t = f.okc("interactive", { window: f.NOTES });
  const row = t.nodes.find((n) => /Ansuman/.test(n.name)).element;
  const r1 = f.bad("click", { element: row }, "not_foreground");
  assert.match(r1.error, /not in front/);
  assert.equal(logOf(f.s, "click").length, 0, "nothing was clicked while the window was behind");
  f.okc("focus", { window: f.NOTES });
  const r = f.okc("click", { element: row });
  assert.deepEqual([r.method, r.name], ["mouse", "Ansuman Kumar 10:42 pm"]);
  assert.deepEqual(logOf(f.s, "click")[0].slice(1, 3), [210, 320], "the middle of the row: (110 + 200/2, 300 + 40/2)");
});

test("a real click can be asked for even where an action exists; a control with no action and no place is 'not_invokable'", () => {
  const f = fresh();
  const t = f.okc("tree", { window: f.NOTES });
  const id = t.nodes.find((n) => n.name === "New Note").element;
  const r = f.okc("click", { element: id, mouse: true });
  assert.equal(r.method, "mouse");
  assert.deepEqual(logOf(f.s, "click")[0].slice(1, 3), [160, 122]);
  const icon = t.nodes.find((n) => n.type === "Button" && n.name === "").element;
  f.s.nodes[f.refs.iconBtn].info.actions = [];
  const e = f.bad("click", { element: icon }, "not_invokable");
  assert.match(e.error, /click a spot instead/);
});

test("a password field is never clicked into, by id", () => {
  const f = fresh();
  const t = f.okc("tree", { window: f.NOTES });
  f.bad("click", { element: t.nodes.find((n) => n.name === "Secret").element }, "password_field");
  assert.equal(f.s.log.length, 0);
});

test("a click at a spot is checked at every step and only then made: front, inside, uncovered, pointer arrived, user still", () => {
  const f = fresh();
  const r = f.okc("click", { window: f.NOTES, x: 400, y: 300 });
  assert.deepEqual([r.method, r.name], ["mouse", "(spot)"]);
  assert.deepEqual(f.s.log.map((l) => l[0]), ["move", "click"]);
  assert.deepEqual(logOf(f.s, "click")[0].slice(1), [400, 300, { right: false, count: 1 }]);
  f.s.log.length = 0;
  f.okc("click", { window: f.NOTES, x: 400.4, y: 300.6, double: true, right: true });
  assert.deepEqual(logOf(f.s, "click")[0].slice(1), [400, 301, { right: true, count: 2 }], "whole numbers, a double click is two");
  f.bad("click", { window: f.NOTES, x: "a", y: 2 }, "bad_arguments");
  f.bad("click", { window: f.NOTES }, "bad_arguments");
});

test("a spot outside the window, in a window that is behind, or under another program's window is refused, and nothing is clicked", () => {
  const f = fresh();
  f.bad("click", { window: f.NOTES, x: 50, y: 300 }, "outside_window");
  f.bad("click", { window: f.NOTES, x: 400, y: 900 }, "outside_window");
  f.s.overlays = [{ pid: 200, name: "Safari", rect: { x: 350, y: 250, w: 100, h: 100 } }];
  const covered = f.bad("click", { window: f.NOTES, x: 400, y: 300 }, "covered");
  assert.match(covered.error, /something else is on top of that spot \(Safari\)/);
  assert.equal(f.s.log.length, 0, "the pointer was not even moved there");
  f.okc("click", { window: f.NOTES, x: 600, y: 450 }); // a part of the window that is not covered
  f.s.overlays = [];
  f.s.log.length = 0;
  f.s.front = { pid: 200, ref: "winSafari" };
  f.bad("click", { window: f.NOTES, x: 400, y: 300 }, "not_foreground");
  assert.equal(f.s.log.length, 0);
  f.s.overlays = [{ pid: 100, name: "Notes", rect: { x: 350, y: 250, w: 100, h: 100 } }];
  f.s.front = { pid: 100, ref: "winNotes" };
  f.okc("click", { window: f.NOTES, x: 400, y: 300 }); // the same program's own panel on top is fine
});

test("if the pointer does not arrive where Noah sent it (the user moved the mouse), nothing is clicked", () => {
  const f = fresh();
  f.s.onSleep = (ms) => { if (ms === 80) f.s.mouse = { x: 900, y: 50 }; }; // the user grabs the mouse while Noah is pointing
  const r = f.bad("click", { window: f.NOTES, x: 400, y: 300 }, "user_busy");
  assert.match(r.error, /someone moved the mouse/);
  assert.equal(logOf(f.s, "click").length, 0);
  const g = fresh();
  g.s.mouseStuck = true;
  g.bad("click", { window: g.NOTES, x: 400, y: 300 }, "user_busy");
  const v = fresh();
  v.s.onSleep = (ms) => { if (ms === 80) v.s.mouse = { x: 400, y: 340 }; }; // moved straight down only
  v.bad("click", { window: v.NOTES, x: 400, y: 300 }, "user_busy");
  const small = fresh();
  small.s.onSleep = (ms) => { if (ms === 80) small.s.mouse = { x: 402, y: 302 }; }; // a pixel or two of rounding is not the user
  small.okc("click", { window: small.NOTES, x: 400, y: 300 });
  const h = fresh();
  h.s.onSleep = (ms) => { if (ms === 80) { h.s.clock.t += 400; h.s.userTouches(); } }; // the user types something
  const k = h.bad("click", { window: h.NOTES, x: 400, y: 300 }, "user_busy");
  assert.match(k.error, /you started using the computer/);
  assert.equal(logOf(h.s, "click").length, 0);
});

test("when Noah has been given the mouse (force) a nudged pointer is pointed again, the user's keys do not stop typing, and a key press goes ahead", () => {
  const f = fresh();
  let nudges = 2; // a hand moves the mouse during the first two attempts
  f.s.onSleep = (ms) => { if (ms === 80 && nudges > 0) { nudges--; f.s.mouse = { x: 900, y: 50 }; } };
  const r = f.okc("click", { window: f.NOTES, x: 400, y: 300, force: true });
  assert.equal(r.method, "mouse");
  assert.equal(logOf(f.s, "move").length, 3, "pointed three times: the two nudged ones and the one that held");
  assert.equal(logOf(f.s, "click").length, 1);
  const g = fresh();
  g.s.onSleep = (ms) => { if (ms === 80) g.s.mouse = { x: 900, y: 50 }; }; // something keeps moving it
  const e = g.bad("click", { window: g.NOTES, x: 400, y: 300, force: true }, "user_busy");
  assert.equal(logOf(g.s, "move").length, 4, "one try and three more, then it gives up");
  assert.equal(logOf(g.s, "click").length, 0);
  const h = fresh();
  h.s.afterKey = (n) => { if (n === 5) h.s.userIn(300); };
  assert.equal(h.okc("type", { window: h.NOTES, text: "x".repeat(30), force: true }).typed, 30, "the user's keys do not stop typing when Noah has the keyboard");
  const lose = fresh();
  lose.s.afterKey = (n) => { if (n === 4) lose.s.front = { pid: 200, ref: "winSafari" }; };
  lose.bad("type", { window: lose.NOTES, text: "abcdefgh", force: true }, "not_foreground"); // but a window that loses the front still stops it
  const k = fresh();
  k.okc("key", { window: k.NOTES, combo: "cmd+a" });
  k.s.clock.t += 600; k.s.userTouches(); k.s.clock.t += 300;
  k.bad("key", { window: k.NOTES, combo: "cmd+c" }, "user_busy");
  assert.deepEqual(k.okc("key", { window: k.NOTES, combo: "cmd+c", force: true }), { pressed: "cmd+c" });
  const sc = fresh();
  const wheel = sc.api.scrollWheel;
  let ticks = 0;
  sc.api.scrollWheel = (dy) => { wheel(dy); if (++ticks === 2) sc.s.userIn(500); };
  assert.equal(sc.okc("scroll", { window: sc.NOTES, clicks: -6, force: true }).scrolled, -6);
  assert.ok(e.error.length > 0);
});

test("with force a click goes ahead even if the user touched the keyboard while Noah was pointing; without it, it stops", () => {
  const a = fresh();
  a.s.onSleep = (ms) => { if (ms === 80) { a.s.clock.t += 400; a.s.userTouches(); } };
  assert.equal(a.okc("click", { window: a.NOTES, x: 400, y: 300, force: true }).method, "mouse");
  const b = fresh();
  b.s.onSleep = (ms) => { if (ms === 80) { b.s.clock.t += 400; b.s.userTouches(); } };
  b.bad("click", { window: b.NOTES, x: 400, y: 300 }, "user_busy");
});

test("if the window loses the front or gets covered between pointing and clicking, nothing is clicked", () => {
  const f = fresh();
  f.s.onSleep = (ms) => { if (ms === 80) f.s.front = { pid: 200, ref: "winSafari" }; };
  f.bad("click", { window: f.NOTES, x: 400, y: 300 }, "not_foreground");
  assert.equal(logOf(f.s, "click").length, 0);
  const g = fresh();
  g.s.onSleep = (ms) => { if (ms === 80) g.s.overlays = [{ pid: 200, name: "Safari", rect: { x: 0, y: 0, w: 5000, h: 5000 } }]; };
  g.bad("click", { window: g.NOTES, x: 400, y: 300 }, "covered");
  assert.equal(logOf(g.s, "click").length, 0);
});

// ------------------------------------------------------------------------------------------------ working quietly
test("userIdle: how long since the USER used the keyboard or mouse; what Noah sent itself is not counted", () => {
  const f = fresh();
  const first = f.okc("userIdle");
  assert.deepEqual([first.idleMs, first.own], [60_000, false], "nobody has done anything for a minute");
  f.s.clock.t += 5000;
  assert.equal(f.okc("userIdle").idleMs, 65_000);
  f.okc("click", { window: f.NOTES, x: 400, y: 300 });
  const after = f.okc("userIdle");
  assert.deepEqual([after.own, after.idleMs], [true, 3_600_000], "the latest input was Noah's own: as far as the user goes, a long time");
  f.s.clock.t += 1000;
  assert.equal(f.okc("userIdle").own, true);
  f.s.clock.t += 600; f.s.userTouches(); f.s.clock.t += 300; // the user touches something 300 ms ago
  const user = f.okc("userIdle");
  assert.deepEqual([user.own, user.idleMs], [false, 300]);
  f.s.clock.t += 5000;
  assert.equal(f.okc("userIdle").idleMs, 5300);
});

test("after Noah's own click, however long it took, the latest input still counts as Noah's, not the user's", () => {
  const f = fresh();
  f.s.clickCost = 900; // a slow double click
  f.okc("click", { window: f.NOTES, x: 400, y: 300, double: true });
  const idle = f.okc("userIdle");
  assert.deepEqual([idle.own, idle.idleMs], [true, 3_600_000]);
  f.s.clock.t += 400;
  assert.equal(f.okc("userIdle").own, true);
});

test("input the system registers a moment AFTER Noah sent it is still Noah's, not the user's", () => {
  const f = fresh();
  f.s.eventLag = 120; // macOS notes the event a little after Noah posted it
  assert.equal(f.okc("type", { window: f.NOTES, text: "hello there, friend" }).typed, 19, "typing is not stopped by its own echo");
  assert.equal(f.okc("userIdle").own, true);
  f.okc("click", { window: f.NOTES, x: 400, y: 300 });
  assert.equal(f.okc("userIdle").own, true, "nor is a click");
  assert.equal(f.okc("scroll", { window: f.NOTES, clicks: -4 }).scrolled, -4, "nor a scroll");
  f.okc("key", { window: f.NOTES, combo: "cmd+s" });
  f.okc("key", { window: f.NOTES, combo: "cmd+c" });
});

test("typing right after the user was busy and then still does not trip over input from BEFORE Noah started", () => {
  const f = fresh();
  f.okc("click", { window: f.NOTES, x: 400, y: 300 });
  f.s.clock.t += 20_000; f.s.userTouches(); // the user did something 10 s ago ...
  f.s.clock.t += 10_000; // ... and has been still since
  assert.equal(f.okc("type", { window: f.NOTES, text: "abc" }).typed, 3);
  f.s.clock.t += 20_000; f.s.userTouches(); f.s.clock.t += 10_000;
  assert.equal(f.okc("scroll", { window: f.NOTES, clicks: -2 }).scrolled, -2, "and so does scrolling");
  f.s.clock.t += 20_000; f.s.userTouches(); f.s.clock.t += 10_000;
  assert.deepEqual(f.okc("key", { window: f.NOTES, combo: "cmd+s" }), { pressed: "cmd+s" }, "and so does a key");
});

test("typing: each character is sent only if the window is in front and the user has not touched anything; the message says how far it got", () => {
  const f = fresh();
  const r = f.okc("type", { window: f.NOTES, text: "Hello" });
  assert.equal(r.typed, 5);
  assert.deepEqual(logOf(f.s, "keystroke").map((l) => l[1]), ["H", "e", "l", "l", "o"]);
  // the user types after the 5th character
  const g = fresh();
  g.s.afterKey = (n) => { if (n === 5) g.s.userIn(300); };
  const e = g.bad("type", { window: g.NOTES, text: "x".repeat(40) }, "user_busy");
  assert.match(e.error, /you started using the computer, so Noah stopped/);
  assert.match(e.error, /\(5 of 40 characters had already been typed\)/);
  assert.equal(logOf(g.s, "keystroke").length, 5, "nothing more was typed once the user came in");
  // the window loses the front
  const h = fresh();
  h.s.afterKey = (n) => { if (n === 3) h.s.front = { pid: 200, ref: "winSafari" }; };
  const w = h.bad("type", { window: h.NOTES, text: "abcdefgh" }, "not_foreground");
  assert.match(w.error, /the window is not in front/);
  assert.match(w.error, /\(3 of 8 characters had already been typed\)/);
});

test("Noah's own keystrokes are never mistaken for the user's, however long the text or slow the keys", () => {
  const f = fresh();
  f.s.keyCost = 190; // the slowest a key can be and still be inside the slack
  const text = "The quick brown fox jumps over the lazy dog. ".repeat(6);
  const r = f.okc("type", { window: f.NOTES, text });
  assert.equal(r.typed, text.length);
  const g = fresh();
  g.s.keyCost = 5;
  assert.equal(g.okc("type", { window: g.NOTES, text }).typed, text.length);
  assert.ok(OWN_SLACK_MS >= 100 && OWN_SLACK_MS <= 500, "slack is small enough to notice a person, big enough for jitter");
});

test("newline and tab are the Return and Tab keys, a carriage return is dropped, and the text may be any characters", () => {
  const f = fresh();
  f.okc("type", { window: f.NOTES, text: "a\nb\tc\ré中" });
  assert.deepEqual(f.s.log.filter((l) => l[0] !== "raise").map((l) => l[0] + ":" + l[1]), ["keystroke:a", "keyCode:36", "keystroke:b", "keyCode:48", "keystroke:c", "keystroke:é", "keystroke:中"]);
  assert.equal(f.okc("type", { window: f.NOTES, text: "" }).typed, 0);
});

test("typing into a password field is refused, before and during typing, and into a control by id focuses it first", () => {
  const f = fresh();
  const t = f.okc("tree", { window: f.NOTES });
  f.bad("type", { window: f.NOTES, text: "x", element: t.nodes.find((n) => n.name === "Secret").element }, "password_field");
  assert.equal(logOf(f.s, "keystroke").length, 0);
  f.s.focusedElement = { subrole: "AXSecureTextField", role: "AXTextField" };
  f.bad("type", { window: f.NOTES, text: "hunter2" }, "password_field");
  assert.equal(logOf(f.s, "keystroke").length, 0, "the cursor is already in a password field");
  const g = fresh();
  g.s.afterKey = (n) => { if (n === 7) g.s.focusedElement = { subrole: "AXSecureTextField", role: "AXTextField" }; }; // the cursor moves into one mid-text
  const e = g.bad("type", { window: g.NOTES, text: "x".repeat(60) }, "password_field");
  assert.match(e.error, /had already been typed/);
  assert.ok(logOf(g.s, "keystroke").length < 25, "caught within a few characters");
  const h = fresh();
  const tt = h.okc("tree", { window: h.NOTES });
  const body = tt.nodes.find((n) => n.name === "Body").element;
  h.okc("type", { window: h.NOTES, text: "ok", element: body });
  assert.equal(logOf(h.s, "focus").length, 1);
});

test("typing brings the window forward first", () => {
  const f = fresh();
  f.s.front = { pid: 200, ref: "winSafari" };
  assert.equal(f.okc("type", { window: f.NOTES, text: "hi" }).typed, 2);
  assert.equal(logOf(f.s, "raise").length >= 1, true);
});

test("a key combination: modifiers and keys are mapped, a bad one is refused, the window must be in front, the user must be still", () => {
  assert.deepEqual(parseCombo("cmd+shift+s"), { mods: ["command down", "shift down"], char: "s" });
  assert.deepEqual(parseCombo("Command + Option + Escape"), { mods: ["command down", "option down"], code: 53 });
  assert.deepEqual(parseCombo("ctrl+alt+x"), { mods: ["control down", "option down"], char: "x" });
  assert.deepEqual(parseCombo("enter"), { mods: [], code: 36 });
  assert.deepEqual(parseCombo("cmd+cmd+a"), { mods: ["command down"], char: "a" });
  for (const bad of ["", "   ", "cmd+", "cmd+shift", "wibble+s", "cmd+nonsense", null, undefined]) assert.throws(() => parseCombo(bad), (e) => e instanceof HostError && e.code === "bad_key", String(bad));
  const f = fresh();
  assert.deepEqual(f.okc("key", { window: f.NOTES, combo: "cmd+s" }), { pressed: "cmd+s" });
  assert.deepEqual(logOf(f.s, "keystroke")[0].slice(1), ["s", ["command down"]]);
  f.okc("key", { window: f.NOTES, combo: "enter" });
  assert.deepEqual(logOf(f.s, "keyCode")[0].slice(1), [36, []]);
  f.bad("key", { window: f.NOTES, combo: "cmd+wibble" }, "bad_key");
  f.s.front = { pid: 200, ref: "winSafari" };
  f.bad("key", { window: f.NOTES, combo: "cmd+s" }, "not_foreground");
  const g = fresh();
  g.okc("key", { window: g.NOTES, combo: "cmd+a" });
  g.s.clock.t += 600; g.s.userTouches(); g.s.clock.t += 300; // the user touched something 0.3 s ago
  const busy = g.bad("key", { window: g.NOTES, combo: "cmd+c" }, "user_busy");
  assert.match(busy.error, /you are using the computer/);
  assert.equal(logOf(g.s, "keystroke").length, 1, "the second key was not pressed");
  g.s.clock.t += 2000; // ... and has been still for two seconds
  g.okc("key", { window: g.NOTES, combo: "cmd+c" });
});

test("scrolling: the window must be in front, the amount is limited, the pointer goes to its middle, and the user stops it", () => {
  const f = fresh();
  assert.equal(f.okc("scroll", { window: f.NOTES, clicks: -3 }).scrolled, -3);
  assert.deepEqual(logOf(f.s, "scroll").map((l) => l[1]), [-1, -1, -1]);
  assert.deepEqual(logOf(f.s, "move")[0].slice(1), [400, 300]);
  assert.equal(f.okc("scroll", { window: f.NOTES, clicks: 500 }).scrolled, 40);
  assert.equal(f.okc("scroll", { window: f.NOTES, clicks: -500 }).scrolled, -40);
  assert.equal(f.okc("scroll", { window: f.NOTES, clicks: "x" }).scrolled, 0);
  const g = fresh();
  const orig = g.api.scrollWheel;
  let n = 0;
  g.api.scrollWheel = (dy) => { orig(dy); if (++n === 2) g.s.userIn(500); };
  g.bad("scroll", { window: g.NOTES, clicks: -10 }, "user_busy");
  assert.equal(n, 2, "stopped as soon as the user came in");
  const h = fresh();
  h.s.front = { pid: 200, ref: "winSafari" };
  h.bad("scroll", { window: h.NOTES }, "not_foreground");
  const k = fresh();
  const wheel = k.api.scrollWheel;
  let ticks = 0;
  k.api.scrollWheel = (dy) => { wheel(dy); if (++ticks === 2) k.s.front = { pid: 200, ref: "winSafari" }; };
  k.bad("scroll", { window: k.NOTES, clicks: -10 }, "not_foreground");
  assert.equal(ticks, 2, "stopped when the window lost the front");
});

// ------------------------------------------------------------------------------------------------ the rest
test("setText fills a field directly; a password field and a field that cannot be filled are refused", () => {
  const f = fresh();
  const t = f.okc("tree", { window: f.NOTES });
  const body = t.nodes.find((n) => n.name === "Body").element;
  const r = f.okc("setText", { element: body, text: "new words" });
  assert.deepEqual([r.method, r.now], ["value", "new words"]);
  f.bad("setText", { element: t.nodes.find((n) => n.name === "Secret").element, text: "x" }, "password_field");
  const icon = t.nodes.find((n) => n.name === "New Note").element;
  f.bad("setText", { element: icon, text: "x" }, "not_settable");
});

test("a screenshot needs Screen Recording permission, measures the window, and reports the scale and where the picture sits on the screen", () => {
  const f = fresh();
  const r = f.okc("screenshot", { window: f.NOTES });
  assert.deepEqual([r.mime, r.x, r.y, r.sourceWidth, r.sourceHeight, r.grid, r.marks], ["image/png", 100, 100, 1200, 800, false, false]);
  assert.equal(r.width, 1200);
  assert.equal(r.scale, 2, "the picture is twice the window's size in points (a Retina screen)");
  const small = f.okc("screenshot", { window: f.NOTES, maxWidth: 600 });
  assert.equal(small.width, 600);
  assert.equal(small.scale, 1);
  assert.equal(f.okc("screenshot", { window: f.NOTES, maxWidth: 99999 }).width, 1200, "capped at 3000, and never larger than the window");
  assert.equal(f.okc("screenshot", { window: f.NOTES, maxWidth: 10 }).width, 200, "at least 200 wide");
  f.s.screen = false;
  const denied = f.bad("screenshot", { window: f.NOTES }, "screen_recording_denied");
  assert.match(denied.error, /Screen Recording/);
  f.s.screen = true;
  f.s.wins[100][0].rect = { x: 0, y: 0, w: 0, h: 0 };
  f.bad("screenshot", { window: f.NOTES }, "no_window");
});

test("closing a window, launching an app, the list of apps, the pointer, and waiting for a window", () => {
  const f = fresh();
  assert.equal(f.okc("close", { window: windowNumber(200, "News", 0) }).closed, true);
  f.s.wins[100][0].closable = false;
  f.bad("close", { window: f.NOTES }, "not_closable");
  assert.deepEqual(f.okc("launch", { appId: "/Applications/Notes.app" }), { started: true, pid: 4242 });
  assert.deepEqual(f.okc("launch", { file: "/Users/me/doc.pdf" }), { started: true, pid: 4242 });
  f.bad("launch", {}, "bad_arguments");
  assert.deepEqual(f.okc("cursor"), { x: 5, y: 5 });
  assert.equal(f.okc("apps")[0].name, "Notes");
  assert.equal(f.okc("waitWindow", { title: "note" }).title, "Note 1");
  assert.equal(f.okc("waitWindow", { process: "safari" }).process, "Safari");
  const t0 = f.s.clock.t;
  f.bad("waitWindow", { title: "never", waitMs: 1000 }, "timeout");
  assert.ok(f.s.clock.t - t0 >= 1000 && f.s.clock.t - t0 < 2500, "waited about as long as asked, no longer");
  let arrives = 0;
  f.s.onSleep = () => { if (++arrives === 3) f.s.wins[100].push({ ref: "winNew", title: "Brand new", minimized: false, rect: { x: 0, y: 0, w: 100, h: 100 }, closable: true }); f.s.nodes.winNew = { info: { role: "AXWindow" }, children: [] }; };
  assert.equal(f.okc("waitWindow", { title: "brand new", waitMs: 5000 }).title, "Brand new", "a window that appears while waiting is found");
});

// ------------------------------------------------------------------------------------------------ small pure helpers
test("roles map to the Windows helper's names; unknown roles get a sensible one", () => {
  const cases = { AXButton: "Button", AXTextField: "Edit", AXTextArea: "Edit", AXStaticText: "Text", AXCheckBox: "CheckBox", AXRow: "ListItem", AXWebArea: "Document", AXLink: "Hyperlink", AXPopUpButton: "ComboBox", AXWindow: "Window", AXWeirdThing: "WeirdThing", "": "Custom", undefined: "Custom" };
  for (const [role, want] of Object.entries(cases)) assert.equal(roleName(role === "undefined" ? undefined : role), want, role);
});

test("accessibility points and sizes are read from their text form", () => {
  assert.deepEqual(parsePoint("<AXValue 0x6000 {value = x:100.500000 y:-20.000000 type = kAXValueCGPointType}>"), { x: 100.5, y: -20 });
  assert.deepEqual(parseSize("<AXValue 0x6000 {value = w:80.000000 h:24.000000 type = kAXValueCGSizeType}>"), { w: 80, h: 24 });
  for (const junk of ["", null, undefined, "nothing here", "x:1"]) { assert.equal(parsePoint(junk), null, String(junk)); assert.equal(parseSize(junk), null, String(junk)); }
});

test("a reply line is plain ASCII, whatever the text", () => {
  const line = asciiJson({ name: "café 中文 😀", plain: "abc" });
  assert.ok(/^[\x20-\x7e]*$/.test(line), line);
  assert.deepEqual(JSON.parse(line), { name: "café 中文 😀", plain: "abc" });
});

// ------------------------------------------------------------------------------------------------ the file itself
test("host-mac.js is valid JavaScript, plain ASCII (osascript reads it as the system's encoding), and starts itself only when run by osascript", () => {
  const file = path.join(__dirname, "..", "..", "desktop", "host-mac.js");
  const src = fs.readFileSync(file, "utf8");
  assert.doesNotThrow(() => new vm.Script(src, { filename: file }), "it compiles");
  const odd = [...src].filter((c) => c.charCodeAt(0) > 126 || (c.charCodeAt(0) < 32 && c !== "\n" && c !== "\r" && c !== "\t"));
  assert.deepEqual(odd, [], "no character outside printable ASCII");
  assert.match(src, /typeof module !== "undefined" && module\.exports/);
  assert.match(src, /else \{\s*main\(\);/, "under osascript (no `module`) it runs");
  for (const op of ["ping", "windows", "tree", "interactive", "elementAt", "userIdle", "screenshot", "focus", "click", "scroll", "setText", "type", "key", "launch", "close", "cursor", "waitWindow", "apps"]) assert.ok(createHost(makeMac().api).ops[op], `the Windows helper's '${op}' exists on a Mac too`);
});

test("every operation the Windows helper offers to the bridge exists on the Mac helper", () => {
  const bridgeOps = [...fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "bridge.cjs"), "utf8").matchAll(/this\.call\("(\w+)"/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i);
  assert.ok(bridgeOps.length >= 15, bridgeOps.join());
  const host = createHost(makeMac().api);
  for (const op of bridgeOps) assert.ok(typeof host.ops[op] === "function", `bridge calls '${op}': the Mac helper must answer it`);
});

// ------------------------------------------------------------------------------------------------ the bridge, on a Mac
function fakeSpawn() {
  const spawns = [];
  const impl = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.stdin = { written: [], write(d) { this.written.push(d); const req = JSON.parse(d); setImmediate(() => child.stdout.emit("data", JSON.stringify({ id: req.id, ok: true, result: { echoed: req.op, args: req.args } }) + "\n")); }, end() {} };
    child.killed = []; child.kill = (sig) => { child.killed.push(sig); setImmediate(() => child.emit("exit", null)); };
    child.pid = 321;
    spawns.push({ cmd, args, opts, child });
    setImmediate(() => child.stdout.emit("data", JSON.stringify({ ready: true }) + "\n"));
    return child;
  };
  return { impl, spawns };
}

test("on a Mac the bridge runs osascript on host-mac.js, with none of Jonah's secrets in its environment", async () => {
  const { impl, spawns } = fakeSpawn();
  const saved = { ...process.env };
  Object.assign(process.env, { PATH: "/usr/bin", HOME: "/Users/me", JONAH_PROXY_KEY: "secret-1", OPENAI_API_KEY: "secret-2", GOOGLE_API_KEY: "secret-3", LANG: "en_US.UTF-8", TMPDIR: "/tmp/x" });
  try {
    const b = new DesktopBridge({ spawnImpl: impl, platform: "darwin" });
    const r = await b.userIdle();
    assert.equal(r.echoed, "userIdle");
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].cmd, "/usr/bin/osascript");
    assert.deepEqual(spawns[0].args.slice(0, 2), ["-l", "JavaScript"]);
    assert.equal(path.basename(spawns[0].args[2]), "host-mac.js");
    const env = spawns[0].opts.env;
    const allowed = new Set(["path", "home", "tmpdir", "user", "logname", "lang", "lc_all", "lc_ctype", "shell", "tz", "__cf_user_text_encoding"]);
    assert.ok(["HOME", "LANG", "PATH", "TMPDIR"].every((k) => k in env), "what an app needs is there");
    assert.deepEqual(Object.keys(env).filter((k) => !allowed.has(k.toLowerCase())), [], "and nothing else");
    assert.doesNotMatch(JSON.stringify(env), /secret-/);
    await b.interactive(5, { maxNodes: 50, budgetMs: 2500 });
    await b.elementAt(10, 20);
    assert.deepEqual(JSON.parse(spawns[0].child.stdin.written.at(-1)).args, { x: 10, y: 20, timeoutMs: 20000 });
    b.stop();
    assert.deepEqual(spawns[0].child.killed, ["SIGKILL"], "Stop kills the helper at once (no taskkill on a Mac)");
    assert.equal(b.running, false);
    await b.ping();
    assert.equal(spawns.length, 2, "it starts fresh on the next call");
    b.dispose();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("the environment for each system keeps what its programs need and nothing of Jonah's", () => {
  const src = { PATH: "p", HOME: "h", JONAH_X: "1", ANTHROPIC_API_KEY: "k", TMPDIR: "t", USER: "u", LOGNAME: "l", SHELL: "/bin/zsh", __CF_USER_TEXT_ENCODING: "0x1F5:0:0", ComSpec: "c", SystemRoot: "r" };
  assert.deepEqual(Object.keys(hostEnv(src, "darwin")).sort(), ["HOME", "LOGNAME", "PATH", "SHELL", "TMPDIR", "USER", "__CF_USER_TEXT_ENCODING"]);
  const win = hostEnv(src, "win32");
  assert.ok(win.ComSpec && win.SystemRoot && win.PATH && !win.JONAH_X && !win.ANTHROPIC_API_KEY);
});

test("the bridge refuses systems it was not built for, and picks the Mac helper by platform", async () => {
  const b = new DesktopBridge({ platform: "linux", spawnImpl: () => { throw new Error("must not start"); } });
  await assert.rejects(() => b.ping(), (e) => e.code === "unsupported" && /Windows and macOS/.test(e.message));
  assert.equal(path.basename(new DesktopBridge({ platform: "darwin" }).hostPath), "host-mac.js");
  assert.equal(path.basename(new DesktopBridge({ platform: "win32" }).hostPath), "host.ps1");
});

// ------------------------------------------------------------------------------------------------ permissions
test("on a Mac the Accessibility permission is checked before a task, the prompt is shown once, and the user is told where to switch it on", () => {
  const asked = [];
  const sp = { isTrustedAccessibilityClient: (prompt) => { asked.push(prompt); return false; } };
  const logs = [];
  const check = createPermissionCheck({ systemPreferences: sp, platform: "darwin", log: (m) => logs.push(m) });
  const r = check();
  assert.equal(r.ok, false);
  assert.equal(r.reply, ACCESSIBILITY_REPLY);
  assert.match(r.reply, /System Settings \(System Preferences on older Macs\) > Privacy & Security \(Security & Privacy\) > Accessibility/, "both names: Monterey says System Preferences");
  assert.match(r.reply, /press the minus \(-\) button to remove it/, "the stale-permission remedy (the tick of an older Jonah build)");
  assert.match(r.reply, /Screen Recording/);
  assert.deepEqual(asked, [false, true], "first a silent check, then macOS's own prompt");
  assert.ok(logs.length === 1);
  const granted = createPermissionCheck({ systemPreferences: { isTrustedAccessibilityClient: (p) => { asked.push(p); return true; } }, platform: "darwin" });
  asked.length = 0;
  assert.deepEqual(granted(), { ok: true });
  assert.deepEqual(asked, [false], "no prompt when it is already granted");
});

test("the permission check never blocks a task by mistake: Windows, a missing API, or an error all say yes", () => {
  assert.deepEqual(createPermissionCheck({ platform: "win32" })(), { ok: true });
  assert.deepEqual(createPermissionCheck({ systemPreferences: undefined, platform: "darwin" })(), { ok: true });
  assert.deepEqual(createPermissionCheck({ systemPreferences: {}, platform: "darwin" })(), { ok: true });
  const logs = [];
  assert.deepEqual(createPermissionCheck({ systemPreferences: { isTrustedAccessibilityClient: () => { throw new Error("boom"); } }, platform: "darwin", log: (m) => logs.push(m) })(), { ok: true });
  assert.match(logs[0], /could not check permissions: boom/);
  const promptFails = createPermissionCheck({ systemPreferences: { isTrustedAccessibilityClient: (p) => { if (p) throw new Error("no prompt"); return false; } }, platform: "darwin" });
  assert.equal(promptFails().ok, false, "a prompt that cannot be shown does not hide that the permission is missing");
});

test("Screen Recording: when it is not allowed yet the user is told ONCE (it does not stop the task), and macOS is asked to show its prompt so Jonah appears in the list", async () => {
  const asked = [];
  const sp = (status) => ({ isTrustedAccessibilityClient: () => true, getMediaAccessStatus: (k) => { assert.equal(k, "screen"); return status; } });
  // never asked before: the prompt is requested, and the notice says allow it
  const fresh = createPermissionCheck({ platform: "darwin", systemPreferences: sp("not-determined"), requestScreen: () => { asked.push(1); return Promise.resolve([]); } });
  const first = fresh();
  assert.equal(first.ok, true);
  assert.equal(asked.length, 1, "trying to capture the screen is what makes macOS list Jonah");
  assert.match(first.notice, /Screen Recording permission/);
  assert.match(first.notice, /I have asked macOS to show its prompt/);
  assert.deepEqual(fresh(), { ok: true }, "said once per run, not at every task");
  assert.equal(asked.length, 1);
  // refused or stale: macOS will not ask again, so the notice says where to go and how to reset the entry
  const denied = createPermissionCheck({ platform: "darwin", systemPreferences: sp("denied"), requestScreen: () => { asked.push(2); } });
  const d = denied();
  assert.equal(d.ok, true);
  assert.match(d.notice, /System Settings \(System Preferences on older Macs\)/);
  assert.match(d.notice, /Screen Recording \(it is further down the list/);
  assert.match(d.notice, /minus \(-\) button/);
  assert.equal(asked.length, 1, "no pointless request when macOS will not show a prompt");
  assert.equal(d.notice, screenNotice("denied"));
  // allowed, or not knowable: no notice
  assert.deepEqual(createPermissionCheck({ platform: "darwin", systemPreferences: sp("granted") })(), { ok: true });
  assert.deepEqual(createPermissionCheck({ platform: "darwin", systemPreferences: { isTrustedAccessibilityClient: () => true } })(), { ok: true });
  assert.deepEqual(createPermissionCheck({ platform: "darwin", systemPreferences: { isTrustedAccessibilityClient: () => true, getMediaAccessStatus: () => { throw new Error("x"); } } })(), { ok: true });
  // a request that fails, or rejects, never breaks the check
  for (const requestScreen of [() => { throw new Error("no"); }, () => Promise.reject(new Error("no"))]) {
    const c = createPermissionCheck({ platform: "darwin", systemPreferences: sp("not-determined"), requestScreen });
    assert.equal(c().ok, true);
  }
  await new Promise((r) => setImmediate(r)); // (a rejected request must not become an unhandled rejection)
  // Accessibility still comes first, and Windows is unchanged
  const noAccess = createPermissionCheck({ platform: "darwin", systemPreferences: { isTrustedAccessibilityClient: () => false, getMediaAccessStatus: () => "not-determined" }, requestScreen: () => asked.push(3) });
  assert.equal(noAccess().ok, false);
  assert.equal(asked.length, 1, "no Screen Recording request before Accessibility is sorted");
  assert.deepEqual(createPermissionCheck({ platform: "win32", systemPreferences: sp("denied") })(), { ok: true });
});

// ------------------------------------------------------------------------------------------------ reading what macOS hands back (found on a real Mac)
const { unwrapAny, listOf, asBool } = mac;
const arrayLike = (items) => ({ count: items.length, objectAtIndex: (i) => items[i] });
/** What JXA gave on the real Mac for the windows of an app: a bare reference with no .count at all; only after a cast does it behave like an array. */
const bareRef = (items) => ({ __bare: true, items });
const objcWith = (over = {}) => ({ unwrap: (v) => (v && v.__str !== undefined ? v.__str : v), castRefToObject: (v) => { if (!v || !v.__bare) throw new Error("not a reference"); return arrayLike(v.items); }, ...over });

test("a list macOS returns as a bare reference (no .count: the real Mac's \"0 windows\") is read after casting it; ordinary arrays still read as before", () => {
  const items = ["w1", "w2", "w3"];
  const objc = objcWith();
  assert.deepEqual(listOf(arrayLike(items), objc), items, "an ordinary array proxy, as for the running applications");
  assert.deepEqual(listOf(bareRef(items), objc), items, "a bare reference: the case that was read as an empty list");
  assert.equal(Number(bareRef(items).count), NaN, "(this is why: Number(undefined) is NaN, and a loop up to NaN never runs)");
  assert.deepEqual(listOf(bareRef([]), objc), [], "and a genuinely empty list is empty");
});

test("a count that is nonsense on the bare reference does not hide the real list behind it; and the JXA layer really reads lists and values through these readers", () => {
  assert.deepEqual(listOf({ count: -1, __bare: true, items: ["q"] }, objcWith()), ["q"], "a negative count is skipped, the cast is tried");
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "host-mac.js"), "utf8");
  assert.ok(src.includes("const arrayOf = (list) => listOf(list, ObjC);"), "every list from macOS goes through listOf");
  assert.ok(src.includes("const unwrap = (o) => unwrapAny(o, ObjC);"), "and every value through unwrapAny");
  const actionLine = src.split("\n").find((l) => l.includes("const actionNames = (el) =>")) || "";
  assert.ok(actionLine.includes("arrayOf(r[0])"), "the action names too (they came back bare as well)");
});

test("a count that is a METHOD instead of a property, a getter that throws, and an item that cannot be read are all survived", () => {
  const items = ["a", "b"];
  assert.deepEqual(listOf({ count: () => 2, objectAtIndex: (i) => items[i] }, objcWith()), items, "count()");
  const castObj = { __bare: true, items };
  assert.deepEqual(listOf(castObj, objcWith({ castRefToObject: () => ({ count: () => 2, objectAtIndex: (i) => items[i] }) })), items, "count() after the cast");
  const thrower = { get count() { throw new Error("no"); }, __bare: true, items };
  assert.deepEqual(listOf(thrower, objcWith()), items, "a throwing count falls through to the cast");
  assert.deepEqual(listOf({ count: 3, objectAtIndex: (i) => { if (i === 1) throw new Error("bad item"); return ["x", "y", "z"][i]; } }, objcWith()), ["x", "z"], "the unreadable item is skipped");
});

test("when nothing can be counted, an array the bridge can unwrap is used; otherwise the list is empty (never a throw)", () => {
  const plain = { __bare: true, items: [] };
  assert.deepEqual(listOf(plain, { unwrap: () => ["u1", "u2"], castRefToObject: () => { throw new Error("no"); } }), ["u1", "u2"]);
  assert.deepEqual(listOf(plain, { unwrap: () => "not an array", castRefToObject: () => { throw new Error("no"); } }), []);
  assert.deepEqual(listOf(plain, { unwrap: () => { throw new Error("no"); }, castRefToObject: () => { throw new Error("no"); } }), []);
  for (const v of [undefined, null]) assert.deepEqual(listOf(v, objcWith()), []);
  assert.deepEqual(listOf({ count: -1 }, { unwrap: () => null, castRefToObject: () => { throw new Error("no"); } }), [], "a negative count is nonsense");
  assert.deepEqual(listOf({ count: "many" }, { unwrap: () => null, castRefToObject: () => { throw new Error("no"); } }), []);
});

test("a value macOS returns as a bare reference (a title, a role) is read after casting it; plain values pass through; failures give undefined", () => {
  const objc = { unwrap: (v) => (v && v.kind === "string" ? "Hello" : v && v.kind === "bare" ? { wrapper: true } : v && v.__cast ? "from the cast" : v), castRefToObject: (v) => { if (v.kind === "bare") return { __cast: true }; throw new Error("no"); } };
  assert.equal(unwrapAny({ kind: "string" }, objc), "Hello");
  assert.equal(unwrapAny({ kind: "bare" }, objc), "from the cast", "unwrap gave only the wrapper object: it is cast and unwrapped again");
  assert.equal(unwrapAny(7, { unwrap: (v) => v, castRefToObject: () => { throw new Error("no"); } }), 7);
  assert.equal(unwrapAny(false, { unwrap: (v) => v, castRefToObject: () => { throw new Error("no"); } }), false, "false is a value, not 'nothing'");
  assert.equal(unwrapAny(undefined, objc), undefined);
  assert.equal(unwrapAny(null, objc), undefined);
  assert.equal(unwrapAny({ x: 1 }, { unwrap: () => { throw new Error("no"); }, castRefToObject: () => { throw new Error("no"); } }), undefined);
});

test("a yes/no from macOS may come as true/false or 1/0; anything else is 'unknown', never a guess", () => {
  assert.deepEqual([true, 1, false, 0, undefined, null, "yes", 2, {}].map(asBool), [true, true, false, false, undefined, undefined, undefined, undefined, undefined]);
});

// The exact shapes the second real-Mac diagnostic showed (macOS 12.7.6, Intel): the value of an out-parameter is a FUNCTION object; unwrap() of it returns the function again;
// after ObjC.castRefToObject it behaves like an NSArray whose count is a number-like STRING ("1"), and a title unwraps to text.
test("the real Mac's shapes: a function-shaped reference is cast, a count that is the string \"1\" is read, and a function is never handed on as a value", () => {
  const fnRef = (payload) => { const f = function () {}; f.payload = payload; return f; };
  const objc = {
    unwrap: (v) => (typeof v === "function" ? v : v && v.text !== undefined ? v.text : v), // a bare reference unwraps to itself, a cast string to text
    castRefToObject: (v) => { if (typeof v !== "function") throw new Error("not a reference"); const p = v.payload; return Array.isArray(p) ? { count: String(p.length), objectAtIndex: (i) => p[i] } : { text: p }; },
  };
  const windows = listOf(fnRef(["window one", "window two"]), objc);
  assert.deepEqual(windows, ["window one", "window two"], "two windows, read after the cast, from a count that arrives as a string");
  assert.deepEqual(listOf(fnRef(["only"]), objc), ["only"], "the count \"1\" of the real Finder, Terminal and Chrome windows");
  assert.equal(unwrapAny(fnRef("Untitled - Notes"), objc), "Untitled - Notes", "a title: unwrap alone gives a function; the cast gives the text");
  assert.equal(unwrapAny(fnRef("AXWindow"), objc), "AXWindow");
  const uncastable = { unwrap: (v) => v, castRefToObject: () => { throw new Error("no"); } };
  assert.equal(unwrapAny(fnRef("x"), uncastable), undefined, "a function that cannot be cast is NOTHING, not a value");
});

test("a plain number or yes/no is taken as it is (not re-read through a cast); and every reference from the accessibility API is cast once, at the door", () => {
  const objc = { unwrap: (v) => v, castRefToObject: () => ({ text: "from the cast" }) };
  assert.equal(unwrapAny(7, objc), 7);
  assert.equal(unwrapAny(true, objc), true);
  assert.equal(unwrapAny("text", objc), "text");
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "host-mac.js"), "utf8");
  const attrLine = src.split("\n").find((l) => l.includes("const attr = (el, name) =>")) || "";
  assert.ok(attrLine.includes("e === 0 && r[0] !== undefined && r[0] !== null ? asObject(r[0]) : undefined"), "attr() casts what it gets back, and says 'nothing' when there is nothing");
  assert.ok(src.includes("const asObject = (v) => { try { return ObjC.castRefToObject(v); } catch (_) { return v; } };"), "the cast never throws");
});

test("window references are compared through a helper that cannot throw (a failing comparison is 'not the same window', never an error that breaks the window list)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "host-mac.js"), "utf8");
  const uses = src.split("\n").filter((l) => l.includes("$.CFEqual("));
  assert.equal(uses.length, 1, "CFEqual is called in exactly one place");
  assert.ok(uses[0].includes("const same = (a, b) => { try {") && uses[0].includes("catch (_) { return false; }"), "and that place is the guarded helper");
  assert.ok(src.includes("focused: attrBool(w, \"AXMain\") || same(focused, w)"));
  assert.ok(src.includes("return same(fw, ref);"));
});

// ------------------------------------------------------------------------------------------------ found by the user's Terminal run of the real helper (macOS 12.7.6): WhatsApp's name starts with an invisible mark
test("a program whose name starts with an invisible mark (WhatsApp is '<LRM>WhatsApp' on a real Mac) is found by its plain name", () => {
  assert.equal(cleanName("\u200eWhatsApp"), "WhatsApp");
  assert.equal(cleanName("a\u200b b\u202ec\ufeff"), "a bc");
  assert.equal(cleanName(null), "");
  const f = fresh();
  f.s.apps.push({ pid: 300, name: "\u200eWhatsApp", path: "/Applications/WhatsApp.app", bundleId: "net.whatsapp.WhatsApp", hidden: false });
  f.s.wins[300] = [{ ref: "winWa", title: "\u200eWhatsApp", minimized: false, rect: { x: 208, y: 30, w: 1024, h: 796 }, closable: true }];
  const w = f.okc("windows").find((x) => x.pid === 300);
  assert.equal(w.process, "WhatsApp", "the program name has no invisible mark");
  assert.equal(w.title, "WhatsApp");
  const hit = f.okc("waitWindow", { process: "whatsapp", waitMs: 1000 });
  assert.equal(hit.pid, 300);
});

test("waiting for a window by part of the program's name works ('chrome' finds 'Google Chrome'), as the model says it that way", () => {
  const f = fresh();
  f.s.apps.push({ pid: 400, name: "Google Chrome", path: "/Applications/Google Chrome.app", bundleId: "com.google.Chrome", hidden: false });
  f.s.wins[400] = [{ ref: "winChrome", title: "New Tab - Google Chrome", minimized: false, rect: { x: 0, y: 25, w: 801, h: 663 }, closable: true }];
  for (const args of [{ process: "chrome" }, { process: "Google Chrome" }, { title: "new tab", process: "chrome" }, { title: "Google Chrome" }]) {
    assert.equal(f.okc("waitWindow", { ...args, waitMs: 1000 }).pid, 400, JSON.stringify(args));
  }
  f.bad("waitWindow", { process: "chromium", waitMs: 800 }, "timeout");
});

test("Jonah's own windows do not prove that other apps' windows can be read; when only they can, the error says so and names the answer macOS gave", () => {
  const f = fresh();
  f.s.apps.push({ pid: 500, name: "Jonah", path: "/Applications/Jonah.app", bundleId: "live.jonah", hidden: false });
  f.s.wins[500] = [{ ref: "winJonah", title: "Jonah", minimized: false, rect: { x: 0, y: 0, w: 900, h: 700 }, closable: true }];
  const real = f.api.axWindows;
  f.api.axWindows = (pid) => (pid === 500 ? real(pid) : []); // only Jonah's own windows can be read
  f.api.axError = (pid) => (pid === 500 ? 0 : -25211);
  const r = f.bad("windows", {}, "accessibility_stale");
  assert.match(r.error, /macOS answered error -25211: Accessibility is not allowed for Jonah/);
  // Jonah's own window must not tip the balance: Notes hidden, Safari readable, Jonah readable = one other app readable against one hidden, which is still suspicious
  const h = fresh();
  h.s.apps.push({ pid: 500, name: "Jonah", path: "/Applications/Jonah.app", bundleId: "live.jonah", hidden: false });
  h.s.wins[500] = [{ ref: "winJonah", title: "Jonah", minimized: false, rect: { x: 0, y: 0, w: 900, h: 700 }, closable: true }];
  const realH = h.api.axWindows;
  h.api.axWindows = (pid) => (pid === 100 ? [] : realH(pid));
  h.bad("windows", {}, "accessibility_stale");
  // when most OTHER apps can be read the list is trusted again (a few odd apps may hide their windows)
  const g = fresh();
  g.s.apps.push({ pid: 500, name: "Jonah", path: "/Applications/Jonah.app", bundleId: "live.jonah", hidden: false }, { pid: 600, name: "Mail", path: "/Applications/Mail.app", bundleId: "com.apple.mail", hidden: false });
  g.s.wins[500] = [{ ref: "winJonah", title: "Jonah", minimized: false, rect: { x: 0, y: 0, w: 900, h: 700 }, closable: true }];
  g.s.wins[600] = [{ ref: "winMail", title: "Inbox", minimized: false, rect: { x: 50, y: 50, w: 800, h: 600 }, closable: true }];
  const realG = g.api.axWindows;
  g.api.axWindows = (pid) => (pid === 200 ? [] : realG(pid)); // Safari hidden; Notes and Mail readable
  assert.ok(g.okc("windows").some((w) => w.pid === 100) && g.okc("windows").some((w) => w.pid === 600));
});

test("the real layer keeps the answer code of the window-list question, and the source stays ASCII", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "host-mac.js"), "utf8");
  assert.ok(src.includes("axErrors[pid] = code;") && src.includes("axError: (pid) => axErrors[pid] || 0,"));
  assert.ok(!/[^\x00-\x7f]/.test(src), "no non-ASCII character in the helper");
});

test("every window scan leaves one line in the helper's log: what macOS answered for each app (inside Jonah's process nothing else can be seen), and a failing log never breaks the scan", () => {
  const f = fresh();
  const lines = [];
  f.api.debugLog = (l) => lines.push(l);
  f.api.axError = () => 0;
  f.okc("windows");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^windows: 3 found, ok; trusted=true screen=true; /);
  assert.match(lines[0], /Notes\(100\) ax=1 code=0 onscreen=1/);
  assert.match(lines[0], /Safari\(200\) ax=2 code=0 onscreen=2/);
  const g = fresh();
  const seen = [];
  g.api.debugLog = (l) => seen.push(l);
  g.api.axWindows = () => [];
  g.api.axError = () => -25211;
  g.bad("windows", {}, "accessibility_stale");
  assert.match(seen[seen.length - 1], /NOT TRUSTED \(2 app\(s\)/);
  assert.match(seen[seen.length - 1], /code=-25211/);
  const h = fresh();
  h.api.debugLog = () => { throw new Error("disk full"); };
  assert.equal(h.okc("windows").length, 3, "a log that throws does not break the scan");
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "host-mac.js"), "utf8");
  assert.ok(src.includes("/Library/Logs/Jonah-desktop-helper.log") && src.includes("} catch (_) { /* a log that cannot be written is not worth stopping for */ }"));
});
