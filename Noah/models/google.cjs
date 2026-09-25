// Noah/models/google.cjs
//
// Gemini generateContent adapter (functionDeclarations + inlineData vision), written
// against https://ai.google.dev/gemini-api/docs. Gemini's documented computer-use
// convention is a normalised 0-999 grid; that lives in the FrameGeometry
// coordinateSpace ("normalized_1000") chosen from the model catalog, so this file only
// does transport. Uses Noah's own single-tool protocol, not Google's computer_use tool,
// to stay vendor-neutral. NOT exercised against the live API unless the live tier ran
// (see docs/ARCHITECTURE.md "Testing").

"use strict";

const { BaseProvider, ProviderError } = require("./base.cjs");

/** Gemini accepts an OpenAPI-subset schema: drop keywords it rejects. */
function sanitizeSchema(s) {
  if (Array.isArray(s)) return s.map(sanitizeSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (["additionalProperties", "$schema", "default", "examples", "title"].includes(k)) continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, sanitizeSchema(pv)])) : sanitizeSchema(v);
  }
  return out;
}

class GoogleProvider extends BaseProvider {
  get type() {
    return "google";
  }

  _buildBody(req) {
    const contents = req.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: m.content.map((c) => (c.type === "image" ? { inlineData: { mimeType: c.mime, data: c.base64 } } : { text: c.text })),
    }));
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents,
      generationConfig: { maxOutputTokens: req.maxTokens || 2048 },
    };
    if (req.temperature !== undefined) body.generationConfig.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: sanitizeSchema(t.parameters) })) }];
      body.toolConfig = { functionCallingConfig: { mode: "ANY", ...(req.toolChoice ? { allowedFunctionNames: [req.toolChoice] } : {}) } };
    }
    return body;
  }

  async complete(req) {
    const key = this.getKey();
    if (!key) throw new ProviderError("Gemini API key is not configured", { code: "auth", provider: this.name });
    const t0 = Date.now();
    let json;
    try {
      json = await this.postJson(`${this.baseURL}/models/${encodeURIComponent(req.model)}:generateContent`, { "x-goog-api-key": key }, this._buildBody(req), { signal: req.signal, timeoutMs: req.timeoutMs });
    } catch (err) {
      this._account(null, false);
      throw err;
    }
    if (json.promptFeedback?.blockReason) throw new ProviderError(`Gemini blocked the prompt: ${json.promptFeedback.blockReason}`, { code: "content_filtered", provider: this.name });
    const cand = json.candidates?.[0];
    if (!cand) throw new ProviderError("Gemini returned no candidates", { code: "unknown", provider: this.name });
    if (cand.finishReason === "SAFETY" || cand.finishReason === "PROHIBITED_CONTENT") throw new ProviderError(`Gemini stopped: ${cand.finishReason}`, { code: "content_filtered", provider: this.name });
    let text = "";
    const toolCalls = [];
    for (const part of cand.content?.parts || []) {
      if (part.thought) continue; // internal reasoning parts are never surfaced or stored
      if (part.functionCall) toolCalls.push({ id: "gemini", name: part.functionCall.name, args: part.functionCall.args || {} });
      else if (part.text) text += part.text;
    }
    const u = json.usageMetadata || {};
    const usage = { inputTokens: u.promptTokenCount || 0, outputTokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), cachedTokens: u.cachedContentTokenCount || 0 };
    this._account(usage);
    return { text, toolCalls, usage, stopReason: cand.finishReason, latencyMs: Date.now() - t0, model: json.modelVersion || req.model };
  }
}

module.exports = { GoogleProvider, sanitizeSchema };
