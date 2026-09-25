// Noah/models/base.cjs
//
// Provider abstraction (spec §12): every model vendor sits behind the same
// interface so Noah never hard-codes one.
//
//   ModelProvider
//     complete(request) -> { text, toolCalls[], usage, stopReason, latencyMs }
//
// Normalised request (provider adapters translate it to their wire format):
//   {
//     model, system, maxTokens, signal, timeoutMs,
//     messages: [{ role: 'user'|'assistant', content: [{type:'text',text} | {type:'image',mime,base64}] }],
//     tools:    [{ name, description, parameters(JSON schema) }],
//     toolChoice: 'name' | null,
//     meta: {...}                      // ignored by real providers (used by the scripted test provider)
//   }
//
// Errors are normalised to ProviderError with a code the ModelRouter can act on.

"use strict";

class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {object} o
   * @param {'auth'|'rate_limit'|'quota'|'overloaded'|'timeout'|'network'|'invalid_request'|'content_filtered'|'unsupported'|'aborted'|'unknown'} o.code
   */
  constructor(message, { code = "unknown", status, retryable = false, provider, retryAfterMs } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

/** One readable line from a provider error body (they are JSON blobs with request details we do not need to show). */
function briefError(text) {
  let msg = String(text || "");
  try {
    const j = JSON.parse(msg);
    msg = (j.error && (j.error.message || j.error.status || (typeof j.error === "string" ? j.error : ""))) || j.message || msg;
  } catch (_) { /* not JSON: use as is */ }
  return redact(String(msg).replace(/\s+/g, " ").trim()).slice(0, 240);
}

function classifyHttp(status, bodyText) {
  const t = String(bodyText || "").toLowerCase();
  // Providers disagree on the status for a bad key: Google answers 400 API_KEY_INVALID, others 401/403.
  if (status === 401 || status === 403 || /api[_ -]?key[_ ]*(is |was )?(not valid|invalid)|invalid[_ ]api[_ ]key|incorrect api key|invalid x-api-key|api_key_invalid|unauthenticated/.test(t)) return { code: "auth", retryable: false };
  if (status === 429) return { code: /quota|billing|exceeded your|insufficient|credit/.test(t) ? "quota" : "rate_limit", retryable: false };
  if (status === 402) return { code: "quota", retryable: false };
  if (status === 408 || status === 504) return { code: "timeout", retryable: true };
  if (status === 529 || status === 503 || status === 502) return { code: "overloaded", retryable: true };
  if (status >= 500) return { code: "overloaded", retryable: true };
  if (status === 400 || status === 404 || status === 413 || status === 422) return { code: "invalid_request", retryable: false };
  return { code: "unknown", retryable: false };
}

class BaseProvider {
  /**
   * @param {object} o
   * @param {string} o.name        provider key (anthropic, openai, google, qwen, local, rexy)
   * @param {string} o.baseURL
   * @param {() => string|null} o.getKey   returns the API key at call time (never cached in the instance)
   * @param {typeof fetch} [o.fetch]
   */
  constructor({ name, baseURL, getKey, fetch: fetchImpl, options = {} }) {
    this.name = name;
    this.baseURL = String(baseURL || "").replace(/\/+$/, "");
    this.getKey = getKey || (() => null);
    this.fetch = fetchImpl || globalThis.fetch;
    this.options = options;
    this.stats = { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
  }

  get type() {
    return "base";
  }

  isConfigured() {
    return !!this.getKey() || !!this.options.keyless;
  }

  /** @abstract */
  async complete(_request) {
    throw new ProviderError(`${this.name}: complete() not implemented`, { code: "unsupported", provider: this.name });
  }

  /**
   * POST JSON with timeout + abort + normalised errors. Returns parsed JSON.
   * One quick retry on a transient transport failure ("fetch failed", 502/503/504): inference calls are idempotent,
   * and without it a single network blip failed a whole task when only one provider was configured.
   */
  async postJson(url, headers, body, opts = {}) {
    try {
      return await this._postJsonOnce(url, headers, body, opts);
    } catch (err) {
      const transient = err instanceof ProviderError && err.retryable && (err.code === "network" || err.code === "overloaded");
      if (!transient || opts.signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, 700));
      if (opts.signal?.aborted) throw err;
      return this._postJsonOnce(url, headers, body, opts);
    }
  }

  async _postJsonOnce(url, headers, body, { signal, timeoutMs = 60_000 } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) throw new ProviderError("aborted by caller", { code: "aborted", provider: this.name });
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await this.fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: controller.signal });
      } catch (err) {
        if (err.name === "AbortError") {
          const byCaller = signal?.aborted;
          throw new ProviderError(byCaller ? "aborted by caller" : `request timed out after ${timeoutMs}ms`, { code: byCaller ? "aborted" : "timeout", retryable: !byCaller, provider: this.name });
        }
        throw new ProviderError(`network error: ${err.message}`, { code: "network", retryable: true, provider: this.name });
      }
      const text = await res.text();
      if (!res.ok) {
        const c = classifyHttp(res.status, text);
        // Number(null) is 0: a missing header must not turn into "retry after 0 ms", which silently disabled the
        // router's cooldown for every HTTP failure (a bad key was re-tried on every single call).
        const raw = res.headers.get("retry-after");
        const ra = raw !== null && raw !== undefined && raw !== "" ? Number(raw) : NaN;
        throw new ProviderError(`${this.name} HTTP ${res.status}: ${briefError(text)}`, {
          ...c, status: res.status, provider: this.name, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined,
        });
      }
      try {
        return JSON.parse(text);
      } catch (_) {
        throw new ProviderError(`${this.name}: response was not JSON`, { code: "unknown", provider: this.name });
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  _account(usage, ok = true) {
    this.stats.calls++;
    if (!ok) this.stats.errors++;
    if (usage) {
      this.stats.inputTokens += usage.inputTokens || 0;
      this.stats.outputTokens += usage.outputTokens || 0;
    }
  }
}

/** Never let an API key echo back into logs/errors. */
function redact(s) {
  return String(s || "")
    .replace(/(AIza[0-9A-Za-z_-]{20,})/g, "[redacted-key]")
    .replace(/(sk-[A-Za-z0-9_-]{16,})/g, "[redacted-key]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1[redacted]")
    .replace(/(x-api-key["':\s]+)[A-Za-z0-9._-]{12,}/gi, "$1[redacted]");
}

/** Last-resort JSON extraction from free text (models without tool calling). */
function extractJson(text) {
  if (!text) return null;
  const t = String(text).trim();
  try {
    return JSON.parse(t);
  } catch (_) {
    /* fall through */
  }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_) {
      /* fall through */
    }
  }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(t.slice(first, last + 1));
    } catch (_) {
      /* fall through */
    }
  }
  return null;
}

module.exports = { BaseProvider, ProviderError, classifyHttp, redact, extractJson };
