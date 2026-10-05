// Noah/test/unit/autonomy-ipc.test.cjs - the Stop button, Esc and the Continue button reach a running PROJECT TASK (Noah/ipc.cjs).
// Found just before the first hands-on test of stop / pause / continue: the handlers called the browser agent only, and agent.stop() does nothing
// unless a browser-agent task is current, so the red button did NOTHING while a mission was editing files and running commands.
// REAL mission service, runner, tools and files; only the Electron window and the browser agent are stand-ins.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { registerNoahIpc } = require("../../ipc.cjs");
const { MissionService } = require("../../autonomy/service.cjs");
const { AgentSession } = require("../../agent/session.cjs");
const { EventBus } = require("../../events.cjs");

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-ipc-")));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(10); } };

function project() {
  const root = path.join(base, `p${++n}`);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.js"), "module.exports = 1;\n");
  return root;
}
const CRITERIA = ["criteria_add", { criteria: [{ kind: "file_exists", path: "src/a.js", description: "a.js exists" }] }];
const PLAN = ["plan_set", { steps: ["do it"] }];

/**
 * @param script  rounds as [[tool, args], ...]; `delays[i]` makes round i's model call take that long (so a click can land in the middle of it)
 */
function app({ script, delays = {}, agent = {}, confirm = null }) {
  const root = project();
  const requests = [];
  const router = {
    usable: () => [{ provider: "scripted" }],
    call: async () => {
      const i = requests.push(1) - 1;
      if (delays[i]) await sleep(delays[i]);
      const r = script[i];
      if (r === undefined) throw new Error(`the script ran out at round ${i + 1}`);
      return { text: "", toolCalls: r.map(([name, args]) => ({ name, args })), usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const bus = new EventBus();
  const pending = [];
  const denied = [];
  const core = {
    bus, session: new AgentSession({ bus }), audit: { tail: () => [] },
    safety: {
      confirm: (req) => new Promise((resolve) => { pending.push({ req, resolve }); if (confirm) confirm(req, resolve); }),
      denyAllPending: (why) => { denied.push(why); while (pending.length) pending.pop().resolve(false); },
      resolveConfirmation: () => true, hasPendingConfirmation: () => pending.length > 0,
    },
  };
  const svc = new MissionService({ router, core, dataDir: path.join(base, `data${n}`), pickFolder: async () => root });
  const sender = { send() {} };
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), removeHandler() {} };
  const calls = [];
  const fakeAgent = { stop: (r) => { calls.push(["agent.stop", r]); return agent.stop ? agent.stop(r) : { ok: true }; }, pause: () => { calls.push(["agent.pause"]); return agent.pause ? agent.pause() : { ok: false, reason: "idle" }; }, resume: () => { calls.push(["agent.resume"]); return agent.resume ? agent.resume() : { ok: false, reason: "not_paused" }; } };
  registerNoahIpc({ ipcMain, mainWindow: { isDestroyed: () => false, webContents: sender }, core, getAgent: () => fakeAgent, getMissions: () => svc, config: {} });
  const click = (channel, ...args) => handlers.get(channel)({ sender }, ...args);
  const ended = () => new Promise((resolve) => svc.once("ended", resolve));
  return { root, svc, click, calls, requests, ended, pending, denied, handlers, sender, core };
}

test("the Stop button stops a running project task: nothing more is done, and the task ends as cancelled", async () => {
  const a = app({ script: [[CRITERIA, PLAN], [["fs_write", { path: "src/should-not-exist.js", content: "x" }]]], delays: { 1: 500 } });
  const done = a.ended();
  assert.equal(a.svc.start("fix it").ok, true);
  await until(() => a.requests.length >= 2); // the model is thinking about round 2: a file write is about to be asked for
  const res = await a.click("noah:stop");
  assert.deepEqual([res.ok, res.mission], [true, true], "the click reports that it stopped a project task");
  const out = await done;
  assert.equal(out.status, "cancelled");
  assert.equal(out.resumable, false, "stop is final");
  assert.equal(fs.existsSync(path.join(a.root, "src", "should-not-exist.js")), false, "the write that was about to happen did not");
  assert.equal(a.svc.isRunning(), false);
  assert.deepEqual(a.calls.map((c) => c[0]), ["agent.stop"], "the browser agent was told too (it simply has nothing to stop)");
});

test("Esc is the same handler: it stops a task that is waiting on a confirmation card, and the open card is answered 'no'", async () => {
  // the model wants to replace a TEST file: that asks, and the card is left open
  const a = app({ script: [[CRITERIA, PLAN], [["fs_write", { path: "test/x.test.js", content: "x" }], ["fs_write", { path: "src/a.js", content: "module.exports = 2;\n", overwrite: true }]]] });
  fs.mkdirSync(path.join(a.root, "test"), { recursive: true });
  fs.writeFileSync(path.join(a.root, "test", "x.test.js"), "old\n");
  // so that an overwrite is allowed the file must have been read: read it in round 2, overwrite it in round 3
  const b = app({ script: [[CRITERIA, PLAN], [["fs_read", { path: "test/x.test.js" }]], [["fs_write", { path: "test/x.test.js", content: "new\n", overwrite: true }]]] });
  fs.mkdirSync(path.join(b.root, "test"), { recursive: true });
  fs.writeFileSync(path.join(b.root, "test", "x.test.js"), "old\n");
  const done = b.ended();
  b.svc.start("rewrite the test");
  await until(() => b.pending.length === 1); // the confirmation card is open
  assert.match(b.pending[0].req.summary, /Overwrite test\/x\.test\.js \(a test file\)/);
  const res = await b.click("noah:stop"); // what Esc calls
  assert.equal(res.mission, true);
  assert.deepEqual(b.denied, ["stopped"], "the open card was answered no");
  const out = await done;
  assert.equal(out.status, "cancelled");
  assert.equal(fs.readFileSync(path.join(b.root, "test", "x.test.js"), "utf8"), "old\n", "the test file was not replaced");
});

test("the Pause button pauses a running task with its progress saved, and the Continue button carries on and finishes it", async () => {
  const a = app({
    script: [[CRITERIA, PLAN], [["fs_list", { path: "." }]], [["fs_write", { path: "src/b.js", content: "module.exports = 2;\n" }]], [["finish", { summary: "Added b.js." }]]],
    delays: { 1: 500 },
  });
  const paused = a.ended();
  a.svc.start("add b.js");
  await until(() => a.requests.length >= 2);
  const p = await a.click("noah:pause");
  assert.deepEqual([p.ok, p.mission], [true, true]);
  const out = await paused;
  assert.deepEqual([out.status, out.resumable], ["budget_paused", true], "a pause is not a stop: it can be continued");
  assert.equal(fs.existsSync(path.join(a.root, "src", "b.js")), false, "nothing was written while it was paused");

  const finished = a.ended();
  const c = await a.click("noah:resume");
  assert.deepEqual([c.ok, c.mission], [true, true], "Continue resumed the PROJECT task");
  const done = await finished;
  assert.equal(done.status, "succeeded");
  assert.equal(fs.readFileSync(path.join(a.root, "src", "b.js"), "utf8"), "module.exports = 2;\n");
  assert.deepEqual(a.calls.filter((x) => x[0] === "agent.resume").length, 1, "the browser agent was asked first and had nothing paused");
});

test("Continue prefers a paused browser run when there is one, and never resumes a task that is already running", async () => {
  const a = app({ script: [[CRITERIA, PLAN], [["fs_list", { path: "." }]], [["finish", { summary: "ok" }]]], delays: { 1: 400 }, agent: { resume: () => ({ ok: true }) } });
  const done = a.ended();
  a.svc.start("x");
  const c = await a.click("noah:resume");
  assert.deepEqual(c, { ok: true }, "the browser agent's own pause was continued (no mission flag)");
  await done.catch(() => {});
  // a running mission is not 'resumed' a second time by a stray click
  const b = app({ script: [[CRITERIA, PLAN], [["fs_list", { path: "." }]], [["finish", { summary: "ok" }]]], delays: { 1: 400 } });
  const fin = b.ended();
  b.svc.start("x");
  await until(() => b.requests.length >= 2);
  const again = await b.click("noah:resume");
  assert.equal(again.ok, false, "nothing to continue: it is already running");
  assert.notEqual(again.mission, true);
  await fin;
});

test("with nothing running the buttons behave as before (the browser agent decides), and with no task manager at all they still work", async () => {
  const a = app({ script: [], agent: { stop: () => ({ ok: true, who: "agent" }), pause: () => ({ ok: true, who: "agent" }) } });
  assert.deepEqual(await a.click("noah:stop"), { ok: true, who: "agent" });
  assert.deepEqual(await a.click("noah:pause"), { ok: true, who: "agent" });
  assert.equal((await a.click("noah:resume")).ok, false);
  // no getMissions at all (an app build without project tasks)
  const handlers = new Map();
  registerNoahIpc({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, mainWindow: { isDestroyed: () => false, webContents: a.sender }, core: a.core, getAgent: () => ({ stop: () => ({ ok: true, who: "agent" }), pause: () => ({ ok: false }), resume: () => ({ ok: false }) }), config: {} });
  assert.deepEqual(await handlers.get("noah:stop")({ sender: a.sender }), { ok: true, who: "agent" });
  // a missions getter that throws must not break the button
  const h2 = new Map();
  registerNoahIpc({ ipcMain: { handle: (c, f) => h2.set(c, f) }, mainWindow: { isDestroyed: () => false, webContents: a.sender }, core: a.core, getAgent: () => ({ stop: () => ({ ok: true }), pause: () => ({ ok: false }), resume: () => ({ ok: false }) }), getMissions: () => { throw new Error("boom"); }, config: {} });
  assert.deepEqual(await h2.get("noah:stop")({ sender: a.sender }), { ok: true });
});

test("only the Jonah shell window can press these buttons (a web page cannot stop or resume a task)", async () => {
  const a = app({ script: [] });
  for (const ch of ["noah:stop", "noah:pause", "noah:resume"]) {
    await assert.rejects(() => a.handlers.get(ch)({ sender: { send() {} } }), /untrusted sender/, ch);
  }
});
