// Noah/test/unit/mission-stop-continue.test.cjs - "Stop" and "Continue" while a computer task is busy (the user's own report: continue and stop do not work when a process is going on).
//   * Stop (and Pause) must end the task quickly even while a command, a model call or a long wait is in progress, and must leave no process behind.
//   * "Continue" after a pause must actually continue: a task paused for making no progress used to pause AGAIN before running a single step ("Paused: say continue" six times in a row).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MissionService } = require("../../autonomy/service.cjs");
const { AgentSession } = require("../../agent/session.cjs");
const { EventBus } = require("../../events.cjs");

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-sc-")));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const mk = (name) => { const d = path.join(base, `${name}-${Math.random().toString(36).slice(2, 7)}`); fs.mkdirSync(d, { recursive: true }); return fs.realpathSync.native(d); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const waitFor = async (fn, ms = 8000, step = 50) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } };

const fakeBridge = () => ({ windows: async () => [], stop() {}, dispose() {}, userIdle: async () => ({ idleMs: 99999 }) });
function world({ script, model, folder = mk("Desktop"), limits } = {}) {
  const requests = [];
  const bus = new EventBus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const router = {
    usable: () => [{ provider: "scripted" }],
    call: async (role, req, o) => {
      const i = requests.push(req) - 1;
      if (model) return model(i, req, o);
      const r = script[Math.min(i, script.length - 1)];
      return { text: "", toolCalls: r.map(([name, args]) => ({ name, args })), usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const core = { bus, session: new AgentSession({ bus }), safety: { confirm: async () => false, denyAllPending: () => {} } };
  const svc = new MissionService({ router, core, dataDir: mk("data"), pickFolder: async () => null, desktop: true, makeBridge: fakeBridge, desktopFolders: () => [folder], limits });
  const ended = [];
  svc.on("ended", (o) => ended.push(o));
  return { svc, events, ended, folder, requests };
}
const CRIT = ["criteria_add", { criteria: [{ kind: "file_exists", path: "never-made.txt" }] }];
const PLAN = ["plan_set", { steps: ["wait for the command", "check"] }];
// a command that writes its own process id into a file, then waits a minute
const LONG = (pidFile) => `node -e "require('fs').writeFileSync('${pidFile.replace(/\\/g, "/")}', String(process.pid)); setTimeout(() => {}, 60000)"`;

test("Stop ends the task within seconds while a command is running, and the command's process is gone", async () => {
  const folder = mk("Desktop");
  const pidFile = path.join(folder, "pid.txt");
  const w = world({ folder, script: [[CRIT, PLAN], [["shell_run", { cmd: LONG(pidFile) }]], [["finish", { summary: "x" }]]] });
  assert.equal(w.svc.start("run a long thing", { kind: "desktop" }).ok, true);
  const pid = Number(await waitFor(() => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : null)));
  assert.ok(pid > 0 && alive(pid), "the command is running");
  const t0 = Date.now();
  assert.deepEqual(w.svc.stop(), { ok: true });
  const out = await waitFor(() => w.ended[0]);
  assert.ok(out, "the task ended");
  assert.equal(out.status, "cancelled");
  assert.ok(Date.now() - t0 < 6000, `ended after ${Date.now() - t0} ms`);
  assert.equal(await waitFor(() => !alive(pid), 4000), true, "and its process was killed");
});

test("Pause while a command is running ends as a pause that can be continued, and the command is killed", async () => {
  const folder = mk("Desktop");
  const pidFile = path.join(folder, "pid.txt");
  const w = world({ folder, script: [[CRIT, PLAN], [["shell_run", { cmd: LONG(pidFile) }]], [["desktop_windows", {}]]] });
  w.svc.start("run a long thing", { kind: "desktop" });
  const pid = Number(await waitFor(() => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : null)));
  assert.deepEqual(w.svc.pause(), { ok: true });
  const out = await waitFor(() => w.ended[0]);
  assert.ok(out);
  assert.deepEqual([out.status, out.resumable], ["budget_paused", true]);
  assert.equal(await waitFor(() => !alive(pid), 4000), true);
  assert.equal(w.svc.canResume(), true);
});

test("Stop ends a task that is waiting for the model even when the model ignores the stop signal", async () => {
  let release;
  const hang = new Promise((r) => { release = r; });
  const w = world({ model: async (i, req, o) => { if (i === 0) return { text: "", toolCalls: [{ name: "criteria_add", args: CRIT[1] }, { name: "plan_set", args: PLAN[1] }], usage: {} }; await hang; return { text: "", toolCalls: [{ name: "desktop_windows", args: {} }], usage: {} }; } });
  w.svc.start("think for ever", { kind: "desktop" });
  await waitFor(() => w.requests.length >= 2);
  const t0 = Date.now();
  w.svc.stop();
  const out = await waitFor(() => w.ended[0], 6000);
  release();
  assert.ok(out, "Stop did not wait for the model");
  assert.equal(out.status, "cancelled");
  assert.ok(Date.now() - t0 < 5000);
});

test("Continue after a pause for making no progress really continues: it runs more rounds before it can pause again", async () => {
  // the model keeps looking at the same windows: no new file, no change, no new error = no progress
  const w = world({ script: [[CRIT, PLAN], [["desktop_windows", {}]]] });
  w.svc.start("go round in circles", { kind: "desktop" });
  const first = await waitFor(() => w.ended[0], 15000);
  assert.ok(first, "it paused by itself");
  assert.deepEqual([first.status, first.resumable], ["budget_paused", true]);
  assert.match(first.reason, /No real progress/);
  const roundsBefore = w.events.filter((e) => e.event === "mission_round").length;
  assert.equal(w.svc.resume().ok, true, "Continue is accepted");
  const second = await waitFor(() => w.ended[1], 15000);
  assert.ok(second, "and it ended again");
  const roundsAfter = w.events.filter((e) => e.event === "mission_round").length - roundsBefore;
  assert.ok(roundsAfter >= 3, `after Continue it ran ${roundsAfter} more rounds (it used to run none and pause again at once)`);
  assert.match(second.reason, /No real progress/, "it paused again only after a fresh stretch without progress");
});

test("each Continue gets a fresh stretch: three in a row all run rounds", async () => {
  const w = world({ script: [[CRIT, PLAN], [["desktop_windows", {}]]] });
  w.svc.start("go round in circles", { kind: "desktop" });
  assert.ok(await waitFor(() => w.ended[0], 15000));
  for (let i = 1; i <= 3; i++) {
    const before = w.events.filter((e) => e.event === "mission_round").length;
    assert.equal(w.svc.resume().ok, true, `Continue ${i}`);
    assert.ok(await waitFor(() => w.ended[i], 15000), `ended again after Continue ${i}`);
    assert.ok(w.events.filter((e) => e.event === "mission_round").length - before >= 3, `Continue ${i} ran rounds`);
  }
});

test("Stop on a task that is paused cancels it for good: Continue then has nothing to continue", async () => {
  const w = world({ script: [[CRIT, PLAN], [["desktop_windows", {}]]] });
  w.svc.start("go round in circles", { kind: "desktop" });
  assert.ok(await waitFor(() => w.ended[0], 15000));
  assert.equal(w.svc.canResume(), true);
  const r = w.svc.stop();
  assert.equal(r.ok, true, "Stop is accepted for a paused task too (it used to be ignored: the paused task stayed and Continue kept coming back)");
  assert.equal(w.svc.canResume(), false);
  assert.equal(w.svc.resume().ok, false);
});

test("a task that works through the shell with NEW commands is not paused for making no progress; the same command over and over still is", async () => {
  const w = world({ model: async (i) => (i === 0
    ? { text: "", toolCalls: [{ name: "criteria_add", args: CRIT[1] }, { name: "plan_set", args: PLAN[1] }], usage: {} }
    : { text: "", toolCalls: [{ name: "shell_run", args: { cmd: `echo step ${i}` } }], usage: {} }) });
  w.svc.start("work through the shell", { kind: "desktop" });
  await waitFor(() => w.requests.length >= 13, 90000);
  assert.equal(w.ended.length, 0, "12 different commands in a row: still working (ten rounds without anything new would have paused it)");
  w.svc.stop();
  assert.ok(await waitFor(() => w.ended[0]));
  const same = world({ model: async (i) => (i === 0
    ? { text: "", toolCalls: [{ name: "criteria_add", args: CRIT[1] }, { name: "plan_set", args: PLAN[1] }], usage: {} }
    : { text: "", toolCalls: [{ name: "shell_run", args: { cmd: "echo the same", retry: true } }], usage: {} }) });
  same.svc.start("repeat", { kind: "desktop" });
  const out = await waitFor(() => same.ended[0], 90000);
  assert.ok(out, "the same command again and again still ends");
  assert.equal(out.status, "budget_paused");
});

test("Stop ends a task whose tool is stuck and ignores Stop (a hung desktop helper): it does not wait for the tool", async () => {
  let release;
  const stuck = new Promise((r) => { release = r; });
  const folder = mk("Desktop");
  const w = world({ folder, script: [[CRIT, PLAN], [["desktop_windows", {}]]] });
  w.svc.makeBridge = () => ({ windows: () => stuck, stop() {}, dispose() {}, userIdle: async () => ({ idleMs: 99999 }) });
  w.svc.start("look at the windows", { kind: "desktop" });
  await waitFor(() => w.requests.length >= 2);
  await sleep(300);
  const t0 = Date.now();
  w.svc.stop();
  const out = await waitFor(() => w.ended[0], 6000);
  release([]);
  assert.ok(out, "Stop did not wait for the stuck tool");
  assert.equal(out.status, "cancelled");
  assert.ok(Date.now() - t0 < 5000);
});

test("Stop on a task that has already ended for good does nothing and says so", async () => {
  const w = world({ model: async (i) => { await sleep(250); return { text: "", toolCalls: i === 0 ? [{ name: "criteria_add", args: CRIT[1] }, { name: "plan_set", args: PLAN[1] }] : [{ name: "desktop_windows", args: {} }], usage: {} }; } }); // (slow enough to be stopped while it is still working)
  w.svc.start("go", { kind: "desktop" });
  await waitFor(() => w.requests.length >= 2);
  assert.equal(w.svc.stop().ok, true);
  assert.ok(await waitFor(() => w.ended[0]));
  assert.equal(w.ended[0].status, "cancelled", JSON.stringify(w.ended[0]).slice(0, 300));
  assert.deepEqual(w.svc.stop(), { ok: false }, "a task that is already cancelled is not 'cancelled' a second time");
});
