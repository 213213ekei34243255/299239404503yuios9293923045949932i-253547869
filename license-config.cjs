// Licence-gate configuration for the Mac app. Nothing here is secret: the licence server's address and its PUBLIC key(s).
//
// Where the values come from in a real build: CI writes license-config.generated.json from repository secrets (see the Mac workflow), so
// it lives INSIDE the signed app bundle. A packaged app ignores the environment completely: pointing it at another server needs a
// modified bundle, which breaks the app's signature - and even then a fake server cannot sign tokens the real backends accept.
"use strict";
const fs = require("fs");
const path = require("path");

function readGenerated(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "license-config.generated.json"), "utf8")) || {}; } catch { return {}; }
}
// The licence server is part of the jonahbrowser.store backend (its /v1 and /admin routes). The address is public information.
const DEFAULT_LICENSE_URL = "https://www.jonahbrowser.store"; // "www": the apex redirects, and the client refuses redirects on purpose
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

function loadLicenseConfig({ isPackaged, platform = process.platform, env = process.env, argv = process.argv, dir = __dirname } = {}) {
  const gen = readGenerated(dir);
  let serverUrl = String(gen.serverUrl || DEFAULT_LICENSE_URL);
  let publicKeys = Array.isArray(gen.publicKeys) ? gen.publicKeys : [];
  let heartbeatMs = 60000;

  if (!isPackaged) {
    // development and tests only
    if (env.JONAH_LICENSE_URL) serverUrl = env.JONAH_LICENSE_URL;
    if (env.JONAH_LICENSE_KEYS) { try { publicKeys = JSON.parse(env.JONAH_LICENSE_KEYS); } catch { /* keep the file's keys */ } }
    if (env.JONAH_LICENSE_HEARTBEAT_MS) heartbeatMs = clamp(env.JONAH_LICENSE_HEARTBEAT_MS, 500, 300000, 60000);
  }
  publicKeys = publicKeys.filter((k) => k && typeof k.kid === "string" && typeof k.spki === "string");

  return {
    // These switches can only TURN THE GATE ON. On a Mac it is always required; nothing can turn it off.
    required: platform === "darwin" || env.JONAH_REQUIRE_LICENSE === "1" || argv.includes("--require-license"),
    serverUrl, publicKeys, heartbeatMs,
    allowInsecureLoopback: !isPackaged, // http://127.0.0.1 for local development only
    configured: Boolean(serverUrl && publicKeys.length),
  };
}

module.exports = { loadLicenseConfig, DEFAULT_LICENSE_URL };
