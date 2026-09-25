// Noah/safety/takeover.cjs
//
// Independent of any model:
//   * EMERGENCY STOP  - the configured shortcut (default Escape) pressed by the
//                       user in Jonah, anywhere, stops the task.
//   * USER TAKEOVER   - real user keystrokes in the page, real mouse movement
//                       over the page, or switching tabs pauses the agent
//                       ("manual takeover"); the user resumes or stops it.
//
// The hard part is telling the user's input from Noah's own. CDP-injected key
// events flow through the same browser-process hook as real ones, so
// InputDriver.isDispatching() (in-flight flag) plus a short trailing window
// marks Noah's events. Noah never moves the OS cursor (it injects events
// straight into the page), so ANY physical cursor movement over the page during
// a task is the user.

"use strict";

const { slog } = require("../agent/lifecycle-log.cjs");

const MODIFIER_ONLY = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "NumLock", "ScrollLock"]);

class TakeoverMonitor {
  /**
   * @param {object} deps
   * @param {import('./safety-controller.cjs').SafetyController} deps.safety
   * @param {import('../browser/tabs.cjs').TabRegistry} deps.tabs
   * @param {import('electron').BrowserWindow} deps.mainWindow
   * @param {typeof import('electron').screen} deps.screen
   * @param {() => object} deps.getConfig
   * @param {() => boolean} deps.isSynthetic   true while Noah is dispatching its own input
   */
  constructor({ safety, tabs, mainWindow, screen, getConfig, isSynthetic, log = () => {} }) {
    this.safety = safety;
    this.tabs = tabs;
    this.win = mainWindow;
    this.screen = screen;
    this.getConfig = getConfig;
    this.isSynthetic = isSynthetic || (() => false);
    this.log = log;
    this._watched = new WeakSet();
    this._timer = null;
    this._tabTimer = null;
    this._last = null;
    this._rect = null;
    this._rectAt = 0;
    this._lastSyntheticEnd = 0;
    this._spans = []; // [{ start, end|null }] of Noah's own input dispatches
    this._onActive = ({ byNoah }) => {
      if (!byNoah && this._running()) this._takeover("You switched tabs");
    };
    tabs.on("active_changed", this._onActive);
  }

  _running() {
    // an ENDED task must not keep reacting to the user: it used to, so clicking or scrolling after a task finished
    // produced "Paused (you took control)" on an idle agent
    return !!this.safety.active && !this.safety.stopped;
  }

  /** Noah is about to inject an input event: everything the page sees from now until the matching end is Noah's. */
  markSyntheticStart(kind = "any") {
    const now = Date.now();
    this._spans = this._spans.filter((s) => now - (s.end ?? now) < 10_000).slice(-200);
    this._spans.push({ start: now, end: null, kind });
  }

  /** Call when Noah finishes dispatching a synthetic event (extends the trailing window). */
  markSyntheticEnd(kind = "any") {
    this._lastSyntheticEnd = Date.now();
    const open = this._spans.find((s) => s.end === null && s.kind === kind) || this._spans.find((s) => s.end === null);
    if (open) open.end = this._lastSyntheticEnd;
  }

  /**
   * Was an input event that the PAGE saw at time `t` (page Date.now()) injected by Noah? The page's report reaches us
   * over IPC after the fact, so in-flight state is not enough: compare against the recorded dispatch spans.
   * `kind` ("key" | "mouse"): Noah typing must not hide a REAL click that lands between two of its keystrokes, which is
   * exactly when a person grabs the mouse to take over.
   */
  syntheticAt(t, kind) {
    const now = Date.now();
    return this._spans.some((s) => (!kind || s.kind === "any" || s.kind === kind) && t >= s.start - 30 && t <= (s.end ?? now) + 250);
  }

  /**
   * A trusted mouse click / wheel / touch reported by the guest page's preload (webview-preload.js).
   * Motion alone never gets here: only deliberate interaction is a takeover.
   */
  pageInput(msg) {
    if (!this._running() || this.safety.paused || this.safety.stopped) return;
    if (this.getConfig().takeover?.enabled === false) return;
    if (this.safety.hasPendingConfirmation()) return;
    if (!msg || typeof msg.t !== "number" || !["mousedown", "wheel", "touchstart"].includes(msg.type)) return;
    if (this.syntheticAt(msg.t, "mouse")) return;
    this._takeover(msg.type === "wheel" ? "You scrolled the page" : "You clicked in the page", { input: msg.type, ageMs: Date.now() - msg.t, lastMouseSpan: this._lastSpanAge("mouse"), lastKeySpan: this._lastSpanAge("key") });
  }

  /** Attach keyboard listeners to a webContents (idempotent). isGuest = page content, not the shell. */
  watch(wc, { isGuest }) {
    if (!wc || this._watched.has(wc)) return;
    this._watched.add(wc);
    wc.on("before-input-event", (_event, input) => {
      if (!this._running() || input.type !== "keyDown") return;
      const synthetic = this.isSynthetic() || Date.now() - this._lastSyntheticEnd < 40;
      if (synthetic) return;
      const stopKey = this.getConfig().stopShortcut || "Escape";
      if (input.key === stopKey) {
        this.safety.stop("user_escape");
        return;
      }
      if (!isGuest) return; // typing in the shell (confirm card, panel) is not a takeover
      if (MODIFIER_ONLY.has(input.key) || input.isAutoRepeat) return;
      if (this.getConfig().takeover?.enabled === false) return;
      if (this.safety.hasPendingConfirmation()) return;
      this._takeover("You started typing in the page");
    });
  }

  /** Milliseconds since Noah's last own input of this kind (null: none recorded). Diagnostic only. */
  _lastSpanAge(kind) {
    const now = Date.now();
    const last = [...this._spans].reverse().find((s) => s.kind === kind || s.kind === "any");
    return last ? now - (last.end ?? now) : null;
  }

  _takeover(reason, detail = {}) {
    if (this.getConfig().takeover?.enabled === false) return;
    if (this.safety.paused || this.safety.stopped) return;
    this.safety.pause("takeover");
    this.log("takeover:", reason);
    // The physical cursor is evidence: Noah never moves it, so one over the page (or one that moved) is a person or a remote session.
    let cursor = null;
    try {
      cursor = this.screen && this.screen.getCursorScreenPoint ? this.screen.getCursorScreenPoint() : null;
    } catch (_) {
      /* ignore */
    }
    slog("TAKEOVER_DETECTED", { reason, cursor, focused: !!(this.win && this.win.isFocused && this.win.isFocused()), ...detail });
  }

  start() {
    this.stop();
    this._last = null;
    const poll = 120;
    this._timer = setInterval(() => this._pollCursor(), poll);
    this._tabTimer = setInterval(() => {
      if (this._running()) this.tabs.refresh().catch(() => {});
    }, 500);
  }

  stop() {
    clearInterval(this._timer);
    clearInterval(this._tabTimer);
    this._timer = this._tabTimer = null;
  }

  dispose() {
    this.stop();
    this.tabs.off("active_changed", this._onActive);
  }

  async _webviewScreenRect() {
    const now = Date.now();
    if (!this._rect || now - this._rectAt > 1000) {
      try {
        const r = await this.win.webContents.executeJavaScript("window.NoahRenderer ? window.NoahRenderer.webviewRect() : null", true);
        this._rect = r;
        this._rectAt = now;
      } catch (_) {
        /* keep old */
      }
    }
    if (!this._rect || this.win.isDestroyed()) return null;
    const b = this.win.getContentBounds();
    return { x: b.x + this._rect.x, y: b.y + this._rect.y, width: this._rect.width, height: this._rect.height };
  }

  async _pollCursor() {
    if (!this._running() || this.safety.paused || this.safety.hasPendingConfirmation()) {
      this._last = null;
      return;
    }
    // Opt-in only (takeover.mouseMove): watching pointer movement paused the agent whenever the user simply moved
    // the mouse, including to click "Resume", which paused it again in a loop.
    if (this.getConfig().takeover?.mouseMove !== true) {
      this._last = null;
      return;
    }
    if (this.getConfig().takeover?.enabled === false || this.win.isDestroyed() || !this.win.isFocused()) {
      this._last = null;
      return;
    }
    const p = this.screen.getCursorScreenPoint();
    const last = this._last;
    this._last = p;
    if (!last) return;
    const threshold = this.getConfig().takeover?.cursorDeltaPx || 14;
    if (Math.hypot(p.x - last.x, p.y - last.y) < threshold) return;
    const rect = await this._webviewScreenRect();
    if (!rect) return;
    const inside = p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
    if (inside) this._takeover("You moved the mouse over the page");
  }
}

module.exports = { TakeoverMonitor };
