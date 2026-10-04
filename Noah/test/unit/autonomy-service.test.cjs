// Noah/test/unit/autonomy-service.test.cjs - the app-facing mission owner (Noah/autonomy/service.cjs)
// REAL runner, tools and files; a SCRIPTED model; and stand-ins only for the app's own pieces (event bus, session, confirmation card, folder dialog).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MissionService, formatOutcome } = require("../../autonomy/service.cjs");
const { EventBus } = require("../../events.cjs");
const { AgentSession } = require("../../agent/session.cjs");

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-svc-")));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;
const NODE_TEST = `"${process.execPath}" --test`;
const put = (root, rel, content) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); };

function project() {
  const root = path.join(base, `p${++n}`);
  put(root, "package.json", JSON.stringify({ name: "demo", version: "1.0.0" }));
  put(root, "src/index.js", "const { add } = require('./util');\nmodule.exports = { add };\n");
  put(root, "src/utils.js", "exports.add = (a, b) => a + b;\n");
  put(root, "test/index.test.js", 'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../src/index.js");\ntest("adds", () => assert.equal(add(2, 3), 5));\n');
  return root;
}
const round = (...calls) => ({ calls });
const CRITERIA = ["criteria_add", { criteria: [{ kind: "command", cmd: NODE_TEST, description: "the project's tests pass" }] }];
const PLAN = ["plan_set", { steps: ["run the tests", "fix it", "run the tests again"] }];
const FIX = [round(CRITERIA, PLAN), round(["shell_run", { cmd: NODE_TEST }]), round(["fs_read", { path: "src/index.js" }]), round(["fs_edit", { path: "src/index.js", find: "'./util'", replace: "'./utils'" }]), round(["finish", { summary: "Fixed the import in src/index.js (./util is ./utils). The tests pass." }])];

function world({ script, folder, dataDir = path.join(base, `data${++n}`), ready = true, confirm, getMode } = {}) {
  const requests = [];
  const model = async (req, opts) => {
    requests.push(req.messages[0].content[0].text);
    const r = typeof script === "function" ? await script({ i: requests.length - 1, opts }) : script[requests.length - 1];
    if (r === undefined) throw new Error("the script ran out");
    return { text: "", toolCalls: r.calls.map(([name, args]) => ({ name, args })), usage: { inputTokens: 10, outputTokens: 5 } };
  };
  const bus = new EventBus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const session = new AgentSession({ bus });
  const states = [];
  session.on("state", (s) => states.push(s.state));
  const confirms = [];
  const core = { bus, session, safety: { confirm: async (req) => { confirms.push(req); return confirm ? confirm(req) : false; }, denyAllPending: () => {} } };
  const router = { usable: () => (ready ? [{ provider: "scripted" }] : []), call: async (role, req, opts) => { assert.equal(role, "mission"); return model(req, opts); } };
  const asked = [];
  const svc = new MissionService({ router, core, dataDir, pickFolder: async (info) => { asked.push(info); return typeof folder === "function" ? folder() : folder; }, getMode });
  const ended = () => new Promise((resolve) => svc.once("ended", resolve));
  return { svc, core, events, states, requests, confirms, asked, ended, dataDir, session };
}

test("a goal becomes a mission: the user picks a folder, the work runs, and the answer says what was CHECKED", async () => {
  const root = project();
  const w = world({ script: FIX, folder: root });
  assert.equal(w.svc.isAvailable(), true);
  const done = w.ended();
  const r = w.svc.start("Fix the failing test in this project and prove it passes.", { source: "voice" });
  assert.equal(r.ok, true);
  assert.ok(r.id, "the id is returned at once, before any work");
  assert.equal(w.svc.isRunning(), true);
  const out = await done;
  assert.equal(out.status, "succeeded");
  assert.deepEqual(w.asked, [{ goal: "Fix the failing test in this project and prove it passes." }]);
  assert.equal(fs.readFileSync(path.join(root, "src/index.js"), "utf8"), "const { add } = require('./utils');\nmodule.exports = { add };\n");
  assert.match(out.text, /^Fixed the import in src\/index\.js/);
  assert.match(out.text, /What Noah checked itself:\nPASS {6}the project's tests pass: exit 0/);
  assert.match(out.text, /Files changed: src\/index\.js\./);
  assert.equal(w.svc.isRunning(), false);
  const res = w.events.find((e) => e.event === "mission_result");
  assert.deepEqual([res.missionId, res.status, res.resumable, res.source], [r.id, "succeeded", false, "voice"]);
  assert.equal(w.events.find((e) => e.event === "mission_started").missionId, r.id, "the id handed back is the mission's own");
  assert.deepEqual(w.states.filter((s, i, a) => s !== a[i - 1]), ["planning", "executing", "completed"], "the one status line the browser agent uses");
});

test("no folder, no mission: declining the dialog starts nothing and says why", async () => {
  const w = world({ script: FIX, folder: null });
  const done = w.ended();
  w.svc.start("set up this project");
  const out = await done;
  assert.equal(out.status, "cancelled");
  assert.match(out.text, /No folder was chosen, so I did not start\. I only work inside a folder you pick/);
  assert.equal(w.requests.length, 0, "the model was never asked");
  assert.deepEqual(w.svc.list(), [], "and nothing was saved");
  assert.equal(w.session.executionState, "idle");
});

test("a folder dialog that blows up is treated as 'no folder'", async () => {
  const w = world({ script: FIX, folder: () => { throw new Error("dialog crashed"); } });
  const done = w.ended();
  w.svc.start("set up this project");
  assert.equal((await done).status, "cancelled");
});

test("one mission at a time", async () => {
  const w = world({ script: async () => { await new Promise((r) => setTimeout(r, 200)); return round(CRITERIA); }, folder: project() });
  const done = w.ended();
  assert.equal(w.svc.start("fix the build in this repo").ok, true);
  const second = w.svc.start("run the tests in this project");
  assert.equal(second.ok, false);
  assert.match(second.reply, /already running/);
  w.svc.stop();
  await done;
});

test("stop kills the work in progress and ends it as cancelled", async () => {
  const root = project();
  put(root, "forever.js", "setInterval(() => {}, 1000);");
  const w = world({ script: [round(CRITERIA, PLAN), round(["shell_run", { cmd: `"${process.execPath}" forever.js`, timeoutMs: 60000 }]), round(["fs_read", { path: "package.json" }])], folder: root });
  const done = w.ended();
  w.svc.start("run the dev server for this project");
  setTimeout(() => w.svc.stop(), 2500);
  const t0 = Date.now();
  const out = await done;
  assert.equal(out.status, "cancelled");
  assert.equal(out.text, "Stopped.");
  assert.ok(Date.now() - t0 < 15000);
  assert.equal(w.svc.stop().ok, false, "nothing left to stop");
});

test("a question from the mission waits for the answer, which arrives as the next message", async () => {
  const root = project();
  const w = world({ script: [round(CRITERIA, PLAN), round(["ask_user", { question: "Should I use staging or production?" }]), round(["fs_read", { path: "src/index.js" }]), round(["fs_edit", { path: "src/index.js", find: "'./util'", replace: "'./utils'" }]), round(["finish", { summary: "Used staging, and fixed the import." }])], folder: root });
  let done = w.ended();
  w.svc.start("deploy this project");
  let out = await done;
  assert.equal(out.status, "blocked_input");
  assert.match(out.text, /^Should I use staging or production\?\n\nReply with your answer and I will carry on\./);
  assert.equal(w.svc.awaitingAnswer(), true);
  assert.equal(w.svc.hasResumable(), true);
  assert.equal(w.session.executionState, "waiting_for_user", "the status line says it is waiting for the user");
  assert.equal(w.svc.isRunning(), false);
  assert.equal(w.events.find((e) => e.event === "mission_result").resumable, true);

  done = w.ended();
  assert.equal(w.svc.answer("staging").ok, true);
  assert.equal(w.session.executionState, "executing");
  out = await done;
  assert.equal(out.status, "succeeded", out.text);
  assert.match(w.requests[2], /The user replied: staging/);
  assert.equal(w.svc.awaitingAnswer(), false);
  assert.equal(w.svc.answer("anything").ok, false, "nothing is waiting any more");
});

test("the ticket given at the start is what the mission is built with, and a restored mission gets back the one it was saved with", async () => {
  const root = project();
  const built = [];
  const w = world({ script: [round(CRITERIA, PLAN)], folder: root });
  const realCreate = w.svc.create;
  w.svc.create = (opts) => { built.push({ ticket: opts.ticket, restore: !!opts.restore }); return realCreate(opts); };
  w.svc.limits = { maxIterations: 1 };
  const done = w.ended();
  assert.equal(w.svc.start("fix this project", { ticket: "paid-key-77" }).ok, true);
  await done;
  assert.deepEqual(built, [{ ticket: "paid-key-77", restore: false }]);
  const restart = world({ script: [round(["fs_read", { path: "package.json" }])], folder: null, dataDir: w.dataDir });
  const seen = [];
  const create = restart.svc.create;
  restart.svc.create = (opts) => { seen.push(opts.ticket); return create(opts); };
  restart.svc.limits = { maxIterations: 1 };
  const d2 = restart.ended();
  assert.equal(restart.svc.resume().ok, true);
  await d2;
  assert.deepEqual(seen, ["paid-key-77"], "after a restart the saved ticket is used, not none");
  const plain = world({ script: [round(CRITERIA)], folder: project() });
  const noTicket = [];
  const c3 = plain.svc.create;
  plain.svc.create = (opts) => { noTicket.push(opts.ticket); return c3(opts); };
  plain.svc.limits = { maxIterations: 1 };
  const d3 = plain.ended();
  plain.svc.start("fix this project");
  await d3;
  assert.deepEqual(noTicket, [undefined], "a task started without one has none (the model endpoint decides whether that is allowed)");
});

test("pause ends a running mission as a PAUSE that 'continue' picks up; stop on the same mission would have been final", async () => {
  const root = project();
  const w = world({ script: async (c) => { if (c.i === 0) return round(CRITERIA, PLAN); await new Promise((r) => setTimeout(r, 150)); return round(["fs_read", { path: "package.json" }]); }, folder: root });
  w.svc.limits = { stallLimit: 50 };
  let done = w.ended();
  w.svc.start("investigate this codebase");
  setTimeout(() => assert.equal(w.svc.pause().ok, true), 300);
  let out = await done;
  assert.equal(out.status, "budget_paused");
  assert.match(out.text, /^Paused at your request\./);
  assert.equal(w.svc.hasResumable(), true);
  assert.equal(w.svc.canResume(), true);
  assert.equal(w.svc.pause().ok, false, "nothing running to pause");
  done = w.ended();
  assert.equal(w.svc.resume().ok, true);
  assert.equal(w.svc.canResume(), false, "running again");
  setTimeout(() => w.svc.stop(), 300);
  out = await done;
  assert.equal(out.status, "cancelled");
  assert.equal(w.svc.canResume(), false, "a stopped mission is not resumable");
});

test("a paused mission (budget) is continued with a bare 'continue', and is not an awaited answer", async () => {
  const root = project();
  const w = world({ script: (c) => (c.i === 0 ? round(CRITERIA, PLAN) : round(["fs_read", { path: ["package.json", "src/index.js", "src/utils.js"][(c.i - 1) % 3] }])), folder: root });
  w.svc.limits = { maxIterations: 2, stallLimit: 50 };
  let done = w.ended();
  w.svc.start("investigate this codebase");
  let out = await done;
  assert.equal(out.status, "budget_paused");
  assert.match(out.text, /Paused after 2 rounds \(the round limit\)/);
  assert.match(out.text, /Say "continue" to carry on, or stop\./);
  assert.equal(w.svc.hasResumable(), true);
  assert.equal(w.svc.awaitingAnswer(), false);
  done = w.ended();
  assert.equal(w.svc.resume().ok, true);
  out = await done;
  assert.equal(out.status, "budget_paused");
  assert.match(w.requests[2], /The user asked you to continue\./);
});

test("after a restart the latest saved mission comes back PAUSED and 'continue' picks it up; a folder that is gone is reported", async () => {
  const root = project();
  const dataDir = path.join(base, `data-restart${++n}`);
  const first = world({ script: FIX.slice(0, 3), folder: root, dataDir });
  first.svc.limits = { maxIterations: 3 };
  let done = first.ended();
  first.svc.start("fix the failing test in this project");
  await done;
  assert.equal(first.svc.list()[0].status, "budget_paused");

  // "restart": a brand-new service over the same data folder
  const second = world({ script: [round(["fs_read", { path: "src/index.js" }]), round(["fs_edit", { path: "src/index.js", find: "'./util'", replace: "'./utils'" }]), round(["finish", { summary: "Fixed after a restart." }])], folder: null, dataDir });
  assert.equal(second.svc.hasResumable(), false, "nothing is running by itself after a restart");
  assert.equal(second.svc.list()[0].resumable, true);
  done = second.ended();
  const r = second.svc.resume();
  assert.equal(r.ok, true);
  const out = await done;
  assert.equal(out.status, "succeeded", out.text);
  assert.equal(second.asked.length, 0, "no dialog: the folder was granted for this very task");
  assert.match(out.text, /^Fixed after a restart\./);
  assert.equal(second.svc.resume().ok, false, "and now nothing is left to continue");

  // a saved task whose folder has since been deleted
  const root2 = project();
  const dataDir2 = path.join(base, `data-gone${++n}`);
  const a = world({ script: FIX.slice(0, 2), folder: root2, dataDir: dataDir2 });
  a.svc.limits = { maxIterations: 2 };
  done = a.ended();
  a.svc.start("fix this project");
  await done;
  fs.rmSync(root2, { recursive: true, force: true });
  const b = world({ script: [], folder: null, dataDir: dataDir2 });
  const rr = b.svc.resume();
  assert.equal(rr.ok, false);
  assert.match(rr.reply, /could not continue that task/);
});

test("a risky command reaches the confirmation card, and the mode comes from the app's own setting", async () => {
  const root = project();
  const risky = `${`"${process.execPath}"`} -e "require('fs').writeFileSync('marker.txt','x');/*execSync*/"`;
  const w = world({ script: [round(CRITERIA, PLAN), round(["shell_run", { cmd: risky }]), round(["fs_read", { path: "package.json" }])], folder: root, confirm: () => false, getMode: () => "autonomous" });
  w.svc.limits = { maxIterations: 3 };
  const done = w.ended();
  w.svc.start("run my script in this project");
  await done;
  assert.equal(w.confirms.length, 1, "the app's confirmation card was asked");
  assert.match(w.confirms[0].summary, /writeFileSync/);
  assert.equal(w.confirms[0].risk.level, "high");
  assert.equal(fs.existsSync(path.join(root, "marker.txt")), false, "declined: it did not run");
  const strict = world({ script: [round(CRITERIA, PLAN), round(["fs_write", { path: "a.txt", content: "x" }])], folder: project(), confirm: () => false, getMode: () => "strict" });
  strict.svc.limits = { maxIterations: 3 };
  const d2 = strict.ended();
  strict.svc.start("create a file in this project");
  await d2;
  assert.deepEqual(strict.confirms.map((c) => c.summary), ["Create a.txt"], "strict mode asks even for a plain write");
});

test("the mission is unavailable without a usable model, and the service says so instead of pretending", () => {
  const w = world({ script: FIX, folder: null, ready: false });
  assert.equal(w.svc.isAvailable(), false);
  const broken = new MissionService({ router: { usable: () => { throw new Error("router broke"); }, call: async () => ({}) }, core: w.core, dataDir: null, pickFolder: async () => null });
  assert.equal(broken.isAvailable(), false);
  assert.deepEqual(broken.list(), []);
});

test("every ending is reported honestly", () => {
  const base = { filesChanged: ["a.js", "b.js"], verification: "PASS  tests pass: exit 0\nASSERTED  report the price (stated by Noah, not machine-checked): 61,999" };
  const ok = formatOutcome({ ...base, status: "succeeded", summary: "All fixed." });
  assert.match(ok, /^All fixed\.\n\nWhat Noah checked itself:\nPASS/);
  assert.match(ok, /ASSERTED {2}report the price \(stated by Noah, not machine-checked\)/, "asserted is never passed off as verified");
  assert.match(ok, /Files changed: a\.js, b\.js\./);
  assert.match(formatOutcome({ ...base, status: "impossible", reason: "The service shut down in 2024." }), /^I could not do this: The service shut down in 2024\./);
  assert.match(formatOutcome({ ...base, status: "budget_paused", reason: "Paused after 120 rounds (the round limit)." }), /Where the checks stand:\nPASS[\s\S]*Say "continue"/);
  assert.match(formatOutcome({ status: "blocked_permission", reason: "May I install globally?" }), /^May I install globally\?\n\nReply with your answer/);

  // text that looked like orders to an AI: the user is told by code, in every ending, naming where
  const inj = [{ id: "concealment", source: "README.md" }, { id: "note_to_ai", source: "README.md" }, { id: "false_report", source: "docs/NOTES.md" }];
  assert.match(formatOutcome({ ...base, status: "succeeded", summary: "All fixed.", injection: inj }), /^All fixed\.[\s\S]*\n\nHeads-up: text in README\.md, docs\/NOTES\.md looked like instructions aimed at an AI\. It is not from you\./);
  assert.match(formatOutcome({ ...base, status: "impossible", reason: "no key", injection: inj }), /Heads-up: text in README\.md/);
  assert.match(formatOutcome({ ...base, status: "budget_paused", reason: "Paused.", injection: inj }), /Say "continue"[\s\S]*Heads-up/);
  assert.match(formatOutcome({ ...base, status: "succeeded", summary: "ok", injection: [{ id: "x" }] }), /Heads-up: text in a file or program output looked like/, "no file name known: say so plainly");
  assert.equal(formatOutcome({ status: "cancelled", reason: "stopped by the user", injection: inj }), "Stopped.", "a plain stop stays plain");
  assert.doesNotMatch(formatOutcome({ ...base, status: "succeeded", summary: "ok", injection: [] }), /Heads-up/);
  assert.doesNotMatch(formatOutcome({ ...base, status: "succeeded", summary: "ok" }), /Heads-up/);
  const spent = formatOutcome({ ...base, status: "budget_exhausted", reason: "This task has used its whole allowance (600 model calls across all its runs), so it cannot be continued." });
  assert.match(spent, /^This task has used its whole allowance[\s\S]*Where the checks stood:\nPASS[\s\S]*Files changed: a\.js, b\.js\./);
  assert.doesNotMatch(spent, /continue"/, "it does not invite a 'continue' that cannot work");
  assert.equal(formatOutcome({ status: "cancelled", reason: "stopped by the user" }), "Stopped.");
  assert.match(formatOutcome({ status: "unsafe", reason: "a rule" }), /safety rule: a rule/);
  assert.ok(formatOutcome({ status: "succeeded", summary: "x".repeat(5000), verification: "v".repeat(5000), filesChanged: [] }).length < 3000, "bounded");
  const many = formatOutcome({ status: "succeeded", summary: "x", filesChanged: Array.from({ length: 20 }, (_, i) => `f${i}.js`) });
  assert.match(many, /\(\+8 more\)/);
});
