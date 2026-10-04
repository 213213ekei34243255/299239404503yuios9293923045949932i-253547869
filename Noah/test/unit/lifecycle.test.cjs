// Noah/test/unit/lifecycle.test.cjs - the mission lifecycle state machine (Noah/autonomy/lifecycle.cjs)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Lifecycle, LifecycleError, PHASES, TERMINAL, NEXT } = require("../../autonomy/lifecycle.cjs");

const rejectsWith = (fn, code) => assert.throws(fn, (e) => e instanceof LifecycleError && e.code === code, `expected a LifecycleError with code ${code}`);
const toVerify = (lc) => ["plan", "act", "observe", "reason", "verify"].forEach((p) => lc.to(p));

test("a mission starts in understand and follows the loop plan -> inspect/act -> observe -> reason -> verify", () => {
  const lc = new Lifecycle();
  assert.equal(lc.phase, "understand");
  for (const p of ["plan", "inspect", "observe", "reason", "act", "observe", "reason", "verify"]) lc.to(p);
  assert.equal(lc.phase, "verify");
  assert.equal(lc.visits.observe, 2);
  assert.equal(lc.visits.reason, 2);
  assert.equal(lc.isTerminal, false);
});

test("a phase that is not allowed next is refused, and the phase does not move", () => {
  for (const [from, bad] of [["understand", "act"], ["plan", "verify"], ["act", "verify"], ["act", "reason"], ["observe", "act"], ["verify", "act"], ["recover", "verify"]]) {
    const lc = new Lifecycle();
    const route = { understand: [], plan: ["plan"], act: ["plan", "act"], observe: ["plan", "act", "observe"], verify: ["plan", "act", "observe", "reason", "verify"], recover: ["plan", "act", "observe", "reason", "recover"] }[from];
    route.forEach((p) => lc.to(p));
    assert.equal(lc.phase, from);
    rejectsWith(() => lc.to(bad), "illegal_transition");
    assert.equal(lc.phase, from, `${from} -> ${bad} must not move the phase`);
  }
});

test("an unknown phase name is refused", () => {
  const lc = new Lifecycle();
  rejectsWith(() => lc.to("succeeded"), "bad_phase"); // an ending is not a phase: finish() is the only way out
  rejectsWith(() => lc.to("nonsense"), "bad_phase");
});

test("a mission cannot leave understand until canPlan allows it, and the reason is passed on", () => {
  let ready = "no success criteria yet";
  const lc = new Lifecycle({ canPlan: () => ready });
  assert.throws(() => lc.to("plan"), (e) => e.code === "guard" && /no success criteria yet/.test(e.message));
  assert.equal(lc.phase, "understand");
  ready = true;
  lc.to("plan");
  assert.equal(lc.phase, "plan");
});

test("success is fail-closed: a lifecycle with no verifier can never succeed, even from verify", () => {
  const lc = new Lifecycle();
  toVerify(lc);
  rejectsWith(() => lc.finish("succeeded"), "success_not_verified");
  assert.equal(lc.isTerminal, false);
});

test("success can only be declared from the verify phase", () => {
  const lc = new Lifecycle({ canSucceed: () => true });
  lc.to("plan");
  lc.to("act");
  lc.to("observe");
  lc.to("reason");
  assert.throws(() => lc.finish("succeeded"), (e) => e.code === "success_not_verified" && /verify phase/.test(e.message));
  assert.equal(lc.isTerminal, false);
  lc.to("verify");
  const t = lc.finish("succeeded", "all checks passed");
  assert.equal(t.kind, "succeeded");
  assert.equal(lc.isTerminal, true);
});

test("success is refused with the verifier's own reason while checks are red, then accepted when they pass", () => {
  let verdict = "still failing: c2";
  const lc = new Lifecycle({ canSucceed: () => verdict });
  toVerify(lc);
  assert.throws(() => lc.finish("succeeded"), (e) => e.code === "success_not_verified" && /still failing: c2/.test(e.message));
  verdict = true;
  assert.equal(lc.finish("succeeded").kind, "succeeded");
});

test("a truthy-but-not-true verdict does not count as success", () => {
  for (const v of [1, "yes", {}, [], "true"]) {
    // strings are the REASON for refusing, never an approval
    const lc = new Lifecycle({ canSucceed: () => v });
    toVerify(lc);
    rejectsWith(() => lc.finish("succeeded"), "success_not_verified");
  }
});

test("a terminal state is final: nothing moves a finished mission", () => {
  const lc = new Lifecycle({ canSucceed: () => true });
  toVerify(lc);
  lc.finish("succeeded");
  rejectsWith(() => lc.to("reason"), "terminal");
  rejectsWith(() => lc.finish("cancelled"), "terminal");
});

test("every ending except success can be reached from any phase, and an unknown ending is refused", () => {
  for (const kind of Object.keys(TERMINAL).filter((k) => k !== "succeeded")) {
    for (const path of [[], ["plan", "act"]]) {
      const lc = new Lifecycle();
      path.forEach((p) => lc.to(p));
      const t = lc.finish(kind, "because");
      assert.equal(t.kind, kind);
      assert.equal(t.resumable, TERMINAL[kind].resumable);
    }
  }
  rejectsWith(() => new Lifecycle().finish("won"), "bad_kind");
});

test("only the endings that wait on the user or a budget can be resumed, and they re-enter at reason", () => {
  for (const kind of ["blocked_permission", "blocked_input", "budget_paused"]) {
    const lc = new Lifecycle();
    lc.to("plan");
    lc.to("act");
    lc.finish(kind, "waiting");
    assert.equal(lc.isTerminal, true);
    lc.resume("granted");
    assert.equal(lc.isTerminal, false);
    assert.equal(lc.phase, "reason");
    lc.to("act"); // and the loop carries on
  }
  for (const kind of ["impossible", "unsafe", "cancelled", "budget_exhausted"]) {
    const lc = new Lifecycle();
    lc.finish(kind);
    rejectsWith(() => lc.resume(), "not_resumable");
  }
  const done = new Lifecycle({ canSucceed: () => true });
  toVerify(done);
  done.finish("succeeded");
  rejectsWith(() => done.resume(), "not_resumable");
  rejectsWith(() => new Lifecycle().resume(), "not_resumable"); // not stopped at all
});

test("listeners hear every transition including the ending, and a listener that throws cannot break the mission", () => {
  const seen = [];
  const lc = new Lifecycle({ onTransition: (t) => { seen.push(`${t.from}>${t.to}`); throw new Error("listener bug"); } });
  lc.to("plan", "go");
  lc.to("act");
  lc.finish("cancelled", "user");
  assert.deepEqual(seen, ["understand>plan", "plan>act", "act>cancelled"]);
  assert.equal(lc.terminal.kind, "cancelled");
});

test("snapshot and restore round-trip through JSON", () => {
  const lc = new Lifecycle();
  lc.to("plan");
  lc.to("inspect");
  lc.to("observe");
  lc.finish("budget_paused", "step budget");
  const snap = JSON.parse(JSON.stringify(lc.snapshot()));
  const back = new Lifecycle().restore(snap);
  assert.equal(back.phase, "observe");
  assert.equal(back.terminal.kind, "budget_paused");
  back.resume();
  assert.equal(back.phase, "reason");
  // garbage in is ignored, not trusted
  assert.equal(new Lifecycle().restore({ phase: "hacked" }).phase, "understand");
  assert.equal(new Lifecycle().restore({ phase: "act", terminal: { kind: "made_up" } }).terminal, null);
});

test("the transition table is complete and self-consistent", () => {
  for (const p of PHASES) assert.ok(Array.isArray(NEXT[p]) && NEXT[p].length, `${p} has no way forward`);
  for (const [from, tos] of Object.entries(NEXT)) for (const to of tos) assert.ok(PHASES.includes(to), `${from} -> ${to} is not a phase`);
  for (const to of Object.values(NEXT).flat()) assert.ok(!(to in TERMINAL), "an ending must never be reachable as an ordinary phase");
  // the only road into verify is reason, so success always follows a fresh round of thinking
  assert.deepEqual(Object.entries(NEXT).filter(([, t]) => t.includes("verify")).map(([f]) => f), ["reason"]);
});

test("the trail is bounded however long the mission runs", () => {
  const lc = new Lifecycle();
  lc.to("plan");
  lc.to("act");
  lc.to("observe");
  lc.to("reason");
  for (let i = 0; i < 400; i++) { lc.to("inspect"); lc.to("observe"); lc.to("reason"); }
  assert.equal(lc.trail.length, 200);
  assert.ok(lc.snapshot().trail.length <= 20);
});
