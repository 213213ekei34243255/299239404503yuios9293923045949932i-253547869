// jonah-account.js - the Jonah account for Jonah on Chromium (Electron: entitlement-client.cjs + entitlement-oauth.cjs +
// entitlement-device.cjs). Signing in gives Noah's web agent its brain: noahai.live (/api/llm/step), exactly as in Electron Jonah.
//
// Sign-in: Google's own page opens in a normal Jonah tab (the user signs in there themselves; Jonah never sees or types the
// password). Same Google client, PKCE and loopback redirect (http://127.0.0.1:<port>/callback) as Electron; instead of a local
// server, Jonah reads the code from that redirect address and closes the tab. noahai.live exchanges the code (its secret never
// reaches the browser) and binds this device's public key. Every later call is signed with the device's Ed25519 key
// (X-Jonah-Device / -Timestamp / -Signature over method, path, time, account and body), like Electron.
// Differences from Electron, said plainly: the private key is a non-exportable browser key (not the Windows keychain), and the
// device id is a random id made once for this Jonah profile (a browser cannot read Windows' machine id).
(function () {
  "use strict";
  const BASE = "https://www.noahai.live";
  const CLIENT_ID = "423052223158-2bv7uvscdih8n9fom62mms191bglqou0.apps.googleusercontent.com";
  const NAMESPACE = "jonah-device-v1:";
  const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

  // ---- device key, kept in IndexedDB (the private key can be used but never exported)
  const db = () => new Promise((res, rej) => { const r = indexedDB.open("jonah-account", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const idb = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction("kv", mode); const out = fn(t.objectStore("kv")); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); };
  let device = null;
  async function getDevice() {
    if (device) return device;
    let rec = await idb("readonly", (s) => s.get("device"));
    if (!rec) {
      const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
      const pub = b64u(await crypto.subtle.exportKey("raw", pair.publicKey));
      rec = { privateKey: pair.privateKey, pub, deviceHash: hex(await sha256(NAMESPACE + crypto.randomUUID())) };
      await idb("readwrite", (s) => s.put(rec, "device"));
    }
    device = rec;
    return device;
  }

  // ---- signed-in account (the server's accountId), remembered in this profile
  let accountId = null;
  const ready = chrome.storage.local.get("jonahAccount").then((r) => { accountId = (r.jonahAccount && r.jonahAccount.accountId) || null; });

  async function signedHeaders(method, path, raw = "") {
    await ready;
    if (!accountId) return {};
    const dev = await getDevice();
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, dev.privateKey, new TextEncoder().encode(`${method}\n${path}\n${ts}\n${accountId}\n${raw}`));
    return { "X-Jonah-Device": accountId, "X-Jonah-Timestamp": ts, "X-Jonah-Signature": b64u(sig) };
  }

  let signing = null;
  function signIn() {
    if (!signing) signing = doSignIn().finally(() => { signing = null; });
    return signing;
  }
  async function doSignIn() {
    const dev = await getDevice();
    const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64u(await sha256(verifier));
    const state = b64u(crypto.getRandomValues(new Uint8Array(16)));
    const port = 49152 + Math.floor(Math.random() * 16000);
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for (const [k, v] of Object.entries({ client_id: CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state, code_challenge: challenge, code_challenge_method: "S256", access_type: "online", prompt: "select_account" })) u.searchParams.set(k, v);
    const tab = await chrome.tabs.create({ url: u.href, active: true });
    const granted = await new Promise((resolve) => {
      const done = (val) => { chrome.tabs.onUpdated.removeListener(onUpd); chrome.tabs.onRemoved.removeListener(onRem); clearTimeout(timer); resolve(val); };
      const onUpd = (id, change) => {
        if (id !== tab.id || !change.url || !change.url.startsWith(redirectUri)) return;
        const q = new URL(change.url).searchParams;
        chrome.tabs.remove(tab.id).catch(() => {});
        if (q.get("state") !== state) return done({ error: "state_mismatch" });
        done(q.get("code") ? { code: q.get("code") } : { error: q.get("error") || "cancelled" });
      };
      const onRem = (id) => { if (id === tab.id) done({ error: "cancelled" }); };
      const timer = setTimeout(() => done({ error: "timeout" }), 5 * 60 * 1000);
      chrome.tabs.onUpdated.addListener(onUpd);
      chrome.tabs.onRemoved.addListener(onRem);
    });
    if (!granted.code) return { ok: false, reason: granted.error };
    const r = await fetch(BASE + "/api/auth/google/exchange", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit", cache: "no-store",
      body: JSON.stringify({ code: granted.code, codeVerifier: verifier, redirectUri, publicKey: dev.pub, deviceHash: dev.deviceHash }),
    }).catch(() => null);
    if (!r) return { ok: false, reason: "server_unreachable" };
    const j = await r.json().catch(() => null);
    if (r.status !== 200 || !j || typeof j.accountId !== "string" || !j.accountId) return { ok: false, reason: (j && (j.error || j.reason)) || "status " + r.status };
    accountId = j.accountId;
    await chrome.storage.local.set({ jonahAccount: { accountId, at: Date.now() } });
    return { ok: true, accountId };
  }
  async function signOut() { accountId = null; await chrome.storage.local.remove("jonahAccount"); }

  window.JonahAccount = { ready, signIn, signOut, signedHeaders, isSignedIn: () => !!accountId, accountId: () => accountId, baseURL: BASE };
})();
