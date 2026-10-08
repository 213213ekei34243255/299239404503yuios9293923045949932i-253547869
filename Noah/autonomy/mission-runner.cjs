// Noah/autonomy/mission-runner.cjs
//
// The MISSION LOOP: Goal -> understand -> plan -> inspect/act -> observe -> reason -> verify -> (recover | continue), until the work is verified
// done, or it genuinely cannot go on. One round:
//
//   brief  (mission-context: the state, the last results, notices)   ->   ask the model (it must call tools)   ->   run its calls in order,
//   each through the right gate   ->   record what happened in MissionState   ->   move the lifecycle   ->   checkpoint
//
// Everything that matters is enforced HERE and in the pieces it drives, not by asking the model nicely:
//   * no change is allowed before success criteria exist (the model must first say how "done" will be checked)
//   * the mission only succeeds through `finish`, and only when every required check is green and current (lifecycle + verifier)
//   * a round runs at most a few calls and stops at the first failed action; a refused or failed call is returned to the model as a result
//   * a stall (no new file looked at, nothing changed, no new error, no check turned green) first corrects the model and moves to `recover`,
//     then pauses the mission with its progress saved, instead of burning calls forever
//   * hitting a budget (rounds, model calls, time) or losing the model PAUSES the mission (resumable); only the user's stop cancels it
//   * instruction-like text met in a file or in program output raises the confirmation level for the rest of the mission
//
// The model is injected as `callModel(request, { signal })` -> { text, toolCalls: [{ name, args }], usage } (the ModelRouter's shape), so this file
// never knows which provider is behind it and tests drive it with a scripted one.

"use strict";

const { EventEmitter } = require("events");
const { randomBytes } = require("crypto");
const path = require("path");
const fs = require("fs");
const { MissionState } = require("./mission-state.cjs");
const { Lifecycle } = require("./lifecycle.cjs");
const { GoalVerifier } = require("./goal-verifier.cjs");
const { ControlTools } = require("./control-tools.cjs");
const { ToolRegistry } = require("./tools/registry.cjs");
const { Workspace } = require("./tools/workspace.cjs");
const { MissionStore } = require("./mission-store.cjs");
const { systemPrompt, buildMissionMessage } = require("./mission-context.cjs");
const { WorkingSet } = require("./working-set.cjs");
const { describeCall, describeStart, phaseWords } = require("./activity.cjs");
const { isTestPath } = require("./tools/test-paths.cjs");
const { redactSecrets, asksForSecret } = require("../safety/secrets.cjs");
const { DesktopTools } = require("../desktop/tools.cjs");

const DEFAULT_LIMITS = { maxIterations: 120, maxModelCalls: 150, maxLifetimeModelCalls: 600, maxWallMs: 45 * 60_000, stallLimit: 10, maxCallsPerRound: 4, invalidLimit: 4, modelTimeoutMs: 90_000, maxTokens: 2048, temperature: 0, workingSetChars: 12000, workingSetFileChars: 6000 };
/**
 * Wait for `promise`, but give up the moment `signal` aborts: a model call or a tool that does not listen for Stop (a hung helper, a slow network) must not keep a stopped task alive.
 * The abandoned promise is left to finish on its own (its result is ignored, its failure is swallowed).
 */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  const stopped = () => Object.assign(new Error("stopped by the user"), { code: "aborted" });
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(stopped()); }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(stopped());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

const clip = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n - 1) + "…" : String(s ?? ""));
const INVALID = new Set(["invalid_arguments", "unknown_tool"]);
/** Results of calls that were turned away BEFORE anything ran. Everything else (including a command that ran and failed) was a real look at the world. */
const REFUSED = new Set(["invalid_arguments", "unknown_tool", "not_ready", "blocked", "user_denied", "policy_denied", "repeat_blocked", "not_executed", "protected_path", "outside_workspace", "no_workspace", "aborted", "too_early", "already_rejected"]);

/** One short line for the "earlier" list and the log. */
function summarize(name, args = {}, r = {}) {
  const bad = r && r.ok === false ? ` FAILED [${r.code || "error"}]` : "";
  switch (name) {
    case "criteria_add": return `criteria_add (${(args.criteria || []).length})${bad}`;
    case "plan_set": return `plan_set (${(args.steps || []).length} steps)${bad}`;
    case "step_update": return `step ${args.id} -> ${args.status}${bad}`;
    case "hypothesis_add": return `hypothesis: ${clip(args.text, 80)}${bad}`;
    case "hypothesis_resolve": return `hypothesis ${args.id} ${args.status}${bad}`;
    case "run_checks": return `run_checks -> ${r.passed ? "all green" : r.reason || "not green"}${bad}`;
    case "finish": return r.ok ? "finish accepted: verified" : `finish refused: ${r.code || "error"}`;
    case "ask_user": return `ask_user: ${clip(args.question, 80)}`;
    case "give_up": return `give_up${bad}`;
    default: return `${name}${bad}`;
  }
}

class MissionRunner extends EventEmitter {
  /**
   * @param {object} o
   * @param {MissionState} o.state
   * @param {Lifecycle} o.lifecycle
   * @param {GoalVerifier} o.verifier
   * @param {ToolRegistry} o.registry
   * @param {ControlTools} o.control
   * @param {(req: object, opts: { signal?: AbortSignal }) => Promise<{ text?: string, toolCalls?: {name:string,args?:object}[], usage?: object }>} o.callModel
   * @param {object} [o.limits]
   * @param {'autonomous'|'supervised'|'strict'} [o.mode]
   * @param {{ publish: Function }} [o.bus]
   * @param {MissionStore} [o.store]
   * @param {string[]} [o.roots]  the granted folders (saved so a resumed mission can re-grant them)
   */
  constructor({ state, lifecycle, verifier, registry, control, callModel, limits = {}, mode = "autonomous", bus = null, store = null, roots = [], ticket = null, now = Date.now, log = () => {}, platform = process.platform, restored = null, experience = null }) {
    super();
    Object.assign(this, { state, lc: lifecycle, verifier, registry, control, callModel, mode, bus, store, roots, now, log, platform });
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    // a task on the user's own computer that makes no progress is also keeping that computer busy (and the user waiting): it gives up in half the rounds
    if (registry && registry.desktop && !(limits && limits.stallLimit)) this.limits.stallLimit = Math.min(this.limits.stallLimit, 5);
    // what the mission has read stays in the briefing, current (see working-set.cjs): the model edits what is really there, not what it remembers
    this.working = new WorkingSet({
      maxChars: this.limits.workingSetChars,
      perFile: this.limits.workingSetFileChars,
      statOf: (p) => { try { const s = fs.statSync(this.registry.workspace.resolve(p)); return { mtimeMs: s.mtimeMs, size: s.size }; } catch (_) { return null; } },
      readFile: (p, a) => this.registry.fs.read({ path: p, ...a }),
    });
    this.nonce = randomBytes(9).toString("hex");
    this.experienceNote = ""; // what earlier tasks taught Noah with this user (text from experience/advice.cjs only); read once, so the prompt stays the same for the whole mission
    try { this.experienceNote = experience ? String(experience() || "") : ""; } catch (_) { /* experience must never stop a task */ }
    this.ticket = ticket || (restored && restored.ticket) || null; // the paid-for agent use behind this mission (sent with every model step; saved with the checkpoint)
    this.tainted = !!(restored && restored.tainted);
    this.injection = restored && Array.isArray(restored.injection) ? restored.injection.slice(0, 6) : []; // WHERE instruction-like text was found: reported to the user at the end, not left to the model to mention
    this.notices = restored && Array.isArray(restored.notices) ? [...restored.notices] : [];
    this.last = { results: [], thought: restored && restored.thought ? restored.thought : "" };
    this.stats = { modelCalls: 0, inputTokens: 0, outputTokens: 0, ...(restored && restored.stats ? restored.stats : {}) };
    this.invalidStreak = 0;
    this._stallNudged = false;
    this._startedAt = now();
    this._base = { iterations: state.counters.iterations, modelCalls: this.stats.modelCalls };
  }

  /** The user's mode, but never looser than `supervised` once instruction-like text has been met. */
  effectiveMode() {
    return this.tainted && this.mode === "autonomous" ? "supervised" : this.mode;
  }

  get id() {
    return this.state.id;
  }

  _publish(event, payload) {
    try {
      if (this.bus) this.bus.publish(event, { missionId: this.id, ...payload });
      this.emit(event, payload);
    } catch (_) {
      /* a listener must never break a mission */
    }
  }

  /**
   * What the user sees while it works (activity.cjs): one plain line per call, built from the REAL result. `id` is stable per call, so a
   * "Running npm test…" line is replaced in place by its outcome. Describing must never break a mission either.
   */
  _show(item, id, extra = {}) {
    if (!item) return;
    const iteration = this.state.counters.iterations;
    this._publish("mission_activity", { id: `${iteration}.${id}`, iteration, phase: this.lc.phase, phaseText: phaseWords(this.lc.phase), ...item, ...extra });
  }

  _showStart(name, args, id) {
    try { this._show(describeStart(name, args), id, { pending: true }); } catch (_) { /* cosmetic only */ }
  }

  _showDone(name, args, result, id) {
    try { this._show(describeCall(name, args, result), id, { pending: false }); } catch (_) { /* cosmetic only */ }
  }

  _save() {
    if (!this.store) return false;
    return this.store.save({ id: this.id, objective: this.state.objective, desktop: !!this.registry.desktop, roots: this.roots, ticket: this.ticket, mode: this.mode, state: this.state.snapshot(), lifecycle: this.lc.snapshot(), notices: this.notices, thought: this.last.thought, tainted: this.tainted, injection: this.injection, stats: this.stats });
  }

  /** The user asked the mission to stop. A PAUSE keeps it resumable (its progress is saved); a plain stop cancels it for good. */
  requestPause() {
    this._pauseRequested = true;
  }

  /** Stop for good a mission that is PAUSED (resumable): it can no longer be continued. */
  cancelPaused() {
    if (!this.lc.terminal || !this.lc.terminal.resumable) return false;
    this.lc.terminal = { kind: "cancelled", reason: "stopped by the user", resumable: false, at: this.now() };
    this._save();
    return true;
  }

  _stopped() {
    if (this.lc.isTerminal) return null;
    if (this._pauseRequested) return this.lc.finish("budget_paused", "Paused at your request. Its progress is saved: say \"continue\" to carry on.");
    return this.lc.finish("cancelled", "stopped by the user");
  }

  /** The whole allowance of this mission, across every pause and resume (a safety cap, not a billing rule). */
  _exhausted() {
    const L = this.limits;
    return this.stats.modelCalls >= L.maxLifetimeModelCalls ? `This task has used its whole allowance (${L.maxLifetimeModelCalls} model calls across all its runs), so it cannot be continued. Start a new task to carry on: this one keeps its saved progress for reference.` : null;
  }

  _overBudget() {
    const L = this.limits;
    if (this.state.counters.iterations - this._base.iterations >= L.maxIterations) return `Paused after ${L.maxIterations} rounds (the round limit). Its progress is saved: continue it to carry on.`;
    if (this.stats.modelCalls - this._base.modelCalls >= L.maxModelCalls) return `Paused after ${L.maxModelCalls} model calls (the cost limit). Its progress is saved: continue it to carry on.`;
    if (this.now() - this._startedAt >= L.maxWallMs) return `Paused after ${Math.round(L.maxWallMs / 60000)} minutes (the time limit). Its progress is saved: continue it to carry on.`;
    return null;
  }

  /** Stuck? First correct the model and move to `recover`; if that does not help, pause with the progress saved. */
  _stallCheck() {
    const stalled = this.state.stalledFor();
    const L = this.limits.stallLimit;
    if (stalled >= L * 2) {
      this.lc.finish("budget_paused", `No real progress for ${stalled} rounds (nothing new looked at, nothing changed, no new error, no check turned green). Paused with the progress saved: continue it with a new hint, or stop it.`);
      return;
    }
    if (stalled >= L && !this._stallNudged) {
      this._stallNudged = true;
      this.notices.push(`You have made no real progress for ${stalled} rounds (nothing new looked at, nothing changed, no new error, no check turned green). What you are doing is not working. Stop and rethink: re-read the failing output and the briefing, list what you have actually established, say what you do NOT know, and try something different (read a file you have not read, test a different hypothesis, replan). Repeating a failed approach will end this mission.`);
      if (this.lc.phase === "reason") this.lc.to("recover", "stalled");
    }
    if (stalled < L) this._stallNudged = false;
  }

  _earlier() {
    const obs = this.state.observations;
    return obs.slice(0, Math.max(0, obs.length - this.last.results.length)).map((o) => o.summary);
  }

  /** One tool call: through the registry (the computer), or through the control tools (the mission itself). */
  async _exec(name, args, signal) {
    const reg = this.registry.names().includes(name);
    const ctl = this.control.has(name);
    if (!reg && !ctl) return { result: { ok: false, code: "unknown_tool", message: `unknown tool "${name}". Valid tools: ${[...this.registry.names(), ...this.control.names()].join(", ")}` }, viaRegistry: false, kind: "none" };
    if (ctl) {
      const result = await this.control.execute(name, args);
      return { result, viaRegistry: false, kind: this.control.kindOf(name) };
    }
    const mutating = this.registry.isMutating(name, args);
    if (this.lc.phase === "understand" && mutating) {
      return { result: { ok: false, code: "not_ready", message: "Changes are not allowed yet. First say how success will be checked (criteria_add): then you can change things. Until then you can read, list, search and run read-only commands." }, viaRegistry: false, kind: "act" };
    }
    const result = await this.registry.execute(name, args, { signal });
    // a command that ran and that Noah has not run before is something NEW looked at (a task that works through the shell, listing folders and reading files, used to be paused as "no progress" after ten rounds)
    if (result.ok && /^(fs_(read|list|search)|shell_run|desktop_(windows|read|screenshot|wait))$/.test(name)) this.state.noteExplored(`${name}:${args.cmd ? `${args.cwd || "."}|${args.cmd}` : (args.path || args.pattern || args.title || args.window || args.process || ".")}`);
    if (result.ok) {
      if (name === "fs_read") this.working.remember(args, result);
      else if (name === "fs_edit" || name === "fs_write") this.working.touch(result.path);
      else if (name === "fs_delete") this.working.drop(result.path);
    }
    return { result, viaRegistry: true, kind: mutating ? "act" : "inspect" };
  }

  /** Move the lifecycle along the loop after a round of work (the table forbids shortcuts: success can only follow a look at the result). */
  _settle({ hadWork, mutated, planned }) {
    const lc = this.lc;
    if (lc.isTerminal || lc.phase === "understand") return;
    if (hadWork) {
      if (["plan", "reason", "recover"].includes(lc.phase)) lc.to(mutated ? "act" : "inspect", "round of work");
      if (lc.phase === "act" || lc.phase === "inspect") lc.to("observe");
      if (lc.phase === "observe") lc.to("reason");
    } else if (planned && lc.phase === "reason") lc.to("plan", "replanned");
    else if (lc.phase === "observe") lc.to("reason");
  }

  async _round(signal) {
    const { state, lc } = this;
    await this.working.refresh(); // a file changed by an edit or by a command is read again; a deleted one is forgotten
    const shownInFull = this.last.results.filter((c) => c.name === "fs_read" && c.result && c.result.ok).map((c) => c.result.path); // already in this round's results
    const msg = buildMissionMessage({ state, phase: lc.phase, iteration: state.counters.iterations, results: this.last.results, files: this.working.entries({ skipPaths: shownInFull }), earlier: this._earlier(), thought: this.last.thought, notices: this.notices, nonce: this.nonce });
    this.notices = [];
    if (msg.tainted && !this.tainted) {
      this.tainted = true;
      this.injection = msg.findings.slice(0, 6).map((f) => ({ id: f.id, source: String(f.source || "").replace(/^file /, "") }));
      const where = [...new Set(this.injection.map((f) => f.source).filter(Boolean))].slice(0, 3).join(", ") || "a file or program output";
      this._publish("mission_notice", { text: `Instruction-like text was found in ${where}. It is treated as untrusted data, and Noah now confirms more of what it does.` });
    }

    let res;
    try {
      const pictures = this.registry.takeImages ? this.registry.takeImages() : []; // a screenshot taken last round is shown to the model once, with this message
      const content = [{ type: "text", text: msg.text }, ...pictures.map((p) => ({ type: "image", mime: p.mime, base64: p.base64 }))];
      res = await raceAbort(this.callModel({ system: systemPrompt({ platform: this.platform, nonce: this.nonce, desktop: !!this.registry.desktop, experience: this.experienceNote }), messages: [{ role: "user", content }], tools: [...this.registry.schemas(), ...this.control.schemas()], toolChoice: "any", maxTokens: this.limits.maxTokens, temperature: this.limits.temperature, signal, timeoutMs: this.limits.modelTimeoutMs, meta: { missionId: this.id, round: state.counters.iterations, ticket: this.ticket } }, { signal }), signal);
    } catch (err) {
      if ((signal && signal.aborted) || (err && (err.code === "aborted" || err.code === "STOPPED"))) return this._stopped();
      // "the connection" is the wrong thing to blame when there is NO model (not signed in), or the model refused the sign-in: say what is actually wrong and what to do (found on a real Mac)
      const failures = (err && err.details && err.details.failures) || (err && err.failures) || [];
      if (err && err.code === "NO_MODEL") return lc.finish("budget_paused", `There is no AI model to continue with, because Jonah is not signed in. Say "continue" to sign in (one time, with Google). The progress is saved.`);
      if (err && err.code === "ALL_FAILED" && failures.length && failures.every((f) => f.code === "auth")) return lc.finish("budget_paused", `The AI model did not accept Jonah's sign-in (${clip(failures.map((f) => f.candidate).join(", "), 80)}). Sign in to Jonah again, then say "continue". The progress is saved.`);
      return lc.finish("budget_paused", `The model could not be reached (${clip((err && err.message) || err, 160)}). Paused with the progress saved: continue it when the connection is back.`);
    }
    this.stats.modelCalls++;
    this.stats.inputTokens += (res.usage && res.usage.inputTokens) || 0;
    this.stats.outputTokens += (res.usage && res.usage.outputTokens) || 0;
    if (signal && signal.aborted) return this._stopped();

    const thought = clip(String(res.text || "").trim(), 600);
    const calls = (res.toolCalls || []).filter((c) => c && typeof c.name === "string");
    if (!calls.length) {
      this.last = { results: [], thought };
      this.invalidStreak++;
      this.notices.push("You replied without calling a tool. Answer ONLY by calling tools: to continue, call one; to end, call finish.");
      if (this.invalidStreak >= this.limits.invalidLimit) lc.finish("budget_paused", "The model kept answering without using tools. Paused with the progress saved.");
      return;
    }

    const batch = calls.slice(0, this.limits.maxCallsPerRound);
    if (calls.length > batch.length) this.notices.push(`Only the first ${batch.length} calls of a round are run; the other ${calls.length - batch.length} were ignored. Send fewer calls per round and look at each result.`);
    const results = [];
    const flags = { hadWork: false, mutated: false, planned: false };
    let halted = null;
    let finishCall = null;
    const record = (name, args, result, viaRegistry) => {
      const at = results.length;
      results.push({ name, args, result });
      if (!viaRegistry) state.recordObservation({ tool: name, summary: summarize(name, args, result) });
      this._showDone(name, args, result, at);
    };
    for (let i = 0; i < batch.length; i++) {
      const { name } = batch[i];
      const args = batch[i].args && typeof batch[i].args === "object" ? batch[i].args : {};
      if (name === "finish") {
        finishCall = { name, args };
        if (i < batch.length - 1) this.notices.push("finish must be the LAST call of a round: the calls after it were ignored.");
        break;
      }
      if (halted) { record(name, args, { ok: false, code: "not_executed", message: halted }, false); continue; }
      this._showStart(name, args, results.length);
      let done;
      try { done = await raceAbort(this._exec(name, args, signal), signal); } catch (err) {
        if (signal && signal.aborted) return this._stopped(); // Stop was pressed while a tool was busy: do not wait for it
        throw err;
      }
      const { result, viaRegistry, kind } = done;
      record(name, args, result, viaRegistry);
      const reached = result.ok || !REFUSED.has(result.code); // it ran: a failing test run is still something the model has now seen
      if (reached && (kind === "act" || kind === "inspect")) {
        flags.hadWork = true;
        if (kind === "act" && (result.ok || name === "shell_run")) flags.mutated = true; // a failed edit changed nothing; a failed command may have
      }
      if (result.ok && name === "plan_set") flags.planned = true;
      if (!result.ok && (kind === "act" || kind === "inspect" || kind === "none")) {
        halted = "Not run: an earlier call in this round failed. Look at that first.";
        if (result.code === "user_denied") this.notices.push("The user declined that action. Do not achieve the same thing another way: explain, offer an alternative, or ask what they prefer.");
      }
      if (lc.isTerminal) break;
    }
    if (lc.isTerminal) { this.last = { results, thought }; return; }

    this._settle(flags);
    if (finishCall && !lc.isTerminal) {
      const { result } = await this._exec("finish", finishCall.args, signal);
      record("finish", finishCall.args, result, false);
    }

    this.last = { results, thought };
    const invalidOnly = results.length > 0 && results.every((r) => r.result && INVALID.has(r.result.code));
    this.invalidStreak = invalidOnly ? this.invalidStreak + 1 : 0;
    if (this.invalidStreak >= this.limits.invalidLimit && !lc.isTerminal) lc.finish("budget_paused", "The model kept sending malformed tool calls. Paused with the progress saved.");
    this._publish("mission_round", { iteration: state.counters.iterations, phase: lc.phase, calls: results.map((r) => ({ tool: r.name, ok: !!(r.result && r.result.ok), code: r.result && r.result.code })), tainted: this.tainted });
  }

  /** Run until the mission ends (succeeded, blocked, impossible, unsafe, paused or cancelled). Never throws. */
  async run({ signal } = {}) {
    this._publish("mission_started", { objective: this.state.objective, phase: this.lc.phase, resumed: this.state.counters.iterations > 0, desktop: !!this.registry.desktop });
    try {
      while (!this.lc.isTerminal) {
        if (signal && signal.aborted) { this._stopped(); break; }
        const spent = this._exhausted();
        if (spent) { this.lc.finish("budget_exhausted", spent); break; }
        const over = this._overBudget();
        if (over) { this.lc.finish("budget_paused", over); break; }
        this.state.tick();
        this._stallCheck();
        if (this.lc.isTerminal) break;
        await this._round(signal);
        this._save();
      }
    } catch (err) {
      this.log("mission error:", (err && err.stack) || err);
      if (!this.lc.isTerminal) this.lc.finish("budget_paused", `An unexpected error stopped the mission (${clip((err && err.message) || err, 160)}). Its progress is saved.`);
    } finally {
      this._save();
      // the user's own window goes back in front, and the tools let go of the mouse and keyboard, BEFORE anyone is told it is finished
      try { if (this.registry.desktop && this.registry.desktop.finish) await this.registry.desktop.finish(); } catch (_) { /* a courtesy: never an error */ }
      this._publish("mission_finished", this.outcome());
    }
    return this.outcome();
  }

  /** Continue a paused or blocked mission. `answer` is what the user said (an answer, a permission, a hint). */
  resume({ answer } = {}) {
    const asked = this.lc.terminal && this.lc.terminal.reason; // the question this answers (read before the lifecycle moves on)
    this.lc.resume("resumed");
    // a secret typed into the chat would go to the model provider and into the checkpoint on disk: it is removed first, and the user is told
    const clean = answer ? redactSecrets(answer, { askedForSecret: asksForSecret(asked) }) : null;
    this.notices.push(clean ? `The user replied: ${clip(clean.text, 800)}` : "The user asked you to continue.");
    if (clean && clean.found) {
      this.notices.push("The user's reply contained something that looks like a secret (a key, token or password). Noah removed it before you saw it, and you must never ask for it in the chat. If the task needs it, tell the user to put it in the project's own .env file themselves (you cannot read that file) and to say continue; if the project does not load .env for its tests, propose that change (the user will be asked to approve it).");
      this._publish("mission_notice", { text: "Your reply looked like it contained a secret (a key, token or password). Noah removed it and did not send it to the model. Put secrets in the project's own .env file yourself; never type them here." });
    }
    this.invalidStreak = 0;
    this._pauseRequested = false;
    this._stallNudged = false;
    this.state.progress("resumed"); // the user said "continue": the stall count starts again, or a task paused for making no progress paused AGAIN at once, before running a step
    this._startedAt = this.now();
    this._base = { iterations: this.state.counters.iterations, modelCalls: this.stats.modelCalls };
    return this;
  }

  outcome() {
    const t = this.lc.terminal;
    return {
      missionId: this.id,
      status: t ? t.kind : "running",
      resumable: !!(t && t.resumable),
      reason: t ? t.reason : "",
      summary: t && t.kind === "succeeded" ? t.reason : "",
      verification: this.verifier.summaryText(),
      findings: Object.values(this.state.verification).filter((v) => v && v.asserted && v.evidence).map((v) => v.evidence), // what the model WROTE DOWN as having seen: the final answer is compared with it
      objective: this.state.objective,
      criteria: this.state.criteria.length,
      iterations: this.state.counters.iterations,
      commandsRun: this.state.counters.commands,
      filesChanged: Object.keys(this.state.files),
      changes: Object.entries(this.state.files).map(([p, f]) => ({ path: p, op: f.lastOp, diffs: f.diffs || [] })), // what the file tools really changed, for the final message
      testFilesChanged: Object.entries(this.state.files).filter(([p, f]) => f.check || isTestPath(p)).map(([p]) => p), // the checks themselves were touched (a test, or how tests are run): reported to the user by code
      tainted: this.tainted,
      injection: this.injection,
      stats: { ...this.stats },
    };
  }
}

/**
 * Build a whole mission: workspace (the folders the user granted), state, tools, verifier, lifecycle, runner.
 * @param {object} o
 * @param {string} o.objective
 * @param {string[]} o.roots   folders the user granted for this mission
 * @param {Function} o.callModel
 * @param {(req: object) => Promise<boolean>} [o.confirm]  the confirmation card
 * @param {string} [o.dataDir]  where checkpoints and long command logs live
 * @param {object} [o.restore]  a saved record (MissionStore.load) to carry on from
 */
function createMission({ id, objective, roots, ticket, callModel, confirm, mode = "autonomous", dataDir, limits, bus, now = Date.now, log, platform, restore = null, store, desktopBridge = null, experience = null }) {
  const ref = {};
  const workspace = new Workspace({ roots: [] });
  const granted = [];
  for (const r of roots || []) {
    try { granted.push(workspace.grant(r)); } catch (err) { if (!restore) throw err; } // a saved folder that is gone or no longer allowed is skipped, not fatal
  }
  const state = restore ? MissionState.restore(restore.state, { now }) : new MissionState({ id, objective, now });
  const missionsDir = dataDir ? path.join(dataDir, "missions") : null;
  // the tools say when they take over the mouse and keyboard (the panel shows a small bar then, and only then), and when they are waiting for the user to stop using them
  const takeover = (e) => {
    if (bus) { try { bus.publish("desktop_takeover", { missionId: id, ...e }); } catch (_) { /* telling the panel must never break a task */ } }
    if (e.state === "waiting" && ref.runner) ref.runner._show({ kind: "wait", level: "info", pending: false, text: "Waiting for you to stop using the computer", detail: "Noah takes over the mouse and keyboard only while you are not using them." }, "idle-wait");
  };
  const desktop = desktopBridge ? new DesktopTools({ bridge: desktopBridge, confirm, state, getMode: () => ref.runner.effectiveMode(), notify: takeover }) : null; // Noah's eyes and hands on the Windows desktop, when this task is one
  const registry = new ToolRegistry({ workspace, state, confirm, getMode: () => ref.runner.effectiveMode(), logDir: missionsDir ? path.join(missionsDir, state.id, "logs") : undefined, desktop });
  const verifier = new GoalVerifier({ state, ...registry.verifierEnv() });
  const lifecycle = new Lifecycle({ canPlan: () => (state.criteria.length ? true : "say how success will be checked first"), canSucceed: () => verifier.canSucceed() });
  if (restore) lifecycle.restore(restore.lifecycle);
  const control = new ControlTools({ state, verifier, lifecycle });
  const runner = new MissionRunner({ state, lifecycle, verifier, registry, control, callModel, limits, mode, bus, store: store || (missionsDir ? new MissionStore({ dir: missionsDir }) : null), roots: granted, ticket: ticket || (restore && restore.ticket) || null, now, log, platform, restored: restore, experience });
  ref.runner = runner;
  return runner;
}

module.exports = { MissionRunner, createMission, summarize, DEFAULT_LIMITS };
