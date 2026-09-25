// Noah/perception/ocr.cjs
//
// Free, local, keyless OCR over a screenshot buffer - Tesseract (via tesseract.js, pure JS/WASM, no native
// binary, no API key, no network call once its language data is cached). This exists for the class of on-screen
// text the AX tree genuinely cannot describe: canvas-drawn UI, text baked into images, and other visual-only
// content perception-policy.cjs already flags via hints.preferVision (see agent/perception-policy.cjs). It is
// NOT a replacement for the AX tree - AX stays the default, cheaper, more precise path (see docs/RESEARCH.md /
// Anthropic's own browser-use tool, which prefers structured element refs and only falls back to
// screenshot+coordinates for exactly this canvas/image/cross-origin category).
//
// Bounding boxes are returned in the SAME pixel space as the screenshot buffer passed in (the delivered image,
// post-resize) - callers map them to viewport CSS px via the frame's own FrameGeometry.imageToViewport(), never
// a coordinate system of the OCR engine's own invention.

"use strict";

// One worker, created lazily and reused for the life of the process - creating a fresh worker per call would
// reload the language model (a real, multi-hundred-ms cost) on every single OCR request.
let workerPromise = null;

// Tesseract downloads its language data on first use and caches it. By default that cache is the process's working directory,
// which in an INSTALLED app (a Mac .app bundle, Program Files) is not writable - so OCR would fail there while working in
// development. Cache in the app's own data folder (Electron), or the OS temp folder when run outside Electron (tests, scripts).
function cacheDir() {
  const fs = require("fs");
  const path = require("path");
  let dir;
  try {
    dir = path.join(require("electron").app.getPath("userData"), "tesseract-cache");
  } catch (_) {
    dir = path.join(require("os").tmpdir(), "noah-tesseract-cache");
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* tesseract will report it */ }
  return dir;
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = require("tesseract.js")
      .createWorker("eng", 1, { cachePath: cacheDir() })
      .catch((err) => {
        workerPromise = null; // let the next call retry instead of caching a permanent failure
        throw err;
      });
  }
  return workerPromise;
}

// Tesseract's own 0-100 confidence. Low-confidence "text" over icons/photos is worse noise than a missed real
// label here, so this is tuned conservative on purpose (mirrors the AX/perceptual-hash modules' own stance in
// this codebase: a false positive costs more than a missed signal).
const MIN_LINE_CONFIDENCE = 45;

/** One Tesseract recognition pass, flattened from blocks/paragraphs down to lines. */
async function recognizeOnce(worker, imageBuffer) {
  // tesseract.js v5+ skips building the block/paragraph/line tree by default (it costs real time to construct),
  // returning only a flat `text` string - `{ blocks: true }` is what actually populates
  // `data.blocks[].paragraphs[].lines[]`, which is where per-line bounding boxes live.
  const { data } = await worker.recognize(imageBuffer, {}, { blocks: true });
  const lines = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) lines.push(line);
    }
  }
  return lines
    .map((l) => ({
      text: (l.text || "").replace(/\s+/g, " ").trim(),
      confidence: l.confidence,
      rect: { x: l.bbox.x0, y: l.bbox.y0, width: l.bbox.x1 - l.bbox.x0, height: l.bbox.y1 - l.bbox.y0 },
    }))
    .filter((l) => l.text && l.confidence >= MIN_LINE_CONFIDENCE && l.rect.width > 0 && l.rect.height > 0);
}

/**
 * OCR one screenshot buffer (PNG/JPEG bytes, e.g. Buffer.from(shot.base64, "base64") from
 * perception/screenshot.cjs's captureFrame). Returns line-level results (word-level is noisier for UI labels,
 * which are usually a short phrase like "Sign in" or "Country" that IS one Tesseract "line"):
 *   [{ text, confidence, rect:{x,y,width,height} }, ...]
 * Never throws - OCR is a best-effort perception signal, not a required one. Any failure (corrupt image,
 * worker crash, out of memory) degrades to "no OCR text found", not a broken observation.
 */
async function recognizeText(imageBuffer) {
  try {
    // A worker's very first recognize() job, dispatched right as createWorker()'s promise resolves, sometimes
    // comes back with zero blocks on a real, readable image (verified empirically: every later call on the
    // SAME worker instance is reliable). One retry on an already-warm worker clears this up; it only costs
    // anything extra on that one first call, and even then only when it would otherwise have been wrong.
    const freshWorker = !workerPromise;
    const worker = await getWorker();
    let lines = await recognizeOnce(worker, imageBuffer);
    if (!lines.length && freshWorker) lines = await recognizeOnce(worker, imageBuffer);
    return lines;
  } catch (err) {
    if (process.env.NOAH_OCR_DEBUG) console.error("[ocr.cjs] recognizeText failed:", err);
    return [];
  }
}

/** Release the worker (its WASM instance + loaded language data). Call on app shutdown; never required mid-run. */
async function shutdown() {
  if (!workerPromise) return;
  const p = workerPromise;
  workerPromise = null;
  try {
    const worker = await p;
    await worker.terminate();
  } catch (_) {
    /* already gone */
  }
}

module.exports = { recognizeText, shutdown, MIN_LINE_CONFIDENCE };
