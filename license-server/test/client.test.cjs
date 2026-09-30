// The Mac app's licence client (license-client.cjs + license-device.cjs) against the real server over real HTTP.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const has = fs.existsSync(path.join(ROOT, "license-client.cjs"));
const skip = has ? false : "the Mac app files are not next to the server (standalone deployment)";

const { createServer } = require("../src/http.cjs");
const { newService } = require("./helpers.cjs");
const C = require("../src/crypto.cjs");

const load = (f) => require(path.join(ROOT, f));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the macOS Keychain: encrypts with a per-"Mac" secret, so a blob from another "Mac" cannot be decrypted.
function fakeKeychain(machineSecret) {
  const key = crypto.createHash("sha256").update(machineSecret).digest();
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", key, iv); const enc = Buffer.concat([c.update(s, "utf8"), c.final()]); return Buffer.concat([iv, c.getAuthTag(), enc]); },
    decryptString: (b) => { const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"); },
  };
}

async function world(over = {}) {
  const env = newService({ requireHttps: false, ...over });
  await env.service.createAccount({ username: "rohan_test", password: "Test-pass-1" }, "t");
  const server = createServer({ service: env.service, config: env.config, publicDir: path.join(__dirname, "..", "public") });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const mono = { t: 1000000 };
  const { createDeviceStore } = load("license-device.cjs");
  const { LicenseClient } = load("license-client.cjs");
  const makeMac = (name = "mac-1", secret = "keychain-1", hw = "HW-" + name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-dev-"));
    const device = createDeviceStore({ dir, safeStorage: fakeKeychain(secret), hardwareId: () => hw, label: () => name });
    return { dir, device };
  };
  const makeClient = (mac, extra = {}) => new LicenseClient({ serverUrl: url, publicKeys: [{ kid: env.key.kid, spki: env.key.spki }], device: mac.device, allowInsecureLoopback: true, monotonic: () => mono.t, ...extra });
  const close = () => new Promise((r) => { server.close(r); server.closeAllConnections(); });
  return { ...env, url, mono, makeMac, makeClient, close, server };
}

test("sign in: the client ends up holding a token the server signed, for this device", { skip }, async () => {
  const w = await world();
  try {
    const mac = w.makeMac(); const client = w.makeClient(mac);
    const r = await client.login("rohan_test", "Test-pass-1");
    assert.deepEqual({ ok: r.ok, username: r.username }, { ok: true, username: "rohan_test" });
    assert.equal(client.signedIn, true);
    const token = client.getAccessToken();
    assert.equal(C.verifyToken(token, [{ kid: w.key.kid, publicKey: w.key.publicKey }], { now: w.clock.t, issuer: "jonah-license", audience: "jonah-mac" }).ok, true);
    assert.equal(w.service.listAccounts()[0].device.label, "mac-1");
  } finally { await w.close(); }
});

test("wrong password: refused with the plain message, and nothing is held", { skip }, async () => {
  const w = await world();
  try {
    const client = w.makeClient(w.makeMac());
    const r = await client.login("rohan_test", "not-the-password");
    assert.deepEqual({ ok: r.ok, code: r.code, message: r.message }, { ok: false, code: "invalid_credentials", message: "Incorrect username or password." });
    assert.equal(client.signedIn, false);
    assert.equal(client.getAccessToken(), null);
    assert.equal((await client.login("", "")).code, "bad_request");
  } finally { await w.close(); }
});

test("banned / expired / switched-off: the exact 'developer access expired' message", { skip }, async () => {
  const EXPIRED = "Sorry, your developer access mode has expired. Kindly reinstall the app from the Mac App Store or jonahbrowser.com, or please contact Customer Care Service.";
  const w = await world();
  try {
    const id = w.service.listAccounts()[0].id;
    w.service.action(id, "ban", "t");
    let r = await w.makeClient(w.makeMac()).login("rohan_test", "Test-pass-1");
    assert.equal(r.message, EXPIRED);
    w.service.action(id, "unban", "t");
    w.service.updateSettings({ appActive: false }, "t");
    r = await w.makeClient(w.makeMac()).login("rohan_test", "Test-pass-1");
    assert.equal(r.message, EXPIRED);
    w.service.updateSettings({ appActive: true, unlimitedEnabled: false }, "t");
    r = await w.makeClient(w.makeMac()).login("rohan_test", "Test-pass-1");
    assert.equal(r.message, EXPIRED);
  } finally { await w.close(); }
});

test("a second Mac gets the separate device message; after the admin revokes the device it can sign in", { skip }, async () => {
  const DEVICE = "This account is already authorized on another device. Please contact Customer Care Service to transfer or reset your device authorization.";
  const w = await world();
  try {
    assert.equal((await w.makeClient(w.makeMac("mac-1", "k1")).login("rohan_test", "Test-pass-1")).ok, true);
    const second = w.makeClient(w.makeMac("mac-2", "k2"));
    const r = await second.login("rohan_test", "Test-pass-1");
    assert.deepEqual({ code: r.code, message: r.message }, { code: "device_conflict", message: DEVICE });
    w.service.action(w.service.listAccounts()[0].id, "revoke-device", "t");
    assert.equal((await second.login("rohan_test", "Test-pass-1")).ok, true);
  } finally { await w.close(); }
});

test("copying an authorized installation to another Mac does not work", { skip }, async () => {
  const w = await world();
  try {
    const original = w.makeMac("mac-1", "keychain-A", "HW-A");
    assert.equal((await w.makeClient(original).login("rohan_test", "Test-pass-1")).ok, true);
    // copy the whole app data folder to a Mac with a different keychain and a different hardware id
    const { createDeviceStore } = load("license-device.cjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-copy-"));
    fs.copyFileSync(original.device.file, path.join(dir, "license-device.json"));
    const copyDevice = createDeviceStore({ dir, safeStorage: fakeKeychain("keychain-B"), hardwareId: () => "HW-B", label: () => "copy" });
    const r = await w.makeClient({ device: copyDevice }).login("rohan_test", "Test-pass-1");
    assert.equal(r.code, "device_conflict");
    // even with the keychain "shared", a different hardware id is refused
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-copy2-"));
    fs.copyFileSync(original.device.file, path.join(dir2, "license-device.json"));
    const sameKeychain = createDeviceStore({ dir: dir2, safeStorage: fakeKeychain("keychain-A"), hardwareId: () => "HW-OTHER", label: () => "copy2" });
    assert.equal((await w.makeClient({ device: sameKeychain }).login("rohan_test", "Test-pass-1")).code, "device_conflict");
  } finally { await w.close(); }
});

test("the device key file holds no readable private key and survives restarts unchanged", { skip }, async () => {
  const { createDeviceStore } = load("license-device.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-dev-"));
  const mk = () => createDeviceStore({ dir, safeStorage: fakeKeychain("k"), hardwareId: () => "HW", label: () => "m" });
  const a = mk().load();
  const b = mk().load();
  assert.equal(a.id, b.id, "the same device after a restart");
  const raw = fs.readFileSync(path.join(dir, "license-device.json"), "utf8");
  assert.equal(JSON.parse(raw).enc, "os");
  const priv = JSON.parse(raw).priv;
  assert.ok(!Buffer.from(priv, "base64").toString("latin1").includes("\u0006\u0003+ep"), "the stored bytes are not a plain PKCS#8 key");
  // tampering with the stored public key makes it a different (new) device rather than trusting the file
  const j = JSON.parse(raw); j.pub = j.pub.slice(0, -4) + "AAAA"; fs.writeFileSync(path.join(dir, "license-device.json"), JSON.stringify(j));
  assert.notEqual(mk().load().id, a.id);
});

test("the periodic check: banning a signed-in user ends their access at the next check, once", { skip }, async () => {
  const w = await world();
  try {
    const client = w.makeClient(w.makeMac());
    await client.login("rohan_test", "Test-pass-1");
    const lost = [];
    client.start(60, (code) => lost.push(code));
    await sleep(250);
    assert.deepEqual(lost, [], "still allowed while nothing changed");
    assert.equal(client.signedIn, true);
    w.service.action(w.service.listAccounts()[0].id, "ban", "t");
    await sleep(500);
    assert.deepEqual(lost, ["access_expired"]);
    assert.equal(client.signedIn, false);
    assert.equal(client.getAccessToken(), null);
    await sleep(200);
    assert.equal(lost.length, 1, "reported once");
  } finally { await w.close(); }
});

test("the periodic check: deactivating the whole app, revoking the device or forcing re-login also ends access", { skip }, async () => {
  for (const [name, doIt, expected] of [
    ["app off", (w) => w.service.updateSettings({ appActive: false }, "t"), "access_expired"],
    ["unlimited off", (w) => w.service.updateSettings({ unlimitedEnabled: false }, "t"), "access_expired"],
    ["device revoked", (w) => w.service.action(w.service.listAccounts()[0].id, "revoke-device", "t"), "session_ended"],
    ["force re-login", (w) => w.service.action(w.service.listAccounts()[0].id, "force-reauth", "t"), "session_ended"],
    ["deleted", (w) => w.service.deleteAccount(w.service.listAccounts()[0].id, "t"), "session_ended"],
  ]) {
    const w = await world();
    try {
      const client = w.makeClient(w.makeMac());
      await client.login("rohan_test", "Test-pass-1");
      const lost = [];
      client.start(50, (c) => lost.push(c));
      doIt(w);
      await sleep(500);
      assert.deepEqual(lost, [expected], name);
    } finally { await w.close(); }
  }
});

test("server unreachable: keeps working only until the last signed token runs out, then locks (fail closed)", { skip }, async () => {
  const w = await world();
  try {
    let down = false;
    const fetchImpl = (...a) => (down ? Promise.reject(new Error("offline")) : fetch(...a));
    const client = w.makeClient(w.makeMac(), { fetchImpl });
    await client.login("rohan_test", "Test-pass-1");
    const lost = [];
    client.start(40, (c) => lost.push(c));
    down = true;
    await sleep(300);
    assert.deepEqual(lost, [], "a short outage inside the token's 3 minutes is tolerated");
    assert.ok(client.getAccessToken());
    w.mono.t += 181 * 1000; // the token's lifetime passes on the client's monotonic clock
    assert.equal(client.getAccessToken(), null, "no token is handed out after it expired");
    await sleep(300);
    assert.deepEqual(lost, ["server_unreachable"]);
  } finally { await w.close(); }
});

test("a forged 'success' from a fake server is rejected: it cannot sign tokens the pinned key accepts", { skip }, async () => {
  const w = await world();
  try {
    const rogue = C.keyInfo(crypto.generateKeyPairSync("ed25519").privateKey);
    const mac = w.makeMac();
    const dev = mac.device.load();
    // a man-in-the-middle answers the login with a token signed by ITS key
    const fetchImpl = async (url, opts) => {
      if (String(url).endsWith("/v1/auth/challenge")) return new Response(JSON.stringify({ ok: true, challengeId: "c1", nonce: "n1" }), { status: 200 });
      const t = C.signToken({ iss: "jonah-license", aud: "jonah-mac", usr: "rohan_test", did: dev.id, nc: "n1", iat: 1, exp: 100, sid: "s", unl: 1, sub: 1, ep: 0 }, { ...rogue });
      return new Response(JSON.stringify({ ok: true, sessionId: "s", refreshToken: "r", accessToken: t }), { status: 200 });
    };
    const client = w.makeClient(mac, { fetchImpl });
    const r = await client.login("rohan_test", "Test-pass-1");
    assert.equal(r.code, "bad_response");
    assert.equal(client.signedIn, false);
  } finally { await w.close(); }
});

test("a replayed old server reply is rejected (it does not answer this request's challenge)", { skip }, async () => {
  const w = await world();
  try {
    const mac = w.makeMac();
    const first = w.makeClient(mac);
    let captured = null;
    const spy = async (url, opts) => { const res = await fetch(url, opts); if (String(url).endsWith("/v1/auth/login")) captured = { status: res.status, body: await res.clone().text() }; return res; };
    const spying = w.makeClient(mac, { fetchImpl: spy });
    assert.equal((await spying.login("rohan_test", "Test-pass-1")).ok, true);

    const replay = async (url, opts) => (String(url).endsWith("/v1/auth/login") ? new Response(captured.body, { status: captured.status }) : fetch(url, opts));
    const victim = w.makeClient(mac, { fetchImpl: replay });
    const r = await victim.login("rohan_test", "Test-pass-1");
    assert.equal(r.code, "bad_response");
    assert.equal(victim.signedIn, false);
    assert.equal(first.signedIn, false);
  } finally { await w.close(); }
});

test("only HTTPS is accepted (plain http only for the local machine in development); a disabled-TLS environment stops sign-in", { skip }, async () => {
  const { checkServerUrl } = load("license-client.cjs");
  assert.ok(checkServerUrl("https://license.example.com", false));
  assert.equal(checkServerUrl("http://license.example.com", false), null);
  assert.equal(checkServerUrl("http://license.example.com", true), null, "http is only allowed for the local machine");
  assert.equal(checkServerUrl("http://127.0.0.1:8791", false), null, "a packaged app never allows http");
  assert.ok(checkServerUrl("http://127.0.0.1:8791", true));
  assert.equal(checkServerUrl("ftp://x", true), null);
  assert.equal(checkServerUrl("not a url", true), null);

  const w = await world();
  try {
    const { LicenseClient } = load("license-client.cjs");
    const mac = w.makeMac();
    const unconfigured = new LicenseClient({ serverUrl: "", publicKeys: [], device: mac.device });
    assert.equal((await unconfigured.login("a", "b")).code, "not_configured");
    const insecure = new LicenseClient({ serverUrl: "https://license.example.com", publicKeys: [{ kid: w.key.kid, spki: w.key.spki }], device: mac.device, env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, fetchImpl: () => { throw new Error("must not be called"); } });
    assert.equal((await insecure.login("rohan_test", "Test-pass-1")).code, "insecure");
  } finally { await w.close(); }
});

test("sign out tells the server, which ends that session", { skip }, async () => {
  const w = await world();
  try {
    const client = w.makeClient(w.makeMac());
    await client.login("rohan_test", "Test-pass-1");
    assert.equal(w.service.listAccounts()[0].activeSessions, 1);
    await client.logout();
    assert.equal(w.service.listAccounts()[0].activeSessions, 0);
    assert.equal(client.signedIn, false);
  } finally { await w.close(); }
});

test("wording always comes from the app itself: a server that sends its own message text cannot change what the user sees", { skip }, async () => {
  const w = await world();
  try {
    const fetchImpl = async (url) => (String(url).endsWith("/v1/auth/challenge")
      ? new Response(JSON.stringify({ ok: true, challengeId: "c", nonce: "n" }), { status: 200 })
      : new Response(JSON.stringify({ ok: false, code: "access_expired", message: "Visit http://evil.example to renew" }), { status: 403 }));
    const r = await w.makeClient(w.makeMac(), { fetchImpl }).login("rohan_test", "Test-pass-1");
    assert.ok(!/evil/.test(r.message));
    assert.match(r.message, /reinstall the app from the Mac App Store or jonahbrowser\.com/);
  } finally { await w.close(); }
});
