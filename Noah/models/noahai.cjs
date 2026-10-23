// Noah/models/noahai.cjs
//
// The hosted brain: Jonah's own noahai.live (Gemini behind it). The desktop app holds NO model key; it asks noahai.live, as the signed-in
// account, to run one model step: `POST /api/llm/step` with the app's normalised request (system, messages, tools, toolChoice, ...), and gets
// back { text, toolCalls, usage, stopReason, model }. The server keeps the Gemini key, applies per-account limits and metering, and never sees
// more than the request.
//
// Requests are signed exactly like every other call to noahai.live (X-Jonah-Device / -Timestamp / -Signature over the raw body), by a function the
// app injects (`getAuthHeaders`): this file knows nothing about keys. Not signed in => the provider reports itself NOT READY, so the router does
// not even try it (and a mission pauses with a clear reason instead of failing 401 in a loop).
//
// STATUS: the /api/llm/step endpoint is specified (see docs/AUTONOMY.md) but must be built by the noahai.live backend. Until it exists this
// provider has only been proven against a stand-in server that implements the contract AS SPECIFIED, never against noahai.live itself.

"use strict";

const { BaseProvider, ProviderError } = require("./base.cjs");
const { sanitizeSchema } = require("./google.cjs");

const STEP_PATH = "/api/llm/step";
// The roles the server knows (it maps each to a Gemini model). The router names the hosted candidate after its role, so the model it hands over IS the role.
const SERVER_ROLES = new Set(["mission", "browser", "vision", "planner", "fast"]);

class NoahaiProvider extends BaseProvider {
  /**
   * @param {object} o  (BaseProvider's, plus)
   * @param {() => boolean} [o.isSignedIn]  whether the user is signed in to Jonah (the account that is billed)
   * @param {(method: string, path: string, rawBody: string) => Promise<Record<string,string>>|Record<string,string>} o.getAuthHeaders
   */
  constructor({ isSignedIn = () => true, getAuthHeaders, ...rest }) {
    super({ ...rest, options: { ...(rest.options || {}), keyless: true } });
    this._signedIn = isSignedIn;
    this._auth = getAuthHeaders;
  }

  get type() {
    return "noahai";
  }

  /** The router asks before choosing this provider. */
  isReady() {
    return typeof this._auth === "function" && !!this._signedIn();
  }

  _body(req) {
    const body = {
      role: (req.meta && req.meta.role) || (SERVER_ROLES.has(req.model) ? req.model : null) || req.role || "mission",
      system: req.system,
      messages: req.messages,
      // Gemini rejects some JSON-schema keywords; the same clean-up the Gemini provider does (it leaves a schema that is already clean exactly as it was)
      tools: (req.tools || []).map((t) => (t && t.parameters ? { ...t, parameters: sanitizeSchema(t.parameters) } : t)),
      toolChoice: req.toolChoice === undefined ? null : req.toolChoice,
      maxTokens: req.maxTokens || 2048,
      temperature: req.temperature === undefined ? 0 : req.temperature,
    };
    // the TICKET: the key of the agent use that paid for this mission, so the server can refuse step calls not backed by one. Optional key, inside the signed body.
    if (req.meta && req.meta.ticket) body.missionRef = String(req.meta.ticket);
    return body;
  }

  async complete(req) {
    if (!this.isReady()) throw new ProviderError("Jonah is not signed in, so the hosted model cannot be used", { code: "auth", provider: this.name });
    const t0 = Date.now();
    const body = this._body(req);
    let headers;
    try {
      headers = await this._auth("POST", STEP_PATH, JSON.stringify(body)); // signs the exact text that is sent (postJson stringifies the same object the same way)
    } catch (err) {
      throw new ProviderError(`could not sign the request: ${err && err.message}`, { code: "auth", provider: this.name });
    }
    if (!headers || !headers["X-Jonah-Signature"]) throw new ProviderError("Jonah is not signed in, so the hosted model cannot be used", { code: "auth", provider: this.name });
    let json;
    try {
      json = await this.postJson(`${this.baseURL}${STEP_PATH}`, headers, body, { signal: req.signal, timeoutMs: req.timeoutMs || 90_000 });
    } catch (err) {
      this._account(null, false);
      throw err;
    }
    if (!json || typeof json !== "object" || Array.isArray(json) || !Array.isArray(json.toolCalls || [])) throw new ProviderError("noahai.live answered with something that is not a model step", { code: "unknown", provider: this.name });
    const toolCalls = (json.toolCalls || []).filter((c) => c && typeof c.name === "string").map((c, i) => ({ id: c.id || `call_${i + 1}`, name: c.name, args: c.args && typeof c.args === "object" ? c.args : {} }));
    const u = json.usage || {};
    const usage = { inputTokens: Number(u.inputTokens) || 0, outputTokens: Number(u.outputTokens) || 0, cachedTokens: Number(u.cachedTokens) || 0 };
    this._account(usage);
    return { text: typeof json.text === "string" ? json.text : "", toolCalls, usage, stopReason: json.stopReason || "", latencyMs: Date.now() - t0, model: json.model || "noahai" };
  }
}

module.exports = { NoahaiProvider, STEP_PATH, SERVER_ROLES };
