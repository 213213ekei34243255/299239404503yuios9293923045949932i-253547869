// Rexy/browser.js
//
// browser.js implements NOTHING itself — every real browser capability
// already exists in bridge.js. This file is a controller: it gives the
// rest of Noah (executor.js directly, planner.js indirectly via the
// capability registry) a clean, cached, slightly higher-level API instead
// of talking to bridge.js's raw phase-by-phase methods everywhere.
//
//   Executor -> browser.js -> bridge.js -> renderer.js -> Electron
//
// browser.js also owns the "current known state" cache that observer.js
// keeps warm, so cheap reads (url(), title(), allTabs()...) don't have to
// round-trip into the page every time something just wants to know what
// it already knows.

"use strict";

const { EventEmitter } = require("events");
const Logger = require("./logger.cjs");

// ---------------------------------------------------------------------------
// browser.js
// ---------------------------------------------------------------------------

class Browser extends EventEmitter {
  /**
   * @param {import('./bridge.cjs')} bridge   a bridge.js instance — the only
   *        thing this file is allowed to depend on for real work.
   * @param {object} [options]
   * @param {object} [options.runtime]    optional runtime.js reference,
   *        mostly so helpers can read the active goal for context.
   * @param {object} [options.llm]        optional llm.js client, used by
   *        helpers like summarizePage()/translatePage().
   * @param {object} [options.vision]     optional vision.js instance.
   * @param {object} [options.capabilities] override/extend the derived
   *        capability registry.
   */
  constructor(bridge, options = {}) {
    super();
    if (!bridge) throw new Error("Browser requires a bridge instance");
    this.bridge = bridge;
    this.runtime = options.runtime || null;
    this.llm = options.llm || null;
    this.vision = options.vision || null;
    this.log = new Logger({ scope: "browser", level: options.logLevel || "info" });

    this.ready = false;
    this._unsubscribers = [];

    // ---- 18. Cache -----------------------------------------------------
    this.cache = {
      url: null,
      title: null,
      loading: false,
      tabs: [],
      activeTab: null,
      buttons: [],
      inputs: [],
      links: [],
      images: [],
      downloads: [],
      bookmarks: [],
      history: [],
      updatedAt: null,
    };

    // ---- 17-ish. Capability Registry -----------------------------------
    // Derived from bridge's capabilities so the planner never sees a
    // capability browser.js can't actually back with a working bridge call.
    const bc = bridge.capabilities || {};
    this.capabilities = {
      navigation: Boolean(bc.navigation),
      tabs: Boolean(bc.tabs),
      dom: true, // reading the DOM has no separate bridge flag; always on
      mouse: Boolean(bc.click),
      keyboard: Boolean(bc.type),
      javascript: true,
      downloads: Boolean(bc.download),
      bookmarks: Boolean(bc.bookmarks),
      history: Boolean(bc.history),
      cookies: Boolean(bc.cookies),
      vision: Boolean(bc.vision) || Boolean(this.vision),
      voice: Boolean(bc.voice),
      ...options.capabilities,
    };
  }

  // ===================================================================
  // 1. Initialization
  // ===================================================================

  async initialize() {
    if (this.ready) return;
    this._registerBridgeEvents();
    await this.refreshCache().catch((err) => this.log.warn("Initial cache refresh failed:", err.message));
    this.ready = true;
    this.log.info("browser.js ready");
    this.emit("ready");
  }

  shutdown() {
    for (const off of this._unsubscribers) {
      try {
        off();
      } catch (_) {
        /* ignore */
      }
    }
    this._unsubscribers = [];
    this.ready = false;
    this.emit("shutdown");
  }

  reset() {
    this.cache = { ...this.cache, buttons: [], inputs: [], links: [], images: [], updatedAt: null };
    this.emit("reset");
  }

  isReady() {
    return this.ready;
  }

  // ===================================================================
  // 2. Navigation
  // ===================================================================

  async open(url) {
    const result = await this.bridge.openURL(url);
    await this.refreshCache();
    return result;
  }

  async reload() {
    await this.bridge.reload();
    return this.refreshCache();
  }

  async back() {
    const moved = await this.bridge.goBack();
    if (moved) await this.refreshCache();
    return moved;
  }
  goBack() {
      return this.back();
  }

  async forward() {
    const moved = await this.bridge.goForward();
    if (moved) await this.refreshCache();
    return moved;
  }
  

  goForward() {
      return this.forward();
  }

  stop() {
    return this.bridge.stop();
  }

  waitForLoad(timeoutMs) {
    return this.bridge.waitForLoad(timeoutMs);
  }

  currentURL() {
    return this.cache.url ?? this.bridge.getCurrentURL();
  }

  currentTitle() {
    return this.cache.title ?? this.bridge.getTitle();
  }

  isLoading() {
    return this.cache.loading;
  }

  // ===================================================================
  // 3. Tabs
  // ===================================================================

  async createTab(url) {
    const tab = await this.bridge.createTab(url);
    await this.refreshCache();
    return tab;
  }

  async closeTab(index) {
    const result = await this.bridge.closeTab(index);
    await this.refreshCache();
    return result;
  }

  async switchTab(index) {
    const result = await this.bridge.switchTab(index);
    await this.refreshCache();
    return result;
  }

  async duplicateTab(index) {
    const result = await this.bridge.duplicateTab(index);
    await this.refreshCache();
    return result;
  }

  activeTab() {
    return this.cache.activeTab ?? this.bridge.getActiveTab();
  }

  allTabs() {
    return this.cache.tabs.length ? this.cache.tabs : this.bridge.getTabs();
  }

  tabCount() {
    return this.allTabs().length;
  }

  moveTab(fromIndex, toIndex) {
    return this.bridge.moveTab(fromIndex, toIndex);
  }

  pinTab(index, pinned = true) {
    return this.bridge.pinTab(index, pinned);
  }

  // ===================================================================
  // 4. DOM
  // ===================================================================

  getDOM() {
    return this.bridge.getDOM();
  }

  getHTML() {
    return this.getDOM();
  }
  openURL(url, options = {}) {
    return this.open(url, options);
  }

  pressKey(key, options = {}) {
      return this.press(key, options);
  }

  getHistory() {
      return this.history();
  }

  getBookmarks() {
      return this.bookmarks();
  }

  getCookies(filter) {
      return this.cookies(filter);
  }

  getDownloads() {
      return this.downloads();
  }
  async getButtons() {
    return (this.cache.buttons = await this.bridge.getButtons());
  }

  async getInputs() {
    return (this.cache.inputs = await this.bridge.getInputs());
  }

  getForms() {
    return this.bridge.getForms();
  }

  async getLinks() {
    return (this.cache.links = await this.bridge.getLinks());
  }

  async getImages() {
    return (this.cache.images = await this.bridge.getImages());
  }

  getVideos() {
    return this.bridge.getVideos();
  }

  getTables() {
    return this.bridge.getTables();
  }

  getText() {
    return this.bridge.getPageText();
  }

  /** Returns basic info about the first element matching `selector`, or null. */
  async query(selector) {
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || "").trim().slice(0, 200),
        visible: r.width > 0 && r.height > 0,
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      };
    })();`;
    return this.bridge.execute(script);
  }

  async exists(selector) {
    return (await this.query(selector)) !== null;
  }

  // ===================================================================
  // 5. Mouse
  // ===================================================================

  click(selector) { return this.bridge.click(selector); }
  doubleClick(selector) { return this.bridge.doubleClick(selector); }
  rightClick(selector) { return this.bridge.rightClick(selector); }
  hover(selector) { return this.bridge.hover(selector); }
  scroll(x, y) { return this.bridge.scroll(x, y); }
  scrollTo(selector) { return this.bridge.scrollTo(selector); }
  drag(sourceSelector, targetSelector) { return this.bridge.drag(sourceSelector, targetSelector); }
  drop(targetSelector) { return this.bridge.drop(targetSelector); }

  // ===================================================================
  // 6. Keyboard
  // ===================================================================

  type(selector, text) { return this.bridge.type(selector, text); }
  press(key) { return this.bridge.pressKey(key); }
  hotkey(keys) { return this.bridge.hotkey(keys); }
  copy() { return this.bridge.copy(); }
  paste() { return this.bridge.paste(); }
  selectAll() { return this.bridge.selectAll(); }

  /** Electron's webContents has no dedicated cut() — reuse execute() rather
   * than inventing new Electron-level behavior. */
  cut() {
    return this.bridge.execute(`document.execCommand("cut")`);
  }

  // ===================================================================
  // 7. JavaScript
  // ===================================================================

  execute(js) { return this.bridge.execute(js); }
  inject(js) { return this.bridge.inject(js); }
  evaluate(expression) { return this.bridge.evaluate(expression); }

  // ===================================================================
  // 8. Browser State
  // ===================================================================

  url() { return this.currentURL(); }
  title() { return this.currentTitle(); }
  loading() { return this.isLoading(); }
  zoom() { return this.bridge.getZoom(); }
  windowSize() { return this.bridge.getWindowState(); }
  focused() { return this.bridge.getWindowState().focused; }
  fullscreen() { return this.bridge.getWindowState().fullscreen; }

  // ===================================================================
  // 9. Downloads (reuses bridge's download manager wiring)
  // ===================================================================

  downloads() {
    return this.cache.downloads.length ? this.cache.downloads : this.bridge.getDownloads();
  }

  download(id) {
    return this.downloads().find((d) => d.filename === id || d.id === id) || null;
  }

  pauseDownload(id) {
    if (typeof this.bridge.pauseDownload !== "function") {
      throw new Error("pauseDownload is not implemented in bridge.js yet");
    }
    return this.bridge.pauseDownload(id);
  }

  resumeDownload(id) {
    if (typeof this.bridge.resumeDownload !== "function") {
      throw new Error("resumeDownload is not implemented in bridge.js yet");
    }
    return this.bridge.resumeDownload(id);
  }

  cancelDownload(id) {
    return this.bridge.cancelDownload(id);
  }

  // ===================================================================
  // 10. History
  // ===================================================================

  history() {
    return this.cache.history.length ? this.cache.history : this.bridge.getHistory();
  }

  async searchHistory(query) {
    const entries = await this.history();
    const q = String(query).toLowerCase();
    return entries.filter((entry) => String(entry).toLowerCase().includes(q));
  }

  clearHistory() {
    return this.bridge.clearHistory();
  }

  // ===================================================================
  // 11. Bookmarks
  // ===================================================================

  bookmarks() {
    return this.cache.bookmarks.length ? this.cache.bookmarks : this.bridge.getBookmarks();
  }

  addBookmark(entry) {
    return this.bridge.addBookmark(entry);
  }

  removeBookmark(url) {
    return this.bridge.removeBookmark(url);
  }

  async searchBookmarks(query) {
    const marks = await this.bookmarks();
    const q = String(query).toLowerCase();
    return marks.filter((b) => (b.title || "").toLowerCase().includes(q) || (b.url || "").toLowerCase().includes(q));
  }

  // ===================================================================
  // 12. Cookies
  // ===================================================================

  cookies(filter) { return this.bridge.getCookies(filter); }
  setCookie(details) { return this.bridge.setCookie(details); }
  deleteCookie(details) { return this.bridge.clearCookies(details); }
  clearCookies(filter) { return this.bridge.clearCookies(filter); }

  // ===================================================================
  // 13. Permissions
  // ===================================================================

  permissions() {
    return this.bridge.getPermissions();
  }

  requestPermission(name, details) {
    const store = this.bridge.permissionsStore;
    if (!store || typeof store.grant !== "function") {
      throw new Error("requestPermission requires a permissionsStore with a grant() method wired into bridge.js");
    }
    return store.grant(name, details);
  }

  revokePermission(name) {
    const store = this.bridge.permissionsStore;
    if (!store || typeof store.revoke !== "function") {
      throw new Error("revokePermission requires a permissionsStore with a revoke() method wired into bridge.js");
    }
    return store.revoke(name);
  }

  // ===================================================================
  // 14. AI Panel
  // ===================================================================

  openAI() { return this.bridge.openAI(); }
  closeAI() { return this.bridge.closeAI(); }
  toggleAI() { return this.bridge.toggleAI(); }

  // ===================================================================
  // 15. Trust Panel
  // ===================================================================

  showTrust() { return this.bridge.showTrust(); }
  hideTrust() { return this.bridge.hideTrust(); }
  toggleTrust() { return this.bridge.toggleTrust(); }

  // ===================================================================
  // 16. Vision
  // ===================================================================

  capturePage() { return this.bridge.capturePage(); }
  captureViewport() { return this.bridge.captureViewport(); }
  captureElement(selector) { return this.bridge.captureElement(selector); }

  async OCR(dataUrl) {
    if (!this.vision || typeof this.vision.ocr !== "function") {
      throw new Error("OCR requires a vision.js instance with an ocr() method");
    }
    const image = dataUrl || (await this.capturePage());
    return this.vision.ocr(image);
  }
  async observe() {

      const observation = await this.bridge.observe();

      this.ingestObservation(observation);

      return observation;

  }
  async extract(args = {}) {

      const observation = await this.observe();

      if (args.type === "text") {

          return observation.page?.text || "";

      }

      if (args.type === "links") {

          return observation.page?.links || [];

      }

      if (args.type === "buttons") {

          return observation.page?.buttons || [];

      }

      if (args.type === "inputs") {

          return observation.page?.inputs || [];

      }

      return observation;

  }

  // ===================================================================
  // 17. High-Level Helpers
  //
  // These compose the lower-level calls above into one step so the
  // planner can request "searchYouTube('Interstellar')" instead of
  // reasoning through open -> type -> pressKey -> click across three
  // separate loop iterations.
  // ===================================================================

  async searchGoogle(query) {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await this.open(url);
    return { url, query };
  }

  async searchYouTube(query) {
    await this.open("https://www.youtube.com");
    await this.waitForLoad().catch(() => {});
    const inputs = await this.getInputs();
    const searchBox = inputs.find((i) => /search/i.test(i.name) || /search/i.test(i.placeholder)) || inputs[0];
    if (!searchBox) throw new Error("searchYouTube: could not find a search box");
    await this.type(searchBox.selector, query);
    await this.press("enter");
    return { query };
  }

  async findText(text) {
    const pageText = (await this.getText()) || "";
    const index = pageText.toLowerCase().indexOf(String(text).toLowerCase());
    return { found: index !== -1, index };
  }

  /** Clicks the first visible button or link whose text matches (case-insensitive substring). */
  async clickText(text) {
    const needle = String(text).toLowerCase();
    const [buttons, links] = await Promise.all([this.getButtons(), this.getLinks()]);
    const candidate = [...buttons, ...links].find(
      (el) => el.visible !== false && (el.text || "").toLowerCase().includes(needle)
    );
    if (!candidate) throw new Error(`clickText: no visible element found matching "${text}"`);
    return this.click(candidate.selector);
  }

  /** data: { selectorOrFieldName: value } */
  async fillForm(data) {
    const inputs = await this.getInputs();
    const results = [];
    for (const [key, value] of Object.entries(data || {})) {
      const field =
        inputs.find((i) => i.selector === key) ||
        inputs.find((i) => i.name === key) ||
        inputs.find((i) => (i.placeholder || "").toLowerCase() === key.toLowerCase());
      if (!field) {
        results.push({ key, ok: false, reason: "field not found" });
        continue;
      }
      await this.type(field.selector, String(value));
      results.push({ key, ok: true, selector: field.selector });
    }
    return results;
  }

  /**
   * Best-effort generic login using common field-name heuristics. Real
   * sites vary enough that this is a starting point, not a guarantee —
   * planner.js should fall back to explicit click/type steps if this
   * fails to find the right fields.
   */
  async login({ username, password, submitText = "Log in" } = {}) {
    const inputs = await this.getInputs();
    const userField = inputs.find((i) => /user|email|login/i.test(i.name + i.placeholder));
    const passField = inputs.find((i) => i.type === "password");
    if (!userField || !passField) {
      throw new Error("login: could not identify username/password fields on this page");
    }
    await this.type(userField.selector, username);
    await this.type(passField.selector, password);
    try {
      await this.clickText(submitText);
    } catch (_) {
      await this.press("enter");
    }
    return { userField: userField.selector, passField: passField.selector };
  }

  async summarizePage() {
    if (!this.llm) throw new Error("summarizePage requires an llm client");
    const text = await this.getText();
    const response = await this.llm.raw(
      `Summarize the following page content in 3-5 sentences:\n\n${text.slice(0, 6000)}`
    );
    return response;
  }

  /** Rough article extraction: full page text, callers can refine further. */
  async extractArticle() {
    const [title, text] = await Promise.all([this.currentTitle(), this.getText()]);
    return { title, text };
  }

  /** Snapshots title/url/text-excerpt for every open tab, restoring the original active tab. */
  async compareTabs() {
    const tabs = this.allTabs();
    const originalActive = this.activeTab();
    const snapshots = [];
    for (let i = 0; i < tabs.length; i++) {
      await this.switchTab(i).catch(() => {});
      snapshots.push({
        index: i,
        url: this.currentURL(),
        title: this.currentTitle(),
        excerpt: (await this.getText().catch(() => "")).slice(0, 500),
      });
    }
    if (originalActive?.id !== undefined) {
      await this.switchTab(tabs.findIndex((t) => t.id === originalActive.id)).catch(() => {});
    }
    return snapshots;
  }

  async translatePage(targetLanguage = "English") {
    if (!this.llm) throw new Error("translatePage requires an llm client");
    const text = await this.getText();
    return this.llm.raw(`Translate the following page content to ${targetLanguage}:\n\n${text.slice(0, 6000)}`);
  }

  async readPage() {
    const [url, title, text] = await Promise.all([this.currentURL(), this.currentTitle(), this.getText()]);
    return { url, title, text };
  }

  async downloadFile(selector) {
    await this.click(selector);
    // Actual transfer progress arrives asynchronously via the 'download'
    // event / downloads() — this only triggers it.
    return { triggered: true, selector };
  }

  async watchVideo(query) {
    await this.searchYouTube(query);
    await this.waitForLoad().catch(() => {});
    const links = await this.getLinks();
    const video = links.find((l) => /\/watch\?v=/.test(l.href));
    if (!video) throw new Error("watchVideo: no video results found");
    return this.click(video.selector);
  }

  /** Generic "search a site and play the first result" helper; no specific
   * music service is assumed — pass a base search URL if you have one. */
  async playMusic(query, { searchUrl } = {}) {
    if (searchUrl) {
      await this.open(`${searchUrl}${encodeURIComponent(query)}`);
    } else {
      await this.searchYouTube(query);
    }
    await this.waitForLoad().catch(() => {});
    return this.clickText(query).catch(() => this.watchVideo(query));
  }

  // ===================================================================
  // 18. Cache
  // ===================================================================

  /**
   * Pulls a fresh snapshot via bridge.observe() and repopulates the
   * cache. Called on init and after any action that changes navigation
   * state; observer.js should also call ingestObservation() continuously
   * so the cache stays warm between explicit refreshes.
   */
  async refreshCache() {
    const snapshot = await this.bridge.observe();
    this._applySnapshot(snapshot);
    return this.cache;
  }

  /** Called by observer.js after each observation cycle. */
  ingestObservation(observation) {
    this._applySnapshot(observation);
  }

  _applySnapshot(snapshot = {}) {
    const browser = snapshot.browser || {};
    const page = snapshot.page || {};
    this.cache = {
      ...this.cache,
      url: browser.url ?? this.cache.url,
      title: browser.title ?? this.cache.title,
      loading: browser.loading ?? this.cache.loading,
      tabs: snapshot.tabs ?? this.cache.tabs,
      activeTab: (snapshot.tabs || []).find((t) => t.active) ?? this.cache.activeTab,
      buttons: page.buttons ?? this.cache.buttons,
      inputs: page.inputs ?? this.cache.inputs,
      links: page.links ?? this.cache.links,
      images: page.images ?? this.cache.images,
      downloads: snapshot.downloads ?? this.cache.downloads,
      bookmarks: snapshot.bookmarks ?? this.cache.bookmarks,
      history: snapshot.history ?? this.cache.history,
      updatedAt: Date.now(),
    };
    this.emit("cache-updated", this.cache);
  }

  // ===================================================================
  // 19. Events — re-emitted from bridge's lower-level events under
  // browser.js's own naming, so runtime/observer can subscribe here
  // instead of reaching past this layer into bridge directly.
  // ===================================================================

  onLoad(cb) { this.on("load", cb); return () => this.off("load", cb); }
  onNavigate(cb) { this.on("navigate", cb); return () => this.off("navigate", cb); }
  onTabCreated(cb) { this.on("tab-created", cb); return () => this.off("tab-created", cb); }
  onTabClosed(cb) { this.on("tab-closed", cb); return () => this.off("tab-closed", cb); }
  onDownload(cb) { this.on("download", cb); return () => this.off("download", cb); }
  onTitleChanged(cb) { this.on("title-changed", cb); return () => this.off("title-changed", cb); }
  onPopup(cb) { this.on("popup", cb); return () => this.off("popup", cb); }
  onPermission(cb) { this.on("permission", cb); return () => this.off("permission", cb); }
  onCrash(cb) { this.on("crash", cb); return () => this.off("crash", cb); }
  onError(cb) { this.on("error", cb); return () => this.off("error", cb); }

  _registerBridgeEvents() {
    const forward = (bridgeEvent, browserEvent) => {
      const handler = (payload) => this.emit(browserEvent, payload);
      this.bridge.on(bridgeEvent, handler);
      this._unsubscribers.push(() => this.bridge.off(bridgeEvent, handler));
    };

    forward("navigate", "navigate");
    forward("page-loaded", "load");
    forward("title-change", "title-changed");
    forward("tab-created", "tab-created");
    forward("tab-closed", "tab-closed");
    forward("download", "download");
    forward("popup", "popup");
    forward("permission", "permission");
    // bridge.js doesn't currently emit "crashed" itself (that's wired at
    // the webContents level in observer.js); forward it too if present
    // so browser.js has one consistent place to listen either way.
    forward("crashed", "crash");

    // Keep the cheap parts of the cache fresh in near-real-time without
    // waiting for the next full observe() cycle.
    const onNavigate = ({ url }) => {
      this.cache.url = url;
      this.cache.updatedAt = Date.now();
    };
    const onTitle = ({ title }) => {
      this.cache.title = title;
      this.cache.updatedAt = Date.now();
    };
    const onDownload = (entry) => {
      const idx = this.cache.downloads.findIndex((d) => d.filename === entry.filename);
      if (idx === -1) this.cache.downloads.push(entry);
      else this.cache.downloads[idx] = entry;
    };
    this.on("navigate", onNavigate);
    this.on("title-changed", onTitle);
    this.on("download", onDownload);
    this._unsubscribers.push(() => this.off("navigate", onNavigate));
    this._unsubscribers.push(() => this.off("title-changed", onTitle));
    this._unsubscribers.push(() => this.off("download", onDownload));
  }
}

module.exports = Browser;