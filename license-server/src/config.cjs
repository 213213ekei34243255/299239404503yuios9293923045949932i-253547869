// Configuration comes from environment variables only. Nothing secret has a default.
"use strict";
const path = require("path");

const num = (v, d, min, max) => {
  const n = Number(v);
  if (v == null || String(v).trim() === "" || !Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
};
const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  let seedAccounts = [];
  if (env.SEED_ACCOUNTS) {
    try {
      const parsed = JSON.parse(env.SEED_ACCOUNTS);
      if (Array.isArray(parsed)) seedAccounts = parsed;
    } catch { throw new Error("SEED_ACCOUNTS must be a JSON array like [{\"username\":\"a\",\"password\":\"b\"}]"); }
  }
  return {
    port: num(env.PORT, 8080, 0, 65535),
    host: env.HOST || (production ? "0.0.0.0" : "127.0.0.1"),
    dataDir: env.DATA_DIR || path.join(__dirname, "..", "data"),
    production,
    // Passwords must only ever travel over TLS. Behind a proxy (Render, Cloudflare...) the proxy terminates TLS and sets X-Forwarded-Proto.
    requireHttps: env.REQUIRE_HTTPS != null && env.REQUIRE_HTTPS !== "" ? env.REQUIRE_HTTPS !== "0" : production,
    trustProxyHops: num(env.TRUST_PROXY_HOPS, 0, 0, 5),
    tlsCertFile: env.TLS_CERT_FILE || "",
    tlsKeyFile: env.TLS_KEY_FILE || "",
    signingKey: env.LICENSE_SIGNING_KEY || "", // PEM (or base64 of a PEM); if empty, generated once into dataDir/signing-key.pem
    issuer: "jonah-license",
    audience: "jonah-mac",
    tokenTtlSeconds: num(env.TOKEN_TTL_SECONDS, 180, 60, 3600),
    sessionIdleSeconds: num(env.SESSION_IDLE_SECONDS, 900, 120, 86400),
    maxSessionsPerAccount: num(env.MAX_SESSIONS_PER_ACCOUNT, 5, 1, 50),
    adminEnabled: env.ADMIN_ENABLED !== "0",
    adminAllowedIps: list(env.ADMIN_ALLOWED_IPS),
    adminUsername: env.ADMIN_USERNAME || "",
    adminPassword: env.ADMIN_PASSWORD || "",
    adminIdleSeconds: num(env.ADMIN_IDLE_SECONDS, 1800, 60, 86400),
    adminMaxSeconds: num(env.ADMIN_MAX_SECONDS, 28800, 300, 604800),
    seedAccounts,
  };
}

module.exports = { loadConfig };
