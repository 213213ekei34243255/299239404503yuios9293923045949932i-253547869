"use strict";
// Jonah's local search relay (search-proxy.cjs): page -> 127.0.0.1:5589/api/search/* -> jonahbrowser.store.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { mountSearchProxy, fetchSearch, readSetting } = require("../../../search-proxy.cjs");

function fakeHttp(handler) {
  const calls = [];
  return { calls, get: async (url, opts) => { calls.push({ url, ...opts }); return handler({ url, ...opts }); } };
}
const GOOGLE_JSON = { items: [{ title: "Jonah", link: "https://jonahbrowser.com", displayLink: "jonahbrowser.com", snippet: "s" }] };

function withRoot(env) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-search-"));
  if (env !== undefined) fs.writeFileSync(path.join(root, ".env"), env);
  return root;
}

test("relay forwards the query to the proxy's /search/web with the shared secret from .env, and returns Google's JSON unchanged", async () => {
  const root = withRoot("GEMINI_API_KEY=unrelated\nJONAH_PROXY_KEY=s3cret\n");
  const http = fakeHttp(() => ({ status: 200, data: GOOGLE_JSON }));
  const r = await fetchSearch("web", "jonah browser", { root, http });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, GOOGLE_JSON);
  assert.equal(http.calls[0].url, "https://www.jonahbrowser.store/search/web");
  assert.deepEqual(http.calls[0].params, { q: "jonah browser" });
  assert.equal(http.calls[0].headers["X-Jonah-Key"], "s3cret");
  const img = await fetchSearch("images", "cats", { root, http });
  assert.equal(http.calls[1].url, "https://www.jonahbrowser.store/search/images");
  assert.equal(img.status, 200);
});

test("a wrong or missing secret (proxy 401) becomes a readable Google-shaped error, never a silent empty result", async () => {
  const noKey = withRoot("GEMINI_API_KEY=x\n");
  const http = fakeHttp(() => ({ status: 401, data: "<h1>Unauthorized</h1>" }));
  delete process.env.JONAH_PROXY_KEY;
  const a = await fetchSearch("web", "q", { root: noKey, http });
  assert.equal(a.status, 502);
  assert.match(a.body.error.message, /JONAH_PROXY_KEY/);
  assert.match(a.body.error.message, /\.env/);
  assert.equal(http.calls[0].headers["X-Jonah-Key"], undefined, "no header when no secret is configured");
  const b = await fetchSearch("web", "q", { root: withRoot("JONAH_PROXY_KEY=wrong\n"), http });
  assert.match(b.body.error.message, /rejected/);
});

test("proxy outage / bad upstream body / bad input are all reported in the error shape", async () => {
  const root = withRoot("");
  assert.match((await fetchSearch("web", "q", { root, http: fakeHttp(() => { throw new Error("ECONNREFUSED"); }) })).body.error.message, /unreachable: ECONNREFUSED/);
  assert.equal((await fetchSearch("web", "q", { root, http: fakeHttp(() => ({ status: 500, data: { error: { message: "Server is missing required environment variables: GOOGLE_API_KEY" } } })) })).body.error.message.startsWith("Server is missing"), true);
  assert.equal((await fetchSearch("web", "   ", { root, http: fakeHttp(() => ({})) })).status, 400);
  assert.equal((await fetchSearch("nope", "q", { root, http: fakeHttp(() => ({})) })).status, 404);
});

test("readSetting: environment wins, .env is read for exactly the requested name only", () => {
  const root = withRoot('export JONAH_PROXY_KEY="quoted value"\nOTHER=1\n');
  delete process.env.JONAH_PROXY_KEY;
  assert.equal(readSetting("JONAH_PROXY_KEY", root), "quoted value");
  assert.equal(readSetting("NOT_THERE", root), "");
  process.env.JONAH_PROXY_KEY = "from-env";
  assert.equal(readSetting("JONAH_PROXY_KEY", root), "from-env");
  delete process.env.JONAH_PROXY_KEY;
});

test("HTTP relay: file:// pages (origin null) are served, other websites are refused; static server never serves .env", async () => {
  const root = withRoot("JONAH_PROXY_KEY=topsecret\n");
  fs.writeFileSync(path.join(root, "search.html"), "<html>ok</html>");
  const http = fakeHttp(() => ({ status: 200, data: GOOGLE_JSON }));
  const app = express();
  mountSearchProxy(app, { root, http });
  app.use(express.static(root, { dotfiles: "deny" }));
  const server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/api/search/web?q=hello`, { headers: { Origin: "null" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "null");
    assert.deepEqual(await ok.json(), GOOGLE_JSON);

    const evil = await fetch(`${base}/api/search/web?q=hello`, { headers: { Origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    assert.equal(http.calls.length, 1, "a refused origin must not spend proxy quota");

    assert.equal((await fetch(`${base}/search.html`)).status, 200);
    const env = await fetch(`${base}/.env`);
    assert.ok(env.status === 403 || env.status === 404, `.env must not be served (got ${env.status})`);
    assert.ok(!(await env.text()).includes("topsecret"));
  } finally {
    server.close();
  }
});
