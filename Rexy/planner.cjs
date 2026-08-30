// Rexy/planner.js
//
// Planner is Noah's executive brain. Every loop iteration it is asked one
// question — "given the goal, what I've observed, and what I remember,
// what is the single next action?" — and it must answer with exactly one
// validated action (or a completion / ask-user signal).
//
// Planner never touches Electron and never talks to the network directly:
//
//   Runtime -> Planner -> llm.js -> Cloud -> Response -> Planner -> Runtime
//
// Internally it's composed of small single-purpose modules rather than
// one giant function, mirroring:
//
//   Planner
//   ├── GoalAnalyzer
//   ├── ContextBuilder
//   ├── CapabilitySelector
//   ├── PromptBuilder
//   ├── (llm.js — injected, not owned)
//   ├── PlanValidator
//   ├── RetryManager
//   ├── ErrorRecovery
//   └── GoalCompletionChecker

"use strict";
console.log("PLANNER LOADED");
console.log(__filename);
const Logger = require("./logger.cjs");

// ---------------------------------------------------------------------------
// Action schema — the contract between the LLM's output and the executor.
// Each entry declares which bridge capability it needs and which args are
// required, so the CapabilitySelector and PlanValidator both work off one
// source of truth instead of duplicating this list.
// ---------------------------------------------------------------------------

const ACTION_SCHEMA = {
  navigate: { capability: "navigation", required: ["url"] },
  reload: { capability: "navigation", required: [] },
  goBack: { capability: "navigation", required: [] },
  goForward: { capability: "navigation", required: [] },
  click: { capability: "click", required: ["selector"] },
  doubleClick: { capability: "click", required: ["selector"] },
  rightClick: { capability: "click", required: ["selector"] },
  hover: { capability: "click", required: ["selector"] },
  type: { capability: "type", required: ["selector", "text"] },
  pressKey: { capability: "type", required: ["key"] },
  scroll: { capability: "scroll", required: [] },
  scrollTo: { capability: "scroll", required: ["selector"] },
  drag: { capability: "drag", required: ["sourceSelector", "targetSelector"] },
  download: { capability: "download", required: ["selector"] },
  upload: { capability: "upload", required: ["selector", "filePath"] },
  getCookies: { capability: "cookies", required: [] },
  clearCookies: { capability: "cookies", required: [], sensitive: true },
  clearHistory: { capability: "history", required: [], sensitive: true },
  addBookmark: { capability: "bookmarks", required: ["url"] },
  observe: { capability: null, required: [] },
  extract: { capability: null, required: [] },
  newTab: { capability: "tabs", required: [] },
  closeTab: { capability: "tabs", required: [] },
  switchTab: { capability: "tabs", required: ["index"] },
  // Control actions that never require a bridge capability.
  wait: { capability: null, required: [] },
  ask_user: { capability: null, required: ["question"] },
};

const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_IDENTICAL_ACTIONS = 3;
const WAIT_BACKOFF_MS = [500, 1000, 2000, 4000];

// ---------------------------------------------------------------------------
// GoalAnalyzer — light classification of the goal, mostly to steer the
// prompt and to sanity-check obviously out-of-scope requests early rather
// than burning an LLM round trip on them.
// ---------------------------------------------------------------------------

class GoalAnalyzer {
  analyze(goal) {
    const text = String(goal || "").trim();
    const lower = text.toLowerCase();
    return {
      text,
      empty: text.length === 0,
      // crude intent hints — the LLM does the real reasoning, this is
      // just cheap metadata for logging/prompting.
      looksLikeSearch: /\bsearch\b|\bfind\b|\blook up\b/.test(lower),
      looksLikeNavigation: /\bopen\b|\bgo to\b|\bvisit\b|https?:\/\//.test(lower),
      looksLikeForm: /\bfill\b|\bsubmit\b|\blogin\b|\bsign in\b/.test(lower),
      looksDestructive: /\bdelete\b|\bwipe\b|\bclear (all|everything)\b|\buninstall\b|\bformat\b/.test(lower),
    };
  }
}

// ---------------------------------------------------------------------------
// ContextBuilder — condenses observation + memory into the compact
// structure the prompt and the LLM payload both draw from. Keeping this
// separate means the prompt text and the raw JSON context never drift out
// of sync with each other.
// ---------------------------------------------------------------------------

class ContextBuilder {
  build({ goal, observation, memory }) {
    const browser = observation?.browser || memory?.browser || {};
    const page = observation?.page || memory?.page || {};
    const tabs = observation?.tabs || memory?.tabs || [];

    return {
      goal,
      url: browser.url || null,
      title: browser.title || null,
      loading: Boolean(browser.loading),
      activeTab: browser.activeTab ?? null,
      tabCount: tabs.length,
      buttons: (page.buttons || []).filter((b) => b.visible !== false).slice(0, 25),
      inputs: (page.inputs || []).slice(0, 25),
      links: (page.links || []).slice(0, 25),
      forms: page.forms || [],
      pageTextExcerpt: (page.pageText || "").slice(0, 800),
      recentActions: memory?.recentActions || [],
      recentErrors: (memory?.errors || []).slice(-3),
      history: (memory?.history || []).slice(-10),
      task: memory?.task || null,
      capabilities: memory?.capabilities || {},
    };
  }
}

// ---------------------------------------------------------------------------
// CapabilitySelector — never let the LLM believe it can do something the
// bridge can't actually do.
// ---------------------------------------------------------------------------

class CapabilitySelector {
  allowedActions(capabilities = {}) {
    return Object.entries(ACTION_SCHEMA)
      .filter(([, spec]) => spec.capability === null || capabilities[spec.capability])
      .map(([name]) => name);
  }
}

// ---------------------------------------------------------------------------
// PromptBuilder — the highest-leverage part of the whole system. Builds a
// grounded, constrained prompt so the model proposes exactly one legal
// action instead of free-form prose.
// ---------------------------------------------------------------------------

class PromptBuilder {
  build({ context, allowedActions, goalAnalysis, recoveryNote }) {
    const lines = [];
    lines.push("You are Noah, an autonomous browser agent.");
    lines.push("");
    lines.push(`Goal: ${context.goal}`);
    if (context.task?.currentTask) lines.push(`Current sub-task: ${context.task.currentTask}`);
    if (context.task?.completed?.length) {
      lines.push(`Already completed: ${context.task.completed.join("; ")}`);
    }
    if (context.task?.pending?.length) {
      lines.push(`Still pending: ${context.task.pending.join("; ")}`);
    }

    lines.push("");
    lines.push("Current Browser:");
    lines.push(`- URL: ${context.url || "(none)"}`);
    lines.push(`- Title: ${context.title || "(none)"}`);
    lines.push(`- Loading: ${context.loading}`);
    lines.push(`- Tabs open: ${context.tabCount}`);

    lines.push("");
    lines.push(`Visible buttons (${context.buttons.length}):`);
    lines.push(this._compactList(context.buttons, (b) => `"${b.text}" -> ${b.selector}`));

    lines.push("");
    lines.push(`Visible inputs (${context.inputs.length}):`);
    lines.push(
      this._compactList(context.inputs, (i) => `[${i.type}] "${i.placeholder || i.name}" -> ${i.selector}`)
    );

    if (context.links.length) {
      lines.push("");
      lines.push(`Notable links (${context.links.length}):`);
      lines.push(this._compactList(context.links.slice(0, 10), (l) => `"${l.text}" -> ${l.href}`));
    }

    if (context.pageTextExcerpt) {
      lines.push("");
      lines.push(`Page text excerpt: ${context.pageTextExcerpt}`);
    }

    if (context.recentActions.length) {
      lines.push("");
      lines.push("Recent actions taken:");
      lines.push(
        this._compactList(context.recentActions.slice(-5), (a) => `${a.action} ${JSON.stringify(a.args)}`)
      );
    }

    if (context.recentErrors.length) {
      lines.push("");
      lines.push("Recent errors — avoid repeating whatever caused these:");
      lines.push(this._compactList(context.recentErrors, (e) => `${e.time}: ${e.error}`));
    }

    if (recoveryNote) {
      lines.push("");
      lines.push(`Recovery guidance: ${recoveryNote}`);
    }

    if (context.history.length) {
      lines.push("");
      lines.push(`Recently visited (avoid re-visiting unnecessarily): ${context.history.join(", ")}`);
    }

    lines.push("");
    lines.push(`Allowed actions: ${allowedActions.join(", ")}`);
    lines.push("");
    lines.push(
      "Respond with exactly one JSON object and nothing else, in one of these forms:"
    );
    lines.push('  { "action": "<one of the allowed actions>", "args": { ... }, "reasoning": "..." }');
    lines.push('  { "complete": true, "reasoning": "why the goal is now satisfied" }');
    lines.push(
      "Only set complete=true if the goal is genuinely and fully satisfied given the current browser state."
    );

    return lines.join("\n");
  }

  _compactList(items, fmt) {
    if (!items.length) return "  (none)";
    return items.map((i) => `  - ${fmt(i)}`).join("\n");
  }
}

// ---------------------------------------------------------------------------
// PlanValidator — never trust the LLM blindly. Checks shape, capability
// availability, required args, and flags sensitive actions for the
// permission layer that runtime.js enforces downstream. This is a safety
// net, not the final authority — runtime.permissions.validate() still has
// the last word.
// ---------------------------------------------------------------------------

class PlanValidator {
  validate(plan, { capabilities, goalAnalysis }) {
    if (!plan || typeof plan !== "object") {
      return { ok: false, reason: "Plan is not an object" };
    }

    if (plan.complete === true) {
      return { ok: true, plan: { complete: true, reasoning: plan.reasoning || null } };
    }

    const { action, args = {} } = plan;
    const spec = ACTION_SCHEMA[action];
    if (!spec) {
      return { ok: false, reason: `Unknown action "${action}"` };
    }

    if (spec.capability && !capabilities[spec.capability]) {
      return { ok: false, reason: `Action "${action}" requires disabled capability "${spec.capability}"` };
    }

    for (const field of spec.required) {
      if (args[field] === undefined || args[field] === null || args[field] === "") {
        return { ok: false, reason: `Action "${action}" missing required arg "${field}"` };
      }
    }

    if (action === "navigate" && !this._looksLikeUrl(args.url)) {
      return { ok: false, reason: `"${args.url}" does not look like a valid URL` };
    }

    // A goal that reads as destructive AND a plan step that is itself
    // flagged sensitive is the clearest signal to force a permission
    // check rather than silently proceeding.
    const sensitive = Boolean(spec.sensitive) || goalAnalysis?.looksDestructive;

    return {
      ok: true,
      plan: {
        action,
        args,
        reasoning: plan.reasoning || null,
        requiresPermission: sensitive,
      },
    };
  }

  _looksLikeUrl(url) {
    if (typeof url !== "string") return false;
    try {
      // Allow bare domains too ("youtube.com") by prepending a scheme
      // for validation purposes only.
      const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
      // eslint-disable-next-line no-new
      new URL(candidate);
      return true;
    } catch (_) {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// RetryManager — tracks repeated failures/identical actions per goal so
// the planner waits-and-observes instead of hammering the same click, and
// escalates to ask_user if truly stuck.
// ---------------------------------------------------------------------------

class RetryManager {
  constructor() {
    this._failureCounts = new Map(); // key -> count
    this._lastActionSignature = null;
    this._repeatCount = 0;
    this._waitStreak = 0;
  }

  reset() {
    this._failureCounts.clear();
    this._lastActionSignature = null;
    this._repeatCount = 0;
    this._waitStreak = 0;
  }

  signatureOf(plan) {
    if (!plan || plan.complete) return null;
    return `${plan.action}:${JSON.stringify(plan.args || {})}`;
  }

  recordFailure(signature) {
    const count = (this._failureCounts.get(signature) || 0) + 1;
    this._failureCounts.set(signature, count);
    return count;
  }

  failureCount(signature) {
    return this._failureCounts.get(signature) || 0;
  }

  clearFailure(signature) {
    this._failureCounts.delete(signature);
  }

  /** Returns true if the *same* action has now been proposed too many times in a row. */
  notePlanAndCheckLoop(plan) {
    const sig = this.signatureOf(plan);
    if (sig && sig === this._lastActionSignature) {
      this._repeatCount += 1;
    } else {
      this._repeatCount = 1;
      this._lastActionSignature = sig;
    }
    return this._repeatCount >= MAX_IDENTICAL_ACTIONS;
  }

  nextWaitMs() {
    const ms = WAIT_BACKOFF_MS[Math.min(this._waitStreak, WAIT_BACKOFF_MS.length - 1)];
    this._waitStreak += 1;
    return ms;
  }

  resetWaitStreak() {
    this._waitStreak = 0;
  }
}

// ---------------------------------------------------------------------------
// ErrorRecovery — turns the last recorded error into either a synthesized
// "wait" action (transient/loading errors) or a recovery note injected
// into the next prompt so the LLM tries a different approach instead of
// repeating the failing one.
// ---------------------------------------------------------------------------

class ErrorRecovery {
  inspect(recentErrors = []) {
    const last = recentErrors[recentErrors.length - 1];
    if (!last) return { transient: false, note: null };

    const msg = (last.error || "").toLowerCase();
    const transient = /timeout|timed out|loading|not visible|detached|navigat/i.test(msg);
    const notFound = /not found|no element|missing/i.test(msg);

    let note = null;
    if (transient) {
      note = "The last action likely failed because the page was still loading or changing. Consider waiting or re-checking the current state before repeating it.";
    } else if (notFound) {
      note = "The last targeted element could not be found. Re-examine the current buttons/inputs/links list rather than reusing the old selector.";
    } else if (last.error) {
      note = `The last action failed with: "${last.error}". Choose a different approach.`;
    }

    return { transient, note };
  }
}

// ---------------------------------------------------------------------------
// GoalCompletionChecker — the LLM's complete=true is the primary signal;
// this adds a couple of cheap sanity backstops.
// ---------------------------------------------------------------------------

class GoalCompletionChecker {
  check({ plan, loopStuck }) {
    if (plan?.complete) {
      return { complete: true, reason: "llm-reported" };
    }
    if (loopStuck) {
      return { complete: false, stuck: true, reason: "identical-action-repeated" };
    }
    return { complete: false };
  }
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

class Planner {
  constructor(options = {}) {
    this.log = new Logger({ scope: "planner", level: options.logLevel || "info" });
    this.goalAnalyzer = new GoalAnalyzer();
    this.contextBuilder = new ContextBuilder();
    this.capabilitySelector = new CapabilitySelector();
    this.promptBuilder = new PromptBuilder();
    this.validator = new PlanValidator();
    this.retryManager = new RetryManager();
    this.errorRecovery = new ErrorRecovery();
    this.completionChecker = new GoalCompletionChecker();

    this._activeGoalText = null;
  }

  /**
   * @param {object} params
   * @param {string} params.goal
   * @param {object} params.observation   latest observer.js snapshot
   * @param {object} params.memory        memory.export() snapshot
   * @param {object} params.llm           llm.js client instance
   * @param {AbortSignal} [params.signal]
   * @param {"minimal"|"full"} [params.detailLevel] whether the server
   *   should embed the full page dump in the prompt this cycle, or just
   *   a minimal url/title/counts summary. Set to "full" by
   *   runtime.cjs's _runAgentAttempt exactly when the model's previous
   *   turn asked for it via a lone {"type":"observe"} action.
   */
  async plan({ goal, observation, memory, llm, signal, detailLevel } = {}) {
    if (!llm) throw new Error("planner.plan() requires an llm client");

    // A fresh goal resets retry/loop tracking so stale state from a
    // previous task doesn't bleed into this one.
    if (goal !== this._activeGoalText) {
      this.retryManager.reset();
      this._activeGoalText = goal;
    }
    console.log("1");
    const goalAnalysis = this.goalAnalyzer.analyze(goal);
    if (goalAnalysis.empty) {
      return { complete: true, reasoning: "No goal provided." };
    }
    console.log("2");
    const context = this.contextBuilder.build({ goal, observation, memory });
    console.log("3");
    const capabilities = context.capabilities || {};
    console.log("4");
    const allowedActions = this.capabilitySelector.allowedActions(capabilities);
    const lastAction = (context.recentActions || [])[context.recentActions.length - 1];
    if (
      goalAnalysis.looksLikeNavigation &&
      !goalAnalysis.looksLikeForm &&
      !goalAnalysis.looksLikeSearch &&
      lastAction &&
      lastAction.action === "navigate" &&
      lastAction.result?.success &&
      // Critical: only honor this shortcut if that navigate happened
      // under the CURRENT goal. Without this check, a successful
      // navigate left over from a completely different, earlier goal
      // (e.g. "open NBA" before "open Marvel Studios") gets misread as
      // already satisfying the new goal, and the new goal is marked
      // complete without the agent ever actually acting on it.
      lastAction.goal === goal
    ) {
      this.log.info("Heuristic: navigation goal already satisfied by last successful navigate — marking complete.");
      this.retryManager.reset();
      return { complete: true, reason: "Navigation completed.", actions: [] };
    }

    // --- Error recovery / retry manager: short-circuit the LLM call
    // entirely when the fastest, cheapest thing to do is just wait.
    console.log("5");
    const recovery = this.errorRecovery.inspect(context.recentErrors);
    if (recovery.transient) {
      const waitMs = this.retryManager.nextWaitMs();
      this.log.info(`Transient issue detected, waiting ${waitMs}ms before re-observing`);
      return { action: "wait", args: { ms: waitMs }, reasoning: "Waiting for page to stabilize", requiresPermission: false };
    }
    this.retryManager.resetWaitStreak();
    console.log("6");
    const prompt = this.promptBuilder.build({
      context,
      allowedActions,
      goalAnalysis,
      recoveryNote: recovery.note,
    });

    let llmResponse;
    try {
      console.log("7");
      console.log("PLANNER -> Calling LLM");
      llmResponse = await llm.predict({ goal, observation, memory, prompt, signal, detailLevel });
      console.log("8");
      console.log("========== LLM RESPONSE ==========");
      console.dir(llmResponse, { depth: null });
      console.log("==================================");
    } catch (err) {
      this.log.error("LLM predict failed", err.message);
      // Network/LLM failure is itself transient — back off and let the
      // runtime's own retry/error handling decide whether to keep going.
      throw err;
    }

    const firstAction = (llmResponse.actions || [])[0];

    let candidate;

    if (llmResponse.complete) {

        candidate = {
            complete: true,
            reasoning: llmResponse.reason || ""
        };

    } else if (firstAction) {

        const args = { ...firstAction };
        delete args.type;

        candidate = {
            action: firstAction.type,
            args,
            reasoning: llmResponse.reason || ""
        };

    } else {

        return null;

    }

    // Validate candidate
    const validation = this.validator.validate(candidate, {
        capabilities,
        goalAnalysis,
        
    });
    console.log("========== VALIDATED PLAN ==========");
    console.dir(validation, { depth: null });
    console.log("====================================");

    if (!validation.ok) {
        this.log.warn("Planner validation failed:", validation.reason);
        return null;
    }

    const plan = validation.plan;

    const completion = this.completionChecker.check({
      plan,
      loopStuck: this.retryManager.notePlanAndCheckLoop(plan),
    });

    if (completion.complete) {
      this.retryManager.reset();
      return {
          complete: true,
          reason: plan.reasoning || "",
          actions: []
      };
    }

    if (completion.stuck) {
      this.log.warn("Same action repeated too many times, escalating to ask_user");
      this.retryManager.reset();
      return {
          complete: false,
          reason: "Repeated action loop",
          actions: [
              {
                  type: "ask_user",
                  question: `I've tried "${plan.action}" several times without progress. Should I keep trying, try something else, or stop?`
              }
          ]
      };
    }

    return {
        complete: false,
        reason: plan.reasoning || "",
        actions: [
            {
                type: plan.action,
                ...plan.args
            }
        ]
    };
  }

  /**
   * Called by runtime.js when an executed action failed, so the retry
   * manager's failure counts stay in sync with reality (independent of
   * whatever the next planned action ends up being).
   */
  reportExecutionFailure(plan, error) {
    const sig = this.retryManager.signatureOf(plan);
    if (!sig) return;
    const count = this.retryManager.recordFailure(sig);
    this.log.warn(`Execution failure #${count} for ${sig}: ${error?.message || error}`);
  }

  reportExecutionSuccess(plan) {
    const sig = this.retryManager.signatureOf(plan);
    if (sig) this.retryManager.clearFailure(sig);
  }
}

module.exports = Planner;
module.exports.ACTION_SCHEMA = ACTION_SCHEMA;