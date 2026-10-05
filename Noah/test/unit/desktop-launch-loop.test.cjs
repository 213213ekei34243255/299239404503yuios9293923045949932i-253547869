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
  assert.match(r.note, /no new window has appeared yet/);
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
