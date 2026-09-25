// Noah/agent/lifecycle-log.cjs
//
// Structured lifecycle log for the agent session (AGENT_SESSION_*, AGENT_RUN_*, BROWSER_NAVIGATION, ACTIVE_TAB_CHANGED,
// VOICE_COMMAND_RECEIVED, TEXT_COMMAND_RECEIVED, IPC_LISTENER_*). One JSON object per line, every entry carrying
// sessionId / runId / tabId / url / timestamp so a lifecycle bug is obvious from the log alone.
//
// Off by default (it is a development aid, not something to spam a user's console with). Turn it on with the environment
// variable NOAH_LOG=1, or in code with setEnabled(true) / setSink(fn) (the tests do).

"use strict";

let enabled = process.env.NOAH_LOG === "1";
let sink = (line) => console.log("[noah-lifecycle]", line);
const ctx = { sessionId: null, runId: null, tabId: null, url: null };

function setEnabled(v) {
  enabled = !!v;
}
function setSink(fn) {
  sink = typeof fn === "function" ? fn : sink;
}
/** Session/browser fields every later entry inherits (kept current by AgentSession). */
function setContext(partial) {
  Object.assign(ctx, partial);
}

function slog(event, fields = {}) {
  if (!enabled) return;
  try {
    sink(JSON.stringify({ event, ...ctx, ...fields, timestamp: new Date().toISOString() }));
  } catch (_) {
    /* logging must never affect the agent */
  }
}

module.exports = { slog, setEnabled, setSink, setContext, isEnabled: () => enabled };
