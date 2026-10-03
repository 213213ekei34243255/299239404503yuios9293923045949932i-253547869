// Noah/test/unit/entitlement-gate.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createEntitlementGate, classifyGoal, blockedFeatureMessage, signInMessage } = require("../../../entitlement-gate.cjs");
const { createStandInServer } = require("./entitlement-stand-in-server.cjs");

function keychain(secret) {
  const key = crypto.createHash("sha256").update(secret).digest();
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", key, iv); const enc = Buffer.concat([c.update(s, "utf8"), c.final()]); return Buffer.concat([iv, c.getAuthTag(), enc]); },
    decryptString: (b) => { const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"); },
  };
}
// Stands in for the user finishing sign-in on Google's page: the gate's REAL loopback listener is up when this runs, and this makes the
// same real HTTP request Google's redirect would, with a code the stand-in server accepts.
const googleSaysYouAre = (sub) => async (authUrl) => {
  const u = new URL(authUrl);
  await fetch(`${u.searchParams.get("redirect_uri")}?code=GOOD:${sub}:${crypto.randomBytes(6).toString("hex")}&state=${u.searchParams.get("state")}`);
};
const mkGate = (over) => createEntitlementGate({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "jonah-gate-")), safeStorage: keychain("k"), allowInsecureLoopback: true, openExternal: googleSaysYouAre("alice"), ...over });
const withEnabled = (fn) => async () => {
  const before = process.env.JONAH_ENTITLEMENTS_ENABLED;
  process.env.JONAH_ENTITLEMENTS_ENABLED = "1";
  try { await fn(); } finally { if (before === undefined) delete process.env.JONAH_ENTITLEMENTS_ENABLED; else process.env.JONAH_ENTITLEMENTS_ENABLED = before; }
};

// ------------------------------------------------------------------ classifyGoal

test("classifyGoal: an explicit mode is always honoured, whatever the text says", () => {
  assert.equal(classifyGoal("open google.com and search for cats", "chat"), "chat");
  assert.equal(classifyGoal("how are you today", "agent"), "agent");
});

test("classifyGoal: auto mode - a browser-shaped instruction is 'agent'", () => {
  assert.equal(classifyGoal("open youtube.com and search for lofi music", "auto"), "agent");
  assert.equal(classifyGoal("go to amazon and buy a laptop", "auto"), "agent");
});

test("classifyGoal: auto mode - a plain question is 'chat'", () => {
  assert.equal(classifyGoal("what is the capital of France", "auto"), "chat");
  assert.equal(classifyGoal("explain how photosynthesis works", "auto"), "chat");
});

test("classifyGoal: auto mode - text that looks like a browser task is still 'chat' when it's clearly about an attached file", () => {
  // mirrors submitGoal's own override in Rexy/runtime.cjs: "answer the questions in the attached file" reads like ACT_ON_PAGE text,
  // but with a real attachment present it must be answered by the chat model reading the file, never mistaken for a browser task.
  assert.equal(classifyGoal("answer the questions in the attached file", "auto", { hasAttachments: true }), "chat");
  assert.equal(classifyGoal("answer the questions in the attached file", "auto", { hasAttachments: false }), "agent", "the same text with no attachment present is not overridden");
});

test("classifyGoal: auto mode - a control word on an existing task is free, not a new agent use", () => {
  assert.equal(classifyGoal("continue", "auto"), "control");
  assert.equal(classifyGoal("stop", "auto"), "control");
  assert.equal(classifyGoal("pause", "auto"), "control");
});

// ------------------------------------------------------------------ gate(): disabled by default (rollout safety)

test("entitlementsEnabled: env var wins ('1' on, '0' off); otherwise the shipped config file decides; missing/garbled file means OFF", () => {
  const tmp = (content) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jonah-cfg-")), "c.json"); if (content !== null) fs.writeFileSync(f, content); return f; };
  const { entitlementsEnabled } = require("../../../entitlement-gate.cjs");
  const on = tmp('{"enabled": true}'), off = tmp('{"enabled": false}');
  assert.equal(entitlementsEnabled({ env: {}, configFile: on }), true, "a packaged build with no env vars is switched on by its config");
  assert.equal(entitlementsEnabled({ env: {}, configFile: off }), false);
  assert.equal(entitlementsEnabled({ env: { JONAH_ENTITLEMENTS_ENABLED: "1" }, configFile: off }), true);
  assert.equal(entitlementsEnabled({ env: { JONAH_ENTITLEMENTS_ENABLED: "0" }, configFile: on }), false);
  assert.equal(entitlementsEnabled({ env: {}, configFile: tmp(null) }), false, "missing file");
  assert.equal(entitlementsEnabled({ env: {}, configFile: tmp("{not json") }), false, "garbled file");
  assert.equal(entitlementsEnabled({ env: {}, configFile: tmp('{"enabled":"true"}') }), false, "only a real boolean true counts");
  // the shipped file is what makes `npm start` and the packaged app enforce billing; it must be a real boolean for that to work
  assert.equal(typeof JSON.parse(fs.readFileSync(path.join(__dirname, "../../../entitlements.config.json"), "utf8")).enabled, "boolean");
});

test("gate(): with enforcement switched off, every feature passes through unconditionally and sign-in never opens a browser", async () => {
  const before = process.env.JONAH_ENTITLEMENTS_ENABLED;
  process.env.JONAH_ENTITLEMENTS_ENABLED = "0"; // the dev override that forces OFF even though the shipped config is on
  try {
    await offBody();
  } finally { if (before === undefined) delete process.env.JONAH_ENTITLEMENTS_ENABLED; else process.env.JONAH_ENTITLEMENTS_ENABLED = before; }
});
async function offBody() {
  const g = mkGate({ serverUrl: "http://127.0.0.1:1" });
  assert.equal(g.enabled, false);
  assert.deepEqual(await g.gate("agent"), { allowed: true, bypass: "entitlements_disabled" });
  assert.deepEqual(await g.signIn(), { ok: true, bypass: "entitlements_disabled" }, "no browser is opened while the feature is off");
}

test("gate(): 'control' is always free, even with entitlements enabled, without even contacting the server", withEnabled(async () => {
  const g = mkGate({ serverUrl: "http://127.0.0.1:1" });
  assert.deepEqual(await g.gate("control"), { allowed: true });
}));

// ------------------------------------------------------------------ gate(): enabled, against a real stand-in server

test("gate(): enabled but NOT signed in -> refused with sign_in_required, and no browser is ever opened by gate() itself", withEnabled(async () => {
  let opened = 0;
  const g = mkGate({ serverUrl: "http://127.0.0.1:1", openExternal: async () => { opened++; } });
  const r = await g.gate("agent");
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "sign_in_required");
  assert.match(r.message, /Sign in with Google to use AI Agent/);
  assert.equal(opened, 0, "a gated action must never surprise the user with a browser window");
}));

test("gate(): signs in explicitly, then authorizes real usage against the live server", withEnabled(async () => {
  const stand = createStandInServer();
  const url = await stand.listen();
  try {
    const g = mkGate({ serverUrl: url });
    const si = await g.signIn();
    assert.equal(si.ok, true);
    const r1 = await g.gate("agent");
    assert.equal(r1.allowed, true);
    assert.equal(r1.remaining, 1);
    const r2 = await g.gate("agent");
    assert.equal(r2.allowed, true);
    assert.equal(r2.remaining, 0);
    const r3 = await g.gate("agent");
    assert.equal(r3.allowed, false);
    assert.equal(r3.reason, "lifetime_exhausted");
    assert.match(r3.message, /AI Agent limit reached/);
    assert.match(r3.message, /Upgrade/);
  } finally { await stand.close(); }
}));

test("gate(): signIn() when already signed in does not open the browser again", withEnabled(async () => {
  const stand = createStandInServer();
  const url = await stand.listen();
  try {
    let opened = 0;
    const base = googleSaysYouAre("alice");
    const g = mkGate({ serverUrl: url, openExternal: async (u) => { opened++; await base(u); } });
    await g.signIn(); await g.signIn();
    assert.equal(opened, 1);
  } finally { await stand.close(); }
}));

test("gate(): a cancelled sign-in is a plain message, and gated actions stay blocked", withEnabled(async () => {
  const stand = createStandInServer();
  const url = await stand.listen();
  try {
    const g = mkGate({ serverUrl: url, openExternal: async (a) => { const u = new URL(a); await fetch(`${u.searchParams.get("redirect_uri")}?error=access_denied&state=${u.searchParams.get("state")}`); } });
    const si = await g.signIn();
    assert.equal(si.ok, false);
    assert.equal(si.reason, "denied");
    assert.equal(si.message, "Sign-in was cancelled.");
    assert.equal((await g.gate("agent")).allowed, false);
  } finally { await stand.close(); }
}));

test("gate(): a cooldown refusal carries a human-readable time, not raw seconds or server internals", withEnabled(async () => {
  const stand = createStandInServer();
  const url = await stand.listen();
  try {
    const g = mkGate({ serverUrl: url });
    await g.signIn();
    await g.gate("trust-engine"); await g.gate("trust-engine"); await g.gate("trust-engine");
    const r = await g.gate("trust-engine");
    assert.equal(r.allowed, false);
    assert.match(r.message, /Trust Engine limit reached/);
    assert.match(r.message, /Available again in \d+h \d+m/);
  } finally { await stand.close(); }
}));

test("gate(): server unreachable at sign-in -> a plain network message, and nothing is allowed through", withEnabled(async () => {
  const g = mkGate({ serverUrl: "http://127.0.0.1:1" });
  const si = await g.signIn();
  assert.equal(si.ok, false);
  assert.match(si.message, /Cannot reach the authorization server/);
  assert.equal((await g.gate("attachment")).allowed, false);
}));

test("gate(): a suspended account is blocked at its next action with a plain message", withEnabled(async () => {
  const stand = createStandInServer();
  const url = await stand.listen();
  try {
    const g = mkGate({ serverUrl: url, openExternal: googleSaysYouAre("mallory") });
    await g.signIn();
    stand.suspend("mallory");
    const r = await g.gate("chat");
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "account_suspended");
    assert.match(r.message, /suspended/);
  } finally { await stand.close(); }
}));

test("gate(): the SAME Google account on a fresh app launch (new gate instance, new in-memory session) keeps its consumed usage", withEnabled(async () => {
  const stand = createStandInServer();
  const url = await stand.listen();
  try {
    const first = mkGate({ serverUrl: url });
    await first.signIn(); await first.gate("agent");
    const second = mkGate({ serverUrl: url }); // simulates a fresh install: different data dir, different keypair
    assert.equal((await second.gate("agent")).reason, "sign_in_required", "a new launch starts signed out");
    await second.signIn();
    const r = await second.gate("agent");
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 0, "usage followed the Google account, not the install");
  } finally { await stand.close(); }
}));

test("gate(): a restart on the SAME install stays signed in - no second Google prompt", withEnabled(async () => {
  const stand = createStandInServer();
  const url = await stand.listen();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-gate-"));
    let opened = 0;
    const open = async (u) => { opened++; await googleSaysYouAre("alice")(u); };
    const first = createEntitlementGate({ userDataDir: dir, safeStorage: keychain("k"), serverUrl: url, allowInsecureLoopback: true, openExternal: open });
    await first.signIn(); await first.gate("agent");
    const second = createEntitlementGate({ userDataDir: dir, safeStorage: keychain("k"), serverUrl: url, allowInsecureLoopback: true, openExternal: open }); // app restarted
    assert.equal(second.client.signedIn, true, "remembered across the restart");
    const r = await second.gate("agent");
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 0, "and it is the same account, with the same usage");
    assert.equal(opened, 1, "the browser was only opened for the first sign-in");
  } finally { await stand.close(); }
}));

test("gate(): the remembered sign-in is dropped if the device key changed (app data cleared / file copied to another machine)", withEnabled(async () => {
  const stand = createStandInServer();
  const url = await stand.listen();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-gate-"));
    const first = createEntitlementGate({ userDataDir: dir, safeStorage: keychain("k"), serverUrl: url, allowInsecureLoopback: true, openExternal: googleSaysYouAre("alice") });
    await first.signIn();
    fs.unlinkSync(path.join(dir, "entitlement", "entitlement-device.json")); // the keypair is gone; the session file is left behind
    const second = createEntitlementGate({ userDataDir: dir, safeStorage: keychain("k"), serverUrl: url, allowInsecureLoopback: true, openExternal: googleSaysYouAre("alice") });
    assert.equal(second.client.signedIn, false, "a session is only valid with the key it was bound to");
  } finally { await stand.close(); }
}));

test("gate(): if the server stops accepting the remembered session (401), the user is signed out and the file is cleared", withEnabled(async () => {
  const stand = createStandInServer();
  const url = await stand.listen();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-gate-"));
    const first = createEntitlementGate({ userDataDir: dir, safeStorage: keychain("k"), serverUrl: url, allowInsecureLoopback: true, openExternal: googleSaysYouAre("alice") });
    await first.signIn();
    // the same Google account signs in on a NEW install elsewhere: that supersedes this install's key server-side
    const elsewhere = mkGate({ serverUrl: url, openExternal: googleSaysYouAre("alice") });
    await elsewhere.signIn();
    const second = createEntitlementGate({ userDataDir: dir, safeStorage: keychain("k"), serverUrl: url, allowInsecureLoopback: true });
    assert.equal(second.client.signedIn, true);
    assert.equal((await second.gate("agent")).reason, "sign_in_required");
    assert.equal(second.client.signedIn, false);
    const third = createEntitlementGate({ userDataDir: dir, safeStorage: keychain("k"), serverUrl: url, allowInsecureLoopback: true });
    assert.equal(third.client.signedIn, false, "the stale session file is gone");
  } finally { await stand.close(); }
}));

test("gate(): signing out clears the remembered session", withEnabled(async () => {
  const stand = createStandInServer();
  const url = await stand.listen();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-gate-"));
    const a = createEntitlementGate({ userDataDir: dir, safeStorage: keychain("k"), serverUrl: url, allowInsecureLoopback: true, openExternal: googleSaysYouAre("alice") });
    await a.signIn(); a.client.signOut();
    const b = createEntitlementGate({ userDataDir: dir, safeStorage: keychain("k"), serverUrl: url, allowInsecureLoopback: true });
    assert.equal(b.client.signedIn, false);
  } finally { await stand.close(); }
}));

test("blockedFeatureMessage: every known reason produces plain, non-technical text naming the feature", () => {
  assert.match(blockedFeatureMessage("agent", { reason: "lifetime_exhausted" }), /^AI Agent limit reached\./);
  assert.match(blockedFeatureMessage("trust-engine", { reason: "server_unreachable" }), /Cannot reach the authorization server/);
  assert.match(blockedFeatureMessage("attachment", { reason: "cooldown", cooldownUntil: Math.floor(Date.now() / 1000) + 3661 }), /^Attachments limit reached\..*Available again in 1h/);
  assert.match(blockedFeatureMessage("agent", { reason: "sign_in_required" }), /^Sign in with Google to use AI Agent/);
  assert.match(blockedFeatureMessage("chat", { reason: "account_suspended" }), /suspended/);
  assert.match(blockedFeatureMessage("chat", { reason: "subscription_expired" }), /expired.*AI Chat/);
  assert.match(blockedFeatureMessage("attachment", { reason: "daily_limit", cooldownUntil: Math.floor(Date.now() / 1000) + 600 }), /Available again in \d+m/);
});

test("signInMessage: every failure reason has plain text", () => {
  for (const r of ["denied", "timeout", "state_mismatch", "account_suspended", "server_unreachable", "not_configured", "something_else"]) assert.ok(signInMessage(r).length > 10);
});
