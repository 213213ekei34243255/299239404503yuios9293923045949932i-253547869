// Noah/test/unit/mission-intake.test.cjs - a long request reaches the mission WHOLE (it used to be cut to 1000 / 600 / 300 characters, silently).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ControlTools } = require("../../autonomy/control-tools.cjs");
const { MissionState } = require("../../autonomy/mission-state.cjs");
const { GoalVerifier } = require("../../autonomy/goal-verifier.cjs");
const { Lifecycle } = require("../../autonomy/lifecycle.cjs");
const { MAX_REQUEST_CHARS, FULL_VIEW_CHARS } = require("../../intake/request.cjs");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const request = (n) => `Please do all of these, in order:\n${Array.from({ length: n }, (_, i) => `${i + 1}. Question ${i + 1}: what is ${i + 1} plus 100?`).join("\n")}`;

function make(objective) {
  const state = new MissionState({ objective });
  const verifier = new GoalVerifier({ state, run: async () => ({ exitCode: 0, output: "" }), exists: async () => true, readFile: async () => "" });
  const lc = new Lifecycle({ canPlan: () => true, canSucceed: () => verifier.canSucceed() });
  return { state, lc, ctl: new ControlTools({ state, verifier, lifecycle: lc }) };
}

test("the objective is stored whole (not cut to 1000 characters), with line endings normalised and nothing else changed", () => {
  const text = request(80); // ~4k characters
  assert.ok(text.length > 3000);
  const s = new MissionState({ objective: text.replace(/\n/g, "\r\n") });
  assert.equal(s.objective, text);
  assert.equal(MissionState.restore(s.snapshot()).objective, text, "and it survives a save and restore");
});

test("a request up to the full-view limit is shown to the model whole, in the briefing, however small the briefing budget", () => {
  const text = request(120);
  assert.ok(text.length > 1000 && text.length <= FULL_VIEW_CHARS);
  const s = new MissionState({ objective: text });
  for (const maxChars of [6000, 2500, 150]) {
    const out = s.render({ maxChars });
    assert.ok(out.includes(text), `whole at maxChars ${maxChars}`);
    assert.ok(out.includes("120. Question 120: what is 120 plus 100?"));
  }
});

test("a request beyond the full-view limit shows a numbered digest, announces what it leaves out and how to read it; request_read returns it exactly", async () => {
  const text = request(900);
  assert.ok(text.length > FULL_VIEW_CHARS * 2);
  const { state, ctl } = make(text);
  assert.equal(state.objective, text);
  const out = state.render();
  assert.match(out, /a long request: \d+ characters, 900 parts; call request_read/);
  assert.match(out, /^80\. Question 80/m, "the first parts are listed");
  assert.match(out, /\(\+820 more parts: read the full text with request_read\)/, "and the rest is announced, with the way to read it, never silently left out");
  assert.ok(out.length < 14000, `briefing stayed bounded: ${out.length}`);
  let got = "", offset = 0, calls = 0;
  for (;;) {
    const r = await ctl.execute("request_read", { offset });
    assert.equal(r.ok, true);
    got += r.text; calls++;
    if (r.next === null) break;
    assert.equal(r.next, offset + r.text.length);
    offset = r.next;
  }
  assert.equal(got, text, "reading it in slices gives back the request, character for character");
  assert.ok(calls >= 2);
  assert.equal(ctl.kindOf("request_read"), "inspect");
});

test("finish: an answer that skips questions of the request is sent back ONCE, naming exactly which; the second try goes through", async () => {
  const objective = "Answer these:\n1. What is the capital of France?\n2. What is the largest planet in the solar system?\n3. Who wrote Hamlet?";
  const { ctl, lc } = make(objective);
  await ctl.execute("criteria_add", { criteria: [{ kind: "claim", description: "answers given" }] });
  lc.to("act"); lc.to("observe"); lc.to("reason");
  const first = await ctl.execute("finish", { summary: "1. The capital of France is Paris." });
  assert.equal(first.code, "incomplete_answer");
  assert.match(first.message, /does not answer 2 of the 3 questions/);
  assert.match(first.message, /part 2 .*planet/);
  assert.match(first.message, /part 3 .*Hamlet/);
  assert.doesNotMatch(first.message, /part 1/);
  assert.equal(lc.isTerminal, false, "the mission goes on");
  const second = await ctl.execute("finish", { summary: "1. Paris. 2. Jupiter is the largest planet. 3. Shakespeare wrote Hamlet." });
  assert.notEqual(second.code, "incomplete_answer");
});

test("a request with one part is never second-guessed at finish", async () => {
  const { ctl, lc } = make("What is the capital of France?");
  await ctl.execute("criteria_add", { criteria: [{ kind: "claim", description: "answered" }] });
  lc.to("act"); lc.to("observe"); lc.to("reason");
  assert.notEqual((await ctl.execute("finish", { summary: "Paris" })).code, "incomplete_answer");
});

test("the IPC entrances refuse only a message over the limit, say so with the numbers, and never cut one below it", () => {
  const src = fs.readFileSync(path.join(ROOT, "Noah/ipc.cjs"), "utf8");
  assert.ok(src.includes("const { MAX_REQUEST_CHARS } = require(\"./intake/request.cjs\");"));
  assert.ok(!/length > 4000/.test(src), "the old 4000-character limit is gone");
  assert.equal((src.match(/length > MAX_REQUEST_CHARS\) return \{ ok: false, error: `That message is too long/g) || []).length, 2);
  assert.ok(MAX_REQUEST_CHARS >= 100000);
});

test("the briefing of a multi-part request carries the rule to deal with every part; a one-part request does not", () => {
  assert.match(new MissionState({ objective: request(5) }).render(), /The user's message has 5 parts\. Deal with EVERY one/);
  assert.doesNotMatch(new MissionState({ objective: "open notepad and type hello" }).render(), /Deal with EVERY one/);
});
