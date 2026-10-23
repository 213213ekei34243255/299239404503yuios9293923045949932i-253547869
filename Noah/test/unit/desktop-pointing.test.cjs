// Noah/test/unit/desktop-pointing.test.cjs - the computer agent's pointing aids: numbered boxes (click by number, no coordinates), the size of the picture stated plainly,
// a point outside the picture refused instead of clicked somewhere else, a ring where the last click landed, and a model name's family deciding its coordinate system.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DesktopTools } = require("../../desktop/tools.cjs");
const { modelInfo } = require("../../models/catalog.cjs");

const NOTEPAD = { window: 101, title: "Untitled - Notepad", process: "notepad", pid: 7, class: "Notepad", x: 100, y: 200, w: 2000, h: 1200, foreground: true, minimized: false };
const MARKS = [
  { n: 1, element: "e11", name: "Save", type: "Button", x: 10, y: 10, w: 80, h: 30, cx: 50, cy: 25 },
  { n: 2, element: "e12", name: "Cancel", type: "Button", x: 100, y: 10, w: 80, h: 30, cx: 140, cy: 25 },
];

class Bridge {
  constructor(marks = MARKS) { this.marks = marks; this.shots = []; this.clicks = []; }
  async windows() { return [NOTEPAD]; }
  async userIdle() { return { idleMs: 60000 }; }
  async screenshot(a) { this.shots.push(a); return { mime: "image/png", base64: "UEZBS0VQSUNUVVJF".repeat(20), width: 1568, height: 940, sourceWidth: 2000, sourceHeight: 1200, scale: 0.784, x: 100, y: 200, marks: this.marks, grid: !!a.grid }; }
  async click(a) { this.clicks.push(a); return { method: a.element ? "invoke" : "mouse", name: a.element ? "Save" : "(spot)" }; }
  async hit() { return null; }
  async hitAt() { return null; }
  async focus() { return { previous: 101 }; }
  async interactive() { return { nodes: [], title: "" }; }
  async focused() { return null; }
  async stop() {}
}

function make(bridge = new Bridge()) {
  const clock = { t: 0 };
  const t = new DesktopTools({ bridge, getMode: () => "autonomous", ocr: async () => [], confirm: async () => true, notify: () => {}, now: () => clock.t, pause: async (ms) => { clock.t += ms; }, restoreAfterMs: 60_000, takeOver: false });
  return { t, bridge, clock };
}

test("the screenshot asks for numbered boxes and says exactly how big the picture is and what x and y mean", async () => {
  const { t, bridge } = make();
  const r = await t.screenshot({ window: 101 });
  assert.equal(r.ok, true);
  assert.equal(bridge.shots[0].marks, true, "numbered boxes are asked for");
  assert.equal(bridge.shots[0].maxWidth, 1568);
  assert.match(r.note, /The picture is 1568 x 940 pixels/);
  assert.match(r.note, /ALWAYS in these pixels/);
  assert.match(r.note, /never a 0-1000 scale/);
  assert.match(r.note, /2 controls/);
  assert.match(r.note, /1 Button "Save"; 2 Button "Cancel"/);
  assert.equal(r.marks, 2);
});

test("a click by box number is a click on that control, with no coordinates", async () => {
  const { t, bridge } = make();
  await t.screenshot({ window: 101 });
  const r = await t.click({ mark: 2 });
  assert.equal(r.ok, true);
  assert.equal(bridge.clicks.length, 1);
  assert.equal(bridge.clicks[0].element, "e12", "box 2 stands for the control e12");
  assert.equal(bridge.clicks[0].x, undefined);
});

test("a box number that is not in the last picture is refused with what the picture does have", async () => {
  const { t, bridge } = make();
  assert.equal((await t.click({ mark: 1 })).code, "no_such_mark", "no picture yet");
  await t.screenshot({ window: 101 });
  const r = await t.click({ mark: 9 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "no_such_mark");
  assert.match(r.message, /it has 2/);
  assert.equal(bridge.clicks.length, 0);
});

test("a point outside the picture is refused and the picture's size is repeated, never clicked somewhere else", async () => {
  const { t, bridge } = make();
  await t.screenshot({ window: 101 });
  for (const [x, y] of [[2500, 100], [100, 5000], [-5, 10], [10, -1]]) {
    const r = await t.click({ window: 101, x, y });
    assert.equal(r.ok, false, `(${x}, ${y})`);
    assert.equal(r.code, "outside_picture");
    assert.match(r.message, /1568 x 940 pixels/);
  }
  assert.equal(bridge.clicks.length, 0, "nothing was clicked");
});

test("a point inside the picture is mapped to the screen exactly: window origin + point / scale", async () => {
  const { t, bridge } = make();
  await t.screenshot({ window: 101 });
  const r = await t.click({ window: 101, x: 784, y: 470 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.at, { x: 100 + Math.round(784 / 0.784), y: 200 + Math.round(470 / 0.784) });
  assert.equal(bridge.clicks[0].x, r.at.x);
  assert.equal(bridge.clicks[0].y, r.at.y);
});

test("the next picture of that window shows where the last click landed; a window never clicked has no ring; the ring expires", async () => {
  const { t, bridge, clock } = make();
  await t.screenshot({ window: 101 });
  assert.equal(bridge.shots[0].pointer, undefined);
  const c = await t.click({ window: 101, x: 784, y: 470 });
  const shot = await t.screenshot({ window: 101 });
  assert.deepEqual(bridge.shots[1].pointer, { x: c.at.x, y: c.at.y }, "the screen position of the click, drawn by the helper");
  assert.match(shot.note, /yellow ring marked 'last click'/);
  clock.t += 4 * 60_000;
  await t.screenshot({ window: 101 });
  assert.equal(bridge.shots[2].pointer, undefined, "an old click is not shown");
});

test("a Gemini or Qwen3 model the list does not know by name still gets the 0-999 grid, Claude and GPT pixels", () => {
  for (const m of ["gemini-2.5-flash", "gemini-flash-latest", "models/gemini-2.0-flash-001", "gemini-9-ultra", "qwen3-vl-235b-a22b"]) assert.equal(modelInfo(m).coordinateSpace, "normalized_1000", m);
  for (const m of ["claude-sonnet-4-5", "claude-opus-9", "gpt-4o", "o4-mini", "qwen2.5-vl-72b-instruct", "qwen-vl-max", "some-unknown-model", "rexy-render", ""]) assert.equal(modelInfo(m).coordinateSpace, "image_px", m);
  assert.equal(modelInfo("gemini-3.8-flash").coordinateSpace, "normalized_1000", "listed models are unchanged");
  assert.equal(modelInfo("claude-sonnet-5").maxImageLongEdge, 2576, "and keep their own limits");
});

// ------------------------------------------------------------------ a model that answers on a 0-1000 scale (Gemini): the hosted brain

test("for a model that answers on a 0-1000 scale the screenshot says so, with a grid labelled on that scale, and a click converts x / 1000 x width exactly", async () => {
  const { t, bridge } = make();
  t.setCoordinateSpace("normalized_1000");
  const r = await t.screenshot({ window: 101 });
  assert.equal(bridge.shots[0].gridUnits, "normalized", "the helper is asked for a grid labelled on the 0-1000 scale");
  assert.match(r.note, /give x and y on a 0-1000 scale/);
  assert.match(r.note, /NOT pixels/);
  assert.match(r.note, /1568 x 940 pixels/, "it still states the real size");
  assert.doesNotMatch(r.note, /ALWAYS in these pixels/);
  // the centre of the picture: (500, 500) -> picture pixel (784, 470) -> screen = origin + pixel / scale
  const c = await t.click({ window: 101, x: 500, y: 500 });
  assert.equal(c.ok, true);
  assert.deepEqual(c.at, { x: 100 + Math.round(784 / 0.784), y: 200 + Math.round(470 / 0.784) });
  // a corner
  const c2 = await t.click({ window: 101, x: 0, y: 1000 });
  assert.deepEqual(c2.at, { x: 100, y: 200 + Math.round(940 / 0.784) });
});

test("on the 0-1000 scale a point beyond 1000 is refused with the scale explained (it is a pixel position)", async () => {
  const { t, bridge } = make();
  t.setCoordinateSpace("normalized_1000");
  await t.screenshot({ window: 101 });
  for (const [x, y] of [[1400, 300], [200, 1500], [-3, 10]]) {
    const r = await t.click({ window: 101, x, y });
    assert.equal(r.ok, false);
    assert.equal(r.code, "outside_picture");
    assert.match(r.message, /0-1000 scale/);
  }
  assert.equal(bridge.clicks.length, 0);
});

test("the scale follows the model that answered last: Gemini then Claude (pixels) then back", async () => {
  const { t, bridge } = make();
  await t.screenshot({ window: 101 });
  assert.equal(bridge.shots[0].gridUnits, undefined, "pixels by default");
  t.setCoordinateSpace("normalized_1000");
  await t.screenshot({ window: 101 });
  assert.equal(bridge.shots[1].gridUnits, "normalized");
  t.setCoordinateSpace("image_px");
  await t.screenshot({ window: 101 });
  assert.equal(bridge.shots[2].gridUnits, undefined);
  t.setCoordinateSpace("something-unknown");
  assert.equal(t.coordinateSpace, "image_px", "anything unknown means pixels");
});

test("the mission loop hands the answering model's coordinate system to the desktop tools after every model call", () => {
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "autonomy", "mission-runner.cjs"), "utf8");
  assert.match(src, /this\.registry\.desktop\.setCoordinateSpace\(res && res\.coordinateSpace\)/);
  // and the router really returns it on every call
  const router = fs.readFileSync(path.join(__dirname, "..", "..", "models", "router.cjs"), "utf8");
  assert.match(router, /coordinateSpace: c\.info\.coordinateSpace/);
});

test("the hosted brain is a candidate for the Web agent: browser (text steps) and vision (steps with a screenshot) use it first, and it points on the 0-1000 scale", () => {
  const { DEFAULT_ROLES, modelInfo } = require("../../models/catalog.cjs");
  assert.deepEqual(DEFAULT_ROLES.browser[0], { provider: "noahai", model: "browser", trusted: true });
  assert.deepEqual(DEFAULT_ROLES.vision[0], { provider: "noahai", model: "vision", trusted: true });
  assert.equal(modelInfo("vision").coordinateSpace, "normalized_1000");
  assert.equal(modelInfo("vision").vision, true);
  assert.equal(modelInfo("browser").vision, false, "the flash-lite model behind 'browser' has not been verified with images, so a screenshot step never goes to it");
  assert.equal(modelInfo("mission").vision, true);
});
