// Noah/agent/noah-agent.cjs
//
// NoahAgent: the orchestrator (spec §14). One task at a time:
//
//   USER TASK -> triage/plan -> loop { OBSERVE (AX + optional screenshot) -> DECIDE (routed model)
//     -> validate -> for each action { SAFETY gate -> EXECUTE -> VERIFY } -> assess/recover -> checkpoint }
//     -> finish
//
// What lives where:
//   models/router      which model reasons (role routing, failover that never silently downgrades)
//   perception/*       what Noah can see (AX tree, page text, screenshot, geometry)
//   agent/executor     how an action really happens (target resolution, safety, input, verification)
//   safety/*           what is allowed (independent of the model), emergency stop, takeover
//   agent/recovery     what to try next when things go wrong
//   agent/task-state   checkpoints so a crash does not lose the task
//
// The loop is deliberately model-stateless: each step gets a fresh compact observation plus a small
// task memory instead of an ever-growing transcript (no screenshot pile-up, flat cost per step).

"use strict";

const { EventEmitter } = require("events");
const { randomBytes, randomUUID } = require("crypto");
const path = require("path");

const { validateEnvelope, toolSchema, redactAction } = require("../protocol/actions.cjs");
const { systemPrompt, STEP_TOOL_DESCRIPTION, COORD_DOC } = require("./prompts.cjs");
const { buildStepMessage } = require("./context.cjs");
const { TaskStore, TERMINAL } = require("./task-state.cjs");
const { TaskMemory, BrowserMemory, PreferenceStore } = require("./memory.cjs");
const { RecoveryEngine } = require("./recovery.cjs");
const { Planner, triage } = require("./planner.cjs");
const perceptionPolicy = require("./perception-policy.cjs");
const { extractJson } = require("../models/base.cjs");
const { RouterError } = require("../models/router.cjs");
const { StoppedError } = require("../computer/input.cjs");
const { humanNavigationBlock } = require("./human-nav.cjs");
const { decideAsk, norm } = require("./ask-policy.cjs");
const { slog } = require("./lifecycle-log.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BARRIER_SIGNALS = ["url_changed", "tab_count_changed", "active_tab_changed", "dialog_opened", "download_started"];
const NAV_ACTIONS = new Set(["navigate", "back", "forward", "reload", "new_tab", "switch_tab", "close_tab"]);

class TaskLimitError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * Race a promise against the emergency-stop signal. On stop the caller gets a StoppedError immediately instead of
 * waiting for an in-flight page read or action (a big page under load took seconds); the abandoned promise is
 * left to settle on its own and cleanup (releaseAll -> detach) cuts any CDP call still pending.
 */
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { promise.catch(() => {}); return Promise.reject(new StoppedError()); }
  return new Promise((resolve, reject) => {
    const onAbort = () => { promise.catch(() => {}); reject(new StoppedError()); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); }
    );
  });
}

class ToolTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.code = "tool_timeout";
  }
}

/**
 * abortable() plus a deadline. Every browser read and every action goes through this: a page or a tool that never answers
 * ends THAT step with a clear error instead of leaving the run (and the UI) waiting forever.
 */
function timed(promise, signal, ms, what) {
  promise.catch(() => {}); // an abandoned call must never become an unhandled rejection
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const end = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      end();
      reject(new StoppedError());
    };
    timer = setTimeout(() => {
      if (settled) return;
      end();
      reject(new ToolTimeoutError(`${what} did not respond within ${Math.round(ms / 1000)}s`));
    }, ms);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { if (!settled) { end(); resolve(v); } },
      (e) => { if (!settled) { end(); reject(e); } }
    );
  });
}

const ACTION_LABEL = {
  click: "Clicking", double_click: "Clicking", right_click: "Clicking", hover: "Moving the pointer", drag: "Dragging",
  type: "Typing", key_press: "Pressing a key", hotkey: "Pressing a key", scroll: "Scrolling", wait: "Waiting for the page",
  read_page: "Reading the page", find_element: "Looking on the page", back: "Going back", forward: "Going forward",
  reload: "Reloading the page", new_tab: "Opening a tab", switch_tab: "Switching tabs", close_tab: "Closing a tab",
};
/** What the user sees while a step runs: derived from the ACTION, never from the model's own words (no chain-of-thought in the UI). */
function describeAction(action) {
  if (!action) return "Working…";
  if (action.action === "navigate") {
    try {
      return `Opening ${new URL(action.url).hostname.replace(/^www\./, "")}…`;
    } catch (_) {
      return "Opening the page…";
    }
  }
  return `${ACTION_LABEL[action.action] || "Working"}…`;
}

/** Internal failures -> one sentence a person can act on. */
function friendlyError(err) {
  const m = String((err && err.message) || err || "");
  if (err && err.code === "tool_timeout") return `${m}. The page may be busy or frozen: try again in a moment.`;
  if (/no active browser context|no tab|target closed|detached|session closed|inspected target|was destroyed|object has been destroyed/i.test(m)) return "The tab I was working in was closed or changed. Open the page again and tell me to continue.";
  // a raw CDP timeout ("Page.getFrameTree timed out after 8000ms") is a frozen or still-loading page
  if (/\b(?:Page|DOM|Runtime|Input|Accessibility|Target|Emulation)\.\w+ (?:timed out|failed)|dialog_open/i.test(m)) return "The page stopped responding (it may be frozen, still loading, or showing a dialog), so I stopped. Try again in a moment.";
  if (/econnrefused|enotfound|etimedout|fetch failed|network/i.test(m)) return "I could not reach the model just now (network problem). Try again in a moment.";
  return m || "Something went wrong.";
}

/** A model outage in one sentence a person can act on (auth problems keep their specific hint). */
function friendlyRouterError(err) {
  const codes = ((err.details && err.details.failures) || []).map((f) => f.code);
  if (err.code === "ALL_FAILED" && codes.length && codes.every((c) => ["network", "timeout", "overloaded", "unknown"].includes(c))) {
    return "I could not reach the AI model just now, so I stopped. Check your connection and try again in a moment.";
  }
  return err.message;
}

/** AbortController that fires when `signal` aborts or after `ms`. */
function withTimeout(signal, ms) {
  const c = new AbortController();
  const onAbort = () => c.abort();
  if (signal?.aborted) c.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); }, timedOut: () => !signal?.aborted && c.signal.aborted };
}

class NoahAgent extends EventEmitter {
  /**
   * @param {object} o
   * @param {ReturnType<import('../core.cjs').createCore>} o.core
   * @param {import('../models/router.cjs').ModelRouter} o.router
   * @param {import('../config.cjs').ConfigStore} o.config
   * @param {string} o.dataDir
   */
  constructor({ core, router, config, dataDir, log = () => {} }) {
    super();
    this.core = core;
    this.router = router;
    this.config = config;
    this.log = log;
    this.bus = core.bus;
    this.session = core.session;
    this._last = { key: "", at: 0, id: null };
    this.store = new TaskStore({ dir: path.join(dataDir, "tasks") });
    this.prefs = new PreferenceStore({ file: path.join(dataDir, "preferences.json") });
    this.browserMemory = new BrowserMemory();
    this.planner = new Planner({ router, log });
    this.queue = [];
    this.current = null;
    this._interrupted = this.store.markInterrupted();
    this.store.prune();
    this._unsub = this.bus.subscribe((e) => {
      if (e.event === "recovery" && this.current) this.current.run.metrics.laddersUsed = (this.current.run.metrics.laddersUsed || 0) + 1;
      if (e.event === "model_failover" && this.current) this.current.run.metrics.failovers++;
    });
  }

  dispose() {
    this._unsub?.();
  }

  isAvailable() {
    return this.config.get().enabled !== false && this.router.isAvailable();
  }

  state() {
    const t = this.current?.task;
    const session = this.session.snapshot();
    return t ? { status: t.status, taskId: t.id, goal: t.goal, step: t.step, paused: this.core.safety.paused, queued: this.queue.length, session } : { status: "idle", queued: this.queue.length, interruptedTasks: this.store.list().filter((x) => x.status === "interrupted").length, session };
  }

  listTasks() {
    return this.store.list();
  }

  // --------------------------------------------------------------------- queue

  /**
   * One instruction in. There is one session; this starts (or queues) one RUN inside it.
   *   idle                     -> the run starts
   *   a run is working         -> the newest instruction waits its turn (one place in line: a newer one replaces an older one)
   *   the run is paused / asking the user / waiting for a confirmation
   *                            -> the new instruction REPLACES it: the user has moved on. The session, its tab and its
   *                               context stay; only the old run ends.
   *   the same words twice within 4 s (voice + text, double tap) -> one run
   * @param {string} goal
   * @param {{ source?: 'voice'|'text'|'ui', followUp?: boolean, context?: object }} [opts]
   */
  submit(goal, opts = {}) {
    const text = String(goal || "").trim();
    const source = opts.source || "text";
    const key = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const now = Date.now();
    if (key && this._last.key === key && now - this._last.at < 4000 && this._last.id) {
      slog("AGENT_RUN_DEDUPED", { source, goal: text.slice(0, 80) });
      return this._last.id;
    }
    const task = this.store.create(text, opts);
    task.source = source;
    task.followUp = !!opts.followUp;
    const run = this._newRun();
    run.source = source;
    run.followUp = !!opts.followUp;
    run.context = opts.context || null;
    const entry = { task, run };
    const safety = this.core.safety;
    if (this.current && (safety.paused || safety.hasPendingConfirmation())) {
      this.current.run.superseded = true;
      this._dropQueued("superseded by a newer instruction");
      this.queue.push(entry);
      safety.stop("superseded");
    } else if (this.current) {
      this._dropQueued("replaced by a newer instruction");
      this.queue.push(entry);
    } else {
      this.queue.push(entry);
    }
    this._last = { key, at: now, id: task.id };
    setImmediate(() => this._drain());
    return task.id;
  }

  _dropQueued(why) {
    for (const q of this.queue.splice(0)) {
      q.task.status = "cancelled";
      q.task.failureReason = why;
      this.store.save(q.task);
    }
  }

  /** Stop what is running and forget what is waiting. The session, its tab and its context stay. */
  stop(reason = "user") {
    this._dropQueued("stopped");
    if (this.current) this.core.safety.stop(reason);
    return { ok: true };
  }

  pause() {
    if (!this.current) return { ok: false, reason: "idle" };
    this.core.safety.pause("user");
    return { ok: true };
  }

  /** "Continue": carries on the SAME run. Never approves a confirmation (that needs the card, not a spoken word). */
  resume() {
    const safety = this.core.safety;
    if (safety.hasPendingConfirmation()) return { ok: false, reason: "needs_confirmation" };
    if (!safety.paused) return { ok: false, reason: "not_paused" };
    safety.resume();
    return { ok: true };
  }

  async resumeTask(taskId) {
    const t = this.store.load(taskId);
    if (!t) throw new Error("unknown task");
    if (TERMINAL.has(t.status)) throw new Error(`task already ${t.status}`);
    t.status = "queued";
    t.resumedFrom = t.checkpointSeq;
    this.queue.push({ task: t, run: this._newRun(), resumed: true });
    setImmediate(() => this._drain());
    return t.id;
  }

  _newRun() {
    return { id: randomUUID().slice(0, 8), superseded: false, source: "text", followUp: false, context: null, asked: new Set(), typed: new Set(), metrics: { localSteps: 0, timeouts: 0, steps: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, actions: 0, actionFailures: 0, screenshots: 0, screenshotBytes: 0, obsChars: 0, obsTokensEst: 0, invalidResponses: 0, failovers: 0, laddersUsed: 0, byCategory: {}, modelLatencyMs: 0, startedAt: Date.now(), pausedMs: 0 } };
  }

  async _drain() {
    if (this.current || !this.queue.length) return;
    const next = this.queue.shift();
    this.current = next;
    try {
      await this._run(next);
    } catch (err) {
      this.log("task crashed:", err.stack || err.message);
    } finally {
      this.current = null;
      if (this.queue.length) setImmediate(() => this._drain());
    }
  }

  // ------------------------------------------------------------------- one task

  async _run({ task, run, resumed }) {
    const { core } = this;
    const { safety, browser, bus } = core;
    const cfg = () => this.config.get();
    const memory = resumed ? TaskMemory.restore(task.goal, task.id, task.memory) : new TaskMemory({ goal: task.goal, taskId: task.id });
    Object.assign(task, { status: "running" });
    safety.beginTask(task.id);
    bus.setTask(task.id);
    this.session.runStarted({ runId: run.id, taskId: task.id, goal: task.goal, source: run.source, followUp: run.followUp });
    core.monitor.start();
    core.executor.setGoalLine(task.goal);
    core.executor.wantVisual = false;
    const t0 = Date.now();
    bus.publish("task_started", { taskId: task.id, goal: task.goal, resumed: !!resumed });
    this.store.save(task);
    let finished = false;
    let finalPayload = null;
    const finish = (status, extra = {}) => {
      if (finished) return;
      finished = true;
      task.status = status;
      Object.assign(task, extra);
      task.memory = memory.snapshot();
      task.budgets = { ...task.budgets, ...run.metrics, elapsedMs: Date.now() - t0 - run.metrics.pausedMs };
      this.store.save(task);
      const metrics = { ...run.metrics, elapsedMs: Date.now() - t0 - run.metrics.pausedMs, models: this.router.stats.byModel };
      bus.publish("task_finished", { taskId: task.id, status, result: task.result, error: task.failureReason, metrics, steps: task.step, superseded: run.superseded });
      this.session.runFinished(status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed", { result: task.result, error: task.failureReason, superseded: run.superseded });
      finalPayload = { task, metrics };
    };

    try {
      if (cfg().sessionMode === "isolated") {
        // Sandbox: never touch the user's own tabs. Work in a fresh tab that has no access to the user's cookies.
        await timed(browser.newTab(""), safety.signal, 20000, "Opening a tab");
      }
      await timed(browser.current({ activate: true }), safety.signal, 20000, "The browser tab");

      // ---- 1. analysis + plan
      let triageInfo = triage(task.goal);
      if (!task.plan && run.followUp) {
        // a follow-up ("continue the story") is one step of the work already in progress: no planning round trip
        task.plan = { objective: task.goal, complexity: "simple", steps: [task.goal], success_criteria: [], sensitive: triageInfo.sensitive, needs_visual: false, sites: [], source: "follow_up" };
      }
      if (!task.plan) {
        task.status = "planning";
        const p = await this.planner.plan(task.goal, { signal: safety.signal, sensitive: triageInfo.sensitive });
        task.plan = p.plan;
        if (p.usage) {
          run.metrics.modelCalls += p.calls;
          run.metrics.inputTokens += p.usage.inputTokens || 0;
          run.metrics.outputTokens += p.usage.outputTokens || 0;
        }
        bus.publish("plan", { plan: task.plan });
      }
      // Which model is trusted to run this task is a code-enforced decision, not something a model gets to talk itself
      // into: use OUR classifier (triage's regex over the goal text), not the planner MODEL's own "this feels sensitive"
      // guess. A real user's benign task ("fill in my name and email on a feedback form and submit it") was refused
      // outright - "No TRUSTED model is available" - purely because the planner model guessed sensitive when our own
      // classifier correctly did not. Individual risky ACTIONS (typing into a password/payment field, leaving a
      // sensitive site) still go through their own, separate confirmation gate in safety/risk.cjs regardless of this
      // flag, so nothing here weakens that: this only decides which model is allowed to choose the actions.
      task.sensitive = triageInfo.sensitive;
      this.store.save(task);

      // ---- 2. the loop
      await this._loop({ task, run, memory, finish, cfg });
    } catch (err) {
      if (err instanceof StoppedError || err.code === "STOPPED" || safety.stopped) {
        finish("cancelled", { failureReason: "Stopped by the user" });
      } else if (err instanceof TaskLimitError) {
        finish("failed", { failureReason: err.message });
      } else if (err instanceof RouterError) {
        finish("failed", { failureReason: friendlyRouterError(err), failureCode: err.code });
      } else {
        this.log("task error:", err.stack || err.message);
        finish("failed", { failureReason: friendlyError(err), failureCode: err.code });
      }
    } finally {
      finish("failed", { failureReason: task.failureReason || "ended unexpectedly" }); // no-op if already finished
      core.monitor.stop();
      safety.endTask();
      await browser.releaseAll().catch(() => {});
      bus.setTask(null);
      // consumers of "finished" may assume the browser is detached and input released
      if (finalPayload) this.emit("finished", finalPayload);
    }
  }

  async _loop({ task, run, memory, finish, cfg }) {
    const { core, router } = this;
    const { safety, browser, bus, executor } = core;
    const recovery = new RecoveryEngine({ maxConsecutiveFailures: cfg().limits.maxConsecutiveFailures });
    const nonce = randomBytes(9).toString("hex");
    let previous = null; // { url, lines } for observation diffing
    let previousObs = null;
    let results = [];
    let feedback = [];
    let toolOutputs = [];
    let needVisual = false;
    let forceVisualOnce = false;
    let lastAssessment = null;
    let invalidStreak = 0;
    let doneRejections = 0;

    this.session.runExecuting();
    for (;;) {
      const lim = cfg().limits;
      this._checkBudgets(task, run, lim);
      await this._waitRunning(safety, run);
      safety.guard();
      task.step++;
      run.metrics.steps++;
      task.status = "observing";

      // ---- perception: choose layers
      const pol = perceptionPolicy.choose({
        configMode: cfg().perception?.perceptionMode || "auto",
        previousObs, lastAssessment, needVisual: needVisual || executor.wantVisual, pendingZoom: !!executor.pendingImage, forceVisualOnce, step: task.step,
      });
      needVisual = false;
      executor.wantVisual = false;
      forceVisualOnce = false;
      // A text-only model (the legacy Rexy backend) cannot read pixels: when nothing vision-capable is usable, stay on
      // AX/text perception instead of failing the whole task with "no vision model".
      if (pol.screenshot && !router.usable("browser", { needsVision: true, sensitive: task.sensitive }).length) pol.screenshot = false;
      const role = pol.screenshot ? "vision" : "browser";
      const primary = router.usable(role, { needsVision: pol.screenshot, sensitive: task.sensitive })[0];
      const info = primary?.info || {};
      const coordinateSpace = info.coordinateSpace || "image_px";

      const shotOpts = { ...(cfg().perception.screenshot || {}), coordinateSpace };
      shotOpts.maxLongEdge = Math.min(shotOpts.maxLongEdge || 1280, info.maxImageLongEdge || 1280);
      let obs;
      try {
        obs = await timed(browser.observe({ screenshot: pol.screenshot, deep: pol.deep, screenshotOptions: shotOpts }), safety.signal, lim.observeTimeoutMs || 30000, "The page");
      } catch (err) {
        if (err.code === "STOPPED") throw err;
        // a page that cannot be read (crashed, mid-navigation, detached) -> wait once and retry the observation
        this.log("observe failed:", err.message);
        if (err.code === "tool_timeout") run.metrics.timeouts++;
        await sleep(400);
        obs = await timed(browser.observe({ screenshot: false, deep: false }), safety.signal, lim.observeTimeoutMs || 30000, "The page");
      }
      memory.addVisited(obs.url, obs.title);
      this.browserMemory.notePage(obs.url, obs.title);
      task.browserState = { tabId: browser.targetTabId, url: obs.url, title: obs.title };
      this.session.updateBrowser({ tabId: browser.targetTabId, url: obs.url, title: obs.title, pageReady: !obs.loading }, "observe");
      if (obs.security?.tainted) task.taint = { tainted: true, reasons: safety.taintReasons };
      if (obs.screenshot) {
        run.metrics.screenshots++;
        run.metrics.screenshotBytes += obs.screenshot.bytes;
      }
      const zoomImage = executor.pendingImage;
      executor.pendingImage = null;

      // ---- compose the prompt
      const plan = task.plan?.complexity === "trivial" ? null : task.plan;
      const msg = buildStepMessage({
        goal: task.goal, plan, memory, results, feedback, toolOutputs,
        observation: obs, nonce, previous,
        image: obs.screenshot, zoomImage,
        coordinateNote: obs.screenshot ? `A screenshot (${obs.screenshot.width}x${obs.screenshot.height}) of the current viewport follows this text; coordinates you emit refer to it.` : undefined,
        budgets: { ...(cfg().perception.tokenBudget || {}), step: task.step },
      });
      run.metrics.obsChars += msg.stats.chars;
      run.metrics.obsTokensEst += Math.ceil(msg.stats.chars / 3.6) + msg.stats.images * 1000;
      previous = { url: obs.url, lines: msg.lines };
      previousObs = obs;
      feedback = [];
      toolOutputs = [];

      // ---- decide (routed model)
      task.status = "executing";
      const to = withTimeout(safety.signal, lim.stepTimeoutMs || 60000);
      let res;
      try {
        res = await router.call(
          role,
          {
            system: systemPrompt({ nonce, coordinateSpace, platform: process.platform === "darwin" ? "macOS" : "Windows" }),
            messages: [{ role: "user", content: msg.content }],
            tools: [{ name: "noah_step", description: STEP_TOOL_DESCRIPTION, parameters: toolSchema() }],
            toolChoice: "noah_step",
            maxTokens: 1600,
            signal: to.signal,
            timeoutMs: lim.stepTimeoutMs || 60000,
            meta: { goal: task.goal, observation: obs, taskId: task.id, step: task.step, recentActions: memory.entries.slice(-6), plan: task.plan, results, feedback: msg.feedback, context: run.context, followUp: run.followUp },
          },
          { sensitive: task.sensitive, needsVision: pol.screenshot, signal: to.signal }
        );
      } catch (err) {
        if (safety.stopped) throw new StoppedError();
        if (err.code === "aborted" && to.timedOut()) throw new TaskLimitError(`The model did not answer within ${Math.round((lim.stepTimeoutMs || 60000) / 1000)}s`, "model_timeout");
        throw err;
      } finally {
        to.done();
      }
      // steps the adapter worked out by itself (typing a script, scrolling, waiting) are not model calls: only real round trips count
      if (res.local) {
        run.metrics.localSteps++;
        run.metrics.modelCalls += res.remoteCalls || 0;
      } else {
        run.metrics.modelCalls++;
      }
      run.metrics.inputTokens += res.usage?.inputTokens || 0;
      run.metrics.outputTokens += res.usage?.outputTokens || 0;
      run.metrics.modelLatencyMs += res.latencyMs || 0;
      safety.guard();

      // ---- parse + validate
      const call = res.toolCalls.find((c) => c.name === "noah_step") || res.toolCalls[0];
      const raw = call?.args && Object.keys(call.args).length ? call.args : extractJson(res.text);
      const v = validateEnvelope(raw);
      if (!v.ok) {
        run.metrics.invalidResponses++;
        invalidStreak++;
        if (invalidStreak >= 3) throw new TaskLimitError(`The model kept returning invalid responses (${v.error})`, "invalid_model_output");
        feedback.push(`Your last response was invalid: ${v.error}. Call noah_step with valid arguments.`);
        results = [];
        continue;
      }
      invalidStreak = 0;
      const env = v.envelope;
      if (env.errors.length) feedback.push(`Some of your actions were ignored: ${env.errors.join("; ")}`);
      memory.addNotes(env.notes);
      if (env.remember.length) this.prefs.propose(env.remember, (r) => safety.confirm(r)).catch(() => {});
      if (env.needVisual) needVisual = true;
      if (env.actions.length) this.session.note(describeAction(env.actions[0]));
      bus.publish("step", { n: task.step, summary: env.summary, method: env.method, status: env.status, actions: env.actions.map((a) => redactAction(a)), model: `${res.provider}:${res.modelId}`, perception: pol.screenshot ? "hybrid" : "text", perceptionReason: pol.reason });

      // ---- finish / ask / give up
      if (env.status === "done") {
        if (!env.result && doneRejections < 2) {
          doneRejections++;
          feedback.push('You set status "done" without a "result". Put the final answer for the user in "result".');
          results = [];
          continue;
        }
        task.result = env.result || env.summary || "Done.";
        task.completedSteps.push(env.summary);
        this._recordHistory(task, env, []);
        return finish("completed", { result: task.result });
      }
      if (env.status === "give_up") {
        this._recordHistory(task, env, []);
        return finish("failed", { failureReason: env.summary || "Noah could not complete the task." });
      }
      if (env.status === "ask_user") {
        const question = env.summary || env.actions.find((a) => a.action === "ask_user")?.question;
        const verdict = decideAsk({ question, obs, asked: run.asked, autoDecide: cfg().autoDecide });
        if (verdict.ask) {
          run.asked.add(norm(question));
          await this._askUser(question, safety, bus, run, task);
          feedback.push("The user handled your request and pressed Resume. Observe the page again before continuing.");
        } else {
          // not something only a person can do: Noah re-reads the page and decides for itself
          this._selfDecide(run, question);
          feedback.push("Do NOT ask the user. Decide by yourself: re-read the page and take the most sensible next action; if the goal is ambiguous, take the most reasonable interpretation and continue.");
          previous = null;
        }
        forceVisualOnce = true;
        results = [];
        recovery.consecutiveFailures = 0;
        continue;
      }

      // ---- execute the batch, verifying after EVERY action
      const executed = [];
      let halted = null;
      for (let i = 0; i < env.actions.length; i++) {
        const action = env.actions[i];
        if (halted) {
          executed.push({ action, result: { ok: false, code: "not_executed", message: halted, skipped: true } });
          continue;
        }
        if (action.action === "ask_user") {
          const verdict = decideAsk({ question: action.question, obs, asked: run.asked, autoDecide: cfg().autoDecide });
          if (verdict.ask) {
            run.asked.add(norm(action.question));
            await this._askUser(action.question, safety, bus, run, task);
            executed.push({ action, result: { ok: true, message: "the user handled it", method: "browser" } });
          } else {
            this._selfDecide(run, action.question);
            executed.push({ action, result: { ok: true, message: "not asked: Noah decides this itself. Re-read the page and choose the next action.", method: "browser" } });
            previous = null;
          }
          forceVisualOnce = true;
          continue;
        }
        this.session.note(describeAction(action));
        run.metrics.actions++;
        await this._waitRunning(safety, run);
        // "Act like a person": inside a site, do not jump to a constructed URL (see agent/human-nav.cjs).
        const why = action.action === "navigate" && cfg().humanLike !== false ? humanNavigationBlock({ url: action.url, goal: task.goal, currentUrl: obs.url, elements: obs.elements }) : null;
        // "Once, not all the time": the same text typed into the same field on the same page is not typed a second time
        let typeKey = null;
        let dupType = false;
        if (action.action === "type" && action.text && cfg().humanLike !== false) {
          typeKey = [obs.url, JSON.stringify(action.target || "focused"), action.text.length, action.text.slice(0, 40), action.text.slice(-20)].join("|");
          dupType = run.typed.has(typeKey);
        }
        const result = why
          ? { ok: false, action: "navigate", code: "use_the_page", message: why, method: "browser" }
          : dupType
          ? { ok: false, action: "type", code: "already_done", message: "This exact text was already typed here. Do NOT type it again: go on with the next step of the goal, or finish with status \"done\".", method: "browser" }
          : await this._execute(action, safety, lim, run);
        if (result.ok && typeKey) run.typed.add(typeKey);
        if (result.ok && action.action === "type" && action.text) this.session.noteWritten(action.text);
        executed.push({ action, result });
        if (!result.ok) {
          run.metrics.actionFailures++;
          run.metrics.byCategory[result.code || "error"] = (run.metrics.byCategory[result.code || "error"] || 0) + 1;
          halted = "Not executed: an earlier action in this batch failed.";
          continue;
        }
        if (result.data?.text && ["read_page", "find_element"].includes(action.action)) toolOutputs.push({ action: action.action, text: String(result.data.text).slice(0, 14000) });
        // state-transition barrier: if the page changed in a way the rest of the batch did not anticipate, stop and re-observe
        const sig = result.verification?.signals || [];
        const remaining = i < env.actions.length - 1;
        if (remaining && (NAV_ACTIONS.has(action.action) || sig.some((s) => BARRIER_SIGNALS.includes(s)))) {
          halted = "Not executed: the page or tab changed after the previous action; observe the new state first.";
        }
      }

      // ---- assess, recover, remember, checkpoint
      task.status = "verifying";
      lastAssessment = recovery.assess(executed, { url: obs.url });
      run.metrics.recoveries = recovery.recoveries + (run.metrics.laddersUsed || 0);
      results = executed.map(({ action, result }, i) => this._resultLine(i + 1, action, result));
      feedback.push(...lastAssessment.notes);
      if (lastAssessment.forceVisual) forceVisualOnce = true;
      if (lastAssessment.refresh) previous = null;
      const doneActions = executed.filter((e) => !e.result.skipped);
      memory.addResults(task.step, doneActions);
      this._recordHistory(task, env, doneActions);
      task.lastAction = doneActions.length ? redactAction(doneActions[doneActions.length - 1].action) : null;
      task.nextAction = null;
      task.memory = memory.snapshot();
      task.budgets = { ...task.budgets, ...run.metrics };
      this.store.save(task);

      // user denied / hard policy stop on a sensitive path: do not let the model route around it silently
      if (lastAssessment.escalate) {
        if (cfg().autoDecide === false) {
          await this._askUser(lastAssessment.escalate.question, safety, bus, run, task);
          feedback.push("The user answered your question by resuming; observe again and continue.");
        } else {
          // stuck (a loop, or repeated failures): do not hand the problem to the person. Re-read the page and try a
          // different approach; give up with an honest message only after several genuine attempts.
          run.metrics.escalations = (run.metrics.escalations || 0) + 1;
          if (run.metrics.escalations > 3) throw new TaskLimitError(`Noah got stuck (${lastAssessment.escalate.reason}) and could not find a way forward after several different attempts.`, "stuck");
          feedback.push(`You are stuck (${lastAssessment.escalate.reason}). Do not repeat what failed. Re-read the page and try a genuinely different approach: another element, scrolling, a keyboard shortcut, or a screenshot.`);
          previous = null;
        }
        recovery.consecutiveFailures = 0;
        forceVisualOnce = true;
      }
    }
  }

  // ------------------------------------------------------------------- helpers

  /** Run one action with a deadline that fits it (long typing legitimately takes a while); a hang becomes an ordinary failed action. */
  async _execute(action, safety, lim, run) {
    const base = lim.actionTimeoutMs || 60000;
    const ms = action.action === "type" && action.text ? Math.max(base, 30000 + action.text.length * 90) : action.action === "wait" ? Math.max(base, (Number(action.ms) || 0) + 30000) : base;
    try {
      return await timed(this.core.executor.execute(action), safety.signal, ms, `The "${action.action}" action`);
    } catch (err) {
      if (err.code !== "tool_timeout") throw err;
      run.metrics.timeouts++;
      return { ok: false, action: action.action, code: "timeout", message: `${err.message}. Re-read the page before trying again.`, method: "browser" };
    }
  }

  _resultLine(i, action, r) {
    const a = redactAction(action);
    const tgt = a.target ? (a.target.ref || (a.target.text ? `"${a.target.text}"` : `(${Math.round(a.target.x)},${Math.round(a.target.y)})`)) : a.url || a.key || a.combo || "";
    if (r.skipped) return `${i}. ${a.action} ${tgt} -> NOT EXECUTED (${r.message})`;
    if (r.ok) return `${i}. ${a.action} ${tgt} -> OK: ${String(r.message || "").slice(0, 160)} | verification: ${r.verification ? r.verification.summary : "n/a"}${r.method ? ` | via ${r.method}` : ""}`;
    const cands = r.candidates?.length ? ` Candidates: ${r.candidates.slice(0, 4).map((c) => `${c.ref || c.id}${c.name ? ` "${c.name}"` : c.title ? ` "${c.title}"` : ""}${c.ctx ? ` in "${c.ctx}"` : ""}`).join("; ")}.` : "";
    return `${i}. ${a.action} ${tgt} -> FAILED [${r.code}]: ${String(r.message).slice(0, 240)}${cands}`;
  }

  _recordHistory(task, env, executed) {
    task.history.push({ step: task.step, summary: env.summary, method: env.method, status: env.status, actions: executed.map(({ action, result }) => ({ action: action.action, ok: !!result.ok, code: result.code, verdict: result.verification?.verdict })) });
  }

  async _waitRunning(safety, run) {
    if (!safety.paused) return safety.guard();
    const t = Date.now();
    await safety.waitUntilRunning();
    run.metrics.pausedMs += Date.now() - t;
  }

  /** The model asked something a person does not need to answer: count it, and stop after a few rather than pester. */
  _selfDecide(run, question) {
    run.metrics.selfDecided = (run.metrics.selfDecided || 0) + 1;
    if (run.metrics.selfDecided > 4) throw new TaskLimitError(`Noah could not decide how to continue by itself${question ? ` (it wanted to ask: "${String(question).slice(0, 120)}")` : ""}.`, "stuck");
  }

  /** Pause for the human (login, payment, decision). Returns after Resume; throws if stopped. */
  async _askUser(question, safety, bus, run, task) {
    task.status = "paused";
    bus.publish("ask_user", { question: question || "Noah needs your help to continue." });
    safety.pause("ask_user");
    await this._waitRunning(safety, run);
    task.status = "running";
  }

  _checkBudgets(task, run, lim) {
    if (run.metrics.steps >= lim.maxSteps) throw new TaskLimitError(`Stopped after ${lim.maxSteps} steps without finishing (step limit).`, "max_steps");
    const elapsed = Date.now() - run.metrics.startedAt - run.metrics.pausedMs;
    if (elapsed > lim.maxWallMs) throw new TaskLimitError(`Stopped after ${Math.round(elapsed / 60000)} minutes (time limit).`, "max_time");
    if (run.metrics.modelCalls >= lim.maxModelCalls) throw new TaskLimitError(`Stopped after ${lim.maxModelCalls} model calls (cost limit).`, "max_calls");
  }
}

module.exports = { NoahAgent, TaskLimitError, ToolTimeoutError, timed, friendlyError, friendlyRouterError, describeAction };
