// Noah/browser/tabs.cjs
//
// Tab awareness for the agent: current tab, all tabs, titles/URLs, activity,
// ownership (opened by Noah vs. by the user), and fuzzy lookup so the user can
// say "go back to the tab where I had Amazon open".
//
// Jonah keeps one <webview> per tab inside the shell renderer. The renderer
// bridge (noah-renderer.js -> window.NoahRenderer) reports the tab list with
// each webview's webContents id; main resolves that to the real guest
// WebContents, which is what CDP attaches to.

"use strict";

const { EventEmitter } = require("events");

function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

const FILLER = new Set(["the", "tab", "where", "had", "have", "open", "opened", "with", "my", "that", "page", "window", "go", "back", "to", "switch", "site", "website", "on", "in", "of", "a", "an", "i"]);

class TabRegistry extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('electron').BrowserWindow} deps.mainWindow
   * @param {typeof import('electron').webContents} deps.webContents
   */
  constructor({ mainWindow, webContents, log = () => {}, isolatedPartition = "noah-isolated" }) {
    super();
    this.win = mainWindow;
    this.webContentsApi = webContents;
    this.log = log;
    this.isolatedPartition = isolatedPartition;
    this._tabs = [];
    this._at = 0;
    this._owned = new Set(); // wcIds opened by Noah
    this._lastActive = new Map(); // wcId -> ts
    this._closed = []; // recently closed [{title,url,closedAt}]
    this.noahSwitching = 0;
    this._lastActiveId = null;
  }

  async _renderer(expression) {
    if (!this.win || this.win.isDestroyed()) throw new Error("Jonah window is not available");
    return this.win.webContents.executeJavaScript(expression, true);
  }

  /** Refresh from the renderer. Emits `active_changed` when the active tab changes. */
  async refresh() {
    let raw = [];
    try {
      raw = (await this._renderer("window.NoahRenderer ? window.NoahRenderer.tabs() : []")) || [];
    } catch (err) {
      this.log("tab refresh failed:", err.message);
    }
    const tabs = raw
      .filter((t) => t.wcId)
      .map((t) => {
        const wc = this.webContentsApi.fromId(t.wcId);
        const live = wc && !wc.isDestroyed();
        return {
          id: `t${t.wcId}`,
          wcId: t.wcId,
          index: t.index,
          title: (live ? wc.getTitle() : t.title) || t.title || "",
          url: (live ? wc.getURL() : t.url) || t.url || "",
          active: !!t.active,
          loading: live ? wc.isLoading() : false,
          ownedByNoah: this._owned.has(t.wcId),
          partition: t.partition || undefined,
          lastActiveAt: this._lastActive.get(t.wcId) || 0,
        };
      });
    const active = tabs.find((t) => t.active);
    if (active) {
      this._lastActive.set(active.wcId, Date.now());
      if (this._lastActiveId !== null && this._lastActiveId !== active.id) {
        this.emit("active_changed", { from: this._lastActiveId, to: active.id, byNoah: this.noahSwitching > 0 });
      }
      this._lastActiveId = active.id;
    }
    // detect closed tabs for "recently closed" recall
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

  /** Cached list (refreshes if older than `maxAgeMs`). */
  async list(maxAgeMs = 250) {
    if (Date.now() - this._at > maxAgeMs) await this.refresh();
    return this._tabs.map((t) => ({ ...t }));
  }

  async active() {
    return (await this.list()).find((t) => t.active) || null;
  }

  get(id) {
    return this._tabs.find((t) => t.id === id) || null;
  }

  guest(id) {
    const t = this.get(id);
    if (!t) return null;
    const wc = this.webContentsApi.fromId(t.wcId);
    return wc && !wc.isDestroyed() ? wc : null;
  }

  markOwned(wcId) {
    this._owned.add(wcId);
  }

  recentlyClosed() {
    return this._closed.slice();
  }

  // ----------------------------------------------------------------- actions

  async switchTo(idOrIndex) {
    const tab = typeof idOrIndex === "number" ? this._tabs.find((t) => t.index === idOrIndex) : this.get(idOrIndex);
    if (!tab) throw new Error(`no such tab: ${idOrIndex}`);
    this.noahSwitching++;
    try {
      await this._renderer(`window.NoahRenderer.switchTab(${tab.index})`);
      await this.refresh();
    } finally {
      setTimeout(() => this.noahSwitching--, 300);
    }
    return this.get(tab.id);
  }

  /**
   * Open a new tab. isolated=true puts it in a non-persistent partition with no
   * cookies from the user's session (sandbox mode).
   */
  async create(url, { isolated = false } = {}) {
    const before = new Set(this._tabs.map((t) => t.wcId));
    this.noahSwitching++;
    try {
      await this._renderer(`window.NoahRenderer.newTab(${JSON.stringify(url || "")}, ${JSON.stringify(isolated ? this.isolatedPartition : null)})`);
      let created = null;
      for (let i = 0; i < 40 && !created; i++) {
        await new Promise((r) => setTimeout(r, 100));
        await this.refresh();
        created = this._tabs.find((t) => !before.has(t.wcId));
      }
      if (!created) throw new Error("new tab did not appear");
      this.markOwned(created.wcId);
      created.ownedByNoah = true;
      return created;
    } finally {
      setTimeout(() => this.noahSwitching--, 300);
    }
  }

  async close(id) {
    const tab = this.get(id);
    if (!tab) throw new Error(`no such tab: ${id}`);
    if (this._tabs.length <= 1) throw new Error("cannot close the last remaining tab");
    this.noahSwitching++;
    try {
      const ok = await this._renderer(`window.NoahRenderer.closeTab(${tab.index})`);
      await new Promise((r) => setTimeout(r, 150));
      await this.refresh();
      return !!ok;
    } finally {
      setTimeout(() => this.noahSwitching--, 300);
    }
  }

  // ---------------------------------------------------------------- searching

  /**
   * Fuzzy-find a tab by natural language ("the amazon tab", "flights", "docs").
   * Scores title and URL token overlap; ties broken by most recently active.
   */
  find(query) {
    const q = tokens(query).filter((t) => !FILLER.has(t));
    if (!q.length) return [];
    const scored = [];
    for (const t of this._tabs) {
      const hay = `${t.title} ${t.url}`.toLowerCase();
      const host = (() => {
        try {
          return new URL(t.url).hostname;
        } catch (_) {
          return "";
        }
      })();
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

  /** Same idea over recently closed tabs (so "the amazon tab I closed" can be reopened). */
  findClosed(query) {
    const q = tokens(query).filter((t) => !FILLER.has(t));
    return this._closed.filter((c) => q.some((tok) => `${c.title} ${c.url}`.toLowerCase().includes(tok)));
  }
}

module.exports = { TabRegistry };
