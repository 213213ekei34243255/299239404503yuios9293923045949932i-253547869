// Noah/browser/cdp.cjs
//
// A thin, defensive CDP client over Electron's `webContents.debugger`.
//
// Why raw CDP and not Playwright/Puppeteer: Electron already exposes an
// in-process CDP client, so there is no extra Node relay hop (the latency that
// pushed Browser Use off Playwright), it works directly against <webview>
// guests, and cross-origin iframes (which Chromium isolates into separate
// targets) can be driven through flattened child sessions.
//
// Responsibilities:
//   * attach/detach lifecycle, auto-recovery after detach
//   * per-call timeouts (a hung renderer must never hang the agent)
//   * flattened child sessions for out-of-process iframes (OOPIF)
//   * JavaScript dialog tracking (must be handled or the page hangs)
//   * HTML5 drag interception plumbing (see computer/input.cjs)
//   * isolated-world evaluation, so page scripts cannot observe or tamper
//     with Noah's helper code (prototype overrides, globals)

"use strict";

const { EventEmitter } = require("events");

class CdpError extends Error {
  constructor(message, { method, code } = {}) {
    super(message);
    this.name = "CdpError";
    this.method = method;
    this.code = code || "CDP_ERROR";
  }
}

const DEFAULT_TIMEOUT_MS = 8000;

// While a JS dialog is open the page's main thread is frozen: almost every page-bound command would hang
// until its timeout. Only these can proceed, so everything else fails fast with a clear, actionable error.
const DIALOG_SAFE = new Set([
  "Page.handleJavaScriptDialog", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.dispatchDragEvent",
  "Input.setInterceptDrags", "Input.insertText", "Runtime.releaseObject", "Target.setAutoAttach", "Accessibility.disable",
]);

class CdpSession extends EventEmitter {
  /**
   * @param {import('electron').WebContents} wc  the guest (or any) webContents
   */
  constructor(wc, { log = () => {} } = {}) {
    super();
    this.wc = wc;
    this.log = log;
    this.attached = false;
    this.children = new Map(); // sessionId -> { sessionId, targetId, frameId, type, url }
    this.mainFrameId = null;
    this.dialog = null;
    this.navigationCount = 0;
    this.lastNavAt = 0; // last time the main frame requested/started a navigation (form submit, link click, location=...)
    this._worlds = new Map(); // `${sessionId||''}|${frameId}|${nav}` -> executionContextId
    this._domainsEnabled = new Set(); // `${sessionId||''}|${domain}`
    this._onMessage = this._onMessage.bind(this);
    this._onDetach = this._onDetach.bind(this);
  }

  get webContentsId() {
    return this.wc.id;
  }

  isAlive() {
    return this.attached && !this.wc.isDestroyed();
  }

  // ---- lifecycle -----------------------------------------------------------

  async attach() {
    if (this.wc.isDestroyed()) throw new CdpError("webContents is destroyed", { code: "DESTROYED" });
    if (this.attached) return this;
    const dbg = this.wc.debugger;
    if (!dbg.isAttached()) {
      try {
        dbg.attach("1.3");
      } catch (err) {
        throw new CdpError(`debugger attach failed: ${err.message}`, { code: "ATTACH_FAILED" });
      }
    }
    dbg.on("message", this._onMessage);
    dbg.on("detach", this._onDetach);
    this.attached = true;
    try {
      await this.send("Page.enable");
      await this.send("DOM.enable");
      await this.send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => {});
      await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch((e) =>
        this.log("setAutoAttach failed (OOPIF support degraded):", e.message)
      );
      const tree = await this.send("Page.getFrameTree");
      this.mainFrameId = tree.frameTree.frame.id;
    } catch (err) {
      this.detach();
      throw err;
    }
    return this;
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    const dbg = this.wc.isDestroyed() ? null : this.wc.debugger;
    if (dbg) {
      dbg.removeListener("message", this._onMessage);
      dbg.removeListener("detach", this._onDetach);
      try {
        if (dbg.isAttached()) dbg.detach();
      } catch (_) {
        /* ignore */
      }
    }
    this.children.clear();
    this._worlds.clear();
    this._domainsEnabled.clear();
    this.dialog = null;
    this.emit("detached", { reason: "requested" });
  }

  _onDetach(_e, reason) {
    this.attached = false;
    this.children.clear();
    this._worlds.clear();
    this._domainsEnabled.clear();
    this.dialog = null;
    this.emit("detached", { reason });
  }

  // ---- calls ---------------------------------------------------------------

  /**
   * Send a CDP command with a timeout. `sessionId` targets a child (OOPIF) session.
   */
  async send(method, params = {}, { sessionId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!this.isAlive()) throw new CdpError(`cannot send ${method}: not attached`, { method, code: "NOT_ATTACHED" });
    if (this.dialog && !DIALOG_SAFE.has(method)) {
      throw new CdpError(`${method} skipped: a JavaScript ${this.dialog.type} dialog is open ("${this.dialog.message.slice(0, 60)}"). Use handle_dialog first.`, { method, code: "DIALOG_OPEN" });
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CdpError(`${method} timed out after ${timeoutMs}ms`, { method, code: "TIMEOUT" })), timeoutMs);
    });
    try {
      const call = sessionId ? this.wc.debugger.sendCommand(method, params, sessionId) : this.wc.debugger.sendCommand(method, params);
      return await Promise.race([call, timeout]);
    } catch (err) {
      if (err instanceof CdpError) throw err;
      throw new CdpError(`${method} failed: ${err.message}`, { method, code: "CDP_ERROR" });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Enable a domain once per (session, domain). */
  async ensureDomain(domain, sessionId) {
    const key = `${sessionId || ""}|${domain}`;
    if (this._domainsEnabled.has(key)) return;
    await this.send(`${domain}.enable`, {}, { sessionId });
    this._domainsEnabled.add(key);
  }

  async disableDomain(domain, sessionId) {
    const key = `${sessionId || ""}|${domain}`;
    if (!this._domainsEnabled.has(key)) return;
    this._domainsEnabled.delete(key);
    await this.send(`${domain}.disable`, {}, { sessionId }).catch(() => {});
  }

  // ---- events --------------------------------------------------------------

  _onMessage(_event, method, params, sessionId) {
    try {
      if (!sessionId) return this._onRootEvent(method, params);
      if (method === "Page.frameNavigated" || method === "Target.attachedToTarget") this._worlds.clear();
      this.emit("child_event", { sessionId, method, params });
    } catch (err) {
      this.log("cdp event handler error:", err.message);
    }
  }

  _onRootEvent(method, params) {
    switch (method) {
      case "Target.attachedToTarget": {
        const info = params.targetInfo || {};
        if (info.type === "iframe" || info.type === "page") {
          this.children.set(params.sessionId, {
            sessionId: params.sessionId,
            targetId: info.targetId,
            frameId: info.targetId, // for OOPIFs the target id is the frame id
            type: info.type,
            url: info.url,
          });
          this.emit("child_attached", this.children.get(params.sessionId));
        }
        break;
      }
      case "Target.detachedFromTarget":
        this.children.delete(params.sessionId);
        for (const key of [...this._domainsEnabled]) if (key.startsWith(params.sessionId + "|")) this._domainsEnabled.delete(key);
        this.emit("child_detached", { sessionId: params.sessionId });
        break;
      case "Target.targetInfoChanged": {
        for (const c of this.children.values()) if (c.targetId === params.targetInfo?.targetId) c.url = params.targetInfo.url;
        break;
      }
      case "Page.frameNavigated":
        if (!params.frame.parentId) {
          this.mainFrameId = params.frame.id;
          this.navigationCount++;
          this._worlds.clear();
          this.emit("navigated", params.frame);
        }
        break;
      case "Page.javascriptDialogOpening":
        this.dialog = {
          type: params.type,
          message: String(params.message || "").slice(0, 500),
          url: params.url,
          defaultPrompt: params.defaultPrompt,
          openedAt: Date.now(),
        };
        this.emit("dialog", this.dialog);
        break;
      case "Page.javascriptDialogClosed":
        this.dialog = null;
        this.emit("dialog_closed", params);
        break;
      case "Page.frameRequestedNavigation":
      case "Page.frameStartedNavigating":
        if (!params.frameId || params.frameId === this.mainFrameId) this.lastNavAt = Date.now();
        break;
      case "Page.frameStartedLoading":
        if (!params.frameId || params.frameId === this.mainFrameId) this.lastNavAt = Date.now();
        break;
      case "Page.lifecycleEvent":
        this.emit("lifecycle", params);
        break;
      case "Input.dragIntercepted":
        this.emit("drag_intercepted", params.data);
        break;
      default:
        break;
    }
  }

  async handleDialog(accept, promptText) {
    if (!this.dialog) return false;
    await this.send("Page.handleJavaScriptDialog", { accept: !!accept, ...(promptText !== undefined ? { promptText } : {}) });
    this.dialog = null;
    return true;
  }

  // ---- evaluation -----------------------------------------------------------

  /** Get (or create) Noah's isolated JS world for a frame. */
  async isolatedWorld(frameId, sessionId) {
    const fid = frameId || this.mainFrameId;
    const key = `${sessionId || ""}|${fid}|${this.navigationCount}`;
    if (this._worlds.has(key)) return this._worlds.get(key);
    const res = await this.send("Page.createIsolatedWorld", { frameId: fid, worldName: "noah-isolated" }, { sessionId });
    let contextId = res.executionContextId;
    // The world asked for as "the main frame's" must BE the main frame's document. Observed live: on a page carrying an injected
    // embedded frame (Netlify's "Powered by Netlify" badge, an about:srcdoc iframe) the context that came back belonged to that 197x64
    // iframe, so a whole page read as 18 characters of text with no questions on it. Check, and ask again under a fresh name if wrong.
    if (!sessionId && fid === this.mainFrameId) {
      for (let n = 1; n <= 2 && !(await this._isTopWorld(contextId)); n++) {
        this.log(`isolated world ${contextId} is not the top-level document; recreating (${n})`);
        const again = await this.send("Page.createIsolatedWorld", { frameId: fid, worldName: `noah-isolated-${Date.now().toString(36)}-${n}` }, { sessionId });
        contextId = again.executionContextId;
      }
    }
    this._worlds.set(key, contextId);
    return contextId;
  }

  /** Is this execution context the top-level document (not an embedded iframe)? Never throws. */
  async _isTopWorld(contextId) {
    try {
      const r = await this.send("Runtime.evaluate", { expression: "window === window.top", contextId, returnByValue: true, silent: true, timeout: 1500 }, { timeoutMs: 2500 });
      return !!(r && r.result && r.result.value === true);
    } catch (_) {
      return true; // cannot tell: do not loop on a probe failure
    }
  }

  /**
   * Evaluate an expression in Noah's isolated world of the main frame (or a
   * given frame). Returns the JSON value. Throws CdpError on exceptions.
   */
  async evaluate(expression, { frameId, sessionId, awaitPromise = false, timeoutMs = 6000 } = {}) {
    let attempt = 0;
    for (;;) {
      const contextId = await this.isolatedWorld(frameId, sessionId);
      try {
        const res = await this.send(
          "Runtime.evaluate",
          { expression, contextId, returnByValue: true, awaitPromise, silent: true, timeout: Math.max(1000, timeoutMs - 500) },
          { sessionId, timeoutMs }
        );
        if (res.exceptionDetails) {
          const d = res.exceptionDetails;
          throw new CdpError(`evaluate exception: ${d.exception?.description || d.text}`, { method: "Runtime.evaluate", code: "EVAL_EXCEPTION" });
        }
        return res.result.value;
      } catch (err) {
        const stale = /Cannot find context|context.*destroyed|Execution context/i.test(err.message);
        if (stale && attempt++ < 2) {
          this._worlds.clear();
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * After some navigations (YouTube) the cached isolated world still belongs to the initial blank document: it reports
   * location "about:blank" and a 0x0 viewport, so every element looks off-screen and every action fails as "offscreen".
   * Compare the world's document with the browser's own idea of the URL and rebuild the world when they disagree.
   */
  async ensureFreshWorld() {
    try {
      const probe = await this.evaluate("({ href: location.href, top: window === window.top })", { timeoutMs: 2500 });
      const href = probe && probe.href;
      const real = this.wc.getURL();
      // a blank/embedded document (about:blank, about:srcdoc) or a non-top frame is never the page the user is looking at
      if (real && real !== href && (!href || /^about:/.test(href) || !probe.top)) this._worlds.clear();
      else if (probe && !probe.top) this._worlds.clear();
    } catch (_) {
      this._worlds.clear();
    }
  }

  /**
   * Run a function on a DOM node (by backendNodeId) inside the isolated world.
   * `fn` is a function *declaration string*, e.g. "function(a){ return this.value + a }".
   */
  async callOnNode(backendNodeId, fn, args = [], { sessionId, frameId, awaitPromise = false } = {}) {
    const contextId = await this.isolatedWorld(frameId, sessionId);
    const { object } = await this.send("DOM.resolveNode", { backendNodeId, executionContextId: contextId }, { sessionId });
    try {
      const res = await this.send(
        "Runtime.callFunctionOn",
        {
          objectId: object.objectId,
          functionDeclaration: fn,
          arguments: args.map((value) => ({ value })),
          returnByValue: true,
          awaitPromise,
          silent: true,
        },
        { sessionId }
      );
      if (res.exceptionDetails) {
        throw new CdpError(`callOnNode exception: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`, {
          code: "EVAL_EXCEPTION",
        });
      }
      return res.result.value;
    } finally {
      this.send("Runtime.releaseObject", { objectId: object.objectId }, { sessionId }).catch(() => {});
    }
  }

  /**
   * Viewport size (CSS px) and scroll, independent of DPR/zoom.
   *
   * IMPORTANT: width/height are window.innerWidth/innerHeight, i.e. they INCLUDE the scrollbar gutter.
   * That is the coordinate space of both Input.dispatchMouseEvent and the captured screenshot.
   * Page.getLayoutMetrics' cssLayoutViewport.clientWidth EXCLUDES the scrollbar and would skew the
   * screenshot->viewport ratio by up to ~17px on any page that has a scrollbar.
   */
  async layoutMetrics() {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const v = await this.evaluate(
          `({ w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY, cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight,
              sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, dpr: devicePixelRatio })`,
          { timeoutMs: 4000 }
        );
        if (v.w > 0 && v.h > 0) return { width: v.w, height: v.h, clientWidth: v.cw, clientHeight: v.ch, scrollX: v.sx, scrollY: v.sy, contentWidth: v.sw, contentHeight: v.sh, dpr: v.dpr, scale: 1 };
        this._worlds.clear(); // a 0x0 viewport means we measured a dead document: rebuild the world and measure again
      }
      throw new Error("viewport measured 0x0");
    } catch (err) {
      if (err.code === "DIALOG_OPEN") throw err;
      const m = await this.send("Page.getLayoutMetrics");
      const vv = m.cssVisualViewport || {};
      const lv = m.cssLayoutViewport || {};
      const cs = m.cssContentSize || m.contentSize || {};
      return { width: Math.round(lv.clientWidth || vv.clientWidth), height: Math.round(lv.clientHeight || vv.clientHeight), scrollX: vv.pageX || lv.pageX || 0, scrollY: vv.pageY || lv.pageY || 0, contentWidth: cs.width || 0, contentHeight: cs.height || 0, scale: vv.scale || 1, fallback: true };
    }
  }
}

module.exports = { CdpSession, CdpError, DEFAULT_TIMEOUT_MS };
