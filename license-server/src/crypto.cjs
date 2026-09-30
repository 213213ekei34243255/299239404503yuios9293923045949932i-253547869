// Cryptography for the licence server. Only Node's built-in crypto: scrypt for passwords, Ed25519 for tokens and device proofs.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s), "base64url");
const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

// ------------------------------------------------------------------ passwords (scrypt)

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
const MAX_PASSWORD_LENGTH = 256;

// scrypt runs on libuv's small thread pool; cap how many run at once so a flood of login attempts cannot starve everything else.
class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async run(fn) {
    if (this.n <= 0) await new Promise((r) => this.q.push(r));
    else this.n--;
    try { return await fn(); } finally { const next = this.q.shift(); if (next) next(); else this.n++; }
  }
}
const scryptGate = new Semaphore(3);

function scryptAsync(password, salt, params) {
  return scryptGate.run(() => new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  }));
}

async function hashPassword(password) {
  const pw = String(password);
  if (pw.length > MAX_PASSWORD_LENGTH) throw new Error("password too long");
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(pw, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64u(salt)}$${b64u(key)}`;
}

async function verifyPassword(password, stored) {
  const pw = String(password);
  if (pw.length > MAX_PASSWORD_LENGTH) return false;
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = fromB64u(hash);
  const params = { N: Number(N), r: Number(r), p: Number(p), keylen: expected.length };
  if (![params.N, params.r, params.p].every(Number.isInteger) || params.N > 1 << 17 || expected.length < 16) return false;
  const actual = await scryptAsync(pw, fromB64u(salt), params);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// A real hash of a random password: verifying against it costs the same as a real check, so "no such user" and "wrong password"
// take the same time and cannot be told apart.
let dummyHash = null;
async function verifyAgainstDummy(password) {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(12).toString("hex"));
  await verifyPassword(password, dummyHash);
  return false;
}

// ------------------------------------------------------------------ random ids and secrets

const randomToken = (bytes = 32) => b64u(crypto.randomBytes(bytes));
const randomHex = (bytes = 16) => crypto.randomBytes(bytes).toString("hex");
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ------------------------------------------------------------------ signing key + tokens (Ed25519)

function spkiDer(publicKey) { return publicKey.export({ type: "spki", format: "der" }); }

function keyInfo(privateKey) {
  const publicKey = crypto.createPublicKey(privateKey);
  const der = spkiDer(publicKey);
  return { privateKey, publicKey, kid: "k" + sha256Hex(der).slice(0, 10), spki: b64u(der) };
}

// The private key comes from LICENSE_SIGNING_KEY (best for hosts without a persistent disk) or a file that is created once.
function loadSigningKey({ pemOrBase64, dataDir }) {
  let pem = String(pemOrBase64 || "").trim();
  if (pem && !pem.includes("BEGIN")) pem = Buffer.from(pem, "base64").toString("utf8");
  if (pem) return keyInfo(crypto.createPrivateKey(pem));
  const file = path.join(dataDir, "signing-key.pem");
  if (fs.existsSync(file)) return keyInfo(crypto.createPrivateKey(fs.readFileSync(file, "utf8")));
  fs.mkdirSync(dataDir, { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return keyInfo(privateKey);
}

function signToken(claims, key) {
  const head = b64u(JSON.stringify({ alg: "EdDSA", typ: "JLT", kid: key.kid }));
  const body = b64u(JSON.stringify(claims));
  const sig = crypto.sign(null, Buffer.from(`${head}.${body}`), key.privateKey);
  return `${head}.${body}.${b64u(sig)}`;
}

// keys: [{ kid, publicKey: KeyObject }]. Only EdDSA is accepted (never "none", never a shared-secret algorithm).
function verifyToken(token, keys, { now = Math.floor(Date.now() / 1000), issuer, audience, skew = 30 } = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  let head, claims;
  try { head = JSON.parse(fromB64u(parts[0]).toString("utf8")); claims = JSON.parse(fromB64u(parts[1]).toString("utf8")); } catch { return { ok: false, reason: "malformed" }; }
  if (!head || head.alg !== "EdDSA" || head.typ !== "JLT") return { ok: false, reason: "bad_alg" };
  const key = keys.find((k) => k.kid === head.kid);
  if (!key) return { ok: false, reason: "unknown_kid" };
  let good = false;
  try { good = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key.publicKey, fromB64u(parts[2])); } catch { good = false; }
  if (!good) return { ok: false, reason: "bad_signature" };
  if (issuer && claims.iss !== issuer) return { ok: false, reason: "bad_issuer" };
  if (audience && claims.aud !== audience) return { ok: false, reason: "bad_audience" };
  if (!Number.isFinite(claims.exp) || !Number.isFinite(claims.iat)) return { ok: false, reason: "malformed" };
  if (claims.exp + skew < now) return { ok: false, reason: "expired" };
  if (claims.iat - skew > now) return { ok: false, reason: "not_yet_valid" };
  return { ok: true, claims };
}

// ------------------------------------------------------------------ device keys (Ed25519 SPKI, base64url)

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function parseDevicePublicKey(pubB64u) {
  try {
    const der = fromB64u(pubB64u);
    if (der.length !== 44 || !der.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) return null;
    return { der, key: crypto.createPublicKey({ key: der, format: "der", type: "spki" }), id: sha256Hex(der).slice(0, 32) };
  } catch { return null; }
}

function verifyDeviceSignature(pubB64u, message, sigB64u) {
  const parsed = parseDevicePublicKey(pubB64u);
  if (!parsed) return false;
  try { return crypto.verify(null, Buffer.from(String(message)), parsed.key, fromB64u(sigB64u)); } catch { return false; }
}

module.exports = {
  b64u, fromB64u, sha256Hex, hashPassword, verifyPassword, verifyAgainstDummy, MAX_PASSWORD_LENGTH,
  randomToken, randomHex, safeEqual, keyInfo, loadSigningKey, signToken, verifyToken,
  parseDevicePublicKey, verifyDeviceSignature,
};
