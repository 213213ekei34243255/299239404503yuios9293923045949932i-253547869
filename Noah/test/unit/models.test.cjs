"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { AnthropicProvider } = require("../../models/anthropic.cjs");
const { OpenAIProvider } = require("../../models/openai.cjs");
const { GoogleProvider, sanitizeSchema } = require("../../models/google.cjs");
const { translateAction, RexyLegacyProvider } = require("../../models/rexy-legacy.cjs");
const { ScriptedProvider, FailingProvider } = require("../../models/scripted.cjs");
const { ModelRouter, RouterError } = require("../../models/router.cjs");
const { ProviderError, redact, extractJson } = require("../../models/base.cjs");
const { ConfigStore, parseEnvFile, sanitizePatch } = require("../../config.cjs");
const { toolSchema } = require("../../protocol/actions.cjs");
const { EventBus } = require("../../events.cjs");

const TOOL = { name: "noah_step", description: "step", parameters: toolSchema() };
const REQ = () => ({
  model: "m",
  system: "SYS",
  maxTokens: 500,
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image", mime: "image/jpeg", base64: "QUJD" }] }],
  tools: [TOOL],
  toolChoice: "noah_step",
});

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, headers: opts.headers, body });
    const r = await handler({ url, headers: opts.headers, body, n: calls.length });
    const status = r.status || 200;
    return { ok: status < 400, status, headers: { get: (h) => (r.headers || {})[h.toLowerCase()] ?? null }, text: async () => (typeof r.json === "string" ? r.json : JSON.stringify(r.json)) };
  };
  f.calls = calls;
  return f;
}

// ---- Anthropic ------------------------------------------------------------------------------

test("anthropic: request shape (system cache_control, tools/input_schema, tool_choice, base64 image) and tool_use parsing", async () => {
  const f = fakeFetch(() => ({ json: { model: "claude-x", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "tu1", name: "noah_step", input: { status: "done", summary: "s" } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 40 }, stop_reason: "tool_use" } }));
  const p = new AnthropicProvider({ name: "anthropic", baseURL: "https://api.anthropic.com/", getKey: () => "KEY", fetch: f });
  const res = await p.complete(REQ());
  const c = f.calls[0];
  assert.equal(c.url, "https://api.anthropic.com/v1/messages");
  assert.equal(c.headers["x-api-key"], "KEY");
  assert.equal(c.headers["anthropic-version"], "2023-06-01");
  assert.equal(c.body.system[0].cache_control.type, "ephemeral");
  assert.equal(c.body.tools[0].input_schema.type, "object");
  assert.deepEqual(c.body.tool_choice, { type: "tool", name: "noah_step" });
  assert.deepEqual(c.body.messages[0].content[1], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } });
  assert.equal(c.body.max_tokens, 500);
  assert.ok(!("temperature" in c.body));
  assert.deepEqual(res.toolCalls, [{ id: "tu1", name: "noah_step", args: { status: "done", summary: "s" } }]);
  assert.equal(res.usage.inputTokens, 50);
  assert.equal(res.usage.cachedTokens, 40);
});

test("anthropic: HTTP errors map to router codes (auth, rate_limit, quota, overloaded)", async () => {
  const mk = (status, body) => new AnthropicProvider({ name: "anthropic", baseURL: "http://x", getKey: () => "k", fetch: fakeFetch(() => ({ status, json: body })) });
  await assert.rejects(mk(401, { error: "bad key" }).complete(REQ()), (e) => e.code === "auth");
  await assert.rejects(mk(429, { error: "slow down" }).complete(REQ()), (e) => e.code === "rate_limit");
  await assert.rejects(mk(429, { error: "You exceeded your current quota" }).complete(REQ()), (e) => e.code === "quota");
  await assert.rejects(mk(529, { error: "overloaded" }).complete(REQ()), (e) => e.code === "overloaded" && e.retryable);
  await assert.rejects(mk(400, { error: "bad" }).complete(REQ()), (e) => e.code === "invalid_request");
});

test("missing API key fails as auth without any network call", async () => {
  const f = fakeFetch(() => ({ json: {} }));
  const p = new AnthropicProvider({ name: "anthropic", baseURL: "http://x", getKey: () => null, fetch: f });
  await assert.rejects(p.complete(REQ()), (e) => e.code === "auth");
  assert.equal(f.calls.length, 0);
});

// ---- OpenAI-compatible ------------------------------------------------------------------------

test("openai: chat/completions shape, image_url data URL, function tool_choice, tool_calls arguments parsed, token param", async () => {
  const f = fakeFetch(() => ({ json: { model: "gpt", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", function: { name: "noah_step", arguments: '{"status":"continue","summary":"x","actions":[{"action":"wait","ms":5}]}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 64 } } } }));
  const p = new OpenAIProvider({ name: "openai", baseURL: "https://api.openai.com/v1", getKey: () => "K", fetch: f, options: { tokenParam: "max_completion_tokens" } });
  const res = await p.complete(REQ());
  const b = f.calls[0].body;
  assert.equal(f.calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(f.calls[0].headers.authorization, "Bearer K");
  assert.equal(b.messages[0].role, "system");
  assert.equal(b.messages[1].content[1].image_url.url, "data:image/jpeg;base64,QUJD");
  assert.deepEqual(b.tool_choice, { type: "function", function: { name: "noah_step" } });
  assert.equal(b.tools[0].type, "function");
  assert.equal(b.max_completion_tokens, 500);
  assert.equal(res.toolCalls[0].args.actions[0].action, "wait");
  assert.equal(res.usage.cachedTokens, 64);
});

test("openai-compatible local server: keyless (no auth header), max_tokens param, falls back to JSON mode when tools are rejected", async () => {
  let n = 0;
  const f = fakeFetch(({ body }) => {
    n++;
    if (n === 1) return { status: 400, json: { error: { message: "registry.ollama.ai/library/tinyvl does not support tools" } } };
    assert.ok(!body.tools, "retry must not send tools");
    assert.equal(body.response_format.type, "json_object");
    return { json: { choices: [{ finish_reason: "stop", message: { content: '```json\n{"status":"done","summary":"ok","result":"42"}\n```' } }], usage: { prompt_tokens: 5, completion_tokens: 5 } } };
  });
  const p = new OpenAIProvider({ name: "local", baseURL: "http://127.0.0.1:11434/v1", getKey: () => null, fetch: f, options: { keyless: true, tokenParam: "max_tokens" } });
  const res = await p.complete(REQ());
  assert.equal(f.calls[0].headers.authorization, undefined);
  assert.equal(f.calls[0].body.max_tokens, 500);
  assert.equal(res.toolCalls[0].args.status, "done");
  assert.equal(res.jsonMode, true);
  await p.complete(REQ()); // remembered: goes straight to JSON mode
  assert.ok(!f.calls[2].body.tools);
});

// ---- Google -----------------------------------------------------------------------------------

test("google: generateContent shape (systemInstruction, inlineData, functionDeclarations w/o unsupported keys, mode ANY) and functionCall parsing", async () => {
  const f = fakeFetch(() => ({ json: { modelVersion: "gemini-x", candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "secret reasoning" }, { functionCall: { name: "noah_step", args: { status: "done", summary: "s" } } }] } }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 4 } } }));
  const p = new GoogleProvider({ name: "google", baseURL: "https://generativelanguage.googleapis.com/v1beta", getKey: () => "GK", fetch: f });
  const res = await p.complete({ ...REQ(), model: "gemini-3.8-flash" });
  const c = f.calls[0];
  assert.equal(c.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
  assert.equal(c.headers["x-goog-api-key"], "GK");
  assert.equal(c.body.systemInstruction.parts[0].text, "SYS");
  assert.deepEqual(c.body.contents[0].parts[1], { inlineData: { mimeType: "image/jpeg", data: "QUJD" } });
  assert.deepEqual(c.body.toolConfig.functionCallingConfig, { mode: "ANY", allowedFunctionNames: ["noah_step"] });
  assert.ok(!/additionalProperties|\$schema/.test(JSON.stringify(c.body.tools)));
  assert.equal(res.toolCalls[0].args.status, "done");
  assert.ok(!res.text.includes("secret reasoning"), "thought parts are never surfaced");
});

test("google: blocked prompt -> content_filtered; sanitizeSchema strips keywords Gemini rejects", async () => {
  const p = new GoogleProvider({ name: "google", baseURL: "http://x", getKey: () => "k", fetch: fakeFetch(() => ({ json: { promptFeedback: { blockReason: "SAFETY" } } })) });
  await assert.rejects(p.complete(REQ()), (e) => e.code === "content_filtered");
  assert.deepEqual(sanitizeSchema({ type: "object", additionalProperties: false, properties: { a: { type: "string", default: "x" } } }), { type: "object", properties: { a: { type: "string" } } });
});

// ---- legacy adapter ---------------------------------------------------------------------------------

test("legacy: Rexy actions translate to Noah actions; unsafe legacy actions are dropped", () => {
  assert.deepEqual(translateAction({ type: "click", selector: "e12" }), { action: "click", target: { ref: "e12" } });
  assert.deepEqual(translateAction({ type: "click", selector: "Add to cart" }), { action: "click", target: { text: "Add to cart" } });
  assert.deepEqual(translateAction({ type: "type", selector: "f1e3", text: "hi" }), { action: "type", target: { ref: "f1e3" }, text: "hi" });
  assert.deepEqual(translateAction({ type: "scroll", deltaY: -300 }), { action: "scroll", direction: "up", amount: 300 });
  assert.deepEqual(translateAction({ type: "goBack" }), { action: "back" });
  assert.equal(translateAction({ type: "executeJS", script: "alert(1)" }), null);
});

test("legacy provider: sends refs as selectors, maps response, drops executeJS and reports it", async () => {
  const f = fakeFetch(() => ({ json: { complete: false, reason: "click it", actions: [{ type: "executeJS", script: "x" }, { type: "click", selector: "e2" }] } }));
  const p = new RexyLegacyProvider({ name: "rexy", baseURL: "https://legacy.example/predict", getKey: () => null, fetch: f, options: { keyless: true } });
  const res = await p.complete({ ...REQ(), meta: { goal: "g", observation: { url: "https://a.test", title: "T", elements: [{ ref: "e2", role: "button", name: "Go", states: {} }], tabs: [], pageText: { viewport: "hi" } } } });
  assert.equal(f.calls[0].body.observation.page.buttons[0].selector, '[data-noah-ref="e2"]');
  assert.deepEqual(res.toolCalls[0].args.actions, [{ action: "click", target: { ref: "e2" } }]);
  assert.match(res.toolCalls[0].args.notes[0], /executeJS/);
});

test("legacy provider: maps echoed ref selectors AND selectors the model invents back to our element refs", async () => {
  const els = [
    { ref: "e1", role: "textbox", name: "Search products", states: {} },
    { ref: "e2", role: "button", name: "Search", states: {} },
    { ref: "e3", role: "link", name: "Sign in", href: "/login", states: {} },
  ];
  const { translateAction } = require("../../models/rexy-legacy.cjs");
  const t = (selector) => translateAction({ type: "click", selector }, els).target;
  assert.deepEqual(t('[data-noah-ref="e2"]'), { ref: "e2" }); // echoed verbatim (what the live server does)
  assert.deepEqual(t("#e3"), { ref: "e3" });
  assert.deepEqual(t("e1"), { ref: "e1" });
  assert.deepEqual(t("#Search_products"), { ref: "e1" }); // invented from the element's name
  assert.deepEqual(t('input[placeholder="Search products"]'), { ref: "e1" });
  assert.deepEqual(t("text=Sign in"), { ref: "e3" });
  assert.deepEqual(t("#no_such_thing"), { text: "no such thing" }); // unresolved: fuzzy text target, never a raw CSS string
});

// ---- helpers ------------------------------------------------------------------------------------------

test("redact never leaks keys; extractJson handles fences and prose", () => {
  assert.ok(!redact("failed with key AIzaSyA1234567890abcdefghijklmnop").includes("AIza"));
  assert.ok(!redact("Authorization: Bearer abcdefghijklmnopqrstuv").includes("abcdefghij"));
  assert.deepEqual(extractJson('Sure! ```json\n{"a":1}\n``` done'), { a: 1 });
  assert.deepEqual(extractJson('prefix {"a":2} suffix'), { a: 2 });
  assert.equal(extractJson("no json here"), null);
});

// ---- config / secrets ---------------------------------------------------------------------------------------

test("config: only allow-listed .env names are read; renderer view never contains keys; generic *_BASE_URL is ignored", () => {
  const parsed = parseEnvFile('GEMINI_API_KEY=abc123\nset GOOGLE_APPLICATION_CREDENTIALS=C:\\x.json\nSOMETHING_ELSE=1\n# c\nANTHROPIC_API_KEY="qq"');
  assert.deepEqual(parsed, { GEMINI_API_KEY: "abc123", ANTHROPIC_API_KEY: "qq" });
  const cfg = new ConfigStore({ env: { OPENAI_API_KEY: "sk-test-1234567890", ANTHROPIC_BASE_URL: "https://proxy.evil/" } });
  assert.equal(cfg.getKey("openai"), "sk-test-1234567890");
  assert.equal(cfg.getBaseURL("anthropic"), "https://api.anthropic.com", "generic ANTHROPIC_BASE_URL must not redirect Noah's traffic");
  const view = JSON.stringify(cfg.publicView());
  assert.ok(!view.includes("sk-test"));
  assert.equal(cfg.publicView().providerStatus.openai.hasKey, true);
  assert.equal(cfg.publicView().providerStatus.anthropic.hasKey, false);
});

test("config: sanitizePatch rejects junk and prototype pollution", () => {
  const p = sanitizePatch({ policy: { mode: "hacker", allowedDomains: ["a.com", 5, { x: 1 }] }, __proto__: { polluted: 1 }, sessionMode: "isolated", roles: { planner: [{ provider: "x", model: "y" }, "bad"] } });
  assert.equal(p.policy.mode, undefined);
  assert.deepEqual(p.policy.allowedDomains, ["a.com"]);
  assert.equal(p.sessionMode, "isolated");
  assert.equal(p.roles.planner.length, 1);
  assert.equal({}.polluted, undefined);
});

// ---- router --------------------------------------------------------------------------------------------------

function routerWith({ env = {}, providers = {}, roles, routing } = {}) {
  const cfg = new ConfigStore({ env });
  if (roles) cfg.get().roles = { ...cfg.get().roles, ...roles };
  if (routing) Object.assign(cfg.get().routing, routing);
  const bus = new EventBus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  return { router: new ModelRouter({ config: cfg, bus, providers }), events, cfg };
}
const ok = (name) => new ScriptedProvider(() => ({ status: "done", summary: name, result: name }), { name });

test("router: picks the first configured candidate per role and skips unconfigured providers", async () => {
  const { router } = routerWith({ env: { ANTHROPIC_API_KEY: "k" }, providers: { anthropic: ok("anthropic") } });
  const res = await router.call("browser", { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "t" }] }], tools: [TOOL], toolChoice: "noah_step" });
  assert.equal(res.provider, "anthropic"); // google (first in list) has no key
  assert.equal(res.modelId, "claude-sonnet-5");
});

test("router: failover on rate_limit is VISIBLE (event) and the failed model cools down", async () => {
  const good = ok("anthropic");
  const bad = new FailingProvider("google", ["rate_limit"], null);
  const { router, events } = routerWith({ env: { GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a" }, providers: { google: bad, anthropic: good } });
  const req = { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "t" }] }], tools: [TOOL], toolChoice: "noah_step" };
  const res = await router.call("browser", req);
  assert.equal(res.provider, "anthropic");
  const fo = events.find((e) => e.event === "model_failover");
  assert.ok(fo, "failover must be announced, never silent");
  assert.equal(fo.reason, "rate_limit");
  assert.match(fo.text, /switching to/);
  await router.call("browser", req);
  assert.equal(bad.calls, 1, "cooling-down model is not retried immediately");
});

test("router SAFETY: sensitive task never fails over to an untrusted or local model - it stops", async () => {
  const bad = new FailingProvider("anthropic", ["overloaded", "overloaded"], null);
  const { router } = routerWith({
    env: { ANTHROPIC_API_KEY: "a", DASHSCOPE_API_KEY: "q" },
    providers: { anthropic: bad, qwen: ok("qwen"), local: ok("local") },
    roles: { browser: [{ provider: "anthropic", model: "claude-sonnet-5", trusted: true }, { provider: "qwen", model: "qwen3.8-27b" /* untrusted */ }, { provider: "local", model: "qwen3-vl:8b" }] },
  });
  const req = { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "buy it" }] }], tools: [TOOL], toolChoice: "noah_step" };
  await assert.rejects(router.call("browser", req, { sensitive: true }), (e) => e instanceof RouterError && e.code === "NO_TRUSTED_MODEL");
  // a NON-sensitive task may fall back to the untrusted model
  const { router: r2 } = routerWith({
    env: { ANTHROPIC_API_KEY: "a", DASHSCOPE_API_KEY: "q" },
    providers: { anthropic: new FailingProvider("anthropic", ["overloaded"], null), qwen: ok("qwen") },
    roles: { browser: [{ provider: "anthropic", model: "claude-sonnet-5", trusted: true }, { provider: "qwen", model: "qwen3.8-27b" }] },
  });
  assert.equal((await r2.call("browser", req, { sensitive: false })).provider, "qwen");
});

test("router SAFETY: local/legacy models serve sensitive tasks only when explicitly allowed", () => {
  const { router } = routerWith({ providers: { local: ok("local") }, roles: { browser: [{ provider: "local", model: "qwen3-vl:8b" }] } });
  assert.equal(router.usable("browser", { sensitive: false }).length, 1);
  assert.equal(router.usable("browser", { sensitive: true }).length, 0);
  const { router: r2 } = routerWith({ providers: { local: ok("local") }, roles: { browser: [{ provider: "local", model: "qwen3-vl:8b" }] }, routing: { allowSensitiveOnLocal: true } });
  assert.equal(r2.usable("browser", { sensitive: true }).length, 1);
});

test("router: vision calls never route to the text-only legacy backend; clear error when nothing can see", async () => {
  const { router } = routerWith({ providers: { rexy: ok("rexy") }, roles: { browser: [], vision: [], planner: [], fast: [], local: [] } });
  assert.equal(router.usable("browser", { needsVision: false }).length, 1); // legacy is the last resort for text
  assert.equal(router.usable("browser", { needsVision: true }).length, 0);
  await assert.rejects(router.call("vision", { system: "s", messages: [], tools: [TOOL] }, { needsVision: true }), (e) => e.code === "NO_MODEL" && /vision-capable/.test(e.message));
});

test("router: non-transient errors (invalid_request) are surfaced, not silently failed over", async () => {
  const bad = new FailingProvider("anthropic", ["invalid_request"], null);
  const { router } = routerWith({ env: { ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" }, providers: { anthropic: bad, google: ok("g") }, roles: { browser: [{ provider: "anthropic", model: "claude-sonnet-5", trusted: true }, { provider: "google", model: "gemini-3.8-flash", trusted: true }] } });
  await assert.rejects(router.call("browser", { system: "s", messages: [], tools: [TOOL] }), (e) => e instanceof ProviderError && e.code === "invalid_request");
});

test("router: coordinate space and image limit come from the catalog per model", async () => {
  const { router } = routerWith({ env: { GEMINI_API_KEY: "g" }, providers: { google: ok("g") } });
  const res = await router.call("vision", { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "t" }] }], tools: [TOOL], toolChoice: "noah_step" }, { needsVision: true });
  assert.equal(res.coordinateSpace, "normalized_1000");
  assert.ok(res.maxImageLongEdge > 0);
});

test("router SAFETY: a trusted model that is merely COOLING DOWN never causes a sensitive call to be served by an untrusted one", async () => {
  const trustedBad = new FailingProvider("anthropic", ["overloaded"], null);
  const { router } = routerWith({
    env: { ANTHROPIC_API_KEY: "a", DASHSCOPE_API_KEY: "q" },
    providers: { anthropic: trustedBad, qwen: ok("qwen") },
    roles: { browser: [{ provider: "anthropic", model: "claude-sonnet-5", trusted: true }, { provider: "qwen", model: "qwen3.8-27b" }] },
  });
  const req = { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "pay" }] }], tools: [TOOL], toolChoice: "noah_step" };
  await assert.rejects(router.call("browser", req, { sensitive: true }), (e) => e.code === "NO_TRUSTED_MODEL"); // 1st call: trusted fails -> stop
  // 2nd call: the trusted model is now cooling down; the router must STILL refuse the untrusted fallback
  await assert.rejects(router.call("browser", req, { sensitive: true }), (e) => e.code === "NO_TRUSTED_MODEL" || e.code === "ALL_FAILED" || e.code === "NO_MODEL");
  assert.equal(router.usable("browser", { sensitive: true }).length, 0);
  assert.equal(router.usable("browser", { sensitive: false }).length, 1); // non-sensitive work may still use it
});

// ---- regressions found by the first real-provider run (invalid Gemini key + suspended legacy backend) -----------

test("google: 400 API_KEY_INVALID is an AUTH failure (fails over), and the error is one readable line", async () => {
  const body = { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } };
  const g = new GoogleProvider({ name: "google", baseURL: "http://x", getKey: () => "k", fetch: fakeFetch(() => ({ status: 400, json: body })) });
  await assert.rejects(g.complete(REQ()), (e) => e.code === "auth" && e.message === "google HTTP 400: API key not valid. Please pass a valid API key.");
  // a genuinely malformed request is still our bug, not a failover
  const g2 = new GoogleProvider({ name: "google", baseURL: "http://x", getKey: () => "k", fetch: fakeFetch(() => ({ status: 400, json: { error: { message: "Invalid JSON payload" } } })) });
  await assert.rejects(g2.complete(REQ()), (e) => e.code === "invalid_request");
});

test("router: a dead legacy backend is tried ONCE per call, not forever (retry-storm regression)", async () => {
  const dead = new FailingProvider("rexy", ["overloaded", "overloaded", "overloaded", "overloaded", "overloaded", "overloaded"], null);
  const badGoogle = new FailingProvider("google", ["auth"], null);
  const { router, events } = routerWith({ env: { GEMINI_API_KEY: "bad" }, providers: { google: badGoogle, rexy: dead } });
  const req = { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "t" }] }], tools: [TOOL], toolChoice: "noah_step" };
  await assert.rejects(router.call("planner", req), (e) => e instanceof RouterError && e.code === "ALL_FAILED");
  assert.equal(dead.calls, 1, "legacy fallback must obey the per-call exclusion set");
  assert.equal(badGoogle.calls, 1);
  assert.ok(events.filter((e) => e.event === "model_failover").length <= 3, "failover events stay bounded");
  // While they cool down, the next call must not hammer a rejected key (auth cooldowns stay in force). A transiently
  // failing backend that is the only option left IS tried again - at most once per call - so one slow answer cannot make
  // the agent "unavailable" for the length of the cooldown.
  await assert.rejects(router.call("planner", req));
  assert.equal(badGoogle.calls, 1, "a rejected API key is not retried during its cooldown");
  assert.equal(dead.calls, 2, "the only transiently-failing option is tried once more, not in a loop");
});

test("router: ONE slow answer does not make the agent 'unavailable' - a transiently cooling only-option stays usable; a rejected key does not", async () => {
  const flaky = new FailingProvider("rexy", ["timeout"], null);
  const { router } = routerWith({ env: {}, providers: { rexy: flaky } });
  const req = { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "t" }] }], tools: [TOOL], toolChoice: "noah_step" };
  assert.equal(router.isAvailable(), true);
  await assert.rejects(router.call("browser", req)); // the timeout: the model now cools down
  assert.equal(router.isAvailable(), true, "the next instruction must still be accepted");
  const badKey = new FailingProvider("google", ["auth", "auth"], null);
  const { router: r2 } = routerWith({ env: { GEMINI_API_KEY: "bad" }, roles: { browser: [{ provider: "google", model: "gemini-2.5-flash" }] }, routing: { allowLegacyFallback: false }, providers: { google: badKey } });
  await assert.rejects(r2.call("browser", req));
  assert.equal(r2.isAvailable(), false, "an auth failure stays cooled: retrying it every call would only hammer a rejected key");
});

test("router: an HTTP auth failure (no Retry-After header) still cools the provider down - it is not re-hit every call", async () => {
  const f = fakeFetch(() => ({ status: 400, json: { error: { message: "API key not valid. Please pass a valid API key." } } }));
  const google = new GoogleProvider({ name: "google", baseURL: "http://x", getKey: () => "bad", fetch: f });
  const { router } = routerWith({ env: { GEMINI_API_KEY: "bad", ANTHROPIC_API_KEY: "a" }, providers: { google, anthropic: ok("anthropic") } });
  const req = { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "t" }] }], tools: [TOOL], toolChoice: "noah_step" };
  for (let i = 0; i < 3; i++) assert.equal((await router.call("browser", req)).provider, "anthropic");
  assert.equal(f.calls.length, 1, "Number(null)===0 used to make retryAfterMs 0 and disable the cooldown");
});

test("legacy provider: plans locally, opens the user's URL first, gives `type` fill semantics and submits search boxes", async () => {
  const els = [{ ref: "e1", role: "searchbox", name: "Search products", states: {} }, { ref: "e2", role: "button", name: "Go", states: {} }];
  const obs = (url) => ({ url, title: "T", elements: els, tabs: [], pageText: { viewport: "hi" } });
  const f = fakeFetch(() => ({ json: { complete: false, reason: "type it", actions: [{ type: "type", selector: '[data-noah-ref="e1"]', text: "laptops" }] } }));
  const p = new RexyLegacyProvider({ name: "rexy", baseURL: "https://legacy.example/predict", getKey: () => null, fetch: f, options: { keyless: true } });
  const goal = "open http://127.0.0.1:9/ and find laptops"; // (a "search for" goal is typed locally, see the search-box test below)

  // planner: answered locally, the server is not called
  const plan = await p.complete({ ...REQ(), toolChoice: "noah_plan", meta: { goal, kind: "plan" } });
  assert.equal(plan.toolCalls[0].name, "noah_plan");
  assert.equal(f.calls.length, 0);

  // first step on a different origin: navigate to the URL from the goal, still no server call
  const nav = await p.complete({ ...REQ(), meta: { goal, observation: obs("file:///C:/Jonah2/home.html"), recentActions: [] } });
  assert.deepEqual(nav.toolCalls[0].args.actions, [{ action: "navigate", url: "http://127.0.0.1:9/" }]);
  assert.equal(f.calls.length, 0);

  // on the shop: the server is asked; type is a fill (clear) and the lone search box is submitted
  const step = await p.complete({ ...REQ(), meta: { goal, observation: obs("http://127.0.0.1:9/"), recentActions: [{ step: 1, text: 'navigate http://127.0.0.1:9/ -> ok [url_changed] via browser', ok: true }] } });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body.memory.recentActions[0], { action: "navigate", args: { url: "http://127.0.0.1:9/" }, result: { success: true, message: 'navigate http://127.0.0.1:9/ -> ok [url_changed] via browser' } });
  const a = step.toolCalls[0].args.actions[0];
  assert.deepEqual({ action: a.action, ref: a.target.ref, clear: a.clear, submit: a.submit }, { action: "type", ref: "e1", clear: true, submit: true });
  assert.match(step.toolCalls[0].args.notes[0], /auto-submitted/);
});

test("legacy provider: a URL invented from link text becomes a click on that link; a redundant navigate to the current page is dropped", async () => {
  const els = [{ ref: "e5", role: "link", name: "Laptops", href: "/search?q=laptop", states: {} }, { ref: "e6", role: "searchbox", name: "Search products", states: {} }];
  const respond = (actions) => new RexyLegacyProvider({ name: "rexy", baseURL: "https://legacy.example/predict", getKey: () => null, options: { keyless: true }, fetch: fakeFetch(() => ({ json: { complete: false, reason: "r", actions } })) });
  const ctx = { goal: "find laptops", observation: { url: "http://127.0.0.1:9/", title: "T", elements: els, tabs: [], pageText: { viewport: "" } }, recentActions: [{ step: 1, text: "navigate http://127.0.0.1:9/ -> ok", ok: true }] };
  const a = await respond([{ type: "navigate", url: "http://127.0.0.1:9/Laptops" }]).complete({ ...REQ(), meta: ctx });
  assert.deepEqual(a.toolCalls[0].args.actions, [{ action: "click", target: { ref: "e5" } }]);
  const b = await respond([{ type: "navigate", url: "http://127.0.0.1:9/" }, { type: "click", selector: '[data-noah-ref="e5"]' }]).complete({ ...REQ(), meta: ctx });
  assert.deepEqual(b.toolCalls[0].args.actions, [{ action: "click", target: { ref: "e5" } }]);
  assert.match(b.toolCalls[0].args.notes.join(" "), /redundant navigate/);
});

test("legacy provider: 'navigate to where I already am' means it thinks it is done -> answer from the page via chat mode", async () => {
  const f = fakeFetch(({ body }) => (body.mode === "chat" ? { json: { answer: "The cheapest 16GB laptop is 61,999." } } : { json: { complete: false, reason: "go", actions: [{ type: "navigate", url: "http://127.0.0.1:9/search?q=laptop" }] } }));
  const p = new RexyLegacyProvider({ name: "rexy", baseURL: "https://legacy.example/predict", getKey: () => null, fetch: f, options: { keyless: true } });
  const meta = { goal: "find the cheapest 16GB laptop", taskId: "t1", observation: { url: "http://127.0.0.1:9/search?q=laptop", title: "R", elements: [], tabs: [], pageText: { viewport: "v", content: "Laptop A 16GB 61,999\nLaptop B 8GB 40,000" } }, recentActions: [{ step: 1, text: "navigate x -> ok", ok: true }, { step: 2, text: "click e5 -> ok", ok: true }] };
  const res = await p.complete({ ...REQ(), meta });
  assert.equal(res.toolCalls[0].args.status, "done");
  assert.equal(res.toolCalls[0].args.result, "The cheapest 16GB laptop is 61,999.");
  const chat = f.calls.find((c) => c.body.mode === "chat");
  assert.match(chat.body.page_content, /61,999/);
  // too early (fewer than 2 prior actions): do not answer from an arbitrary page
  const early = await p.complete({ ...REQ(), meta: { ...meta, taskId: "t2", recentActions: [] } });
  assert.notEqual(early.toolCalls[0].args.status, "done");
});

test("legacy provider: the goal is rewritten as a plain question (no URL, no 'search for') before asking chat mode", () => {
  const { questionFrom } = require("../../models/rexy-legacy.cjs");
  assert.equal(questionFrom("open http://127.0.0.1:58838/ , search for laptops, and tell me the cheapest laptop with 16GB of RAM and its price."), "tell me the cheapest laptop with 16GB of RAM and its price.");
  assert.equal(questionFrom("find the cheapest 16GB laptop"), "find the cheapest 16GB laptop");
  assert.equal(questionFrom("go to amazon.in, search for headphones under 2000, then list the top three"), "list the top three");
});

test("legacy provider: 'open youtube.com' / 'open youtube' go to the site first; an action goal finishes without a fake answer; a refusal is never reported as success", async () => {
  const mk = (handler) => { const f = fakeFetch(handler); return { f, p: new RexyLegacyProvider({ name: "rexy", baseURL: "https://legacy.example/predict", getKey: () => null, fetch: f, options: { keyless: true } }) }; };
  const home = { url: "file:///C:/Jonah2/home.html", title: "Jonah", elements: [], tabs: [], pageText: { viewport: "" } };
  for (const [goal, url] of [["open youtube.com and search for lo-fi music", "https://youtube.com"], ["open youtube and search for lo-fi music", "https://youtube.com"], ["go to amazon.in, search for headphones", "https://amazon.in"], ["mail me at bob@example.com", ""],
    // Real bug report: "Openm" (garbled "open") never matched the strict verb regex, so Noah stayed on its own
    // home page and typed the query into Jonah's own search box instead of ever reaching YouTube.
    ["Openm youtube and search for Never say never song", "https://youtube.com"],
    // The typo-tolerant fallback must stay narrow: a site word deep in a normal sentence is not a request to open it.
    ["I love youtube personally but right now let's check twitter for news", ""]]) {
    const { f, p } = mk(() => ({ json: { complete: false, reason: "r", actions: [{ type: "wait", ms: 1 }] } }));
    const res = await p.complete({ ...REQ(), meta: { goal, taskId: "t", observation: home, recentActions: [] } });
    if (url) assert.deepEqual(res.toolCalls[0].args.actions, [{ action: "navigate", url }], goal);
    else assert.notEqual(res.toolCalls[0].args.actions?.[0]?.action, "navigate", goal);
    if (url) assert.equal(f.calls.length, 0);
  }
  // action goal, model says "navigate to where I am": done, and the chat endpoint is never asked
  const results = { url: "https://youtube.com/results?search_query=lo-fi", title: "lo-fi - YouTube", elements: [], tabs: [], pageText: { viewport: "v", content: "c" } };
  const a = mk(() => ({ json: { complete: false, reason: "r", actions: [{ type: "navigate", url: "https://youtube.com/results?search_query=lo-fi" }] } }));
  const done = await a.p.complete({ ...REQ(), meta: { goal: "open youtube.com and look around", taskId: "t2", observation: results, recentActions: [{ text: "navigate x -> ok", ok: true }, { text: 'type e1 "lo-fi" -> ok', ok: true }] } });
  assert.equal(done.toolCalls[0].args.status, "done");
  assert.equal(a.f.calls.filter((c) => c.body.mode === "chat").length, 0);
  // question goal, but the chat mode answers with a refusal: give up, do not claim success
  const b = mk(({ body }) => (body.mode === "chat" ? { json: { answer: "I couldn't find a matching command. Try again with clearer words." } } : { json: { complete: false, reason: "r", actions: [{ type: "navigate", url: "https://youtube.com/results?search_query=lo-fi" }] } }));
  const gave = await b.p.complete({ ...REQ(), meta: { goal: "what is the top video?", taskId: "t3", observation: results, recentActions: [{ text: "a", ok: true }, { text: "b", ok: true }] } });
  assert.equal(gave.toolCalls[0].args.status, "give_up");
});

test("legacy provider: 'Open Amazon and search for shoes cheapest ones' is a browsing goal (finishes on the results page), not a question it must answer", async () => {
  const f = fakeFetch(() => ({ json: { complete: false, reason: "r", actions: [{ type: "navigate", url: "https://www.amazon.com/s?k=shoes" }] } }));
  const p = new RexyLegacyProvider({ name: "rexy", baseURL: "https://legacy.example/predict", getKey: () => null, fetch: f, options: { keyless: true } });
  const meta = { goal: "Open Amazon and browse the cheapest shoes", taskId: "amz", observation: { url: "https://www.amazon.com/s?k=shoes", title: "Amazon.com : shoes", elements: [], tabs: [], pageText: { viewport: "v", content: "c" } }, recentActions: [{ text: "navigate x -> ok", ok: true }, { text: 'type e1 "shoes" -> ok', ok: true }] };
  const res = await p.complete({ ...REQ(), meta });
  assert.equal(res.toolCalls[0].args.status, "done");
  assert.match(res.toolCalls[0].args.result, /Amazon\.com : shoes/);
  assert.equal(f.calls.filter((c) => c.body.mode === "chat").length, 0, "no chat-mode answer for a browsing goal");
});

test("legacy provider: 'search for X' is typed into the site's own search box (visible typing), then the goal finishes on the results page", async () => {
  const { searchIntentFrom, goalNeedsAnswer } = require("../../models/rexy-legacy.cjs");
  assert.deepEqual(searchIntentFrom("Open Amazon and search for shoes cheapest ones"), { query: "shoes cheapest ones", followUp: false });
  assert.deepEqual(searchIntentFrom("search for pants over here"), { query: "pants", followUp: false });
  assert.deepEqual(searchIntentFrom("open https://x.test, search for laptops, and tell me the cheapest one"), { query: "laptops", followUp: false });
  assert.deepEqual(searchIntentFrom("search for node.js tutorials and click the first result"), { query: "node.js tutorials", followUp: true });
  assert.equal(searchIntentFrom("open youtube"), null);
  assert.equal(goalNeedsAnswer("open https://x.test, search for laptops, and tell me the cheapest one"), true);
  assert.equal(goalNeedsAnswer("Open Amazon and search for shoes cheapest ones"), false);

  const els = [{ ref: "e7", role: "searchbox", name: "Search Amazon", states: {} }, { ref: "e8", role: "link", name: "Cart", href: "/cart", states: {} }];
  const f = fakeFetch(() => ({ json: { complete: false, reason: "r", actions: [{ type: "navigate", url: "https://www.amazon.com/womens-shoes/b?node=1" }] } }));
  const p = new RexyLegacyProvider({ name: "rexy", baseURL: "https://legacy.example/predict", getKey: () => null, fetch: f, options: { keyless: true } });
  const goal = "Open Amazon and search for shoes cheapest ones";
  const obs = (url, title) => ({ url, title, elements: els, tabs: [], pageText: { viewport: "v", content: "c" } });
  // on the site, nothing typed yet: type the query live (server not consulted)
  const first = await p.complete({ ...REQ(), meta: { goal, taskId: "a1", observation: obs("https://www.amazon.com/", "Amazon"), recentActions: [{ text: "navigate https://amazon.com -> ok", ok: true }] } });
  assert.deepEqual(first.toolCalls[0].args.actions, [{ action: "type", target: { ref: "e7" }, text: "shoes cheapest ones", clear: true, submit: true }]);
  assert.equal(f.calls.length, 0);
  // typed and the results are showing: done, without asking the model to navigate somewhere else
  const second = await p.complete({ ...REQ(), meta: { goal, taskId: "a1", observation: obs("https://www.amazon.com/s?k=shoes+cheapest+ones", "Amazon.com : shoes cheapest ones"), recentActions: [{ text: "navigate https://amazon.com -> ok", ok: true }, { text: 'type e7 "shoes cheapest ones" -> ok [url_changed]', ok: true }] } });
  assert.equal(second.toolCalls[0].args.status, "done");
  assert.match(second.toolCalls[0].args.result, /shoes cheapest ones/);
  assert.equal(f.calls.length, 0);
});
