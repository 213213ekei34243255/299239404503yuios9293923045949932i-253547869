// Noah/events.cjs
//
// The central action/event stream (spec §38.15). The ComputerController emits
// the *same* event object that the cursor overlay, audit logger and
// benchmark tracer consume, so what is drawn can never drift from what was
// done. Events are plain JSON-serialisable objects: { event, seq, ts, taskId, ... }.
//
// Event names used across Noah:
//   task_started task_state task_finished
//   agent_status            { phase, text }               (thinking / observing / ...)
//   session_state           { sessionId, state, label, text, taskId, runId, enabled }   (the ONE status stream: idle / planning / executing / paused / waiting_for_user / completed / error)
//   mouse_action            { action, x, y, source, target, ... }
//   keyboard_action         { action, chars, durationMs, ... }
//   scroll_action           { x, y, deltaX, deltaY }
//   cursor_state            { state }                     (THINKING, WAITING, ERROR ...)
//   observation             { summary }
//   action_result           { action, ok, verification, method }
//   confirm_request / confirm_resolved
//   recovery                { failure, strategy, outcome }
//   model_call              { role, provider, model, usage, latencyMs }
//   safety                  { level, decision, ... }

"use strict";

const { EventEmitter } = require("events");

class EventBus extends EventEmitter {
  constructor({ ringSize = 500 } = {}) {
    super();
    this.setMaxListeners(50);
    this._seq = 0;
    this._ring = [];
    this._ringSize = ringSize;
    this.taskId = null;
  }

  setTask(taskId) {
    this.taskId = taskId;
  }

  /** Emit a named event. Returns the stamped event object. */
  publish(event, payload = {}) {
    const evt = { event, seq: ++this._seq, ts: Date.now(), taskId: this.taskId, ...payload };
    this._ring.push(evt);
    if (this._ring.length > this._ringSize) this._ring.shift();
    // Consumers must never be able to break the agent.
    try {
      this.emit("*", evt);
      this.emit(event, evt);
    } catch (err) {
      try {
        this.emit("listener_error", { event, error: err.message });
      } catch (_) {
        /* ignore */
      }
    }
    return evt;
  }

  /** Subscribe to every event; returns an unsubscribe function. */
  subscribe(fn) {
    this.on("*", fn);
    return () => this.off("*", fn);
  }

  recent(n = 100) {
    return this._ring.slice(-n);
  }
}

module.exports = { EventBus };
