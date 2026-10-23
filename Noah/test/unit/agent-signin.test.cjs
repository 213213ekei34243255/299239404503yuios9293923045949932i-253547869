// Noah/test/unit/agent-signin.test.cjs - the UNLIMITED build with the Google sign-in for the agents: billing stays off (no plans, no counting, no limits of Jonah's own), while the
// account sign-in is offered, because Jonah's cloud AI (Gemini behind noahai.live) is served only to a signed-in account. Off unless entitlements.config.json says
// { "enabled": false, "agentSignIn": true } (or JONAH_AGENT_SIGNIN=1): every other build behaves exactly as before.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createEntitlementGate, agentSignInEnabled, entitlementsEnabled } = require("../../../entitlement-gate.cjs");
const { registerBillingIpc } = require("../../../billing.cjs");
const { createStandInServer } = require("./entitlement-stand-in-server.cjs");

const ROOT = path.resolve(__dirname, "..", "..", "..");
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
const configFile = (json) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jonah-cfg-")), "entitlements.config.json"); fs.writeFileSync(f, JSON.stringify(json)); return f; };
const withEnv = (vars, fn) => async () => {
  const before = {};
  for (const k of Object.keys(vars)) { before[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { await fn(); } finally { for (const k of Object.keys(vars)) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } }
};
const NO_ENV = { JONAH_ENTITLEMENTS_ENABLED: undefined, JONAH_AGENT_SIGNIN: undefined };

test("agentSignInEnabled: only an explicit true in the config (or JONAH_AGENT_SIGNIN=1) turns it on; the env var can also force it off; anything unreadable is off", withEnv(NO_ENV, () => {
  assert.equal(agentSignInEnabled({ env: {}, configFile: configFile({ enabled: false, agentSignIn: true }) }), true);
  assert.equal(agentSignInEnabled({ env: {}, configFile: configFile({ enabled: false }) }), false);
  assert.equal(agentSignInEnabled({ env: {}, configFile: configFile({ enabled: false, agentSignIn: "yes" }) }), false, "not a boolean true");
  assert.equal(agentSignInEnabled({ env: {}, configFile: path.join(os.tmpdir(), "does-not-exist.json") }), false);
  assert.equal(agentSignInEnabled({ env: { JONAH_AGENT_SIGNIN: "1" }, configFile: configFile({}) }), true);
  assert.equal(agentSignInEnabled({ env: { JONAH_AGENT_SIGNIN: "0" }, configFile: configFile({ agentSignIn: true }) }), false);
}));

test("billing OFF + agentSignIn: signIn() really signs in, the account can sign requests, and nothing is metered or blocked", withEnv(NO_ENV, async () => {
  const stand = createStandInServer();
  const url = await stand.listen();
  try {
    let opened = 0; const base = googleSaysYouAre("alice");
    const g = createEntitlementGate({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "jonah-gate-")), safeStorage: keychain("k"), serverUrl: url, allowInsecureLoopback: true, configFile: configFile({ enabled: false, agentSignIn: true }), openExternal: async (u) => { opened++; return base(u); } });
    assert.deepEqual([g.enabled, g.agentSignIn], [false, true]);
    const r = await g.signIn();
    assert.equal(r.ok, true);
    assert.equal(r.bypass, undefined, "a REAL sign-in, not the billing bypass");
    assert.deepEqual([opened, g.client.signedIn], [1, true]);
    assert.ok(g.client.signedHeaders("POST", "/api/llm/step", "{}")["X-Jonah-Signature"], "the hosted model's requests can be signed");
    assert.deepEqual(await g.signIn(), { ok: true, accountId: g.client.accountId }, "signed in already: no second browser window");
    assert.equal(opened, 1);
    assert.deepEqual(await g.gate("agent"), { allowed: true, bypass: "entitlements_disabled" }, "unlimited: the app counts and blocks nothing");
    assert.deepEqual(await g.gate("chat"), { allowed: true, bypass: "entitlements_disabled" });
  } finally { await stand.close(); }
}));

test("billing OFF without the flag: signIn() stays the no-op it always was (no browser, nobody signed in)", withEnv(NO_ENV, async () => {
  let opened = 0;
  const g = createEntitlementGate({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "jonah-gate-")), safeStorage: keychain("k"), serverUrl: "http://127.0.0.1:1", allowInsecureLoopback: true, configFile: configFile({ enabled: false }), openExternal: async () => { opened++; } });
  assert.deepEqual([g.enabled, g.agentSignIn], [false, false]);
  assert.deepEqual(await g.signIn(), { ok: true, bypass: "entitlements_disabled" });
  assert.deepEqual([opened, g.client.signedIn], [0, false]);
}));

test("billing ON: the flag changes nothing (signing in is part of billing there)", withEnv({ ...NO_ENV, JONAH_AGENT_SIGNIN: "1", JONAH_ENTITLEMENTS_ENABLED: "1" }, async () => {
  const g = createEntitlementGate({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "jonah-gate-")), safeStorage: keychain("k"), serverUrl: "http://127.0.0.1:1", allowInsecureLoopback: true, openExternal: async () => {} });
  assert.deepEqual([g.enabled, g.agentSignIn], [true, false], "agentSignIn is only a mode of an unlimited build");
}));

test("the billing status the page reads: off and signed out, then off and signed in, with no plan or usage asked of the server", withEnv(NO_ENV, async () => {
  const stand = createStandInServer();
  const url = await stand.listen();
  try {
    const handlers = new Map();
    const ipc = { handle: (ch, fn) => handlers.set(ch, fn) };
    const g = createEntitlementGate({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "jonah-gate-")), safeStorage: keychain("k"), serverUrl: url, allowInsecureLoopback: true, configFile: configFile({ enabled: false, agentSignIn: true }), openExternal: googleSaysYouAre("alice") });
    registerBillingIpc({ ipcMain: ipc, gate: g, openExternal: async () => {}, env: {}, links: {} });
    const ev = { sender: { getType: () => "window" }, senderFrame: { parent: null } };
    const before = await handlers.get("billing:status")(ev);
    assert.deepEqual(before, { ok: true, enabled: false, agentSignIn: true, signedIn: false });
    const si = await handlers.get("billing:sign-in")(ev);
    assert.equal(si.ok, true);
    const after = await handlers.get("billing:status")(ev);
    assert.deepEqual(after, { ok: true, enabled: false, agentSignIn: true, signedIn: true }, "no entitlements, plan or usage fields: nothing about a plan exists here");
    await handlers.get("billing:sign-out")(ev);
    assert.equal((await handlers.get("billing:status")(ev)).signedIn, false);
  } finally { await stand.close(); }
}));

test("a plain unlimited build (no flag) reports exactly what it always did", withEnv(NO_ENV, async () => {
  const handlers = new Map();
  const g = createEntitlementGate({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "jonah-gate-")), safeStorage: keychain("k"), serverUrl: "http://127.0.0.1:1", allowInsecureLoopback: true, configFile: configFile({ enabled: false }), openExternal: async () => {} });
  registerBillingIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, gate: g, openExternal: async () => {}, env: {}, links: {} });
  assert.deepEqual(await handlers.get("billing:status")({ sender: { getType: () => "window" }, senderFrame: { parent: null } }), { ok: true, enabled: false, agentSignIn: false, signedIn: false });
}));

test("the page: the Plans page of an unlimited build with the sign-in shows an Account page (no plans or prices), and the launch card is offered when nobody is signed in", () => {
  const src = fs.readFileSync(path.join(ROOT, "billing-panel.js"), "utf8");
  assert.match(src, /st && !st\.enabled && st\.agentSignIn/);
  assert.match(src, /textContent = "Account"/);
  assert.match(src, /\(st\.enabled \|\| st\.agentSignIn\) && !st\.signedIn\) showSigninPrompt\(\)/);
  assert.match(src, /Signing in is optional/);
  // no emoji in the new text
  const EMOJI = /\p{Extended_Pictographic}(?=️)|\p{Emoji_Presentation}|️/u;
  assert.equal(EMOJI.test(src), false);
});
