// Noah/perception/screenshot.cjs
//
// Layer 2 perception (visual). Captures the guest viewport through CDP,
// normalises it to the model's image limits, and records the FrameGeometry of
// exactly that frame so any coordinates the model returns are mapped with the
// geometry it actually saw (never "whatever the window is now").

"use strict";

const { FrameGeometry, fitImageSize } = require("../computer/coordinates.cjs");

function nativeImage() {
  return require("electron").nativeImage;
}

/** 64-bit difference hash as 16 hex chars. Robust to compression noise. */
function dHash(img) {
  const small = img.resize({ width: 9, height: 8, quality: "good" });
  const bmp = small.toBitmap(); // BGRA
  const gray = [];
  for (let i = 0; i < 9 * 8; i++) {
    const o = i * 4;
    gray.push(0.114 * bmp[o] + 0.587 * bmp[o + 1] + 0.299 * bmp[o + 2]);
  }
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += gray[y * 9 + x] > gray[y * 9 + x + 1] ? "1" : "0";
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

const GRAY_W = 96;
const GRAY_H = 54;

/** 96x54 luma map used for pixel-level "did the screen change?" checks (catches thin canvas outlines dHash misses). */
function grayMap(img) {
  const small = img.resize({ width: GRAY_W, height: GRAY_H, quality: "good" });
  const bmp = small.toBitmap(); // BGRA
  const out = new Uint8Array(GRAY_W * GRAY_H);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = (0.114 * bmp[o] + 0.587 * bmp[o + 1] + 0.299 * bmp[o + 2]) | 0;
  }
  return out;
}

/** Number of map cells whose brightness moved by more than `delta` (default 18/255). */
function diffGray(a, b, delta = 18) {
  if (!a || !b || a.length !== b.length) return { changed: a === b ? 0 : a.length || 1, cells: a ? a.length : 0 };
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > delta) changed++;
  return { changed, cells: a.length };
}

function hashDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/**
 * Read the page surface. CDP first (short timeout: a healthy window answers in <100ms); if the compositor
 * is stalled (occluded/minimised window on some platforms) fall back to Electron's own capture path.
 * Returns { data: base64 PNG }.
 */
async function grabSurface(cdp) {
  try {
    return await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, { timeoutMs: 3500 });
  } catch (err) {
    if (err.code === "DIALOG_OPEN" || cdp.wc.isDestroyed()) throw err;
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("capturePage timed out")), 3500));
    const img = await Promise.race([cdp.wc.capturePage(), timeout]);
    return { data: img.toPNG().toString("base64") };
  }
}

/**
 * @param {import('../browser/cdp.cjs').CdpSession} cdp
 * @param {object} opts
 * @param {number} [opts.maxLongEdge=1280]
 * @param {number} [opts.maxPixels=1150000]
 * @param {'jpeg'|'png'} [opts.format='jpeg']
 * @param {number} [opts.quality=75]
 * @param {string} [opts.coordinateSpace='image_px']
 * @param {() => Promise<object>} [opts.shellInfo]  returns { webviewRect, windowContentBounds, display, zoomFactor }
 */
/** True if a luma map is a single flat colour (every cell within `tol` of the first) - a compositor that has not
 * painted its next frame yet returns exactly this (often solid black), indistinguishable at this layer from a
 * genuinely blank page. One bounded retry (below) costs nothing extra for a truly blank page, since the retry
 * comes back flat too and capture just proceeds with it. */
function isFlat(gray, tol = 2) {
  const first = gray[0];
  for (let i = 1; i < gray.length; i++) if (Math.abs(gray[i] - first) > tol) return false;
  return true;
}

async function captureFrame(cdp, opts = {}) {
  const { maxLongEdge = 1280, maxPixels = 1_150_000, format = "jpeg", quality = 75, coordinateSpace = "image_px", shellInfo } = opts;
  const t0 = Date.now();
  const [metrics, shot0, shell] = await Promise.all([
    cdp.layoutMetrics(),
    grabSurface(cdp),
    shellInfo ? shellInfo().catch(() => null) : Promise.resolve(null),
  ]);
  let shot = shot0;
  const ni = nativeImage();
  let img = ni.createFromBuffer(Buffer.from(shot.data, "base64"));
  let native = img.getSize();
  if (!native.width || !native.height) throw new Error("screenshot decoded to an empty image");

  if (isFlat(grayMap(img))) {
    await new Promise((r) => setTimeout(r, 120));
    shot = await grabSurface(cdp);
    img = ni.createFromBuffer(Buffer.from(shot.data, "base64"));
    native = img.getSize();
    if (!native.width || !native.height) throw new Error("screenshot decoded to an empty image");
  }

  const target = fitImageSize(native.width, native.height, { maxLongEdge, maxPixels });
  if (target.scale < 1) img = img.resize({ width: target.width, height: target.height, quality: "best" });
  const size = img.getSize();
  const buf = format === "png" ? img.toPNG() : img.toJPEG(quality);

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

  return {
    base64: buf.toString("base64"),
    mime: format === "png" ? "image/png" : "image/jpeg",
    width: size.width,
    height: size.height,
    nativeWidth: native.width,
    nativeHeight: native.height,
    bytes: buf.length,
    hash: dHash(img),
    gray: grayMap(img),
    geometry,
    metrics,
    capturedAt: Date.now(),
    captureMs: Date.now() - t0,
  };
}

/**
 * Capture a viewport region at full resolution (the `zoom`/region screenshot).
 * `region` is in CSS viewport px. The result is scaled to fit the model limits
 * (upscaled if small) with aspect ratio preserved; coordinates the model emits
 * afterwards still refer to the FULL frame, not to this crop.
 */
async function captureRegion(cdp, region, { maxLongEdge = 1280, format = "png" } = {}) {
  const [x0, y0, x1, y1] = region;
  const width = Math.max(4, x1 - x0);
  const height = Math.max(4, y1 - y0);
  const shot = await cdp.send(
    "Page.captureScreenshot",
    { format: "png", fromSurface: true, clip: { x: x0, y: y0, width, height, scale: 1 } },
    { timeoutMs: 8000 }
  );
  let img = nativeImage().createFromBuffer(Buffer.from(shot.data, "base64"));
  const native = img.getSize();
  const scale = Math.min(maxLongEdge / Math.max(native.width, native.height), 4);
  if (scale !== 1) img = img.resize({ width: Math.max(1, Math.round(native.width * scale)), height: Math.max(1, Math.round(native.height * scale)), quality: "best" });
  const size = img.getSize();
  const buf = format === "png" ? img.toPNG() : img.toJPEG(90);
  return { base64: buf.toString("base64"), mime: format === "png" ? "image/png" : "image/jpeg", width: size.width, height: size.height, bytes: buf.length, region };
}

module.exports = { captureFrame, captureRegion, dHash, hashDistance, grayMap, diffGray };
