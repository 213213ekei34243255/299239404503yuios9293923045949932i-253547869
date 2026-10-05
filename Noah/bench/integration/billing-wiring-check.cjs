// Noah/bench/integration/billing-wiring-check.cjs
//
// Is billing really switched ON and wired, as the app ships it? Run before a release build:
//
//   node Noah/bench/integration/billing-wiring-check.cjs
//
// It uses the REAL shipped switch (entitlements.config.json, no env var, no injected file) and the REAL gate code against the repository's stand-in entitlement server
// (NOT noahai.live: whether the real server accepts the same calls is only known from a live run). Plain Node: no window is opened, nothing leaves this computer.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const { createEntitlementGate, entitlementsEnabled, classifyGoal } = require(path.join(ROOT, "entitlement-gate.cjs"));
const { createStandInServer } = require(path.join(ROOT, "Noah", "test", "unit", "entitlement-stand-in-server.cjs"));

let failures = 0;
const check = (ok, what, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${extra ? `  -> ${extra}` : ""}`); if (!ok) failures++; };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function keychain(secret) {
  const key = crypto.createHash("sha256").update(secret).digest();
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", key, iv); const enc = Buffer.concat([c.update(s, "utf8"), c.final()]); return Buffer.concat([iv, c.getAuthTag(), enc]); },
    decryptString: (b) => { const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"); },
  };
}
const googleSaysYouAre = (sub) => async (authUrl) => {
  const u = new URL(authUrl);
  await fetch(`${u.searchParams.get("redirect_uri")}?code=GOOD:${sub}:${crypto.randomBytes(6).toString("hex")}&state=${u.searchParams.get("state")}`);
};

(async () => {
  delete process.env.JONAH_ENTITLEMENTS_ENABLED; // the app's users have no such variable: only the shipped file decides
  const cfgText = read("entitlements.config.json");
  let cfg = null; try { cfg = JSON.parse(cfgText); } catch (_) { /* reported below */ }
  check(!!cfg && cfg.enabled === true, "the shipped switch (entitlements.config.json) says billing is ON", cfgText.replace(/\s+/g, " ").trim());
  check(entitlementsEnabled() === true, "the app's own reading of that file says ON, with no environment variable");

  // the file is part of every build, and nothing overrides it at start-up
  const pkg = JSON.parse(read("package.json"));
  const excluded = (pkg.build.files || []).filter((f) => f.startsWith("!")).some((f) => /entitlements\.config|\*\*\/\*\.json|\*\.json/.test(f));
  check((pkg.build.files || []).includes("**/*") && !excluded, "the installer packs entitlements.config.json (nothing in build.files leaves it out)");
  const main = read("main.cjs");
  const create = main.slice(main.indexOf("entitlementGate = createEntitlementGate("), main.indexOf("registerBillingIpc("));
  check(create.length > 50 && !/configFile|JONAH_ENTITLEMENTS_ENABLED/.test(create), "main.cjs builds the gate from the shipped file only (no override at start-up)");
  const iCheck = main.indexOf("const decision = await entitlementCheck(predictedFeature);");
  const iSubmit = main.indexOf("rexyRuntime.submitGoal(goal, { source, mode, attachments, ticket: decision.usageKey })");
  check(iCheck > 0 && iSubmit > iCheck, "every goal is checked with the gate BEFORE any work starts, and the granted use is passed on as the task's ticket");
  check(/registerBillingIpc\(\{ ipcMain, gate: entitlementGate/.test(main), "the Plans & Billing screen is connected to the same gate");
  check(main.includes("if (entitlementsEnabled()) return Promise.resolve({ allowed: false, reason: \"not_ready\""), "before start-up has finished, a gated action is refused, never waved through");

  // behaviour of the real gate against the stand-in server
  const stand = createStandInServer();
  const url = await stand.listen();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-billing-wire-"));
    const gate = createEntitlementGate({ userDataDir: dir, safeStorage: keychain("k"), serverUrl: url, allowInsecureLoopback: true, openExternal: googleSaysYouAre("wire-check") });
    check(gate.enabled === true, "the real gate is enforcing (enabled)");
    check(classifyGoal("open notes and write hello", "computer") === "agent" && classifyGoal("open notes", "web") === "agent" && classifyGoal("hello", "chat") === "chat", "Computer agent and Web agent are billed as an Agent use; chat as chat");
    const out = await gate.gate("agent");
    check(out.allowed === false && out.reason === "sign_in_required" && /Sign in/i.test(out.message), "signed out: an agent task is refused with the way forward", JSON.stringify(out).slice(0, 160));
    check((await gate.gate("control")).allowed === true, "steering a running task (stop, continue) stays free");
    const si = await gate.signIn();
    check(si.ok === true, "Google sign-in works through the real loopback listener (stand-in Google)", JSON.stringify(si).slice(0, 120));
    const first = await gate.gate("agent");
    check(first.allowed === true && typeof first.usageKey === "string" && first.usageKey.length > 8, "signed in: the first agent task is allowed and gets a ticket", JSON.stringify(first).slice(0, 160));
    const second = await gate.gate("agent");
    check(second.allowed === true && second.usageKey !== first.usageKey, "the second one too, with its own ticket");
    const third = await gate.gate("agent");
    check(third.allowed === false && !!third.reason && !!third.message, "the third is refused once the free trials are used (stand-in plan: 2), with a message for the user", JSON.stringify(third).slice(0, 200));
    check((await gate.gate("control")).allowed === true, "and steering is still free after that");
  } finally { await stand.close(); }

  console.log(`RESULT billing-wiring ${failures ? "FAIL" : "ok"}`);
  setTimeout(() => process.exit(failures ? 1 : 0), 100); // (let the stand-in server's sockets finish closing first)
})().catch((e) => { console.error("RUNNER ERROR", e && e.stack); process.exit(2); });
