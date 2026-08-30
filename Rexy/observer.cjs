// Rexy/observer.js
"use strict";

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { EventEmitter } = require("events");
const { session, webContents: electronWebContents, ipcMain } = require("electron");

const Logger = require("./logger.cjs");

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".rexy");
const DEFAULT_BOOKMARKS_PATH = path.join(DEFAULT_DATA_DIR, "bookmarks.json");
const DEFAULT_HISTORY_PATH = path.join(DEFAULT_DATA_DIR, "history.json");

const DOM_CHANGE_DEBOUNCE_MS = 250;
const IDLE_FALLBACK_MS = 4000;

const EXTRACTION_SCRIPT = `(() => {
  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      style.opacity !== "0"
    );
  }

  function selectorFor(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.name) return el.tagName.toLowerCase() + "[name='" + el.name.replace(/'/g, "\\\\'") + "']";
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.className && typeof node.className === "string") {
        const cls = node.className.trim().split(/\\s+/).slice(0, 2).join(".");
        if (cls) part += "." + cls;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) {
          part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
        }
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function textOf(el) {
    return (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 200);
  }

  const buttons = Array.from(document.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button']"))
    .slice(0, 200)
    .map((el) => ({
      text: textOf(el),
      selector: selectorFor(el),
      visible: visible(el),
      enabled: !el.disabled,
    }));

  const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
    .slice(0, 200)
    .map((el) => ({
      type: el.type || el.tagName.toLowerCase(),
      placeholder: el.getAttribute("placeholder") || "",
      name: el.getAttribute("name") || "",
      selector: selectorFor(el),
      visible: visible(el),
      enabled: !el.disabled,
      value: el.type === "password" ? undefined : (el.value || "").slice(0, 200),
    }));

  const links = Array.from(document.querySelectorAll("a[href]"))
    .slice(0, 300)
    .map((el) => ({
      text: textOf(el),
      href: el.href,
      selector: selectorFor(el),
      visible: visible(el),
    }));

  const forms = Array.from(document.querySelectorAll("form"))
    .slice(0, 50)
    .map((form) => ({
      action: form.action || "",
      method: (form.method || "get").toUpperCase(),
      selector: selectorFor(form),
      fields: Array.from(form.querySelectorAll("input, textarea, select")).map((el) => ({
        type: el.type || el.tagName.toLowerCase(),
        name: el.getAttribute("name") || "",
        selector: selectorFor(el),
      })),
    }));

  const images = Array.from(document.querySelectorAll("img"))
    .slice(0, 100)
    .map((el) => ({
      alt: el.alt || "",
      src: el.src,
      selector: selectorFor(el),
      visible: visible(el),
    }));

  const videos = Array.from(document.querySelectorAll("video"))
    .slice(0, 20)
    .map((el) => ({
      src: el.currentSrc || el.src || "",
      selector: selectorFor(el),
      playing: !el.paused,
      duration: isFinite(el.duration) ? el.duration : null,
    }));

  const tables = Array.from(document.querySelectorAll("table"))
    .slice(0, 20)
    .map((el) => ({
      selector: selectorFor(el),
      rows: el.rows ? el.rows.length : 0,
      headers: Array.from(el.querySelectorAll("th")).slice(0, 20).map((th) => textOf(th)),
    }));

  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .slice(0, 40)
    .map((el) => ({ level: el.tagName, text: textOf(el) }));

  const accessibility = Array.from(document.querySelectorAll("[role], [aria-label]"))
    .slice(0, 150)
    .map((el) => ({
      role: el.getAttribute("role") || null,
      label: el.getAttribute("aria-label") || null,
      selector: selectorFor(el),
    }));

  const selection = window.getSelection ? window.getSelection().toString() : "";

  return {
    title: document.title,
    text: (document.body ? document.body.innerText : "").slice(0, 20000),
    selectedText: selection,
    buttons,
    inputs,
    links,
    forms,
    images,
    videos,
    tables,
    headings,
    accessibility,
    scrollY: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight,
  };
})();`;

const MUTATION_WATCH_SCRIPT = `(() => {
  if (window.__rexyObserverInstalled) return;
  window.__rexyObserverInstalled = true;

  let timer = null;
  const notify = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (window.rexy && typeof window.rexy.notifyDomChange === "function") {
        window.rexy.notifyDomChange();
      }
    }, ${DOM_CHANGE_DEBOUNCE_MS});
  };

  const mo = new MutationObserver(notify);
  mo.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: false,
  });

  window.addEventListener("scroll", notify, { passive: true });
})();`;

class Observer extends EventEmitter {
  constructor(mainWindow, options = {}) {
    super();
    this.window = mainWindow;
    this.tabManager = options.tabManager || null;
    this.downloadManager = options.downloadManager || null;
    this.permissionsStore = options.permissionsStore || null;

    this.dataDir = options.dataDir || DEFAULT_DATA_DIR;
    this.bookmarksPath = options.bookmarksPath || DEFAULT_BOOKMARKS_PATH;
    this.historyJsonPath = options.historyPath || DEFAULT_HISTORY_PATH;

    this.log = new Logger({ scope: "observer", level: options.logLevel || "info" });

    this._downloads = new Map();
    this._lastSnapshotHash = null;
    this._idleTimer = null;

    this._guestWebContents = null;

    this.log.info("Observer constructed — starting webview tracking");
    this._registerNativeListeners();
    this._registerWebviewTracking();
    this._registerIPC();
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  async observe({ vision } = {}) {
    const wc = this._activeWebContents();
    if (!wc || wc.isDestroyed()) {
      throw new Error("No active webContents to observe");
    }

    this.log.info(`observe() using webContents id=${wc.id}, type=${wc.getType ? wc.getType() : "unknown"}, url=${wc.getURL()}`);

    const [browser, windowState, page, downloads, bookmarks, history, cookies, permissions] =
      await Promise.all([
        this._observeBrowser(wc),
        this._observeWindow(),
        this._observePage(wc),
        this._observeDownloads(),
        this._observeBookmarks(),
        this._observeHistory(),
        this._observeCookies(wc),
        this._observePermissions(),
      ]);

    const tabs = this._observeTabs(wc);

    let visionSnapshot = null;
    if (vision && typeof vision.observe === "function") {
      try {
        visionSnapshot = await vision.observe();
      } catch (err) {
        this.log.warn("Vision capture failed", err.message);
      }
    }

    const snapshot = {
      url: browser.url,
      browser: { ...browser, ...windowState },
      tabs,
      page,
      downloads,
      bookmarks,
      history,
      cookies,
      permissions,
      vision: visionSnapshot || undefined,
    };

    this._lastSnapshotHash = this._hash(snapshot);
    this.emit("observed", snapshot);
    return snapshot;
  }

  waitForChange(maxWaitMs = IDLE_FALLBACK_MS) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (reason) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off("dirty", onDirty);
        resolve(reason);
      };
      const onDirty = (reason) => finish(reason);
      const timer = setTimeout(() => finish("idle-timeout"), maxWaitMs);
      this.once("dirty", onDirty);
    });
  }

  async reattach() {
    const wc = this._activeWebContents();
    if (!wc) throw new Error("No webContents available to reattach to");
    if (wc.isLoading()) {
      await new Promise((resolve) => wc.once("did-stop-loading", resolve));
    }
    await this._injectMutationWatcher(wc);
    this.log.info("Reattached observer to webContents");
  }

  // -------------------------------------------------------------------
  // Webview tracking
  // -------------------------------------------------------------------

  _registerWebviewTracking() {
    const wc = this.window?.webContents;
    if (!wc) {
      this.log.warn("No mainWindow.webContents available to track webviews on");
      return;
    }

    wc.on("did-attach-webview", (_event, guestWebContents) => {
      this.log.info(`✅ did-attach-webview EVENT fired — guest id=${guestWebContents.id}`);
      this._adoptGuest(guestWebContents);
    });

    // did-attach-webview can fire before this listener exists (a
    // <webview src="..."> declared directly in index.html's initial HTML
    // attaches almost immediately — likely before Observer is even
    // constructed, since Observer is only created inside did-finish-load).
    // Poll electron's global webContents registry as a fallback so we
    // find it either way.
    this.log.info("Starting poll for already-attached guest webview...");
    this._pollForGuest();
  }

  _adoptGuest(guestWebContents) {
    if (this._guestWebContents === guestWebContents) return;
    this._guestWebContents = guestWebContents;
    this.log.info(`👉 Observer now tracking guest webContents id=${guestWebContents.id}, url=${guestWebContents.getURL()}`);

    guestWebContents.on("destroyed", () => {
      if (this._guestWebContents === guestWebContents) {
        this.log.warn("Tracked guest webContents was destroyed");
        this._guestWebContents = null;
        this._pollForGuest();
      }
    });

    guestWebContents.on("did-navigate", (_e, url) => {
      this.log.info(`Guest navigated: ${url}`);
      this._scheduleDirty("navigate");
    });
    guestWebContents.on("did-navigate-in-page", () => this._scheduleDirty("navigate-in-page"));
    guestWebContents.on("did-stop-loading", () => this._scheduleDirty("loading-stop"));
    guestWebContents.on("page-title-updated", () => this._scheduleDirty("title"));
    guestWebContents.on("dom-ready", () => {
      this._injectMutationWatcher(guestWebContents);
      this._scheduleDirty("dom-ready");
    });
  }

  _pollForGuest(attempt = 0) {
    if (this._guestWebContents) return;

    try {
      const all = electronWebContents.getAllWebContents();
      this.log.info(`Poll attempt ${attempt}: found ${all.length} total webContents — types: [${all.map((c) => { try { return c.getType(); } catch (_) { return "?"; } }).join(", ")}]`);

      const guest = all.find((c) => {
        try {
          return c.getType && c.getType() === "webview" && !c.isDestroyed();
        } catch (_) {
          return false;
        }
      });

      if (guest) {
        this.log.info(`✅ Found guest webview via polling (attempt ${attempt}), id=${guest.id}, url=${guest.getURL()}`);
        this._adoptGuest(guest);
        return;
      }
    } catch (err) {
      this.log.warn("Poll for guest webview threw:", err.message);
    }

    if (attempt < 40) {
      setTimeout(() => this._pollForGuest(attempt + 1), 250);
    } else {
      this.log.warn("❌ Gave up polling for a guest webview after 10s — observe() will use the host window");
    }
  }

  // -------------------------------------------------------------------
  // Browser / window state
  // -------------------------------------------------------------------

  async _observeBrowser(wc) {
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
      canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
      audioPlaying: typeof wc.isCurrentlyAudible === "function" ? wc.isCurrentlyAudible() : false,
      muted: typeof wc.isAudioMuted === "function" ? wc.isAudioMuted() : false,
      zoomFactor: wc.getZoomFactor ? wc.getZoomFactor() : 1,
      activeTab: this._activeTabId(),
    };
  }

  async _observeWindow() {
    const win = this.window;
    if (!win || win.isDestroyed()) return {};
    const bounds = win.getBounds();
    return {
      windowWidth: bounds.width,
      windowHeight: bounds.height,
      fullscreen: win.isFullScreen(),
      focused: win.isFocused(),
    };
  }

  _observeTabs(activeWc) {
    if (this.tabManager && typeof this.tabManager.getTabs === "function") {
      return this.tabManager.getTabs().map((t) => ({
        id: t.id,
        title: t.title ?? t.webContents?.getTitle?.() ?? "",
        url: t.url ?? t.webContents?.getURL?.() ?? "",
        active: t.active ?? t.webContents === activeWc,
      }));
    }
    return [
      {
        id: this._activeTabId(),
        title: activeWc.getTitle(),
        url: activeWc.getURL(),
        active: true,
      },
    ];
  }

  _activeTabId() {
    if (this.tabManager && typeof this.tabManager.getActive === "function") {
      return this.tabManager.getActive()?.id ?? null;
    }
    return 0;
  }

  _activeWebContents() {
    if (this.tabManager && typeof this.tabManager.getActive === "function") {
      const tabWc = this.tabManager.getActive()?.webContents;
      if (tabWc) return tabWc;
    }

    if (this._guestWebContents && !this._guestWebContents.isDestroyed()) {
      return this._guestWebContents;
    }

    return this.window?.webContents;
  }

  // -------------------------------------------------------------------
  // Page (DOM) state
  // -------------------------------------------------------------------

  async _observePage(wc) {
    try {
      const result = await wc.executeJavaScript(EXTRACTION_SCRIPT, true);
      return {
        buttons: result.buttons,
        inputs: result.inputs,
        links: result.links,
        forms: result.forms,
        images: result.images,
        videos: result.videos,
        tables: result.tables,
        headings: result.headings,
        accessibility: result.accessibility,
        selectedText: result.selectedText,
        pageText: result.text,
        scrollY: result.scrollY,
        scrollHeight: result.scrollHeight,
      };
    } catch (err) {
      this.log.warn("DOM extraction failed:", err.message);
      return {
        buttons: [],
        inputs: [],
        links: [],
        forms: [],
        images: [],
        videos: [],
        tables: [],
        headings: [],
        accessibility: [],
        selectedText: "",
        pageText: "",
      };
    }
  }

  async _injectMutationWatcher(wc) {
    try {
      await wc.executeJavaScript(MUTATION_WATCH_SCRIPT, true);
    } catch (err) {
      this.log.debug("Mutation watcher injection skipped:", err.message);
    }
  }

  // -------------------------------------------------------------------
  // Downloads
  // -------------------------------------------------------------------

  async _observeDownloads() {
    if (this.downloadManager && typeof this.downloadManager.list === "function") {
      return this.downloadManager.list();
    }
    return Array.from(this._downloads.values());
  }

  // -------------------------------------------------------------------
  // Bookmarks / history
  // -------------------------------------------------------------------

  async _observeBookmarks() {
    return this._readJsonSafe(this.bookmarksPath, []);
  }

  async _observeHistory() {
    return this._readJsonSafe(this.historyJsonPath, []);
  }

  async _readJsonSafe(filePath, fallback) {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw);
    } catch (err) {
      if (err.code !== "ENOENT") {
        this.log.debug(`Failed reading ${filePath}: ${err.message}`);
      }
      return fallback;
    }
  }

  // -------------------------------------------------------------------
  // Cookies
  // -------------------------------------------------------------------

  async _observeCookies(wc) {
    try {
      const ses = wc.session || session.defaultSession;
      const cookies = await ses.cookies.get({});
      const domains = new Set(cookies.map((c) => c.domain));
      return { count: cookies.length, domains: Array.from(domains).slice(0, 50) };
    } catch (err) {
      this.log.debug("Cookie read failed:", err.message);
      return { count: 0, domains: [] };
    }
  }

  async getCookiesForDomain(wc, domain) {
    const ses = wc.session || session.defaultSession;
    return ses.cookies.get({ domain });
  }

  // -------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------

  async _observePermissions() {
    if (this.permissionsStore && typeof this.permissionsStore.getGrantedPermissions === "function") {
      return this.permissionsStore.getGrantedPermissions();
    }
    return { camera: false, microphone: false, location: false, clipboard: false, notifications: false };
  }

  // -------------------------------------------------------------------
  // Change-driven observation wiring
  // -------------------------------------------------------------------

  _registerNativeListeners() {
    const wc = this.window?.webContents;
    if (!wc) return;

    wc.on("dom-ready", () => {
      this._scheduleDirty("host-dom-ready");
    });

    if (wc.session) {
      wc.session.on("will-download", (_event, item) => {
        const entry = { filename: item.getFilename(), progress: 0, completed: false };
        this._downloads.set(entry.filename, entry);
        this._scheduleDirty("download-start");

        item.on("updated", (_e, state) => {
          const total = item.getTotalBytes();
          const received = item.getReceivedBytes();
          entry.progress = total > 0 ? Math.round((received / total) * 100) : 0;
          entry.state = state;
          this._scheduleDirty("download-progress");
        });
        item.once("done", (_e, state) => {
          entry.completed = state === "completed";
          entry.state = state;
          this._scheduleDirty("download-done");
        });
      });
    }

    this.on("dirty", () => {
      clearTimeout(this._idleTimer);
    });
  }

  _registerIPC() {
    ipcMain.on("rexy:dom-changed", (event) => {
      if (this._guestWebContents && event.sender === this._guestWebContents) {
        this._scheduleDirty("dom-mutation");
        return;
      }
      const wc = this.window?.webContents;
      if (wc && event.sender === wc) {
        this._scheduleDirty("dom-mutation");
      }
    });
  }

  _scheduleDirty(reason) {
    clearTimeout(this._dirtyTimer);
    this._dirtyTimer = setTimeout(() => {
      this.emit("dirty", reason);
    }, 50);
  }

  // -------------------------------------------------------------------
  // internal
  // -------------------------------------------------------------------

  _hash(snapshot) {
    const s = JSON.stringify({
      url: snapshot.url,
      title: snapshot.browser?.title,
      buttons: snapshot.page?.buttons?.length,
      inputs: snapshot.page?.inputs?.length,
      links: snapshot.page?.links?.length,
      text: snapshot.page?.pageText?.length,
    });
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = (hash * 31 + s.charCodeAt(i)) | 0;
    }
    return hash;
  }
}

module.exports = Observer;