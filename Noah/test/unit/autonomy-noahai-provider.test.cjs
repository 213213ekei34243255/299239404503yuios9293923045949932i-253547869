// Noah/test/unit/autonomy-noahai-provider.test.cjs - the hosted-brain provider (Noah/models/noahai.cjs)
// Proven against a REAL HTTP stand-in that implements the /api/llm/step contract AS SPECIFIED, with genuine Ed25519 signature verification.
// It is NOT noahai.live. Until noahai.live builds the endpoint, nothing here says the real service works.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("http");
const { NoahaiProvider, STEP_PATH } = require("../../models/noahai.cjs");
const { ProviderError, classifyHttp } = require("../../models/base.cjs");
const { ModelRouter } = require("../../models/router.cjs");
const { ConfigStore } = require("../../config.cjs");
const { ScriptedProvider } = require("../../models/scripted.cjs");
const { DEFAULT_ROLES, DEFAULT_PROVIDERS, ROLES } = require("../../models/catalog.cjs");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const pubKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey.export({ type: "spki", format: "der" }).subarray(-32)]), format: "der", type: "spki" });
const ACCOUNT = "acct-test-1";
const authHeaders = (method, path, raw) => {
  const ts = String(Math.floor(Date.now() / 1000));
  return { "X-Jonah-Device": ACCOUNT, "X-Jonah-Timestamp": ts, "X-Jonah-Signature": crypto.sign(null, Buffer.from(`${method}\n${path}\n${ts}\n${ACCOUNT}\n${raw}`), privateKey).toString("base64url") };
};

/** The stand-in: verifies the signature over the exact raw body, then answers as `behavior` says. */
function standIn() {
  const seen = [];
  const state = { behavior: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const rec = { method: req.method, path: req.url, headers: req.headers, raw, body: null, signatureOk: false };
      try { rec.body = JSON.parse(raw); } catch (_) { /* reported by the test */ }
      const dev = req.headers["x-jonah-device"];
      const ts = req.headers["x-jonah-timestamp"];
      const sig = req.headers["x-jonah-signature"];
      try { rec.signatureOk = !!(dev && ts && sig) && crypto.verify(null, Buffer.from(`${req.method}\n${req.url}\n${ts}\n${dev}\n${raw}`), pubKey, Buffer.from(sig, "base64url")); } catch (_) { /* false */ }
      seen.push(rec);
      const send = (status, json, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(typeof json === "string" ? json : JSON.stringify(json)); };
      if (!rec.signatureOk) return send(401, { error: { code: "auth", message: "bad or missing signature" } });
      const b = state.behavior;
      if (b) return send(b.status || 200, b.json === undefined ? {} : b.json, b.headers);
      send(200, { text: "", toolCalls: [{ id: "c1", name: rec.body.tools[0].name, args: { path: "src/index.js" } }], usage: { inputTokens: 11, outputTokens: 3, cachedTokens: 2 }, stopReason: "STOP", model: "gemini-test" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, seen, state, close: () => new Promise((r) => server.close(r)) })));
}

const REQ = (over = {}) => ({
  model: "mission",
  system: "SYSTEM RULES",
  messages: [{ role: "user", content: [{ type: "text", text: "the briefing" }, { type: "image", mime: "image/png", base64: "QUJD" }] }],
  tools: [{ name: "fs_read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }, { name: "finish", description: "end", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } }],
  toolChoice: "any", maxTokens: 700, temperature: 0, timeoutMs: 5000, ...over,
});
const provider = (url, o = {}) => new NoahaiProvider({ name: "noahai", baseURL: url, getKey: () => null, getAuthHeaders: authHeaders, ...o });

test("a step: the request carries the normalised model request, signed over exactly the text that was sent; the reply is mapped", async () => {
  const s = await standIn();
  try {
    const res = await provider(s.url).complete(REQ());
    const r = s.seen[0];
    assert.deepEqual([r.method, r.path], ["POST", STEP_PATH]);
    assert.equal(r.signatureOk, true, "the signature verifies against the raw body the server received");
    assert.equal(r.headers["x-jonah-device"], ACCOUNT);
    assert.deepEqual(r.body, { role: "mission", system: "SYSTEM RULES", messages: REQ().messages, tools: REQ().tools, toolChoice: "any", maxTokens: 700, temperature: 0 });
    assert.deepEqual(res.toolCalls, [{ id: "c1", name: "fs_read", args: { path: "src/index.js" } }]);
    assert.deepEqual(res.usage, { inputTokens: 11, outputTokens: 3, cachedTokens: 2 });
    assert.equal(res.model, "gemini-test");
    assert.equal(res.stopReason, "STOP");
    assert.equal(res.text, "");
    assert.ok(res.latencyMs >= 0);
  } finally { await s.close(); }
});

test("the ticket (the paid-for agent use) rides in the SIGNED body as missionRef, and is absent when there is none", async () => {
  const s = await standIn();
  try {
    await provider(s.url).complete({ ...REQ(), meta: { ticket: "0123456789abcdef0123456789abcdef" } });
    await provider(s.url).complete(REQ());
    await provider(s.url).complete({ ...REQ(), meta: { ticket: "" } });
    assert.equal(s.seen[0].body.missionRef, "0123456789abcdef0123456789abcdef");
    assert.equal(s.seen[0].signatureOk, true, "it is inside what is signed: it cannot be swapped by anyone in between");
    assert.equal("missionRef" in s.seen[1].body, false);
    assert.equal("missionRef" in s.seen[2].body, false, "an empty ticket is no ticket");
    assert.deepEqual(Object.keys(s.seen[1].body), ["role", "system", "messages", "tools", "toolChoice", "maxTokens", "temperature"], "the contract's seven keys are unchanged when there is no ticket");
  } finally { await s.close(); }
});

test("the role comes from meta.role when given, defaults are explicit, and a null toolChoice stays null", async () => {
  const s = await standIn();
  try {
    await provider(s.url).complete({ ...REQ({ toolChoice: undefined, temperature: undefined, maxTokens: undefined }), meta: { role: "browser" } });
    assert.deepEqual([s.seen[0].body.role, s.seen[0].body.toolChoice, s.seen[0].body.temperature, s.seen[0].body.maxTokens], ["browser", null, 0, 2048]);
  } finally { await s.close(); }
});

test("tool calls without an id get one, and malformed entries are dropped", async () => {
  const s = await standIn();
  try {
    s.state.behavior = { json: { text: "thinking", toolCalls: [{ name: "fs_read", args: { path: "a" } }, { name: 5 }, null, { name: "finish" }], usage: {} } };
    const res = await provider(s.url).complete(REQ());
    assert.deepEqual(res.toolCalls, [{ id: "call_1", name: "fs_read", args: { path: "a" } }, { id: "call_2", name: "finish", args: {} }], "ids count the valid calls");
    assert.deepEqual(res.usage, { inputTokens: 0, outputTokens: 0, cachedTokens: 0 });
    assert.equal(res.text, "thinking");
  } finally { await s.close(); }
});

test("not signed in: the provider is not ready, and a call never reaches the network", async () => {
  const s = await standIn();
  try {
    const off = provider(s.url, { isSignedIn: () => false });
    assert.equal(off.isReady(), false);
    await assert.rejects(() => off.complete(REQ()), (e) => e instanceof ProviderError && e.code === "auth" && /not signed in/.test(e.message));
    const noSigner = provider(s.url, { getAuthHeaders: undefined });
    assert.equal(noSigner.isReady(), false);
    await assert.rejects(() => provider(s.url, { getAuthHeaders: () => ({}) }).complete(REQ()), (e) => e.code === "auth");
    await assert.rejects(() => provider(s.url, { getAuthHeaders: () => { throw new Error("no device key"); } }).complete(REQ()), (e) => e.code === "auth" && /could not sign/.test(e.message));
    assert.equal(s.seen.length, 0, "no request was sent in any of those cases");
  } finally { await s.close(); }
});

test("a bad signature is refused by the server and comes back as an auth error", async () => {
  const s = await standIn();
  try {
    const forged = (m, p, raw) => ({ ...authHeaders(m, p, raw + " "), });
    await assert.rejects(() => provider(s.url, { getAuthHeaders: forged }).complete(REQ()), (e) => e.code === "auth" && e.status === 401);
    assert.equal(s.seen[0].signatureOk, false);
  } finally { await s.close(); }
});

test("server errors map to the codes the router acts on, and the message stays short", async () => {
  const s = await standIn();
  const err = async (behavior) => { s.state.behavior = behavior; try { await provider(s.url).complete(REQ()); } catch (e) { return e; } return null; };
  try {
    let e = await err({ status: 402, json: { error: { code: "quota", message: "agent allowance used up" } } });
    assert.deepEqual([e.code, e.status], ["quota", 402]);
    assert.match(e.message, /agent allowance used up/);
    e = await err({ status: 429, json: { error: { code: "rate_limit", message: "slow down" } }, headers: { "retry-after": "5" } });
    assert.deepEqual([e.code, e.retryAfterMs], ["rate_limit", 5000]);
    e = await err({ status: 503, json: { error: { code: "overloaded", message: "busy" } } });
    assert.deepEqual([e.code, e.retryable], ["overloaded", true]);
    e = await err({ status: 504, json: { error: { code: "timeout", message: "upstream took too long" } } });
    assert.equal(e.code, "timeout");
    e = await err({ status: 422, json: { error: { code: "content_filtered", message: "blocked by the model's safety filter" } } });
    assert.equal(e.code, "content_filtered", "the error CODE in the body decides, not just the status");
    e = await err({ status: 400, json: { error: { code: "invalid_request", message: "tools[0].parameters is not a schema" } } });
    assert.equal(e.code, "invalid_request");
    e = await err({ status: 413, json: { error: { code: "invalid_request", message: "body too large" } } });
    assert.equal(e.code, "invalid_request");
    e = await err({ status: 403, json: { error: { code: "auth", message: "account suspended" } } });
    assert.equal(e.code, "auth");
    e = await err({ status: 500, json: "<html>boom</html>" });
    assert.equal(e.code, "overloaded");
    assert.ok(e.message.length < 400);
  } finally { await s.close(); }
});

test("a 200 that is not a model step is an error, not an empty success", async () => {
  const s = await standIn();
  try {
    for (const json of ["not json at all", "[]", { toolCalls: "nope" }]) {
      s.state.behavior = { json };
      await assert.rejects(() => provider(s.url).complete(REQ()), (e) => e instanceof ProviderError);
    }
  } finally { await s.close(); }
});

test("an unreachable server is a network error (the router fails over or the mission pauses)", async () => {
  const s = await standIn();
  const url = s.url;
  await s.close();
  await assert.rejects(() => provider(url).complete(REQ()), (e) => e.code === "network");
});

test("the base classifier reads the error code in the body, and leaves other vendors' error shapes alone", () => {
  assert.equal(classifyHttp(422, JSON.stringify({ error: { code: "content_filtered" } })).code, "content_filtered");
  assert.equal(classifyHttp(400, JSON.stringify({ error: { code: "rate_limit" } })).code, "rate_limit");
  assert.equal(classifyHttp(400, JSON.stringify({ error: { code: "invalid_api_key", message: "Incorrect API key" } })).code, "auth", "OpenAI's own code still goes through the old text rules");
  assert.equal(classifyHttp(400, JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "API key not valid" } })).code, "auth");
  assert.equal(classifyHttp(429, "plain text").code, "rate_limit");
  assert.equal(classifyHttp(400, "{ broken").code, "invalid_request");
});

test("the catalog has a mission role that prefers the hosted brain, and the config accepts it", () => {
  assert.ok(ROLES.includes("mission"));
  assert.equal(DEFAULT_ROLES.mission[0].provider, "noahai");
  assert.equal(DEFAULT_ROLES.mission[0].trusted, true);
  assert.ok(DEFAULT_ROLES.mission.length >= 2, "and a fallback behind it");
  assert.equal(DEFAULT_PROVIDERS.noahai.type, "noahai");
  assert.equal(DEFAULT_PROVIDERS.noahai.baseURL, "https://www.noahai.live");
  const cfg = new ConfigStore({ env: {} });
  assert.equal(cfg.get().roles.mission[0].provider, "noahai");
  assert.equal(cfg.getBaseURL("noahai"), "https://www.noahai.live");
});

test("the router uses the hosted brain only when it is ready, and otherwise moves on to the next candidate", async () => {
  const s = await standIn();
  try {
    let signedIn = true;
    const hosted = provider(s.url, { isSignedIn: () => signedIn });
    const backup = new ScriptedProvider(() => ({}), { name: "backup" });
    const cfg = new ConfigStore({ env: {} });
    cfg.get().roles.mission = [{ provider: "noahai", model: "mission", trusted: true }, { provider: "backup", model: "scripted", trusted: true }];
    cfg.get().providers.backup = { type: "scripted", enabled: true };
    const router = new ModelRouter({ config: cfg, providers: { noahai: hosted, backup } });
    assert.equal(router.usable("mission")[0].provider, "noahai");
    const res = await router.call("mission", REQ());
    assert.equal(res.provider, "noahai");
    assert.deepEqual(res.toolCalls[0].args, { path: "src/index.js" });
    assert.equal(s.seen.length, 1);
    signedIn = false;
    assert.equal(router.usable("mission")[0].provider, "backup", "not signed in: skipped without trying");
    const res2 = await router.call("mission", REQ());
    assert.equal(res2.provider, "backup");
    assert.equal(s.seen.length, 1, "and no request went to the hosted brain");
  } finally { await s.close(); }
});

// ------------------------------------------------------------------ the hosted brain serves the Web agent too (browser / vision roles)

test("the role sent to the server is the router's hosted candidate (browser / vision / mission), unless the request names one in meta.role", async () => {
  const s = await standIn();
  try {
    const p = provider(s.url);
    await p.complete(REQ({ model: "vision" }));
    await p.complete(REQ({ model: "browser" }));
    await p.complete(REQ({ model: "mission" }));
    await p.complete({ ...REQ({ model: "vision" }), meta: { role: "planner" } });
    await p.complete(REQ({ model: "gemini-3.8-flash" })); // not a server role: falls back to the old default
    assert.deepEqual(s.seen.map((r) => r.body.role), ["vision", "browser", "mission", "planner", "mission"]);
  } finally { await s.close(); }
});

test("the web agent's noah_step tool is sent in a form Gemini accepts, and an image rides in the message unchanged", async () => {
  const s = await standIn();
  try {
    const { toolSchema } = require("../../protocol/actions.cjs");
    const messy = { type: "object", properties: { a: { type: "string", title: "x", default: "d" }, list: { type: "array", items: { type: "string" } } }, required: ["a"], additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" };
    await provider(s.url).complete({ ...REQ({ model: "vision" }), tools: [{ name: "noah_step", description: "one step", parameters: toolSchema() }, { name: "messy", description: "m", parameters: messy }], toolChoice: "noah_step" });
    const body = s.seen[0].body;
    const step = body.tools.find((t) => t.name === "noah_step").parameters;
    assert.ok(step.properties, "the step schema survived");
    const m = body.tools.find((t) => t.name === "messy").parameters;
    assert.equal(m.additionalProperties, undefined);
    assert.equal(m.$schema, undefined);
    assert.equal(m.properties.a.title, undefined);
    assert.equal(m.properties.a.default, undefined);
    assert.deepEqual(m.required, ["a"]);
    assert.deepEqual(m.properties.list.items, { type: "string" });
    assert.deepEqual(body.messages[0].content[1], { type: "image", mime: "image/png", base64: "QUJD" }, "the screenshot is forwarded exactly as given");
    assert.equal(body.toolChoice, "noah_step");
  } finally { await s.close(); }
});

test("the router: screenshot steps go to the hosted VISION model, text steps to the hosted browser model, and neither is tried when nobody is signed in", async () => {
  const { DEFAULT_ROLES } = require("../../models/catalog.cjs");
  const s = await standIn();
  try {
    let signedIn = true;
    const hosted = provider(s.url, { isSignedIn: () => signedIn });
    const cfg = new ConfigStore({ env: {} });
    cfg.get().roles.browser = JSON.parse(JSON.stringify(DEFAULT_ROLES.browser));
    cfg.get().roles.vision = JSON.parse(JSON.stringify(DEFAULT_ROLES.vision));
    const router = new ModelRouter({ config: cfg, providers: { noahai: hosted } });
    const text = router.usable("browser", { needsVision: false })[0];
    assert.equal(text.key, "noahai:browser");
    const pic = router.usable("vision", { needsVision: true })[0];
    assert.equal(pic.key, "noahai:vision");
    assert.equal(pic.info.coordinateSpace, "normalized_1000", "the screenshot's geometry is built for the 0-1000 scale");
    const viaBrowser = router.usable("browser", { needsVision: true })[0];
    assert.equal(viaBrowser.key, "noahai:vision", "a screenshot step asked of the browser role skips the text-only hosted model");
    const res = await router.call("vision", REQ({ model: undefined }), { needsVision: true });
    assert.equal(res.provider, "noahai");
    assert.equal(res.coordinateSpace, "normalized_1000", "returned with the answer, so the desktop tools read x and y the same way");
    assert.equal(s.seen[s.seen.length - 1].body.role, "vision");
    signedIn = false;
    assert.ok(!router.usable("browser").some((c) => c.provider === "noahai"), "not signed in: not tried");
  } finally { await s.close(); }
});
