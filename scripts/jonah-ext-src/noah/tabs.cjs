// Noah/browser/tabs.cjs - Jonah on Chromium version (replaces the Electron file in the bundle).
//
// Same TabRegistry interface as Electron Jonah (list/active/get/guest/switchTo/create/close/find/...), built on the browser's
// real tabs (chrome.tabs) instead of the Electron window's <webview> list. guest(id) returns a "webContents" made from
// chrome.debugger (the Chrome DevTools Protocol, the same protocol Electron's webContents.debugger speaks) and chrome.tabs.
// While Noah works in a tab, Chromium shows its own "Jonah started debugging this browser" bar: that is intended and stays visible.

"use strict";

const { EventEmitter } = require("events");

function tokens(s) {
  return String(s || "").toLowerCase().replace(/https?:\/\/(www\.)?/g, "").split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
}
const FILLER = new Set(["the", "tab", "where", "had", "have", "open", "opened", "with", "my", "that", "page", "window", "go", "back", "to", "switch", "site", "website", "on", "in", "of", "a", "an", "i"]);

// ------------------------------------------------------------------ webContents made from chrome.debugger + chrome.tabs
const contents = new Map(); // tabId -> TabContents

class TabDebugger extends EventEmitter {
  constructor(tabId) { super(); this.tabId = tabId; this._attached = false; this._attaching = null; }
  isAttached() { return this._attached; }
  attach() {
    if (this._attached || this._attaching) return;
    this._attaching = chrome.debugger.attach({ tabId: this.tabId }, "1.3").then(() => { this._attached = true; }).finally(() => { this._attaching = null; });
  }
  async ready() {
    if (this._attached) return;
    if (!this._attaching) this.attach();
    await this._attaching;
  }
  detach() { if (this._attached) chrome.debugger.detach({ tabId: this.tabId }).catch(() => {}); this._attached = false; }
  async sendCommand(method, params = {}, sessionId) {
    await this.ready();
    const target = sessionId ? { tabId: this.tabId, sessionId } : { tabId: this.tabId };
    return chrome.debugger.sendCommand(target, method, params);
  }
}

class TabContents extends EventEmitter {
  constructor(tab) {
    super();
    this.id = tab.id;
    this._tab = tab;
    this._destroyed = false;
    this._zoom = 1;
    this.debugger = new TabDebugger(tab.id);
  }
  _update(tab) {
    const before = this._tab;
    this._tab = { ...before, ...tab };
    if (tab.status === "loading" && before.status !== "loading") { this.emit("did-start-loading"); this.emit("did-start-navigation", {}, this._tab.url, false, true); }
    if (tab.url && tab.url !== before.url) this.emit("did-navigate", {}, tab.url);
    if (tab.title && tab.title !== before.title) this.emit("page-title-updated", {}, tab.title);
    if (tab.status === "complete" && before.status !== "complete") { this.emit("dom-ready"); this.emit("did-finish-load"); this.emit("did-stop-loading"); }
  }
  isDestroyed() { return this._destroyed; }
  isLoading() { return this._tab.status === "loading"; }
  getURL() { return this._tab.url || this._tab.pendingUrl || ""; }
  getTitle() { return this._tab.title || ""; }
  getZoomFactor() { return this._zoom; }
  canGoBack() { return true; }
  canGoForward() { return true; }
  async loadURL(url) {
    await chrome.tabs.update(this.id, { url: String(url) });
    await new Promise((resolve) => {
      const done = () => { this.removeListener("did-stop-loading", done); resolve(); };
      this.on("did-stop-loading", done);
      setTimeout(done, 30000);
    });
  }
  reload() { chrome.tabs.reload(this.id).catch(() => {}); }
  goBack() { chrome.tabs.goBack(this.id).catch(() => {}); }
  goForward() { chrome.tabs.goForward(this.id).catch(() => {}); }
  async executeJavaScript(code, userGesture = false) {
    const r = await this.debugger.sendCommand("Runtime.evaluate", { expression: String(code), awaitPromise: true, returnByValue: true, userGesture: !!userGesture });
    if (r && r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || "script error");
    return r && r.result ? r.result.value : undefined;
  }
  async capturePage() {
    // Noah's in-page overlay is left out of the picture, as Electron's layer over the <webview> was (see noah/screenshot.cjs)
    const layer = (v) => this.debugger.sendCommand("Runtime.evaluate", { expression: `(() => { const h = document.querySelector('jonah-noah-layer'); if (!h) return 0; ${v ? "h.style.setProperty('visibility', 'hidden', 'important')" : "h.style.removeProperty('visibility')"}; return 1; })()`, returnByValue: true }).catch(() => null);
    const hid = await layer(true);
    let shot;
    try { shot = await this.debugger.sendCommand("Page.captureScreenshot", { format: "png" }); }
    finally { if (hid && hid.result && hid.result.value === 1) layer(false); }
    const data = shot.data;
    return { toPNG: () => Buffer.from(data, "base64"), toDataURL: () => "data:image/png;base64," + data, isEmpty: () => !data };
  }
  _destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.debugger.detach();
    this.emit("destroyed");
    contents.delete(this.id);
  }
}

function contentsFor(tab) {
  let c = contents.get(tab.id);
  if (!c) { c = new TabContents(tab); contents.set(tab.id, c); chrome.tabs.getZoom(tab.id).then((z) => { c._zoom = z || 1; }).catch(() => {}); }
  return c;
}
chrome.tabs.onUpdated.addListener((tabId, _change, tab) => { const c = contents.get(tabId); if (c) c._update(tab); });
chrome.tabs.onRemoved.addListener((tabId) => { const c = contents.get(tabId); if (c) c._destroy(); });
chrome.tabs.onZoomChange.addListener((z) => { const c = contents.get(z.tabId); if (c) c._zoom = z.newZoomFactor || 1; });
chrome.debugger.onEvent.addListener((source, method, params) => {
  const c = contents.get(source.tabId);
  if (c) c.debugger.emit("message", {}, method, params || {}, source.sessionId);
});
chrome.debugger.onDetach.addListener((source, reason) => {
  const c = contents.get(source.tabId);
  if (c) { c.debugger._attached = false; c.debugger.emit("detach", {}, reason); }
});

// ------------------------------------------------------------------ the registry (same interface as Electron Jonah's)
class TabRegistry extends EventEmitter {
  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    this._tabs = [];
    this._at = 0;
    this._owned = new Set();
    this._lastActive = new Map();
    this._closed = [];
    this.noahSwitching = 0;
    this._lastActiveId = null;
  }

  async _windowId() {
    const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    return w && w.id;
  }

  async refresh() {
    let raw = [];
    try {
      const windowId = await this._windowId();
      raw = await chrome.tabs.query(windowId != null ? { windowId } : { lastFocusedWindow: true });
    } catch (err) {
      this.log("tab refresh failed:", err.message);
    }
    const tabs = raw.map((t) => {
      contentsFor(t)._update(t);
      return {
        id: `t${t.id}`, wcId: t.id, index: t.index, title: t.title || "", url: t.url || t.pendingUrl || "",
        active: !!t.active, loading: t.status === "loading", ownedByNoah: this._owned.has(t.id), partition: undefined,
        lastActiveAt: this._lastActive.get(t.id) || 0,
      };
    });
    const active = tabs.find((t) => t.active);
    if (active) {
      this._lastActive.set(active.wcId, Date.now());
      if (this._lastActiveId !== null && this._lastActiveId !== active.id) this.emit("active_changed", { from: this._lastActiveId, to: active.id, byNoah: this.noahSwitching > 0 });
      this._lastActiveId = active.id;
    }
    for (const old of this._tabs) {
      if (!tabs.some((t) => t.id === old.id)) {
        this._closed.unshift({ title: old.title, url: old.url, closedAt: Date.now() });
        this._closed = this._closed.slice(0, 10);
        this._owned.delete(old.wcId);
      }
    }
    this._tabs = tabs;
    this._at = Date.now();
    return tabs;
  }

  async list(maxAgeMs = 250) { if (Date.now() - this._at > maxAgeMs) await this.refresh(); return this._tabs.map((t) => ({ ...t })); }
  async active() { return (await this.list()).find((t) => t.active) || null; }
  get(id) { return this._tabs.find((t) => t.id === id) || null; }
  guest(id) { const t = this.get(id); if (!t) return null; const c = contents.get(t.wcId); return c && !c.isDestroyed() ? c : null; }
  markOwned(wcId) { this._owned.add(wcId); }
  recentlyClosed() { return this._closed.slice(); }

  async switchTo(idOrIndex) {
    const tab = typeof idOrIndex === "number" ? this._tabs.find((t) => t.index === idOrIndex) : this.get(idOrIndex);
    if (!tab) throw new Error(`no such tab: ${idOrIndex}`);
    this.noahSwitching++;
    try { await chrome.tabs.update(tab.wcId, { active: true }); await this.refresh(); } finally { setTimeout(() => this.noahSwitching--, 300); }
    return this.get(tab.id);
  }

  async create(url) {
    this.noahSwitching++;
    try {
      const windowId = await this._windowId();
      const t = await chrome.tabs.create({ url: url || undefined, active: true, ...(windowId != null ? { windowId } : {}) });
      this.markOwned(t.id);
      await this.refresh();
      const created = this.get(`t${t.id}`);
      if (!created) throw new Error("new tab did not appear");
      created.ownedByNoah = true;
      return created;
    } finally { setTimeout(() => this.noahSwitching--, 300); }
  }

  async close(id) {
    const tab = this.get(id);
    if (!tab) throw new Error(`no such tab: ${id}`);
    if (this._tabs.length <= 1) throw new Error("cannot close the last remaining tab");
    this.noahSwitching++;
    try { await chrome.tabs.remove(tab.wcId); await new Promise((r) => setTimeout(r, 150)); await this.refresh(); return true; } finally { setTimeout(() => this.noahSwitching--, 300); }
  }

  find(query) {
    const q = tokens(query).filter((t) => !FILLER.has(t));
    if (!q.length) return [];
    const scored = [];
    for (const t of this._tabs) {
      const hay = `${t.title} ${t.url}`.toLowerCase();
      let host = ""; try { host = new URL(t.url).hostname; } catch (_) { /* not a web page */ }
      let score = 0;
      for (const tok of q) {
        if (host.includes(tok)) score += 3;
        else if (hay.includes(tok)) score += 2;
        else if (tokens(hay).some((h) => h.startsWith(tok) || tok.startsWith(h))) score += 1;
      }
      if (score > 0) scored.push({ tab: { ...t }, score: score / q.length });
    }
    scored.sort((a, b) => b.score - a.score || b.tab.lastActiveAt - a.tab.lastActiveAt);
    return scored;
  }

  findClosed(query) {
    const q = tokens(query).filter((t) => !FILLER.has(t));
    return this._closed.filter((c) => q.some((tok) => `${c.title} ${c.url}`.toLowerCase().includes(tok)));
  }

  /** Jonah on Chromium: stop debugging every tab (when Noah finishes or the panel closes). */
  detachAll() { for (const c of contents.values()) c.debugger.detach(); }
}

module.exports = { TabRegistry };
