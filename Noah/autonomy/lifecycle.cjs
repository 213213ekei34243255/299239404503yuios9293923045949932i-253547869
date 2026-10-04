// Noah/autonomy/lifecycle.cjs
//
// The task lifecycle of a MISSION (a long job such as "set this project up, fix the errors, run the tests"), as an explicit
// state machine instead of "whatever the loop happens to be doing":
//
//   understand -> plan -> inspect | act -> observe -> reason -> inspect | act | verify | recover | plan
//   verify  -> reason (a check failed: keep going) | recover        recover -> plan | inspect | act
//
// and exactly seven ways to END (TERMINAL). The rules that matter are enforced here, not asked of the model:
//   * success can only be declared from `verify`, and only when `canSucceed()` says every check passed. The default is
//     fail-closed: a Lifecycle built without a verifier can never succeed.
//   * a mission cannot leave `understand` until it has something checkable to aim at (`canPlan`).
//   * a terminal state is final, except the three that are waiting on the user or a budget (`resumable`).

"use strict";

const PHASES = ["understand", "plan", "inspect", "act", "observe", "reason", "verify", "recover"];

const TERMINAL = {
  succeeded: { resumable: false, text: "Done and verified" },
  blocked_permission: { resumable: true, text: "Needs a permission only the user can give" },
  blocked_input: { resumable: true, text: "Needs information or a credential only the user has" },
  impossible: { resumable: false, text: "Cannot be done (checked, not assumed)" },
  unsafe: { resumable: false, text: "Stopped by a safety rule" },
  budget_paused: { resumable: true, text: "Paused at a budget limit; progress is saved" },
  budget_exhausted: { resumable: false, text: "Used its whole allowance (it cannot be resumed; start a new task)" },
  cancelled: { resumable: false, text: "Stopped by the user" },
};

const NEXT = {
  understand: ["plan"],
  plan: ["inspect", "act"],
  inspect: ["observe"],
  act: ["observe"],
  observe: ["reason"],
  reason: ["inspect", "act", "verify", "recover", "plan"],
  verify: ["reason", "recover"],
  recover: ["plan", "inspect", "act"],
};

const MAX_TRAIL = 200;

class LifecycleError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LifecycleError";
    this.code = code; // illegal_transition | terminal | guard | success_not_verified | not_resumable | bad_kind | bad_phase
  }
}

class Lifecycle {
  /**
   * @param {object} [o]
   * @param {() => true|string} [o.canPlan]       true, or the reason planning is not allowed yet
   * @param {() => true|string|false} [o.canSucceed]  true only when every success check has passed
   * @param {(t: object) => void} [o.onTransition]
   * @param {() => number} [o.now]
   */
  constructor({ canPlan = () => true, canSucceed = () => false, onTransition = () => {}, now = Date.now } = {}) {
    this._canPlan = canPlan;
    this._canSucceed = canSucceed;
    this._onTransition = onTransition;
    this._now = now;
    this.phase = "understand";
    this.terminal = null; // { kind, reason, resumable, at }
    this.trail = []; // [{ from, to, why, at }]
    this.visits = { understand: 1 };
  }

  get isTerminal() {
    return !!this.terminal;
  }

  _note(from, to, why) {
    const t = { from, to, why: String(why || "").slice(0, 160), at: this._now() };
    this.trail.push(t);
    if (this.trail.length > MAX_TRAIL) this.trail.shift();
    try {
      this._onTransition(t);
    } catch (_) {
      /* a listener must never break the mission */
    }
  }

  /** Move to another phase of the loop. */
  to(phase, why = "") {
    if (this.terminal) throw new LifecycleError(`the mission already ended (${this.terminal.kind})`, "terminal");
    if (!PHASES.includes(phase)) throw new LifecycleError(`unknown phase "${phase}"`, "bad_phase");
    if (!NEXT[this.phase].includes(phase)) throw new LifecycleError(`cannot go from ${this.phase} to ${phase}`, "illegal_transition");
    if (this.phase === "understand" && phase === "plan") {
      const g = this._canPlan();
      if (g !== true) throw new LifecycleError(typeof g === "string" && g ? g : "the mission is not ready to plan", "guard");
    }
    const from = this.phase;
    this.phase = phase;
    this.visits[phase] = (this.visits[phase] || 0) + 1;
    this._note(from, phase, why);
    return this.phase;
  }

  /** End the mission. `succeeded` is only possible from `verify` with every check passing. */
  finish(kind, reason = "") {
    if (this.terminal) throw new LifecycleError(`the mission already ended (${this.terminal.kind})`, "terminal");
    const spec = TERMINAL[kind];
    if (!spec) throw new LifecycleError(`unknown ending "${kind}"`, "bad_kind");
    if (kind === "succeeded") {
      if (this.phase !== "verify") throw new LifecycleError("success can only be declared from the verify phase", "success_not_verified");
      const ok = this._canSucceed();
      if (ok !== true) throw new LifecycleError(typeof ok === "string" && ok ? ok : "the success checks have not all passed", "success_not_verified");
    }
    const from = this.phase;
    this.terminal = { kind, reason: String(reason || "").slice(0, 300), resumable: spec.resumable, at: this._now() };
    this._note(from, kind, reason);
    return this.terminal;
  }

  /** Carry on after a pause for a budget, a permission or missing information. Re-enters at `reason`: the model re-evaluates first. */
  resume(why = "") {
    if (!this.terminal) throw new LifecycleError("the mission is not stopped", "not_resumable");
    if (!this.terminal.resumable) throw new LifecycleError(`a mission that ended as ${this.terminal.kind} cannot be resumed`, "not_resumable");
    const from = this.terminal.kind;
    this.terminal = null;
    this.phase = "reason";
    this.visits.reason = (this.visits.reason || 0) + 1;
    this._note(from, "reason", why || "resumed");
    return this.phase;
  }

  snapshot() {
    return { phase: this.phase, terminal: this.terminal ? { ...this.terminal } : null, visits: { ...this.visits }, trail: this.trail.slice(-20) };
  }

  restore(snap) {
    if (!snap || !PHASES.includes(snap.phase)) return this;
    this.phase = snap.phase;
    this.terminal = snap.terminal && TERMINAL[snap.terminal.kind] ? { ...snap.terminal } : null;
    this.visits = { ...(snap.visits || {}) };
    this.trail = Array.isArray(snap.trail) ? snap.trail.slice(-MAX_TRAIL) : [];
    return this;
  }
}

module.exports = { Lifecycle, LifecycleError, PHASES, TERMINAL, NEXT };
