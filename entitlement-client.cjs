// entitlement-client.cjs — Jonah's side of the noahai.live billing/entitlement API. This module NEVER decides whether an action is
// allowed: every gated action (agent, trust engine, attachment, chat) asks the server with a live network call and only proceeds on an
// explicit `authorized: true`. A cached/stale answer, a network failure, or the device's own clock are never treated as authorization -
// see the module's `consumeUsage`: a failed or unreachable request is `authorized: false`, always (fail closed, per the spec's core
// principle: "the desktop client is untrusted").
//
// IDENTITY: a signed-in Google account (its `sub`), not an anonymous device - this is what makes "buy a plan, reinstall, sign back
// into the same Google account, the purchase is still there" work. loginWithGoogle() runs the real OAuth flow (entitlement-oauth.cjs:
// system browser + PKCE + a one-time loopback redirect) and hands the resulting authorization code to noahai.live, which exchanges it
// for Google's tokens and verifies the ID token ITSELF - the Client Secret and Google's tokens never reach this file or the app bundle.
// The device's own Ed25519 keypair (entitlement-device.cjs) is kept as a SEPARATE layer on top: once signed in, it still signs every
// request, so a leaked session identifier alone is not enough to act as this device - the server only accepts requests signed by the
// keypair it bound during the last sign-in.
//
// SIGNING SCHEME (proposed by this side; must match noahai.live's actual implementation exactly, adjust here if it differs):
//   Every request after sign-in carries three headers:
//     X-Jonah-Device:    the accountId returned by /api/auth/google/exchange (the name is legacy; it identifies "which credential
//                        signed this", which now resolves to an account server-side, not an anonymous device row)
//     X-Jonah-Timestamp: unix seconds, this device's clock (used only to bound the replay window; the SERVER's clock is authoritative
//                        for every entitlement/cooldown decision, never this timestamp)
//     X-Jonah-Signature: base64url Ed25519 signature over `${method}\n${path}\n${timestamp}\n${accountId}\n${rawBody}`
//   Signing the exact raw body (which embeds a fresh idempotencyKey per usage call) means a captured-and-replayed request can only
//   ever repeat the SAME idempotency key - the server's own idempotency check (never grant the same key twice) makes replay harmless
//   without needing a separate challenge round-trip for this lower-stakes API.
"use strict";
const crypto = require("crypto");
const { signIn: googleSignIn } = require("./entitlement-oauth.cjs");

const DEFAULT_BASE = "https://www.noahai.live";
// A public identifier, not a secret: Google's "Desktop app" client type is explicitly designed to ship its ID in the binary. The matching
// Client Secret lives only on noahai.live (GOOGLE_CLIENT_SECRET) and is never present anywhere in this repo.
const GOOGLE_CLIENT_ID = "423052223158-2bv7uvscdih8n9fom62mms191bglqou0.apps.googleusercontent.com";
const FEATURES = new Set(["agent", "trust-engine", "attachment", "chat"]);

/** The server may send a time as unix seconds or an ISO-8601 string; the rest of the app uses unix seconds. null if absent/unparseable. */
function toUnixSeconds(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v); // tolerate epoch-millis too
  if (typeof v === "string") { const ms = Date.parse(v); return Number.isNaN(ms) ? null : Math.floor(ms / 1000); }
  return null;
}

const path_of = (feature) => `/api/usage/${feature}`;

/**
 * Remembers WHICH account this install is signed in as, across restarts. It stores only the opaque accountId plus the public key it was
 * bound to - not a secret on its own: every request is still signed by the device's private key (kept encrypted by the OS keychain), so
 * a copied file is useless on another machine, and it is ignored the moment the device key changes (e.g. app data cleared).
 */
function createSessionStore({ file, fsImpl = require("fs") }) {
  return {
    load(pub) {
      try {
        const s = JSON.parse(fsImpl.readFileSync(file, "utf8"));
        return s && s.v === 1 && typeof s.accountId === "string" && s.accountId && s.pub === pub ? s.accountId : null;
      } catch { return null; }
    },
    save(accountId, pub) {
      try {
        fsImpl.mkdirSync(require("path").dirname(file), { recursive: true });
        fsImpl.writeFileSync(file, JSON.stringify({ v: 1, accountId, pub }), { mode: 0o600 });
      } catch { /* not persisted: still signed in for this run */ }
    },
    clear() { try { fsImpl.unlinkSync(file); } catch { /* already gone */ } },
  };
}

function checkServerUrl(raw, allowInsecureLoopback) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && allowInsecureLoopback && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) return u;
  return null;
}

class EntitlementClient {
  constructor({ serverUrl = DEFAULT_BASE, device, allowInsecureLoopback = false, fetchImpl, timeoutMs = 10000, googleClientId = GOOGLE_CLIENT_ID, signInTimeoutMs = 180000, sessionStore = null, log = () => {} }) {
    this.url = checkServerUrl(serverUrl, allowInsecureLoopback);
    this.deviceStore = device;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.timeoutMs = timeoutMs;
    this.googleClientId = googleClientId;
    this.signInTimeoutMs = signInTimeoutMs;
    this.log = log;
    this.sessionStore = sessionStore;
    // set by a successful loginWithGoogle(); every signed call needs it. Resumed after a restart ONLY if it was bound to this same
    // device key. If the server no longer accepts it, the first signed call gets a 401 and the user is asked to sign in again.
    this.accountId = null;
    if (this.sessionStore && this.configured) { try { this.accountId = this.sessionStore.load(this.deviceStore.load().pub); } catch { this.accountId = null; } }
    this._login = null;    // in-flight sign-in, so two clicks never open two browser tabs / two loopback listeners
  }

  _forget() { this.accountId = null; if (this.sessionStore) this.sessionStore.clear(); }

  get signedIn() { return Boolean(this.accountId); }

  get configured() { return Boolean(this.url); }

  async _request(method, path, body) {
    if (!this.configured) return { ok: false, transport: "not_configured" };
    const dev = this.deviceStore.load();
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.accountId) {
      const toSign = `${method}\n${path}\n${ts}\n${this.accountId}\n${raw}`;
      Object.assign(headers, { "X-Jonah-Device": this.accountId, "X-Jonah-Timestamp": ts, "X-Jonah-Signature": dev.sign(toSign) });
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(new URL(path, this.url).href, { method, redirect: "error", cache: "no-store", signal: ctl.signal, headers, body: body === undefined ? undefined : raw });
      const text = (await res.text()).slice(0, 65536);
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { ok: true, status: res.status, json };
    } catch (e) {
      this.log("entitlement request failed:", path, e && e.message);
      return { ok: false, transport: "unreachable" };
    } finally { clearTimeout(timer); }
  }

  /**
   * Signs this device in with a Google account (system browser + PKCE), then lets noahai.live exchange the code and bind this device's
   * signing key to that account. Must succeed before any signed call works. Idempotent while one attempt is in flight.
   * @param {{openExternal:(url:string)=>Promise<void>, loginHint?:string}} opts openExternal = Electron's shell.openExternal
   * @returns {Promise<{ok:true, accountId, entitlements}|{ok:false, reason, message?}>} reason: denied | timeout | state_mismatch |
   *   server_error | server_unreachable | account_suspended | bad_response | not_configured
   */
  loginWithGoogle({ openExternal, loginHint } = {}) {
    if (this._login) return this._login;
    this._login = this._doLogin({ openExternal, loginHint }).finally(() => { this._login = null; });
    return this._login;
  }

  async _doLogin({ openExternal, loginHint }) {
    if (!this.configured) return { ok: false, reason: "not_configured" };
    let granted;
    try {
      granted = await googleSignIn({ clientId: this.googleClientId, openExternal, loginHint, timeoutMs: this.signInTimeoutMs, log: this.log });
    } catch (e) {
      return { ok: false, reason: (e && e.code) || "server_error", message: e && e.message };
    }
    const dev = this.deviceStore.load();
    // sent UNSIGNED on purpose: this is the call that establishes who we are. The one-time code + PKCE verifier are what prove it.
    const prev = this.accountId; this.accountId = null;
    const r = await this._request("POST", "/api/auth/google/exchange", {
      code: granted.code, codeVerifier: granted.codeVerifier, redirectUri: granted.redirectUri, publicKey: dev.pub, deviceHash: dev.hardwareHash,
    });
    if (!r.ok) { this.accountId = prev; return { ok: false, reason: "server_unreachable" }; }
    if (r.status !== 200) this.log("sign-in exchange refused:", r.status, JSON.stringify(r.json)); // reason only - the body never contains tokens
    if (r.status === 403 && r.json && r.json.reason === "account_suspended") return { ok: false, reason: "account_suspended" };
    if (r.status === 429) return { ok: false, reason: "rate_limited" };
    // noahai.live's documented 400s: invalid_redirect_uri | invalid_id_token | token_exchange_failed (anything else is just a bad response)
    if (r.status === 400 && r.json && ["invalid_redirect_uri", "invalid_id_token", "token_exchange_failed"].includes(r.json.error)) return { ok: false, reason: r.json.error };
    if (r.status !== 200 || !r.json || typeof r.json.accountId !== "string" || !r.json.accountId) return { ok: false, reason: "bad_response" };
    this.accountId = r.json.accountId;
    if (this.sessionStore) this.sessionStore.save(this.accountId, dev.pub);
    return { ok: true, accountId: this.accountId, entitlements: r.json.entitlements || null };
  }

  /** Forgets the signed-in account in memory (the server-side binding is superseded by the next sign-in). Never touches the device key. */
  signOut() { this._forget(); }

  /** Informational only (renders the Plans & Billing / current-plan UI). Never used to authorize anything. */
  async getEntitlements() {
    if (!this.accountId) return { ok: false, reason: "sign_in_required" };
    const r = await this._request("GET", "/api/entitlements");
    if (!r.ok || r.status !== 200 || !r.json) return { ok: false, reason: r.ok ? "bad_response" : r.transport };
    return { ok: true, entitlements: r.json };
  }

  /** The public plan list/prices, for the Plans & Billing page. No device/signature needed. */
  async getPlans() {
    const r = await this._request("GET", "/api/plans");
    if (!r.ok || r.status !== 200 || !r.json) return { ok: false, reason: r.ok ? "bad_response" : r.transport };
    return { ok: true, plans: r.json };
  }

  /**
   * The ONLY way any gated feature may run. Always makes a live call; never decides locally.
   * @param {"agent"|"trust-engine"|"attachment"|"chat"} feature
   * @param {object} extra feature-specific fields (e.g. chat seconds requested)
   * @returns {{authorized:true, remaining, cooldownUntil} | {authorized:false, reason, cooldownUntil?, plan?}}
   */
  async consumeUsage(feature, extra = {}) {
    if (!FEATURES.has(feature)) throw new Error(`unknown feature: ${feature}`);
    if (!this.accountId) return { authorized: false, reason: "sign_in_required" };
    // ONE idempotency key for every attempt at this same logical action: a retry after a dropped connection can never double-consume,
    // because the server has already recorded this exact key if the first attempt actually reached it.
    const idempotencyKey = crypto.randomBytes(16).toString("hex");
    let r = { ok: false };
    for (let attempt = 0; attempt < 2 && !r.ok; attempt++) {
      r = await this._request("POST", `/api/usage/${feature}`, { idempotencyKey, ...extra });
    }
    if (!r.ok) return { authorized: false, reason: "server_unreachable" }; // fail closed: a network problem never authorizes anything
    if (r.status === 200 && r.json && r.json.authorized === true) {
      return { authorized: true, remaining: r.json.remaining, cooldownUntil: toUnixSeconds(r.json.cooldownUntil) };
    }
    // A 401 on a signed call means the server no longer accepts this key/account binding (e.g. a newer sign-in on another install
    // superseded it): drop the in-memory account so the app asks the user to sign in again instead of retrying forever.
    if (r.status === 401) { this.log("signed request rejected (401):", path_of(feature), JSON.stringify(r.json)); this._forget(); return { authorized: false, reason: "sign_in_required" }; }
    // Any other shape (403 limit reached, 5xx, malformed json, missing fields) is a plain refusal, never "proceed anyway".
    const j = r.json || {};
    return { authorized: false, reason: j.reason || "refused", cooldownUntil: toUnixSeconds(j.cooldownUntil), plan: j.plan };
  }

  /** Stakes a short-lived claim before opening a static Razorpay link, so the webhook has something to (best-effort) match. */
  async createCheckoutIntent(plan, provider = "razorpay") {
    const r = await this._request("POST", "/api/checkout/intent", { plan, provider });
    if (!r.ok || r.status !== 200 || !r.json || typeof r.json.intentId !== "string") return { ok: false, reason: r.ok ? "bad_response" : r.transport };
    return { ok: true, intentId: r.json.intentId, expiresAt: r.json.expiresAt };
  }
}

module.exports = { EntitlementClient, createSessionStore, checkServerUrl, toUnixSeconds, DEFAULT_BASE, GOOGLE_CLIENT_ID };
