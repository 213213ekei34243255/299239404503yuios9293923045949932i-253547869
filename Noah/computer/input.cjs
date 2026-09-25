// Noah/computer/input.cjs
//
// The virtual mouse and keyboard: real input events injected into the page
// through CDP `Input.*`, i.e. the same event pipeline a physical device uses
// (hit-testing, focus, hover, pointer/mouse/keyboard event ordering, default
// actions, text editing). Nothing here is simulated with element.click().
//
// All coordinates at this layer are CSS px in the top frame's layout viewport;
// mapping from screenshot/model space happens in computer/coordinates.cjs.
//
// Safety properties
//  * `guard()` is consulted before EVERY CDP input event, so an emergency stop
//    interrupts a drag or a long typing run mid-flight, independent of any model.
//  * `releaseAll()` releases any held mouse buttons / keys (used on stop/finish).
//  * HTML5 drag-and-drop uses Input.setInterceptDrags so a synthetic drag can
//    never enter the OS drag loop (which synthetic input cannot terminate).
//  * `isDispatching()` lets the app tell Noah's own synthetic key events apart
//    from real user keystrokes (takeover / emergency-stop detection).

"use strict";

const { resolveKey, parseCombo, modifierMask, editCommandFor, MODIFIER_BITS, normalizeName } = require("./keymap.cjs");

class StoppedError extends Error {
  constructor(message = "Stopped by user") {
    super(message);
    this.name = "StoppedError";
    this.code = "STOPPED";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUTTON_BIT = { left: 1, right: 2, middle: 4 };
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

class InputDriver {
  /**
   * @param {import('../browser/cdp.cjs').CdpSession} cdp
   * @param {object} [opts]
   * @param {() => void} [opts.guard] throws StoppedError when the agent must halt
   */
  constructor(cdp, { guard = () => {}, log = () => {}, onDispatchStart = () => {}, onDispatchEnd = () => {} } = {}) {
    this.cdp = cdp;
    this.guard = guard;
    this.log = log;
    this.onDispatchStart = onDispatchStart;
    this.onDispatchEnd = onDispatchEnd;
    this.pointer = { x: 0, y: 0 };
    this.buttons = 0;
    this.heldModifiers = new Set();
    this.heldKeys = new Set();
    this.dragging = null; // { data, entered }
    this._inFlight = 0;
    this._lastDragData = null;
    this._onDragIntercepted = (data) => {
      this._lastDragData = data;
      if (this.buttons) this.dragging = { data, entered: false };
    };
    cdp.on("drag_intercepted", this._onDragIntercepted);
  }

  dispose() {
    this.cdp.off("drag_intercepted", this._onDragIntercepted);
  }

  isDispatching() {
    return this._inFlight > 0;
  }

  async _send(method, params) {
    this.guard();
    this._inFlight++;
    const kind = /Key/.test(method) ? "key" : "mouse";
    this.onDispatchStart(kind);
    let onDialog;
    try {
      // If the event opens a JS dialog (alert/confirm/prompt) the page's main thread blocks and the input
      // ack never arrives until the dialog is handled. The event WAS delivered, so stop waiting for the ack.
      const dialogOpened = new Promise((resolve) => {
        onDialog = () => resolve({ dialog: true });
        this.cdp.once("dialog", onDialog);
      });
      const call = this.cdp.send(method, params, { timeoutMs: 6000 });
      call.catch(() => {}); // an abandoned call must never become an unhandled rejection
      return await Promise.race([call, dialogOpened]);
    } finally {
      this.cdp.off("dialog", onDialog);
      this._inFlight--;
      this.onDispatchEnd(kind);
    }
  }

  get modifiers() {
    let m = 0;
    for (const mod of this.heldModifiers) m |= MODIFIER_BITS[mod] || 0;
    return m;
  }

  // ------------------------------------------------------------------ mouse

  async mouseMove(x, y) {
    if (this.dragging?.data) {
      const type = this.dragging.entered ? "dragOver" : "dragEnter";
      this.dragging.entered = true;
      await this._send("Input.dispatchDragEvent", { type, x, y, data: this.dragging.data, modifiers: this.modifiers });
      this.pointer = { x, y };
      return;
    }
    const held = this.buttons & 1 ? "left" : this.buttons & 2 ? "right" : this.buttons & 4 ? "middle" : "none";
    await this._send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: held, buttons: this.buttons, modifiers: this.modifiers, pointerType: "mouse",
    });
    this.pointer = { x, y };
  }

  async mouseDown(x, y, { button = "left", clickCount = 1 } = {}) {
    if (x !== undefined && (x !== this.pointer.x || y !== this.pointer.y)) await this.mouseMove(x, y);
    if (button === "left" && !this.dragging) {
      await this._send("Input.setInterceptDrags", { enabled: true }).catch(() => {});
      this._lastDragData = null;
    }
    this.buttons |= BUTTON_BIT[button] || 1;
    await this._send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: this.pointer.x, y: this.pointer.y, button, buttons: this.buttons, clickCount, modifiers: this.modifiers, pointerType: "mouse",
    });
  }

  async mouseUp(x, y, { button = "left", clickCount = 1 } = {}) {
    if (x !== undefined && (x !== this.pointer.x || y !== this.pointer.y)) await this.mouseMove(x, y);
    const px = this.pointer.x;
    const py = this.pointer.y;
    try {
      if (this.dragging?.data) {
        if (!this.dragging.entered) await this._send("Input.dispatchDragEvent", { type: "dragEnter", x: px, y: py, data: this.dragging.data, modifiers: this.modifiers });
        await this._send("Input.dispatchDragEvent", { type: "dragOver", x: px, y: py, data: this.dragging.data, modifiers: this.modifiers });
        await this._send("Input.dispatchDragEvent", { type: "drop", x: px, y: py, data: this.dragging.data, modifiers: this.modifiers });
      }
      this.buttons &= ~(BUTTON_BIT[button] || 1);
      await this._send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: px, y: py, button, buttons: this.buttons, clickCount, modifiers: this.modifiers, pointerType: "mouse",
      });
    } finally {
      this.buttons &= ~(BUTTON_BIT[button] || 1);
      if (button === "left") {
        this.dragging = null;
        this.cdp.send("Input.setInterceptDrags", { enabled: false }).catch(() => {});
      }
    }
  }

  /** Move, press, release. clickCount 2 = double click (two press/release pairs). */
  async click(x, y, { button = "left", clickCount = 1, modifiers = [] } = {}) {
    const added = this._holdModifiers(modifiers);
    try {
      await this.mouseMove(x, y);
      for (let i = 1; i <= clickCount; i++) {
        await this.mouseDown(undefined, undefined, { button, clickCount: i });
        await this.mouseUp(undefined, undefined, { button, clickCount: i });
      }
    } finally {
      this._releaseModifiers(added);
    }
  }

  /**
   * Press at `from`, move along an eased path to `to`, release. Works for
   * pointer-event canvases (Figma-like), mouse-event widgets, and HTML5 DnD.
   */
  async drag(from, to, { steps = 14, holdMs = 60 } = {}) {
    try {
      await this.mouseMove(from.x, from.y);
      await this.mouseDown(from.x, from.y, { button: "left" });
      await sleep(holdMs); // let press-handlers / drag thresholds arm
      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      const n = Math.max(2, Math.min(60, dist < 30 ? 4 : steps));
      for (let i = 1; i <= n; i++) {
        const t = easeInOut(i / n);
        await this.mouseMove(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
        if (i === 3) await sleep(20); // give Blink a moment to report a native drag
      }
      await sleep(40);
      // Input.dragIntercepted is reported asynchronously (renderer -> browser IPC), so on a busy machine it can land
      // after the last mouseMoved. Releasing before it arrives would drop nothing and strand the drag; give it a
      // bounded moment (exits at once when it has arrived, or costs ~150ms for a plain pointer-event drag).
      for (let i = 0; i < 15 && !this.dragging; i++) await sleep(10);
      await this.mouseUp(to.x, to.y, { button: "left" });
    } catch (err) {
      await this.releaseAll().catch(() => {});
      throw err;
    }
  }

  /** Mouse wheel at a point. Large deltas are chunked like real wheel notches. */
  async wheel(x, y, deltaX = 0, deltaY = 0, { chunk = 300, delayMs = 12, maxMs = 1600 } = {}) {
    await this.mouseMove(x, y);
    // Small notches with a short pause read as a hand on the wheel; the total is capped so a long scroll is not slow.
    let CH = Math.max(20, chunk);
    const total = Math.max(Math.abs(deltaX), Math.abs(deltaY));
    if (delayMs > 0 && total > 0 && Math.ceil(total / CH) * delayMs > maxMs) CH = Math.ceil(total / Math.max(1, Math.floor(maxMs / delayMs)));
    let rx = deltaX;
    let ry = deltaY;
    while (Math.abs(rx) > 0.5 || Math.abs(ry) > 0.5) {
      const dx = Math.abs(rx) > CH ? Math.sign(rx) * CH : rx;
      const dy = Math.abs(ry) > CH ? Math.sign(ry) * CH : ry;
      await this._send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, deltaX: dx, deltaY: dy, modifiers: this.modifiers, pointerType: "mouse",
      });
      rx -= dx;
      ry -= dy;
      if (Math.abs(rx) > 0.5 || Math.abs(ry) > 0.5) await sleep(delayMs);
    }
  }

  // --------------------------------------------------------------- keyboard

  _holdModifiers(mods) {
    const added = [];
    for (const m of mods || []) {
      const n = normalizeName(m === "ctrl" ? "control" : m);
      const canon = n === "Mod" ? "Control" : n;
      if (MODIFIER_BITS[canon] && !this.heldModifiers.has(canon)) {
        this.heldModifiers.add(canon);
        added.push(canon);
      }
    }
    return added;
  }

  _releaseModifiers(added) {
    for (const m of added) this.heldModifiers.delete(m);
  }

  _keyParams(def, type, { text, commands } = {}) {
    const p = {
      type,
      modifiers: this.modifiers,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      autoRepeat: false,
      isKeypad: false,
    };
    if (text !== undefined) {
      p.text = text;
      p.unmodifiedText = text;
    }
    if (commands && commands.length) p.commands = commands;
    return p;
  }

  async keyDown(name) {
    const def = resolveKey(name);
    if (!def) throw new Error(`unknown key "${name}"`);
    if (def.modifier) this.heldModifiers.add(def.modifier);
    this.heldKeys.add(def.key);
    // Characters only produce text when no command modifier is held.
    const commandHeld = this.heldModifiers.has("Control") || this.heldModifiers.has("Alt") || this.heldModifiers.has("Meta");
    const text = !def.modifier && def.text && !commandHeld ? def.text : undefined;
    const cmd = commandHeld ? editCommandFor(def.key, [...this.heldModifiers]) : null;
    await this._send("Input.dispatchKeyEvent", this._keyParams(def, text !== undefined ? "keyDown" : "rawKeyDown", { text, commands: cmd ? [cmd] : undefined }));
  }

  async keyUp(name) {
    const def = resolveKey(name);
    if (!def) throw new Error(`unknown key "${name}"`);
    try {
      await this._send("Input.dispatchKeyEvent", this._keyParams(def, "keyUp"));
    } finally {
      if (def.modifier) this.heldModifiers.delete(def.modifier);
      this.heldKeys.delete(def.key);
    }
  }

  async keyPress(name, { repeat = 1 } = {}) {
    for (let i = 0; i < repeat; i++) {
      await this.keyDown(name);
      await this.keyUp(name);
    }
  }

  async hotkey(combo) {
    const { modifiers, key } = parseCombo(combo);
    if (!key) throw new Error(`invalid hotkey "${combo}"`);
    const pressed = [];
    try {
      for (const m of modifiers) {
        await this.keyDown(m);
        pressed.push(m);
      }
      await this.keyDown(key);
      await this.keyUp(key);
    } finally {
      for (const m of pressed.reverse()) await this.keyUp(m).catch(() => {});
    }
  }

  async insertText(text) {
    await this._send("Input.insertText", { text });
  }

  /**
   * Type text. mode:
   *   keys   real key events per character (needed by editors that listen to
   *          keydown: Docs-like apps, autocomplete widgets, key-driven UIs)
   *   insert one Input.insertText (fast; for long text)
   *   auto   keys up to 200 chars, insert beyond
   * Characters without a US-layout key (é, 你, emoji) are always inserted.
   */
  async type(text, { mode = "auto", delayMs = 0 } = {}) {
    const chars = [...String(text)];
    // Real key events (visible, and what editors listen for) up to ~1500 characters, one insert beyond that.
    const use = mode === "auto" ? (chars.length <= 1500 ? "keys" : "insert") : mode;
    if (use === "insert") {
      await this.insertText(String(text));
      return { chars: chars.length, mode: "insert" };
    }
    let buffer = "";
    const flush = async () => {
      if (buffer) {
        await this.insertText(buffer);
        buffer = "";
      }
    };
    for (const ch of chars) {
      if (ch === "\n" || ch === "\r") {
        await flush();
        await this.keyPress("Enter");
      } else if (ch === "\t") {
        await flush();
        await this.keyPress("Tab");
      } else {
        const def = resolveKey(ch);
        if (!def) {
          buffer += ch;
          continue;
        }
        await flush();
        await this._send("Input.dispatchKeyEvent", this._keyParams(def, "keyDown", { text: ch }));
        await this._send("Input.dispatchKeyEvent", this._keyParams(def, "keyUp"));
        if (delayMs) await sleep(delayMs);
      }
    }
    await flush();
    return { chars: chars.length, mode: "keys" };
  }

  /** Release everything still held (mouse buttons, keys, modifiers). Never throws. */
  async releaseAll() {
    const guardWas = this.guard;
    this.guard = () => {}; // cleanup must run even after a stop
    try {
      if (this.buttons) {
        for (const [name, bit] of Object.entries(BUTTON_BIT)) {
          if (this.buttons & bit) await this.mouseUp(undefined, undefined, { button: name }).catch(() => {});
        }
      }
      for (const k of [...this.heldKeys]) await this.keyUp(k).catch(() => {});
      this.heldModifiers.clear();
      this.heldKeys.clear();
      this.buttons = 0;
      this.dragging = null;
      await this.cdp.send("Input.setInterceptDrags", { enabled: false }).catch(() => {});
    } finally {
      this.guard = guardWas;
    }
  }
}

module.exports = { InputDriver, StoppedError };
