// Noah/test/unit/web-pointing.test.cjs - a click by coordinates lands on what the model meant (browser/pointing.cjs): a near miss goes onto the one control that is clearly
// closest, a click already on a control or between two is left alone, and the model is told in a sentence what its click hit.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isInteractiveHit, distanceToRect, nearestInteractive, planSnap, describeLanding } = require("../../browser/pointing.cjs");

const el = (ref, name, x, y, w, h, extra = {}) => ({ ref, name, role: "button", interactive: true, rect: { x, y, width: w, height: h }, states: {}, ...extra });
const VIEW = { width: 1000, height: 700 };
const SAVE = el("e1", "Save", 100, 100, 80, 30); // 100..180 x 100..130
const CANCEL = el("e2", "Cancel", 200, 100, 80, 30);
const PAGE = { tag: "div", role: null, text: "" };

test("distanceToRect: 0 inside, straight distance to an edge, diagonal to a corner", () => {
  const r = { x: 100, y: 100, width: 80, height: 30 };
  assert.equal(distanceToRect(120, 110, r), 0);
  assert.equal(distanceToRect(95, 110, r), 5);
  assert.equal(distanceToRect(120, 140, r), 10);
  assert.equal(Math.round(distanceToRect(93, 94, r) * 10) / 10, Math.hypot(7, 6).toFixed(1) * 1);
});

test("isInteractiveHit: buttons, links, fields and ARIA widgets count; a plain div does not", () => {
  for (const hit of [{ tag: "button" }, { tag: "a", href: "https://x" }, { tag: "input" }, { tag: "div", role: "button" }, { tag: "span", role: "menuitem" }, { tag: "div", href: "https://x" }]) assert.equal(isInteractiveHit(hit), true, JSON.stringify(hit));
  for (const hit of [{ tag: "div" }, { tag: "p", role: null }, { tag: "span", role: "presentation" }, null]) assert.equal(isInteractiveHit(hit), false, JSON.stringify(hit));
});

test("a point just outside a button, on nothing clickable, is moved onto that button's middle", () => {
  const plan = planSnap(PAGE, [SAVE, CANCEL], 94, 115, VIEW);
  assert.ok(plan, "snapped");
  assert.equal(plan.el.ref, "e1");
  assert.deepEqual([plan.x, plan.y], [140, 115]);
  assert.equal(plan.distance, 6);
});

test("it never moves a click that is already on a control", () => {
  assert.equal(planSnap({ tag: "button", text: "Save" }, [SAVE, CANCEL], 94, 115, VIEW), null);
  assert.equal(planSnap({ tag: "div", role: "button" }, [SAVE], 94, 115, VIEW), null);
});

test("it never moves a click that is inside an element the observation listed (distance 0): the page chose what that spot is", () => {
  assert.equal(planSnap(PAGE, [SAVE], 120, 115, VIEW), null);
});

test("two controls about equally close: no guess", () => {
  // 190 is 10 from SAVE (right edge 180) and 10 from CANCEL (left edge 200)
  assert.equal(planSnap(PAGE, [SAVE, CANCEL], 190, 115, VIEW), null);
  // nearer one clearly wins
  const plan = planSnap(PAGE, [SAVE, CANCEL], 186, 115, VIEW);
  assert.equal(plan && plan.el.ref, "e1", "6 px from Save, 14 from Cancel");
});

test("a miss by more than the radius is not a near miss: nothing is moved", () => {
  assert.equal(planSnap(PAGE, [SAVE], 60, 115, VIEW), null, "40 px away");
  assert.ok(planSnap(PAGE, [SAVE], 90, 115, VIEW), "10 px away is");
});

test("disabled, hidden, tiny and non-clickable elements are never snap targets", () => {
  assert.equal(planSnap(PAGE, [el("e3", "Off", 100, 100, 80, 30, { states: { disabled: true } })], 94, 115, VIEW), null);
  assert.equal(planSnap(PAGE, [el("e4", "Dot", 100, 100, 2, 2)], 98, 101, VIEW), null);
  assert.equal(planSnap(PAGE, [el("e5", "Title", 100, 100, 80, 30, { role: "heading" })], 94, 115, VIEW), null);
  assert.equal(planSnap(PAGE, [el("e6", "x", 100, 100, 80, 30, { interactive: false })], 94, 115, VIEW), null);
});

test("the new point stays inside the viewport", () => {
  const edge = el("e7", "Menu", 990, 5, 40, 20); // sticks out of a 1000-wide viewport
  const plan = planSnap(PAGE, [edge], 985, 15, { width: 1000, height: 700 });
  assert.ok(plan.x <= 999 && plan.y >= 0);
});

test("the sentence the model reads says what the click hit, and when it was moved", () => {
  const plan = planSnap(PAGE, [SAVE], 94, 115, VIEW);
  assert.match(describeLanding({ x: plan.x, y: plan.y, hit: { tag: "button", text: "Save" }, snap: plan }), /moved it 6 px onto button "Save"/);
  assert.match(describeLanding({ x: 140, y: 115, hit: { tag: "button", role: null, text: "Save" } }), /landed on button "Save"/);
  const near = nearestInteractive([SAVE], 60, 115);
  const miss = describeLanding({ x: 60, y: 115, hit: PAGE, near });
  assert.match(miss, /landed on a <div> that is not a control/);
  assert.match(miss, /nearest clickable thing is button "Save", about 40 px away/);
  assert.match(miss, /point more carefully/);
});

test("a canvas, a panel or anything bigger than a control is never a snap target (drawing points are deliberate)", () => {
  const canvas = el("e8", "Drawing area", 100, 100, 800, 500, { role: "canvas" });
  assert.equal(planSnap(PAGE, [canvas], 94, 115, VIEW), null);
  const panel = el("e9", "Sidebar", 100, 100, 600, 300, { role: "button" });
  assert.equal(planSnap(PAGE, [panel], 94, 115, VIEW), null, "600 x 300 is not control-sized");
  assert.ok(planSnap(PAGE, [el("e10", "Wide", 100, 100, 400, 40)], 94, 115, VIEW), "400 x 40 is");
});

test("landPoint: moves a near miss only for plain clicks, and always says what was hit", async () => {
  const { landPoint } = require("../../browser/pointing.cjs");
  const under = (x, y) => (x >= 100 && x <= 180 && y >= 100 && y <= 130 ? { tag: "button", text: "Save" } : { tag: "div", text: "" });
  const observer = { last: { elements: [SAVE, CANCEL] }, describePoint: async (x, y) => under(x, y) };
  const miss = await landPoint(observer, { x: 94, y: 115 }, VIEW);
  assert.deepEqual([miss.vx, miss.vy], [140, 115]);
  assert.equal(miss.snapped.name, "Save");
  assert.match(miss.landing, /moved it 6 px onto button "Save"/);
  const still = await landPoint(observer, { x: 94, y: 115 }, VIEW, { allowSnap: false });
  assert.deepEqual([still.vx, still.vy], [94, 115], "a hover, move or drag keeps its point");
  assert.equal(still.snapped, null);
  assert.match(still.landing, /not a control/);
  const exact = await landPoint(observer, { x: 120, y: 115 }, VIEW);
  assert.deepEqual([exact.vx, exact.vy], [120, 115]);
  assert.match(exact.landing, /landed on button "Save"/);
  const broken = await landPoint({ last: null, describePoint: async () => { throw new Error("page gone"); } }, { x: 5, y: 5 }, VIEW);
  assert.deepEqual([broken.vx, broken.vy], [5, 5], "a page that cannot be inspected is clicked as given");
});

test("the note sent with every screenshot states its size and what x and y mean for that model's coordinate system", () => {
  const { coordinateNoteFor } = require("../../agent/prompts.cjs");
  const px = coordinateNoteFor("image_px", 1280, 720);
  assert.match(px, /1280x720 pixels/);
  assert.match(px, /x is between 0 and 1280 and y between 0 and 720/);
  assert.match(px, /Do NOT give page \(CSS\) pixels/);
  const g = coordinateNoteFor("normalized_1000", 1280, 720);
  assert.match(g, /0-999 grid/);
  assert.match(g, /each between 0 and 999/);
  assert.match(g, /NOT pixels/);
  assert.match(coordinateNoteFor("normalized_1", 800, 600), /between 0 and 1/);
  assert.match(coordinateNoteFor("something-else", 800, 600), /pixels of the screenshot/, "an unknown space falls back to pixels");
});
