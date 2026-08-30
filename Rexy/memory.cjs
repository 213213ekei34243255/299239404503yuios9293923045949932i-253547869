// Rexy/memory.js
//
// Memory is the backbone of the agent: a fast in-memory store that holds
// the latest known state of the browser and the current task. It never
// talks to Electron directly — only observer.js writes browser/page/tab
// state in here, and only planner.js (via the LLM context) reads it back
// out. That one-way data flow keeps the rest of the system testable:
//
//   Electron -> Observer -> Memory -> Planner -> LLM
//
// Everything here is synchronous and cheap; anything expensive (disk
// persistence, remote sync) is pushed to the edges via load()/flush().

"use strict";

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { EventEmitter } = require("events");

const DEFAULT_PERSIST_PATH = path.join(os.homedir(), ".rexy", "memory.json");

const MAX_HISTORY = 200;
const MAX_ERRORS = 100;
const MAX_RECENT_ACTIONS = 50;
const MAX_CONVERSATION = 100;
const MAX_PREVIOUS_PLANS = 50;

function nowISO() {
  return new Date().toISOString();
}

function clampPush(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
  return arr;
}

// ---------------------------------------------------------------------------
// Default shape — mirrors the 15-section structure.
// ---------------------------------------------------------------------------

function defaultState() {
  return {
    // 1. Goal Memory
    goal: {
      text: null,
      setAt: null,
    },

    // 2. Task Memory
    task: {
      currentTask: null,
      completed: [],
      pending: [],
    },

    // 3. Browser State
    browser: {
      activeTab: null,
      url: null,
      title: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
    },

    // 4. Tab Memory
    tabs: [],

    // 5. Page Memory (from observer.js)
    page: {
      buttons: [],
      inputs: [],
      links: [],
      forms: [],
      images: [],
      selectedText: "",
      pageText: "",
    },

    // 6. Downloads
    downloads: [],

    // 7. History (deduped, most-recent-last)
    history: [],

    // 8. Browser Permissions
    permissions: {
      camera: false,
      microphone: false,
      location: false,
    },

    // 9. Session Memory
    session: {
      startTime: Date.now(),
      lastAction: null,
      lastActionAt: null,
      idle: false,
    },

    // 10. Error Memory
    errors: [],

    // 11. User Preferences
    preferences: {
      theme: "dark",
      searchEngine: "Google",
      language: "English",
    },

    // 12. LLM Context
    llmContext: {
      conversation: [],
      previousPlans: [],
      lastResponse: "",
    },

    // 13. Vision Cache
    vision: {
      lastScreenshot: null,
      detectedObjects: [],
      OCR: "",
    },

    // 14. Browser Capabilities
    capabilities: {
      navigation: true,
      click: true,
      scroll: true,
      type: true,
      drag: true,
      download: true,
      upload: true,
      cookies: true,
      history: true,
      bookmarks: true,
      tabs: true,
      screenshot: true,
    },

    // 15. Runtime State
    runtime: {
      running: false,
      paused: false,
      cancelled: false,
    },

    // Not part of the numbered list, but useful for the planner/executor
    // to see what just happened without re-deriving it from history.
    recentActions: [],
  };
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

class Memory extends EventEmitter {
  constructor(options = {}) {
    super();
    this.persistPath = options.persistPath || DEFAULT_PERSIST_PATH;
    this.autoPersist = options.autoPersist ?? true;
    this.state = defaultState();
  }

  // -------------------------------------------------------------------
  // 1. Goal
  // -------------------------------------------------------------------

  setGoal(goalText) {
    const isNewGoal = this.state.goal?.text !== goalText;
    this.state.goal = { text: goalText, setAt: nowISO() };
    // Starting a new goal implicitly resets task progress so stale
    // completed/pending lists from a previous goal don't leak in.
    this.state.task = { currentTask: null, completed: [], pending: [] };
    // A genuinely new/different goal must also drop recentActions and
    // errors from whatever goal came before it. Otherwise a leftover
    // "last action was a successful navigate" from an OLD goal can make
    // the planner's completion heuristics think a brand-new, unrelated
    // goal is already satisfied without ever acting on it.
    if (isNewGoal) {
      this.state.recentActions = [];
      this.state.errors = [];
    }
    this._touch("setGoal");
  }

  getGoal() {
    return { ...this.state.goal };
  }

  // -------------------------------------------------------------------
  // 2. Task
  // -------------------------------------------------------------------

  setCurrentTask(task) {
    this.state.task.currentTask = task;
    this._touch("setCurrentTask");
  }

  setPending(tasks) {
    this.state.task.pending = [...tasks];
    this._touch("setPending");
  }

  completeTask(task) {
    this.state.task.pending = this.state.task.pending.filter((t) => t !== task);
    if (!this.state.task.completed.includes(task)) {
      this.state.task.completed.push(task);
    }
    this._touch("completeTask");
  }

  getTask() {
    return {
      currentTask: this.state.task.currentTask,
      completed: [...this.state.task.completed],
      pending: [...this.state.task.pending],
    };
  }

  // -------------------------------------------------------------------
  // 3/4/5. Browser, tabs, page — written exclusively by observer.js
  // -------------------------------------------------------------------

  /**
   * Single entry point observer.js calls after each observation cycle.
   * Accepts a partial shape; only provided sections are merged in.
   */
  updateObservation(observation = {}) {
    if (observation.browser) {
      this.state.browser = { ...this.state.browser, ...observation.browser };
    }
    if (observation.tabs) {
      this.state.tabs = observation.tabs.map((t) => ({ ...t }));
    }
    if (observation.page) {
      this.state.page = { ...this.state.page, ...observation.page };
    }
    if (observation.downloads) {
      this.state.downloads = observation.downloads.map((d) => ({ ...d }));
    }
    if (observation.permissions) {
      this.state.permissions = { ...this.state.permissions, ...observation.permissions };
    }
    if (observation.capabilities) {
      this.state.capabilities = { ...this.state.capabilities, ...observation.capabilities };
    }
    if (observation.vision) {
      this.state.vision = { ...this.state.vision, ...observation.vision };
    }

    // Convenience flat fields some observers send directly.
    if (observation.url) this._recordHistory(observation.url);

    this._touch("updateObservation");
  }

  getBrowserState() {
    return { ...this.state.browser };
  }

  getTabs() {
    return this.state.tabs.map((t) => ({ ...t }));
  }

  getPage() {
    return { ...this.state.page };
  }

  // -------------------------------------------------------------------
  // 6. Downloads
  // -------------------------------------------------------------------

  updateDownload(filename, patch) {
    const idx = this.state.downloads.findIndex((d) => d.filename === filename);
    if (idx === -1) {
      this.state.downloads.push({ filename, progress: 0, completed: false, ...patch });
    } else {
      this.state.downloads[idx] = { ...this.state.downloads[idx], ...patch };
    }
    this._touch("updateDownload");
  }

  getDownloads() {
    return this.state.downloads.map((d) => ({ ...d }));
  }

  // -------------------------------------------------------------------
  // 7. History
  // -------------------------------------------------------------------

  _recordHistory(url) {
    if (!url) return;
    const normalized = this._normalizeUrl(url);
    // Avoid back-to-back duplicates (e.g. repeated observations of the
    // same page) while still allowing a site to be revisited later.
    const last = this.state.history[this.state.history.length - 1];
    if (last === normalized) return;
    clampPush(this.state.history, normalized, MAX_HISTORY);
  }

  _normalizeUrl(url) {
    try {
      const u = new URL(url);
      return u.hostname + (u.pathname !== "/" ? u.pathname : "");
    } catch (_) {
      return url;
    }
  }

  hasVisited(url) {
    return this.state.history.includes(this._normalizeUrl(url));
  }

  getHistory() {
    return [...this.state.history];
  }

  // -------------------------------------------------------------------
  // 8. Permissions
  // -------------------------------------------------------------------

  setPermission(name, granted) {
    this.state.permissions[name] = granted;
    this._touch("setPermission");
  }

  getPermissions() {
    return { ...this.state.permissions };
  }

  // -------------------------------------------------------------------
  // 9. Session
  // -------------------------------------------------------------------

  recordAction(label) {
    this.state.session.lastAction = label;
    this.state.session.lastActionAt = Date.now();
    this.state.session.idle = false;
    this._touch("recordAction");
  }

  markIdle(idle = true) {
    this.state.session.idle = idle;
    this._touch("markIdle");
  }

  getSession() {
    return { ...this.state.session };
  }

  // -------------------------------------------------------------------
  // 10. Errors
  // -------------------------------------------------------------------

  logError(error, context = {}) {
    const entry = {
      time: nowISO(),
      error: error?.message || String(error),
      context,
    };
    clampPush(this.state.errors, entry, MAX_ERRORS);
    this.emit("error-logged", entry);
    this._touch("logError");
  }

  getErrors() {
    return [...this.state.errors];
  }

  clearErrors() {
    this.state.errors = [];
    this._touch("clearErrors");
  }

  // -------------------------------------------------------------------
  // 11. Preferences
  // -------------------------------------------------------------------

  setPreference(key, value) {
    this.state.preferences[key] = value;
    this._touch("setPreference");
  }

  getPreferences() {
    return { ...this.state.preferences };
  }

  // -------------------------------------------------------------------
  // 12. LLM Context
  // -------------------------------------------------------------------

  appendConversation(role, content) {
    clampPush(this.state.llmContext.conversation, { role, content, at: nowISO() }, MAX_CONVERSATION);
    this._touch("appendConversation");
  }

  recordPlan(plan) {
    clampPush(this.state.llmContext.previousPlans, plan, MAX_PREVIOUS_PLANS);
    this._touch("recordPlan");
  }

  setLastResponse(response) {
    this.state.llmContext.lastResponse = response;
    this._touch("setLastResponse");
  }

  getLLMContext() {
    return {
      conversation: [...this.state.llmContext.conversation],
      previousPlans: [...this.state.llmContext.previousPlans],
      lastResponse: this.state.llmContext.lastResponse,
    };
  }

  // -------------------------------------------------------------------
  // 13. Vision cache
  // -------------------------------------------------------------------

  setVision(patch) {
    this.state.vision = { ...this.state.vision, ...patch };
    this._touch("setVision");
  }

  getVision() {
    return { ...this.state.vision };
  }

  // -------------------------------------------------------------------
  // 14. Capabilities
  // -------------------------------------------------------------------

  setCapability(name, enabled) {
    this.state.capabilities[name] = enabled;
    this._touch("setCapability");
  }

  can(action) {
    return Boolean(this.state.capabilities[action]);
  }

  getCapabilities() {
    return { ...this.state.capabilities };
  }

  // -------------------------------------------------------------------
  // 15. Runtime state
  // -------------------------------------------------------------------

  setRuntimeState(patch) {
    this.state.runtime = { ...this.state.runtime, ...patch };
    this._touch("setRuntimeState");
  }

  getRuntimeState() {
    return { ...this.state.runtime };
  }

  // -------------------------------------------------------------------
  // Actions (bridges Task + Session + LLM context in one call, used by
  // runtime.js after executor.execute())
  // -------------------------------------------------------------------

  storeAction(plan, result) {
    const entry = {
      action: plan?.action ?? null,
      args: plan?.args ?? {},
      result: result ?? null,
      at: nowISO(),
      goal: this.state.goal?.text ?? null,
    };
    clampPush(this.state.recentActions, entry, MAX_RECENT_ACTIONS);
    this.recordAction(entry.action || "unknown");
    this.recordPlan(plan);
    if (plan?.reasoning) {
      this.appendConversation("assistant", plan.reasoning);
    }
    this._touch("storeAction");
  }

  getRecentActions(limit = MAX_RECENT_ACTIONS) {
    return this.state.recentActions.slice(-limit).map((a) => ({ ...a }));
  }

  // -------------------------------------------------------------------
  // Export — the single object the planner hands to llm.js so the
  // planner never has to reassemble context by hand.
  // -------------------------------------------------------------------

  export() {
    return {
      goal: this.getGoal(),
      task: this.getTask(),
      browser: this.getBrowserState(),
      tabs: this.getTabs(),
      page: this.getPage(),
      downloads: this.getDownloads(),
      history: this.getHistory(),
      permissions: this.getPermissions(),
      session: this.getSession(),
      errors: this.getErrors().slice(-10), // keep exports light; full list via getErrors()
      preferences: this.getPreferences(),
      llmContext: this.getLLMContext(),
      vision: this.getVision(),
      capabilities: this.getCapabilities(),
      runtime: this.getRuntimeState(),
      recentActions: this.getRecentActions(10),
    };
  }

  /**
   * Full reset, e.g. when the user starts a brand-new session. Keeps
   * user preferences by default since those are cross-session.
   */
  reset({ keepPreferences = true } = {}) {
    const prefs = this.state.preferences;
    this.state = defaultState();
    if (keepPreferences) this.state.preferences = prefs;
    this._touch("reset");
  }

  // -------------------------------------------------------------------
  // Persistence — deliberately separate from the synchronous API above
  // so normal reads/writes never block on disk I/O.
  // -------------------------------------------------------------------

  async load() {
    try {
      const raw = await fs.readFile(this.persistPath, "utf-8");
      const saved = JSON.parse(raw);
      // Merge onto defaults so new fields introduced later don't get
      // lost when loading an older persisted file.
      this.state = {
        ...defaultState(),
        ...saved,
        session: { ...defaultState().session, ...saved.session, startTime: Date.now() },
      };
      this.emit("loaded");
    } catch (err) {
      if (err.code !== "ENOENT") {
        this.logError(err, { phase: "load" });
      }
      // No persisted file yet — start fresh, that's fine.
    }
  }

  async flush() {
    if (!this.autoPersist) return;
    try {
      await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
      await fs.writeFile(this.persistPath, JSON.stringify(this.state, null, 2), "utf-8");
      this.emit("flushed");
    } catch (err) {
      // Persistence failures shouldn't crash the agent — log and move on.
      this.emit("flush-error", err);
    }
  }

  /**
   * Called periodically by runtime.js's background loop. Cheap no-op
   * unless a sync target (remote store, renderer mirror, etc.) is wired
   * in via the "sync" listener.
   */
  async sync() {
    this.emit("sync", this.export());
  }

  // -------------------------------------------------------------------
  // internal
  // -------------------------------------------------------------------

  _touch(reason) {
    this.emit("change", { reason, at: Date.now() });
  }
}

module.exports = Memory;