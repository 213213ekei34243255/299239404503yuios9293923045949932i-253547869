// Rexy/executor.js
//
// Executor is Noah's nervous system + muscles. It never decides what to
// do — planner.js already decided — it only makes a single validated
// action happen, as reliably and observably as possible, and reports
// back what happened.
//
//   Planner -> Executor -> browser (bridge.js) -> renderer.js -> Electron
//
// Executor holds no opinion about *why* an action is being taken and no
// memory of the goal. It knows how to click, type, navigate, and so on —
// nothing more.

"use strict";

const { EventEmitter } = require("events");
const Logger = require("./logger.cjs");

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new ExecutorError("Action cancelled", { code: "CANCELLED" }));
        },
        { once: true }
      );
    }
  });
}

async function withTimeout(promise, ms, label, signal) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ExecutorError(`${label} timed out after ${ms}ms`, { code: "TIMEOUT" })), ms);
  });
  const abort = new Promise((_, reject) => {
    if (!signal) return;
    signal.addEventListener("abort", () => reject(new ExecutorError("Action cancelled", { code: "CANCELLED" })), {
      once: true,
    });
  });
  try {
    return await Promise.race([promise, timeout, ...(signal ? [abort] : [])]);
  } finally {
    clearTimeout(timer);
  }
}

class ExecutorError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = "ExecutorError";
    this.code = code || "EXECUTION_ERROR";
  }
}

// ---------------------------------------------------------------------------
// Action Router
//
// Instead of one giant switch statement, each action has a small config:
// which browser method handles it, a default timeout, how many small
// automatic retries it gets, and how to phrase a success message for
// logs/events. Categories below are just organizational — they all feed
// the same flat lookup table.
// ---------------------------------------------------------------------------

function buildActionTable(browser) {
  const nav = {
    navigate: {
      timeoutMs: 45_000,
      retries: 0,
      run: (args) => browser.openURL(args.url, { timeoutMs: args.timeoutMs || 20_000 }),
      message: (args) => `Navigated to ${args.url}`,
    },
    reload: {
      timeoutMs: 30_000,
      retries: 0,
      run: () => browser.reload(),
      message: () => "Reloaded page",
    },
    back: { timeoutMs: 15_000, retries: 0, run: () => browser.goBack(), message: () => "Went back" },
    goBack: { alias: "back" },
    forward: { timeoutMs: 15_000, retries: 0, run: () => browser.goForward(), message: () => "Went forward" },
    goForward: { alias: "forward" },
    stop: { timeoutMs: 2_000, retries: 0, run: () => browser.stop(), message: () => "Stopped loading" },
  };

  const mouse = {
    click: {
      timeoutMs: 8_000,
      retries: 1,
      retryDelayMs: 500,
      run: (args) => browser.click(args.selector, { button: args.button, clickCount: args.clickCount }),
      message: (args) => `Clicked ${args.selector}`,
    },
    doubleClick: {
      timeoutMs: 8_000,
      retries: 1,
      retryDelayMs: 500,
      run: (args) => browser.doubleClick(args.selector),
      message: (args) => `Double-clicked ${args.selector}`,
    },
    rightClick: {
      timeoutMs: 8_000,
      retries: 1,
      retryDelayMs: 500,
      run: (args) => browser.rightClick(args.selector),
      message: (args) => `Right-clicked ${args.selector}`,
    },
    hover: {
      timeoutMs: 5_000,
      retries: 1,
      retryDelayMs: 300,
      run: (args) => browser.hover(args.selector),
      message: (args) => `Hovered ${args.selector}`,
    },
    drag: {
      timeoutMs: 10_000,
      retries: 1,
      retryDelayMs: 500,
      run: (args) => browser.drag(args.sourceSelector, args.targetSelector, { steps: args.steps }),
      message: (args) => `Dragged ${args.sourceSelector} to ${args.targetSelector}`,
    },
    drop: {
      timeoutMs: 5_000,
      retries: 0,
      run: (args) => browser.drop(args.targetSelector),
      message: (args) => `Dropped on ${args.targetSelector}`,
    },
    scroll: {
      timeoutMs: 3_000,
      retries: 0,
      run: (args) => {
        const dx = args.deltaX ?? args.x ?? 0;
        const dy = args.deltaY ?? args.y ?? args.amount ?? 0;
        return browser.scroll(dx, dy);
      },
      message: (args) => {
        const dx = args.deltaX ?? args.x ?? 0;
        const dy = args.deltaY ?? args.y ?? args.amount ?? 0;
        return `Scrolled (${dx}, ${dy})`;
      },
    },
    scrollTo: {
      timeoutMs: 5_000,
      retries: 1,
      retryDelayMs: 300,
      run: (args) => browser.scrollTo(args.selector || { x: args.x, y: args.y }),
      message: (args) => `Scrolled to ${args.selector || `(${args.x},${args.y})`}`,
    },
  };

  const keyboard = {
    type: {
      timeoutMs: 8_000,
      retries: 1,
      retryDelayMs: 400,
      run: (args) => browser.type(args.selector, args.text, { delayMs: args.delayMs || 0 }),
      message: (args) => `Typed into ${args.selector}`,
    },
    pressKey: {
      timeoutMs: 3_000,
      retries: 0,
      run: (args) => browser.pressKey(args.key, { modifiers: args.modifiers || [] }),
      message: (args) => `Pressed key ${args.key}`,
    },
    hotkey: {
      timeoutMs: 3_000,
      retries: 0,
      run: (args) => browser.hotkey(args.keys || []),
      message: (args) => `Pressed hotkey ${(args.keys || []).join("+")}`,
    },
    copy: { timeoutMs: 2_000, retries: 0, run: () => browser.copy(), message: () => "Copied selection" },
    paste: { timeoutMs: 2_000, retries: 0, run: () => browser.paste(), message: () => "Pasted clipboard" },
  };

  const tabs = {
    createTab: {
      timeoutMs: 15_000,
      retries: 0,
      run: (args) => browser.createTab(args.url),
      message: (args) => `Created tab${args.url ? ` for ${args.url}` : ""}`,
    },
    closeTab: {
      timeoutMs: 5_000,
      retries: 0,
      run: (args) => browser.closeTab(args.index),
      message: (args) => `Closed tab ${args.index}`,
    },
    switchTab: {
      timeoutMs: 5_000,
      retries: 0,
      run: (args) => browser.switchTab(args.index),
      message: (args) => `Switched to tab ${args.index}`,
    },
    duplicateTab: {
      timeoutMs: 10_000,
      retries: 0,
      run: () => browser.duplicateTab(),
      message: () => "Duplicated current tab",
    },
  };

  const browserMisc = {
    download: {
      timeoutMs: 10_000,
      retries: 1,
      retryDelayMs: 500,
      // "download" is expressed as a click on a download link/button;
      // the actual transfer is tracked asynchronously via bridge's
      // 'download' event / getDownloads(), not awaited here.
      run: (args) => browser.click(args.selector),
      message: (args) => `Triggered download via ${args.selector}`,
    },
    upload: {
      timeoutMs: 10_000,
      retries: 0,
      run: (args) => {
        throw new ExecutorError("upload is not yet supported by the bridge", { code: "UNSUPPORTED" });
      },
      message: () => "Uploaded file",
    },
    bookmark: {
      timeoutMs: 3_000,
      retries: 0,
      run: (args) =>
        args.remove ? browser.removeBookmark(args.url) : browser.addBookmark({ url: args.url, title: args.title }),
      message: (args) => (args.remove ? `Removed bookmark ${args.url}` : `Bookmarked ${args.url}`),
    },
    history: {
      timeoutMs: 3_000,
      retries: 0,
      run: (args) => (args.clear ? browser.clearHistory() : browser.getHistory()),
      message: (args) => (args.clear ? "Cleared history" : "Read history"),
    },
    getCookies: {
      timeoutMs: 3_000,
      retries: 0,
      run: (args) => browser.getCookies(args.filter || {}),
      message: () => "Read cookies",
    },
    clearCookies: {
      timeoutMs: 5_000,
      retries: 0,
      run: (args) => browser.clearCookies(args.filter || {}),
      message: () => "Cleared cookies",
    },
    executeJS: {
      timeoutMs: 10_000,
      retries: 0,
      run: (args) => browser.execute(args.script),
      message: () => "Executed script",
    },
    capturePage: {
      timeoutMs: 5_000,
      retries: 0,
      run: () => browser.capturePage(),
      message: () => "Captured page screenshot",
    },
    focusWindow: {
      timeoutMs: 2_000,
      retries: 0,
      run: () => {
        browser.window?.focus?.();
        return true;
      },
      message: () => "Focused window",
    },
  };

  // Control actions: never touch the browser at all.
  const control = {
      wait: {
          timeoutMs: 60000,
          retries: 0,
          run: (args, signal) =>
              sleep(Math.min(args.ms ?? 1000, 30000), signal),
          message: (args) => `Waited ${args.ms ?? 1000}ms`,
      },

      observe: {
          timeoutMs: 5000,
          retries: 0,
          run: () => browser.observe(),
          message: () => "Observed page",
      },

      extract: {
          timeoutMs: 5000,
          retries: 0,
          run: (args) => browser.extract(args),
          message: () => "Extracted page information",
      },

      complete: {
          timeoutMs: 100,
          retries: 0,
          run: () => true,
          message: () => "Goal completed",
      },

      ask_user: {
          timeoutMs: 2000,
          retries: 0,
          run: () => true,
          message: (args) => `Asked user: ${args.question}`,
          paused: true,
      },

  };

  const table = { ...nav, ...mouse, ...keyboard, ...tabs, ...browserMisc, ...control };

  // Resolve simple aliases (e.g. goBack -> back) to their target config.
  for (const [name, cfg] of Object.entries(table)) {
    if (cfg.alias) table[name] = table[cfg.alias];
  }

  return table;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

class Executor extends EventEmitter {
  /**
   * @param {object} browser  a bridge.js-compatible browser API instance
   *                          (never Electron itself — see browser.js).
   * @param {object} [options]
   */
  constructor(browser, options = {}) {
    super();
    if (!browser) throw new Error("Executor requires a browser (bridge) instance");
    this.browser = browser;
    this.log = new Logger({ scope: "executor", level: options.logLevel || "info" });
    this.actions = buildActionTable(browser);

    this._activeController = null;
    this._cancelled = false;
  }

  /**
   * Single entry point. Every action flows through here.
   * @param {object} plan  a validated action from planner.js, e.g.
   *                       { action: "click", args: { selector: "#go" } }
   * @returns {Promise<{success:boolean, message?:string, error?:string, time:number, paused?:boolean}>}
   */
  async execute(plan) {
    console.log("EXECUTOR EXECUTE");
    console.log(plan);
    if (!plan || !plan.action) {
      return { success: false, error: "No action provided to executor", time: 0 };
    }

    const { action } = plan;
    const args = plan.args || {};
    const config = this.actions[action];

    if (!config) {
      const error = `Unknown action "${action}"`;
      this.log.error(error);
      this.emit("actionFailed", { action, args, error });
      return { success: false, error, time: 0 };
    }

    this._cancelled = false;
    this._activeController = new AbortController();
    const signal = this._activeController.signal;

    const start = Date.now();
    this.emit("actionStarted", { action, args });
    this.log.info(`▶ ${action}`, this._summarizeArgs(args));

    const maxAttempts = 1 + (config.retries || 0);
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) {
        return this._fail(action, args, "Cancelled by user", start);
      }
      try {
        const result = await withTimeout(
          Promise.resolve(config.run(args, signal)),
          config.timeoutMs || 10_000,
          action,
          signal
        );
        const time = Date.now() - start;
        const message = config.message ? config.message(args, result) : `${action} succeeded`;
        this.log.info(`✔ ${action} (${time}ms)`, message);
        const payload = { success: true, message, data: result, time, paused: Boolean(config.paused) };
        this.emit("actionCompleted", { action, args, ...payload });
        return payload;
      } catch (err) {
        lastError = err;
        if (err.code === "CANCELLED") {
          return this._fail(action, args, "Cancelled by user", start);
        }
        if (attempt < maxAttempts) {
          const delay = config.retryDelayMs || 500;
          this.log.warn(`✗ ${action} attempt ${attempt} failed (${err.message}); retrying in ${delay}ms`);
          await sleep(delay, signal).catch(() => {});
        }
      }
    }

    return this._fail(action, args, lastError?.message || "Unknown execution error", start);
  }

  /**
   * Immediately stops whatever the executor is currently doing. Called
   * by runtime.js when the user cancels the active goal.
   */
  cancel() {
    this._cancelled = true;
    if (this._activeController) {
      this._activeController.abort();
      this.log.info("Executor cancelled by request");
    }
  }

  isBusy() {
    return Boolean(this._activeController) && !this._cancelled;
  }

  // -------------------------------------------------------------------
  // internal
  // -------------------------------------------------------------------

  _fail(action, args, error, start) {
    const time = Date.now() - start;
    this.log.error(`✗ ${action} (${time}ms): ${error}`);
    const payload = { success: false, error, time };
    this.emit("actionFailed", { action, args, error, time });
    return payload;
  }

  _summarizeArgs(args) {
    try {
      const s = JSON.stringify(args);
      return s.length > 160 ? s.slice(0, 160) + "…" : s;
    } catch (_) {
      return "";
    }
  }
}

module.exports = Executor;
module.exports.ExecutorError = ExecutorError;