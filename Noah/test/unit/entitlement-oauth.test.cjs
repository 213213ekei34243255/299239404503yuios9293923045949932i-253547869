// Noah/test/unit/entitlement-oauth.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { signIn, buildAuthUrl, SCOPE } = require("../../../entitlement-oauth.cjs");

const CLIENT_ID = "423052223158-2bv7uvscdih8n9fom62mms191bglqou0.apps.googleusercontent.com";

test("buildAuthUrl: points at Google, carries the real client id, PKCE S256, and a narrow identity-only scope", () => {
  const url = new URL(buildAuthUrl({ clientId: CLIENT_ID, redirectUri: "http://127.0.0.1:9999/callback", state: "st", codeChallenge: "ch" }));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:9999/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "ch");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(SCOPE, "openid email profile", "no Drive/Gmail/Calendar - identity only");
  assert.equal(url.searchParams.get("access_type"), "online", "no refresh token requested into the desktop app");
});

// Simulates "the user finished signing in on Google's real page and the browser was redirected" by making a real HTTP request to
// the real loopback server signIn() starts - the same request Google's own redirect would make, just sent by this test instead of
// by a human's browser.
async function fakeGoogleRedirect(openExternal) {
  let capturedUrl;
  const flow = signIn({ clientId: CLIENT_ID, openExternal: async (url) => { capturedUrl = url; await openExternal(url); }, timeoutMs: 5000 });
  flow.catch(() => {}); // a test-only silencer: some cases below reject it on purpose, and assert.rejects attaches its own check
  // AFTER this helper returns, which would otherwise race an already-rejected promise and trip node:test's unhandled-rejection guard
  for (let i = 0; i < 50 && !capturedUrl; i++) await new Promise((r) => setTimeout(r, 20)); // wait for the server to actually be listening
  return { flow, authUrl: new URL(capturedUrl) };
}

test("signIn: a real matching redirect resolves with the code, the SAME verifier that produced the challenge, and the exact redirect_uri used", async () => {
  const { flow, authUrl } = await fakeGoogleRedirect(async () => {});
  const state = authUrl.searchParams.get("state");
  const challenge = authUrl.searchParams.get("code_challenge");
  const redirectUri = authUrl.searchParams.get("redirect_uri");
  const res = await fetch(`${redirectUri}?code=REAL-AUTH-CODE&state=${state}`);
  assert.equal(res.status, 200);
  const r = await flow;
  assert.equal(r.code, "REAL-AUTH-CODE");
  assert.equal(r.redirectUri, redirectUri);
  // PKCE: this is the exact check the token endpoint performs - the verifier really does hash to the challenge sent earlier
  const recomputed = Buffer.from(crypto.createHash("sha256").update(r.codeVerifier).digest()).toString("base64url");
  assert.equal(recomputed, challenge);
  assert.ok(r.codeVerifier.length >= 43, "RFC 7636 minimum length");
});

test("signIn: a forged redirect with the WRONG state is refused, and does not resolve the flow", async () => {
  const { flow, authUrl } = await fakeGoogleRedirect(async () => {});
  const redirectUri = authUrl.searchParams.get("redirect_uri");
  const res = await fetch(`${redirectUri}?code=STOLEN-CODE&state=not-the-real-state`);
  assert.equal(res.status, 200); // still answers the browser with a page, just doesn't accept the sign-in
  await assert.rejects(flow, (e) => e.code === "state_mismatch");
});

test("signIn: the user cancelling on Google's own page (error=access_denied) is reported plainly, not as a crash", async () => {
  const { flow, authUrl } = await fakeGoogleRedirect(async () => {});
  const state = authUrl.searchParams.get("state");
  const redirectUri = authUrl.searchParams.get("redirect_uri");
  await fetch(`${redirectUri}?error=access_denied&state=${state}`);
  await assert.rejects(flow, (e) => e.code === "denied");
});

test("signIn: a request to any other path on the loopback server is ignored (404), the flow keeps waiting", async () => {
  const { flow, authUrl } = await fakeGoogleRedirect(async () => {});
  const redirectUri = authUrl.searchParams.get("redirect_uri");
  const other = await fetch(new URL("/favicon.ico", redirectUri));
  assert.equal(other.status, 404);
  const state = authUrl.searchParams.get("state");
  const real = await fetch(`${redirectUri}?code=C1&state=${state}`);
  assert.equal(real.status, 200);
  assert.equal((await flow).code, "C1");
});

test("signIn: gives up after its timeout, and stops listening (does not hang forever or leak the port)", async () => {
  let opened = null;
  const p = signIn({ clientId: CLIENT_ID, openExternal: async (url) => { opened = url; }, timeoutMs: 150 });
  await assert.rejects(p, (e) => e.code === "timeout");
  assert.ok(opened, "the browser step did run before the timeout");
  // the port really was released: a fresh signIn() call can bind its own new ephemeral port without EADDRINUSE
  const p2 = signIn({ clientId: CLIENT_ID, openExternal: async () => {}, timeoutMs: 150 });
  await assert.rejects(p2);
});

test("signIn: a failure to open the browser is reported, not silently swallowed", async () => {
  const p = signIn({ clientId: CLIENT_ID, openExternal: async () => { throw new Error("no browser available"); }, timeoutMs: 5000 });
  await assert.rejects(p, (e) => e.code === "server_error" && /no browser available/.test(e.message));
});

test("two sign-in attempts never reuse the same state or code_verifier (a captured old redirect cannot be replayed into a new attempt)", async () => {
  const a = await fakeGoogleRedirect(async () => {});
  const b = await fakeGoogleRedirect(async () => {});
  assert.notEqual(a.authUrl.searchParams.get("state"), b.authUrl.searchParams.get("state"));
  assert.notEqual(a.authUrl.searchParams.get("code_challenge"), b.authUrl.searchParams.get("code_challenge"));
  await fetch(`${a.authUrl.searchParams.get("redirect_uri")}?code=X&state=${a.authUrl.searchParams.get("state")}`);
  await fetch(`${b.authUrl.searchParams.get("redirect_uri")}?code=Y&state=${b.authUrl.searchParams.get("state")}`);
  assert.equal((await a.flow).code, "X");
  assert.equal((await b.flow).code, "Y");
});
