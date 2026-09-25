// Noah/agent/session.cjs
//
// The AGENT SESSION: what stays true while the user works with the agent, as opposed to an AGENT RUN, which is one
// instruction being carried out (think, act, observe ... finish or pause).
//
//   Session (lives for the whole app window)        Run (one instruction)
//   ----------------------------------------        ---------------------
//   id, enabled                                     runId
//   executionState                                  planning -> executing -> completed | error | cancelled
//   task (current / last), conversation             may pause and resume, may be superseded by the next command
//   browser context (tab, url, title, ready)
//
// Rules this file enforces by construction:
//   * a finished, failed, cancelled, paused or superseded run never destroys the session
//   * navigation and tab changes update the browser context; they never reset the task or the conversation
//   * "agent mode enabled" (`enabled`) is a separate fact from what a run is doing (`executionState`): the agent is
//     available in every state; "idle" means "ready for the next instruction"
//   * voice and text both reach the same session through the CommandRouter
//
// It holds compact facts only (no page DOM, no history dump): enough to resolve "continue writing the story" or
// "on the notepad please" against the page that is already open.

"use strict";

const { EventEmitter } = require("events");
const { randomUUID } = require("crypto");
const { slog, setContext } = require("./lifecycle-log.cjs");

const STATES = ["idle", "planning", "executing", "paused", "waiting_for_user", "completed", "error"];
const ACTIVE = new Set(["planning", "executing", "paused", "waiting_for_user"]);
/** What the user sees. Internal reasoning is never shown: only where things stand. */
const LABEL = {
  idle: "Ready",
  planning: "Working…",
  executing: "Working…",
  paused: "Paused — the browser is under your control",
  waiting_for_user: "Waiting for you",
  completed: "Done",
  error: "Something went wrong",
};
const RECENT_MS = 2 * 60 * 60_000; // "continue the story" still means the story after a coffee break; only short follow-up-shaped messages are ever treated this way
const MAX_CONVERSATION = 12;

class AgentSession extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('../events.cjs').EventBus} o.bus
   * @param {() => number} [o.now]
   */
  constructor({ bus, now = Date.now } = {}) {
    super();
    this.bus = bus;
    this.now = now;
    this.id = randomUUID();
    this.enabled = true; // agent mode: on for the whole session (there is no per-request activation)
    this.executionState = "idle";
    this.stateText = ""; // one short action description for the current state ("Writing in the notepad")
    this.task = null; // { id, goal, source, startedAt, status, result?, error? } (current or last)
    this.runId = null; // set only while a run is active
    this.runs = 0;
    this.conversation = []; // [{ at, source, text, followUp, outcome }] (most recent last)
    this.lastResult = null;
    this.lastWritten = ""; // the tail of the text Noah last typed into a page ("continue the story" continues from here)
    this.browser = { tabId: null, url: "", title: "", pageReady: false, lastAction: null, timestamp: 0 };
    this._lastActivity = this.now();
    setContext({ sessionId: this.id });
    slog("AGENT_SESSION_CREATED", { sessionId: this.id });

    // Pauses, questions and confirmations move the RUN between paused/waiting/executing. The session survives all of them.
    this._unsub = bus
      ? bus.subscribe((e) => {
          if (!this.isActive) return;
          switch (e.event) {
            case "safety":
              if (e.level === "pause") this.paused(e.reason);
              else if (e.level === "resume") this.resumed();
              break;
            case "ask_user":
            case "confirm_request":
              this.paused("waiting");
              break;
            case "confirm_resolved":
              if (this.executionState === "waiting_for_user") this.resumed();
              break;
            default:
              break;
          }
        })
      : null;
  }

  // ------------------------------------------------------------------ state

  get isActive() {
    return ACTIVE.has(this.executionState);
  }

  get label() {
    return LABEL[this.executionState] || "";
  }

  /** Move to `next`. Publishes ONE `session_state` event per real change (never a stream of identical ones). */
  transition(next, { reason = "", text } = {}) {
    if (!STATES.includes(next)) throw new Error(`unknown session state: ${next}`);
    const nextText = text !== undefined ? String(text).slice(0, 80) : next === this.executionState ? this.stateText : "";
    if (next === this.executionState && nextText === this.stateText) return false;
    const prev = this.executionState;
    this.executionState = next;
    this.stateText = nextText;
    this._lastActivity = this.now();
    this.emit("state", { state: next, previous: prev, reason });
    this._publish();
    if (next !== prev) slog(next === "paused" ? "AGENT_SESSION_PAUSED" : prev === "paused" && next === "executing" ? "AGENT_SESSION_RESUMED" : "AGENT_SESSION_STATE", { from: prev, to: next, reason });
    return true;
  }

  _publish() {
    this.bus?.publish("session_state", { sessionId: this.id, state: this.executionState, label: this.label, text: this.stateText, taskId: this.task?.id || null, runId: this.runId, enabled: this.enabled });
  }

  // -------------------------------------------------------------------- runs

  runStarted({ runId, taskId, goal, source = "text", followUp = false }) {
    this.runId = runId;
    this.runs++;
    this.task = { id: taskId, goal, source, followUp, startedAt: this.now(), status: "running" };
    this.conversation.push({ at: this.now(), source, text: goal, followUp, outcome: null });
    if (this.conversation.length > MAX_CONVERSATION) this.conversation.shift();
    setContext({ runId });
    slog(this.runs > 1 ? "AGENT_SESSION_REUSED" : "AGENT_SESSION_STARTED", { runNumber: this.runs });
    slog("AGENT_RUN_STARTED", { taskId, source, followUp, goal: String(goal).slice(0, 120) });
    this.transition("planning", { reason: "run_started" });
  }

  runExecuting(text = "") {
    if (!this.runId) return;
    this.transition("executing", { reason: "run_executing", text });
  }

  /** The run ended. `superseded`: a newer instruction replaced it, so the session goes straight into the next run. */
  runFinished(status, { result, error, superseded = false } = {}) {
    if (!this.runId) return;
    const runId = this.runId;
    if (this.task) Object.assign(this.task, { status, result, error });
    const last = this.conversation[this.conversation.length - 1];
    if (last) last.outcome = superseded ? "superseded" : status;
    if (status === "completed") this.lastResult = String(result || "").slice(0, 300);
    this.runId = null;
    setContext({ runId: null });
    slog(status === "completed" ? "AGENT_RUN_COMPLETED" : status === "cancelled" ? "AGENT_RUN_CANCELLED" : "AGENT_RUN_FAILED", { finishedRunId: runId, superseded, error: error ? String(error).slice(0, 160) : undefined });
    if (superseded) return; // the next run's runStarted moves the state on
    this.transition(status === "completed" ? "completed" : status === "cancelled" ? "idle" : "error", { reason: "run_finished", text: status === "failed" ? String(error || "").slice(0, 80) : "" });
  }

  /** The user took control / the agent is waiting for an answer. The session, the task and the page stay exactly as they were. */
  paused(reason) {
    if (!this.isActive) return;
    const waiting = reason === "waiting" || reason === "ask_user";
    this.transition(waiting ? "waiting_for_user" : "paused", { reason: String(reason || "user") });
  }

  resumed() {
    if (this.executionState === "paused" || this.executionState === "waiting_for_user") this.transition("executing", { reason: "resumed" });
  }

  /** One short description of what is happening right now, shown instead of a stream of internal messages. */
  note(text) {
    if (this.executionState === "executing" || this.executionState === "planning") this.transition(this.executionState, { text });
  }

  /** Text Noah just typed into a page: kept (compactly) so a follow-up can carry on from it. */
  noteWritten(text) {
    const t = String(text || "").trim();
    if (t.length >= 80) this.lastWritten = t.slice(-900);
  }

  // --------------------------------------------------------------- the browser

  /** Merge what we learned about the page in front of the user (a navigation, a tab switch, a step's observation). */
  updateBrowser(partial, why = "") {
    const before = this.browser;
    this.browser = { ...before, ...partial, timestamp: this.now() };
    setContext({ tabId: this.browser.tabId, url: this.browser.url });
    if (partial.tabId !== undefined && partial.tabId !== before.tabId) slog("ACTIVE_TAB_CHANGED", { from: before.tabId, why });
    if (partial.url !== undefined && partial.url !== before.url) slog("BROWSER_NAVIGATION", { from: before.url, why });
  }

  // ------------------------------------------------------------ conversation

  hasRecentTask(ms = RECENT_MS) {
    return !!this.task && (this.isActive || this.now() - this._lastActivity <= ms);
  }

  /** Compact context for a follow-up instruction: enough to resolve "the story" and "the notepad", nothing more. */
  contextFor() {
    const previous = this.conversation.slice(-5).map((c) => c.text);
    return {
      sessionId: this.id,
      previousGoals: previous,
      lastGoal: this.task?.goal || null,
      lastResult: this.lastResult,
      lastWritten: this.lastWritten,
      browser: { tabId: this.browser.tabId, url: this.browser.url, title: this.browser.title, pageReady: this.browser.pageReady },
    };
  }

  snapshot() {
    return { sessionId: this.id, enabled: this.enabled, state: this.executionState, label: this.label, text: this.stateText, task: this.task ? { id: this.task.id, goal: this.task.goal, status: this.task.status } : null, runId: this.runId, runs: this.runs, browser: { ...this.browser } };
  }

  /** Only when the app window goes away. Nothing in normal operation calls this. */
  destroy() {
    slog("AGENT_SESSION_DESTROYED", { runs: this.runs });
    this._unsub?.();
    this._unsub = null;
    this.removeAllListeners();
  }
}

module.exports = { AgentSession, STATES, LABEL, RECENT_MS };
