// Noah/test/unit/sensitive-routing.test.cjs
//
// Reported bug: a benign task ("fill in my name and email on this feedback form and submit it") was refused outright -
// "No TRUSTED model is available for this sensitive task right now" - even though nothing about it matches Noah's own
// deterministic sensitivity classifier (triage's regex over the goal text). Root cause: the PLANNER MODEL's own,
// unverifiable "this feels sensitive" guess (`plan.sensitive`) was OR'd into `task.sensitive`, which gates which model
// is allowed to run the whole task. A model's own opinion should never be able to escalate past what our code-enforced
// classifier decided - that is backwards from "a model cannot talk its way past a code-enforced gate". Individual risky
// ACTIONS (typing into a password/payment field, leaving a sensitive site) still go through their OWN, separate
// confirmation gate in safety/risk.cjs regardless of this fix.

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { EventBus } = require("../../events.cjs");
const { AgentSession } = require("../../agent/session.cjs");
const { SafetyController } = require("../../safety/safety-controller.cjs");
const { NoahAgent } = require("../../agent/noah-agent.cjs");
const { triage } = require("../../agent/planner.cjs");
const intent = require("../../agent/intent.cjs");

const GOAL = "Go to this website and then answer all the questions on the google form scroll and check and then submit it as well my name is Shaun Sunil and email id is abrahamshaunsunil@gmail.com";

test("'answer the questions on this form' reaches the agent instead of falling to plain chat (it used to get a hallucinated 'sure, go ahead and fill it out yourself')", () => {
  for (const g of ["Answer all other questions please on this form", "Answer all other questions in the page", "please answer the rest of the questions"]) {
    assert.equal(intent.looksLikeBrowserTask(g) || intent.isFollowUp(g), true, g);
  }
});

test("triage: filling in one's own name/email on a feedback form is NOT flagged sensitive by our own classifier", () => {
  assert.equal(triage(GOAL).sensitive, false);
});

test("a benign task is not blocked just because the PLANNER MODEL guessed 'sensitive' - only our own classifier gates which model may run it", async () => {
  const bus = new EventBus();
  const session = new AgentSession({ bus });
  const safety = new SafetyController({ bus, getPolicy: () => ({}) });
  const seenSensitive = []; // every `sensitive` value router.call()/usable() was actually invoked with
  const fakeObs = {
    url: "https://docs.google.com/forms/d/e/fake/viewform", title: "Feedback", loading: false,
    viewport: { width: 1280, height: 800, zoomFactor: 1, scrollY: 0, scrollHeight: 800 },
    tabs: [{ id: "t1", active: true, title: "Feedback", url: "https://docs.google.com/forms/d/e/fake/viewform" }],
    elements: [], pageText: { viewport: "" },
  };
  const core = {
    bus, session, safety,
    monitor: { start() {}, stop() {} },
    browser: {
      current: async () => {},
      newTab: async () => {},
      observe: async () => fakeObs,
      releaseAll: async () => {},
      targetTabId: "t1",
    },
    executor: { setGoalLine() {}, wantVisual: false, pendingImage: null },
  };
  const config = { get: () => ({ enabled: true, sessionMode: "user", perception: { screenshot: {}, tokenBudget: {} }, limits: { maxSteps: 5, maxWallMs: 60000, maxModelCalls: 10, maxConsecutiveFailures: 3, stepTimeoutMs: 30000, observeTimeoutMs: 30000, actionTimeoutMs: 30000 }, humanLike: false, autoDecide: true, perceptionMode: undefined }) };
  const router = {
    isAvailable: () => true,
    stats: { byModel: {} },
    usable: (role, opts = {}) => {
      if (role === "browser") seenSensitive.push(opts.sensitive);
      return [{ provider: "fake", model: "fake-1", info: {}, weak: false, trusted: true, key: "fake:fake-1" }];
    },
    call: async (role, request, opts = {}) => {
      if (role === "browser") {
        seenSensitive.push(opts.sensitive);
        return { text: "", toolCalls: [{ name: "noah_step", args: { status: "done", summary: "Filled in the form.", result: "Done." } }], usage: { inputTokens: 1, outputTokens: 1 }, provider: "fake", modelId: "fake-1", latencyMs: 1 };
      }
      // planner role: the MODEL's own guess says "sensitive" even though the goal text does not match our regex
      return { text: "", toolCalls: [{ name: "noah_plan", args: { objective: request.goal || GOAL, complexity: "simple", steps: [GOAL], success_criteria: [], sensitive: true, needs_visual: false, sites: [] } }], usage: { inputTokens: 1, outputTokens: 1 }, provider: "fake", modelId: "fake-1" };
    },
  };
  const agent = new NoahAgent({ core, router, config, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "noah-sensitive-test-")) });

  const id = agent.submit(GOAL, { source: "text" });
  const result = await new Promise((resolve) => agent.once("finished", resolve));

  assert.equal(result.task.status, "completed", "the task actually ran and finished, instead of being refused outright");
  assert.equal(result.task.plan.sensitive, true, "the planner's own guess is still recorded (not discarded, just not authoritative)");
  assert.ok(seenSensitive.length > 0, "the router was actually consulted");
  assert.ok(seenSensitive.every((s) => s === false), `router.call/usable must be asked with our classifier's answer (false), not the planner's guess: saw ${JSON.stringify(seenSensitive)}`);
});
