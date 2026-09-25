// Stand-ins for the two bridges the shell preload exposes to the voice orb (window.rexy, window.noah).
// They only RECORD how often the orb registers listeners and let the test fire events into them.
"use strict";

const counts = { completed: 0, paused: 0, error: 0, blocked: 0, step: 0, event: 0, goalCalls: [] };
const handlers = {};
const reg = (name) => (cb) => {
  counts[name]++;
  handlers[name] = cb;
  return cb;
};

window.rexy = {
  onGoalCompleted: reg("completed"),
  onGoalPaused: reg("paused"),
  onGoalError: reg("error"),
  onGoalBlocked: reg("blocked"),
  onGoalStep: reg("step"),
  goal: async (text, opts) => {
    counts.goalCalls.push({ text, opts });
    return { success: true, goalId: "x", kind: "agent" };
  },
};
window.noah = { onEvent: reg("event") };
window.__counts = counts;
window.__fire = (name, payload) => handlers[name] && handlers[name](payload);
