// Noah/models/openai.cjs
//
// OpenAI Chat Completions adapter (function calling + image_url vision). Also serves
// every OpenAI-compatible endpoint: Qwen via DashScope, Ollama (/v1), LM Studio, vLLM,
// OpenRouter, ... by changing `baseURL`. Written against the public API docs; NOT
// exercised against a live endpoint in this build.
//
// Local servers vary: if a model rejects `tools`, the adapter transparently retries
// in JSON mode (schema described in the system prompt, JSON parsed from the text).

"use strict";

const { BaseProvider, ProviderError, extractJson } = require("./base.cjs");

class OpenAIProvider extends BaseProvider {
  get type() {
    return "openai";
  }

  _buildBody(req, { jsonMode = false } = {}) {
    const tokenParam = this.options.tokenParam || "max_completion_tokens";
    let system = req.system;
    if (jsonMode && req.tools?.length) {
      const t = req.tools[0];
      system += `\n\nYou cannot call functions in this session. Reply with ONE JSON object and nothing else that conforms to this JSON schema (the arguments of the "${t.name}" tool):\n${JSON.stringify(t.parameters)}`;
    }
    const messages = [{ role: "system", content: system }];
    for (const m of req.messages) {
      const parts = m.content.map((c) =>
        c.type === "image"
          ? { type: "image_url", image_url: { url: `data:${c.mime};base64,${c.base64}`, detail: "high" } }
          : { type: "text", text: c.text }
      );
      // plain string content for text-only turns keeps older local servers happy
      messages.push({ role: m.role, content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
    }
    const body = { model: req.model, messages, [tokenParam]: req.maxTokens || 2048 };
    if (req.tools?.length && !jsonMode) {
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      if (req.toolChoice) body.tool_choice = { type: "function", function: { name: req.toolChoice } };
    }
    if (jsonMode) body.response_format = { type: "json_object" };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    return body;
  }

  async _send(req, jsonMode) {
    const key = this.getKey();
    const headers = key ? { authorization: `Bearer ${key}` } : {};
    return this.postJson(`${this.baseURL}/chat/completions`, headers, this._buildBody(req, { jsonMode }), { signal: req.signal, timeoutMs: req.timeoutMs });
  }

  async complete(req) {
    if (!this.getKey() && !this.options.keyless) throw new ProviderError(`${this.name} API key is not configured`, { code: "auth", provider: this.name });
    const t0 = Date.now();
    this._noTools = this._noTools || new Set();
    const wantJson = this._noTools.has(req.model);
    let json;
    let usedJson = wantJson;
    try {
      json = await this._send(req, wantJson);
    } catch (err) {
      // Local/compat servers that reject the `tools` field: fall back to JSON mode once and remember.
      if (err.code === "invalid_request" && req.tools?.length && !wantJson && /tool|function/i.test(err.message)) {
        this._noTools.add(req.model);
        usedJson = true;
        try {
          json = await this._send(req, true);
        } catch (err2) {
          this._account(null, false);
          throw err2;
        }
      } else {
        this._account(null, false);
        throw err;
      }
    }
    const choice = json.choices?.[0];
    if (!choice) throw new ProviderError(`${this.name}: empty response`, { code: "unknown", provider: this.name });
    if (choice.finish_reason === "content_filter") throw new ProviderError(`${this.name}: response blocked by content filter`, { code: "content_filtered", provider: this.name });
    const msg = choice.message || {};
    const toolCalls = [];
    for (const tc of msg.tool_calls || []) {
      let args = {};
      try {
        args = JSON.parse(tc.function?.arguments || "{}");
      } catch (_) {
        args = extractJson(tc.function?.arguments) || {};
      }
      toolCalls.push({ id: tc.id, name: tc.function?.name, args });
    }
    let text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p) => p.text || "").join("") : "";
    if (!toolCalls.length && req.tools?.length && text) {
      const parsed = extractJson(text);
      if (parsed && typeof parsed === "object") toolCalls.push({ id: "json", name: req.toolChoice || req.tools[0].name, args: parsed.arguments || parsed });
    }
    const u = json.usage || {};
    const usage = { inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0, cachedTokens: u.prompt_tokens_details?.cached_tokens || 0 };
    this._account(usage);
    return { text, toolCalls, usage, stopReason: choice.finish_reason, latencyMs: Date.now() - t0, model: json.model || req.model, jsonMode: usedJson };
  }
}

module.exports = { OpenAIProvider };
