// Noah/test/unit/entitlement-stand-in-server.cjs
//
// A small, REAL HTTP server implementing entitlement-client.cjs's proposed contract (auth/google/exchange, entitlements, usage, checkout
// intent), with genuine Ed25519 signature verification and genuine atomic in-memory usage counting. This is NOT noahai.live and must
// never be mistaken for it: it exists purely so entitlement-client.cjs's signing, error-handling and fail-closed behaviour can be
// proven against something that actually implements the protocol, the same way license-gate-check.cjs was proven against a real
// reference server before the real Python backend existed. Once noahai.live implements the real contract, entitlement-client.cjs must
// be re-tested against THAT, live - this stand-in only proves the client's own logic is correct against the contract AS PROPOSED.
"use strict";
const crypto = require("crypto");
const http = require("http");

function verifySignature(pub, message, sig) {
  try {
    const raw = Buffer.from(pub, "base64url");
    if (raw.length !== 32) return false; // the agreed wire format is the RAW 32-byte key (what a Python/Go/Node server all take)
    const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(sig, "base64url"));
  } catch { return false; }
}

// A tiny free-plan-shaped entitlement model: 2 lifetime agent trials, 3 trust-engine uses / 24h cooldown, 5 attachments / 48h cooldown.
// Deliberately NOT a full reimplementation of every plan - just enough real behaviour (lifetime exhaustion, rolling cooldown, atomic
// consumption, idempotency) to prove the CLIENT behaves correctly against a server that enforces those properties for real.
function createStandInServer({ now = () => Math.floor(Date.now() / 1000) } = {}) {
  const devices = new Map(); // accountId -> { sub, pub, status, deviceHash, agentUsed, trustUsed, trustCooldownUntil, attachUsed, attachCooldownUntil }
  const bySub = new Map(); // Google `sub` -> accountId (identity is the Google account, NEVER the device hash)
  const usedCodes = new Set(); // Google authorization codes are one-time use
  const exchanges = []; // test-only: every exchange body received, so tests can assert exactly what the client sent
  const usageKeys = new Set(); // `${accountId}:${feature}:${idempotencyKey}` already applied
  const lock = { busy: false, queue: [] };
  const withLock = (fn) => new Promise((resolve, reject) => {
    const run = async () => { lock.busy = true; try { resolve(await fn()); } catch (e) { reject(e); } finally { lock.busy = false; const next = lock.queue.shift(); if (next) next(); } };
    if (lock.busy) lock.queue.push(run); else run();
  });

  function entitlementsFor(d) {
    return {
      plan: "free", subscriptionStatus: "none",
      agent: { remaining: Math.max(0, 2 - d.agentUsed), limit: 2, cooldownUntil: null },
      trustEngine: { remaining: d.trustCooldownUntil && d.trustCooldownUntil > now() ? 0 : Math.max(0, 3 - d.trustUsed), limit: 3, cooldownUntil: d.trustCooldownUntil && d.trustCooldownUntil > now() ? d.trustCooldownUntil : null },
      attachments: { remaining: d.attachCooldownUntil && d.attachCooldownUntil > now() ? 0 : Math.max(0, 5 - d.attachUsed), limit: 5, cooldownUntil: d.attachCooldownUntil && d.attachCooldownUntil > now() ? d.attachCooldownUntil : null },
      chat: { remainingSeconds: 2 * 3600, resetAt: null },
    };
  }

  const server = http.createServer(async (req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", async () => {
      const send = (code, body) => { const s = JSON.stringify(body); res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) }); res.end(s); };
      const url = new URL(req.url, "http://x");
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: "bad json" }); }

      if (req.method === "GET" && url.pathname === "/api/plans") return send(200, { free: { agent: { limit: 2 } } }); // public: no signature needed

      if (req.method === "POST" && url.pathname === "/api/auth/google/exchange") {
        exchanges.push(body);
        if (!body.code || !body.codeVerifier || !body.redirectUri || !body.publicKey || !body.deviceHash) return send(400, { reason: "missing_fields" });
        // what real Google + a real OIDC library enforce, in miniature: a loopback redirect, a PKCE-length verifier, a one-time code
        if (!/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(body.redirectUri)) return send(400, { reason: "bad_redirect_uri" });
        if (String(body.codeVerifier).length < 43) return send(400, { reason: "bad_code_verifier" });
        const m = /^GOOD:([^:]+):.+$/.exec(body.code); // the stand-in's stand-in for "Google accepted this code and the ID token verified": GOOD:<sub>:<nonce>
        if (!m || usedCodes.has(body.code)) return send(400, { reason: "invalid_grant" });
        usedCodes.add(body.code);
        const sub = m[1];
        return withLock(() => {
          let accountId = bySub.get(sub);
          if (!accountId) {
            accountId = crypto.randomBytes(16).toString("hex");
            devices.set(accountId, { sub, pub: body.publicKey, status: "active", deviceHash: body.deviceHash, agentUsed: 0, trustUsed: 0, trustCooldownUntil: null, attachUsed: 0, attachCooldownUntil: null });
            bySub.set(sub, accountId);
          }
          const acct = devices.get(accountId);
          if (acct.status !== "active") return send(403, { authorized: false, reason: "account_suspended" });
          acct.pub = body.publicKey; // supersede, don't stack: a re-login (reinstall / new machine) re-binds a fresh key to the SAME account, usage intact
          acct.deviceHash = body.deviceHash; // recorded as a secondary signal only; never used to find the account
          send(200, { accountId, entitlements: entitlementsFor(acct) });
        });
      }

      // everything past here needs a valid signature
      const deviceId = req.headers["x-jonah-device"], ts = req.headers["x-jonah-timestamp"], sig = req.headers["x-jonah-signature"];
      const d = deviceId && devices.get(deviceId);
      if (!d) return send(401, { error: "unknown account" });
      if (Math.abs(now() - Number(ts)) > 120) return send(401, { error: "stale timestamp" });
      const toVerify = `${req.method}\n${url.pathname}\n${ts}\n${deviceId}\n${raw}`;
      if (!verifySignature(d.pub, toVerify, sig)) return send(401, { error: "bad signature" });
      if (d.status !== "active") return send(403, { authorized: false, reason: "account_suspended" }); // account-level ban: every endpoint, every device

      if (req.method === "GET" && url.pathname === "/api/entitlements") return send(200, entitlementsFor(d));

      if (req.method === "POST" && url.pathname === "/api/checkout/intent") {
        return send(200, { intentId: crypto.randomBytes(8).toString("hex"), expiresAt: now() + 1800 });
      }

      const usageMatch = /^\/api\/usage\/(agent|trust-engine|attachment|chat)$/.exec(url.pathname);
      if (req.method === "POST" && usageMatch) {
        const feature = usageMatch[1];
        return withLock(async () => { // the atomicity the spec's Race-Condition Protection section demands: one consumer at a time, in order
          const key = `${deviceId}:${feature}:${body.idempotencyKey}`;
          if (body.idempotencyKey && usageKeys.has(key)) return send(200, { authorized: true, remaining: remainingFor(d, feature), cooldownUntil: null, replay: true });
          const t = now();
          if (feature === "agent") {
            if (d.agentUsed >= 2) return send(403, { authorized: false, reason: "lifetime_exhausted", plan: "free" });
            await new Promise((r) => setImmediate(r)); // stands in for a real database round-trip between "check" and "consume"
            d.agentUsed++;
            if (body.idempotencyKey) usageKeys.add(key);
            return send(200, { authorized: true, remaining: 2 - d.agentUsed, cooldownUntil: null });
          }
          if (feature === "trust-engine") {
            if (d.trustCooldownUntil && d.trustCooldownUntil > t) return send(403, { authorized: false, reason: "cooldown", cooldownUntil: d.trustCooldownUntil, plan: "free" });
            d.trustUsed++;
            if (d.trustUsed >= 3) d.trustCooldownUntil = t + 24 * 3600;
            if (body.idempotencyKey) usageKeys.add(key);
            return send(200, { authorized: true, remaining: Math.max(0, 3 - d.trustUsed), cooldownUntil: d.trustCooldownUntil });
          }
          if (feature === "attachment") {
            if (d.attachCooldownUntil && d.attachCooldownUntil > t) return send(403, { authorized: false, reason: "cooldown", cooldownUntil: d.attachCooldownUntil, plan: "free" });
            d.attachUsed++;
            if (d.attachUsed >= 5) d.attachCooldownUntil = t + 48 * 3600;
            if (body.idempotencyKey) usageKeys.add(key);
            return send(200, { authorized: true, remaining: Math.max(0, 5 - d.attachUsed), cooldownUntil: d.attachCooldownUntil });
          }
          // chat: always authorized in this stand-in (the real free-chat daily budget is out of scope for this test double)
          if (body.idempotencyKey) usageKeys.add(key);
          return send(200, { authorized: true, remaining: 7200, cooldownUntil: null });
        });
      }

      return send(404, { error: "not found" });
    });
  });

  function remainingFor(d, feature) {
    if (feature === "agent") return Math.max(0, 2 - d.agentUsed);
    if (feature === "trust-engine") return Math.max(0, 3 - d.trustUsed);
    if (feature === "attachment") return Math.max(0, 5 - d.attachUsed);
    return 7200;
  }

  return {
    server,
    listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((r) => server.close(r)),
    _accounts: devices, // test-only introspection
    _exchanges: exchanges,
    suspend: (sub) => { const a = devices.get(bySub.get(sub)); if (a) a.status = "banned"; }, // test-only stand-in for an admin ban
  };
}

module.exports = { createStandInServer };
