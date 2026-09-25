// Noah/models/router.cjs
//
// ModelRouter (spec §12/§34): picks a model per ROLE (planner / browser / vision / fast /
// local) and fails over across providers - without ever silently downgrading a sensitive
// task.
//
//   role -> ordered candidate list (config.roles[role])
//        -> filter by: provider configured, not cooling down, capability (vision), safety
//        -> call; on rate-limit/quota/overload/timeout/network/auth: cool down that
//           candidate and try the next one, emitting a visible `model_failover` event.
//
// Safety invariants (enforced here, in code):
//   1. A `sensitive` task (purchases, credentials, finance, ...) may only fail over to
//      candidates marked `trusted`. If none remain the call throws NO_TRUSTED_MODEL and the
//      agent stops and tells the user; it does not proceed on a weaker model.
//   2. local/legacy (text-only, weaker) candidates serve sensitive tasks only if the user
//      explicitly allowed it (routing.allowSensitiveOnLocal).
//   3. Failover changes WHICH model reasons, never what is permitted: the SafetyController
//      sits after the model and is provider-independent.

"use strict";

const { modelInfo, LEGACY_CANDIDATE } = require("./catalog.cjs");
const { ProviderError } = require("./base.cjs");
const { AnthropicProvider } = require("./anthropic.cjs");
const { OpenAIProvider } = require("./openai.cjs");
const { GoogleProvider } = require("./google.cjs");
const { RexyLegacyProvider } = require("./rexy-legacy.cjs");

class RouterError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "RouterError";
    this.code = code;
    this.details = details;
  }
}

const FAILOVER_CODES = new Set(["rate_limit", "quota", "overloaded", "timeout", "network", "auth", "content_filtered", "unknown"]);
const COOLDOWN_MS = { rate_limit: 60_000, quota: 15 * 60_000, overloaded: 30_000, timeout: 20_000, network: 20_000, auth: 10 * 60_000, content_filtered: 0, unknown: 15_000 };

class ModelRouter {
  /**
   * @param {object} o
   * @param {import('../config.cjs').ConfigStore} o.config
   * @param {import('../events.cjs').EventBus} [o.bus]
   * @param {Record<string, any>} [o.providers]  pre-built providers by name (tests / injection)
   */
  constructor({ config, bus, providers = {}, fetch: fetchImpl, log = () => {} }) {
    this.config = config;
    this.bus = bus;
    this.log = log;
    this.fetch = fetchImpl;
    this._providers = { ...providers };
    this._cooldown = new Map(); // "provider:model" -> until (ms)
    this._cooldownCode = new Map(); // "provider:model" -> the error code that caused it
    this.stats = { calls: 0, failovers: 0, byRole: {}, inputTokens: 0, outputTokens: 0, byModel: {} };
  }

  provider(name) {
    if (this._providers[name]) return this._providers[name];
    const cfg = this.config.get().providers[name];
    if (!cfg || cfg.enabled === false) return null;
    const args = { name, baseURL: this.config.getBaseURL(name), getKey: () => this.config.getKey(name), fetch: this.fetch, options: cfg };
    const P = { anthropic: AnthropicProvider, openai: OpenAIProvider, google: GoogleProvider, rexy: RexyLegacyProvider }[cfg.type];
    if (!P) return null;
    this._providers[name] = new P(args);
    return this._providers[name];
  }

  _usable(c) {
    const p = this.provider(c.provider);
    if (!p) return false;
    const cfg = this.config.get().providers[c.provider] || {};
    if (cfg.legacy || p.type === "rexy") return this.config.get().routing.allowLegacyFallback !== false;
    if (p.type === "scripted") return true;
    return !!this.config.getKey(c.provider) || !!cfg.keyless;
  }

  _cooling(c) {
    const until = this._cooldown.get(`${c.provider}:${c.model}`);
    return until && until > Date.now();
  }

  /** Candidates for a role with capability info, in preference order (before availability filtering). */
  candidates(role) {
    const list = this.config.get().roles[role] || [];
    return list.map((c) => ({ ...c, info: modelInfo(c.model), key: `${c.provider}:${c.model}` }));
  }

  /**
   * Candidates that can serve this call right now.
   * @param {string} role
   * @param {{ needsVision?: boolean, sensitive?: boolean, excludeKeys?: Set<string> }} opts
   */
  usable(role, { needsVision = false, sensitive = false, excludeKeys = new Set() } = {}) {
    const routing = this.config.get().routing;
    const out = [];
    let list = this.candidates(role);
    // vision role must see pixels; if nothing configured for the role, borrow from browser role
    if (needsVision && role === "browser") list = [...list, ...this.candidates("vision")];
    // SAFETY (invariant 1): a sensitive task is restricted to TRUSTED models from the first choice on. Filtering
    // here - before availability/cooldown - means a trusted model that is merely cooling down can never cause the
    // call to be served by an untrusted one. (If the user marked no candidate trusted, their list is used as-is.)
    if (sensitive && routing.requireTrustedForSensitive !== false && list.some((c) => c.trusted)) list = list.filter((c) => c.trusted);
    const cooling = []; // configured and eligible, but cooling down after an error
    for (const c of list) {
      if (excludeKeys.has(c.key) || out.some((o) => o.key === c.key) || cooling.some((o) => o.key === c.key)) continue;
      if (!this._usable(c)) continue;
      const p = this.provider(c.provider);
      const cfg = this.config.get().providers[c.provider] || {};
      const weak = !!cfg.local || !!cfg.legacy || p.type === "rexy";
      if (needsVision && (!c.info.vision || p.type === "rexy")) continue;
      if (sensitive && weak && !routing.allowSensitiveOnLocal) continue;
      if (this._cooling(c)) {
        cooling.push({ ...c, weak });
        continue;
      }
      out.push({ ...c, weak });
    }
    // A cooldown exists to prefer ANOTHER model for a while. When nothing else is left, refusing to try the cooling one
    // only makes the agent "unavailable" for the length of the cooldown after a single slow answer: try it (soonest-ready
    // first). Never for sensitive tasks: they must not run on anything but a healthy trusted model. Each candidate is
    // still tried at most once per call() through excludeKeys, so this cannot become a retry storm.
    // A rejected key or an exhausted quota will not fix itself in a minute, so those stay cooled.
    const retryable = cooling.filter((c) => !["auth", "quota"].includes(this._cooldownCode.get(c.key)));
    if (!out.length && !sensitive && retryable.length) {
      retryable.sort((a, b) => (this._cooldown.get(a.key) || 0) - (this._cooldown.get(b.key) || 0));
      out.push(retryable[0]);
    }
    // Legacy text-only backend is the last resort for NON-vision calls when nothing else is usable.
    // It obeys the same exclusion + cooldown rules as every other candidate: without that, a dead legacy backend
    // was re-selected forever inside one call() (891 failover events in 150s, the task never ended).
    const legacyKey = "rexy:rexy-render";
    if (!out.length && !needsVision && routing.allowLegacyFallback !== false && !sensitive && this._usable(LEGACY_CANDIDATE) && !excludeKeys.has(legacyKey)) {
      out.push({ ...LEGACY_CANDIDATE, info: modelInfo("rexy-render"), key: legacyKey, weak: true, trusted: false });
    }
    return out;
  }

  /** True if at least one candidate can run the browser role. */
  isAvailable() {
    return this.usable("browser").length > 0;
  }

  /** Resolved plan for the settings UI. */
  describe() {
    const roles = {};
    for (const role of Object.keys(this.config.get().roles)) {
      const all = this.candidates(role).map((c) => ({ provider: c.provider, model: c.model, trusted: !!c.trusted, configured: this._usable(c), cooling: !!this._cooling(c), coordinateSpace: c.info.coordinateSpace }));
      roles[role] = { active: all.find((c) => c.configured && !c.cooling) || null, candidates: all };
    }
    return { roles, stats: this.stats };
  }

  markCooldown(c, err) {
    const ms = err.retryAfterMs ?? COOLDOWN_MS[err.code] ?? 15_000;
    if (ms > 0) {
      this._cooldown.set(c.key, Date.now() + ms);
      this._cooldownCode.set(c.key, err.code);
    }
  }

  /**
   * @param {string} role
   * @param {object} request normalised request (see models/base.cjs); `model` is filled in per candidate
   * @param {{ sensitive?: boolean, needsVision?: boolean, signal?: AbortSignal }} [opts]
   */
  async call(role, request, { sensitive = false, needsVision = false, signal } = {}) {
    const tried = new Set();
    const failures = [];
    let firstKey = null;
    // Each candidate is tried at most once per call (`tried`); the hard cap is defence in depth against any
    // future selection bug turning a provider outage into an endless retry storm.
    for (let attempts = 0; ; attempts++) {
      if (attempts > 12) break;
      const cands = this.usable(role, { needsVision, sensitive, excludeKeys: tried });
      if (!cands.length) break;
      const c = cands[0];
      if (!firstKey) firstKey = c.key;
      tried.add(c.key);
      const provider = this.provider(c.provider);
      const req = { ...request, model: c.model };
      try {
        const res = await provider.complete(req);
        this.stats.calls++;
        this.stats.byRole[role] = (this.stats.byRole[role] || 0) + 1;
        this.stats.inputTokens += res.usage?.inputTokens || 0;
        this.stats.outputTokens += res.usage?.outputTokens || 0;
        const m = (this.stats.byModel[c.key] ||= { calls: 0, inputTokens: 0, outputTokens: 0 });
        m.calls++;
        m.inputTokens += res.usage?.inputTokens || 0;
        m.outputTokens += res.usage?.outputTokens || 0;
        this.bus?.publish("model_call", { role, provider: c.provider, model: c.model, usage: res.usage, latencyMs: res.latencyMs, failedOver: c.key !== firstKey });
        return { ...res, provider: c.provider, modelId: c.model, coordinateSpace: c.info.coordinateSpace, maxImageLongEdge: c.info.maxImageLongEdge, candidate: c };
      } catch (err) {
        if (err.code === "aborted") throw err;
        const pe = err instanceof ProviderError ? err : new ProviderError(err.message, { code: "unknown", provider: c.provider });
        failures.push({ candidate: c.key, code: pe.code, message: pe.message });
        this.log(`model ${c.key} failed (${pe.code}): ${pe.message}`);
        if (!FAILOVER_CODES.has(pe.code)) throw pe; // invalid_request/unsupported: our bug, not a transient outage
        this.markCooldown(c, pe);
        const next = this.usable(role, { needsVision, sensitive, excludeKeys: tried })[0];
        // Visible, never silent (spec §34): tell the UI which model is now reasoning.
        this.stats.failovers++;
        this.bus?.publish("model_failover", {
          role, from: c.key, to: next ? next.key : null, reason: pe.code, sensitive,
          text: next ? `${c.model} unavailable (${pe.code}); switching to ${next.model}` : `${c.model} unavailable (${pe.code}); no fallback available`,
        });
        if (signal?.aborted) throw new ProviderError("aborted by caller", { code: "aborted" });
      }
    }
    if (!failures.length) {
      const configured = this.candidates(role).filter((c) => this._usable(c));
      if (configured.length && sensitive) {
        throw new RouterError("No TRUSTED model is available for this sensitive task right now (the trusted model is cooling down after errors, or only untrusted/local models are configured). Noah stopped instead of continuing on a weaker model.", "NO_TRUSTED_MODEL", { role });
      }
      if (configured.length) {
        throw new RouterError(`Every configured model for the "${role}" role is temporarily unavailable (cooling down after errors). Try again in a minute.`, "ALL_FAILED", { role, cooling: true });
      }
      throw new RouterError(
        needsVision
          ? `No vision-capable model is configured for the "${role}" role. Add an API key (Anthropic, OpenAI, Gemini or Qwen) or a local vision model in Noah settings.`
          : `No model is configured for the "${role}" role. Add an API key (Anthropic, OpenAI, Gemini or Qwen) or a local model in Noah settings.`,
        "NO_MODEL",
        { role }
      );
    }
    if (sensitive) {
      throw new RouterError(
        `The model for a sensitive task became unavailable (${failures[failures.length - 1].code}) and no trusted fallback is configured. Noah stopped instead of continuing on a weaker model.`,
        "NO_TRUSTED_MODEL",
        { failures }
      );
    }
    const authFailed = [...new Set(failures.filter((f) => f.code === "auth").map((f) => f.candidate.split(":")[0]))];
    const hint = authFailed.length ? ` The API key for ${authFailed.join(", ")} was rejected: check it in .env (or Noah settings).` : "";
    throw new RouterError(`All configured models failed for role "${role}": ${failures.map((f) => `${f.candidate} (${f.code})`).join(", ")}.${hint}`, "ALL_FAILED", { failures });
  }
}

module.exports = { ModelRouter, RouterError };
