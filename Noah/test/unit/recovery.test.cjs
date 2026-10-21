// Noah/test/unit/recovery.test.cjs - RecoveryEngine (Noah/agent/recovery.cjs): failure hints, the identical-action loop
// detector, and the observe-only stall detector added after a live run got stuck alternating screenshot/read_page
// for 5 rounds on a 30-question form without ever attempting a click or a type (2026-10-21).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { RecoveryEngine } = require("../../agent/recovery.cjs");

const ok = (action, extra = {}) => ({ action, result: { ok: true, method: "ax", ...extra } });
const fail = (action, code, extra = {}) => ({ action, result: { ok: false, code, message: "nope", ...extra } });
const act = (name, target) => ({ action: name, target });

test("a failed action is hinted and counted; success resets the count", () => {
  const r = new RecoveryEngine({ maxConsecutiveFailures: 4 });
  const a = r.assess([fail(act("click", { ref: "e1" }), "not_found")], { url: "https://x" });
  assert.equal(r.consecutiveFailures, 1);
  assert.match(a.notes[0], /not_found/);
  assert.match(a.notes[0], /Hint:/);
  assert.equal(a.forceVisual, true); // not_found -> visual hint
  r.assess([ok(act("click", { ref: "e2" }))], { url: "https://x" });
  assert.equal(r.consecutiveFailures, 0);
});

test("escalates after maxConsecutiveFailures, with the real count in the question", () => {
  const r = new RecoveryEngine({ maxConsecutiveFailures: 2 });
  r.assess([fail(act("click", { ref: "e1" }), "no_effect")], { url: "https://x" });
  const a = r.assess([fail(act("click", { ref: "e1" }), "no_effect")], { url: "https://x" });
  assert.equal(a.escalate.reason, "failures");
  assert.match(a.escalate.question, /last 2 attempts failed/);
});

test("the same (action, target, url) three times in the last five is a LOOP: a notice first, escalate once it keeps recurring", () => {
  // a SUCCESSFUL-but-useless repeat (not a failure), so this exercises the loop path in isolation from consecutiveFailures
  const r = new RecoveryEngine({ maxConsecutiveFailures: 100 });
  const scroll = () => [ok(act("scroll", { dy: 100 }))];
  r.assess(scroll(), { url: "https://x" });
  r.assess(scroll(), { url: "https://x" });
  const third = r.assess(scroll(), { url: "https://x" });
  assert.match(third.notes.join(" "), /LOOP: you have issued the same action three times/);
  assert.equal(third.escalate, null, "the first time, it's a nudge, not an escalation");
  // the notice cleared the signature history; it takes a fresh run of three to escalate
  r.assess(scroll(), { url: "https://x" });
  r.assess(scroll(), { url: "https://x" });
  const escalated = r.assess(scroll(), { url: "https://x" });
  assert.equal(escalated.escalate?.reason, "loop");
});

test("cycling through three DIFFERENT observation actions never repeats one signature 3x in a 5-window, so the OLD loop check alone misses it", () => {
  const r = new RecoveryEngine();
  const names = ["screenshot", "read_page", "find_element"];
  for (let i = 0; i < 9; i++) {
    const a = r.assess([ok(act(names[i % 3]))], { url: "https://x" });
    assert.equal(a.notes.filter((n) => /^LOOP:/.test(n)).length, 0, `round ${i} (${names[i % 3]}): the identical-action loop detector should not fire on a 3-way rotation`);
  }
});

test("STALLED: 3 rounds that only look (any mix of screenshot/read_page/find_element/wait) get ONE nudge, naming the real count", () => {
  const r = new RecoveryEngine();
  const round1 = r.assess([ok(act("screenshot"))], { url: "https://x" });
  assert.equal(round1.notes.filter((n) => /^STALLED:/.test(n)).length, 0);
  const round2 = r.assess([ok(act("read_page"))], { url: "https://x" });
  assert.equal(round2.notes.filter((n) => /^STALLED:/.test(n)).length, 0, "two is not yet a stall");
  const round3 = r.assess([ok(act("find_element"))], { url: "https://x" });
  assert.equal(round3.notes.filter((n) => /^STALLED:/.test(n)).length, 1);
  assert.match(round3.notes.join(" "), /STALLED: 3 rounds in a row/);
  assert.match(round3.notes.join(" "), /give_up/);
  assert.equal(round3.escalate, null, "a nudge first, not yet an escalation");
  // it keeps nudging-but-not-escalating through round 5, then escalates at round 6, not before and not never
  const round4 = r.assess([ok(act("wait"))], { url: "https://x" });
  const round5 = r.assess([ok(act("screenshot"))], { url: "https://x" });
  assert.equal(round4.escalate, null);
  assert.equal(round5.escalate, null);
  const round6 = r.assess([ok(act("read_page"))], { url: "https://x" });
  assert.equal(round6.escalate?.reason, "no_progress");
  assert.match(round6.escalate.question, /\?$/);
});

test("a real attempt (click, type, navigate, ...) resets the stall streak, even mid-way through one", () => {
  const r = new RecoveryEngine();
  r.assess([ok(act("screenshot"))], { url: "https://x" });
  r.assess([ok(act("read_page"))], { url: "https://x" });
  // a click here - even a FAILED one - is a real attempt, not just looking
  r.assess([fail(act("click", { ref: "e9" }), "no_effect")], { url: "https://x" });
  const next = r.assess([ok(act("screenshot"))], { url: "https://x" });
  assert.equal(next.notes.filter((n) => /^STALLED:/.test(n)).length, 0, "the streak restarted after the click attempt, so this is only round 1 again");
});

test("a round that MIXES an observation action with a real one (e.g. screenshot + click together) does not count toward the stall", () => {
  const r = new RecoveryEngine();
  for (let i = 0; i < 5; i++) {
    const a = r.assess([ok(act("screenshot")), ok(act("click", { ref: "e" + i }))], { url: "https://x" });
    assert.equal(a.notes.filter((n) => /^STALLED:/.test(n)).length, 0, `round ${i}: a click was attempted alongside the screenshot, so this round is not "only looking"`);
  }
});

test("type and other non-observation actions (not just click) also count as a real attempt", () => {
  for (const name of ["type", "set_text", "key_press", "hotkey", "navigate", "select_all", "form_input", "new_tab", "switch_tab", "handle_dialog", "upload_file", "scroll", "drag"]) {
    const r = new RecoveryEngine();
    r.assess([ok(act("screenshot"))], { url: "https://x" });
    r.assess([ok(act("read_page"))], { url: "https://x" });
    const third = r.assess([ok(act(name))], { url: "https://x" });
    assert.equal(third.notes.filter((n) => /^STALLED:/.test(n)).length, 0, `${name} should count as a real attempt, not pure observation`);
  }
});

test("reset() clears the stall streak along with everything else", () => {
  const r = new RecoveryEngine();
  r.assess([ok(act("screenshot"))], { url: "https://x" });
  r.assess([ok(act("read_page"))], { url: "https://x" });
  r.reset();
  assert.equal(r.observeOnlyStreak, 0);
  const a = r.assess([ok(act("find_element"))], { url: "https://x" });
  assert.equal(a.notes.filter((n) => /^STALLED:/.test(n)).length, 0, "after reset, this is round 1 again, not round 3");
});

test("the real wiring: noah-agent.cjs resets observeOnlyStreak at the same two points it already resets consecutiveFailures", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require.resolve("../../agent/noah-agent.cjs"), "utf8");
  const failureResets = (src.match(/recovery\.consecutiveFailures = 0;/g) || []).length;
  const streakResets = (src.match(/recovery\.observeOnlyStreak = 0;/g) || []).length;
  assert.equal(streakResets, failureResets, "every place the old counter is cleared on escalation, the new one must be too, or it would keep re-escalating every round after the first");
});
