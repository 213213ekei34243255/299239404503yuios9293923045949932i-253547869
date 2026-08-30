// Rexy/vision.js
//
// Vision answers exactly one question: "What is currently visible in the
// browser?" It never decides what to do about it — that's planner.js's
// job. Vision only observes and describes.
//
//   Runtime -> Observer -> Vision -> Renderer -> WebView
//
// Today this is DOM-extraction-based (fast, cheap, accurate for normal
// pages). capture() also grabs a real screenshot so a later pass can add
// OCR or an image model without changing this file's public API — analyze()
// already accepts a capture and returns a description; swapping *how* that
// description is produced is an internal change.

"use strict";

const { EventEmitter } = require("events");
const Logger = require("./logger.cjs");

function queryListScript(selector, mapExpr, limit) {
  return `(() => Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
    .slice(0, ${limit})
    .map((el) => (${mapExpr})))();`;
}

function selectorExpr() {
  // Shared inline expression for computing a reasonably stable selector,
  // used inside each detect*() query script.
  return `(el.id ? "#"+CSS.escape(el.id) : el.getAttribute("name") ? el.tagName.toLowerCase()+"[name='"+el.getAttribute("name").replace(/'/g,"\\\\'")+"']" : el.tagName.toLowerCase())`;
}

class Vision extends EventEmitter {
  /**
   * @param {import('electron').BrowserWindow} mainWindow
   * @param {object} [options]
   * @param {number} [options.captureInterval] ms between automatic
   *        captures if startLoop() is used; 0/undefined disables the loop.
   */
  constructor(mainWindow, options = {}) {
    super();
    this.mainWindow = mainWindow;
    this.lastScreenshot = null;
    this.lastObservation = null;
    this.enabled = false;
    this.captureInterval = options.captureInterval || 0;

    this.log = new Logger({ scope: "vision", level: options.logLevel || "info" });
    this._loopHandle = null;
  }

  // ===================================================================
  // Lifecycle
  // ===================================================================

  initialize() {
    this.enabled = true;
    if (this.captureInterval > 0) {
      this._startLoop();
    }
    this.log.info("Vision initialized");
    this.emit("ready");
  }

  shutdown() {
    this.enabled = false;
    this._stopLoop();
    this.emit("shutdown");
  }

  _startLoop() {
    this._stopLoop();
    this._loopHandle = setInterval(() => {
      this.getObservation().catch((err) => this.log.warn("Auto-capture failed:", err.message));
    }, this.captureInterval);
  }

  _stopLoop() {
    if (this._loopHandle) {
      clearInterval(this._loopHandle);
      this._loopHandle = null;
    }
  }

  _wc() {
    const wc = this.mainWindow?.webContents;
    if (!wc || wc.isDestroyed()) throw new Error("Vision: no active webContents");
    return wc;
  }

  // ===================================================================
  // capture() — raw screenshot, no interpretation
  // ===================================================================

  async capture() {
    const wc = this._wc();
    const image = await wc.capturePage();
    const { width, height } = image.getSize();
    const result = {
      timestamp: Date.now(),
      image: image.toDataURL(),
      width,
      height,
    };
    this.lastScreenshot = result;
    this.emit("captured", { timestamp: result.timestamp, width, height });
    return result;
  }

  // ===================================================================
  // analyze() — turns a capture into a structured description.
  //
  // Today this ignores capture.image and reads the live DOM instead,
  // since that's cheaper and more accurate than image analysis for
  // ordinary pages. capture is still the input contract so a future
  // OCR/vision-model pass can be swapped in without callers changing.
  // ===================================================================

  async analyze(capture) {
    const wc = this._wc();

    const [title, url, visibleText, buttons, inputs, links, images, forms] = await Promise.all([
      Promise.resolve(wc.getTitle()),
      Promise.resolve(wc.getURL()),
      this._getVisibleText(),
      this.detectButtons(),
      this.detectInputs(),
      this.detectLinks(),
      this.detectImages(),
      this.detectForms(),
    ]);

    return {
      title,
      url,
      visibleText,
      buttons,
      inputs,
      links,
      images,
      forms,
      capturedAt: capture?.timestamp ?? Date.now(),
    };
  }

  async _getVisibleText() {
    try {
      return await this._wc().executeJavaScript(
        `(document.body ? document.body.innerText : "").slice(0, 20000)`,
        true
      );
    } catch (err) {
      this.log.warn("Failed reading visible text:", err.message);
      return "";
    }
  }

  // ===================================================================
  // Individual detectors — each a small, independent DOM query so
  // callers that only need one thing don't pay for the rest.
  // ===================================================================

  async detectButtons() {
    return this._safeQuery(
      queryListScript(
        "button, [role='button'], input[type='submit'], input[type='button']",
        `{ text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0,200),
           selector: ${selectorExpr()},
           enabled: !el.disabled }`,
        200
      ),
      []
    );
  }

  async detectInputs() {
    return this._safeQuery(
      queryListScript(
        "input, textarea, select",
        `{ placeholder: el.getAttribute("placeholder") || "",
           selector: ${selectorExpr()},
           type: el.type || el.tagName.toLowerCase() }`,
        200
      ),
      []
    );
  }

  async detectLinks() {
    return this._safeQuery(
      queryListScript(
        "a[href]",
        `{ text: (el.innerText || "").trim().slice(0,200), href: el.href }`,
        300
      ),
      []
    );
  }

  async detectImages() {
    return this._safeQuery(
      queryListScript(
        "img",
        `{ alt: el.alt || "", src: el.src, width: el.naturalWidth || el.width || 0, height: el.naturalHeight || el.height || 0 }`,
        100
      ),
      []
    );
  }

  async detectForms() {
    return this._safeQuery(
      queryListScript("form", `{ action: el.action || "", method: (el.method || "get").toUpperCase() }`, 50),
      []
    );
  }

  async _safeQuery(script, fallback) {
    try {
      return await this._wc().executeJavaScript(script, true);
    } catch (err) {
      this.log.warn("Vision query failed:", err.message);
      return fallback;
    }
  }

  // ===================================================================
  // getObservation() — the single method observer.js should call.
  // ===================================================================

  async getObservation() {
    const capture = await this.capture().catch((err) => {
      this.log.warn("Screenshot capture failed, continuing with DOM-only observation:", err.message);
      return null;
    });

    const described = await this.analyze(capture);

    const observation = {
      ...described,
      timestamp: Date.now(),
    };

    this.lastObservation = observation;
    this.emit("observed", observation);
    return observation;
  }
}

module.exports = Vision;