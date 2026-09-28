// Entry point: node server.cjs
"use strict";
const path = require("path");
const { loadConfig } = require("./src/config.cjs");
const { openDb } = require("./src/db.cjs");
const { loadSigningKey } = require("./src/crypto.cjs");
const { LicenseService } = require("./src/service.cjs");
const { createServer } = require("./src/http.cjs");

async function start(env = process.env, { log = (...a) => console.log("[license]", ...a) } = {}) {
  const config = loadConfig(env);
  const db = openDb(path.join(config.dataDir, "license.db"));
  const key = loadSigningKey({ pemOrBase64: config.signingKey, dataDir: config.dataDir });
  const service = new LicenseService({ db, config, signingKey: key, log });
  const seeded = await service.seedAccounts(config.seedAccounts);
  if (seeded.length) log(`created ${seeded.length} account(s) from SEED_ACCOUNTS: ${seeded.join(", ")} (remove SEED_ACCOUNTS from the environment now)`);
  await service.ensureBootstrapAdmin(console.log);
  const server = createServer({ service, config, publicDir: path.join(__dirname, "public"), log });
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const address = server.address();
  log(`listening on ${config.host}:${address.port} (${config.requireHttps ? "HTTPS required" : "HTTPS NOT required - development only"})`);
  log(`signing key id ${key.kid}; public key (for the Mac app's build settings): ${key.spki}`);
  return { server, service, config, db, key, port: address.port, close: () => new Promise((r) => { server.close(() => { db.close(); r(); }); server.closeAllConnections && server.closeAllConnections(); }) };
}

if (require.main === module) {
  start().catch((e) => { console.error("Could not start:", e.message); process.exit(1); });
}

module.exports = { start };
