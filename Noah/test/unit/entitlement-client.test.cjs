// Noah/test/unit/entitlement-client.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EntitlementClient, checkServerUrl, toUnixSeconds, GOOGLE_CLIENT_ID } = require("../../../entitlement-client.cjs");
const { createEntitlementDeviceStore } = require("../../../entitlement-device.cjs");
const { createStandInServer } = require("./entitlement-stand-in-server.cjs");

function keychain(secret) {
  const key = crypto.createHash("sha256").update(secret).digest();
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", key, iv); const enc = Buffer.concat([c.update(s, "utf8"), c.final()]); return Buffer.concat([iv, c.getAuthTag(), enc]); },
    decryptString: (b) => { const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"); },
  };
}

// Stands in for "the user finished signing in as <sub> on Google's real page": the client's REAL loopback listener is already up when
// openExternal is called, so this makes the same real HTTP request Google's own redirect would, with a code the stand-in server accepts.
const googleSaysYouAre = (sub) => async (authUrl) => {
  const u = new URL(authUrl);
  const code = `GOOD:${sub}:${crypto.randomBytes(6).toString("hex")}`;
  await fetch(`${u.searchParams.get("redirect_uri")}?code=${code}&state=${u.searchParams.get("state")}`);
};

async function world(over = {}) {
  const stand = createStandInServer(over);
  const url = await stand.listen();
  const mkDevice = (machineId, secret = "k") => createEntitlementDeviceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "jonah-ec-")), safeStorage: keychain(secret), machineId: () => machineId });
  const mkClient = (device, extra = {}) => new EntitlementClient({ serverUrl: url, device, allowInsecureLoopback: true, ...extra });
  const login = (client, sub = "google-sub-1") => client.loginWithGoogle({ openExternal: googleSaysYouAre(sub) });
  return { stand, url, mkDevice, mkClient, login, close: () => stand.close() };
}

test("checkServerUrl: only https, except http for the local machine when explicitly allowed", () => {
  assert.ok(checkServerUrl("https://noahai.live", false));
  assert.equal(checkServerUrl("http://noahai.live", false), null);
  assert.equal(checkServerUrl("http://noahai.live", true), null, "http is only for the local machine");
  assert.ok(checkServerUrl("http://127.0.0.1:9", true));
  assert.equal(checkServerUrl("not a url", true), null);
});

test("toUnixSeconds accepts unix seconds, epoch millis and ISO-8601 (whichever form noahai.live ends up sending), and nothing else", () => {
  assert.equal(toUnixSeconds(1_800_000_000), 1_800_000_000);
  assert.equal(toUnixSeconds(1_800_000_000_000), 1_800_000_000);
  assert.equal(toUnixSeconds("2027-01-15T08:00:00Z"), Date.parse("2027-01-15T08:00:00Z") / 1000);
  assert.equal(toUnixSeconds(null), null);
  assert.equal(toUnixSeconds(undefined), null);
  assert.equal(toUnixSeconds("tomorrow-ish"), null);
});

test("the Google client id baked in is the public Desktop-app id the user supplied (and no secret lives in the client)", () => {
  assert.equal(GOOGLE_CLIENT_ID, "423052223158-2bv7uvscdih8n9fom62mms191bglqou0.apps.googleusercontent.com");
  const src = fs.readFileSync(path.join(__dirname, "../../../entitlement-client.cjs"), "utf8") + fs.readFileSync(path.join(__dirname, "../../../entitlement-oauth.cjs"), "utf8");
  // comments may *mention* the secret by name; what must never exist is a secret value or the field being sent from the app
  assert.doesNotMatch(src, /GOCSPX-[\w-]{10,}/, "no Google client-secret value in the app");
  assert.doesNotMatch(src, /["']?client_secret["']?\s*[:=]/i, "the app never builds a token request carrying a client_secret");
});

test("login: a new Google account gets an accountId and starts at 2/2 agent trials remaining", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    const r = await w.login(client);
    assert.equal(r.ok, true);
    assert.ok(r.accountId);
    assert.equal(client.signedIn, true);
    assert.equal(r.entitlements.agent.remaining, 2);
  } finally { await w.close(); }
});

test("login sends exactly what the server needs - code, verifier, loopback redirect, this device's public key, deviceHash - and no secret", async () => {
  const w = await world();
  try {
    const dev = w.mkDevice("M1");
    const client = w.mkClient(dev);
    await w.login(client);
    const sent = w.stand._exchanges[0];
    assert.deepEqual(Object.keys(sent).sort(), ["code", "codeVerifier", "deviceHash", "publicKey", "redirectUri"]);
    assert.equal(sent.publicKey, dev.load().pub);
    assert.equal(sent.deviceHash, dev.load().hardwareHash);
    assert.match(sent.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.ok(sent.codeVerifier.length >= 43);
  } finally { await w.close(); }
});

test("login: the SAME Google account on a reinstalled app (new keypair, new machine id) restores the SAME account and usage - no fresh trials", async () => {
  const w = await world();
  try {
    const first = w.mkClient(w.mkDevice("M1", "keychain-A"));
    const a = await w.login(first, "alice");
    await first.consumeUsage("agent"); // 1 of 2 used
    const reinstalled = w.mkClient(w.mkDevice("M-NEW", "keychain-B")); // wiped app data AND a different machine
    const b = await w.login(reinstalled, "alice");
    assert.equal(b.accountId, a.accountId, "identity is the Google account, not the device");
    assert.equal(b.entitlements.agent.remaining, 1, "prior usage carried over");
  } finally { await w.close(); }
});

test("login: re-binding supersedes the old key - the old install's signatures stop being accepted", async () => {
  const w = await world();
  try {
    const oldInstall = w.mkClient(w.mkDevice("M1", "keychain-A"));
    await w.login(oldInstall, "alice");
    const newInstall = w.mkClient(w.mkDevice("M2", "keychain-B"));
    await w.login(newInstall, "alice");
    const stale = await oldInstall.consumeUsage("agent");
    assert.deepEqual(stale, { authorized: false, reason: "sign_in_required" }, "a 401 drops the stale session instead of retrying forever");
    assert.equal(oldInstall.signedIn, false);
    assert.equal((await newInstall.consumeUsage("agent")).authorized, true);
  } finally { await w.close(); }
});

test("login: a DIFFERENT Google account on the same machine is a separate account with its own fresh allowance", async () => {
  const w = await world();
  try {
    const a = w.mkClient(w.mkDevice("M1")); await w.login(a, "alice"); await a.consumeUsage("agent"); await a.consumeUsage("agent");
    const b = w.mkClient(w.mkDevice("M1")); const r = await w.login(b, "bob");
    assert.notEqual(r.accountId, a.accountId);
    assert.equal(r.entitlements.agent.remaining, 2);
  } finally { await w.close(); }
});

test("login: the user cancelling on Google's page is reported as denied, and the client stays signed out", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    const r = await client.loginWithGoogle({ openExternal: async (authUrl) => { const u = new URL(authUrl); await fetch(`${u.searchParams.get("redirect_uri")}?error=access_denied&state=${u.searchParams.get("state")}`); } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "denied");
    assert.equal(client.signedIn, false);
    assert.equal(w.stand._exchanges.length, 0, "nothing was sent to the server");
  } finally { await w.close(); }
});

test("login: a rejected authorization code (Google/server refuses it) leaves the client signed out", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    const r = await client.loginWithGoogle({ openExternal: async (authUrl) => { const u = new URL(authUrl); await fetch(`${u.searchParams.get("redirect_uri")}?code=FORGED&state=${u.searchParams.get("state")}`); } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "bad_response");
    assert.equal(client.signedIn, false);
    assert.deepEqual(await client.consumeUsage("agent"), { authorized: false, reason: "sign_in_required" });
  } finally { await w.close(); }
});

test("login: noahai.live's documented error replies (429 rate_limited, 400 invalid_id_token / token_exchange_failed / invalid_redirect_uri) map to specific reasons", async () => {
  const w = await world();
  try {
    for (const [status, body, reason] of [[429, { error: "rate_limited" }, "rate_limited"], [400, { error: "invalid_id_token" }, "invalid_id_token"], [400, { error: "token_exchange_failed" }, "token_exchange_failed"], [400, { error: "invalid_redirect_uri" }, "invalid_redirect_uri"], [400, { error: "something_new" }, "bad_response"]]) {
      const client = w.mkClient(w.mkDevice("M1"));
      const realFetch = client.fetch;
      client.fetch = async (u, o) => (String(u).endsWith("/api/auth/google/exchange") ? { status, text: async () => JSON.stringify(body) } : realFetch(u, o));
      const r = await w.login(client, "alice");
      assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason }, `${status} ${JSON.stringify(body)}`);
      assert.equal(client.signedIn, false);
    }
  } finally { await w.close(); }
});

test("login: a banned/suspended account cannot sign in, and is told so", async () => {
  const w = await world();
  try {
    const first = w.mkClient(w.mkDevice("M1")); await w.login(first, "mallory");
    w.stand.suspend("mallory");
    const second = w.mkClient(w.mkDevice("M2"));
    const r = await w.login(second, "mallory");
    assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "account_suspended" });
    assert.equal(second.signedIn, false);
  } finally { await w.close(); }
});

test("ban takes effect on an ALREADY signed-in device at its very next gated action", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    await w.login(client, "mallory");
    assert.equal((await client.consumeUsage("agent")).authorized, true);
    w.stand.suspend("mallory");
    const r = await client.consumeUsage("agent");
    assert.equal(r.authorized, false);
    assert.equal(r.reason, "account_suspended");
  } finally { await w.close(); }
});

test("login: server unreachable after the browser step -> reported, client stays signed out", async () => {
  const w = await world();
  const client = w.mkClient(w.mkDevice("M1"));
  await w.close();
  const r = await w.login(client);
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "server_unreachable" });
  assert.equal(client.signedIn, false);
});

test("login: two clicks while a sign-in is already running share ONE attempt (one browser tab, one listener, one exchange)", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    let opened = 0;
    const open = async (u) => { opened++; await googleSaysYouAre("alice")(u); };
    const [a, b] = await Promise.all([client.loginWithGoogle({ openExternal: open }), client.loginWithGoogle({ openExternal: open })]);
    assert.equal(opened, 1);
    assert.equal(a.accountId, b.accountId);
    assert.equal(w.stand._exchanges.length, 1);
  } finally { await w.close(); }
});

test("login: gives up if the browser never comes back (user closes the tab), and does not leave the client half signed-in", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"), { signInTimeoutMs: 150 });
    const r = await client.loginWithGoogle({ openExternal: async () => {} });
    assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "timeout" });
    assert.equal(client.signedIn, false);
  } finally { await w.close(); }
});

test("consumeUsage: every gated call is signed, verified, and the real remaining count comes back", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    await w.login(client);
    assert.deepEqual(await client.consumeUsage("agent"), { authorized: true, remaining: 1, cooldownUntil: null });
    assert.deepEqual(await client.consumeUsage("agent"), { authorized: true, remaining: 0, cooldownUntil: null });
  } finally { await w.close(); }
});

test("consumeUsage: the lifetime trial is refused after exhaustion - THE SERVER refuses it, not a client-side guess", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    await w.login(client);
    await client.consumeUsage("agent"); await client.consumeUsage("agent");
    const r = await client.consumeUsage("agent");
    assert.equal(r.authorized, false);
    assert.equal(r.reason, "lifetime_exhausted");
  } finally { await w.close(); }
});

test("consumeUsage: trust-engine cooldown kicks in after 3 uses and is reported back to the client", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    await w.login(client);
    await client.consumeUsage("trust-engine"); await client.consumeUsage("trust-engine"); await client.consumeUsage("trust-engine");
    const r = await client.consumeUsage("trust-engine");
    assert.equal(r.authorized, false);
    assert.equal(r.reason, "cooldown");
    assert.ok(r.cooldownUntil > Math.floor(Date.now() / 1000));
  } finally { await w.close(); }
});

test("consumeUsage: a signed-out client is refused without ever contacting the server as if authorized", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1")); // never signed in
    let contacted = 0;
    const realFetch = client.fetch; client.fetch = (...a) => { contacted++; return realFetch(...a); };
    const r = await client.consumeUsage("agent");
    assert.deepEqual(r, { authorized: false, reason: "sign_in_required" });
    assert.equal(contacted, 0);
  } finally { await w.close(); }
});

test("consumeUsage: server unreachable -> fail CLOSED, never fail open", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    await w.login(client);
    await w.close(); // the server is gone
    const r = await client.consumeUsage("agent");
    assert.equal(r.authorized, false);
    assert.equal(r.reason, "server_unreachable");
    assert.equal(client.signedIn, true, "a network blip does not sign the user out");
  } finally { /* already closed */ }
});

test("consumeUsage: a dropped connection is retried with the SAME idempotency key, so it costs at most one real usage unit", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    await w.login(client);
    let calls = 0;
    const realFetch = client.fetch;
    client.fetch = async (...a) => { calls++; if (calls === 1) throw new Error("ECONNRESET"); return realFetch(...a); };
    const r = await client.consumeUsage("agent");
    assert.equal(r.authorized, true);
    assert.equal(r.remaining, 1, "exactly one unit was consumed, not two, despite two attempts");
    assert.equal(calls, 2);
  } finally { await w.close(); }
});

test("a captured-and-replayed signed request (same idempotency key) is a safe no-op, not a double consumption", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    await w.login(client);
    const body = { idempotencyKey: "fixed-key-replay-test" };
    const first = await client._request("POST", "/api/usage/agent", body);
    const replay = await client._request("POST", "/api/usage/agent", body); // identical request, sent again
    assert.equal(first.json.authorized, true);
    assert.equal(replay.json.authorized, true);
    assert.equal(replay.json.replay, true, "the server recognises it as the same action, not a new one");
    const entRes = await client.getEntitlements();
    assert.equal(entRes.entitlements.agent.remaining, 1, "only ONE unit was actually consumed");
  } finally { await w.close(); }
});

test("a forged signature (a different device's key) is refused with 401, never authorized", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    await w.login(client);
    const forger = w.mkDevice("M-forger").load();
    const p = "/api/usage/agent";
    const ts = String(Math.floor(Date.now() / 1000));
    const rawBody = JSON.stringify({ idempotencyKey: "x" });
    const badSig = forger.sign(`POST\n${p}\n${ts}\n${client.accountId}\n${rawBody}`);
    const res = await fetch(new URL(p, w.url).href, { method: "POST", headers: { "Content-Type": "application/json", "X-Jonah-Device": client.accountId, "X-Jonah-Timestamp": ts, "X-Jonah-Signature": badSig }, body: rawBody });
    assert.equal(res.status, 401);
  } finally { await w.close(); }
});

test("concurrent agent consumption cannot exceed the real remaining allowance (race-condition protection, §15)", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    await w.login(client);
    const results = await Promise.all(Array.from({ length: 10 }, () => client.consumeUsage("agent")));
    assert.equal(results.filter((r) => r.authorized).length, 2, "exactly the 2 lifetime trials, however many requests arrived at once");
    assert.equal(results.filter((r) => !r.authorized && r.reason === "lifetime_exhausted").length, 8);
  } finally { await w.close(); }
});

test("a cooldownUntil sent as an ISO-8601 string is normalised to unix seconds for the rest of the app", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    await w.login(client);
    const iso = new Date(Date.now() + 3600_000).toISOString();
    client.fetch = async () => ({ status: 403, text: async () => JSON.stringify({ authorized: false, reason: "cooldown", cooldownUntil: iso, plan: "free" }) });
    const r = await client.consumeUsage("trust-engine");
    assert.equal(r.cooldownUntil, Math.floor(Date.parse(iso) / 1000));
  } finally { await w.close(); }
});

test("getEntitlements is informational only and reflects server state, including after a refusal", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    await w.login(client);
    await client.consumeUsage("agent"); await client.consumeUsage("agent"); await client.consumeUsage("agent"); // 3rd refused
    const r = await client.getEntitlements();
    assert.equal(r.entitlements.agent.remaining, 0);
  } finally { await w.close(); }
});

test("createCheckoutIntent returns a fresh intent id and expiry, for the best-effort Razorpay attribution flow", async () => {
  const w = await world();
  try {
    const client = w.mkClient(w.mkDevice("M1"));
    await w.login(client);
    const r = await client.createCheckoutIntent("premium", "razorpay");
    assert.equal(r.ok, true);
    assert.ok(r.intentId && r.expiresAt > Math.floor(Date.now() / 1000));
  } finally { await w.close(); }
});

test("an unconfigured client (no server URL) refuses cleanly instead of throwing", async () => {
  const client = new EntitlementClient({ serverUrl: "", device: createEntitlementDeviceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "jonah-ec-")), safeStorage: keychain("k"), machineId: () => "M1" }) });
  assert.equal(client.configured, false);
  const r = await client.loginWithGoogle({ openExternal: async () => { throw new Error("must not open a browser"); } });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: "not_configured" });
});
