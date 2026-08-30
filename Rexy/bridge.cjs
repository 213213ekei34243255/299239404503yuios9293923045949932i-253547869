// Rexy/bridge.js
//
// Bridge is the ONLY module that touches Electron. Every other module —
// runtime, planner, observer, executor — talks to the browser exclusively
// through this API surface. Nothing above this layer knows Electron
// exists.
//
//            Noah
//   runtime / planner / observer / executor
//                  │
//              bridge.js   <-- you are here
//                  │
//   ─────────────────────────────────────
//   renderer.js / preload.cjs / main.js / webview / Electron
//
// The same design should hold for any future capability connector
// (Unreal, Unity, a filesystem, a second browser engine, etc.): the agent
// talks to a capability layer with a stable API, never to the underlying
// application's internals directly.

"use strict";

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { EventEmitter } = require("events");
const { session: electronSession, ipcMain, clipboard } = require("electron");

const Logger = require("./logger.cjs");

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".rexy");
const BOOKMARKS_PATH = path.join(DEFAULT_DATA_DIR, "bookmarks.json");
const HISTORY_PATH = path.join(DEFAULT_DATA_DIR, "history.json");
const MAX_HISTORY = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Key name -> Electron keyCode mapping for the subset actually needed by
// an agent driving forms/pages. Extend as needed.
const KEY_MAP = {
  enter: "Return",
  return: "Return",
  tab: "Tab",
  esc: "Escape",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  space: "Space",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};
// ---------------------------------------------------------------------------
// Chrome-UI exclusion — the browser's own titlebar/tab-bar/topbar controls
// live in the same DOM as page content (index.html hosts both), so every
// query that feeds the planner must exclude them. Otherwise the LLM sees
// "close-btn"/"min-btn"/tab controls as valid click/type targets and can
// try to interact with the application chrome instead of the webpage.
// ---------------------------------------------------------------------------

const CHROME_UI_SELECTORS = [
  ".titlebar",
  ".tab-bar",
  ".topbar",
  ".window-controls",
  "#aiPanel",
  ".ai-panel",
];

function chromeExclusionExpr(varName = "el") {
  const selectors = JSON.stringify(CHROME_UI_SELECTORS);
  return `!${varName}.closest(${selectors}.join(","))`;
}

// ---------------------------------------------------------------------------
// Small in-page snippets used by the DOM / mouse / keyboard phases.
// These run inside the observed page, not in Node.
// ---------------------------------------------------------------------------

function rectScript(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    return { x: r.left, y: r.top, width: r.width, height: r.height, visible, enabled: !el.disabled };
  })();`;
}

function focusScript(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  })();`;
}

function queryListScript(selector, mapExpr, limit, { excludeChrome = true } = {}) {
  const filterStep = excludeChrome
    ? `.filter((el) => ${chromeExclusionExpr("el")})`
    : "";
  return `(() => Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
    ${filterStep}
    .slice(0, ${limit})
    .map((el) => (${mapExpr})))();`;
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

class Bridge extends EventEmitter {
  /**
   * @param {import('electron').BrowserWindow} mainWindow
   * @param {object} [options]
   * @param {object} [options.tabManager]      { getTabs, getActive, create, close, switchTo, ... }
   * @param {object} [options.permissionsStore] { shouldGrant(permission, details), getGrantedPermissions() }
   * @param {object} [options.memory]           memory.js instance, for the AI phase
   * @param {object} [options.llm]              llm.js instance, for the AI phase
   * @param {boolean} [options.allowPopups]
   */
  constructor(mainWindow, options = {}) {
    super();
    this.window = mainWindow;
    this.tabManager = options.tabManager || null;
    this.permissionsStore = options.permissionsStore || null;
    this.memory = options.memory || null;
    this.llm = options.llm || null;
    this.allowPopups = options.allowPopups ?? false;

    this.log = new Logger({ scope: "bridge", level: options.logLevel || "info" });

    this._downloads = new Map();
    this._hooks = {
      beforeAction: [],
      afterAction: [],
      beforeNavigate: [],
      afterNavigate: [],
      beforeExecute: [],
      afterExecute: [],
    };

    // Phase 17 — Capability Registry. The planner reads this before
    // generating a plan so it never proposes an action the bridge can't
    // actually perform.
    this.capabilities = {
      navigation: true,
      tabs: Boolean(this.tabManager),
      click: true,
      type: true,
      scroll: true,
      drag: true,
      download: true,
      upload: false, // wire up once a file-picker path exists
      cookies: true,
      localStorage: true,
      history: true,
      bookmarks: true,
      vision: false, // flipped on by whoever constructs vision.js
      voice: false, // flipped on by whoever constructs voice.js
      ...options.capabilities,
    };

    this._registerNativeListeners();
    this._registerIPC();
  }

  hasCapability(name) {
    return Boolean(this.capabilities[name]);
  }

  // ===================================================================
  // Phase 18 — Runtime hooks
  // ===================================================================

  beforeAction(fn) { this._hooks.beforeAction.push(fn); }
  afterAction(fn) { this._hooks.afterAction.push(fn); }
  beforeNavigate(fn) { this._hooks.beforeNavigate.push(fn); }
  afterNavigate(fn) { this._hooks.afterNavigate.push(fn); }
  beforeExecute(fn) { this._hooks.beforeExecute.push(fn); }
  afterExecute(fn) { this._hooks.afterExecute.push(fn); }

  async _runHooks(name, ctx) {
    for (const fn of this._hooks[name] || []) {
      try {
        await fn(ctx);
      } catch (err) {
        this.log.warn(`Hook "${name}" threw:`, err.message);
      }
    }
  }

  // ===================================================================
  // Internals
  // ===================================================================

  _wc() {

    if (!this.window || this.window.isDestroyed()) {
      throw new Error("Browser window unavailable");
    }

    const win = this.window;

    // Methods that return a plain, structured-cloneable value (or a
    // Promise of one) — proxied generically by calling the same method
    // name on the active webview inside the renderer, then shipping the
    // result back across the executeJavaScript boundary.
    const PROXY_METHODS = [
      "isLoading", "canGoBack", "canGoForward", "stop", "reload",
      "goBack", "goForward", "getZoomFactor", "setZoomFactor",
      "copy", "paste", "selectAll", "insertText", "sendInputEvent",
      "isAudioMuted", "setAudioMuted", "isCurrentlyAudible",
    ];

    const callOnWebview = async (method, args = []) => {
      const script = `
        (async () => {
          const w = window.RexyRenderer.webview();
          if (!w) throw new Error("No active webview");
          const result = w.${method}(${args.map((a) => JSON.stringify(a)).join(",")});
          return (result && typeof result.then === "function") ? await result : result;
        })();
      `;
      return win.webContents.executeJavaScript(script);
    };

    const proxy = {

      executeJavaScript: async (script) => {
        const encodedScript = JSON.stringify(script);
        return await win.webContents.executeJavaScript(`
          (async () => {
            const w = window.RexyRenderer.webview();
            if (!w) throw new Error("No active webview");
            return await w.executeJavaScript(${encodedScript});
          })();
        `);
      },

      loadURL: async (url) => {
        return win.webContents.executeJavaScript(`
          (async () => {
            if (window.RexyRenderer && typeof window.RexyRenderer.navigate === "function") {
              await window.RexyRenderer.navigate(${JSON.stringify(url)});
              return true;
            }
            // Fallback for older renderer builds without RexyRenderer.navigate
            window.dispatchEvent(new CustomEvent("rexy-legacy-navigate", { detail: ${JSON.stringify(url)} }));
            return true;
          })();
        `);
      },

      getURL: () => {
        return win.webContents.executeJavaScript(`
          (()=>{ const w=window.RexyRenderer.webview(); return w ? w.getURL() : ""; })();
        `);
      },

      getTitle: () => {
        return win.webContents.executeJavaScript(`
          (()=>{ const w=window.RexyRenderer.webview(); return w ? w.getTitle() : ""; })();
        `);
      },

      // capturePage returns a NativeImage in real Electron, which can't
      // cross the executeJavaScript boundary — convert to a data URL
      // string inside the renderer instead, then wrap it back in a
      // minimal object with a toDataURL() so callers (bridge.capturePage)
      // don't need to change.
      capturePage: async (rect) => {
        const dataUrl = await win.webContents.executeJavaScript(`
          (async () => {
            const w = window.RexyRenderer.webview();
            if (!w) throw new Error("No active webview");
            const img = await w.capturePage(${rect ? JSON.stringify(rect) : ""});
            return img.toDataURL();
          })();
        `);
        return { toDataURL: () => dataUrl };
      },

      // webview tag has no direct .session accessor from the renderer;
      // fall back to the window's default session for cookie ops.
      get session() {
        return electronSession.defaultSession;
      },

      navigationHistory: undefined,

    };

    for (const method of PROXY_METHODS) {
      proxy[method] = (...args) => callOnWebview(method, args);
    }

    return proxy;

  }

  async _exec(script, ctx = {}) {
    await this._runHooks("beforeExecute", { script, ...ctx });
    try {
      const result = await this._wc().executeJavaScript(script, true);
      await this._runHooks("afterExecute", { script, result, ...ctx });
      return result;
    } catch (err) {
      await this._runHooks("afterExecute", { script, error: err, ...ctx });
      throw err;
    }
  }

  async _rectOf(selector) {
    if (this._isChromeSelector(selector)) {
      throw new Error(`Refusing to target browser chrome element: ${selector}`);
    }
    return this._exec(rectScript(selector), { action: "rect", selector });
  }

  /** Heuristic guard: blocks obviously chrome-scoped selectors before they
   * ever reach the page, as a second line of defense behind the DOM-query
   * filtering in queryListScript(). */
  _isChromeSelector(selector) {
    if (typeof selector !== "string") return false;
    const s = selector.toLowerCase();
    return (
      s.includes(".titlebar") ||
      s.includes(".tab-bar") ||
      s.includes(".topbar") ||
      s.includes(".window-controls") ||
      s.includes("close-btn") ||
      s.includes("min-btn") ||
      s.includes("max-btn") ||
      s.includes("#aipanel") ||
      s.includes(".ai-panel")
    );
  }

  // ===================================================================
  // Phase 1 — Browser Navigation
  // ===================================================================

  async openURL(url, { waitUntilLoaded = true, timeoutMs = 30000 } = {}) {

      const wc = this._wc();

      await this._runHooks("beforeNavigate", { url });

      if (waitUntilLoaded) {

          try {

              // Race against a generous timeout — real completion now comes
              // from RexyRenderer.navigate()'s did-stop-loading/did-fail-load
              // listeners, not from polling isLoading(), so this is reliable.
              await Promise.race([
                  wc.loadURL(url),
                  new Promise((_, reject) =>
                      setTimeout(() => reject(new Error(`navigation timed out after ${timeoutMs}ms`)), timeoutMs)
                  ),
              ]);

          } catch (err) {

              // A slow/streaming page or a genuine did-fail-load still
              // shouldn't hard-fail the whole action — the URL dispatch
              // itself succeeded, which is the part that matters for the
              // agent's next observation.
              this.log.warn(`Navigation to ${url} did not confirm cleanly: ${err.message} — proceeding anyway`);

          }

      } else {

          wc.loadURL(url).catch((err) => {
              this.log.warn(`Fire-and-forget navigation to ${url} failed: ${err.message}`);
          });

      }

      try {
          await this._recordHistory(url);
      } catch (err) {
          this.log.warn(`_recordHistory failed for ${url}: ${err.message}`);
      }

      try {
          await this._runHooks("afterNavigate", { url });
      } catch (err) {
          this.log.warn(`afterNavigate hooks failed for ${url}: ${err.message}`);
      }

      try {
          return await this.getCurrentURL();
      } catch (err) {
          this.log.warn(`getCurrentURL failed after navigating to ${url}: ${err.message} — returning requested url instead`);
          return url;
      }

  }

  reload() {

      this.window.webContents.send("rexy:reload");

  }

  stop() {
    this._wc().stop();
  }

  async goBack() {

      this.window.webContents.send("rexy:back");

      return true;

  }

  async goForward() {

      this.window.webContents.send("rexy:forward");

      return true;

  }

  getCurrentURL() {
    return this._wc().getURL();
  }

  getTitle() {
    return this._wc().getTitle();
  }

  async getLoadingState() {
    const wc = this._wc();
    const [loading, canGoBack, canGoForward] = await Promise.all([
      wc.isLoading(),
      wc.canGoBack(),
      wc.canGoForward(),
    ]);
    return { loading, canGoBack, canGoForward };
  }

  async waitForLoad(timeoutMs = 30_000, pollMs = 150) {
    const wc = this._wc();
    const start = Date.now();

    // Give navigation a brief moment to actually start before we check,
    // otherwise a same-tick check can read the pre-navigation "not
    // loading" state and return immediately.
    await sleep(Math.min(pollMs, 150));

    while (Date.now() - start < timeoutMs) {
      let loading;
      try {
        loading = await wc.isLoading();
      } catch (err) {
        // If the webview isn't ready yet / errored, keep polling until
        // timeout rather than failing the whole navigation immediately.
        loading = true;
      }
      if (!loading) return true;
      await sleep(pollMs);
    }

    throw new Error(`waitForLoad timed out after ${timeoutMs}ms`);
  }
  // ===================================================================
  // Phase 2 — Tab Management (delegates to an injected tabManager;
  // falls back to single-tab semantics if none was provided)
  // ===================================================================

  async createTab(url) {
    if (!this.tabManager) {
      this.log.warn("createTab called without a tabManager; opening in place instead");
      return this.openURL(url);
    }
    const tab = await this.tabManager.create(url);
    this.emit("tab-created", tab);
    return tab;
  }

  async closeTab(index) {
    if (!this.tabManager) throw new Error("Tabs are not supported without a tabManager");
    const closed = await this.tabManager.close(index);
    this.emit("tab-closed", { index });
    return closed;
  }

  async switchTab(index) {
    if (!this.tabManager) throw new Error("Tabs are not supported without a tabManager");
    return this.tabManager.switchTo(index);
  }

  getActiveTab() {
    if (!this.tabManager) return { id: 0, url: this.getCurrentURL(), title: this.getTitle(), active: true };
    return this.tabManager.getActive();
  }

  getTabs() {
    if (!this.tabManager) return [this.getActiveTab()];
    return this.tabManager.getTabs();
  }

  async duplicateTab() {
    if (!this.tabManager) throw new Error("Tabs are not supported without a tabManager");
    return this.tabManager.duplicate(this.getActiveTab().id);
  }

  async moveTab(fromIndex, toIndex) {
    if (!this.tabManager) throw new Error("Tabs are not supported without a tabManager");
    return this.tabManager.move(fromIndex, toIndex);
  }

  async pinTab(index, pinned = true) {
    if (!this.tabManager) throw new Error("Tabs are not supported without a tabManager");
    return this.tabManager.pin(index, pinned);
  }

  // ===================================================================
  // Phase 3 — DOM Observation
  // ===================================================================

  async getDOM() {
    return this._exec(`document.documentElement.outerHTML.slice(0, 200000)`);
  }

  async getPageText() {
    return this._exec(`(document.body ? document.body.innerText : "").slice(0, 20000)`);
  }

  async getButtons() {
    return this._exec(
      queryListScript(
        "button, [role='button'], input[type='submit'], input[type='button']",
        `{ text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0,200),
           selector: el.id ? '#'+CSS.escape(el.id) : el.tagName.toLowerCase(),
           visible: el.offsetParent !== null,
           enabled: !el.disabled }`,
        200
      )
    );
  }

  async getInputs() {
    return this._exec(
      queryListScript(
        "input, textarea, select",
        `{ type: el.type || el.tagName.toLowerCase(),
           placeholder: el.getAttribute('placeholder') || '',
           name: el.getAttribute('name') || '',
           selector: el.id ? '#'+CSS.escape(el.id) : el.tagName.toLowerCase(),
           enabled: !el.disabled }`,
        200
      )
    );
  }

  async getForms() {
    return this._exec(
      queryListScript(
        "form",
        `{ action: el.action || '', method: (el.method||'get').toUpperCase(),
           selector: el.id ? '#'+CSS.escape(el.id) : 'form',
           fieldCount: el.querySelectorAll('input,textarea,select').length }`,
        50
      )
    );
  }

  async getLinks() {
    return this._exec(
      queryListScript(
        "a[href]",
        `{ text: (el.innerText||'').trim().slice(0,200), href: el.href,
           selector: el.id ? '#'+CSS.escape(el.id) : 'a' }`,
        300
      )
    );
  }

  async getImages() {
    return this._exec(
      queryListScript("img", `{ alt: el.alt||'', src: el.src }`, 100)
    );
  }

  async getVideos() {
    return this._exec(
      queryListScript(
        "video",
        `{ src: el.currentSrc||el.src||'', playing: !el.paused, duration: isFinite(el.duration)?el.duration:null }`,
        20
      )
    );
  }

  async getTables() {
    return this._exec(
      queryListScript(
        "table",
        `{ rows: el.rows?el.rows.length:0, headers: Array.from(el.querySelectorAll('th')).slice(0,20).map(th=>th.innerText.trim()) }`,
        20
      )
    );
  }

  async getSelection() {
    return this._exec(`window.getSelection ? window.getSelection().toString() : ""`);
  }

  // ===================================================================
  // Phase 4 — Mouse
  // ===================================================================

  async click(selector, { button = "left", clickCount = 1 } = {}) {
    await this._runHooks("beforeAction", { action: "click", selector });
    const rect = await this._rectOf(selector);
    if (!rect || !rect.visible) throw new Error(`click: element not visible: ${selector}`);
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    const wc = this._wc();
    wc.sendInputEvent({ type: "mouseMove", x, y });
    wc.sendInputEvent({ type: "mouseDown", x, y, button, clickCount });
    wc.sendInputEvent({ type: "mouseUp", x, y, button, clickCount });
    await this._runHooks("afterAction", { action: "click", selector, x, y });
    return { x, y };
  }

  async doubleClick(selector) {
    return this.click(selector, { clickCount: 2 });
  }

  async rightClick(selector) {
    return this.click(selector, { button: "right" });
  }

  async hover(selector) {
    const rect = await this._rectOf(selector);
    if (!rect) throw new Error(`hover: element not found: ${selector}`);
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    this._wc().sendInputEvent({ type: "mouseMove", x, y });
    return { x, y };
  }

  async drag(sourceSelector, targetSelector, { steps = 10 } = {}) {
    const src = await this._rectOf(sourceSelector);
    const dst = await this._rectOf(targetSelector);
    if (!src || !dst) throw new Error("drag: source or target element not found");
    const wc = this._wc();
    const sx = src.x + src.width / 2;
    const sy = src.y + src.height / 2;
    const dx = dst.x + dst.width / 2;
    const dy = dst.y + dst.height / 2;

    wc.sendInputEvent({ type: "mouseMove", x: sx, y: sy });
    wc.sendInputEvent({ type: "mouseDown", x: sx, y: sy, button: "left" });
    for (let i = 1; i <= steps; i++) {
      const x = sx + ((dx - sx) * i) / steps;
      const y = sy + ((dy - sy) * i) / steps;
      wc.sendInputEvent({ type: "mouseMove", x, y });
      await sleep(10);
    }
    wc.sendInputEvent({ type: "mouseUp", x: dx, y: dy, button: "left" });
    return { from: { x: sx, y: sy }, to: { x: dx, y: dy } };
  }

  /** Alias kept for API symmetry with drag(); drop is implied by drag()'s mouseUp. */
  async drop(targetSelector) {
    const rect = await this._rectOf(targetSelector);
    if (!rect) throw new Error(`drop: target not found: ${targetSelector}`);
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    this._wc().sendInputEvent({ type: "mouseUp", x, y, button: "left" });
    return { x, y };
  }

  async scroll(deltaX = 0, deltaY = 0) {
    return this._exec(`window.scrollBy(${Number(deltaX)}, ${Number(deltaY)})`);
  }

  async scrollTo(target) {
    if (typeof target === "string") {
      return this._exec(
        `(() => { const el = document.querySelector(${JSON.stringify(target)});
          if (el) el.scrollIntoView({ block: "center", behavior: "instant" }); return !!el; })();`
      );
    }
    const { x = 0, y = 0 } = target || {};
    return this._exec(`window.scrollTo(${Number(x)}, ${Number(y)})`);
  }

  async focus(selector) {
    if (this._isChromeSelector(selector)) {
      throw new Error(`Refusing to target browser chrome element: ${selector}`);
    }
    const ok = await this._exec(focusScript(selector));
    if (!ok) throw new Error(`focus: element not found: ${selector}`);
    return true;
  }

  // ===================================================================
  // Phase 5 — Keyboard
  // ===================================================================

  async type(selector, text, { delayMs = 0 } = {}) {
    await this._runHooks("beforeAction", { action: "type", selector });
    await this.focus(selector);
    const wc = this._wc();
    if (delayMs > 0) {
      for (const ch of String(text)) {
        wc.insertText(ch);
        await sleep(delayMs);
      }
    } else {
      wc.insertText(String(text));
    }
    await this._runHooks("afterAction", { action: "type", selector, text });
    return true;
  }

  async pressKey(key, { modifiers = [] } = {}) {
    const keyCode = KEY_MAP[String(key).toLowerCase()] || key;
    const wc = this._wc();
    wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    return true;
  }

  async hotkey(keys = []) {
    // e.g. hotkey(['control', 'a'])
    const modifiers = keys.slice(0, -1).map((k) => k.toLowerCase());
    const mainKey = keys[keys.length - 1];
    return this.pressKey(mainKey, { modifiers });
  }

  copy() {
    this._wc().copy();
  }

  paste() {
    this._wc().paste();
  }

  selectAll() {
    this._wc().selectAll();
  }

  // ===================================================================
  // Phase 6 — JavaScript
  // ===================================================================

  async execute(js) {
    return this._exec(js);
  }

  async inject(script) {
    return this._exec(script);
  }

  async evaluate(expression) {
    return this._exec(`(${expression})`);
  }

  // ===================================================================
  // Phase 7 — Browser State
  // ===================================================================

  async getHistory() {
    return this._readJsonSafe(HISTORY_PATH, []);
  }

  async clearHistory() {
    await this._writeJsonSafe(HISTORY_PATH, []);
  }

  async getBookmarks() {
    return this._readJsonSafe(BOOKMARKS_PATH, []);
  }

  async addBookmark(entry) {
    const bookmarks = await this.getBookmarks();
    const item = { url: entry.url, title: entry.title || entry.url, addedAt: Date.now() };
    bookmarks.push(item);
    await this._writeJsonSafe(BOOKMARKS_PATH, bookmarks);
    return item;
  }

  async removeBookmark(url) {
    const bookmarks = await this.getBookmarks();
    const filtered = bookmarks.filter((b) => b.url !== url);
    await this._writeJsonSafe(BOOKMARKS_PATH, filtered);
    return filtered.length !== bookmarks.length;
  }

  getDownloads() {
    return Array.from(this._downloads.values());
  }

  cancelDownload(filename) {
    const entry = this._downloads.get(filename);
    if (entry?._item) {
      entry._item.cancel();
      return true;
    }
    return false;
  }

  // ===================================================================
  // Phase 8 — Storage
  // ===================================================================

  async getCookies(filter = {}) {
    const ses = this._wc().session || electronSession.defaultSession;
    return ses.cookies.get(filter);
  }

  async setCookie(details) {
    const ses = this._wc().session || electronSession.defaultSession;
    return ses.cookies.set(details);
  }

  async clearCookies(filter = {}) {
    const ses = this._wc().session || electronSession.defaultSession;
    const cookies = await ses.cookies.get(filter);
    await Promise.all(
      cookies.map((c) =>
        ses.cookies.remove(`http${c.secure ? "s" : ""}://${c.domain.replace(/^\./, "")}${c.path}`, c.name)
      )
    );
    return cookies.length;
  }

  async getLocalStorage(key) {
    if (key) return this._exec(`localStorage.getItem(${JSON.stringify(key)})`);
    return this._exec(`({...localStorage})`);
  }

  async setLocalStorage(key, value) {
    return this._exec(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(String(value))})`);
  }

  async getSessionStorage(key) {
    if (key) return this._exec(`sessionStorage.getItem(${JSON.stringify(key)})`);
    return this._exec(`({...sessionStorage})`);
  }

  // ===================================================================
  // Phase 9 — Browser Information
  // ===================================================================

  getWindowState() {
    const win = this.window;
    if (!win || win.isDestroyed()) return {};
    const bounds = win.getBounds();
    return { width: bounds.width, height: bounds.height, fullscreen: win.isFullScreen(), focused: win.isFocused() };
  }

  getZoom() {
    return this._wc().getZoomFactor();
  }

  setZoom(factor) {
    this._wc().setZoomFactor(factor);
    return factor;
  }

  async getPermissions() {
    if (this.permissionsStore?.getGrantedPermissions) {
      return this.permissionsStore.getGrantedPermissions();
    }
    return { camera: false, microphone: false, location: false, clipboard: false, notifications: false };
  }

  getAudio() {
    const wc = this._wc();
    return {
      playing: typeof wc.isCurrentlyAudible === "function" ? wc.isCurrentlyAudible() : false,
      muted: typeof wc.isAudioMuted === "function" ? wc.isAudioMuted() : false,
    };
  }

  async getNetwork() {
    return this._exec(
      `({ online: navigator.onLine,
          effectiveType: navigator.connection ? navigator.connection.effectiveType : null,
          downlink: navigator.connection ? navigator.connection.downlink : null })`
    );
  }

  // ===================================================================
  // Phase 10 — Vision (screenshot capture; recognition happens in vision.js)
  // ===================================================================

  async capturePage() {
    const image = await this._wc().capturePage();
    return image.toDataURL();
  }

  async captureViewport() {
    return this.capturePage();
  }

  async captureElement(selector) {
    const rect = await this._rectOf(selector);
    if (!rect) throw new Error(`captureElement: not found: ${selector}`);
    const image = await this._wc().capturePage({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    return image.toDataURL();
  }

  /** Delegates to vision.js if one was wired in via options; otherwise raw capture. */
  async readScreenshot(vision) {
    const dataUrl = await this.capturePage();
    if (vision && typeof vision.analyze === "function") {
      return vision.analyze(dataUrl);
    }
    return { screenshot: dataUrl };
  }

  // ===================================================================
  // Phase 11 — AI
  // ===================================================================

  async sendPrompt(prompt, opts = {}) {
    if (!this.llm) throw new Error("No llm client wired into bridge");
    return this.llm.raw(prompt, opts);
  }

  readConversation() {
    return this.memory?.getLLMContext?.().conversation || [];
  }

  getMemory() {
    return this.memory?.export?.() || null;
  }

  getGoal() {
    return this.memory?.getGoal?.() || null;
  }

  // ===================================================================
  // Phase 12 — Trust Panel (UI already exists; bridge just exposes it)
  // ===================================================================

  showTrust() {
    this._sendToRenderer("trust:show");
  }

  hideTrust() {
    this._sendToRenderer("trust:hide");
  }

  toggleTrust() {
    this._sendToRenderer("trust:toggle");
  }

  // ===================================================================
  // Phase 13 — AI Panel
  // ===================================================================

  openAI() {
    this._sendToRenderer("ai-panel:open");
  }

  closeAI() {
    this._sendToRenderer("ai-panel:close");
  }

  toggleAI() {
    this._sendToRenderer("ai-panel:toggle");
  }

  _sendToRenderer(channel, payload) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, payload);
    }
  }

  // ===================================================================
  // Phase 14 — Browser Events (subscribe API; wired to native events below)
  // ===================================================================

  onNavigate(cb) { this.on("navigate", cb); return () => this.off("navigate", cb); }
  onPageLoaded(cb) { this.on("page-loaded", cb); return () => this.off("page-loaded", cb); }
  onTitleChange(cb) { this.on("title-change", cb); return () => this.off("title-change", cb); }
  onTabCreated(cb) { this.on("tab-created", cb); return () => this.off("tab-created", cb); }
  onTabClosed(cb) { this.on("tab-closed", cb); return () => this.off("tab-closed", cb); }
  onDownload(cb) { this.on("download", cb); return () => this.off("download", cb); }
  onPermission(cb) { this.on("permission", cb); return () => this.off("permission", cb); }
  onPopup(cb) { this.on("popup", cb); return () => this.off("popup", cb); }

  // ===================================================================
  // Phase 15 — Observer API (the only bridge surface observer.js should use)
  // ===================================================================

  async observe() {
    const [browser, page, downloads, history, bookmarks, permissions] = await Promise.all([
      this._observeBrowserSummary(),
      this._observePageSummary(),
      Promise.resolve(this.getDownloads()),
      this.getHistory(),
      this.getBookmarks(),
      this.getPermissions(),
    ]);
    return {
      browser,
      tabs: this.getTabs(),
      page,
      downloads,
      history,
      bookmarks,
      permissions,
    };
  }

  async _observeBrowserSummary() {
    const loading = await this.getLoadingState();
    return {
      url: await this.getCurrentURL(),
      title: await this.getTitle(),
      ...loading,
      ...(await this.getAudio()),
      zoomFactor: await this.getZoom(),
      ...this.getWindowState(),
    };
  }

  async _observePageSummary() {
    const [buttons, inputs, links, forms, images, videos, tables, text, selectedText] = await Promise.all([
      this.getButtons(),
      this.getInputs(),
      this.getLinks(),
      this.getForms(),
      this.getImages(),
      this.getVideos(),
      this.getTables(),
      this.getPageText(),
      this.getSelection(),
    ]);
    return { buttons, inputs, links, forms, images, videos, tables, text, selectedText };
  }

  // ===================================================================
  // Native Electron wiring (private)
  // ===================================================================

  _registerNativeListeners() {
    const wc = this.window?.webContents;
    if (!wc) return;

    wc.on("did-navigate", (_e, url) => {
      this._recordHistory(url);
      this.emit("navigate", { url });
    });
    wc.on("did-navigate-in-page", (_e, url) => this.emit("navigate", { url, inPage: true }));
    wc.on("did-finish-load", () => this.emit("page-loaded", { url: this.getCurrentURL() }));
    wc.on("page-title-updated", (_e, title) => this.emit("title-change", { title }));

    wc.setWindowOpenHandler(({ url }) => {
      this.emit("popup", { url });
      return { action: this.allowPopups ? "allow" : "deny" };
    });

    const ses = wc.session || electronSession.defaultSession;

    ses.on("will-download", (_event, item) => {
      const entry = { filename: item.getFilename(), progress: 0, completed: false, _item: item };
      this._downloads.set(entry.filename, entry);
      this.emit("download", { ...entry, _item: undefined });

      item.on("updated", (_e, state) => {
        const total = item.getTotalBytes();
        const received = item.getReceivedBytes();
        entry.progress = total > 0 ? Math.round((received / total) * 100) : 0;
        entry.state = state;
        this.emit("download", { ...entry, _item: undefined });
      });
      item.once("done", (_e, state) => {
        entry.completed = state === "completed";
        entry.state = state;
        this.emit("download", { ...entry, _item: undefined });
      });
    });

    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      this.emit("permission", { permission, details });
      if (this.permissionsStore?.shouldGrant) {
        Promise.resolve(this.permissionsStore.shouldGrant(permission, details))
          .then((granted) => callback(Boolean(granted)))
          .catch(() => callback(false));
      } else {
        callback(false); // deny by default without an explicit policy
      }
    });
  }

  _registerIPC() {
    // Renderer-initiated actions (e.g. user clicks something in the AI
    // panel) can be funneled back through the same hook/event pipeline.
    ipcMain.on("rexy:renderer-event", (_event, { channel, payload }) => {
      this.emit(channel, payload);
    });
  }

  // ===================================================================
  // History persistence helpers
  // ===================================================================

  async _recordHistory(url) {
    if (!url) return;
    const history = await this.getHistory();
    if (history[history.length - 1] === url) return;
    history.push(url);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    await this._writeJsonSafe(HISTORY_PATH, history);
  }

  async _readJsonSafe(filePath, fallback) {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw);
    } catch (err) {
      if (err.code !== "ENOENT") this.log.debug(`Failed reading ${filePath}: ${err.message}`);
      return fallback;
    }
  }

  async _writeJsonSafe(filePath, data) {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      this.log.warn(`Failed writing ${filePath}: ${err.message}`);
    }
  }
}

module.exports = Bridge;