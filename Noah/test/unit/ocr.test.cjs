"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ocr = require("../../perception/ocr.cjs");
const { recognizeText } = ocr;
const { Observer } = require("../../perception/observer.cjs");
const { RefTable } = require("../../perception/ax.cjs");
const { FrameGeometry } = require("../../computer/coordinates.cjs");

// A real screenshot (684x241) of a page with an ordinary DOM text label AND a second label drawn onto a
// <canvas> - the AX tree and any DOM text scan can only ever see the first one. Captured once via this app's
// own perception/screenshot.cjs against a live Electron window (see the session's ocr smoke test), not
// synthesized, so this exercises the real Tesseract recognition path, not a mocked one.
const FIXTURE_PATH = path.join(__dirname, "fixtures", "ocr-sample.png");
const FIXTURE_SIZE = { width: 684, height: 241 };

function loadFixture() {
  return fs.readFileSync(FIXTURE_PATH);
}

test("recognizeText finds both DOM-rendered and canvas-drawn text, with real bounding boxes", async () => {
  const lines = await recognizeText(loadFixture());
  const dom = lines.find((l) => /Regular DOM Text Label/i.test(l.text));
  const canvas = lines.find((l) => /Canvas Drawn Submit Button/i.test(l.text));
  assert.ok(dom, `expected a DOM text line, got: ${JSON.stringify(lines.map((l) => l.text))}`);
  assert.ok(canvas, "expected the canvas-drawn line to be recognized too - this is the whole point of OCR here");
  assert.ok(dom.confidence > 80);
  assert.ok(canvas.confidence > 80);
  assert.ok(dom.rect.width > 0 && dom.rect.height > 0);
  // The canvas line was drawn below the DOM label in the fixture page.
  assert.ok(canvas.rect.y > dom.rect.y);
});

test("recognizeText never throws when there is nothing to read (blank image)", async () => {
  // A real screenshot from perception/screenshot.cjs is always a valid PNG/JPEG - it just might have no text on
  // it (a blank page, a photo). A 1x1 blank PNG is the realistic version of that case; a genuinely malformed
  // buffer instead triggers tesseract.js's underlying image-reader to throw asynchronously from inside its
  // worker thread, after recognizeText's own try/catch has already returned - a third-party quirk unrelated to
  // what this module needs to guarantee.
  const BLANK_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const lines = await recognizeText(Buffer.from(BLANK_PNG_B64, "base64"));
  assert.deepEqual(lines, []);
});

function makeObserverWithFixture() {
  const observer = new Observer({ cdp: { mainFrameId: "F1", on: () => {}, navigationCount: 0 }, refs: new RefTable(), log: () => {} });
  const geometry = new FrameGeometry({ image: FIXTURE_SIZE, viewport: FIXTURE_SIZE });
  observer.last = { screenshot: { base64: loadFixture().toString("base64"), geometry } };
  return observer;
}

test("Observer.locateOcrText finds canvas-only text no DOM scan could, and assigns it a usable ref", async () => {
  const observer = makeObserverWithFixture();
  const hits = await observer.locateOcrText("Canvas Drawn Submit Button");
  assert.equal(hits.length, 1);
  const [el] = hits;
  assert.equal(el.role, "text");
  assert.ok(el.ocrSource);
  assert.ok(el.ref, "locateOcrText must assign a ref so the element is addressable like any other target");
  assert.ok(el.rect.width > 0 && el.rect.height > 0);

  const measured = await observer.measureRef(el.ref);
  assert.equal(measured.ok, true);
  assert.deepEqual(measured.rect, el.rect);
});

test("Observer.locateOcrText returns [] when nothing matches or no screenshot exists yet", async () => {
  const observer = makeObserverWithFixture();
  assert.deepEqual(await observer.locateOcrText("something nowhere on this page"), []);

  const fresh = new Observer({ cdp: { mainFrameId: "F1", on: () => {}, navigationCount: 0 }, refs: new RefTable(), log: () => {} });
  assert.deepEqual(await fresh.locateOcrText("Submit"), []);
});

test("measureRef reports unknown_ref for a ref that was never assigned, same as the AX path", async () => {
  const observer = makeObserverWithFixture();
  const res = await observer.measureRef("e999");
  assert.equal(res.ok, false);
  assert.equal(res.code, "unknown_ref");
});

// tesseract.js keeps its worker (a worker_thread) alive to avoid reloading language data between calls (see
// ocr.cjs) - without an explicit shutdown, that handle keeps this test file's process from exiting on its own.
test.after(() => ocr.shutdown());
