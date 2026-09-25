// Noah/computer/coordinates.cjs
//
// The dedicated coordinate transformation system (spec §38.5). Nothing in
// Noah ever assumes "screenshot X == screen X". Every point lives in one of
// these explicit spaces and is converted through this class:
//
//   model space      what the model emitted:
//                      image_px        pixels of the screenshot it was shown
//                      normalized_1000 0..999 grid over that screenshot (Gemini style)
//                      normalized_1    0..1 fractions
//        │  (scale by image size)
//        ▼
//   image space      pixels of the screenshot as delivered to the model
//        │  (× viewport.width / image.width)
//        ▼
//   viewport space   CSS px in the top frame's layout viewport. THIS is what
//                    CDP Input.dispatchMouseEvent expects. Independent of
//                    devicePixelRatio, zoom and window scaling by construction.
//        │  (× zoomFactor, + <webview> rect)
//        ▼
//   shell space      CSS px in Jonah's shell window (where the purple cursor
//                    overlay lives)
//        │  (+ window content bounds)
//        ▼
//   screen DIP       Electron's device-independent screen coordinates
//        │  (× display scale factor)
//        ▼
//   screen physical  physical monitor pixels (HiDPI / Windows scaling / Retina)
//
// The image→viewport ratio is derived from the *actual* image size and the
// *measured* CSS viewport size for that exact screenshot, so it stays correct
// under HiDPI, browser zoom, non-uniform resizing and window resizes between
// observations. A FrameGeometry is immutable and captured *with* each
// screenshot, so an action is always mapped with the geometry of the frame the
// model actually saw.

"use strict";

const SPACES = Object.freeze(["image_px", "normalized_1000", "normalized_1"]);

class CoordinateError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "CoordinateError";
    this.code = "COORDINATE_OUT_OF_RANGE";
    this.details = details;
  }
}

function num(v, name) {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new CoordinateError(`${name} must be a finite number, got ${v}`);
  return v;
}

class FrameGeometry {
  /**
   * @param {object} o
   * @param {{width:number,height:number}} o.image        size of the image the model saw
   * @param {{width:number,height:number}} o.viewport     CSS-px layout viewport of the top frame
   * @param {number} [o.zoomFactor=1]                     Electron page zoom
   * @param {number} [o.devicePixelRatio=1]               window.devicePixelRatio (informational; includes zoom)
   * @param {{x:number,y:number}} [o.scroll]              scroll offset at capture time (CSS px)
   * @param {{x:number,y:number,width:number,height:number}|null} [o.webviewRect] <webview> rect in shell CSS px
   * @param {{x:number,y:number,width:number,height:number}|null} [o.windowContentBounds] shell content area, screen DIP
   * @param {{scaleFactor:number}|null} [o.display]
   * @param {string} [o.coordinateSpace='image_px']
   */
  constructor(o) {
    const image = o.image || {};
    const viewport = o.viewport || {};
    if (!(image.width > 0 && image.height > 0)) throw new CoordinateError("FrameGeometry: image size must be positive");
    if (!(viewport.width > 0 && viewport.height > 0)) throw new CoordinateError("FrameGeometry: viewport size must be positive");
    this.image = Object.freeze({ width: image.width, height: image.height });
    this.viewport = Object.freeze({ width: viewport.width, height: viewport.height });
    this.zoomFactor = o.zoomFactor > 0 ? o.zoomFactor : 1;
    this.devicePixelRatio = o.devicePixelRatio > 0 ? o.devicePixelRatio : 1;
    this.scroll = Object.freeze({ x: o.scroll?.x || 0, y: o.scroll?.y || 0 });
    this.webviewRect = o.webviewRect ? Object.freeze({ ...o.webviewRect }) : null;
    this.windowContentBounds = o.windowContentBounds ? Object.freeze({ ...o.windowContentBounds }) : null;
    this.displayScale = o.display?.scaleFactor > 0 ? o.display.scaleFactor : 1;
    this.coordinateSpace = SPACES.includes(o.coordinateSpace) ? o.coordinateSpace : "image_px";
    Object.freeze(this);
  }

  // ---- model <-> image -------------------------------------------------

  modelToImage(x, y, space = this.coordinateSpace) {
    num(x, "x");
    num(y, "y");
    switch (space) {
      case "image_px":
        return { x, y };
      case "normalized_1000":
        return { x: (x / 1000) * this.image.width, y: (y / 1000) * this.image.height };
      case "normalized_1":
        return { x: x * this.image.width, y: y * this.image.height };
      default:
        throw new CoordinateError(`unknown coordinate space "${space}"`);
    }
  }

  imageToModel(x, y, space = this.coordinateSpace) {
    switch (space) {
      case "image_px":
        return { x, y };
      case "normalized_1000":
        return { x: (x / this.image.width) * 1000, y: (y / this.image.height) * 1000 };
      case "normalized_1":
        return { x: x / this.image.width, y: y / this.image.height };
      default:
        throw new CoordinateError(`unknown coordinate space "${space}"`);
    }
  }

  // ---- image <-> viewport ------------------------------------------------

  imageToViewport(x, y) {
    return { x: (x * this.viewport.width) / this.image.width, y: (y * this.viewport.height) / this.image.height };
  }

  viewportToImage(x, y) {
    return { x: (x * this.image.width) / this.viewport.width, y: (y * this.image.height) / this.viewport.height };
  }

  /** model → CSS viewport in one step (with validation). */
  modelToViewport(x, y, space = this.coordinateSpace, { tolerance = 2 } = {}) {
    const img = this.modelToImage(x, y, space);
    if (
      img.x < -tolerance || img.y < -tolerance ||
      img.x > this.image.width + tolerance || img.y > this.image.height + tolerance
    ) {
      throw new CoordinateError(
        `point (${x}, ${y}) is outside the ${this.image.width}x${this.image.height} screenshot`,
        { x, y, space, image: this.image }
      );
    }
    const vp = this.imageToViewport(img.x, img.y);
    return this.clamp(vp.x, vp.y);
  }

  viewportToModel(x, y, space = this.coordinateSpace) {
    const img = this.viewportToImage(x, y);
    return this.imageToModel(img.x, img.y, space);
  }

  regionModelToViewport(region, space = this.coordinateSpace) {
    if (!Array.isArray(region) || region.length !== 4) throw new CoordinateError("region must be [x0,y0,x1,y1]");
    const a = this.modelToViewport(region[0], region[1], space);
    const b = this.modelToViewport(region[2], region[3], space);
    return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
  }

  // ---- viewport helpers ---------------------------------------------------

  contains(x, y) {
    return x >= 0 && y >= 0 && x <= this.viewport.width && y <= this.viewport.height;
  }

  clamp(x, y) {
    return {
      x: Math.min(Math.max(x, 0), this.viewport.width - 1),
      y: Math.min(Math.max(y, 0), this.viewport.height - 1),
    };
  }

  /** Page (document) coordinates → viewport, using the scroll offset at capture time. */
  pageToViewport(x, y) {
    return { x: x - this.scroll.x, y: y - this.scroll.y };
  }

  viewportToPage(x, y) {
    return { x: x + this.scroll.x, y: y + this.scroll.y };
  }

  /** Point local to an iframe (its own viewport) → top-frame viewport. */
  frameToViewport(x, y, frameOffset) {
    return { x: x + (frameOffset?.x || 0), y: y + (frameOffset?.y || 0) };
  }

  // ---- viewport -> shell -> screen -----------------------------------------

  /** CSS viewport point → shell window CSS px (for the cursor overlay). */
  viewportToShell(x, y) {
    const r = this.webviewRect || { x: 0, y: 0 };
    return { x: r.x + x * this.zoomFactor, y: r.y + y * this.zoomFactor };
  }

  shellToViewport(x, y) {
    const r = this.webviewRect || { x: 0, y: 0 };
    return { x: (x - r.x) / this.zoomFactor, y: (y - r.y) / this.zoomFactor };
  }

  /** viewport → Electron screen DIP (compare with screen.getCursorScreenPoint()). */
  viewportToScreenDip(x, y) {
    const s = this.viewportToShell(x, y);
    const w = this.windowContentBounds || { x: 0, y: 0 };
    return { x: w.x + s.x, y: w.y + s.y };
  }

  /**
   * viewport → physical monitor pixels. Pass Electron's `screen.dipToScreenPoint`
   * for exact multi-monitor behaviour; otherwise a uniform scale is applied.
   */
  viewportToScreenPhysical(x, y, dipToScreenPoint) {
    const d = this.viewportToScreenDip(x, y);
    if (typeof dipToScreenPoint === "function") return dipToScreenPoint(d);
    return { x: d.x * this.displayScale, y: d.y * this.displayScale };
  }

  /** Scale factor used to draw a viewport-sized thing in shell space. */
  get shellScale() {
    return this.zoomFactor;
  }

  toJSON() {
    return {
      image: this.image,
      viewport: this.viewport,
      zoomFactor: this.zoomFactor,
      devicePixelRatio: this.devicePixelRatio,
      scroll: this.scroll,
      webviewRect: this.webviewRect,
      windowContentBounds: this.windowContentBounds,
      displayScale: this.displayScale,
      coordinateSpace: this.coordinateSpace,
    };
  }
}

/**
 * Choose the size a screenshot should be delivered to the model at, honouring
 * the provider's long-edge and total-pixel limits and never upscaling.
 * Aspect ratio is always preserved.
 */
function fitImageSize(width, height, { maxLongEdge = 1280, maxPixels = 1_150_000 } = {}) {
  const longEdgeScale = maxLongEdge / Math.max(width, height);
  const pixelScale = Math.sqrt(maxPixels / (width * height));
  const scale = Math.min(1, longEdgeScale, pixelScale);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

module.exports = { FrameGeometry, CoordinateError, fitImageSize, SPACES };
