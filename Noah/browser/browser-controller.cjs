// Noah/browser/browser-controller.cjs
//
// Browser-native capability layer: tabs, navigation, semantic targeting
// (AX refs / text) and DOM-level fallbacks, dialogs, downloads, uploads.
// It owns the per-tab CDP context (session + observer + refs + input driver)
// and resolves "what does the model mean" into concrete viewport points.
//
// Method-selection ladder for acting on an element (the RecoveryEngine walks it):
//   1. pointer   real mouse click at the element's computed point   (most faithful)
//   2. dom       element.click() via CDP                            (works when a box can't be hit)
//   3. keyboard  focus + Enter/Space                                (works for stubborn widgets)
//   4. vision    re-ground from a fresh screenshot -> coordinate    (canvas / unlabeled UI)

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const { CdpSession } = require("./cdp.cjs");
const { Observer } = require("../perception/observer.cjs");
const ax = require("../perception/ax.cjs");
const { InputDriver } = require("../computer/input.cjs");
const { checkNavigation, isExecutableDownload } = require("../safety/url-guard.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class BrowserError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "BrowserError";
    this.code = code;
    this.details = details;
  }
}

const SENSITIVE_UPLOAD_PATHS = [
  /[\\/]\.ssh[\\/]/i, /[\\/]\.aws[\\/]/i, /[\\/]\.gnupg[\\/]/i, /[\\/]\.config[\\/]gcloud/i, /[\\/]AppData[\\/](Local|Roaming)[\\/](?!Temp[\\/])/i,
  /[\\/]Library[\\/](Keychains|Application Support)[\\/]/i, /[\\/](Cookies|Login Data|Local State|Web Data|History)$/i,
  /\.env(\.|$)/i, /key\.json$/i, /id_rsa/i, /\.(pem|key|pfx|p12|kdbx)$/i, /[\\/]Windows[\\/]/i, /[\\/]etc[\\/](passwd|shadow)/i,
];

class BrowserController extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('./tabs.cjs').TabRegistry} deps.tabs
   * @param {import('electron').BrowserWindow} deps.mainWindow
   * @param {import('../events.cjs').EventBus} deps.bus
   * @param {import('../safety/safety-controller.cjs').SafetyController} deps.safety
   * @param {() => object} deps.getConfig
   * @param {object} [deps.scanner]
   * @param {typeof import('electron').screen} [deps.screen]
   */
  constructor({ tabs, mainWindow, bus, safety, getConfig, scanner, screen, log = () => {} }) {
    super();
    this.tabs = tabs;
    this.win = mainWindow;
    this.bus = bus;
    this.safety = safety;
    this.getConfig = getConfig || (() => ({}));
    this.scanner = scanner;
    this.screen = screen;
    this.log = log;
    this.targetTabId = null;
    this._ctx = new Map(); // wcId -> ctx
    this.frame = null; // last screenshot frame the model saw
    this.downloads = [];
    this.dirty = true;
    this._watchedSessions = new WeakSet();
    this._dialogTimers = new Map();
  }

  // ------------------------------------------------------------------ context

  async shellInfo() {
    try {
      const rect = await this.win.webContents.executeJavaScript("window.NoahRenderer ? window.NoahRenderer.webviewRect() : null", true);
      const b = this.win.getContentBounds();
      const display = this.screen ? this.screen.getDisplayMatching(this.win.getBounds()) : null;
      const guest = this.currentSync()?.cdp.wc;
      return {
        webviewRect: rect,
        windowContentBounds: { x: b.x, y: b.y, width: b.width, height: b.height },
        display: display ? { scaleFactor: display.scaleFactor } : null,
        zoomFactor: guest && guest.getZoomFactor ? guest.getZoomFactor() : 1,
      };
    } catch (_) {
      return null;
    }
  }

  currentSync() {
    for (const ctx of this._ctx.values()) if (ctx.tabId === this.targetTabId) return ctx;
    return null;
  }

  /** The context (CDP session, observer, refs, driver) of the agent's target tab; attaches on demand. */
  async current({ activate = false } = {}) {
    let tabs = await this.tabs.list(150);
    let tab = this.targetTabId ? tabs.find((t) => t.id === this.targetTabId) : null;
    if (!tab) {
      tab = tabs.find((t) => t.active) || tabs[0];
      if (!tab) throw new BrowserError("No browser tab is available", "no_tab");
      this.targetTabId = tab.id;
    }
    if (activate && !tab.active) {
      await this.tabs.switchTo(tab.id);
      tabs = await this.tabs.list(0);
      tab = tabs.find((t) => t.id === tab.id) || tab;
    }
    let ctx = this._ctx.get(tab.wcId);
    if (ctx && ctx.cdp.isAlive()) return ctx;
    const wc = this.tabs.guest(tab.id);
    if (!wc) throw new BrowserError(`Tab ${tab.id} is not available`, "tab_gone");
    this.watchSession(wc.session);
    const cdp = new CdpSession(wc, { log: (...a) => this.log(...a) });
    await cdp.attach();
    const refs = new ax.RefTable();
    const observer = new Observer({
      cdp,
      refs,
      tabs: { list: () => this.tabs.list(300) },
      shellInfo: () => this.shellInfo(),
      scanner: this.scanner,
      config: this.getConfig().perception || {},
      log: (...a) => this.log(...a),
    });
    const driver = new InputDriver(cdp, { guard: this.safety.guard, log: (...a) => this.log(...a), onDispatchStart: (kind) => this.emit("synthetic_start", kind), onDispatchEnd: (kind) => this.emit("synthetic_end", kind) });
    ctx = { tabId: tab.id, wcId: tab.wcId, cdp, observer, refs, driver };
    this._ctx.set(tab.wcId, ctx);
    this.emit("guest_attached", wc);
    cdp.on("detached", () => {
      driver.dispose();
      this._ctx.delete(tab.wcId);
    });
    cdp.on("navigated", () => this.invalidateFrame("navigated"));
    cdp.on("dialog", (d) => this._onDialog(ctx, d));
    cdp.on("dialog_closed", () => {
      clearTimeout(this._dialogTimers.get(tab.wcId));
    });
    return ctx;
  }

  async setTarget(tabId) {
    const t = this.tabs.get(tabId) || (await this.tabs.list(0)).find((x) => x.id === tabId);
    if (!t) throw new BrowserError(`no such tab: ${tabId}`, "no_tab");
    const cfg = this.getConfig();
    if (cfg.sessionMode === "isolated" && !t.ownedByNoah) {
      throw new BrowserError("Sandbox mode: Noah may only operate tabs it opened itself", "tab_not_owned");
    }
    this.targetTabId = tabId;
    this.invalidateFrame("tab changed");
    return t;
  }

  async releaseAll() {
    for (const ctx of [...this._ctx.values()]) {
      try {
        // bounded: on a frozen page these CDP calls never answer, and a release that hangs keeps the WHOLE agent busy
        // (the next instruction would wait behind it forever). detach() below cuts whatever is still pending.
        let timer;
        await Promise.race([
          (async () => {
            await ctx.driver.releaseAll();
            await ctx.observer.disable();
          })(),
          new Promise((resolve) => (timer = setTimeout(resolve, 4000))),
        ]).finally(() => clearTimeout(timer));
      } catch (_) {
        /* ignore */
      }
      try {
        ctx.cdp.detach();
      } catch (_) {
        /* ignore */
      }
    }
    this._ctx.clear();
    this.frame = null;
    for (const t of this._dialogTimers.values()) clearTimeout(t);
    this._dialogTimers.clear();
  }

  // -------------------------------------------------------------------- frame

  invalidateFrame(reason) {
    this.dirty = true; // anything that outdates the screenshot also outdates the cached element list
    if (this.frame && !this.frame.stale) this.frame = { ...this.frame, stale: true, staleReason: reason };
  }

  // ------------------------------------------------------------------ observe

  async observe(opts = {}) {
    const ctx = await this.current({ activate: !!opts.screenshot });
    const obs = await ctx.observer.observe(opts);
    this.dirty = false;
    if (obs.screenshot) {
      this.frame = { geometry: obs.screenshot.geometry, hash: obs.screenshot.hash, capturedAt: obs.screenshot.capturedAt, tabId: ctx.tabId, stale: false };
    }
    if (obs.security?.tainted) this.safety.noteFindings(obs.security.findings, true);
    return obs;
  }

  /** Text/AX-only lookup against the newest observation (no screenshot). */
  async elementsSnapshot() {
    const ctx = await this.current();
    return ctx.observer.last?.elements || [];
  }

  async findElements(query, { limit = 8 } = {}) {
    const ctx = await this.current();
    let elements = ctx.observer.last?.elements;
    // Reuse the cached element list only if nothing has changed since it was taken.
    if (!elements || this.dirty || Date.now() - ctx.observer.last.ts > 2500) {
      elements = (await ctx.observer.observe({})).elements;
      this.dirty = false;
    }
    const measured = elements.filter((e) => e.ref);
    for (const e of measured) {
      if (e.rect) {
        const vh = ctx.observer.last?.viewport?.height || 0;
        e.viewportPos = e.rect.y + e.rect.height < 0 ? "above" : e.rect.y > vh ? "below" : "in";
      }
    }
    const found = ax.findElements(measured, query, { limit });
    // Nothing accessible matched well: fall back to any visible text in the DOM (draggables, styled divs).
    if (!found.some((f) => f.score >= 45)) {
      const textHits = await ctx.observer.locateText(query, { limit: 4 });
      if (textHits.length) return [...found, ...textHits].slice(0, limit);
      // Still nothing: last resort, OCR the most recent screenshot (canvas-drawn UI, text baked into an
      // image - content with no DOM node at all for locateText to have found).
      const ocrHits = await ctx.observer.locateOcrText(query, { limit: 4 });
      return [...found, ...ocrHits].slice(0, limit);
    }
    return found;
  }

  // ----------------------------------------------------------- target resolution

  /**
   * Resolve a protocol target into a concrete viewport point.
   * @returns {Promise<{ ok: true, vx:number, vy:number, modelX?:number, modelY?:number, source:'ax'|'vision', element?:object, ref?:string, rect?:object, warnings:string[] } | { ok:false, code:string, message:string, candidates?: any[] }>}
   *   vx/vy are always CSS viewport px, ready for computer.*(…, {space:'viewport'}).
   */
  async resolveTarget(target, { forAction } = {}) {
    if (!target) return { ok: false, code: "no_target", message: "no target" };
    const ctx = await this.current();
    const warnings = [];

    if (target.type === "text") {
      const found = await this.findElements(target.text, { limit: 5 });
      const usable = found.filter((e) => e.score >= 45);
      if (!usable.length) return { ok: false, code: "not_found", message: `No element matches "${target.text}". Try read_page or find_element, or use a screenshot.`, candidates: found.slice(0, 3).map(briefEl) };
      const top = usable[0];
      // Several elements scoring (almost) as well as the best one => the text does not identify a single target.
      // Never guess: hand the candidates (with the context that tells them apart) back to the decision layer.
      const contenders = usable.filter((e) => e.score >= top.score - 8);
      if (contenders.length > 1) {
        return {
          ok: false,
          code: "ambiguous",
          message: `"${target.text}" matches ${contenders.length} elements (${contenders.slice(0, 4).map((e) => `${e.ref}${e.ctx ? ` in "${e.ctx}"` : ""}`).join(", ")}${contenders.length > 4 ? ", …" : ""}). Pick one by ref.`,
          candidates: contenders.slice(0, 6).map(briefEl),
        };
      }
      return this.resolveTarget({ type: "ref", ref: top.ref }, { forAction });
    }

    if (target.type === "ref") {
      const m = await ctx.observer.measureRef(target.ref, { scrollIntoView: true });
      if (!m.ok) return { ok: false, code: m.code, message: m.error };
      const vp = ctx.observer.last?.viewport || (await ctx.cdp.layoutMetrics());
      const r = m.rect;
      // visible intersection (elements taller than the viewport are common)
      const vx0 = Math.max(0, r.x);
      const vy0 = Math.max(0, r.y);
      const vx1 = Math.min(vp.width, r.x + r.width);
      const vy1 = Math.min(vp.height, r.y + r.height);
      if (vx1 - vx0 < 1 || vy1 - vy0 < 1) return { ok: false, code: "offscreen", message: `element ${target.ref} is not within the viewport` };
      const cx = (vx0 + vx1) / 2;
      const cy = (vy0 + vy1) / 2;
      const w = vx1 - vx0;
      const h = vy1 - vy0;
      const candidates = [
        [cx, cy], [vx0 + w * 0.25, cy], [vx0 + w * 0.75, cy], [cx, vy0 + h * 0.25], [cx, vy0 + h * 0.75],
      ];
      let point = null;
      let pointerBlocked = false;
      let blocker = null;
      const canHitTest = !m.sessionId; // OOPIF contents cannot be hit-tested from the top session
      if (!canHitTest) {
        point = { x: cx, y: cy };
        warnings.push("cross-origin frame: click point not hit-tested");
      } else {
        const probe = await ctx.observer.probePoints(m.rec.backendNodeId, candidates, undefined).catch(() => null);
        if (!probe) {
          point = { x: cx, y: cy }; // could not probe (page busy): fall back to the geometric centre
          warnings.push("hit test unavailable");
        } else if (probe.pointerEventsNone) {
          // CSS pointer-events:none: a physical click passes straight through it. Element-level activation works.
          point = { x: cx, y: cy };
          pointerBlocked = true;
          warnings.push("pointer-events:none: a mouse click would pass through; using DOM activation");
        } else if (probe.index >= 0) {
          point = { x: candidates[probe.index][0], y: candidates[probe.index][1] };
        } else {
          blocker = probe.blocker;
        }
      }
      const element = { role: m.rec.role, name: m.rec.name, text: m.rec.name, ref: target.ref };
      if (!point) {
        const desc = blocker;
        return {
          ok: false,
          code: "obscured",
          message: `element ${target.ref} (${m.rec.role} "${m.rec.name}") is covered by another element${desc?.text ? ` ("${desc.text}")` : desc?.tag ? ` (<${desc.tag}>)` : ""}. Close the overlay/dialog first, or scroll.`,
          blockedBy: desc,
          rect: r,
          element,
        };
      }
      // enrich with form context for risk classification
      const info = await ctx.observer.describePoint(point.x, point.y).catch(() => null);
      return { ok: true, vx: point.x, vy: point.y, source: "ax", ref: target.ref, rect: r, pointerBlocked, element: { ...element, ...(info || {}), text: info?.text || m.rec.name }, warnings };
    }

    if (target.type === "coordinate") {
      const f = this.frame;
      if (!f) return { ok: false, code: "no_frame", message: "You have not been shown a screenshot yet, so x/y coordinates are meaningless. Take a screenshot (action: screenshot) or use a ref/text target." };
      if (f.stale) return { ok: false, code: "stale_frame", message: `The screenshot your coordinates refer to is out of date (${f.staleReason || "page changed"}). Take a new screenshot and re-locate the target.` };
      if (f.tabId && f.tabId !== this.targetTabId) return { ok: false, code: "stale_frame", message: "The screenshot was taken on a different tab. Take a new screenshot." };
      let vp;
      try {
        vp = f.geometry.modelToViewport(target.x, target.y);
      } catch (err) {
        return { ok: false, code: "out_of_range", message: err.message };
      }
      // Scroll drift since the screenshot => the point no longer means the same thing.
      const metrics = await ctx.cdp.layoutMetrics();
      if (Math.abs(metrics.scrollY - f.geometry.scroll.y) > 2 || Math.abs(metrics.scrollX - f.geometry.scroll.x) > 2) {
        this.invalidateFrame("page scrolled since the screenshot");
        return { ok: false, code: "stale_frame", message: "The page scrolled since the screenshot was taken. Take a new screenshot and re-locate the target." };
      }
      const info = await ctx.observer.describePoint(vp.x, vp.y).catch(() => null);
      return { ok: true, vx: vp.x, vy: vp.y, modelX: target.x, modelY: target.y, source: "vision", element: info || undefined, warnings };
    }

    return { ok: false, code: "bad_target", message: `unsupported target type ${target.type}` };
  }

  // ----------------------------------------------------- semantic (DOM) fallbacks

  async jsClick(ref) {
    const ctx = await this.current();
    const rec = ctx.refs.get(ref);
    if (!rec) throw new BrowserError(`unknown ref ${ref}`, "unknown_ref");
    const sessionId = rec.frameKey ? ctx.observer._sessionFor(ctx.observer._frameIdForKey(rec.frameKey)) : undefined;
    return ctx.cdp.callOnNode(rec.backendNodeId, "function(){ this.scrollIntoView({block:'center',inline:'center'}); this.click(); return true; }", [], { sessionId });
  }

  async keyboardActivate(ref) {
    const ctx = await this.current();
    const rec = ctx.refs.get(ref);
    if (!rec) throw new BrowserError(`unknown ref ${ref}`, "unknown_ref");
    const sessionId = rec.frameKey ? ctx.observer._sessionFor(ctx.observer._frameIdForKey(rec.frameKey)) : undefined;
    await ctx.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: rec.backendNodeId }, { sessionId }).catch(() => {});
    await ctx.cdp.send("DOM.focus", { backendNodeId: rec.backendNodeId }, { sessionId });
    const key = /checkbox|radio|switch/.test(rec.role) ? "Space" : "Enter";
    await ctx.driver.keyPress(key);
    return { key };
  }

  async focusRef(ref) {
    const ctx = await this.current();
    const rec = ctx.refs.get(ref);
    if (!rec) throw new BrowserError(`unknown ref ${ref}`, "unknown_ref");
    const sessionId = rec.frameKey ? ctx.observer._sessionFor(ctx.observer._frameIdForKey(rec.frameKey)) : undefined;
    await ctx.cdp.send("DOM.focus", { backendNodeId: rec.backendNodeId }, { sessionId });
    return true;
  }

  /** Read a control's current value/state (passwords report length only). */
  async readValue(ref) {
    const ctx = await this.current();
    const rec = ctx.refs.get(ref);
    if (!rec) throw new BrowserError(`unknown ref ${ref}`, "unknown_ref");
    const sessionId = rec.frameKey ? ctx.observer._sessionFor(ctx.observer._frameIdForKey(rec.frameKey)) : undefined;
    return ctx.cdp.callOnNode(
      rec.backendNodeId,
      `function(){ const t = this.type;
        if (t === 'password') return { type: t, valueLength: (this.value||'').length };
        if (this.tagName === 'SELECT') return { type: 'select', value: this.value, text: this.options[this.selectedIndex] ? this.options[this.selectedIndex].text : '' };
        if (t === 'checkbox' || t === 'radio') return { type: t, checked: this.checked };
        if (this.isContentEditable) return { type: 'contenteditable', value: (this.innerText||'').slice(0, 500) };
        return { type: t || this.tagName.toLowerCase(), value: typeof this.value === 'string' ? this.value.slice(0, 500) : undefined, text: (this.innerText||'').slice(0,200) }; }`,
      [],
      { sessionId }
    );
  }

  /** Set a form control's value directly, firing the events frameworks listen to. */
  async formInput(ref, value) {
    const ctx = await this.current();
    const rec = ctx.refs.get(ref);
    if (!rec) throw new BrowserError(`unknown ref ${ref}`, "unknown_ref");
    const sessionId = rec.frameKey ? ctx.observer._sessionFor(ctx.observer._frameIdForKey(rec.frameKey)) : undefined;
    return ctx.cdp.callOnNode(
      rec.backendNodeId,
      `function(v){
        const fire = (el, names) => names.forEach(n => el.dispatchEvent(new Event(n, { bubbles: true })));
        const tag = this.tagName, type = (this.type || '').toLowerCase();
        if (type === 'password') return { ok: false, error: 'password fields are not set by Noah' };
        if (tag === 'SELECT') {
          const want = String(v).toLowerCase();
          let idx = Array.from(this.options).findIndex(o => o.value.toLowerCase() === want);
          if (idx < 0) idx = Array.from(this.options).findIndex(o => o.text.trim().toLowerCase() === want);
          if (idx < 0) idx = Array.from(this.options).findIndex(o => o.text.toLowerCase().includes(want));
          if (idx < 0) return { ok: false, error: 'no option matches ' + JSON.stringify(v), options: Array.from(this.options).slice(0, 12).map(o => o.text.trim()) };
          this.selectedIndex = idx; fire(this, ['input', 'change']);
          return { ok: true, kind: 'select', value: this.value, text: this.options[idx].text.trim() };
        }
        if (type === 'checkbox' || type === 'radio') {
          const want = (v === true || v === 'true' || v === 'on' || v === 1 || v === '1');
          if (this.checked !== want) this.click();
          return { ok: true, kind: type, checked: this.checked };
        }
        if (this.isContentEditable) { this.focus(); this.textContent = String(v); fire(this, ['input']); return { ok: true, kind: 'contenteditable' }; }
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          this.focus(); setter.call(this, String(v)); fire(this, ['input', 'change']);
          return { ok: true, kind: type || 'text', value: this.value.slice(0, 200) };
        }
        return { ok: false, error: 'element is not a form control (' + tag.toLowerCase() + ')' };
      }`,
      [value],
      { sessionId }
    );
  }

  /** Where is keyboard focus right now? (used to keep Noah out of password fields) */
  async focusInfo() {
    const ctx = await this.current();
    return ctx.cdp
      .evaluate(
        `(() => { const a = document.activeElement; if (!a || a === document.body) return { none: true };
          const r = a.getBoundingClientRect();
          return { tag: a.tagName.toLowerCase(), type: a.type || null, isPassword: a.type === 'password' || /^cc-|one-time-code/.test(a.autocomplete || ''),
                   editable: !!a.isContentEditable || a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !/^(button|submit|checkbox|radio|reset|image|file)$/.test(a.type || '')),
                   label: a.getAttribute('aria-label') || a.getAttribute('placeholder') || a.name || a.id || '', rect: { x: r.left, y: r.top, width: r.width, height: r.height } }; })()`
      )
      .catch(() => ({ none: true }));
  }

  // ----------------------------------------------------------------- navigation

  _waitNavigation(wc, start, timeoutMs) {
    return new Promise((resolve) => {
      let started = false;
      let failure = null;
      let done = false;
      const t0 = Date.now();
      const finish = (extra) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        wc.removeListener("did-start-loading", onStart);
        wc.removeListener("did-stop-loading", onStop);
        wc.removeListener("did-fail-load", onFail);
        resolve({ url: wc.isDestroyed() ? "" : wc.getURL(), title: wc.isDestroyed() ? "" : wc.getTitle(), ms: Date.now() - t0, ...(failure ? { failure } : {}), ...extra });
      };
      const onStart = () => {
        started = true;
      };
      const onStop = () => {
        if (started || Date.now() - t0 > 400) setTimeout(() => finish({}), 50);
      };
      const onFail = (_e, code, desc, validatedURL, isMainFrame) => {
        if (!isMainFrame || code === -3) return; // subframe failures and ERR_ABORTED (redirects) are normal
        failure = { code, description: desc, url: validatedURL };
      };
      wc.on("did-start-loading", onStart);
      wc.on("did-stop-loading", onStop);
      wc.on("did-fail-load", onFail);
      const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
      try {
        const p = start();
        if (p && typeof p.catch === "function") p.catch(() => {}); // failures arrive via did-fail-load
      } catch (err) {
        failure = { code: 0, description: err.message };
        finish({});
      }
      // Some navigations (same-document, cached) never emit did-start-loading.
      setTimeout(() => {
        if (!started && !wc.isDestroyed() && !wc.isLoading()) finish({});
      }, 900);
    });
  }

  async navigate(url, { timeoutMs = 20000 } = {}) {
    const policy = this.getConfig().policy || {};
    const check = checkNavigation(url, policy);
    if (!check.allowed) throw new BrowserError(check.reason, "url_blocked", check);
    const ctx = await this.current({ activate: true });
    const wc = ctx.cdp.wc;
    this.invalidateFrame("navigating");
    let res;
    if (check.history) {
      const kind = check.url;
      if (kind === "back" && !wc.canGoBack()) throw new BrowserError("There is no previous page in this tab's history", "no_history");
      if (kind === "forward" && !wc.canGoForward()) throw new BrowserError("There is no next page in this tab's history", "no_history");
      res = await this._waitNavigation(wc, () => (kind === "back" ? wc.goBack() : kind === "forward" ? wc.goForward() : wc.reload()), timeoutMs);
    } else {
      res = await this._waitNavigation(wc, () => wc.loadURL(check.url), timeoutMs);
    }
    return this._afterNavigation(ctx, res, policy);
  }

  async _afterNavigation(ctx, res, policy) {
    const wc = ctx.cdp.wc;
    // Re-check where we actually ended up (redirects can leave the allowed set).
    if (res.url && !/^about:|^file:\/\/.*(error|home)\.html/i.test(res.url)) {
      const after = checkNavigation(res.url, policy);
      if (!after.allowed && !after.history) {
        await wc.loadURL("about:blank").catch(() => {});
        throw new BrowserError(`The navigation redirected to a blocked destination (${after.reason}). Reverted to a blank page.`, "redirect_blocked", after);
      }
    }
    if (res.failure) {
      throw new BrowserError(`Navigation failed: ${res.failure.description || res.failure.code} (${res.failure.url || ""})`, "net_error", res.failure);
    }
    if (/[\\/]error\.html/i.test(res.url || "")) throw new BrowserError("The browser showed its error page for this navigation", "net_error", { url: res.url });
    this.invalidateFrame("navigated");
    return { url: res.url, title: res.title, ms: res.ms, timedOut: !!res.timedOut };
  }

  /** Wait until the target tab has finished loading (bounded). Returns true if it settled. */
  async waitForLoad(timeoutMs = 15000) {
    const ctx = await this.current();
    const wc = ctx.cdp.wc;
    const t0 = Date.now();
    await sleep(200); // a freshly created tab may not have started loading yet
    while (Date.now() - t0 < timeoutMs) {
      this.safety.guard();
      if (!wc.isLoading()) return true;
      await sleep(80);
    }
    return false;
  }

  /**
   * Wait until the page stops changing. Two extra rules make this safe for actions that trigger navigation:
   *  - minWaitMs: never declare "settled" before the browser has had a moment to START a navigation the action
   *    caused (a form submit begins a few ms after the click event, i.e. AFTER the input call has returned);
   *  - a navigation requested/started since the action began is waited out (up to loadTimeoutMs) before
   *    verification runs, so the next observation never describes the page we just left.
   */
  async waitForSettle({ timeoutMs = 1500, quietMs = 90, minWaitMs = 150, loadTimeoutMs = 12000 } = {}) {
    const ctx = await this.current();
    const t0 = Date.now();
    const navSince = t0 - 500;
    let last = null;
    let stableSince = 0;
    while (Date.now() - t0 < timeoutMs) {
      this.safety.guard();
      if (ctx.cdp.dialog) return { settled: true, ms: Date.now() - t0, dialog: true }; // page is frozen until handled
      const fp = await ctx.observer.fingerprint();
      const key = `${fp.url}|${fp.textHash}|${fp.nodes}|${fp.sy}|${fp.loading}|${fp.dialog}`;
      const navPending = ctx.cdp.lastNavAt >= navSince;
      if (fp.loading || (navPending && Date.now() - t0 < loadTimeoutMs && ctx.cdp.wc.isLoading())) {
        // a navigation is in flight: wait for it (its own, longer budget), then require stability again
        const until = Date.now() + Math.max(0, loadTimeoutMs - (Date.now() - t0));
        while (ctx.cdp.wc.isLoading() && Date.now() < until) {
          this.safety.guard();
          await sleep(60);
        }
        await sleep(80);
        stableSince = 0;
        last = null;
        continue;
      }
      if (key === last && Date.now() - t0 >= minWaitMs) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= quietMs) return { settled: true, ms: Date.now() - t0, fingerprint: fp };
      } else if (key !== last) {
        stableSince = 0;
        last = key;
      }
      await sleep(40);
    }
    return { settled: false, ms: Date.now() - t0 };
  }

  // ------------------------------------------------------------------- dialogs

  _onDialog(ctx, d) {
    this.bus.publish("agent_status", { phase: "dialog", text: `Page dialog (${d.type}): ${d.message.slice(0, 80)}` });
    // A dialog blocks the page until handled. If nothing handles it, dismiss safely.
    const timeout = this.getConfig().dialogAutoDismissMs || 20000;
    clearTimeout(this._dialogTimers.get(ctx.wcId));
    this._dialogTimers.set(
      ctx.wcId,
      setTimeout(() => {
        if (ctx.cdp.dialog) ctx.cdp.handleDialog(false).catch(() => {});
      }, timeout)
    );
  }

  async handleDialog(accept, text) {
    const ctx = await this.current();
    if (!ctx.cdp.dialog) throw new BrowserError("No dialog is open", "no_dialog");
    const info = ctx.cdp.dialog;
    await ctx.cdp.handleDialog(accept, text);
    return { handled: true, type: info.type, accepted: !!accept };
  }

  // ---------------------------------------------------------------------- tabs

  async newTab(url) {
    const cfg = this.getConfig();
    const tab = await this.tabs.create(url ? checkNavigation(url, cfg.policy || {}).url || "" : "", { isolated: cfg.sessionMode === "isolated" });
    this.targetTabId = tab.id;
    this.invalidateFrame("new tab");
    return tab;
  }

  // ------------------------------------------------------------------ downloads

  watchSession(ses) {
    if (!ses || this._watchedSessions.has(ses)) return;
    this._watchedSessions.add(ses);
    ses.on("will-download", (_event, item) => {
      const rec = { id: `d${this.downloads.length + 1}`, name: item.getFilename(), url: item.getURL(), state: "started", bytes: item.getTotalBytes(), at: Date.now() };
      this.downloads.push(rec);
      if (this.downloads.length > 50) this.downloads.shift();
      if (this.safety.taskId && isExecutableDownload(rec.name)) {
        rec.state = "blocked";
        item.cancel();
        this.bus.publish("safety", { level: "blocked", decision: "deny", reasons: [`Blocked executable download: ${rec.name}`] });
        return;
      }
      item.on("updated", () => {
        rec.bytes = item.getReceivedBytes();
        rec.state = item.isPaused() ? "paused" : "progressing";
      });
      item.once("done", (_e, state) => {
        rec.state = state;
        rec.path = item.getSavePath();
        this.bus.publish("agent_status", { phase: "download", text: `Download ${state}: ${rec.name}` });
      });
    });
  }

  recentDownloads(sinceTs = 0) {
    return this.downloads.filter((d) => d.at >= sinceTs).map((d) => ({ name: d.name, state: d.state, path: d.path, bytes: d.bytes }));
  }

  // ------------------------------------------------------------------- uploads

  validateUploadPath(p) {
    const cfg = this.getConfig();
    let real;
    try {
      real = fs.realpathSync(path.resolve(String(p)));
    } catch (_) {
      throw new BrowserError(`file not found: ${p}`, "file_not_found");
    }
    const st = fs.statSync(real);
    if (!st.isFile()) throw new BrowserError("upload path is not a regular file", "not_a_file");
    if (st.size > (cfg.maxUploadBytes || 50 * 1024 * 1024)) throw new BrowserError("file is larger than the upload limit", "file_too_large");
    if (SENSITIVE_UPLOAD_PATHS.some((re) => re.test(real))) throw new BrowserError("this file is in a protected location and cannot be uploaded by Noah", "protected_path");
    const userData = cfg.userDataDir ? path.resolve(cfg.userDataDir) : null;
    if (userData && real.toLowerCase().startsWith(userData.toLowerCase())) throw new BrowserError("Jonah's own data directory cannot be uploaded", "protected_path");
    const roots = cfg.uploadRoots || [];
    if (roots.length && !roots.some((r) => real.toLowerCase().startsWith(path.resolve(r).toLowerCase() + path.sep) || real.toLowerCase() === path.resolve(r).toLowerCase())) {
      throw new BrowserError("this file is outside the allowed upload folders", "outside_upload_roots");
    }
    return real;
  }

  async uploadFile(ref, filePath) {
    const real = this.validateUploadPath(filePath);
    const ctx = await this.current();
    const rec = ctx.refs.get(ref);
    if (!rec) throw new BrowserError(`unknown ref ${ref}`, "unknown_ref");
    const sessionId = rec.frameKey ? ctx.observer._sessionFor(ctx.observer._frameIdForKey(rec.frameKey)) : undefined;
    const isFileInput = await ctx.cdp.callOnNode(rec.backendNodeId, "function(){ return this.tagName === 'INPUT' && this.type === 'file'; }", [], { sessionId });
    if (!isFileInput) throw new BrowserError(`${ref} is not a file input. Find the file input (role 'button' next to 'Choose file' / 'Upload') via read_page.`, "not_file_input");
    await ctx.cdp.send("DOM.setFileInputFiles", { files: [real], backendNodeId: rec.backendNodeId }, { sessionId });
    return { uploaded: path.basename(real), bytes: fs.statSync(real).size };
  }

  get userHome() {
    return os.homedir();
  }
}

function briefEl(e) {
  return { ref: e.ref, role: e.role, name: e.name, ctx: e.ctx, score: e.score };
}

module.exports = { BrowserController, BrowserError };
