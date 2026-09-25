// Noah/computer/controller.cjs
//
// The ComputerController: the `computer.*` API the rest of Noah (and, through
// the executor, the model) uses to operate the browser like a person:
//
//   computer.move(x, y)            computer.keyPress(key)
//   computer.click(x, y)           computer.keyDown(key) / keyUp(key)
//   computer.doubleClick(x, y)     computer.type(text)
//   computer.rightClick(x, y)      computer.hotkey('ctrl','a')
//   computer.mouseDown/mouseUp     computer.scroll(x, y, dx, dy)
//   computer.drag(x1,y1,x2,y2)     computer.hover(x, y)
//
// Coordinates are MODEL-space (screenshot pixels by default) and are mapped
// through the FrameGeometry of the frame the model saw. Callers that already
// hold CSS viewport coordinates (DOM/AX-derived targets) pass {space:'viewport'}.
//
// Every call publishes its action event on the EventBus BEFORE dispatching
// input, so the purple cursor and audit log consume the identical
// event the driver acts on (spec §38.15). The animation never gates the action
// unless the user opted into cursor.mode = "lead".

"use strict";

const { CoordinateError } = require("./coordinates.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Time the overlay cursor takes to travel `distance` px (spec §38.4). Kept in main so 'lead' mode and the overlay agree. */
function travelMs(distance) {
  if (distance < 24) return 0;
  return Math.round(Math.min(350, 70 + distance * 0.32));
}

class ComputerController {
  /**
   * @param {object} deps
   * @param {() => import('./input.cjs').InputDriver} deps.getDriver
   * @param {() => (import('./coordinates.cjs').FrameGeometry|null)} deps.getGeometry  geometry of the frame the model last saw
   * @param {() => object} [deps.getViewport]   live viewport {width,height} (fallback when no screenshot yet)
   * @param {import('../events.cjs').EventBus} deps.bus
   * @param {() => object} [deps.getConfig]
   * @param {(opts?: object) => Promise<object>} [deps.capture]  screenshot provider
   */
  constructor({ getDriver, getGeometry, getViewport, getZoom, bus, getConfig, capture }) {
    this.getDriver = getDriver;
    this.getGeometry = getGeometry;
    // Page zoom for placing the overlay cursor. Read from the live guest, NOT from the last screenshot:
    // ref/DOM-driven actions happen without any screenshot, and zoom can change between frames.
    this.getZoom = getZoom || (() => getGeometry()?.zoomFactor || 1);
    this.getViewport = getViewport || (() => null);
    this.bus = bus;
    this.getConfig = getConfig || (() => ({}));
    this._capture = capture;
    this.lastPoint = null; // viewport CSS px
  }

  get driver() {
    return this.getDriver();
  }

  get coordinates() {
    return this.getGeometry();
  }

  async screenshot(opts) {
    if (!this._capture) throw new Error("no screenshot provider configured");
    return this._capture(opts);
  }

  // ------------------------------------------------------------ mapping

  /** Map a point to viewport CSS px. */
  toViewport(x, y, { space = "model" } = {}) {
    if (space === "viewport") return { x, y };
    const g = this.getGeometry();
    if (!g) {
      throw new CoordinateError("No screenshot has been taken yet, so screenshot coordinates have no meaning. Take a screenshot first (action: screenshot) or use a ref/text target.");
    }
    return g.modelToViewport(x, y);
  }

  _cursorMode() {
    return this.getConfig().cursor?.mode || "decoupled";
  }

  async _lead(distance) {
    if (this._cursorMode() !== "lead") return;
    const ms = Math.min(180, travelMs(distance));
    if (ms > 0) await sleep(ms);
  }

  _emitMouse(action, vp, o, extra = {}) {
    const g = this.getGeometry();
    const from = this.lastPoint;
    this.bus.publish("mouse_action", {
      action,
      x: vp.x,
      y: vp.y,
      from: from ? { x: from.x, y: from.y } : null,
      modelX: o.space === "viewport" ? undefined : o.modelX,
      modelY: o.space === "viewport" ? undefined : o.modelY,
      source: o.source || (o.space === "viewport" ? "dom" : "vision"),
      target: o.target || { type: o.space === "viewport" ? "viewport" : "visual" },
      zoomFactor: this.getZoom(),
      travelMs: from ? travelMs(Math.hypot(vp.x - from.x, vp.y - from.y)) : 0,
      ...extra,
    });
  }

  async _prep(action, x, y, o = {}) {
    const vp = this.toViewport(x, y, o);
    const dist = this.lastPoint ? Math.hypot(vp.x - this.lastPoint.x, vp.y - this.lastPoint.y) : 0;
    this._emitMouse(action, vp, { ...o, modelX: x, modelY: y });
    await this._lead(dist);
    return vp;
  }

  // -------------------------------------------------------------- mouse

  async move(x, y, o = {}) {
    const vp = await this._prep("move", x, y, o);
    await this.driver.mouseMove(vp.x, vp.y);
    this.lastPoint = vp;
    return vp;
  }

  async hover(x, y, o = {}) {
    const vp = await this._prep("hover", x, y, o);
    await this.driver.mouseMove(vp.x, vp.y);
    this.lastPoint = vp;
    return vp;
  }

  async click(x, y, o = {}) {
    const vp = await this._prep("click", x, y, o);
    await this.driver.click(vp.x, vp.y, { button: "left", clickCount: 1, modifiers: o.modifiers });
    this.lastPoint = vp;
    return vp;
  }

  async doubleClick(x, y, o = {}) {
    const vp = await this._prep("double_click", x, y, o);
    await this.driver.click(vp.x, vp.y, { button: "left", clickCount: 2, modifiers: o.modifiers });
    this.lastPoint = vp;
    return vp;
  }

  async rightClick(x, y, o = {}) {
    const vp = await this._prep("right_click", x, y, o);
    await this.driver.click(vp.x, vp.y, { button: "right", clickCount: 1, modifiers: o.modifiers });
    this.lastPoint = vp;
    return vp;
  }

  async mouseDown(x, y, o = {}) {
    const hasPoint = x !== undefined && y !== undefined;
    const vp = hasPoint ? await this._prep("mouse_down", x, y, o) : this.lastPoint || { x: 0, y: 0 };
    if (!hasPoint) this._emitMouse("mouse_down", vp, o);
    await this.driver.mouseDown(vp.x, vp.y, { button: o.button || "left" });
    this.lastPoint = vp;
    return vp;
  }

  async mouseUp(x, y, o = {}) {
    const hasPoint = x !== undefined && y !== undefined;
    const vp = hasPoint ? await this._prep("mouse_up", x, y, o) : this.lastPoint || { x: 0, y: 0 };
    if (!hasPoint) this._emitMouse("mouse_up", vp, o);
    await this.driver.mouseUp(vp.x, vp.y, { button: o.button || "left" });
    this.lastPoint = vp;
    return vp;
  }

  /**
   * Drag from (x1,y1) to (x2,y2). The overlay receives the start/end and every
   * intermediate point as `drag_move` events so the purple cursor stays attached
   * to the real drag path (throttled to ~60 Hz).
   */
  async drag(x1, y1, x2, y2, o = {}) {
    const a = this.toViewport(x1, y1, o);
    const b = this.toViewport(x2, y2, o);
    this._emitMouse("drag_start", a, { ...o, modelX: x1, modelY: y1 }, { to: { x: b.x, y: b.y } });
    await this._lead(this.lastPoint ? Math.hypot(a.x - this.lastPoint.x, a.y - this.lastPoint.y) : 0);

    // Observe the driver's real pointer updates for the overlay.
    const drv = this.driver;
    const origMove = drv.mouseMove.bind(drv);
    let lastEmit = 0;
    drv.mouseMove = async (x, y) => {
      const now = Date.now();
      if (now - lastEmit >= 16) {
        lastEmit = now;
        this.bus.publish("mouse_action", { action: "drag_move", x, y, source: o.source || "vision", target: o.target || { type: "visual" }, zoomFactor: this.getZoom() });
      }
      return origMove(x, y);
    };
    try {
      await drv.drag(a, b, { steps: o.steps, holdMs: o.holdMs });
    } finally {
      drv.mouseMove = origMove;
    }
    this.lastPoint = b;
    this._emitMouse("drag_end", b, { ...o, modelX: x2, modelY: y2 });
    return { from: a, to: b };
  }

  /** Wheel scroll at a point (defaults to the viewport centre). Deltas in CSS px; +y scrolls down. */
  async scroll(x, y, deltaX = 0, deltaY = 0, o = {}) {
    let vp;
    if (x === undefined || y === undefined || x === null || y === null) {
      const v = this.getGeometry()?.viewport || this.getViewport() || { width: 800, height: 600 };
      vp = { x: Math.round(v.width / 2), y: Math.round(v.height / 2) };
    } else {
      vp = this.toViewport(x, y, o);
    }
    this.bus.publish("scroll_action", { action: "scroll", x: vp.x, y: vp.y, deltaX, deltaY, source: o.source || "coordinate", zoomFactor: this.getZoom() });
    // with the cursor on, scroll in small visible notches (~28 ms apart) instead of one jump
    const human = ((this.getConfig() || {}).cursor || {}).mode !== "off";
    await this.driver.wheel(vp.x, vp.y, deltaX, deltaY, human ? { chunk: 80, delayMs: 28, maxMs: 1500 } : {});
    this.lastPoint = vp;
    return vp;
  }

  // ----------------------------------------------------------- keyboard

  async _kb(action, fn, extra = {}) {
    const t0 = Date.now();
    this.bus.publish("keyboard_action", { action, phase: "start", ...extra });
    try {
      const res = await fn();
      this.bus.publish("keyboard_action", { action, phase: "end", durationMs: Date.now() - t0, ...extra });
      return res;
    } catch (err) {
      this.bus.publish("keyboard_action", { action, phase: "error", durationMs: Date.now() - t0, error: err.message, ...extra });
      throw err;
    }
  }

  keyPress(key, o = {}) {
    return this._kb("key_press", () => this.driver.keyPress(key, { repeat: o.repeat || 1 }), { key, focusRect: o.focusRect });
  }

  keyDown(key, o = {}) {
    return this._kb("key_down", () => this.driver.keyDown(key), { key, focusRect: o.focusRect });
  }

  keyUp(key, o = {}) {
    return this._kb("key_up", () => this.driver.keyUp(key), { key, focusRect: o.focusRect });
  }

  /**
   * Pause between real key events. Zero made a query appear all at once, so the user could not watch Noah type. With the
   * cursor on it is ~40 ms per key (config cursor.typingDelayMs), shrunk for long text so a whole entry costs at most
   * ~1.5 s; 0 when the cursor is switched off.
   */
  _typingDelay(nChars) {
    const c = (this.getConfig() || {}).cursor || {};
    if (c.mode === "off") return 0;
    const per = Number.isFinite(c.typingDelayMs) ? c.typingDelayMs : 40;
    return Math.max(0, Math.min(per, Math.floor(3500 / Math.max(1, nChars)))); // a whole story stays under ~3.5 s of pauses
  }

  type(text, o = {}) {
    // `chars` is the real count; the overlay shows activity only for durationMs actually spent.
    const n = [...String(text)].length;
    const delayMs = o.delayMs !== undefined ? o.delayMs : this._typingDelay(n);
    return this._kb("type", () => this.driver.type(text, { mode: o.mode || "auto", delayMs }), { chars: n, focusRect: o.focusRect });
  }

  hotkey(...keys) {
    const combo = keys.length === 1 ? keys[0] : keys.join("+");
    return this._kb("hotkey", () => this.driver.hotkey(combo), { key: combo });
  }
}

module.exports = { ComputerController, travelMs };
