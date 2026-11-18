// Noah/perception/screenshot.cjs - Jonah on Chromium version (replaces the Electron file in the bundle).
//
// Same job and same results as the Electron file: capture the tab through CDP, fit it to the model's image limits, and record
// the FrameGeometry of exactly that frame. Electron decoded/resized images synchronously with nativeImage; a page cannot, so the
// image work here is done asynchronously with createImageBitmap + OffscreenCanvas. dHash / grayMap / diffGray / hashDistance
// give the same values (the bitmap is RGBA here instead of BGRA; the weights are applied to the right channels).

"use strict";

const { FrameGeometry, fitImageSize } = require("../computer/coordinates.cjs");

async function decode(base64, mime = "image/png") {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: mime }));
}
function draw(bitmap, width, height) {
  const c = new OffscreenCanvas(width, height);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, 0, 0, width, height);
  return { canvas: c, g };
}
async function encode(canvas, format, quality) {
  const blob = await canvas.convertToBlob(format === "png" ? { type: "image/png" } : { type: "image/jpeg", quality: quality / 100 });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { base64: btoa(s), bytes: buf.length };
}
const luma = (d, o) => 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]; // RGBA

/** 64-bit difference hash as 16 hex chars. `img` is an ImageBitmap. */
function dHash(img) {
  const { g } = draw(img, 9, 8);
  const d = g.getImageData(0, 0, 9, 8).data;
  const gray = []; for (let i = 0; i < 72; i++) gray.push(luma(d, i * 4));
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += gray[y * 9 + x] > gray[y * 9 + x + 1] ? "1" : "0";
  let hex = ""; for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
const GRAY_W = 96;
const GRAY_H = 54;
function grayMap(img) {
  const { g } = draw(img, GRAY_W, GRAY_H);
  const d = g.getImageData(0, 0, GRAY_W, GRAY_H).data;
  const out = new Uint8Array(GRAY_W * GRAY_H);
  for (let i = 0; i < out.length; i++) out[i] = luma(d, i * 4) | 0;
  return out;
}
function diffGray(a, b, delta = 18) {
  if (!a || !b || a.length !== b.length) return { changed: a === b ? 0 : a.length || 1, cells: a ? a.length : 0 };
  let changed = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > delta) changed++;
  return { changed, cells: a.length };
}
function hashDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } }
  return d;
}
// Noah's overlay (purple cursor, status pill, STOP) is drawn inside the page here, unlike Electron where it was a layer over the
// <webview> that screenshots never contained. It is hidden for the instant of each capture so the model sees only the page.
const HIDE_LAYER = "(() => { const h = document.querySelector('jonah-noah-layer'); if (!h) return 0; h.style.setProperty('visibility', 'hidden', 'important'); return 1; })()";
const SHOW_LAYER = "(() => { const h = document.querySelector('jonah-noah-layer'); if (h) h.style.removeProperty('visibility'); return 1; })()";
async function withoutOverlay(cdp, fn) {
  const hidden = await cdp.send("Runtime.evaluate", { expression: HIDE_LAYER, returnByValue: true }, { timeoutMs: 1500 }).then((r) => r && r.result && r.result.value === 1).catch(() => false);
  try { return await fn(); }
  finally { if (hidden) cdp.send("Runtime.evaluate", { expression: SHOW_LAYER, returnByValue: true }, { timeoutMs: 1500 }).catch(() => {}); }
}
async function grabSurface(cdp) {
  return withoutOverlay(cdp, () => cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, { timeoutMs: 5000 }));
}
function isFlat(gray, tol = 2) {
  const first = gray[0];
  for (let i = 1; i < gray.length; i++) if (Math.abs(gray[i] - first) > tol) return false;
  return true;
}

async function captureFrame(cdp, opts = {}) {
  const { maxLongEdge = 1280, maxPixels = 1_150_000, format = "jpeg", quality = 75, coordinateSpace = "image_px", shellInfo } = opts;
  const t0 = Date.now();
  const [metrics, shot0, shell] = await Promise.all([cdp.layoutMetrics(), grabSurface(cdp), shellInfo ? shellInfo().catch(() => null) : Promise.resolve(null)]);
  let img = await decode(shot0.data);
  if (!img.width || !img.height) throw new Error("screenshot decoded to an empty image");
  if (isFlat(grayMap(img))) {
    await new Promise((r) => setTimeout(r, 120));
    img = await decode((await grabSurface(cdp)).data);
  }
  const native = { width: img.width, height: img.height };
  const target = fitImageSize(native.width, native.height, { maxLongEdge, maxPixels });
  const size = target.scale < 1 ? { width: target.width, height: target.height } : native;
  const { canvas } = draw(img, size.width, size.height);
  const enc = await encode(canvas, format, quality);
  const geometry = new FrameGeometry({
    image: size,
    viewport: { width: metrics.width, height: metrics.height },
    zoomFactor: shell?.zoomFactor || 1,
    devicePixelRatio: native.width / Math.max(1, metrics.width),
    scroll: { x: metrics.scrollX, y: metrics.scrollY },
    webviewRect: shell?.webviewRect || null,
    windowContentBounds: shell?.windowContentBounds || null,
    display: shell?.display || null,
    coordinateSpace,
  });
  const result = {
    base64: enc.base64, mime: format === "png" ? "image/png" : "image/jpeg",
    width: size.width, height: size.height, nativeWidth: native.width, nativeHeight: native.height, bytes: enc.bytes,
    hash: dHash(img), gray: grayMap(img), geometry, metrics, capturedAt: Date.now(), captureMs: Date.now() - t0,
  };
  img.close();
  return result;
}

async function captureRegion(cdp, region, { maxLongEdge = 1280, format = "png" } = {}) {
  const [x0, y0, x1, y1] = region;
  const width = Math.max(4, x1 - x0), height = Math.max(4, y1 - y0);
  const shot = await withoutOverlay(cdp, () => cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, clip: { x: x0, y: y0, width, height, scale: 1 } }, { timeoutMs: 8000 }));
  const img = await decode(shot.data);
  const scale = Math.min(maxLongEdge / Math.max(img.width, img.height), 4);
  const size = { width: Math.max(1, Math.round(img.width * scale)), height: Math.max(1, Math.round(img.height * scale)) };
  const { canvas } = draw(img, size.width, size.height);
  const enc = await encode(canvas, format, 90);
  img.close();
  return { base64: enc.base64, mime: format === "png" ? "image/png" : "image/jpeg", width: size.width, height: size.height, bytes: enc.bytes, region };
}

module.exports = { captureFrame, captureRegion, dHash, hashDistance, grayMap, diffGray };
