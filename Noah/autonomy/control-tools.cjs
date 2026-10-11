// Noah/autonomy/control-tools.cjs
//
// The tools a mission's model uses to run the MISSION itself rather than to touch the computer: say how success will be checked,
// plan, mark steps, keep hypotheses, check progress, finish, ask the user, give up. They act on MissionState, GoalVerifier and
// Lifecycle, and the rules that matter are enforced here, not asked of the model:
//
//   * criteria can only be ADDED (never removed or loosened), so a mission cannot get greener by shrinking what "done" means
//   * `finish` does not accept a claim of success: Noah runs the checks, and only when every required one is green and current does
//     the mission end as succeeded; otherwise the model gets the failing checks back and the mission goes on
//   * `finish` needs work to have been observed first (phase `reason`): finishing straight after planning is refused
//   * `give_up` is refused until real work was tried (a few commands or edits), because "impossible" must be a finding, not a first reaction
//   * a hypothesis the model already tested and REJECTED cannot be proposed again as if new
//
// Every result is a normal object ({ ok:true,... } or { ok:false, code, message }) the model can read.

"use strict";

const { P, validateArgs, schemaOf } = require("./tools/registry.cjs");
const { readSlice, splitParts, coverage } = require("../intake/request.cjs");

const CRITERION_SHAPE = {
  kind: { type: "string", description: "command | file_exists | file_absent | file_contains | window_exists | window_absent | element_text | claim" },
  description: { type: "string", description: "what this proves, in a few words" },
  cmd: { type: "string", description: "kind command: the command line that must succeed" },
  cwd: { type: "string", description: "kind command: folder to run it in (default the workspace root)" },
  expectExit: { type: "integer", description: "kind command: the exit code that counts as success (default 0)" },
  outputIncludes: { type: "string", description: "kind command: text that must appear in the output" },
  outputExcludes: { type: "string", description: "kind command: text that must NOT appear in the output" },
  timeoutMs: { type: "integer", description: "kind command: how long it may take (default 120000)" },
  path: { type: "string", description: "kinds file_exists, file_absent, file_contains: the file" },
  text: { type: "string", description: "kind file_contains: exact text the file must contain; kind element_text: the text the window must show" },
  title: { type: "string", description: "kinds window_exists, window_absent, element_text: part of the window's title" },
  process: { type: "string", description: "kinds window_exists, window_absent: the program, e.g. notepad" },
  name: { type: "string", description: "kind element_text: only look in the control with this name (optional)" },
  pattern: { type: "string", description: "kind file_contains: a regular expression the file must match" },
  required: { type: "boolean", description: "false makes it informational (default true)" },
};

const DEFS = {
  criteria_add: {
    kind: "control",
    description: "Say HOW SUCCESS WILL BE CHECKED, as machine-checkable criteria (a command that must exit 0, a file that must contain something, ...). Required before any change is allowed. Criteria can be added later but never removed. Make them test what the user actually asked for.",
    params: { criteria: P.objects("one or more criteria", CRITERION_SHAPE, true) },
  },
  plan_set: {
    kind: "control",
    description: "Set or revise the plan: a short list of concrete steps. Steps with the same wording keep their status. Revise it when what you learn changes the approach.",
    params: { steps: P.strings("the steps, in order (at most 30)", true), reason: P.str("why the plan changed (when revising)") },
  },
  step_update: {
    kind: "control",
    description: "Mark a plan step active, done (with the evidence that it is done) or blocked (with why).",
    params: { id: P.str("the step id, e.g. s2", true), status: P.oneOf("new status", ["active", "done", "blocked"], true), evidence: P.str("for done: what shows it is done"), why: P.str("for blocked: what is in the way") },
  },
  hypothesis_add: {
    kind: "control",
    description: "Write down a specific hypothesis about what is wrong, BEFORE changing things to test it.",
    params: { text: P.str("the hypothesis", true) },
  },
  hypothesis_resolve: {
    kind: "control",
    description: "Settle a hypothesis as confirmed or rejected, with the evidence you found.",
    params: { id: P.str("the hypothesis id, e.g. h1", true), status: P.oneOf("outcome", ["confirmed", "rejected"], true), evidence: P.str("what you observed", true) },
  },
  claim_assert: {
    kind: "control",
    description: "For a criterion of kind claim (something a machine cannot check, like reporting an answer): state it with concrete evidence. It will be reported as asserted by you, not verified. The evidence is shown back to you every round under \"Findings you recorded\", and your final answer may use only the details written here.",
    params: { id: P.str("the criterion id, e.g. c3", true), evidence: P.str("everything you actually saw that the user will be told: every name, time, number and quoted text, exactly as shown (at least a sentence)", true) },
  },
  next_set: {
    kind: "control",
    description: "Write down what you will do next (it is shown to you at the start of the next round, so you can pick up where you left off).",
    params: { text: P.str("the next step in one sentence", true) },
  },
  tried_add: {
    kind: "control",
    description: "Record an approach you tried and how it went, so it is not tried again.",
    params: { what: P.str("what you tried", true), outcome: P.oneOf("how it went", ["worked", "failed", "partial"], true), note: P.str("a short note") },
  },
  request_read: {
    kind: "inspect",
    description: "Read the user's ORIGINAL request, word for word, when the Mission section of the briefing says it is long or shows only a digest. Returns up to 4000 characters from `offset`; `next` is where to continue. Use it before you decide the work is done, so no instruction is missed.",
    params: { offset: P.int("character to start from (default 0)") },
  },
  run_checks: {
    kind: "inspect",
    description: "Run the success checks now and see which pass. Does not end the mission. Use it to find out where you stand.",
    params: { force: P.bool("re-run every check even if nothing changed") },
  },
  finish: {
    kind: "end",
    description: "Ask to finish. Noah runs ALL the success checks itself: the mission ends only if every required one passes. If any fails you get the failures back and carry on. Call it when you believe the work is done.",
    params: { summary: P.str("the final message to the user, written to them: the answer or result they asked for FIRST (for a question or a check, the actual findings), then what was done and anything they should know", true) },
  },
  ask_user: {
    kind: "end",
    description: "Stop and ask the user: ONLY for something no one but the user can give (a decision between real alternatives, permission, or for them to set up a key, account or service themselves; NEVER ask them to type a secret into the chat). Never for something you can find out yourself.",
    params: { question: P.str("one clear question", true), kind: P.oneOf("input = needs information or a decision, permission = needs the user to allow something", ["input", "permission"]) },
  },
  give_up: {
    kind: "end",
    description: "Declare the task impossible, with what you checked. Refused until you have really tried (several commands or edits). Not for things that merely are hard.",
    params: { reason: P.str("why it cannot be done, with the evidence", true) },
  },
};

const fail = (code, message, extra) => ({ ok: false, code, message, ...(extra || {}) });
const MIN_ACTIONS_BEFORE_GIVING_UP = 3;

class ControlTools {
  /**
   * @param {object} o
   * @param {import('./mission-state.cjs').MissionState} o.state
   * @param {import('./goal-verifier.cjs').GoalVerifier} o.verifier
   * @param {import('./lifecycle.cjs').Lifecycle} o.lifecycle
   */
  constructor({ state, verifier, lifecycle }) {
    this.state = state;
    this.verifier = verifier;
    this.lc = lifecycle;
  }

  names() {
    return Object.keys(DEFS);
  }

  has(name) {
    return Object.prototype.hasOwnProperty.call(DEFS, name);
  }

  /** "control" (changes mission bookkeeping), "inspect" (observes), or "end" (ends or asks to end the mission). */
  kindOf(name) {
    return DEFS[name] ? DEFS[name].kind : null;
  }

  schemas() {
    return Object.entries(DEFS).map(([name, def]) => ({ name, description: def.description, parameters: schemaOf(def) }));
  }

  /** Validate the arguments of one control tool. */
  check(name, args) {
    return validateArgs(name, DEFS[name], args);
  }

  /** Run one control tool. `finish`, `ask_user` and `give_up` may end the mission: the result then carries `ended`. */
  async execute(name, args) {
    const v = this.check(name, args);
    if (!v.ok) return fail("invalid_arguments", v.message);
    try {
      return await this[`_${name}`](v.args);
    } catch (err) {
      return fail("invalid_arguments", String((err && err.message) || err).slice(0, 300));
    }
  }

  _criteria_add({ criteria }) {
    const ids = this.state.addCriteria(criteria);
    if (this.lc.phase === "understand") this.lc.to("plan", "success criteria set");
    return { ok: true, added: ids, note: "These are what Noah will check. Make sure they test what the user asked for, not something easier." };
  }

  _plan_set({ steps, reason }) {
    const plan = this.state.setPlan(steps, reason);
    return { ok: true, steps: plan.map((s) => `${s.id} [${s.status}] ${s.text}`) };
  }

  _step_update({ id, status, evidence, why }) {
    if (status === "done") {
      if (!evidence || evidence.trim().length < 5) return fail("invalid_arguments", "a step is done when something shows it: give the evidence");
      this.state.completeStep(id, evidence);
    } else if (status === "blocked") this.state.blockStep(id, why || "");
    else this.state.startStep(id);
    return { ok: true, id, status };
  }

  _hypothesis_add({ text }) {
    const r = this.state.addHypothesis(text);
    if (r.existing && r.status === "rejected") {
      const h = this.state.hypotheses.find((x) => x.id === r.id);
      return fail("already_rejected", `You already tested this and REJECTED it (${h.id}: ${h.evidence || "no evidence recorded"}). Propose a different explanation.`, { id: r.id });
    }
    return { ok: true, ...r };
  }

  _hypothesis_resolve({ id, status, evidence }) {
    this.state.resolveHypothesis(id, status, evidence);
    return { ok: true, id, status };
  }

  _claim_assert({ id, evidence }) {
    this.verifier.assertClaim(id, evidence);
    return { ok: true, id, note: "Recorded as ASSERTED by you, not machine-verified." };
  }

  _next_set({ text }) {
    this.state.setNext(text);
    return { ok: true };
  }

  _tried_add({ what, outcome, note }) {
    this.state.recordTried({ what, outcome, note });
    return { ok: true };
  }

  _request_read({ offset }) {
    const r = readSlice(this.state.objective, offset || 0);
    return { ok: true, text: r.text, offset: r.offset, next: r.next, total: r.total, note: r.next === null ? "(that is the end of the request)" : `(continue with offset ${r.next})` };
  }

  async _run_checks({ force }) {
    const r = await this.verifier.runAll({ force: !!force });
    return { ok: true, passed: r.passed, reason: r.reason, ran: r.ran, summary: this.verifier.summaryText(), ...(r.failing.length ? { failing: r.failing } : {}) };
  }

  async _finish({ summary }) {
    if (this.lc.phase === "understand") return fail("not_ready", "Nothing has been set up yet: say how success will be checked (criteria_add), plan, and do the work first.");
    if (this.lc.phase !== "reason") return fail("not_ready", "Finish only confirms work that has been done and looked at. Do or check something first (for example run_checks), then call finish.");
    const asked = splitParts(this.state.objective).filter((p) => p.question);
    if (asked.length >= 2 && !this._coverageWarned) {
      const miss = coverage(asked, summary).missing;
      if (miss.length) {
        this._coverageWarned = true;
        return fail("incomplete_answer", `Your final message does not answer ${miss.length} of the ${asked.length} questions the user asked: ${miss.slice(0, 12).map((p) => `part ${p.n} ("${p.text.replace(/\s+/g, " ").slice(0, 80)}")`).join("; ")}. Answer each of them (by its number), or say plainly that you could not, then call finish again.`);
      }
    }
    this.lc.to("verify", "finish requested");
    await this.verifier.runAll();
    const ok = this.verifier.canSucceed();
    if (ok === true) {
      this.lc.finish("succeeded", summary);
      return { ok: true, ended: "succeeded", verification: this.verifier.summaryText() };
    }
    this.lc.to("reason", "verification failed");
    return fail("not_verified", `Noah checked and the work is NOT done: ${ok}. Fix what fails, then call finish again.`, { verification: this.verifier.summaryText() });
  }

  _ask_user({ question, kind }) {
    const ending = kind === "permission" ? "blocked_permission" : "blocked_input";
    this.lc.finish(ending, question);
    return { ok: true, ended: ending };
  }

  _give_up({ reason }) {
    const actions = this.state.explored.length + this.state.counters.commands + this.state.counters.fileChanges; // things looked at, commands run, edits made
    if (actions < MIN_ACTIONS_BEFORE_GIVING_UP) return fail("too_early", `You have only looked into ${actions} thing${actions === 1 ? "" : "s"}. "Impossible" has to be a finding: investigate (read files, run commands, form and test a hypothesis) before giving up.`);
    if (String(reason).trim().length < 20) return fail("invalid_arguments", "give the reason and the evidence, in a sentence or two");
    this.lc.finish("impossible", reason);
    return { ok: true, ended: "impossible" };
  }
}

module.exports = { ControlTools, DEFS, MIN_ACTIONS_BEFORE_GIVING_UP };
