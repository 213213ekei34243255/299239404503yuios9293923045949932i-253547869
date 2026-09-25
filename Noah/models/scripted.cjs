// Noah/models/scripted.cjs
//
// TEST-ONLY providers. `ScriptedProvider` is a deterministic reference policy standing
// in for a model so the orchestrator (loop, verification, recovery, safety, checkpoints)
// can be exercised without network access. It is NOT an LLM and any result obtained with
// it must never be reported as LLM task success. Benchmark output labels it explicitly.

"use strict";

const { BaseProvider, ProviderError } = require("./base.cjs");

class ScriptedProvider extends BaseProvider {
  /**
   * @param {(ctx: {request:any, meta:any, step:number}) => object|Promise<object>} policy  returns a Noah envelope
   */
  constructor(policy, { name = "scripted", latencyMs = 0, vision = true } = {}) {
    super({ name, baseURL: "", getKey: () => "scripted", options: { keyless: true } });
    this.policy = policy;
    this.latencyMs = latencyMs;
    this.vision = vision;
    this.step = 0;
    this.requests = [];
  }

  get type() {
    return "scripted";
  }

  async complete(req) {
    const t0 = Date.now();
    this.step++;
    this.requests.push({ system: req.system.length, images: req.messages.flatMap((m) => m.content).filter((c) => c.type === "image").length, textChars: req.messages.flatMap((m) => m.content).filter((c) => c.type === "text").reduce((n, c) => n + c.text.length, 0) });
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const envelope = await this.policy({ request: req, meta: req.meta || {}, step: this.step });
    const inChars = req.system.length + req.messages.flatMap((m) => m.content).filter((c) => c.type === "text").reduce((n, c) => n + c.text.length, 0);
    const usage = { inputTokens: Math.ceil(inChars / 3.6), outputTokens: Math.ceil(JSON.stringify(envelope).length / 3.6) };
    this._account(usage);
    const name = req.toolChoice || req.tools?.[0]?.name || "noah_step";
    return { text: "", toolCalls: [{ id: `s${this.step}`, name, args: envelope }], usage, stopReason: "stop", latencyMs: Date.now() - t0, model: "scripted-policy" };
  }
}

/** Throws the given ProviderError codes in order, then delegates to `inner`. */
class FailingProvider extends BaseProvider {
  constructor(name, codes, inner) {
    super({ name, baseURL: "", getKey: () => "k", options: { keyless: true } });
    this.codes = [...codes];
    this.inner = inner;
    this.calls = 0;
  }

  async complete(req) {
    this.calls++;
    const code = this.codes.shift();
    if (code) throw new ProviderError(`${this.name} simulated ${code}`, { code, provider: this.name, retryable: code === "overloaded" });
    return this.inner ? this.inner.complete(req) : { text: "", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

module.exports = { ScriptedProvider, FailingProvider };
