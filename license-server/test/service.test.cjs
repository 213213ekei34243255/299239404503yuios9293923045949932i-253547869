// The rules of the licence system, tested against the real service (real scrypt, real Ed25519, fake clock).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const C = require("../src/crypto.cjs");
const { MESSAGES } = require("../src/service.cjs");
const { makeDevice, newService, loginAs, refreshAs, codeOf } = require("./helpers.cjs");

async function withAccount(over) {
  const env = newService(over);
  const account = await env.service.createAccount({ username: "rohan_test", password: "Test-pass-1" }, "test");
  return { ...env, account, dev: makeDevice() };
}
const verify = (env, token) => C.verifyToken(token, [{ kid: env.key.kid, publicKey: env.key.publicKey }], { now: env.clock.t, issuer: "jonah-license", audience: "jonah-mac" });

test("login: correct credentials on a first device give a short-lived signed token, and bind that device", async () => {
  const env = await withAccount();
  const r = await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  assert.equal(r.ok, true);
  const v = verify(env, r.accessToken);
  assert.equal(v.ok, true);
  assert.equal(v.claims.usr, "rohan_test");
  assert.equal(v.claims.unl, 1);
  assert.equal(v.claims.exp - v.claims.iat, 180, "the token lives 3 minutes");
  const view = env.service.getAccountView(env.account.id);
  assert.equal(view.device.label, "Test Mac");
  assert.equal(view.online, true);
});

test("passwords are stored only as scrypt hashes, never in plaintext", async () => {
  const env = await withAccount();
  const rows = env.service.db.prepare("SELECT password_hash FROM accounts").all();
  assert.match(rows[0].password_hash, /^scrypt\$32768\$8\$1\$/);
  const dump = JSON.stringify(env.service.db.prepare("SELECT * FROM accounts").all()) + JSON.stringify(env.service.listAudit(500));
  assert.ok(!dump.includes("Test-pass-1"), "the password appears nowhere in the database");
});

test("wrong password and unknown user are indistinguishable (same code)", async () => {
  const env = await withAccount();
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "nope-nope-1")), "invalid_credentials");
  assert.equal(await codeOf(loginAs(env.service, env.dev, "nobody_here", "nope-nope-1")), "invalid_credentials");
});

test("brute force: 5 wrong passwords lock that user+IP, even for the right password, until the wait passes", async () => {
  const env = await withAccount();
  for (let i = 0; i < 5; i++) assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "wrong-pass-" + i)), "invalid_credentials");
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "Test-pass-1")), "rate_limited");
  env.clock.t += 31;
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "Test-pass-1")), "OK");
});

test("a guesser on another IP does not lock the real user out", async () => {
  const env = await withAccount();
  for (let i = 0; i < 6; i++) await codeOf(loginAs(env.service, makeDevice(), "rohan_test", "guess-" + i, "66.6.6.6"));
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "Test-pass-1", "10.0.0.1")), "OK");
});

test("master switch: deactivating the whole app blocks logins AND running sessions; reactivating restores them", async () => {
  const env = await withAccount();
  const s = await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  env.service.updateSettings({ appActive: false }, "admin:t");
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "Test-pass-1")), "access_expired");
  assert.equal(await codeOf(loginAs(env.service, env.dev, "nobody", "whatever-1")), "access_expired", "nothing is learned about accounts while it is off");
  assert.equal(await codeOf(refreshAs(env.service, env.dev, s)), "access_expired");
  env.service.updateSettings({ appActive: true }, "admin:t");
  assert.equal(await codeOf(refreshAs(env.service, env.dev, s)), "OK");
});

test("master switch: turning unlimited-access mode off blocks everyone the same way", async () => {
  const env = await withAccount();
  const s = await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  env.service.updateSettings({ unlimitedEnabled: false }, "admin:t");
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "Test-pass-1")), "access_expired");
  assert.equal(await codeOf(refreshAs(env.service, env.dev, s)), "access_expired");
});

test("ban: takes effect at the next check, for logins and for a running session; unban restores", async () => {
  const env = await withAccount();
  const s = await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  env.service.action(env.account.id, "ban", "admin:t");
  assert.equal(await codeOf(refreshAs(env.service, env.dev, s)), "access_expired");
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "Test-pass-1")), "access_expired");
  assert.equal(env.service.getAccountView(env.account.id).effectiveStatus, "banned");
  env.service.action(env.account.id, "unban", "admin:t");
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "Test-pass-1")), "OK");
});

test("disable behaves like a ban but is shown as disabled", async () => {
  const env = await withAccount();
  const s = await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  env.service.action(env.account.id, "disable", "admin:t");
  assert.equal(await codeOf(refreshAs(env.service, env.dev, s)), "access_expired");
  assert.equal(env.service.getAccountView(env.account.id).effectiveStatus, "disabled");
  env.service.action(env.account.id, "enable", "admin:t");
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "Test-pass-1")), "OK");
});

test("expiry date: access ends when the date passes, for logins and running sessions", async () => {
  const env = await withAccount();
  env.service.updateAccount(env.account.id, { expiresAt: env.clock.t + 1000 }, "admin:t");
  const s = await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  env.clock.t += 600; // still inside both the expiry and the 15-minute idle limit
  assert.equal(await codeOf(refreshAs(env.service, env.dev, s)), "OK");
  env.clock.t += 401; // now past the expiry date
  assert.equal(await codeOf(refreshAs(env.service, env.dev, s)), "access_expired");
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "Test-pass-1")), "access_expired");
  assert.equal(env.service.getAccountView(env.account.id).effectiveStatus, "expired");
});

test("one account, one device: another Mac with the right password is refused with the device message", async () => {
  const env = await withAccount();
  await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  const other = makeDevice("Other Mac");
  assert.equal(await codeOf(loginAs(env.service, other, "rohan_test", "Test-pass-1")), "device_conflict");
  assert.equal(MESSAGES.device_conflict, "This account is already authorized on another device. Please contact Customer Care Service to transfer or reset your device authorization.");
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "Test-pass-1")), "OK", "the original device still works");
});

test("same device key but different hardware id (a copied installation) is refused", async () => {
  const env = await withAccount();
  await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  const clone = { ...env.dev, hw: C.sha256Hex("another mac") };
  assert.equal(await codeOf(loginAs(env.service, clone, "rohan_test", "Test-pass-1")), "device_conflict");
});

test("revoking the device frees the account for another Mac, and ends the old device's session", async () => {
  const env = await withAccount();
  const first = await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  env.service.action(env.account.id, "revoke-device", "admin:t");
  assert.equal(env.service.getAccountView(env.account.id).device, null);
  assert.equal(await codeOf(refreshAs(env.service, env.dev, first)), "session_ended");
  const other = makeDevice("New Mac");
  assert.equal(await codeOf(loginAs(env.service, other, "rohan_test", "Test-pass-1")), "OK");
  assert.equal(env.service.getAccountView(env.account.id).device.label, "New Mac");
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "Test-pass-1")), "device_conflict", "the old Mac is now the outsider");
});

test("two Macs racing for a fresh account: exactly one wins the binding", async () => {
  const env = await withAccount();
  const a = makeDevice("A"), b = makeDevice("B");
  const [ra, rb] = await Promise.all([codeOf(loginAs(env.service, a, "rohan_test", "Test-pass-1")), codeOf(loginAs(env.service, b, "rohan_test", "Test-pass-1"))]);
  assert.deepEqual([ra, rb].sort(), ["OK", "device_conflict"]);
});

test("force re-authentication ends every session; a fresh login works", async () => {
  const env = await withAccount();
  const s = await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  env.service.action(env.account.id, "force-reauth", "admin:t");
  assert.equal(await codeOf(refreshAs(env.service, env.dev, s)), "session_ended");
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "Test-pass-1")), "OK");
});

test("a refresh needs the device's signature: another key, or a replayed challenge, is refused", async () => {
  const env = await withAccount();
  const s = await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  const thief = makeDevice("Thief");
  assert.equal(await codeOf(refreshAs(env.service, thief, s)), "bad_device_proof");

  const ch = env.service.issueChallenge("10.0.0.1");
  const args = { sessionId: s.sessionId, refreshToken: s.refreshToken, challengeId: ch.challengeId, sig: env.dev.sign(`refresh|${ch.nonce}|${s.sessionId}`), ip: "10.0.0.1" };
  assert.equal(await codeOf(env.service.refresh(args)), "OK");
  assert.equal(await codeOf(env.service.refresh(args)), "bad_challenge", "a challenge works once");
});

test("a stolen refresh token alone is useless: wrong token, idle expiry and logout all end the session", async () => {
  const env = await withAccount();
  const s = await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  assert.equal(await codeOf(refreshAs(env.service, env.dev, { ...s, refreshToken: "x".repeat(43) })), "session_ended");
  env.clock.t += 16 * 60; // idle longer than 15 minutes
  assert.equal(await codeOf(refreshAs(env.service, env.dev, s)), "session_ended");

  const s2 = await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  env.service.logout(s2);
  assert.equal(await codeOf(refreshAs(env.service, env.dev, s2)), "session_ended");
});

test("challenges are single-use and expire after 60 seconds", async () => {
  const env = await withAccount();
  const ch = env.service.issueChallenge("10.0.0.1");
  env.clock.t += 61;
  const sig = env.dev.sign(`login|${ch.nonce}|rohan_test|${env.dev.hw}`);
  assert.equal(await codeOf(env.service.login({ username: "rohan_test", password: "Test-pass-1", challengeId: ch.challengeId, device: { pub: env.dev.pub, hw: env.dev.hw, label: "x", sig }, ip: "10.0.0.1" })), "bad_challenge");
  assert.equal(await codeOf(env.service.login({ username: "rohan_test", password: "Test-pass-1", challengeId: "unknown", device: { pub: env.dev.pub, hw: env.dev.hw, label: "x", sig }, ip: "10.0.0.1" })), "bad_challenge");
});

test("changing the password signs the user out and the old password stops working", async () => {
  const env = await withAccount();
  const s = await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  await env.service.setPassword(env.account.id, "Brand-new-pass-2", "admin:t");
  assert.equal(await codeOf(refreshAs(env.service, env.dev, s)), "session_ended");
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "Test-pass-1")), "invalid_credentials");
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "Brand-new-pass-2")), "OK");
});

test("deleting an account ends its sessions and removes the login", async () => {
  const env = await withAccount();
  const s = await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  env.service.deleteAccount(env.account.id, "admin:t");
  assert.equal(await codeOf(refreshAs(env.service, env.dev, s)), "session_ended");
  assert.equal(await codeOf(loginAs(env.service, env.dev, "rohan_test", "Test-pass-1")), "invalid_credentials");
});

test("editing only a note does not sign the user out; changing the expiry does", async () => {
  const env = await withAccount();
  const s = await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  env.service.updateAccount(env.account.id, { note: "tester from Delhi" }, "admin:t");
  assert.equal(await codeOf(refreshAs(env.service, env.dev, s)), "OK");
  env.service.updateAccount(env.account.id, { expiresAt: env.clock.t + 99999 }, "admin:t");
  assert.equal(await codeOf(refreshAs(env.service, env.dev, s)), "session_ended");
});

test("usernames are case-insensitive, and the seeded accounts are created once without touching existing ones", async () => {
  const env = newService();
  const first = await env.service.seedAccounts([{ username: "Rohan_One", password: "Seed-pass-1" }, { username: "Tomas_Two", password: "Seed-pass-2" }]);
  assert.deepEqual(first, ["Rohan_One", "Tomas_Two"]);
  assert.deepEqual(await env.service.seedAccounts([{ username: "rohan_one", password: "DIFFERENT-9" }]), [], "an existing account is never overwritten");
  const dev = makeDevice();
  assert.equal(await codeOf(loginAs(env.service, dev, "ROHAN_ONE", "Seed-pass-1")), "OK");
  assert.equal(await codeOf(loginAs(env.service, dev, "rohan_one", "DIFFERENT-9")), "invalid_credentials");
});

test("an account list shows active, disabled, banned and expired accounts and who is online", async () => {
  const env = newService();
  const mk = (u) => env.service.createAccount({ username: u, password: "Pass-word-1" }, "t");
  const a = await mk("acct_active"), b = await mk("acct_disabled"), c = await mk("acct_banned"), d = await mk("acct_expired");
  env.service.action(b.id, "disable", "t"); env.service.action(c.id, "ban", "t");
  env.service.updateAccount(d.id, { expiresAt: env.clock.t + 10 }, "t"); env.clock.t += 11;
  await loginAs(env.service, makeDevice(), "acct_active", "Pass-word-1");
  const o = env.service.overview();
  assert.deepEqual(o.counts, { active: 1, disabled: 1, banned: 1, expired: 1, online: 1 });
  assert.equal(o.accounts.find((x) => x.id === a.id).online, true);
  assert.equal(o.accounts.find((x) => x.id === b.id).effectiveStatus, "disabled");
});

test("validation: bad usernames, short passwords, duplicate names and bad settings are refused", async () => {
  const env = newService();
  assert.equal(await codeOf(env.service.createAccount({ username: "a b", password: "Long-enough-1" }, "t")), "bad_request");
  assert.equal(await codeOf(env.service.createAccount({ username: "okname", password: "short" }, "t")), "bad_request");
  await env.service.createAccount({ username: "okname", password: "Long-enough-1" }, "t");
  assert.equal(await codeOf(env.service.createAccount({ username: "OKNAME", password: "Long-enough-1" }, "t")), "bad_request");
  assert.throws(() => env.service.updateSettings({ appActive: "yes" }, "t"), (e) => e.code === "bad_request");
  assert.throws(() => env.service.updateSettings({ tokenTtlSeconds: 5 }, "t"), (e) => e.code === "bad_request");
  assert.throws(() => env.service.action(1, "explode", "t"), (e) => e.code === "bad_request");
});

test("the audit log records admin actions and sign-in outcomes without any password", async () => {
  const env = await withAccount();
  await codeOf(loginAs(env.service, env.dev, "rohan_test", "wrong-wrong-1"));
  await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  env.service.action(env.account.id, "ban", "admin:owner");
  const log = env.service.listAudit(50);
  const actions = log.map((e) => e.action);
  for (const want of ["account_create", "login_failed", "device_bound", "login", "ban"]) assert.ok(actions.includes(want), `missing ${want}: ${actions}`);
  assert.equal(log.find((e) => e.action === "ban").actor, "admin:owner");
  assert.ok(!JSON.stringify(log).includes("wrong-wrong-1") && !JSON.stringify(log).includes("Test-pass-1"));
});

// ------------------------------------------------------------------ tokens

test("token verification rejects tampering, the wrong algorithm, unknown keys, wrong audience and expiry", async () => {
  const env = await withAccount();
  const r = await loginAs(env.service, env.dev, "rohan_test", "Test-pass-1");
  const keys = [{ kid: env.key.kid, publicKey: env.key.publicKey }];
  const opts = { now: env.clock.t, issuer: "jonah-license", audience: "jonah-mac" };
  const [h, p, s] = r.accessToken.split(".");
  assert.equal(C.verifyToken(r.accessToken, keys, opts).ok, true);

  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  const forged = C.b64u(JSON.stringify({ ...claims, usr: "someone_else" }));
  assert.equal(C.verifyToken(`${h}.${forged}.${s}`, keys, opts).reason, "bad_signature");

  const none = C.b64u(JSON.stringify({ alg: "none", typ: "JLT", kid: env.key.kid }));
  assert.equal(C.verifyToken(`${none}.${p}.`, keys, opts).reason, "bad_alg");
  const hs = C.b64u(JSON.stringify({ alg: "HS256", typ: "JLT", kid: env.key.kid }));
  assert.equal(C.verifyToken(`${hs}.${p}.${s}`, keys, opts).reason, "bad_alg");

  const stranger = C.keyInfo(crypto.generateKeyPairSync("ed25519").privateKey);
  assert.equal(C.verifyToken(C.signToken(claims, stranger), keys, opts).reason, "unknown_kid");
  assert.equal(C.verifyToken(r.accessToken, [{ kid: env.key.kid, publicKey: stranger.publicKey }], opts).reason, "bad_signature", "signed by a different key");

  assert.equal(C.verifyToken(r.accessToken, keys, { ...opts, audience: "other-app" }).reason, "bad_audience");
  assert.equal(C.verifyToken(r.accessToken, keys, { ...opts, now: env.clock.t + 180 + 31 }).reason, "expired");
  assert.equal(C.verifyToken("garbage", keys, opts).reason, "malformed");
});

// ------------------------------------------------------------------ admins

test("administrator: sign-in, lock-out after failures, idle expiry and password change", async () => {
  const env = newService({ adminUsername: "owner", adminPassword: "A-long-admin-pass-1" });
  assert.deepEqual(await env.service.ensureBootstrapAdmin(() => {}), { username: "owner", generated: false });
  assert.equal(await env.service.ensureBootstrapAdmin(() => {}), null, "only created once");

  for (let i = 0; i < 5; i++) assert.equal(await codeOf(env.service.adminLogin({ username: "owner", password: "bad-pass-" + i, ip: "9.9.9.9" })), "invalid_credentials");
  assert.equal(await codeOf(env.service.adminLogin({ username: "owner", password: "A-long-admin-pass-1", ip: "9.9.9.9" })), "rate_limited");
  env.clock.t += 61;

  const s = await env.service.adminLogin({ username: "owner", password: "A-long-admin-pass-1", ip: "9.9.9.9" });
  assert.ok(env.service.adminFromToken(s.token));
  env.clock.t += 31 * 60;
  assert.equal(env.service.adminFromToken(s.token), null, "idle sessions expire");

  const s2 = await env.service.adminLogin({ username: "owner", password: "A-long-admin-pass-1", ip: "9.9.9.9" });
  const me = env.service.adminFromToken(s2.token);
  assert.equal(await codeOf(env.service.adminChangePassword(me.adminId, "wrong", "Another-long-pass-2", me.tokenHash)), "invalid_credentials");
  assert.equal(await codeOf(env.service.adminChangePassword(me.adminId, "A-long-admin-pass-1", "short", me.tokenHash)), "bad_request");
  await env.service.adminChangePassword(me.adminId, "A-long-admin-pass-1", "Another-long-pass-2", me.tokenHash);
  assert.equal(await codeOf(env.service.adminLogin({ username: "owner", password: "A-long-admin-pass-1", ip: "8.8.8.8" })), "invalid_credentials");
  assert.equal(await codeOf(env.service.adminLogin({ username: "owner", password: "Another-long-pass-2", ip: "8.8.8.8" })), "OK");
});
