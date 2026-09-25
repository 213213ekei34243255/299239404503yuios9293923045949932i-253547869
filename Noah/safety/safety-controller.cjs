// Noah/safety/safety-controller.cjs
//
// The single gate between "the model wants X" and "X happens".
//
//   checkAction(action, ctx)  -> URL guard, cookie-exfil check, risk classification,
//                                policy decision, (optional) human confirmation, audit
//   stop()/guard()            -> emergency stop; independent of the model, checked
//                                between every low-level input event
//   pause()/resume()          -> user takeover / confirmation waits
//
// Nothing in here calls a model. A model that is confused, jailbroken or
// simply wrong cannot talk its way past it.

"use strict";

const { EventEmitter } = require("events");
const { randomUUID } = require("crypto");
const { classifyRisk } = require("./risk.cjs");
const { decide, DEFAULT_POLICY } = require("./policy.cjs");
const { checkNavigation, containsCookieValue, looksLikeDataCarrier, hostMatches } = require("./url-guard.cjs");
const { AuditLog } = require("./audit.cjs");
const { ACTIONS, redactAction } = require("../protocol/actions.cjs");
const { StoppedError } = require("../computer/input.cjs");

class SafetyController extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../events.cjs').EventBus} deps.bus
   * @param {() => object} deps.getPolicy       live policy config (mode, domains, ...)
   * @param {AuditLog} [deps.audit]
   * @param {() => Promise<string[]>} [deps.getCookieValues]  live cookie values (main-process only; never sent to a model)
   */
  constructor({ bus, getPolicy, audit, getCookieValues }) {
    super();
    this.bus = bus;
    this.getPolicy = () => ({ ...DEFAULT_POLICY, ...(getPolicy ? getPolicy() : {}) });
    this.audit = audit || new AuditLog({ enabled: false });
    this.getCookieValues = getCookieValues || (async () => []);
    this._stopped = false;
    this._abort = new AbortController();
    this._paused = null; // { reason, promise, resume }
    this._pending = new Map(); // confirmation id -> { resolve, timer, request }
    this.tainted = false;
    this.taintReasons = [];
    this.clipboardOwned = false;
    this.taskId = null;
    this.active = false; // true only while a task is running (taskId alone stays set after it ends, for the audit trail)
    this.step = 0;
    this._cookieCache = { at: 0, values: [] };
  }

  // ---------------------------------------------------------------- lifecycle

  beginTask(taskId) {
    this.taskId = taskId;
    this.active = true;
    this._stopped = false;
    this._abort = new AbortController();
    this._paused = null;
    this.tainted = false;
    this.taintReasons = [];
    this.clipboardOwned = false;
    this.step = 0;
  }

  endTask() {
    this.active = false;
    this.denyAllPending("task ended");
    this._paused = null;
  }

  // -------------------------------------------------------------------- stop

  get stopped() {
    return this._stopped;
  }

  get signal() {
    return this._abort.signal;
  }

  /** Emergency stop. Safe to call from any path (UI button, ESC, IPC, timeout). */
  stop(reason = "user") {
    if (this._stopped) return;
    this._stopped = true;
    this._abort.abort();
    this.bus.publish("safety", { level: "stop", reason });
    this.denyAllPending("stopped");
    if (this._paused) {
      this._paused.resume(); // release waiters so they observe the stop
      this._paused = null; // a stopped task is not "paused" any more
    }
    this.emit("stopped", { reason });
  }

  /** Throws if stopped. Passed to the InputDriver so it runs between every input event. */
  guard = () => {
    if (this._stopped) throw new StoppedError();
  };

  // ------------------------------------------------------------------- pause

  get paused() {
    return !!this._paused;
  }

  pause(reason = "user") {
    if (this._paused || this._stopped) return;
    let resume;
    const promise = new Promise((r) => (resume = r));
    this._paused = { reason, promise, resume };
    this.bus.publish("safety", { level: "pause", reason });
    this.emit("paused", { reason });
  }

  resume() {
    if (!this._paused) return;
    const p = this._paused;
    this._paused = null;
    p.resume();
    this.bus.publish("safety", { level: "resume" });
    this.emit("resumed");
  }

  /** Resolves when running; throws StoppedError if stopped while waiting. */
  async waitUntilRunning() {
    while (this._paused && !this._stopped) await this._paused.promise;
    this.guard();
  }

  // ------------------------------------------------------------ confirmation

  /**
   * Ask the human. Resolves true (allow) / false (deny, timeout or stop).
   * The agent is blocked here, so no further computer action can happen.
   */
  confirm(request) {
    const id = randomUUID();
    const timeoutMs = this.getPolicy().confirmTimeoutMs;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._resolvePending(id, false, "timeout");
      }, timeoutMs);
      this._pending.set(id, { resolve, timer, request });
      this.bus.publish("confirm_request", { id, ...request, timeoutMs });
    });
  }

  resolveConfirmation(id, allow) {
    return this._resolvePending(id, !!allow, allow ? "allowed" : "denied");
  }

  _resolvePending(id, allow, why) {
    const p = this._pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this._pending.delete(id);
    this.bus.publish("confirm_resolved", { id, allow, why });
    p.resolve(allow);
    return true;
  }

  denyAllPending(why = "denied") {
    for (const id of [...this._pending.keys()]) this._resolvePending(id, false, why);
  }

  hasPendingConfirmation() {
    return this._pending.size > 0;
  }

  // ------------------------------------------------------------------- taint

  noteFindings(findings, tainted) {
    if (!tainted || this.tainted) return;
    this.tainted = true;
    this.taintReasons = findings.slice(0, 5).map((f) => `${f.id} in ${f.source}`);
    this.bus.publish("safety", { level: "taint", reasons: this.taintReasons });
  }

  noteClipboardOwned(v = true) {
    this.clipboardOwned = v;
  }

  async _cookieValues() {
    // Never cached: an in-process cookie read is cheap, and a cookie set a moment ago (a login redirect, a
    // page script) must be protected on the very next action. A stale cache here was a real exfiltration gap.
    try {
      this._cookieCache = { at: Date.now(), values: await this.getCookieValues() };
    } catch (_) {
      /* keep the last known values */
    }
    return this._cookieCache.values;
  }

  // ------------------------------------------------------------- the checkpoint

  /**
   * @param {object} action validated action
   * @param {object} ctx { element?, page:{url,origin,hasPassword,hasPayment}, focusInSecret?, screenshotThumb?, method?, userGoal? }
   * @returns {Promise<{ allowed: boolean, decision: string, risk: object, reason?: string, code?: string, url?: string }>}
   */
  async checkAction(action, ctx = {}) {
    this.guard();
    await this.waitUntilRunning();
    const policy = this.getPolicy();
    const spec = ACTIONS[action.action] || {};
    const page = ctx.page || {};
    this.step++;

    const finish = (result) => {
      this.audit.record({
        taskId: this.taskId,
        step: this.step,
        action: AuditLog.summarizeAction(action),
        origin: page.origin,
        risk: result.risk?.level,
        categories: result.risk?.categories,
        decision: result.decision,
        tainted: this.tainted,
        method: ctx.method,
        code: result.code,
      });
      this.bus.publish("safety", {
        level: result.risk?.level || "low",
        decision: result.decision,
        action: redactAction(action),
        reasons: result.risk?.reasons,
        code: result.code,
      });
      return result;
    };

    // ---- hard URL boundary (model-independent)
    let normalizedUrl;
    let originChange = false;
    if ((action.action === "navigate" || action.action === "new_tab" || action.action === "download_file") && action.url) {
      const nav = checkNavigation(action.url, policy);
      if (!nav.allowed) {
        return finish({ allowed: false, decision: "deny", code: nav.code, reason: nav.reason, risk: { level: "blocked", categories: ["url_policy"], reasons: [nav.reason] } });
      }
      normalizedUrl = nav.url;
      if (nav.origin && page.origin && nav.origin !== page.origin) originChange = true;
      if (!nav.history) {
        const cookies = await this._cookieValues();
        if (containsCookieValue(nav.url, cookies)) {
          return finish({ allowed: false, decision: "deny", code: "cookie_exfiltration", reason: "The URL contains a live session cookie value; refusing (possible exfiltration)", risk: { level: "blocked", categories: ["cookie_exfiltration"], reasons: ["URL contains cookie value"] } });
        }
        if (looksLikeDataCarrier(nav.url) && this.tainted) {
          return finish({ allowed: false, decision: "deny", code: "data_in_url", reason: "The URL carries a large encoded payload after instruction-like page content; refusing", risk: { level: "blocked", categories: ["data_in_url"], reasons: ["large encoded URL payload"] } });
        }
      }
    }
    if ((action.action === "type" || action.action === "form_input") && typeof (action.text ?? action.value) === "string") {
      const cookies = await this._cookieValues();
      if (containsCookieValue(action.text ?? action.value, cookies)) {
        return finish({ allowed: false, decision: "deny", code: "cookie_exfiltration", reason: "Refusing to type a live session cookie value", risk: { level: "blocked", categories: ["cookie_exfiltration"], reasons: ["text contains cookie value"] } });
      }
    }

    // ---- classify + decide
    const risk = classifyRisk({
      action,
      element: ctx.element,
      page,
      tainted: this.tainted,
      clipboardOwned: this.clipboardOwned,
      focusInSecret: ctx.focusInSecret,
      tabOwned: ctx.tabOwned,
      originChange,
      config: policy,
    });
    // credential typing may be explicitly enabled by the user; it is still confirmed
    if (risk.level === "blocked" && risk.categories.includes("credential_entry") && policy.allowCredentialTyping) {
      risk.level = "high";
      if (!risk.categories.includes("credential_entry_allowed")) risk.categories.push("credential_entry_allowed");
    }
    const host = page.origin ? safeHost(page.origin) : "";
    const hostConfirmAlways = (policy.confirmAlwaysDomains || []).some((d) => host && hostMatches(host, d));
    const verdict = decide(risk, { mode: policy.mode, action, mutates: !!spec.mutates, hostConfirmAlways });

    if (verdict.decision === "deny") {
      return finish({ allowed: false, decision: "deny", code: "policy_blocked", reason: verdict.why, risk, url: normalizedUrl });
    }
    if (verdict.decision === "confirm") {
      const ok = await this.confirm({
        summary: describeForHuman(action, ctx),
        why: verdict.why,
        risk: { level: risk.level, categories: risk.categories, reasons: risk.reasons },
        action: redactAction(action),
        origin: page.origin,
        url: page.url,
        thumb: ctx.screenshotThumb,
      });
      this.guard();
      if (!ok) return finish({ allowed: false, decision: "denied_by_user", code: "user_denied", reason: "The user did not approve this action", risk, url: normalizedUrl });
      return finish({ allowed: true, decision: "confirmed", risk, url: normalizedUrl });
    }
    return finish({ allowed: true, decision: "allow", risk, url: normalizedUrl });
  }
}

function safeHost(origin) {
  try {
    return new URL(origin).hostname;
  } catch (_) {
    return "";
  }
}

function describeForHuman(action, ctx) {
  const el = ctx.element || {};
  const label = el.text || el.name || action.target?.text || "";
  switch (action.action) {
    case "click":
    case "double_click":
    case "right_click":
      return `${action.action.replace("_", "-")} "${label || describeTarget(action.target)}"${ctx.page?.origin ? ` on ${ctx.page.origin}` : ""}`;
    case "type":
      return `Type ${action.text ? action.text.length + " characters" : "text"}${action.submit ? " and press Enter" : ""}${label ? ` into "${label}"` : ""}`;
    case "navigate":
      return `Open ${action.url}`;
    case "new_tab":
      return `Open a new tab${action.url ? ` at ${action.url}` : ""}`;
    case "upload_file":
      return `Upload the local file ${action.path}`;
    case "download_file":
      return `Download ${action.url || label}`;
    case "key_press":
      return `Press ${action.key}${label ? ` (focus: "${label}")` : ""}`;
    default:
      return `${action.action}${label ? ` "${label}"` : ""}`;
  }
}

function describeTarget(t) {
  if (!t) return "";
  if (t.type === "ref") return t.ref;
  if (t.type === "text") return t.text;
  return `(${Math.round(t.x)}, ${Math.round(t.y)})`;
}

module.exports = { SafetyController };
