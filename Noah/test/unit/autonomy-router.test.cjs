// Noah/test/unit/autonomy-router.test.cjs - how the ONE command router sends project jobs to missions (Noah/agent/command-router.cjs),
// and that billing counts them as agent uses (entitlement-gate.cjs classifyGoal). The mission service is a recording stand-in here:
// its own behaviour is tested in autonomy-service.test.cjs.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CommandRouter } = require("../../agent/command-router.cjs");
const { AgentSession } = require("../../agent/session.cjs");
const { EventBus } = require("../../events.cjs");
const { classifyGoal } = require("../../../entitlement-gate.cjs");

const JOB = "Set up this project, diagnose the errors, modify whatever files are necessary, run the tests, verify that it works, and give me the final result.";

function setup({ missions = true, ...m } = {}) {
  const calls = [];
  const agent = { submit: (...a) => { calls.push(["agent.submit", ...a]); return "agent-1"; }, stop: () => calls.push(["agent.stop"]), pause: () => calls.push(["agent.pause"]), resume: () => { calls.push(["agent.resume"]); return { ok: true }; } };
  const state = { available: true, running: false, awaiting: false, canResume: false, startOk: true, ...m };
  const svc = {
    isAvailable: () => state.available, isRunning: () => state.running, awaitingAnswer: () => state.awaiting, hasResumable: () => state.canResume, canResume: () => state.canResume,
    start: (g, o) => { calls.push(["missions.start", g, o]); return state.startOk ? { ok: true, id: "mission-1" } : { ok: false, reply: "A project task is already running." }; },
    answer: (t, o) => { calls.push(["missions.answer", t, o]); return state.awaiting ? { ok: true, id: "mission-1" } : { ok: false, reply: "There is no project task waiting for an answer." }; },
    resume: (o) => { calls.push(["missions.resume", o]); return { ok: true, id: "mission-1" }; },
    stop: () => { calls.push(["missions.stop"]); return { ok: true }; },
    pause: () => { calls.push(["missions.pause"]); return { ok: true }; },
  };
  const session = new AgentSession({ bus: new EventBus() });
  return { router: new CommandRouter({ session, agent, missions: missions ? svc : null }), calls, state, session };
}

test("the audit's headline prompt reaches the mission service (it used to go to plain chat)", () => {
  const { router, calls } = setup();
  const r = router.route(JOB, { source: "voice", ticket: "paid-use-key-1" });
  assert.deepEqual(r, { handled: true, kind: "mission", id: "mission-1" });
  assert.deepEqual(calls, [["missions.start", JOB, { source: "voice", ticket: "paid-use-key-1" }]], "the key of the agent use that paid for it travels with the job");
});

test("browser tasks still go to the browser agent, and plain chat stays chat", () => {
  const { router, calls } = setup();
  assert.equal(router.route("open youtube.com and search for lo-fi music").kind, "agent");
  assert.equal(router.route("what is a git branch?").kind, "chat");
  assert.equal(router.route("write a poem about the sea").kind, "chat");
  assert.equal(calls.filter((c) => c[0] === "missions.start").length, 0);
});

test("the user's own Chat mode never starts a mission", () => {
  const { router, calls } = setup();
  assert.deepEqual(router.route(JOB, { mode: "chat" }), { handled: false, kind: "chat" });
  assert.equal(calls.length, 0);
});

test("without a usable model the project job is not intercepted (nothing changes for the user)", () => {
  const { router, calls } = setup({ available: false });
  const r = router.route("run the tests and fix whatever fails");
  assert.notEqual(r.kind, "mission");
  assert.equal(calls.filter((c) => c[0] === "missions.start").length, 0);
});

test("with no mission service at all the router behaves exactly as before", () => {
  const { router } = setup({ missions: false });
  assert.equal(router.route(JOB).kind === "mission", false);
  assert.equal(router.route("stop").handled, false, "a control with nothing running is not handled");
  assert.equal(router.route("open youtube.com").kind, "agent");
});

test("a second job while one runs gets a plain reply, not a second mission", () => {
  const { router } = setup({ startOk: false });
  const r = router.route("fix the failing build in this repo");
  assert.deepEqual(r, { handled: true, kind: "control", control: "mission", reply: "A project task is already running." });
});

test("an answer to the mission's question goes back to the mission; a NEW job while one waits starts a new mission", () => {
  const { router, calls } = setup({ awaiting: true });
  const a = router.route("use staging", { source: "text" });
  assert.deepEqual(a, { handled: true, kind: "mission", id: "mission-1", followUp: true });
  assert.deepEqual(calls.at(-1), ["missions.answer", "use staging", { source: "text" }]);
  const fresh = router.route("run the tests in this project");
  assert.equal(fresh.kind, "mission");
  assert.equal(calls.at(-1)[0], "missions.start", "a new job is a new job, not an answer");
  const chat = setup({ awaiting: true });
  assert.equal(chat.router.route("use staging", { mode: "chat" }).kind, "chat", "in Chat mode a message is never an answer");
});

test("stop stops the mission and the agent; pause pauses the mission (progress kept)", () => {
  const { router, calls, state } = setup({ running: true });
  const stop = router.route("stop");
  assert.deepEqual([stop.kind, stop.control, stop.reply], ["control", "stop", "Stopped."]);
  assert.deepEqual(calls.map((c) => c[0]), ["missions.stop", "agent.stop"]);
  calls.length = 0;
  const pause = router.route("pause");
  assert.deepEqual(calls.map((c) => c[0]), ["missions.pause"]);
  assert.match(pause.reply, /progress is saved\. Say "continue"/);
  state.running = false;
});

test("'continue' resumes a waiting or saved project task first, and says it is busy while one runs", () => {
  const w = setup({ canResume: true });
  const r = w.router.route("continue");
  assert.deepEqual([r.kind, r.control, r.reply], ["control", "resume", "Continuing the project task."]);
  assert.deepEqual(w.calls.map((c) => c[0]), ["missions.resume"]);
  assert.equal(w.calls.some((c) => c[0] === "agent.resume"), false, "not the browser agent");

  const busy = setup({ running: true });
  assert.equal(busy.router.route("continue").reply, "Already working on it.");

  const none = setup();
  assert.equal(none.router.route("continue").handled, false, "nothing to continue and no session: not handled");
});

test("after an app restart (no session at all) 'continue' still finds the saved project task", () => {
  const w = setup({ canResume: true });
  assert.equal(w.session.hasRecentTask(), false);
  const r = w.router.route("go on");
  assert.deepEqual([r.handled, r.control], [true, "resume"]);
  assert.equal(w.calls[0][0], "missions.resume");
});

test("billing: a project job is an AGENT use, a question about a project concept is chat, and controls stay free", () => {
  assert.equal(classifyGoal(JOB, "auto"), "agent", "it used to be classified as chat (and so was never counted as an agent use)");
  assert.equal(classifyGoal("run the tests and fix whatever fails", "auto"), "agent");
  assert.equal(classifyGoal("git status and commit the changes", "auto"), "agent");
  assert.equal(classifyGoal("what is a git branch?", "auto"), "chat");
  assert.equal(classifyGoal("open youtube.com and search for lo-fi music", "auto"), "agent");
  assert.equal(classifyGoal("continue", "auto"), "control");
  assert.equal(classifyGoal("stop", "auto"), "control");
  assert.equal(classifyGoal(JOB, "chat"), "chat", "the user's own choice of Chat mode is honoured");
});
