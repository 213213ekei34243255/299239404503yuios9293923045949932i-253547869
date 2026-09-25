"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { FrameGeometry, CoordinateError, fitImageSize } = require("../../computer/coordinates.cjs");

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test("identity: 1000x600 image of a 1000x600 viewport", () => {
  const g = new FrameGeometry({ image: { width: 1000, height: 600 }, viewport: { width: 1000, height: 600 } });
  assert.deepEqual(g.modelToViewport(360, 220), { x: 360, y: 220 });
});

test("downscaled screenshot maps back to CSS viewport (HiDPI: image is 1280 wide, viewport 1920 CSS px)", () => {
  const g = new FrameGeometry({ image: { width: 1280, height: 720 }, viewport: { width: 1920, height: 1080 }, devicePixelRatio: 2 });
  const p = g.modelToViewport(640, 360);
  near(p.x, 960);
  near(p.y, 540);
  const back = g.viewportToModel(p.x, p.y);
  near(back.x, 640);
  near(back.y, 360);
});

test("ratio comes from image/viewport, so DPR and zoom of the capture do not matter", () => {
  // Same CSS viewport, screenshot captured at DPR 2 (2000px wide) then resized to 1000: identical mapping.
  const a = new FrameGeometry({ image: { width: 1000, height: 600 }, viewport: { width: 1000, height: 600 } });
  const b = new FrameGeometry({ image: { width: 1000, height: 600 }, viewport: { width: 1000, height: 600 }, devicePixelRatio: 2, zoomFactor: 1 });
  assert.deepEqual(a.modelToViewport(123, 456), b.modelToViewport(123, 456));
});

test("zoomed page: viewport is smaller in CSS px; shell overlay scales by zoom", () => {
  // 1200x720 DIP webview at zoom 1.5 => 800x480 CSS viewport
  const g = new FrameGeometry({
    image: { width: 800, height: 480 },
    viewport: { width: 800, height: 480 },
    zoomFactor: 1.5,
    webviewRect: { x: 0, y: 40, width: 1200, height: 720 },
  });
  const vp = g.modelToViewport(400, 240);
  near(vp.x, 400);
  near(vp.y, 240);
  const shell = g.viewportToShell(vp.x, vp.y);
  near(shell.x, 600); // 400 css * 1.5 zoom
  near(shell.y, 40 + 360);
  const back = g.shellToViewport(shell.x, shell.y);
  near(back.x, 400);
  near(back.y, 240);
});

test("screen DIP and physical (Windows 150% scaling)", () => {
  const g = new FrameGeometry({
    image: { width: 1000, height: 600 },
    viewport: { width: 1000, height: 600 },
    webviewRect: { x: 10, y: 50, width: 1000, height: 600 },
    windowContentBounds: { x: 200, y: 100, width: 1200, height: 800 },
    display: { scaleFactor: 1.5 },
  });
  const dip = g.viewportToScreenDip(100, 100);
  assert.deepEqual(dip, { x: 310, y: 250 });
  const phys = g.viewportToScreenPhysical(100, 100);
  assert.deepEqual(phys, { x: 465, y: 375 });
  const custom = g.viewportToScreenPhysical(100, 100, (d) => ({ x: d.x + 1, y: d.y + 2 }));
  assert.deepEqual(custom, { x: 311, y: 252 });
});

test("normalized 0..999 (Gemini-style) converts through the image", () => {
  const g = new FrameGeometry({ image: { width: 1280, height: 800 }, viewport: { width: 1440, height: 900 }, coordinateSpace: "normalized_1000" });
  const p = g.modelToViewport(500, 500);
  near(p.x, 720);
  near(p.y, 450);
  const m = g.viewportToModel(720, 450);
  near(m.x, 500);
  near(m.y, 500);
  // 999 is the last cell, must stay inside the viewport
  const edge = g.modelToViewport(999, 999);
  assert.ok(edge.x <= 1439 && edge.y <= 899);
});

test("out-of-range model points are rejected, tiny overshoot is clamped", () => {
  const g = new FrameGeometry({ image: { width: 1000, height: 600 }, viewport: { width: 1000, height: 600 } });
  assert.throws(() => g.modelToViewport(1500, 10), CoordinateError);
  assert.throws(() => g.modelToViewport(10, -80), CoordinateError);
  const p = g.modelToViewport(1001, 601);
  assert.ok(p.x <= 999 && p.y <= 599);
  assert.throws(() => g.modelToViewport(NaN, 1), CoordinateError);
});

test("iframe-local point offsets into the top viewport", () => {
  const g = new FrameGeometry({ image: { width: 100, height: 100 }, viewport: { width: 100, height: 100 } });
  assert.deepEqual(g.frameToViewport(5, 6, { x: 602, y: 122 }), { x: 607, y: 128 });
});

test("scroll <-> page coordinates", () => {
  const g = new FrameGeometry({ image: { width: 100, height: 100 }, viewport: { width: 100, height: 100 }, scroll: { x: 0, y: 500 } });
  assert.deepEqual(g.viewportToPage(10, 20), { x: 10, y: 520 });
  assert.deepEqual(g.pageToViewport(10, 520), { x: 10, y: 20 });
});

test("zoom region maps corner to corner", () => {
  const g = new FrameGeometry({ image: { width: 500, height: 300 }, viewport: { width: 1000, height: 600 } });
  assert.deepEqual(g.regionModelToViewport([50, 50, 250, 150]), [100, 100, 500, 300]);
});

test("fitImageSize never upscales and preserves aspect ratio", () => {
  assert.deepEqual(fitImageSize(800, 600, { maxLongEdge: 1280 }), { width: 800, height: 600, scale: 1 });
  const s = fitImageSize(3840, 2160, { maxLongEdge: 1280, maxPixels: 10_000_000 });
  assert.equal(s.width, 1280);
  assert.equal(s.height, 720);
  const px = fitImageSize(2000, 2000, { maxLongEdge: 2576, maxPixels: 1_150_000 });
  assert.ok(px.width * px.height <= 1_150_000 + 4000);
});

test("invalid geometry is rejected", () => {
  assert.throws(() => new FrameGeometry({ image: { width: 0, height: 10 }, viewport: { width: 10, height: 10 } }), CoordinateError);
});
