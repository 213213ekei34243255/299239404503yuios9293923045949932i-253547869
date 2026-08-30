// Rexy/runtime.js
//
// Core orchestration runtime for the Rexy agent.
// Wires together the Observer -> Planner -> Executor loop with a
// goal queue, task scheduler, state machine, error recovery, event bus,
// IPC bridge to the renderer, and graceful shutdown handling.

"use strict";
console.log("RUNTIME LOADED");
console.log(__filename);
const { EventEmitter } = require("events");
const { ipcMain } = require("electron");
const { randomUUID } = require("crypto");

const Observer = require("./observer.cjs");
const Planner = require("./planner.cjs");
const Executor = require("./executor.cjs");
const Memory = require("./memory.cjs");
const Permissions = require("./permissions.cjs");
const Vision = require("./vision.cjs");
const Voice = require("./voice.cjs");
const LLMClient = require("./llm.cjs");
const Logger = require("./logger.cjs");
const Bridge = require("./bridge.cjs");
const Browser = require("./browser.cjs");

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const STATES = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  PLANNING: "planning",
  EXECUTING: "executing",
  OBSERVING: "observing",
  WAITING_PERMISSION: "waiting_permission",
  ERROR: "error",
  STOPPING: "stopping",
  STOPPED: "stopped",
});

// Legal transitions out of each state. Anything not listed here is rejected
// by setState(), which keeps the runtime from drifting into invalid combos
const TRANSITIONS = Object.freeze({

    [STATES.IDLE]: [
        STATES.STARTING,
        STATES.OBSERVING,
        STATES.PLANNING,
        STATES.EXECUTING,
        STATES.ERROR,
        STATES.STOPPING,
        STATES.STOPPED
    ],

    [STATES.STARTING]: [
        STATES.IDLE,          // <-- allow runtime startup to finish
        STATES.PLANNING,
        STATES.ERROR,
        STATES.STOPPING
    ],

    [STATES.PLANNING]: [
        STATES.EXECUTING,
        STATES.WAITING_PERMISSION,
        STATES.ERROR,
        STATES.IDLE,
        STATES.STOPPING
    ],

    [STATES.EXECUTING]: [
        STATES.OBSERVING,
        STATES.ERROR,
        STATES.IDLE,
        STATES.STOPPING
    ],

    [STATES.OBSERVING]: [
        STATES.PLANNING,
        STATES.ERROR,
        STATES.IDLE,
        STATES.STOPPING
    ],

    [STATES.WAITING_PERMISSION]: [
        STATES.EXECUTING,
        STATES.IDLE,
        STATES.ERROR,
        STATES.STOPPING
    ],

    [STATES.ERROR]: [
        STATES.PLANNING,
        STATES.IDLE,
        STATES.STOPPING
    ],

    [STATES.STOPPING]: [
        STATES.STOPPED
    ],

    [STATES.STOPPED]: [
        STATES.STARTING
    ]

});

// ---------------------------------------------------------------------------
// Goal queue
// ---------------------------------------------------------------------------

class GoalQueue {
  constructor() {
    this._items = [];
  }

  enqueue(goal, { priority = 0, retries = 0 } = {}) {
    const entry = {
      id: randomUUID(),
      goal,
      priority,
      retries,
      status: "queued",
      createdAt: Date.now(),
    };
    this._items.push(entry);
    this._items.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    return entry;
  }

  dequeue() {
    return this._items.shift() || null;
  }

  cancel(id) {
    const before = this._items.length;
    this._items = this._items.filter((e) => e.id !== id);
    return this._items.length < before;
  }

  clear() {
    this._items = [];
  }

  get size() {
    return this._items.length;
  }

  list() {
    return this._items.map((e) => ({ ...e }));
  }
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        },
        { once: true }
      );
    }
  });
}

async function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// FIX: withTimeout() above only ever *stops waiting* on timeout - it
// never cancels whatever the wrapped promise was actually doing. For a
// network call (planner.plan() -> llm.predict() -> fetch), that means
// the abandoned request keeps running against the server in the
// background indefinitely, even after the caller has moved on and the
// user has been told "plan timed out". If a retry then fires a second
// request on top of the still-running first one, they compete for the
// same limited server resources (gunicorn threads, the local LLM's
// single processing slot) - which piles up over time and is a real
// contributor to server-side memory growth.
//
// This variant takes a FACTORY function (not an already-started promise)
// so it can hand the operation its own AbortController, chained from -
// but distinct from - the goal-level `parentSignal`. Chaining means a
// user cancellation still cancels this step too; being distinct means
// the outer catch block can still tell "this step's own timer fired"
// (report as a timeout) apart from "the whole goal was cancelled"
// (report as a cancellation) - preserving today's accurate messaging
// while ALSO actually cancelling the abandoned request on timeout.
async function withAbortableTimeout(factory, ms, label = "operation", parentSignal) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    return await factory(controller.signal);
  } catch (err) {
    if (controller.signal.aborted && !parentSignal?.aborted) {
      // Our own timer fired, not the caller's signal - surface a clear
      // timeout message rather than whatever generic "aborted" error
      // the underlying fetch/operation throws when its signal fires.
      throw new Error(`${label} timed out after ${ms}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

async function withRetry(fn, { retries = 3, baseDelayMs = 500, label = "operation", signal } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (attempt > retries) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      await sleep(delay, signal).catch(() => {});
    }
  }
  throw new Error(`${label} failed after ${retries + 1} attempts: ${lastErr?.message || lastErr}`);
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

class RexyRuntime extends EventEmitter {
  /**
   * @param {import('electron').BrowserWindow} mainWindow
   * @param {object} options
   */
  constructor(mainWindow, options = {}) {
    super();

    this.window = mainWindow;
    this.options = {
      tickIntervalMs: 250,
      stepTimeoutMs: 45_000,
      planTimeoutMs: 90_000,
      // maxStepRetries removed: executor.cjs's own per-action retry
      // table is now the sole retry authority for action execution (see
      // the execute() call site for why the outer retry was removed).
      logLevel: "info",
      ...options,
    };
    this.log = new Logger({
        scope: "runtime",
        level: this.options.logLevel || "info"
    });

    // Integrations
    this.observer = new Observer(mainWindow);
    this.planner = new Planner();
    this.bridge = new Bridge(mainWindow);
    this.browser = new Browser(this.bridge);
    this.executor = new Executor(this.browser);
    this.memory = new Memory();
    this.permissions = new Permissions();
    this.vision = new Vision(mainWindow);
    this.voice = new Voice();
    this.llm = new LLMClient(this.options.llm || {});

    // Core runtime state
    this.state = STATES.IDLE;
    this.goalQueue = new GoalQueue();
    this.currentGoalEntry = null;
    this.running = false;
    this._loopPromise = null;
    this._abortController = null;
    this._schedulerHandle = null;

    
    this._registerBrowserListeners();
    this._registerInternalListeners();
    this._registerIPC(); 
    
  }

  // -------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------

  setState(next) {
    const allowed = TRANSITIONS[this.state] || [];
    if (!allowed.includes(next)) {
      this.log.warn(`Illegal transition ${this.state} -> ${next}, ignoring`);
      return false;
    }
    const prev = this.state;
    this.state = next;
    this.emit("state", { from: prev, to: next });
    this._notifyRenderer("runtime:state", { from: prev, to: next });
    return true;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  async init() {
    this.log.info("Initializing runtime");
    await this.memory.load?.();
    await this.permissions.load?.();
    this.emit("ready");
  }

  async start() {
    if (this.running) {
      this.log.warn("start() called while already running");
      return;
    }
    this.setState(STATES.STARTING);
    console.log("STATE AFTER STARTING:", this.state);
    this.running = true;
    this._abortController = new AbortController();
    await this.browser.initialize();
    console.log("BEFORE IDLE:", this.state);

    const ok = this.setState(STATES.IDLE);

    console.log("SET IDLE RETURNED:", ok);

    console.log("AFTER IDLE:", this.state);
    this.setState(STATES.IDLE);
    this.log.info("🧠 Rexy Runtime Started");
    this.setState(STATES.IDLE); 
    this.emit("started");

    // Continuous scheduler tick — pulls goals off the queue and drives
    // the main loop. Decoupled from execute() so goals can be queued
    // asynchronously from IPC/UI/voice at any time.
    this._schedulerHandle = setInterval(() => this._tick(), this.options.tickIntervalMs);

    this._loopPromise = this._runLoop().catch((err) => {
      this.log.error("Fatal runtime loop error", err);
      this.setState(STATES.ERROR);
    });
  }

  async stop(reason = "user requested") {
    if (!this.running) return;
    this.log.info(`🛑 Stopping runtime (${reason})`);
    this.setState(STATES.STOPPING);
    this.running = false;
    this._abortController?.abort();
    clearInterval(this._schedulerHandle);
    this._schedulerHandle = null;

    await this._loopPromise?.catch(() => {});
    this.setState(STATES.STOPPED);
    this.emit("stopped", { reason });
  }

  async shutdown() {
    this.log.info("Shutting down runtime");
    await this.stop("shutdown");
    await this.memory.flush?.();
    this.browser.shutdown();
    this.voice.stop?.();
    
    this.removeAllListeners();
    this.emit("shutdown");
  }

  // -------------------------------------------------------------------
  // Goal queue / scheduler
  // -------------------------------------------------------------------

  submitGoal(goal, opts = {}) {
    console.log("SUBMIT GOAL:", goal);

    if (!this._looksLikeBrowserTask(goal)) {
      // Chat never touches the browser/webview, so it must never be
      // forced to wait behind a slow or stuck agent goal in goalQueue.
      // Without this branch, _tick() would only dequeue this once
      // this.currentGoalEntry clears — which, for a browser task that's
      // mid-retry against a slow backend, can take minutes. During that
      // wait a plain chat question looks "stuck" or appears to trigger
      // agent work, when really it's just queued behind unrelated work.
      // Run it immediately and independently instead.
      const entry = {
        id: randomUUID(),
        goal,
        priority: opts.priority ?? 0,
        retries: opts.retries ?? 0,
        status: "queued",
        createdAt: Date.now(),
        kind: "chat",
      };
      this.log.info("📥 Chat message received (running immediately):", goal);
      this.emit("goal:queued", entry);
      this._notifyRenderer("runtime:goal-queued", entry);
      this._runChatGoal(entry);
      return entry.id;
    }

    const entry = this.goalQueue.enqueue(goal, opts);
    entry.kind = "agent";
    this.log.info("📥 Goal queued:", goal);
    this.emit("goal:queued", entry);
    this._notifyRenderer("runtime:goal-queued", entry);
    return entry.id;
  }

  // Chat goals bypass the browser goalQueue/state machine entirely and
  // handle their own bounded retry inline, so a failure here never
  // re-enters the agent goalQueue (see the goal:error listener below).
  async _runChatGoal(entry, attempt = 1) {
    const { goal } = entry;
    console.log(`EXECUTE GOAL [chat] (attempt ${attempt})`);
    this.memory.setGoal(goal);
    this.log.info("🎯 Goal (chat):", goal);
    this.emit("goal:started", entry);
    try {
      const reply = await this._chatReply(goal);
      this.emit("goal:completed", { ...entry, reason: reply });
    } catch (err) {
      if (attempt < 2) {
        this.log.warn(`Chat reply failed (attempt ${attempt}), retrying:`, err.message);
        return this._runChatGoal(entry, attempt + 1);
      }
      this.log.warn(`Giving up on chat reply after ${attempt} attempt(s):`, goal);
      this.emit("goal:error", { entry: { ...entry, kind: "chat" }, error: err });
    }
  }

  cancelGoal(goalId) {
    if (this.currentGoalEntry?.id === goalId) {
      this._abortController?.abort();
      this.log.info("🚫 Cancelling active goal:", goalId);
      return true;
    }
    return this.goalQueue.cancel(goalId);
  }

  // Scheduler tick: if idle and goals are pending, pop one and kick off
  // execution without blocking the interval itself.
  async _tick() {
    console.log("TICK", this.state, this.goalQueue.size);
    if (!this.running) return;
    if (this.state !== STATES.IDLE) return;
    if (this.currentGoalEntry) return;

    const next = this.goalQueue.dequeue();
    if (!next) return;

    this.currentGoalEntry = next;
    this._abortController = new AbortController();
    this._executeGoal(next).finally(() => {
      this.currentGoalEntry = null;
    });
  }

  // Background loop kept alive for housekeeping: memory sync, health
  // checks, etc. The actual goal work happens per-tick via _executeGoal.
  async _runLoop() {
    while (this.running) {
      try {
        await this.memory.sync?.();
      } catch (err) {
        this.log.warn("Memory sync failed", err);
      }
      await sleep(this.options.tickIntervalMs * 4, this._abortController?.signal).catch(() => {});
    }
  }
  _looksLikeBrowserTask(goal) {
    const g = String(goal || "").toLowerCase();
    const BROWSER_VERBS = [
      "open", "go to", "goto", "navigate", "visit", "click", "type",
      "search", "find", "fill", "submit", "login", "sign in", "scroll",
      "download", "upload", "bookmark", "tab", "screenshot", "extract",
      "reload", "back", "forward",
      // Wordier/indirect phrasing common in voice transcripts, which
      // rarely use the terse verbs above. These are still fairly
      // specific to "go interact with a page" intent rather than
      // general conversation.
      "look into", "look at", "check out", "pull up", "load up",
      "take me to", "bring up", "browse to", "browse", "see this",
      "observe", "look up",
    ];
    const pattern = new RegExp("\\b(" + BROWSER_VERBS.join("|") + ")\\b");
    // A goal that mentions "website"/"site"/"page"/"url"/".com" etc.
    // alongside a proper-noun-ish target is very likely a navigation
    // request even without hitting one of the verbs above — e.g.
    // "can you see this website Pokemon" or "what does the NBA site look
    // like right now".
    const mentionsWebTarget = /\b(website|site|homepage|web ?page|\.com|\.org|\.net)\b/.test(g);
    return pattern.test(g) || mentionsWebTarget || /https?:\/\//.test(g);
  }

  async _chatReply(goal) {
    const reply = await this.llm.chat({
      message: goal,
      sessionId: this.memory?.export?.()?.sessionId || "default",
    });
    return reply || "…";
  }
  // -------------------------------------------------------------------
  // Per-goal execution (Observe -> Plan -> Permission -> Execute)
  // -------------------------------------------------------------------

  async _executeGoal(entry) {
    const { goal } = entry;
    const signal = this._abortController.signal;
    const MAX_ATTEMPTS = 2; // FIX: exactly one retry, total. See note below.

    this.memory.setGoal(goal);
    this.log.info("🎯 Goal:", goal);
    this.emit("goal:started", entry);

    let lastErr;

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(`EXECUTE GOAL [agent] (attempt ${attempt}/${MAX_ATTEMPTS})`);
        try {
          const outcome = await this._runAgentAttempt(entry, signal);
          if (outcome === "paused") return; // already emitted goal:paused inside
          return; // completed / blocked / no-plan all already emitted inside
        } catch (err) {
          if (signal.aborted) throw err; // let the outer catch report cancellation
          lastErr = err;
          if (attempt < MAX_ATTEMPTS) {
            // FIX: exactly ONE retry, done immediately in the same call -
            // not via requeueing into goalQueue. The old requeue-based
            // approach allowed up to 2 requeues (3 total attempts) LAYERED
            // on top of llm.cjs's own internal retry (2 attempts per
            // call), which could multiply into 6+ actual network requests
            // for one failing goal - each one further loading an already
            // struggling backend, and each requeue had to wait for the
            // next scheduler tick, silently extending how long a genuine
            // failure took to finally get reported. This is simpler and
            // predictable: try, retry once immediately, then stop and
            // report clearly - matching how the iOS client behaves (one
            // attempt, fail fast) with exactly one extra try for
            // transient failures, no more.
            this.log.warn(`Goal failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying once:`, err.message);
            continue;
          }
        }
      }

      // Every attempt failed.
      this.log.error(`Goal failed after ${MAX_ATTEMPTS} attempt(s):`, lastErr);
      this.setState(STATES.ERROR);
      this.emit("goal:error", { entry, error: lastErr });
    } catch (err) {
      this.log.info("Goal cancelled:", goal);
      this.emit("goal:cancelled", entry);
    } finally {
      this.setState(this.state === STATES.STOPPING ? STATES.STOPPING : STATES.IDLE);
    }
  }

  // One observe -> plan -> permission -> execute pass. Returns normally
  // on success/complete/blocked (already emitted the relevant event), or
  // the string "paused" if an action asked to pause, or throws on any
  // step failure so the caller in _executeGoal can decide whether to
  // retry. Pulled out of _executeGoal so the retry loop above can call
  // this fresh each attempt without re-running its own try/catch/finally
  // (which previously risked a race between a retry's state changes and
  // the prior attempt's own state reset).
  async _runAgentAttempt(entry, signal) {
    const { goal } = entry;

    // FIX: starts minimal every attempt - the model must explicitly ask
    // for the full page dump (via a lone {"type":"observe"} action) if
    // it needs to see buttons/inputs/links/text, rather than receiving
    // that whole payload by default on every single cycle. See
    // llm.cjs's predict() for the other half of this.
    let detailLevel = "minimal";

    while (this.running && !signal.aborted) {
      this.setState(STATES.OBSERVING);
      const observation = await this._withRecovery(
        () =>
          withTimeout(
            this.observer.observe({ vision: this.vision }),
            this.options.stepTimeoutMs,
            "observe"
          ),
        { step: "observe", signal }
      );
      this.memory.updateObservation(observation);

      this.setState(STATES.PLANNING);
      console.log("==================================");
      console.log("🧠 BEFORE PLANNER");
      console.log("Goal:", goal);
      console.log("Observed URL:", observation?.browser?.url);
      console.log("Observed Title:", observation?.browser?.title);
      console.log("State:", this.state);
      console.log("==================================");


      console.log("========== BEFORE planner.plan() ==========");

      // FIX: uses withAbortableTimeout instead of withTimeout so that
      // when planTimeoutMs elapses, the underlying llm.predict() fetch
      // actually gets cancelled (via the fresh per-step signal handed to
      // planner.plan()) instead of being abandoned to keep running
      // against the server in the background indefinitely. See
      // withAbortableTimeout's own comment for the full explanation.
      const plan = await this._withRecovery(
          () =>
              withAbortableTimeout(
                  (stepSignal) =>
                      this.planner.plan({
                          goal,
                          observation,
                          memory: this.memory.export(),
                          llm: this.llm,
                          signal: stepSignal,
                          detailLevel
                      }),
                  this.options.planTimeoutMs,
                  "plan",
                  signal
              ),
          { step: "plan", signal }
      );
      console.log("==================================");
      console.log("🧠 AFTER PLANNER");
      console.dir(plan, { depth: null });
      console.log("==================================");



      if (!plan) {
        this.log.info("No plan generated.");
        return;
      }

      if (plan.complete) {
        this.log.info(" Goal Completed");
        this.emit("goal:completed", entry);
        return;
      }

      // FIX: this is the model's own request for full page detail. If
      // its plan is EXACTLY one lone {"type":"observe"} action (nothing
      // else), treat that as "I need to see the actual buttons/inputs/
      // links/text before I can decide what to do" rather than a normal
      // browser action - bump detailLevel to "full" for the NEXT
      // planning cycle only, then loop straight back to observe/plan
      // without waiting on permissions or emitting a goal:step for it
      // (there's nothing user-visible to report - the browser didn't
      // change). Any other plan shape (real actions, or observe mixed
      // with other actions) resets back to minimal, since the model
      // already has what it asked for, or didn't ask for more.
      const isLoneDetailRequest =
        Array.isArray(plan.actions) &&
        plan.actions.length === 1 &&
        plan.actions[0]?.type === "observe";

      if (isLoneDetailRequest) {
        this.log.info("🔍 Model requested full page detail for next cycle.");
        detailLevel = "full";
        continue;
      }
      detailLevel = "minimal";

      this.setState(STATES.WAITING_PERMISSION);
      const allowed = await this.permissions.validate(plan);
      console.log("PERMISSION RESULT:", allowed);
      if (!allowed) {
        this.log.info("🚫 Permission denied.");
        this.emit("goal:blocked", { entry, plan });
        return;
      }

      this.setState(STATES.EXECUTING);
      console.log("===== PLAN =====");
      console.log(plan.actions);
      for (const step of (plan.actions || [])) {

          const action = step.type;

          const args = { ...step };
          delete args.type;

          console.log("================================");
          console.log("RUNTIME -> EXECUTOR");
          console.log("Action:", action);
          console.log("Args:", JSON.stringify(args, null, 2));
          console.log("================================");

          // FIX: this used to also wrap executor.execute() in its own
          // withRetry({ retries: this.options.maxStepRetries }) on top
          // of executor.cjs's OWN per-action retry table (0 retries for
          // navigate/back/forward/stop, 1 retry for click/type/etc) -
          // the exact same multiplicative-stacking bug we fixed at the
          // goal level, just one layer down. With maxStepRetries=2 and
          // an action configured for 1 internal retry, that was up to
          // (1+2) x (1+1) = 6 actual attempts for a single failing
          // click. executor.cjs already knows, per action type, what's
          // safe to retry (re-navigating on failure is NOT safe to
          // blindly retry; a click that missed a not-yet-rendered
          // element usually is) - that table is the right place for
          // this decision, so the outer retry is removed rather than
          // duplicated.
          const result = await this._withRecovery(
              () =>
                  withTimeout(
                      this.executor.execute({
                          action,
                          args
                      }),
                      this.options.stepTimeoutMs,
                      "execute"
                  ),
              { step: "execute", signal }
          );

          this.memory.storeAction({ action, args, reasoning: plan.reason }, result);

          this.emit("goal:step", {
              entry,
              plan: step,
              result
          });

          // ask_user (or any future action marked `paused`) must stop
          // the loop cold and wait for a brand-new user goal — not
          // silently continue into another planning cycle, which is
          // what was causing repeated navigate attempts after the
          // model had already asked for guidance.
          if (result.paused) {
              this.log.info("⏸ Goal paused, waiting for user:", result.message);
              this.emit("goal:paused", { entry, plan: step, result });
              return "paused";
          }

      }



      this.setState(STATES.PLANNING === this.state ? STATES.PLANNING : this.state);
    }
  }


  // Wraps a step function with logging + last-ditch error recovery so a
  // single bad observation/plan/execute doesn't necessarily kill the goal.
  async _withRecovery(fn, { step, signal }) {
    try {
      return await fn();
    } catch (err) {
      if (signal?.aborted) throw err;
      this.log.error(`Step "${step}" failed`, err);
      const recovered = await this._handleError(err, { step });
      if (recovered !== undefined) return recovered;
      throw err;
    }
  }

  async _handleError(err, ctx) {
    this.emit("error:recovery", { err, ctx });
    // Hook point: plug in domain-specific recovery strategies, e.g.
    // reloading the page on a detached-frame error, or re-authenticating
    // on a 401 from the LLM client. Returning undefined means "no
    // recovery available", propagating the original error.
    if (ctx.step === "observe" && /detached|context/i.test(err.message)) {
      this.log.warn("Attempting observer recovery: re-attaching to page");
      try {
        await this.observer.reattach?.();
        return await this.observer.observe({ vision: this.vision });
      } catch (_) {
        return undefined;
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------
  // IPC bridge
  // -------------------------------------------------------------------

  _registerIPC() {
    this._ipcHandlers = {
      "rexy:submit-goal": (_e, goal, opts) => this.submitGoal(goal, opts),
      "rexy:cancel-goal": (_e, goalId) => this.cancelGoal(goalId),
      "rexy:get-state": () => ({
        state: this.state,
        queue: this.goalQueue.list(),
        currentGoal: this.currentGoalEntry,
      }),
      // REMOVED: "rexy:start" and "rexy:stop" — main.cjs already registers
      // these at the top level and calls rexyRuntime.start()/.stop() directly.
      // Registering them again here crashes the constructor.
    };
    for (const [channel, handler] of Object.entries(this._ipcHandlers)) {
      ipcMain.handle(channel, handler);
    }
  }

  _unregisterIPC() {
    for (const channel of Object.keys(this._ipcHandlers || {})) {
      ipcMain.removeHandler(channel);
    }
  }

  _notifyRenderer(channel, payload) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, payload);
    }
  }

  // -------------------------------------------------------------------
  // Browser event listeners
  // -------------------------------------------------------------------

  _registerBrowserListeners() {
    const wc = this.window?.webContents;
    if (!wc) return;

    wc.on("did-navigate", (_e, url) => {
      this.log.debug("Navigated:", url);
      this.emit("browser:navigate", url);
    });

    wc.on("did-fail-load", (_e, code, desc, url) => {
      this.log.warn("Load failed:", url, desc);
      this.emit("browser:load-failed", { code, desc, url });
    });

    wc.on("crashed", () => {
      this.log.error("Renderer crashed");
      this.emit("browser:crashed");
      this.stop("renderer crashed");
    });

    this.window.on("closed", () => {
      this.shutdown().catch((err) => this.log.error("Shutdown on close failed", err));
    });
  }

  // -------------------------------------------------------------------
  // Internal event bus wiring (voice -> goals, vision -> memory, etc.)
  // -------------------------------------------------------------------

  _registerInternalListeners() {
    this.voice.on?.("command", (text) => {
      this.log.info("🎙️ Voice command:", text);
      this.submitGoal(text, { priority: 1 });
    });

    // FIX: both _runChatGoal and _executeGoal now retry exactly once,
    // inline, before ever emitting goal:error - so by the time this
    // fires, every attempt this goal is entitled to has already
    // happened. No more requeueing into goalQueue here: that was the
    // layer responsible for the old 3-total-attempts-per-goal behavior
    // (this listener requeuing up to 2x on top of each attempt's own
    // llm.cjs-level retries), which is exactly what let a single
    // failing goal pile up multiple concurrent/overlapping requests
    // against an already-struggling backend. This listener is now pure
    // logging/telemetry - the goal is genuinely done, one way or another.
    this.on("goal:error", ({ entry, error }) => {
      this.log.warn(`Goal [${entry.kind || "agent"}] gave up:`, entry.goal, "-", error?.message);
    });
  }
}

module.exports = RexyRuntime;
module.exports.STATES = STATES;