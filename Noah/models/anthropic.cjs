// Noah/models/anthropic.cjs
//
// Anthropic Messages API adapter (function/tool calling + vision). Written against
// the public API docs (https://platform.claude.com/docs). NOT exercised against the
// live API in this build (no credentials were available) - see docs/ARCHITECTURE.md.
//
// Uses Noah's own single-tool protocol (`noah_step`) rather than Anthropic's
// computer_toolset_*: it keeps the action schema vendor-neutral and identical
// across providers. Coordinates are in the pixel space of the image we send
// (Anthropic's documented convention), so no conversion is needed.

"use strict";

const { BaseProvider, ProviderError } = require("./base.cjs");

class AnthropicProvider extends BaseProvider {
  get type() {
    return "anthropic";
  }

  _buildBody(req) {
    const messages = req.messages.map((m) => ({
      role: m.role,
      content: m.content.map((c) =>
        c.type === "image"
          ? { type: "image", source: { type: "base64", media_type: c.mime, data: c.base64 } }
          : { type: "text", text: c.text }
      ),
    }));
    const body = {
      model: req.model,
      max_tokens: req.maxTokens || 2048,
      // Static prefix (system + tool schema) is marked cacheable: identical on every step of a task.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
        ...(i === req.tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
      }));
      if (req.toolChoice) body.tool_choice = { type: "tool", name: req.toolChoice };
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    return body;
  }

  async complete(req) {
    const key = this.getKey();
    if (!key) throw new ProviderError("Anthropic API key is not configured", { code: "auth", provider: this.name });
    const t0 = Date.now();
    let json;
    try {
      json = await this.postJson(
        `${this.baseURL}/v1/messages`,
        { "x-api-key": key, "anthropic-version": "2023-06-01" },
        this._buildBody(req),
        { signal: req.signal, timeoutMs: req.timeoutMs }
      );
    } catch (err) {
      this._account(null, false);
      throw err;
    }
    const toolCalls = [];
    let text = "";
    for (const block of json.content || []) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, args: block.input || {} });
    }
    const u = json.usage || {};
    const usage = { inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outputTokens: u.output_tokens || 0, cachedTokens: u.cache_read_input_tokens || 0 };
    this._account(usage);
    return { text, toolCalls, usage, stopReason: json.stop_reason, latencyMs: Date.now() - t0, model: json.model || req.model };
  }
}

module.exports = { AnthropicProvider };
