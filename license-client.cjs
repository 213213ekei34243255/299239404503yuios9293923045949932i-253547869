// The Mac app's side of the licence protocol. It holds NO credentials and NO "authorized" flag: the username and password are typed
// every launch, sent once over HTTPS, and forgotten; the only thing kept (in memory) is a short-lived token the server signed, which
// is checked here against the server's PINNED public key before it is believed.
"use strict";
const crypto = require("crypto");

const MESSAGES = {
  access_expired: "Sorry, your developer access mode has expired. Kindly reinstall the app from the Mac App Store or jonahbrowser.com, or please contact Customer Care Service.",
  device_conflict: "This account is already authorized on another device. Please contact Customer Care Service to transfer or reset your device authorization.",
  invalid_credentials: "Incorrect username or password.",
  session_ended: "Your session has ended. Please sign in again.",
  rate_limited: "Too many attempts. Please wait a moment and try again.",
  server_unreachable: "Cannot reach the authorization server. Check your internet connection and try again.",
  server_error: "The authorization server had a problem. Please try again in a moment.",
  not_configured: "This copy of the app is not set up for developer access yet. Please contact Customer Care Service.",
  insecure: "A secure connection to the authorization server could not be guaranteed, so sign-in was stopped.",
  bad_response: "The authorization server's reply could not be verified, so sign-in was stopped.",
  device_error: "This device could not be verified. Please restart the app.",
  bad_request: "Please enter your username and password.",
  bad_challenge: "The sign-in request expired. Please try again.",
  bad_device_proof: "This device could not be verified. Please try again.",
};
const messageFor = (code) => MESSAGES[code] || MESSAGES.server_error;

const b64u = (b) => Buffer.from(b).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s), "base64url");

// Reject anything that is not HTTPS. Plain http is allowed ONLY for the local machine, and only outside a packaged app.
function checkServerUrl(raw, allowInsecureLoopback) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && allowInsecureLoopback && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return u;
  return null;
}

function pinnedKeys(list) {
  const out = [];
  for (const k of list || []) {
    try { out.push({ kid: k.kid, publicKey: crypto.createPublicKey({ key: fromB64u(k.spki), format: "der", type: "spki" }) }); } catch { /* skip a bad entry */ }
  }
  return out;
}

// Verifies a token the server signed. Only EdDSA against the pinned keys; audience/issuer fixed; and it must answer THIS request
// (nc = the one-time challenge the app just sent), so an old captured reply cannot be replayed to extend access.
function verifyAccessToken(token, keys, { nonce, username, deviceId }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  let head, c;
  try { head = JSON.parse(fromB64u(parts[0]).toString("utf8")); c = JSON.parse(fromB64u(parts[1]).toString("utf8")); } catch { return { ok: false, reason: "malformed" }; }
  if (!head || head.alg !== "EdDSA" || head.typ !== "JLT") return { ok: false, reason: "bad_alg" };
  const key = keys.find((k) => k.kid === head.kid);
  if (!key) return { ok: false, reason: "unknown_kid" };
  let good = false;
  try { good = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key.publicKey, fromB64u(parts[2])); } catch { good = false; }
  if (!good) return { ok: false, reason: "bad_signature" };
  if (c.iss !== "jonah-license" || c.aud !== "jonah-mac") return { ok: false, reason: "bad_claims" };
  if (!Number.isFinite(c.iat) || !Number.isFinite(c.exp) || c.exp <= c.iat || c.exp - c.iat > 3600) return { ok: false, reason: "bad_claims" };
  if (c.nc !== nonce) return { ok: false, reason: "replayed" };
  if (c.did !== deviceId) return { ok: false, reason: "wrong_device" };
  if (username && String(c.usr).toLowerCase() !== String(username).toLowerCase()) return { ok: false, reason: "wrong_user" };
  return { ok: true, claims: c };
}

class LicenseClient {
  constructor({ serverUrl, publicKeys, device, allowInsecureLoopback = false, fetchImpl, monotonic, timeoutMs = 10000, log = () => {}, env = process.env }) {
    this.url = checkServerUrl(serverUrl, allowInsecureLoopback);
    this.keys = pinnedKeys(publicKeys);
    this.deviceStore = device;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.mono = monotonic || (() => Number(process.hrtime.bigint() / 1000000n));
    this.timeoutMs = timeoutMs; this.log = log; this.env = env;
    this.session = null;       // { sessionId, refreshToken, username, token, validUntil (monotonic ms) }
    this.timer = null; this.busy = false; this.onLost = null; this.lostFired = false; this.intervalMs = 60000;
  }

  get configured() { return Boolean(this.url && this.keys.length); }
  get signedIn() { return Boolean(this.session) && this.mono() < this.session.validUntil; }

  // The current access token, only while it is still inside the lifetime the server signed for it (measured on a monotonic clock, so
  // changing the Mac's date cannot stretch it). Backends verify the same token themselves.
  getAccessToken() { return this.signedIn ? this.session.token : null; }

  async _post(path, body) {
    if (this.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" && this.url.protocol === "https:") return { transport: "insecure" };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(new URL(path, this.url).href, {
        method: "POST", redirect: "error", cache: "no-store", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body || {}),
      });
      const text = (await res.text()).slice(0, 65536);
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json };
    } catch { return { transport: "unreachable" }; } finally { clearTimeout(timer); }
  }

  _failure(r) {
    if (r.transport === "insecure") return { ok: false, code: "insecure", message: messageFor("insecure") };
    if (r.transport === "unreachable") return { ok: false, code: "server_unreachable", message: messageFor("server_unreachable") };
    const j = r.json || {};
    const code = typeof j.code === "string" ? j.code : r.status >= 500 ? "server_error" : "bad_response";
    // The wording always comes from THIS app's own table, never from the network.
    return { ok: false, code, message: messageFor(code), ...(j.retryAfterSeconds ? { retryAfterSeconds: j.retryAfterSeconds } : {}) };
  }

  async _challenge() {
    const r = await this._post("/v1/auth/challenge", {});
    if (r.transport || r.status !== 200 || !r.json || !r.json.challengeId || !r.json.nonce) return { fail: this._failure(r) };
    return { id: r.json.challengeId, nonce: r.json.nonce };
  }

  async login(username, password) {
    if (!this.configured) return { ok: false, code: "not_configured", message: messageFor("not_configured") };
    username = String(username || "").trim();
    if (!username || !password || username.length > 64 || String(password).length > 256) return { ok: false, code: "bad_request", message: messageFor("bad_request") };
    let dev;
    try { dev = this.deviceStore.load(); } catch (e) { this.log("device error", e && e.message); return { ok: false, code: "device_error", message: messageFor("device_error") }; }
    const ch = await this._challenge();
    if (ch.fail) return ch.fail;
    const sig = dev.sign(`login|${ch.nonce}|${username.toLowerCase()}|${dev.hw}`);
    const r = await this._post("/v1/auth/login", { username, password: String(password), challengeId: ch.id, device: { pub: dev.pub, hw: dev.hw, label: dev.label, sig } });
    if (r.transport || r.status !== 200 || !r.json || r.json.ok !== true) return this._failure(r);
    const v = verifyAccessToken(r.json.accessToken, this.keys, { nonce: ch.nonce, username, deviceId: dev.id });
    if (!v.ok || typeof r.json.sessionId !== "string" || typeof r.json.refreshToken !== "string") { this.log("login reply rejected:", v.reason); return { ok: false, code: "bad_response", message: messageFor("bad_response") }; }
    this._adopt({ sessionId: r.json.sessionId, refreshToken: r.json.refreshToken, username: v.claims.usr }, r.json.accessToken, v.claims);
    return { ok: true, username: v.claims.usr };
  }

  _adopt(base, token, claims) {
    this.session = { ...base, token, validUntil: this.mono() + (claims.exp - claims.iat) * 1000 };
    this.lostFired = false;
  }

  // One check with the server. Returns { ok:true } or { ok:false, code, transient }.
  async refresh() {
    const s = this.session;
    if (!s) return { ok: false, code: "session_ended", transient: false };
    let dev;
    try { dev = this.deviceStore.load(); } catch { return { ok: false, code: "device_error", transient: false }; }
    const ch = await this._challenge();
    if (ch.fail) return { ok: false, code: ch.fail.code, transient: ["server_unreachable", "server_error", "rate_limited", "bad_challenge", "bad_response"].includes(ch.fail.code) };
    const r = await this._post("/v1/session/refresh", { sessionId: s.sessionId, refreshToken: s.refreshToken, challengeId: ch.id, sig: dev.sign(`refresh|${ch.nonce}|${s.sessionId}`) });
    if (r.transport || r.status !== 200 || !r.json || r.json.ok !== true) {
      const f = this._failure(r);
      return { ok: false, code: f.code, transient: ["server_unreachable", "server_error", "rate_limited", "bad_challenge", "bad_response", "insecure"].includes(f.code) };
    }
    const v = verifyAccessToken(r.json.accessToken, this.keys, { nonce: ch.nonce, username: s.username, deviceId: dev.id });
    if (!v.ok) { this.log("refresh reply rejected:", v.reason); return { ok: false, code: "bad_response", transient: true }; }
    this._adopt(s, r.json.accessToken, v.claims);
    return { ok: true };
  }

  // ---- the periodic re-check. onLost(code) fires ONCE when access is over.
  start(intervalMs, onLost) {
    this.stop();
    this.onLost = onLost; this.intervalMs = intervalMs || 60000; this.lostFired = false;
    const loop = async () => { await this.tickNow(); if (this.timer !== null) this.timer = setTimeout(loop, this.intervalMs); };
    this.timer = setTimeout(loop, this.intervalMs);
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  async tickNow() {
    if (this.busy || this.lostFired || !this.session) return;
    this.busy = true;
    try {
      const r = await this.refresh();
      if (r.ok) return;
      if (!r.transient) return this._lost(r.code);
      // No answer (or a garbled one): keep going only while the last token the server signed is still inside its lifetime. Fail closed after.
      if (!this.signedIn) this._lost(r.code === "bad_response" || r.code === "insecure" ? r.code : "server_unreachable");
    } finally { this.busy = false; }
  }
  _lost(code) {
    if (this.lostFired) return;
    this.lostFired = true; this.stop(); this.session = null;
    if (this.onLost) this.onLost(code);
  }

  async logout() {
    const s = this.session;
    this.stop(); this.session = null;
    if (s && this.url) await this._post("/v1/session/logout", { sessionId: s.sessionId, refreshToken: s.refreshToken });
  }
}

module.exports = { LicenseClient, MESSAGES, messageFor, verifyAccessToken, checkServerUrl, pinnedKeys };
