// Noah/test/unit/draw-navigate.test.cjs
//
// The actual wiring: a "draw ..." goal makes RexyLegacyProvider (the adapter used for the hosted, free model - see
// its own header) return a deterministic navigate step to Jonah's drawing tool, exactly once, before anything else
// runs - the same pattern already used for "open x.com ...". Once already on the drawing tool, it must NOT
// re-navigate (that would wipe out whatever is on the canvas).

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { RexyLegacyProvider } = require("../../models/rexy-legacy.cjs");
const { DRAWING_TOOL_URL } = require("../../models/draw-goal.cjs");

function provider() {
  return new RexyLegacyProvider({ name: "rexy", baseURL: "https://example.invalid/predict", getKey: () => null });
}

function baseObs(url) {
  return { url, title: "Test", loading: false, pageText: { viewport: "" }, tabs: [] };
}

test("a drawing goal opens the drawing tool BEFORE any model call, and never touches the network", async () => {
  const p = provider();
  p.postJson = async () => { throw new Error("must not be called: the drawing-tool step must never reach the network"); };
  const res = await p.complete({ meta: { taskId: "t1", goal: "draw a rocket with a blue sky and green hills and a sun", observation: baseObs("https://en.wikipedia.org/") } });
  const args = res.toolCalls[0].args;
  assert.equal(args.status, "continue");
  assert.deepEqual(args.actions, [{ action: "navigate", url: DRAWING_TOOL_URL }]);
});

test("already on the drawing tool: does not re-navigate (falls through instead of wiping the canvas)", async () => {
  const p = provider();
  p.postJson = async () => ({ answer: "" });
  const res = await p.complete({ meta: { taskId: "t2", goal: "draw a rocket", observation: baseObs(DRAWING_TOOL_URL) } });
  const args = res.toolCalls[0].args;
  assert.notDeepEqual(args.actions && args.actions[0], { action: "navigate", url: DRAWING_TOOL_URL });
});

test("a non-drawing goal is unaffected (no navigate-to-drawing-tool step)", async () => {
  const p = provider();
  p.postJson = async () => ({ answer: "" });
  const res = await p.complete({ meta: { taskId: "t3", goal: "summarize the key points of this article", observation: baseObs("https://example.com/") } });
  const args = res.toolCalls[0].args;
  assert.notDeepEqual((args.actions || [])[0], { action: "navigate", url: DRAWING_TOOL_URL }, "this check must only ever fire for an actual drawing request");
});
