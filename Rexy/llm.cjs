// Rexy/llm.js
//
// Thin, resilient client for Noah's cloud model. Every other module
// (planner especially) depends on this returning predictable, structured
// data — so this file's job is to hide network flakiness, enforce
// timeouts/retries, and normalize whatever the API sends back into a
// shape the rest of the app can trust.

"use strict";
console.log("LLLLLLLLLLLL LLM LOADED");
console.log(__filename);

const Logger = require("./logger.cjs");

const DEFAULT_ENDPOINT = "https://damn-9uxm.onrender.com/predict";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Cloud model responses may come back as raw JSON, as a JSON string, or
 * (if the model was asked to reason first) as text with a JSON block
 * embedded in it. This tries each in turn instead of assuming one shape.
 */
function coerceStructured(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;

  if (typeof raw === "string") {
    const trimmed = raw.trim();

    // Straight JSON.
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      /* fall through */
    }

    // ```json ... ``` fenced block.
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch (_) {
        /* fall through */
      }
    }

    // First balanced-looking {...} in the text.
    const braceMatch = trimmed.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]);
      } catch (_) {
        /* fall through */
      }
    }

    // Nothing parseable — hand back the raw text so callers can decide
    // what to do rather than silently losing the response.
    return { raw: trimmed };
  }

  return { raw };
}

// ---------------------------------------------------------------------------
// Payload trimming — the planner's ContextBuilder already caps most of this
// for the human-readable prompt, but that trimmed prompt was never actually
// sent over the wire (see predict() below). observation/memory as captured
// by bridge.js can easily be 50-100KB+ per cycle: a 1000+ entry cookie
// domain list, full-resolution image arrays with long CDN URLs, untrimmed
// page text, and a memory object that duplicates most of observation's
// fields already. None of that detail helps the model pick the next
// action, and all of it costs serialize/transmit/parse time on every single
// planning cycle (and, if the server feeds this blob into an LLM prompt
// directly, real inference time too). Trim it the same way the prompt is
// already trimmed, so both the prompt AND the network payload agree.
// ---------------------------------------------------------------------------

const MAX_PAYLOAD_LIST_ITEMS = 20;
const MAX_PAYLOAD_IMAGES = 6;
const MAX_PAGE_TEXT_CHARS = 1500;
const MAX_HISTORY_ITEMS = 10;
const MAX_COOKIE_DOMAINS = 15;
const MAX_RECENT_ACTIONS = 10;

function trimList(list, max) {
  return Array.isArray(list) ? list.slice(0, max) : list;
}

function trimPage(page) {
  if (!page || typeof page !== "object") return page;
  return {
    ...page,
    buttons: trimList(page.buttons, MAX_PAYLOAD_LIST_ITEMS),
    inputs: trimList(page.inputs, MAX_PAYLOAD_LIST_ITEMS),
    links: trimList(page.links, MAX_PAYLOAD_LIST_ITEMS),
    forms: trimList(page.forms, MAX_PAYLOAD_LIST_ITEMS),
    images: trimList(page.images, MAX_PAYLOAD_IMAGES),
    videos: trimList(page.videos, MAX_PAYLOAD_LIST_ITEMS),
    tables: trimList(page.tables, MAX_PAYLOAD_LIST_ITEMS),
    pageText: typeof page.pageText === "string" ? page.pageText.slice(0, MAX_PAGE_TEXT_CHARS) : page.pageText,
  };
}

function trimCookies(cookies) {
  if (!cookies || typeof cookies !== "object") return cookies;
  return { count: cookies.count, domains: trimList(cookies.domains, MAX_COOKIE_DOMAINS) };
}

function trimObservation(observation) {
  if (!observation || typeof observation !== "object") return observation;
  return {
    ...observation,
    page: trimPage(observation.page),
    history: trimList(observation.history, MAX_HISTORY_ITEMS),
    cookies: trimCookies(observation.cookies),
  };
}

function trimMemory(memory) {
  if (!memory || typeof memory !== "object") return memory;
  return {
    ...memory,
    page: trimPage(memory.page),
    history: trimList(memory.history, MAX_HISTORY_ITEMS),
    cookies: trimCookies(memory.cookies),
    recentActions: trimList(memory.recentActions, MAX_RECENT_ACTIONS),
  };
}

class LLMError extends Error {
  constructor(message, { code, status, cause, retryable = false } = {}) {
    super(message);
    this.name = "LLMError";
    this.code = code;
    this.status = status;
    this.cause = cause;
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

class LLMClient {
  /**
   * @param {object} options
   * @param {string} [options.endpoint] override for the predict URL
   * @param {string} [options.apiKey] bearer token, if the deployment requires one
   * @param {number} [options.timeoutMs]
   * @param {number} [options.retries]
   * @param {number} [options.baseDelayMs] base backoff delay between retries
   */
  constructor(options = {}) {
    this.endpoint = options.endpoint || process.env.REXY_LLM_ENDPOINT || DEFAULT_ENDPOINT;
    this.apiKey = options.apiKey || process.env.REXY_LLM_API_KEY || null;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    // FIX: this used to default to 2, meaning every single call from
    // runtime.cjs (itself now retrying once) could silently balloon into
    // up to 3 actual HTTP attempts per call. Retry ownership now lives
    // exactly one layer up, in _executeGoal/_runChatGoal (see
    // runtime.cjs), which retries a whole failed attempt (fresh
    // observation + fresh plan) once. A second retry layer here added no
    // real value - it just retried the identical payload against the
    // same already-struggling backend - while multiplying total network
    // load. Override via options.retries if a specific deployment
    // genuinely needs it, but the default is now "let the caller decide".
    this.retries = options.retries ?? 0;
    this.baseDelayMs = options.baseDelayMs ?? 3_000;
    this.log = new Logger({ scope: "llm", level: options.logLevel || "info" });

    // Simple counters, handy for debugging/telemetry from the planner.
    this.stats = { calls: 0, failures: 0, retries: 0 };
  }

  /**
   * Main entry point used by the planner.
   *
   * @param {object} params
   * @param {string} params.goal            the active goal text
   * @param {object} params.observation     current browser/page observation
   * @param {object} [params.memory]        exported memory snapshot
   * @param {string} [params.prompt]        pre-built prompt (overrides goal/observation composition)
   * @param {object} [params.context]       any extra structured context (DOM tree, screenshot ref, etc.)
   * @param {AbortSignal} [params.signal]   external cancellation signal
   * @returns {Promise<object>} structured model response, e.g. { action, args, complete, reasoning }
   */
  async predict({ goal, observation, memory, prompt, context, signal, detailLevel } = {}) {
    const payload = this._buildPayload({

        mode: "agent",

        goal: goal ?? "",

        observation: observation ?? {},

        memory: memory ?? {},

        session_id: memory?.sessionId || "default",

        // FIX: this used to send the full page dump (all buttons,
        // inputs, links, images, up to 4000 chars of page text) on
        // EVERY planning cycle, whether or not the model needed any of
        // it - which is real, wasted token cost on every single request
        // (e.g. "open NBA website" never needs to see the page's
        // buttons/links at all). Default is now "minimal" - just
        // url/title/counts. The model gets to ask for the full detail
        // itself, by returning a plan whose only action is
        // {"type":"observe"} - runtime.cjs sets detailLevel: "full" for
        // the NEXT cycle when that happens. See agent.py's
        // summarize_observation() for the server-side half of this.
        detail_level: detailLevel || "minimal"

    });
    this.stats.calls += 1;

    const response = await this._sendWithRetry(payload, signal, "predict");
    return this._normalize(response);
  }

  /**
   * Conversational (non-agent) entry point used when the runtime decides
   * the user's message is plain chat rather than a browser task.
   *
   * Matches the Flask /predict contract for mode: "chat":
   *   request:  { mode: "chat", message, session_id, url?, page_content? }
   *   response: { answer: "..." }  (or { answer: "Invalid input" }, 400, if
   *              "message" is missing/empty)
   *
   * @param {object} params
   * @param {string} params.message         the user's chat text
   * @param {string} [params.sessionId]     conversation/session id
   * @param {string} [params.url]           current page URL, if relevant
   * @param {string} [params.pageContent]   extracted page text, if relevant
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<string>} the plain-text reply (empty string on failure)
   */
  async chat({ message, sessionId, url, pageContent, signal } = {}) {
    const payload = {
      mode: "chat",
      message: message ?? "",
      session_id: sessionId || "default",
      ...(url ? { url } : {}),
      ...(pageContent ? { page_content: pageContent } : {}),
    };
    this.stats.calls += 1;

    const response = await this._sendWithRetry(payload, signal, "chat");
    const parsed = coerceStructured(response);
    // The Flask route always replies with { "answer": "..." } for chat mode.
    return (parsed && (parsed.answer ?? parsed.raw)) || "";
  }

  /**
   * Lower-level escape hatch for callers that want to talk to the model
   * without the planner's goal/observation framing (e.g. a one-off
   * classification or summarization call).
   */
  async raw(prompt, opts = {}) {
    const payload = { prompt, ...opts.extra };
    const response = await this._sendWithRetry(payload, opts.signal, "raw");
    return coerceStructured(response);
  }

  // -------------------------------------------------------------------
  // Payload construction
  // -------------------------------------------------------------------

  _buildPayload({ mode, goal, observation, memory, session_id, detail_level }) {

      return {

          mode,

          goal,

          observation: trimObservation(observation),

          memory: trimMemory(memory),

          session_id,

          ...(detail_level ? { detail_level } : {}),

      };

  }
      
      

  _composePrompt({ goal, observation, memory }) {
    const parts = [];
    if (goal) parts.push(`Goal: ${goal}`);
    if (observation?.url) parts.push(`Current URL: ${observation.url}`);
    if (observation?.title) parts.push(`Page title: ${observation.title}`);
    if (memory?.recentActions?.length) {
      const recent = memory.recentActions
        .slice(-5)
        .map((a) => `- ${a.type || a.action || "action"}: ${JSON.stringify(a.args || a.result || {})}`)
        .join("\n");
      parts.push(`Recent actions:\n${recent}`);
    }
    parts.push(
      "Respond with a single JSON object describing the next action: " +
        '{ "action": string, "args": object, "complete": boolean, "reasoning": string }.'
    );
    return parts.join("\n\n");
  }

  // -------------------------------------------------------------------
  // Network layer: timeout + retry
  // -------------------------------------------------------------------

  async _sendWithRetry(payload, externalSignal, label = "predict") {
    let attempt = 0;
    let lastErr;

    while (attempt <= this.retries) {
      if (externalSignal?.aborted) {
        throw new LLMError("Request aborted by caller", { code: "ABORTED" });
      }

      try {
        return await this._sendOnce(payload, externalSignal);
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof LLMError ? err.retryable : true;

        if (!retryable || attempt === this.retries) {
          this.stats.failures += 1;
          this.log.error(
            `${label} failed permanently after ${attempt + 1} attempt(s): ${err.message}`
          );
          throw err instanceof LLMError
            ? err
            : new LLMError(err.message, { cause: err, retryable: false });
        }

        attempt += 1;
        this.stats.retries += 1;
        const delay = this.baseDelayMs * 2 ** (attempt - 1) + Math.random() * 100;
        this.log.warn(
          `${label} attempt ${attempt} failed (${err.message}); retrying in ${Math.round(delay)}ms`
        );
        await sleep(delay);
      }
    }

    // Unreachable in practice, but keeps control flow explicit.
    throw lastErr;
  }

  async _sendOnce(payload, externalSignal) {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      console.log("========== SENDING REQUEST ==========");
      console.log("Endpoint:", this.endpoint);
      console.dir(payload, { depth: null });

      const res = await fetch(this.endpoint, {
          method: "POST",
          headers: {
              "Content-Type": "application/json",
              ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
      });

      console.log("========== RESPONSE RECEIVED ==========");
      console.log("Status:", res.status);
      console.log("Content-Type:", res.headers.get("content-type"));

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        const retryable = res.status >= 500 || res.status === 429;
        throw new LLMError(`Cloud model returned ${res.status}: ${bodyText.slice(0, 300)}`, {
          code: "HTTP_ERROR",
          status: res.status,
          retryable,
        });
      }

      const contentType = res.headers.get("content-type") || "";

      let data;

      if (contentType.includes("application/json")) {
          console.log("Reading JSON...");
          data = await res.json();
      } else {
          console.log("Reading TEXT...");
          data = await res.text();
      }

      console.log("========== RESPONSE BODY ==========");
      console.dir(data, { depth: null });
      console.log("===================================");

      return data;
    } catch (err) {
      if (err.name === "AbortError") {
        const wasExternal = externalSignal?.aborted;
        throw new LLMError(
          wasExternal ? "Request aborted by caller" : `Request timed out after ${this.timeoutMs}ms`,
          { code: wasExternal ? "ABORTED" : "TIMEOUT", retryable: !wasExternal }
        );
      }
      if (err instanceof LLMError) throw err;
      // Network-level failure (DNS, connection reset, etc.) — retryable.
      throw new LLMError(`Network error contacting cloud model: ${err.message}`, {
        code: "NETWORK_ERROR",
        cause: err,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  // -------------------------------------------------------------------
  // Response normalization
  // -------------------------------------------------------------------

  _normalize(raw) {

      const parsed = coerceStructured(raw);

      if (!parsed) {

          return {

              complete:false,

              actions:[]

          };

      }

      return {

           complete: Boolean(parsed.complete),

          actions: Array.isArray(parsed.actions) ? parsed.actions : [],

          reason: parsed.reason || "",

          raw: parsed

      };

  }
}

module.exports = LLMClient;
module.exports.LLMError = LLMError;
