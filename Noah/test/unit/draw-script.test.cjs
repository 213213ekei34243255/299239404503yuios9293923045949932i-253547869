// Noah/test/unit/draw-script.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DrawScript, partsFor, regionRect, findCanvas } = require("../../models/draw-script.cjs");
const { DRAWING_TOOL_URL } = require("../../models/draw-goal.cjs");

test("partsFor: recognises the reported prompt's scene words, background-first regardless of sentence order", () => {
  const parts = partsFor("draw a rocket colour and also the surroundings with blue skies and great green hills and a sun");
  assert.deepEqual(parts.map((p) => p.key), ["sky", "hills", "sun", "rocket"], "sky/hills (background) before sun (foreground object) before rocket (drawn last)");
});

test("partsFor: only what is actually mentioned, nothing invented, and unknown words match nothing", () => {
  assert.deepEqual(partsFor("draw a sun").map((p) => p.key), ["sun"]);
  assert.deepEqual(partsFor("draw a spaceship and a wizard"), []);
  assert.deepEqual(partsFor(""), []);
});

test("regionRect: fractions of the canvas's OWN rect, so it works wherever the canvas actually is on screen", () => {
  const canvas = { x: 100, y: 50, width: 700, height: 460 };
  const sky = regionRect(canvas, "top-half");
  assert.deepEqual(sky, { from: { x: 100, y: 50 }, to: { x: 800, y: 280 } });
  const hills = regionRect(canvas, "bottom-third");
  assert.equal(hills.from.y, 50 + 460 * 0.66);
  assert.equal(hills.to.y, 50 + 460);
  const corner = regionRect(canvas, "top-right-corner");
  assert.ok(corner.from.x > canvas.x + canvas.width * 0.5, "a 'corner' region is actually near a corner, not the middle");
});

test("findCanvas: only a real, positively-sized canvas-role element counts", () => {
  const els = [{ role: "button", name: "blue color swatch", rect: { x: 1, y: 1, width: 10, height: 10 } }];
  assert.equal(findCanvas(els), null);
  const withCanvas = [...els, { role: "canvas", name: "Drawing Canvas", rect: { x: 5, y: 6, width: 700, height: 460 } }];
  assert.equal(findCanvas(withCanvas).name, "Drawing Canvas");
  assert.equal(findCanvas([{ role: "canvas", name: "x", rect: { x: 0, y: 0, width: 0, height: 0 } }]), null, "a zero-size rect is not a real, on-screen canvas");
});

// ---- the state machine: exactly what rexy-legacy.cjs drives it with, turn by turn

const CANVAS_EL = { role: "canvas", name: "Drawing Canvas", rect: { x: 0, y: 0, width: 700, height: 460 } };
function obsOn(url = DRAWING_TOOL_URL) {
  return { url };
}

test("DrawScript: one part per turn, click colour + click tool + drag, in that order, then moves to the next part", () => {
  const d = new DrawScript();
  const step1 = d.next({ taskId: "t1", goal: "draw a sun and a rocket", obs: obsOn(), els: [CANVAS_EL], recent: [] });
  assert.equal(step1.status, "continue");
  assert.deepEqual(step1.actions.map((a) => a.action), ["click", "click", "drag"]);
  assert.deepEqual(step1.actions[0].target, { text: "color yellow" });
  assert.deepEqual(step1.actions[1].target, { text: "Ellipse" });
  assert.equal(step1.actions[2].from.space, "viewport");

  // the drag "landed" (recent[-1] is an ok drag) -> next turn moves on to the rocket, not the sun again
  const step2 = d.next({ taskId: "t1", goal: "draw a sun and a rocket", obs: obsOn(), els: [CANVAS_EL], recent: [{ text: "drag (500,80)->(600,150) -> changed", ok: true }] });
  assert.deepEqual(step2.actions[1].target, { text: "Rectangle" });
  assert.deepEqual(step2.actions[0].target, { text: "color gray" });

  // the rocket also lands -> done
  const step3 = d.next({ taskId: "t1", goal: "draw a sun and a rocket", obs: obsOn(), els: [CANVAS_EL], recent: [{ text: "drag (300,100)->(400,300) -> changed", ok: true }] });
  assert.equal(step3.status, "done");
  assert.match(step3.result, /sun/);
  assert.match(step3.result, /rocket/);
});

test("DrawScript: not applicable off the drawing tool, or when nothing in the goal is recognised", () => {
  const d = new DrawScript();
  assert.equal(d.next({ taskId: "t2", goal: "draw a sun", obs: obsOn("https://example.com/"), els: [CANVAS_EL], recent: [] }), null);
  assert.equal(d.next({ taskId: "t3", goal: "draw a spaceship", obs: obsOn(), els: [CANVAS_EL], recent: [] }), null);
});

test("DrawScript: waits for the canvas if it is not found yet, then gives up honestly rather than looping forever", () => {
  const d = new DrawScript();
  for (let i = 0; i < 3; i++) {
    const step = d.next({ taskId: "t4", goal: "draw a sun", obs: obsOn(), els: [], recent: [] });
    assert.equal(step.status, "continue");
    assert.match(step.actions[0].action, /wait/);
  }
  const gaveUp = d.next({ taskId: "t4", goal: "draw a sun", obs: obsOn(), els: [], recent: [] });
  assert.equal(gaveUp.status, "give_up");
});

test("DrawScript: a drag that visibly did nothing counts as a real failure, not silent success, and gives up after repeated failures", () => {
  const d = new DrawScript();
  const first = d.next({ taskId: "t5", goal: "draw a sun", obs: obsOn(), els: [CANVAS_EL], recent: [] });
  assert.equal(first.status, "continue");
  // the drag came back with ok:false (no_effect) both times
  const retry = d.next({ taskId: "t5", goal: "draw a sun", obs: obsOn(), els: [CANVAS_EL], recent: [{ text: "drag (1,1)->(2,2) -> no_effect", ok: false }] });
  assert.equal(retry.status, "continue", "one failure is retried, not given up on immediately");
  const gaveUp = d.next({ taskId: "t5", goal: "draw a sun", obs: obsOn(), els: [CANVAS_EL], recent: [{ text: "drag (1,1)->(2,2) -> no_effect", ok: false }] });
  assert.equal(gaveUp.status, "give_up");
  assert.match(gaveUp.summary, /sun/);
});
