"use strict";
const crypto = require("crypto");
const { openDb } = require("../src/db.cjs");
const { loadConfig } = require("../src/config.cjs");
const C = require("../src/crypto.cjs");
const { LicenseService } = require("../src/service.cjs");

// A stand-in for one Mac: its own Ed25519 device key and hardware id.
function makeDevice(label = "Test Mac") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    label,
    pub: C.b64u(publicKey.export({ type: "spki", format: "der" })),
    hw: C.sha256Hex(crypto.randomBytes(16)),
    sign: (msg) => C.b64u(crypto.sign(null, Buffer.from(msg), privateKey)),
  };
}

function newService(over = {}) {
  const clock = { t: 1800000000 };
  const config = { ...loadConfig({}), ...over };
  const key = C.keyInfo(crypto.generateKeyPairSync("ed25519").privateKey);
  const service = new LicenseService({ db: openDb(":memory:"), config, signingKey: key, now: () => clock.t });
  return { service, clock, key, config };
}

async function loginAs(service, dev, username, password, ip = "10.0.0.1") {
  const ch = service.issueChallenge(ip);
  const sig = dev.sign(`login|${ch.nonce}|${String(username).trim().toLowerCase()}|${dev.hw}`);
  return service.login({ username, password, challengeId: ch.challengeId, device: { pub: dev.pub, hw: dev.hw, label: dev.label, sig }, ip });
}

async function refreshAs(service, dev, session, ip = "10.0.0.1") {
  const ch = service.issueChallenge(ip);
  return service.refresh({ sessionId: session.sessionId, refreshToken: session.refreshToken, challengeId: ch.challengeId, sig: dev.sign(`refresh|${ch.nonce}|${session.sessionId}`), ip });
}

const codeOf = async (p) => { try { await p; return "OK"; } catch (e) { return e.code || `ERR:${e.message}`; } };

module.exports = { makeDevice, newService, loginAs, refreshAs, codeOf };
