// Noah/test/unit/autonomy-control-tools.test.cjs - the tools that run the mission itself (Noah/autonomy/control-tools.cjs)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ControlTools, DEFS } = require("../../autonomy/control-tools.cjs");
const { MissionState } = require("../../autonomy/mission-state.cjs");
const { GoalVerifier } = require("../../autonomy/goal-verifier.cjs");
const { Lifecycle } = require("../../autonomy/lifecycle.cjs");
const { sanitizeSchema } = require("../../models/google.cjs");

function make(commands = {}, files = {}) {
  const state = new MissionState({ objective: "make it work" });
  const fake = { commands, files };
  const verifier = new GoalVerifier({
    state,
    run: async (cmd) => fake.commands[cmd] || { exitCode: 0, output: "" },
    exists: async (p) => p in fake.files,
    readFile: async (p) => { if (!(p in fake.files)) throw new Error("ENOENT"); return fake.files[p]; },
  });
  const lc = new Lifecycle({ canPlan: () => (state.criteria.length ? true : "no criteria"), canSucceed: () => verifier.canSucceed() });
  return { state, verifier, lc, fake, ctl: new ControlTools({ state, verifier, lifecycle: lc }) };
}
test("the control tools are valid function-calling schemas, with items on every array and no tool for loosening the goal", () => {
  const { ctl } = make();
  const schemas = ctl.schemas();
  assert.deepEqual(schemas.map((s) => s.name).sort(), ["ask_user", "claim_assert", "criteria_add", "finish", "give_up", "hypothesis_add", "hypothesis_resolve", "next_set", "plan_set", "run_checks", "step_update", "tried_add"]);
  for (const s of schemas) {
    assert.match(s.name, /^[a-z_]+$/);
    assert.equal(s.parameters.type, "object");
    for (const [k, v] of Object.entries(s.parameters.properties)) {
      assert.ok(v.type && v.description, `${s.name}.${k}`);
      if (v.type === "array") assert.ok(v.items && v.items.type, `${s.name}.${k} needs items (Gemini rejects an array without them)`);
    }
    assert.deepEqual(sanitizeSchema(s.parameters), s.parameters, `${s.name}: the Gemini sanitiser would change it`);
  }
  const criteria = schemas.find((s) => s.name === "criteria_add").parameters.properties.criteria;
  assert.ok(Object.keys(criteria.items.properties).length >= 10, "an object item must list its fields: Gemini rejects an empty OBJECT");
  assert.equal(schemas.some((s) => /remove|delete|drop|clear|loosen/.test(s.name)), false);
  assert.deepEqual(schemas.find((s) => s.name === "step_update").parameters.properties.status.enum, ["active", "done", "blocked"]);
  assert.deepEqual(schemas.find((s) => s.name === "finish").parameters.required, ["summary"]);
});

test("kinds: what observes, what bookkeeps, what ends", () => {
  const { ctl } = make();
  assert.deepEqual(["criteria_add", "plan_set", "run_checks", "finish", "ask_user", "give_up", "nope"].map((n) => ctl.kindOf(n)), ["control", "control", "inspect", "end", "end", "end", null]);
  assert.equal(ctl.has("finish"), true);
  assert.equal(ctl.has("toString"), false, "not fooled by inherited property names");
});

test("criteria_add stores the criteria, opens the planning phase, and refuses a bad one without storing any", async () => {
  const { ctl, state, lc } = make();
  assert.equal(lc.phase, "understand");
  const bad = await ctl.execute("criteria_add", { criteria: [{ kind: "command", cmd: "npm test" }, { kind: "telepathy" }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "invalid_arguments");
  assert.match(bad.message, /unknown criterion kind "telepathy"/);
  assert.equal(state.criteria.length, 0, "all or nothing");
  assert.equal(lc.phase, "understand");
  const ok = await ctl.execute("criteria_add", { criteria: [{ kind: "command", cmd: "npm test", description: "tests pass" }, { kind: "file_exists", path: "dist/app.js" }] });
  assert.deepEqual([ok.ok, ok.added], [true, ["c1", "c2"]]);
  assert.equal(lc.phase, "plan");
  assert.equal((await ctl.execute("criteria_add", { criteria: [{ kind: "claim", description: "report the result" }] })).added[0], "c3");
  assert.equal(lc.phase, "plan", "adding more later does not move the phase");
  assert.match((await ctl.execute("criteria_add", { criteria: ["npm test"] })).message, /item 1 of "criteria" must be an object/);
  assert.equal((await ctl.execute("criteria_add", { criteria: JSON.stringify([{ kind: "file_exists", path: "x" }]) })).ok, true, "a list sent as JSON text is accepted");
  assert.match((await ctl.execute("criteria_add", {})).message, /"criteria" is required/);
});

test("plan and steps", async () => {
  const { ctl, state } = make();
  const p = await ctl.execute("plan_set", { steps: ["read the code", "fix the bug", "run the tests"] });
  assert.deepEqual(p.steps, ["s1 [pending] read the code", "s2 [pending] fix the bug", "s3 [pending] run the tests"]);
  assert.equal((await ctl.execute("step_update", { id: "s1", status: "active" })).ok, true);
  assert.equal(state.activeStep().id, "s1");
  assert.match((await ctl.execute("step_update", { id: "s1", status: "done" })).message, /give the evidence/);
  assert.equal((await ctl.execute("step_update", { id: "s1", status: "done", evidence: "read src/index.js: it requires ./util" })).ok, true);
  assert.equal((await ctl.execute("step_update", { id: "s2", status: "blocked", why: "needs a key" })).ok, true);
  assert.match((await ctl.execute("step_update", { id: "s9", status: "active" })).message, /unknown step s9/);
  assert.match((await ctl.execute("step_update", { id: "s2", status: "finished" })).message, /one of: active, done, blocked/);
  const re = await ctl.execute("plan_set", { steps: ["read the code", "fix the other bug", "run the tests"], reason: "found a second bug" });
  assert.equal(re.steps[0], "s1 [done] read the code");
  assert.match((await ctl.execute("plan_set", { steps: [] })).message, /at least one step/);
});

test("hypotheses: an old rejected idea cannot come back as new", async () => {
  const { ctl } = make();
  const a = await ctl.execute("hypothesis_add", { text: "the import path is wrong" });
  assert.deepEqual([a.ok, a.id, a.existing], [true, "h1", false]);
  assert.equal((await ctl.execute("hypothesis_add", { text: "The import path is wrong" })).existing, true);
  assert.match((await ctl.execute("hypothesis_resolve", { id: "h1", status: "maybe", evidence: "x" })).message, /one of: confirmed, rejected/);
  assert.equal((await ctl.execute("hypothesis_resolve", { id: "h1", status: "rejected", evidence: "the path is right; the file is empty" })).ok, true);
  const again = await ctl.execute("hypothesis_add", { text: "the import path is wrong" });
  assert.equal(again.ok, false);
  assert.equal(again.code, "already_rejected");
  assert.match(again.message, /REJECTED.*the file is empty.*different explanation/);
  assert.match((await ctl.execute("hypothesis_resolve", { id: "h7", status: "confirmed", evidence: "x" })).message, /unknown hypothesis/);
});

test("claims, next, tried", async () => {
  const { ctl, state } = make();
  await ctl.execute("criteria_add", { criteria: [{ kind: "claim", description: "report the price" }, { kind: "file_exists", path: "a" }] });
  assert.match((await ctl.execute("claim_assert", { id: "c1", evidence: "done" })).message, /concrete evidence/);
  assert.match((await ctl.execute("claim_assert", { id: "c2", evidence: "I created that file already" })).message, /machine-checked/);
  const c = await ctl.execute("claim_assert", { id: "c1", evidence: "the shop page lists it at 61,999" });
  assert.equal(c.ok, true);
  assert.match(c.note, /ASSERTED/);
  assert.equal((await ctl.execute("next_set", { text: "open src/index.js" })).ok, true);
  assert.equal(state.next, "open src/index.js");
  assert.equal((await ctl.execute("tried_add", { what: "reinstalling", outcome: "failed", note: "same error" })).ok, true);
  assert.match((await ctl.execute("tried_add", { what: "x", outcome: "great" })).message, /one of: worked, failed, partial/);
  assert.equal(state.tried.length, 1);
});

test("run_checks reports where things stand without ending the mission", async () => {
  const { ctl, lc, fake } = make({ "npm test": { exitCode: 1, output: "1 failing" } });
  await ctl.execute("criteria_add", { criteria: [{ kind: "command", cmd: "npm test", description: "tests pass" }] });
  const r = await ctl.execute("run_checks", {});
  assert.deepEqual([r.ok, r.passed, r.reason], [true, false, "failing"]);
  assert.match(r.summary, /^FAIL .*tests pass.*1 failing/);
  assert.equal(r.failing[0].id, "c1");
  assert.equal(lc.isTerminal, false);
  fake.commands["npm test"] = { exitCode: 0, output: "ok" };
  assert.equal((await ctl.execute("run_checks", { force: true })).passed, true);
});

test("finish: refused before the work was done and looked at; refused while a check fails; accepted only when everything is green", async () => {
  const { ctl, lc, fake, state } = make({ "npm test": { exitCode: 1, output: "1 failing: parser" } });
  assert.equal((await ctl.execute("finish", { summary: "done" })).code, "not_ready", "nothing set up yet");
  await ctl.execute("criteria_add", { criteria: [{ kind: "command", cmd: "npm test", description: "tests pass" }] });
  const early = await ctl.execute("finish", { summary: "done" });
  assert.equal(early.code, "not_ready");
  assert.match(early.message, /Do or check something first/, "in the planning phase: nothing has been observed yet");
  assert.equal(lc.phase, "plan");

  lc.to("act");
  lc.to("observe");
  lc.to("reason");
  const red = await ctl.execute("finish", { summary: "I fixed it, honest" });
  assert.equal(red.ok, false);
  assert.equal(red.code, "not_verified");
  assert.match(red.message, /NOT done: still failing: c1/);
  assert.match(red.verification, /FAIL .*1 failing: parser/);
  assert.equal(lc.phase, "reason", "back to work");
  assert.equal(lc.isTerminal, false);

  fake.commands["npm test"] = { exitCode: 0, output: "all passing" };
  state.recordFileChange({ path: "src/parser.js", op: "edit" });
  const green = await ctl.execute("finish", { summary: "fixed the parser" });
  assert.deepEqual([green.ok, green.ended], [true, "succeeded"]);
  assert.match(green.verification, /^PASS .*tests pass/);
  assert.equal(lc.terminal.kind, "succeeded");
  assert.equal(lc.terminal.reason, "fixed the parser");
});

test("finish cannot be talked into success: an edit after a green run makes it stale, and the checks run again", async () => {
  const { ctl, lc, state, verifier, fake } = make();
  await ctl.execute("criteria_add", { criteria: [{ kind: "command", cmd: "npm test" }] });
  lc.to("act");
  lc.to("observe");
  lc.to("reason");
  await verifier.runAll(); // green...
  assert.equal(verifier.status().passed, true);
  fake.commands["npm test"] = { exitCode: 1, output: "broke" };
  state.recordFileChange({ path: "x.js" }); // ...then an edit, which makes that green result stale (and the tests would now fail)
  const r = await ctl.execute("finish", { summary: "still green, trust me" });
  assert.equal(r.code, "not_verified");
  assert.match(r.message, /still failing/, "the stale result was NOT trusted: the checks were run again");
  assert.equal(lc.isTerminal, false);
});

test("ask_user ends the mission in a state that can be resumed, as input or permission", async () => {
  for (const [kind, ending] of [[undefined, "blocked_input"], ["input", "blocked_input"], ["permission", "blocked_permission"]]) {
    const { ctl, lc } = make();
    const r = await ctl.execute("ask_user", { question: "Which database should I use?", ...(kind ? { kind } : {}) });
    assert.deepEqual([r.ok, r.ended], [true, ending]);
    assert.equal(lc.terminal.kind, ending);
    assert.equal(lc.terminal.reason, "Which database should I use?");
    assert.equal(lc.terminal.resumable, true);
  }
  assert.match((await make().ctl.execute("ask_user", { question: "q", kind: "whim" })).message, /one of: input, permission/);
});

test("give_up is a finding: refused until real work was tried, and needs a reason", async () => {
  const { ctl, lc, state } = make();
  const early = await ctl.execute("give_up", { reason: "this is impossible because I said so" });
  assert.equal(early.code, "too_early");
  assert.match(early.message, /only looked into 0 things/);
  state.recordCommand({ cmd: "a", exitCode: 1 });
  state.recordCommand({ cmd: "b", exitCode: 1 });
  assert.equal((await ctl.execute("give_up", { reason: "this is impossible because I said so" })).code, "too_early");
  state.noteExplored("fs_read:src/index.js"); // reading counts as investigating, like commands and edits
  assert.match((await ctl.execute("give_up", { reason: "no" })).message, /give the reason and the evidence/);
  const r = await ctl.execute("give_up", { reason: "The required service shut down in 2024: checked its site and the registry" });
  assert.deepEqual([r.ok, r.ended], [true, "impossible"]);
  assert.equal(lc.terminal.kind, "impossible");
  assert.equal(lc.terminal.resumable, false);
});

test("unknown arguments are refused with the valid ones", async () => {
  const { ctl } = make();
  const r = await ctl.execute("plan_set", { step: ["a"] });
  assert.equal(r.code, "invalid_arguments");
  assert.match(r.message, /unknown argument "step" \(valid: steps, reason\)/);
  assert.ok(Object.keys(DEFS).length === 12);
});
