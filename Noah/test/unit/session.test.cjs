// Noah/test/unit/session.test.cjs
//
// The agent SESSION architecture: what stays true across runs (session), what belongs to one instruction (run), how
// voice and text reach the same session, and how a paused / finished / superseded run leaves the session alone.

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const os = require("os");
const fs = require("fs");
const path = require("path");

const { EventBus } = require("../../events.cjs");
const { AgentSession } = require("../../agent/session.cjs");
const { CommandRouter } = require("../../agent/command-router.cjs");
const intent = require("../../agent/intent.cjs");
const lifecycle = require("../../agent/lifecycle-log.cjs");
const { NoahAgent, timed, friendlyError, describeAction, ToolTimeoutError } = require("../../agent/noah-agent.cjs");
const { SafetyController } = require("../../safety/safety-controller.cjs");
const { TakeoverMonitor } = require("../../safety/takeover.cjs");
const { Composer, continuationIntentFrom, repeatsExisting } = require("../../models/compose.cjs");
const { RexyLegacyProvider } = require("../../models/rexy-legacy.cjs");

const newSession = () => {
  const bus = new EventBus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  return { bus, events, session: new AgentSession({ bus }) };
};
const states = (events) => events.filter((e) => e.event === "session_state").map((e) => e.state);
const runOnce = (s, goal, status = "completed", extra = {}) => {
  s.runStarted({ runId: `r${s.runs + 1}`, taskId: `t${s.runs + 1}`, goal, source: "text" });
  s.runExecuting();
  s.runFinished(status, { result: extra.result || "ok", error: extra.error });
};

// ---- intent (shared by voice and text) -------------------------------------------------------------------------

test("intent: browser tasks, page-acting phrases and plain chat are told apart", () => {
  for (const g of ["Open JustNotepad and write a short dinosaur story", "write a story about Jurassic World on this notepad", "Write the next paragraph on the notepad", "search for shoes on amazon", "summarize this page", "go to youtube.com"]) {
    assert.equal(intent.looksLikeBrowserTask(g), true, g);
  }
  for (const g of ["hello there", "what is the capital of France", "tell me a joke", "thanks"]) assert.equal(intent.looksLikeBrowserTask(g), false, g);
});

test("intent: 'continue' / 'stop' / 'pause' on their own are controls, anything longer is not", () => {
  assert.equal(intent.controlOf("Continue"), "resume");
  assert.equal(intent.controlOf("ok, please continue."), "resume");
  assert.equal(intent.controlOf("stop"), "stop");
  assert.equal(intent.controlOf("never mind"), "stop");
  assert.equal(intent.controlOf("pause"), "pause");
  assert.equal(intent.controlOf("continue writing the story"), null);
  assert.equal(intent.controlOf("stop the music on youtube"), null);
});

test("intent: follow-up fragments only count as follow-ups when they are short, not questions or greetings", () => {
  for (const t of ["Continue writing the story", "on the notepad please", "make it longer", "write the next paragraph", "scroll down more"]) assert.equal(intent.isFollowUp(t), true, t);
  for (const t of ["hello", "thanks", "what is a dinosaur?", "how does photosynthesis work? explain it in detail please and make it long enough to not be short"]) assert.equal(intent.isFollowUp(t), false, t);
});

test("intent: 'turn on agentic mode' is not a command (there is nothing to turn on)", () => {
  assert.deepEqual(intent.stripAgentModePhrase("turn on agentic mode"), { text: "", hadPhrase: true });
  assert.equal(intent.stripAgentModePhrase("on the notepad on ur screen turn the agentic mode").text, "on the notepad on ur screen");
  assert.equal(intent.stripAgentModePhrase("open youtube").hadPhrase, false);
  assert.equal(intent.stripAddress("Noah, open youtube"), "open youtube");
});

// ---- the session -----------------------------------------------------------------------------------------------

test("session: a finished run leaves the SAME session, task and browser context in place", () => {
  const { session, events } = newSession();
  const id = session.id;
  session.updateBrowser({ tabId: "t1", url: "https://justnotepad.com/", title: "Notepad", pageReady: true }, "navigation");
  runOnce(session, "Open JustNotepad and write a short dinosaur story", "completed", { result: "Typed about 120 words into the page." });
  assert.equal(session.executionState, "completed");
  assert.equal(session.id, id);
  assert.equal(session.enabled, true, "agent mode stays on");
  assert.equal(session.task.goal, "Open JustNotepad and write a short dinosaur story");
  assert.equal(session.browser.url, "https://justnotepad.com/");
  assert.equal(session.runId, null, "no run is active any more");
  assert.deepEqual(states(events), ["planning", "executing", "completed"]);
  runOnce(session, "Continue writing the story");
  assert.equal(session.id, id);
  assert.equal(session.runs, 2);
  assert.equal(session.hasRecentTask(), true);
});

test("session: pause is not destroy - the task and page stay, and resume returns to executing", () => {
  const { session, bus, events } = newSession();
  session.updateBrowser({ tabId: "t1", url: "https://justnotepad.com/", title: "Notepad" });
  session.runStarted({ runId: "r1", taskId: "t1", goal: "write a story", source: "text" });
  session.runExecuting("Typing…");
  bus.publish("safety", { level: "pause", reason: "takeover" });
  assert.equal(session.executionState, "paused");
  assert.equal(session.task.goal, "write a story");
  assert.equal(session.runId, "r1");
  assert.equal(session.browser.url, "https://justnotepad.com/");
  bus.publish("safety", { level: "resume" });
  assert.equal(session.executionState, "executing");
  bus.publish("ask_user", { question: "Which account?" });
  assert.equal(session.executionState, "waiting_for_user");
  bus.publish("safety", { level: "pause", reason: "ask_user" });
  assert.equal(session.executionState, "waiting_for_user", "the same wait, not a second 'paused'");
  bus.publish("safety", { level: "resume" });
  assert.equal(session.executionState, "executing");
  assert.deepEqual(states(events), ["planning", "executing", "paused", "executing", "waiting_for_user", "executing"]);
});

test("session: pause/resume events while NOTHING is running are ignored (an idle agent is never 'paused')", () => {
  const { session, bus, events } = newSession();
  bus.publish("safety", { level: "pause", reason: "takeover" });
  bus.publish("ask_user", { question: "?" });
  assert.equal(session.executionState, "idle");
  assert.equal(states(events).length, 0);
  runOnce(session, "open example.com");
  bus.publish("safety", { level: "pause", reason: "takeover" });
  assert.equal(session.executionState, "completed", "a finished run cannot be paused afterwards");
});

test("session: navigation and tab changes update the browser context and never reset the task", () => {
  const { session } = newSession();
  session.runStarted({ runId: "r1", taskId: "t1", goal: "write a story", source: "text" });
  session.runExecuting();
  session.updateBrowser({ tabId: "t7", url: "https://a.example/", title: "A", pageReady: false }, "navigation");
  session.updateBrowser({ url: "https://justnotepad.com/", title: "JustNotepad", pageReady: true }, "navigation");
  session.updateBrowser({ tabId: "t9" }, "tab_switch");
  assert.equal(session.executionState, "executing");
  assert.equal(session.task.goal, "write a story");
  assert.equal(session.browser.tabId, "t9");
  assert.equal(session.browser.url, "https://justnotepad.com/");
  assert.equal(typeof session.browser.timestamp, "number");
  const ctx = session.contextFor();
  assert.deepEqual(Object.keys(ctx.browser).sort(), ["pageReady", "tabId", "title", "url"]);
});

test("session: a superseded run hands over to the next run without a stray terminal state", () => {
  const { session, events } = newSession();
  session.runStarted({ runId: "r1", taskId: "t1", goal: "first", source: "text" });
  session.runExecuting();
  session.paused("takeover");
  session.runFinished("cancelled", { superseded: true });
  assert.equal(session.executionState, "paused", "no idle/error flash between the two runs");
  session.runStarted({ runId: "r2", taskId: "t2", goal: "second", source: "voice" });
  assert.equal(session.executionState, "planning");
  assert.equal(session.conversation[0].outcome, "superseded");
  assert.equal(states(events).includes("error"), false);
});

test("session: every run ends in a terminal transition (completed / error / idle) and identical states are not re-published", () => {
  const { session, events } = newSession();
  runOnce(session, "a", "failed", { error: "The page did not respond" });
  assert.equal(session.executionState, "error");
  runOnce(session, "b", "cancelled");
  assert.equal(session.executionState, "idle");
  session.note("Typing…"); // not running: ignored
  const before = events.length;
  session.runStarted({ runId: "r9", taskId: "t9", goal: "c", source: "text" });
  session.runExecuting();
  session.note("Typing…");
  session.note("Typing…");
  session.note("Typing…");
  const published = states(events.slice(before));
  assert.equal(published.length, 3, "planning, executing, executing+text: repeated identical notes add nothing");
});

test("session: only destroy() ends it, and it says so in the lifecycle log", () => {
  const lines = [];
  lifecycle.setEnabled(true);
  lifecycle.setSink((l) => lines.push(JSON.parse(l)));
  try {
    const { session } = newSession();
    runOnce(session, "x");
    session.paused("takeover"); // no effect (finished)
    session.destroy();
    const names = lines.map((l) => l.event);
    assert.ok(names.includes("AGENT_SESSION_CREATED"));
    assert.ok(names.includes("AGENT_RUN_STARTED"));
    assert.ok(names.includes("AGENT_RUN_COMPLETED"));
    assert.equal(names.filter((n) => n === "AGENT_SESSION_DESTROYED").length, 1);
    for (const l of lines) assert.ok(l.timestamp && "sessionId" in l && "runId" in l && "tabId" in l && "url" in l, "every entry carries the correlation fields");
  } finally {
    lifecycle.setEnabled(false);
  }
});

// ---- the command router: voice and text are the same road ------------------------------------------------------

function routerWithFakeAgent() {
  const { session, bus } = newSession();
  const calls = [];
  const agent = {
    submit: (text, opts) => { calls.push(["submit", text, opts]); return `id${calls.length}`; },
    stop: () => calls.push(["stop"]),
    pause: () => calls.push(["pause"]),
    resume: () => { calls.push(["resume"]); return { ok: true }; },
  };
  return { session, bus, calls, router: new CommandRouter({ session, agent }), agent };
}

test("router A/B/C/D: initial task, follow-up, explicit page reference and voice all reach the same session with context", () => {
  const { session, calls, router } = routerWithFakeAgent();
  // A: initial task
  const a = router.route("Open JustNotepad and write a short dinosaur story", { source: "text" });
  assert.deepEqual([a.kind, a.followUp], ["agent", false]);
  assert.equal(calls[0][2].context, null, "nothing to continue yet");
  runOnce(session, "Open JustNotepad and write a short dinosaur story", "completed", { result: "Typed about 120 words into the page." });
  session.updateBrowser({ tabId: "t1", url: "https://justnotepad.com/", title: "JustNotepad" });
  session.noteWritten("Once upon a time a small dinosaur named Rex lived beside a warm green river. ".repeat(3));
  // B: follow-up with no page named at all
  const b = router.route("Continue writing the story", { source: "text" });
  assert.deepEqual([b.kind, b.followUp], ["agent", true]);
  assert.equal(calls[1][2].followUp, true);
  assert.equal(calls[1][2].context.lastGoal, "Open JustNotepad and write a short dinosaur story");
  assert.equal(calls[1][2].context.browser.url, "https://justnotepad.com/");
  assert.match(calls[1][2].context.lastWritten, /Rex lived beside/);
  // C: the page is named explicitly
  const c = router.route("Write the next paragraph on the notepad", { source: "text" });
  assert.equal(c.kind, "agent");
  assert.equal(calls[2][2].followUp, true);
  // D: the same words spoken: same router, same session, source recorded
  const d = router.route("Noah, continue the story", { source: "voice" });
  assert.equal(d.kind, "agent");
  assert.equal(calls[3][1], "continue the story", "the wake word is not part of the task");
  assert.equal(calls[3][2].source, "voice");
  assert.equal(calls[3][2].context.sessionId, session.id);
});

test("router: without a recent task 'continue the story' is chat, not a phantom agent run", () => {
  const { calls, router } = routerWithFakeAgent();
  const r = router.route("continue the story", { source: "voice" });
  assert.equal(r.kind, "chat");
  assert.equal(calls.length, 0);
  assert.equal(router.route("hello there", { source: "text" }).kind, "chat");
});

test("router E: 'continue' resumes the paused run instead of starting another", () => {
  const { session, calls, router } = routerWithFakeAgent();
  session.runStarted({ runId: "r1", taskId: "t1", goal: "write a story", source: "text" });
  session.runExecuting();
  session.paused("takeover");
  const r = router.route("continue", { source: "voice" });
  assert.deepEqual([r.kind, r.control], ["control", "resume"]);
  assert.deepEqual(calls.map((c) => c[0]), ["resume"]);
  assert.equal(calls.some((c) => c[0] === "submit"), false);
});

test("router: voice cannot approve a confirmation; 'stop' stops; 'continue' when idle is a new run inside the same session", () => {
  const f = routerWithFakeAgent();
  f.session.runStarted({ runId: "r1", taskId: "t1", goal: "buy the shoes", source: "text" });
  f.session.runExecuting();
  f.session.paused("waiting");
  f.agent.resume = () => ({ ok: false, reason: "needs_confirmation" });
  assert.match(f.router.route("continue", { source: "voice" }).reply, /confirmation card/);
  assert.equal(f.router.route("stop", { source: "voice" }).control, "stop");
  assert.equal(f.calls.at(-1)[0], "stop");

  const g = routerWithFakeAgent();
  runOnce(g.session, "Open JustNotepad and write a short dinosaur story");
  const r = g.router.route("continue", { source: "voice" });
  assert.equal(r.kind, "agent");
  assert.match(g.calls[0][1], /Continue with what we were doing: Open JustNotepad/);
  assert.equal(g.calls[0][2].followUp, true);
});

test("router: 'turn on agentic mode' is answered, not run", () => {
  const { calls, router } = routerWithFakeAgent();
  const r = router.route("turn on agentic mode", { source: "voice" });
  assert.equal(r.handled, true);
  assert.equal(calls.length, 0);
  assert.match(r.reply, /already on/);
});

// ---- the assistant panel's Auto / Chat / Agent switch ----------------------------------------------------------

test("mode 'chat': a message that would be a browser task is still just chat, and nothing reaches the agent", () => {
  const { calls, router } = routerWithFakeAgent();
  for (const g of ["open youtube and search for lo-fi music", "fill this form up for me", "how are you doing?"]) {
    const r = router.route(g, { source: "text", mode: "chat" });
    assert.deepEqual([r.handled, r.kind], [false, "chat"], g);
  }
  assert.equal(calls.length, 0, "chat mode never submits an agent task");
});

test("mode 'chat': 'stop' and 'continue' still control a running task (they never start one)", () => {
  const { session, calls, router } = routerWithFakeAgent();
  session.runStarted({ runId: "r1", taskId: "t1", goal: "open youtube and search for lo-fi music", source: "text" });
  session.runExecuting(); // still running
  const r = router.route("stop", { source: "text", mode: "chat" });
  assert.deepEqual([r.handled, r.kind, r.control], [true, "control", "stop"]);
  assert.equal(calls.at(-1)[0], "stop");
});

test("mode 'agent': every message is a browser task, even ones the classifier would call chat", () => {
  const { calls, router } = routerWithFakeAgent();
  const r = router.route("summarise this page for me", { source: "text", mode: "agent" });
  assert.deepEqual([r.handled, r.kind], [true, "agent"]);
  assert.equal(calls[0][1], "summarise this page for me");
  const hi = router.route("hello there", { source: "text", mode: "agent" });
  assert.deepEqual([hi.handled, hi.kind], [true, "agent"]);
  assert.equal(calls.length, 2);
});

test("mode 'auto' (and a missing/unknown mode) keeps the classifier: chat stays chat, tasks still run", () => {
  const { calls, router } = routerWithFakeAgent();
  assert.equal(router.route("hello there", { source: "text", mode: "auto" }).kind, "chat");
  assert.equal(router.route("hello there", { source: "text" }).kind, "chat");
  assert.equal(router.route("open youtube and search for lo-fi music", { source: "text", mode: "auto" }).kind, "agent");
  assert.equal(router.route("open youtube and search for lo-fi music", { source: "text" }).kind, "agent");
  assert.equal(calls.length, 2);
});

// ---- the agent's queue policy ----------------------------------------------------------------------------------

function fakeCore() {
  const bus = new EventBus();
  const session = new AgentSession({ bus });
  const safety = new SafetyController({ bus, getPolicy: () => ({}) });
  return { bus, session, safety, monitor: { start() {}, stop() {} } };
}
function agentWithControlledRuns() {
  const core = fakeCore();
  const config = { get: () => ({ enabled: true }) };
  const router = { isAvailable: () => true, stats: { byModel: {} } };
  const agent = new NoahAgent({ core, router, config, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "noah-agent-test-")) });
  const started = [];
  const gates = [];
  agent._run = async ({ task, run }) => {
    core.safety.beginTask(task.id);
    started.push({ goal: task.goal, followUp: run.followUp, source: run.source, superseded: () => run.superseded });
    await new Promise((resolve) => gates.push(resolve));
    core.safety.endTask();
  };
  return { core, agent, started, gates, finishCurrent: () => gates.shift()() };
}
const tick = () => new Promise((r) => setImmediate(r));

test("agent policy: idle -> runs; working -> newest waits (latest wins); same words twice -> one run", async () => {
  const { agent, started, finishCurrent } = agentWithControlledRuns();
  const id1 = agent.submit("first task", { source: "text" });
  await tick();
  assert.equal(started.length, 1);
  agent.submit("second task", { source: "voice" });
  const id3 = agent.submit("third task", { source: "text" });
  assert.equal(agent.queue.length, 1, "one place in line");
  assert.equal(agent.queue[0].task.goal, "third task", "the newest instruction replaces the older waiting one");
  assert.equal(agent.submit("Third task!", { source: "voice" }), id3, "the same words arriving twice (voice + text) are one run");
  assert.equal(agent.queue.length, 1);
  assert.notEqual(id1, id3);
  finishCurrent();
  await tick();
  await tick();
  assert.deepEqual(started.map((s) => s.goal), ["first task", "third task"]);
  finishCurrent();
});

test("agent policy: a paused run is REPLACED by the next instruction; the session is untouched", async () => {
  const { core, agent, started, gates } = agentWithControlledRuns();
  const sessionId = core.session.id;
  agent.submit("write a story", { source: "text" });
  await tick();
  core.safety.pause("takeover");
  assert.equal(core.safety.paused, true);
  let stopped = null;
  core.safety.on("stopped", ({ reason }) => (stopped = reason));
  agent.submit("open example.com instead", { source: "voice", followUp: false });
  assert.equal(stopped, "superseded");
  assert.equal(started[0].superseded(), true);
  assert.equal(core.safety.paused, false, "a stopped task is not 'paused'");
  gates.shift()(); // the old run ends
  await tick();
  await tick();
  assert.deepEqual(started.map((s) => s.goal), ["write a story", "open example.com instead"]);
  assert.equal(core.session.id, sessionId);
});

test("agent controls: resume() never approves a confirmation; stop() clears the queue; pause() needs a run", async () => {
  const { core, agent, started, finishCurrent } = agentWithControlledRuns();
  assert.deepEqual(agent.pause(), { ok: false, reason: "idle" });
  agent.submit("a", {});
  await tick();
  agent.submit("b", {});
  assert.equal(agent.pause().ok, true);
  assert.equal(agent.resume().ok, true);
  assert.deepEqual(agent.resume(), { ok: false, reason: "not_paused" });
  core.safety.pause("user");
  const pending = core.safety.confirm({ summary: "Pay $5" });
  assert.deepEqual(agent.resume(), { ok: false, reason: "needs_confirmation" });
  assert.equal(core.safety.paused, true, "still paused: only the card can approve");
  core.safety.denyAllPending("test");
  await pending;
  agent.stop("user");
  assert.equal(agent.queue.length, 0);
  finishCurrent();
  await tick();
  assert.equal(started.length, 1, "the queued task did not start after stop()");
});

// ---- deadlines and friendly errors -----------------------------------------------------------------------------

test("timed: a tool that never answers ends the step with a clear error; stop still wins", async () => {
  const never = new Promise(() => {});
  await assert.rejects(timed(never, null, 30, "The page"), (e) => e instanceof ToolTimeoutError && e.code === "tool_timeout" && /did not respond within/.test(e.message));
  assert.equal(await timed(Promise.resolve(5), null, 1000, "x"), 5);
  const c = new AbortController();
  const p = timed(never, c.signal, 5000, "x");
  c.abort();
  await assert.rejects(p, (e) => e.code === "STOPPED");
});

test("friendlyError / describeAction: what the user reads is plain language, never an internal error or the model's own words", () => {
  assert.match(friendlyError(new ToolTimeoutError("The page did not respond within 30s")), /try again in a moment/);
  assert.match(friendlyError(new Error("no active browser context")), /tab I was working in was closed/);
  assert.match(friendlyError(new Error("fetch failed")), /could not reach the model/);
  assert.match(friendlyError(new Error("Page.getFrameTree timed out after 8000ms")), /page stopped responding/, "a raw CDP timeout is explained, not quoted");
  assert.match(friendlyError(new Error("I could not do it")), /could not do it/, "anything else keeps its own words");
  assert.equal(describeAction({ action: "type", text: "hi" }), "Typing…");
  assert.equal(describeAction({ action: "scroll" }), "Scrolling…");
  assert.equal(describeAction({ action: "navigate", url: "https://www.youtube.com/watch?v=1" }), "Opening youtube.com…");
  assert.equal(describeAction(undefined), "Working…");
});

// ---- a frozen page must not keep the agent busy forever -----------------------------------------------------------

test("browser.releaseAll is bounded: a page that never answers cannot hold the whole agent (the next instruction) hostage", async () => {
  const { BrowserController } = require("../../browser/browser-controller.cjs");
  let detached = 0;
  const hang = () => new Promise(() => {});
  const fake = {
    _ctx: new Map([["t1", { driver: { releaseAll: hang }, observer: { disable: hang }, cdp: { detach: () => detached++ } }]]),
    frame: { x: 1 },
    _dialogTimers: new Map(),
  };
  const t0 = Date.now();
  await BrowserController.prototype.releaseAll.call(fake);
  assert.ok(Date.now() - t0 < 6500, "returned after its own deadline instead of hanging");
  assert.equal(detached, 1, "and the debugger was detached anyway");
  assert.equal(fake._ctx.size, 0);
  assert.equal(fake.frame, null);
});

// ---- takeover only reacts while a task runs ---------------------------------------------------------------------

test("takeover: clicks and scrolls after a task has ended do NOT pause anything (stale task id was the cause of idle 'you took control')", () => {
  const bus = new EventBus();
  const safety = new SafetyController({ bus, getPolicy: () => ({}) });
  const tabs = new EventEmitter();
  const monitor = new TakeoverMonitor({ safety, tabs, mainWindow: {}, screen: {}, getConfig: () => ({}), isSynthetic: () => false });
  const click = () => monitor.pageInput({ type: "mousedown", t: Date.now() });
  safety.beginTask("t1");
  click();
  assert.equal(safety.paused, true, "during a task a real click is a takeover");
  safety.endTask();
  assert.equal(safety.taskId, "t1", "the id is kept for the audit trail...");
  assert.equal(safety.active, false, "...but no task is active");
  safety.resume();
  click();
  assert.equal(safety.paused, false, "an ended task does not react to the user any more");
});

test("takeover: a real click BETWEEN Noah's keystrokes is a takeover; Noah's own click is not", () => {
  const bus = new EventBus();
  const safety = new SafetyController({ bus, getPolicy: () => ({}) });
  const monitor = new TakeoverMonitor({ safety, tabs: new EventEmitter(), mainWindow: {}, screen: {}, getConfig: () => ({}), isSynthetic: () => false });
  safety.beginTask("t1");
  // Noah types: a key dispatch just finished, so the trailing window of key events is open
  monitor.markSyntheticStart("key");
  monitor.markSyntheticEnd("key");
  monitor.pageInput({ type: "mousedown", t: Date.now() });
  assert.equal(safety.paused, true, "typing must not hide the user's click");
  safety.resume();
  // Noah's own click: reported by the page inside the span of Noah's mouse dispatch
  monitor.markSyntheticStart("mouse");
  const t = Date.now();
  monitor.markSyntheticEnd("mouse");
  monitor.pageInput({ type: "mousedown", t });
  assert.equal(safety.paused, false, "Noah's own click is never a takeover");
});

// ---- writing follow-ups ------------------------------------------------------------------------------------------

const STORY = "Once upon a time a small dinosaur named Rex lived beside a warm green river. Every morning Rex walked to the tall ferns and ate the sweet leaves. One day he heard a loud rumble behind the hills.";
const CONTEXT = { previousGoals: ["Open JustNotepad and write a short dinosaur story"], lastGoal: "Open JustNotepad and write a short dinosaur story", lastWritten: STORY, browser: { url: "https://justnotepad.com/" } };
const editorEl = (value) => ({ ref: "e5", role: "textbox", name: "Note", rect: { x: 0, y: 0, width: 800, height: 500 }, value, states: {} });
const NEXT = "The rumble grew louder until a huge herd of long necked giants marched over the hill. Rex hid behind a fern and watched them pass. When the dust cleared he followed them to a hidden valley full of glowing flowers.";

test("compose: 'continue the story' / 'next paragraph' resolve against the session's previous writing goal", () => {
  for (const g of ["Continue writing the story", "Write the next paragraph on the notepad", "continue the story", "make it longer", "go on writing"]) {
    const i = continuationIntentFrom(g, CONTEXT);
    assert.ok(i && i.continuation, g);
    assert.match(i.request, /dinosaur story/);
    assert.equal(i.existing, STORY);
  }
  assert.equal(continuationIntentFrom("Continue writing the story", null), null, "no session context: nothing to continue");
  assert.equal(continuationIntentFrom("search for dinosaur toys", CONTEXT), null);
});

test("compose: a continuation appends a NEW paragraph at the end of the existing text, once, and never repeats what is there", async () => {
  const composer = new Composer();
  const prompts = [];
  const pages = [];
  const generate = async (p, page) => (prompts.push(p), pages.push(page), prompts.length === 1 ? STORY : NEXT); // 1st answer just repeats the story
  const obs = { url: "https://justnotepad.com/", pageText: {} };
  const step1 = await composer.next({ taskId: "c1", goal: "Continue writing the story", obs, els: [editorEl("Once upon a time a small dinosaur named Rex…")], recent: [], generate, context: CONTEXT });
  assert.equal(step1.status, "continue", "the repeat was rejected and it asks again");
  const step2 = await composer.next({ taskId: "c1", goal: "Continue writing the story", obs, els: [editorEl("Once upon a time a small dinosaur named Rex…")], recent: [], generate, context: CONTEXT });
  assert.deepEqual(step2.actions.map((a) => a.action), ["click", "hotkey", "type"]);
  assert.equal(step2.actions[1].combo, "ctrl+End");
  assert.ok(step2.actions[2].text.startsWith("\n\n"), "a new paragraph, after what is already there");
  assert.ok(step2.actions[2].text.includes("giants marched over the hill"));
  assert.match(prompts[0], /^Write the next paragraph/, "worded so the hosted chat mode answers it instead of treating it as a command");
  assert.doesNotMatch(prompts[0], /Rex|"/, "the story is NOT quoted in the message: the hosted chat mode takes a quoted passage for a web search");
  assert.match(pages[0], /Rex/, "the story so far is the page the model reads");
  const done = await composer.next({ taskId: "c1", goal: "Continue writing the story", obs, els: [editorEl(NEXT)], recent: [{ ok: true, text: `type e5 "${NEXT.slice(0, 20)}…[200 chars]"` }], generate, context: CONTEXT });
  assert.equal(done.status, "done");
  assert.equal(repeatsExisting(NEXT, STORY), false);
  assert.equal(repeatsExisting(STORY, STORY), true);
});

// ---- honest metrics ---------------------------------------------------------------------------------------------

test("legacy adapter: steps it works out itself are marked local and counted as zero model calls; real round trips are counted", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ answer: NEXT }), text: async () => JSON.stringify({ answer: NEXT }) };
  };
  const p = new RexyLegacyProvider({ name: "rexy", baseURL: "https://legacy.example/predict", getKey: () => null, fetch: fetchImpl, options: { keyless: true } });
  const plan = await p.complete({ system: "s", messages: [], tools: [], toolChoice: "noah_plan", meta: { goal: "x", kind: "plan" } });
  assert.equal(plan.local, true);
  assert.equal(plan.remoteCalls, 0);
  const obs = { url: "https://justnotepad.com/", title: "JustNotepad", elements: [editorEl("Once upon a time…")], tabs: [], pageText: { viewport: "" } };
  const step = await p.complete({ system: "s", messages: [], tools: [], toolChoice: "noah_step", meta: { goal: "Continue writing the story", observation: obs, taskId: "m1", recentActions: [], context: CONTEXT, followUp: true } });
  assert.equal(step.local, true);
  assert.equal(step.remoteCalls, 1, "the composer really asked the hosted model once");
  assert.equal(step.toolCalls[0].args.actions[2].action, "type");
  assert.equal(calls.length, 1);
});
