// Drop-in verifier for any Node backend (zero dependencies). Copy this one file next to your server.
//
//   const { createVerifier } = require("./verify-license-token.cjs");
//   const verifier = createVerifier({ keys: [{ kid: "k1234", spki: "MCowBQYDK2VwAyEA..." }] });   // from GET <licence server>/v1/public-keys
//
//   // in a request handler (the app sends the token in the X-Jonah-License header):
//   const r = verifier.verifyHeader(req.headers["x-jonah-license"]);
//   if (!r.ok) { res.writeHead(401).end(); return; }        // r.reason says why; r.claims.usr is the account
//
// The token is valid for 3 minutes and is renewed by the app every minute while the licence server still approves the account. A backend
// that checks it therefore stops serving a banned/revoked/deactivated account within a few minutes without ever talking to the licence server.
"use strict";
const crypto = require("crypto");

const fromB64u = (s) => Buffer.from(String(s), "base64url");

function createVerifier({ keys, issuer = "jonah-license", audience = "jonah-mac", skewSeconds = 30, now = () => Math.floor(Date.now() / 1000) }) {
  const pinned = (keys || []).map((k) => ({ kid: k.kid, publicKey: crypto.createPublicKey({ key: fromB64u(k.spki), format: "der", type: "spki" }) }));
  if (!pinned.length) throw new Error("createVerifier needs at least one public key");

  function verify(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed" };
    let head, claims;
    try { head = JSON.parse(fromB64u(parts[0]).toString("utf8")); claims = JSON.parse(fromB64u(parts[1]).toString("utf8")); } catch { return { ok: false, reason: "malformed" }; }
    if (!head || head.alg !== "EdDSA" || head.typ !== "JLT") return { ok: false, reason: "bad_alg" }; // never "none", never a shared secret
    const key = pinned.find((k) => k.kid === head.kid);
    if (!key) return { ok: false, reason: "unknown_kid" };
    let good = false;
    try { good = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key.publicKey, fromB64u(parts[2])); } catch { good = false; }
    if (!good) return { ok: false, reason: "bad_signature" };
    if (claims.iss !== issuer) return { ok: false, reason: "bad_issuer" };
    if (claims.aud !== audience) return { ok: false, reason: "bad_audience" };
    if (!Number.isFinite(claims.exp) || !Number.isFinite(claims.iat)) return { ok: false, reason: "malformed" };
    const t = now();
    if (claims.exp + skewSeconds < t) return { ok: false, reason: "expired" };
    if (claims.iat - skewSeconds > t) return { ok: false, reason: "not_yet_valid" };
    if (claims.unl !== 1) return { ok: false, reason: "not_unlimited" };
    return { ok: true, claims };
  }

  // Accepts the raw header value, with or without a "Bearer " prefix.
  const verifyHeader = (value) => verify(String(value || "").replace(/^Bearer\s+/i, "").trim());
  return { verify, verifyHeader };
}

module.exports = { createVerifier };
