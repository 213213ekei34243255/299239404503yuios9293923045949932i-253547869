// Noah/test/unit/desktop-launch-loop.test.cjs - the loop a real Mac test showed: "Looked at the open windows (0 windows)", "Opened Google Chrome", "no such window appeared in time",
// again and again, while the Mac heated up. The helper's window list was empty although Chrome was open (see desktop-mac-host.test.cjs for that half); this is the agent's half:
// it must not start the same app over and over, must not read every window of every app in a tight loop, and a desktop task that goes nowhere must give up sooner.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DesktopTools } = require("../../desktop/tools.cjs");
const { createMission, DEFAULT_LIMITS } = require("../../autonomy/mission-runner.cjs");

class Bridge {
  constructor() { this.wins = []; this.launches = []; this.windowCalls = 0; this.opens = {}; }
  async windows() { this.windowCalls++; return this.wins.map((w) => ({ ...w })); }
  async apps() { return [{ name: "Google Chrome", id: "/Applications/Google Chrome.app" }, { name: "Notes", id: "/System/Applications/Notes.app" }]; }
  async launch(a) { this.launches.push(a.appId); const w = this.opens[a.appId]; if (w) this.wins.push({ window: 900 + this.wins.length, title: w, process: w, path: "x", pid: 1, x: 0, y: 0, w: 500, h: 400, foreground: false, minimized: false }); return { started: true, pid: 5 }; }
  stop() {}
}
function make() {
  const bridge = new Bridge();
  const pauses = [];
  const t = new DesktopTools({ bridge, getMode: () => "autonomous", confirm: async () => true, pause: async (ms) => { pauses.push(ms); }, notify: () => {} });
  return { t, bridge, pauses };
}

test("a launch whose window never shows is looked for a few times with growing gaps (about 9 s), not 28 times in a row", async () => {
  const { t, bridge, pauses } = make();
  const r = await t.launch({ app: "Google Chrome" });
  assert.equal(r.ok, true);
  assert.match(r.note, /no window of it has appeared yet/);
  assert.deepEqual(pauses, [300, 500, 700, 900, 1200, 1500, 1800, 2000], "growing gaps");
  assert.equal(bridge.windowCalls, 1 + 8, "one look before and eight after: every look reads every app's windows");
  assert.ok(pauses.reduce((a, b) => a + b, 0) <= 9500);
});

test("a launch whose window shows up ends the search at once", async () => {
  const { t, bridge, pauses } = make();
  bridge.opens["/Applications/Google Chrome.app"] = "Google Chrome";
  const r = await t.launch({ app: "Google Chrome" });
  assert.equal(r.ok, true);
  assert.ok(r.window >= 900);
  assert.deepEqual(pauses, [300], "found at the first look");
});

test("the third start of an app whose window never showed up is refused, with what to tell the user: the loop ends instead of heating the computer", async () => {
  const { t, bridge } = make();
  assert.equal((await t.launch({ app: "Google Chrome" })).ok, true);
  assert.equal((await t.launch({ app: "Google Chrome" })).ok, true);
  const third = await t.launch({ app: "Google Chrome" });
  assert.equal(third.ok, false);
  assert.equal(third.code, "repeat_blocked");
  assert.match(third.message, /already started "Google Chrome" 2 times/);
  assert.match(third.message, /Do not start it again/);
  assert.match(third.message, /Jonah may not be allowed to read its windows/);
  assert.match(third.message, /remove Jonah from that list/);
  assert.equal(bridge.launches.length, 2, "the app was not started a third time");
});

test("the count is per app, and an app whose window does show up starts again from zero", async () => {
  const { t, bridge } = make();
  await t.launch({ app: "Google Chrome" });
  await t.launch({ app: "Google Chrome" });
  assert.equal((await t.launch({ app: "Notes" })).ok, true, "another app is not affected");
  bridge.opens["/Applications/Google Chrome.app"] = "Google Chrome";
  // after a success the misses are forgotten
  const t2 = make();
  await t2.t.launch({ app: "Google Chrome" });
  t2.bridge.opens["/Applications/Google Chrome.app"] = "Google Chrome";
  assert.equal((await t2.t.launch({ app: "Google Chrome" })).ok, true);
  t2.bridge.opens = {};
  t2.bridge.wins = [];
  assert.equal((await t2.t.launch({ app: "Google Chrome" })).ok, true, "one miss after a success");
  assert.equal((await t2.t.launch({ app: "Google Chrome" })).ok, true, "two misses");
  assert.equal((await t2.t.launch({ app: "Google Chrome" })).code, "repeat_blocked", "and the third is refused again");
});

test("starting an app that is ALREADY open is a success: its window is handed back, and it is looked for once (the user's Terminal run: Chrome was open with a 'New Tab' window, so 'no new window' was counted as a failure)", async () => {
  const { t, bridge, pauses } = make();
  bridge.wins.push({ window: 77, title: "New Tab - Google Chrome", process: "Google Chrome", path: "x", pid: 5, x: 0, y: 25, w: 801, h: 663, foreground: false, minimized: false });
  for (let i = 0; i < 4; i++) {
    const r = await t.launch({ app: "Google Chrome" });
    assert.equal(r.ok, true, "start " + i);
    assert.equal(r.window, 77, "its existing window");
    assert.match(r.note, /already open/);
  }
  assert.equal((await t.launch({ app: "Google Chrome" })).code, undefined, "never refused as a repeat: it was never failing");
  assert.equal(pauses.length, 5, "one look after each start, not eight");
});

test("a window with the app's name in its title or a part of its program name counts as that app's (a name with an invisible mark, 'chrome' for 'Google Chrome')", async () => {
  const { t, bridge } = make();
  bridge.wins.push({ window: 78, title: "x", process: "\u200eGoogle Chrome", path: "x", pid: 5, x: 0, y: 0, w: 500, h: 400, foreground: true, minimized: false });
  const r = await t.launch({ app: "Google Chrome" });
  assert.equal(r.window, 78);
  const other = make();
  other.bridge.wins.push({ window: 79, title: "Notes", process: "Notes", path: "x", pid: 6, x: 0, y: 0, w: 500, h: 400, foreground: false, minimized: false });
  const miss = await other.t.launch({ app: "Google Chrome" });
  assert.match(miss.note, /no window of it has appeared yet/, "another app's window is not Chrome's");
});

test("waiting for a window that does not appear lists the windows that ARE open, so the next try can name one", async () => {
  const { t, bridge } = make();
  bridge.wins.push({ window: 80, title: "WhatsApp Business - Personal - Microsoft Edge", process: "msedge", path: "x", pid: 7, x: 0, y: 0, w: 900, h: 700, foreground: true, minimized: false });
  bridge.waitWindow = async () => { throw Object.assign(new Error("no window like that appeared within 6 seconds"), { code: "not_found" }); };
  const r = await t.wait({ title: "WhatsApp Web", seconds: 6 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "not_found");
  assert.match(r.message, /no window like that appeared within 6 seconds/);
  assert.match(r.text, /WhatsApp Business - Personal - Microsoft Edge/, "the real title of the window that is open");
});

test("a click outside the screenshot is refused with the picture's size, before anything is clicked (the user's trace: 'that spot is outside the window', twice, with no way to tell why)", async () => {
  const { t, bridge } = make();
  bridge.wins.push({ window: 81, title: "Edge", process: "msedge", path: "x", pid: 8, x: 100, y: 200, w: 900, h: 700, foreground: true, minimized: false });
  bridge.shot = { mime: "image/png", base64: "UEZBS0VQSUNUVVJF", width: 640, height: 400, sourceWidth: 1280, sourceHeight: 800, scale: 0.5, x: 100, y: 200 };
  bridge.screenshot = async () => bridge.shot;
  bridge.clicks = [];
  bridge.click = async (a) => { bridge.clicks.push(a); return { method: "mouse", name: "(spot)" }; };
  bridge.focus = async () => ({ window: 81, previous: null });
  bridge.elementAt = async () => ({ found: false });
  await t.screenshot({ window: 81 });
  for (const spot of [{ x: 900, y: 120 }, { x: 100, y: 450 }, { x: -5, y: 10 }, { x: "abc", y: 10 }]) {
    const r = await t.click({ window: 81, ...spot });
    assert.equal(r.code, "outside_picture", JSON.stringify(spot));
    assert.match(r.message, /640 pixels wide and 400 tall/, "it says how big the picture is");
  }
  assert.equal(bridge.clicks.length, 0, "nothing was clicked");
  assert.equal((await t.click({ window: 81, x: 640, y: 400 })).ok, true, "the picture's own edge is inside it");
  assert.equal((await t.click({ window: 81, x: 0, y: 0 })).ok, true);
});

test("a task on the user's own computer gives up after half as many rounds of getting nowhere as a project task, unless told otherwise", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "noah-ll-"));
  try {
    const callModel = async () => ({ text: "", toolCalls: [], usage: {} });
    const project = createMission({ objective: "x", roots: [root], callModel });
    assert.equal(project.limits.stallLimit, DEFAULT_LIMITS.stallLimit, "a project task keeps the usual limit");
    const desktop = createMission({ objective: "x", roots: [], callModel, desktopBridge: new Bridge() });
    assert.equal(desktop.limits.stallLimit, 5, "a desktop task: nudged after 5 rounds without progress, paused after 10");
    const custom = createMission({ objective: "x", roots: [], callModel, desktopBridge: new Bridge(), limits: { stallLimit: 8 } });
    assert.equal(custom.limits.stallLimit, 8, "an explicit limit is respected");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
