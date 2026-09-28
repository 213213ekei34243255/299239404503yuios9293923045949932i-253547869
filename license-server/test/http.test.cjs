// The HTTP surface, through a real server on a real port.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { createServer } = require("../src/http.cjs");
const { makeDevice, newService } = require("./helpers.cjs");

const PUBLIC = path.join(__dirname, "..", "public");

async function boot(over = {}) {
  const env = newService({ requireHttps: false, adminUsername: "owner", adminPassword: "A-long-admin-pass-1", ...over });
  await env.service.ensureBootstrapAdmin(() => {});
  await env.service.createAccount({ username: "rohan_test", password: "Test-pass-1" }, "t");
  const server = createServer({ service: env.service, config: env.config, publicDir: PUBLIC });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => { server.close(r); server.closeAllConnections(); });
  return { ...env, server, base, close };
}
const post = (base, p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

async function clientLogin(base, dev, username, password) {
  const ch = await (await post(base, "/v1/auth/challenge", {})).json();
  const sig = dev.sign(`login|${ch.nonce}|${username.toLowerCase()}|${dev.hw}`);
  return post(base, "/v1/auth/login", { username, password, challengeId: ch.challengeId, device: { pub: dev.pub, hw: dev.hw, label: dev.label, sig } });
}

test("client API: challenge -> login -> refresh -> logout over HTTP", async () => {
  const s = await boot();
  try {
    const dev = makeDevice();
    const res = await clientLogin(s.base, dev, "rohan_test", "Test-pass-1");
    assert.equal(res.status, 200);
    const session = await res.json();
    assert.ok(session.accessToken && session.refreshToken && session.sessionId);
    assert.ok(!JSON.stringify(session).includes("Test-pass-1"));

    const ch = await (await post(s.base, "/v1/auth/challenge", {})).json();
    const refreshed = await post(s.base, "/v1/session/refresh", { sessionId: session.sessionId, refreshToken: session.refreshToken, challengeId: ch.challengeId, sig: dev.sign(`refresh|${ch.nonce}|${session.sessionId}`) });
    assert.equal(refreshed.status, 200);

    assert.equal((await post(s.base, "/v1/session/logout", { sessionId: session.sessionId, refreshToken: session.refreshToken })).status, 200);
    const ch2 = await (await post(s.base, "/v1/auth/challenge", {})).json();
    const after = await post(s.base, "/v1/session/refresh", { sessionId: session.sessionId, refreshToken: session.refreshToken, challengeId: ch2.challengeId, sig: dev.sign(`refresh|${ch2.nonce}|${session.sessionId}`) });
    assert.equal(after.status, 401);
    assert.equal((await after.json()).code, "session_ended");
  } finally { await s.close(); }
});

test("error replies carry a machine code and the right status (401 / 403 / 429)", async () => {
  const s = await boot();
  try {
    const dev = makeDevice();
    const bad = await clientLogin(s.base, dev, "rohan_test", "wrong-pass-1");
    assert.equal(bad.status, 401);
    assert.equal((await bad.json()).code, "invalid_credentials");

    await clientLogin(s.base, dev, "rohan_test", "Test-pass-1");
    const other = await clientLogin(s.base, makeDevice(), "rohan_test", "Test-pass-1");
    assert.equal(other.status, 403);
    assert.equal((await other.json()).code, "device_conflict");

    s.service.updateSettings({ appActive: false }, "t");
    const off = await clientLogin(s.base, dev, "rohan_test", "Test-pass-1");
    assert.equal(off.status, 403);
    assert.equal((await off.json()).code, "access_expired");
    s.service.updateSettings({ appActive: true }, "t");

    for (let i = 0; i < 6; i++) await clientLogin(s.base, makeDevice(), "rohan_test", "guess-" + i);
    const locked = await clientLogin(s.base, makeDevice(), "rohan_test", "Test-pass-1");
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get("retry-after")) > 0);
  } finally { await s.close(); }
});

test("bad requests: unknown routes, wrong method, broken JSON and oversized bodies are refused cleanly", async () => {
  const s = await boot();
  try {
    assert.equal((await fetch(s.base + "/nothing")).status, 404);
    assert.equal((await fetch(s.base + "/v1/auth/login")).status, 404, "login is POST-only");
    const broken = await fetch(s.base + "/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json" });
    assert.equal(broken.status, 400);
    let big;
    try { big = await post(s.base, "/v1/auth/login", { username: "x".repeat(40000) }); } catch { big = { status: 400 }; }
    assert.equal(big.status, 400);
    assert.equal((await (await fetch(s.base + "/health")).json()).ok, true);
  } finally { await s.close(); }
});

test("HTTPS: with it required, plain HTTP is refused; behind a trusted proxy that says https it is accepted", async () => {
  const strict = await boot({ requireHttps: true });
  try {
    const r = await post(strict.base, "/v1/auth/challenge", {});
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, "https_required");
    const spoof = await post(strict.base, "/v1/auth/challenge", {}, { "X-Forwarded-Proto": "https" });
    assert.equal(spoof.status, 400, "the header is ignored unless a proxy is configured as trusted");
    assert.equal((await fetch(strict.base + "/health")).status, 200, "the health check is exempt");
  } finally { await strict.close(); }

  const proxied = await boot({ requireHttps: true, trustProxyHops: 1 });
  try {
    const ok = await post(proxied.base, "/v1/auth/challenge", {}, { "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.9" });
    assert.equal(ok.status, 200);
    assert.ok(ok.headers.get("strict-transport-security"));
  } finally { await proxied.close(); }
});

test("responses are never cacheable and carry the basic security headers", async () => {
  const s = await boot();
  try {
    const r = await fetch(s.base + "/health");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  } finally { await s.close(); }
});

test("public keys endpoint publishes only the public half", async () => {
  const s = await boot();
  try {
    const j = await (await fetch(s.base + "/v1/public-keys")).json();
    assert.equal(j.keys[0].kid, s.key.kid);
    assert.equal(j.keys[0].spki, s.key.spki);
    assert.ok(!JSON.stringify(j).includes("PRIVATE"));
  } finally { await s.close(); }
});

// ------------------------------------------------------------------ Developer Console

async function adminSession(base) {
  const r = await post(base, "/admin/api/login", { username: "owner", password: "A-long-admin-pass-1" });
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const { csrf } = await r.json();
  const call = (method, p, body, extra = {}) => fetch(base + "/admin/api" + p, { method, headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { cookie, csrf, call, setCookie: r.headers.get("set-cookie") };
}

test("console: serves its page with a strict content-security-policy, and the session cookie is HttpOnly + SameSite=Strict", async () => {
  const s = await boot();
  try {
    const page = await fetch(s.base + "/admin/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    const csp = page.headers.get("content-security-policy");
    assert.match(csp, /script-src 'self'/);
    assert.ok(!/unsafe-inline/.test(csp.replace(/style-src[^;]*;?/, "")), "no inline scripts");
    const html = await page.text();
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), "the page has no inline <script>");
    assert.equal((await fetch(s.base + "/admin/console.js")).status, 200);
    assert.equal((await fetch(s.base + "/admin/console.css")).status, 200);
    const a = await adminSession(s.base);
    assert.match(a.setCookie, /HttpOnly/);
    assert.match(a.setCookie, /SameSite=Strict/);
  } finally { await s.close(); }
});

test("console API: needs the session cookie; changes also need the CSRF token and a same-site Origin", async () => {
  const s = await boot();
  try {
    assert.equal((await fetch(s.base + "/admin/api/overview")).status, 401);
    const a = await adminSession(s.base);
    assert.equal((await a.call("GET", "/overview")).status, 200);
    const noCsrf = await fetch(s.base + "/admin/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json", Cookie: a.cookie }, body: JSON.stringify({ appActive: false }) });
    assert.equal(noCsrf.status, 403);
    const wrongCsrf = await a.call("PATCH", "/settings", { appActive: false }, { "X-CSRF-Token": "nope" });
    assert.equal(wrongCsrf.status, 403);
    const crossSite = await a.call("PATCH", "/settings", { appActive: false }, { Origin: "https://evil.example" });
    assert.equal(crossSite.status, 403);
    assert.equal(s.service.getSettings().appActive, true, "none of the refused requests changed anything");
    const sameSite = await a.call("PATCH", "/settings", { appActive: false }, { Origin: s.base });
    assert.equal(sameSite.status, 200);
    assert.equal(s.service.getSettings().appActive, false);
  } finally { await s.close(); }
});

test("console API: every management action from the brief works over HTTP", async () => {
  const s = await boot();
  try {
    const a = await adminSession(s.base);
    const dev = makeDevice();

    // create an account, sign in on a device, see it active + its device
    const created = await (await a.call("POST", "/accounts", { username: "tomas_test", password: "Other-pass-2", note: "beta tester" })).json();
    assert.equal(created.account.effectiveStatus, "active");
    const id = created.account.id;
    assert.equal((await clientLogin(s.base, dev, "tomas_test", "Other-pass-2")).status, 200);
    let ov = await (await a.call("GET", "/overview")).json();
    const row = ov.accounts.find((x) => x.id === id);
    assert.equal(row.online, true);
    assert.equal(row.device.label, "Test Mac");
    assert.equal(ov.counts.online, 1);

    // ban -> denied; unban -> allowed
    await a.call("POST", `/accounts/${id}/action`, { action: "ban" });
    assert.equal((await (await clientLogin(s.base, dev, "tomas_test", "Other-pass-2")).json()).code, "access_expired");
    await a.call("POST", `/accounts/${id}/action`, { action: "unban" });
    assert.equal((await clientLogin(s.base, dev, "tomas_test", "Other-pass-2")).status, 200);

    // revoke the device -> another Mac can take over
    assert.equal((await (await clientLogin(s.base, makeDevice("Mac 2"), "tomas_test", "Other-pass-2")).json()).code, "device_conflict");
    await a.call("POST", `/accounts/${id}/action`, { action: "revoke-device" });
    assert.equal((await clientLogin(s.base, makeDevice("Mac 2"), "tomas_test", "Other-pass-2")).status, 200);

    // change password, set expiry, force re-auth, edit note, rename
    assert.equal((await a.call("POST", `/accounts/${id}/password`, { password: "Third-pass-3" })).status, 200);
    assert.equal((await a.call("PATCH", `/accounts/${id}`, { expiresAt: Math.floor(Date.now() / 1000) + 86400, note: "extended", username: "tomas_renamed" })).status, 200);
    assert.equal((await a.call("POST", `/accounts/${id}/action`, { action: "force-reauth" })).status, 200);

    // settings, audit, delete
    assert.equal((await (await a.call("PATCH", "/settings", { unlimitedEnabled: false })).json()).settings.unlimitedEnabled, false);
    const audit = await (await a.call("GET", "/audit?limit=100")).json();
    const acts = audit.entries.map((e) => e.action);
    for (const want of ["account_create", "ban", "unban", "revoke-device", "password_change", "account_update", "force-reauth", "settings"]) assert.ok(acts.includes(want), `audit is missing ${want}`);
    assert.equal((await a.call("DELETE", `/accounts/${id}`)).status, 200);
    ov = await (await a.call("GET", "/overview")).json();
    assert.ok(!ov.accounts.some((x) => x.id === id));
  } finally { await s.close(); }
});

test("console API: nothing secret is ever sent to the browser", async () => {
  const s = await boot();
  try {
    const a = await adminSession(s.base);
    await clientLogin(s.base, makeDevice(), "rohan_test", "Test-pass-1");
    const text = await (await a.call("GET", "/overview")).text() + await (await a.call("GET", "/audit")).text();
    for (const secret of ["scrypt$", "password_hash", "device_pub", "Test-pass-1", "A-long-admin-pass-1", "PRIVATE KEY"]) assert.ok(!text.includes(secret), `leaked ${secret}`);
  } finally { await s.close(); }
});

test("console can be limited to chosen IPs or switched off entirely; both answer 404", async () => {
  const locked = await boot({ adminAllowedIps: ["203.0.113.50"] });
  try {
    assert.equal((await fetch(locked.base + "/admin/")).status, 404);
    assert.equal((await post(locked.base, "/admin/api/login", { username: "owner", password: "A-long-admin-pass-1" })).status, 404);
    assert.equal((await post(locked.base, "/v1/auth/challenge", {})).status, 200, "the client API is unaffected");
  } finally { await locked.close(); }
  const off = await boot({ adminEnabled: false });
  try { assert.equal((await fetch(off.base + "/admin/")).status, 404); } finally { await off.close(); }
});

test("console sign-in: wrong password is refused and repeated failures lock the sign-in", async () => {
  const s = await boot();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await post(s.base, "/admin/api/login", { username: "owner", password: "bad-password-" + i })).status, 401);
    assert.equal((await post(s.base, "/admin/api/login", { username: "owner", password: "A-long-admin-pass-1" })).status, 429);
  } finally { await s.close(); }
});
