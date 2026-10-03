// entitlement-oauth.cjs — "Sign in with Google" for the billing/entitlement system, replacing the old anonymous device-hash identity.
// Google's account id (the ID token's `sub`) is now the entitlement identity, so buying a plan and later reinstalling/logging back
// into the SAME Google account restores it - the point of this whole change.
//
// FLOW (the standard, Google-documented pattern for a native/desktop app - see developers.google.com/identity/protocols/oauth2/native-app):
//   1. This module starts a ONE-TIME local HTTP server on an unused loopback port and opens Google's consent page in the user's REAL
//      system browser (never an embedded/in-app browser window - Google's own policy disallows those for OAuth, and a real browser
//      is also what lets the user see and verify the actual accounts.google.com address instead of one Jonah could have drawn itself).
//   2. Google redirects back to http://127.0.0.1:<port>/callback?code=...&state=... - the loopback server is listening for exactly
//      that one request, checks `state` (anti-CSRF), and stops listening immediately after.
//   3. The authorization `code`, the PKCE `codeVerifier` and the exact `redirectUri` used are handed to entitlement-client.cjs, which
//      sends them to noahai.live. The CLIENT SECRET is never involved here and never reaches this file or the app bundle: Google's
//      token exchange (code -> tokens) and ID-token verification happen server-side, on noahai.live, using its own server-held secret.
//   4. PKCE (RFC 7636) is used regardless of where the exchange happens: it stops another process on this same machine from completing
//      the sign-in with a code it intercepted from the loopback redirect, since only the process holding the original `codeVerifier`
//      can complete it.
"use strict";
const crypto = require("crypto");
const http = require("http");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "openid email profile"; // identity only - no Drive, no Gmail, no Calendar: see the module header of entitlement-client.cjs

function buildAuthUrl({ clientId, redirectUri, state, codeChallenge, loginHint }) {
  const u = new URL(GOOGLE_AUTH_ENDPOINT);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("access_type", "online"); // no refresh token requested; the desktop app never wants to hold one directly
  u.searchParams.set("prompt", "select_account");
  if (loginHint) u.searchParams.set("login_hint", loginHint);
  return u.toString();
}

const CANCELLED_PAGE = (why) => `<!doctype html><meta charset="utf-8"><title>Jonah</title><body style="font:15px system-ui;background:#0f0f14;color:#ececf4;display:flex;height:100vh;align-items:center;justify-content:center"><p>${why} You can close this tab and go back to Jonah.</p></body>`;

/**
 * Runs one sign-in attempt end to end. Resolves with { code, codeVerifier, redirectUri } on success.
 * Rejects with an Error whose `.code` is one of: "denied" (the user cancelled on Google's page), "state_mismatch" (a forged/stale
 * redirect - refused), "timeout" (nothing arrived in time), "server_error" (the loopback server itself failed to start).
 *
 * `openExternal` is injected (Electron's shell.openExternal in the real app) so this can be tested without a real browser: a test
 * simply issues a real HTTP request to the real loopback server instead of a human clicking through Google's real page.
 */
function signIn({ clientId, openExternal, loginHint, timeoutMs = 180000, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const codeVerifier = b64u(crypto.randomBytes(32)); // 43 chars of base64url = within RFC 7636's 43-128 char requirement
    const codeChallenge = b64u(crypto.createHash("sha256").update(codeVerifier).digest());
    const state = b64u(crypto.randomBytes(16));
    let settled = false;
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); server.close(); if (err) reject(err); else resolve(value); };
    const timer = setTimeout(() => finish(Object.assign(new Error("Sign-in timed out."), { code: "timeout" })), timeoutMs);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const send = (body) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(body); };
      if (url.searchParams.get("state") !== state) {
        send(CANCELLED_PAGE("That sign-in link was not valid."));
        return finish(Object.assign(new Error("state mismatch"), { code: "state_mismatch" }));
      }
      const error = url.searchParams.get("error");
      if (error) {
        send(CANCELLED_PAGE("Sign-in was cancelled."));
        return finish(Object.assign(new Error(`Google reported: ${error}`), { code: "denied" }));
      }
      const code = url.searchParams.get("code");
      if (!code) { send(CANCELLED_PAGE("Sign-in did not complete.")); return finish(Object.assign(new Error("no code"), { code: "server_error" })); }
      send(`<!doctype html><meta charset="utf-8"><title>Jonah</title><body style="font:15px system-ui;background:#0f0f14;color:#ececf4;display:flex;height:100vh;align-items:center;justify-content:center"><p>Signed in. You can close this tab and go back to Jonah.</p></body>`);
      finish(null, { code, codeVerifier, redirectUri });
    });
    server.on("error", (e) => finish(Object.assign(new Error(`could not start the local sign-in listener: ${e.message}`), { code: "server_error" })));

    let redirectUri;
    server.listen(0, "127.0.0.1", async () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      const authUrl = buildAuthUrl({ clientId, redirectUri, state, codeChallenge, loginHint });
      try { await openExternal(authUrl); log("opened the system browser for Google sign-in"); }
      catch (e) { finish(Object.assign(new Error(`could not open the browser: ${e.message}`), { code: "server_error" })); }
    });
  });
}

module.exports = { signIn, buildAuthUrl, SCOPE };
