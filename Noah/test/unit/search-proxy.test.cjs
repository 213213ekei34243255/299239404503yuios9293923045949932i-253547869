"use strict";
// Jonah's local search relay (search-proxy.cjs): page -> 127.0.0.1:5589/api/search/* -> jonahbrowser.store.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const { mountSearchProxy, fetchSearch, setLicenseTokenProvider, readSetting } = require("../../../search-proxy.cjs");

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

// ============================ backing off after failures (reported: a failing search service - HTTP 502 on every /search/* - was hit
// ~20 times per page visited, each query twice, by the Trust Engine; that traffic can only make a quota problem worse)

const { SearchBreaker } = require("../../../search-proxy.cjs");
const RES_502 = { status: 502, data: "error code: 502" };

test("BREAKER: after 3 failures in a row the service is left alone - later calls answer at once, without any request, and say why", async () => {
  const root = withRoot("JONAH_PROXY_KEY=k\n");
  let t = 1_000_000;
  const http = fakeHttp(() => RES_502);
  const opts = { root, http, now: () => t };
  for (let i = 0; i < 3; i++) assert.equal((await fetchSearch("web", "q" + i, opts)).status, 502);
  assert.equal(http.calls.length, 3);
  const paused = await fetchSearch("web", "another", opts);
  assert.equal(http.calls.length, 3, "no request was made while paused");
  assert.equal(paused.status, 502);
  assert.equal(paused.paused, true);
  assert.match(paused.body.error.message, /HTTP 502/, "the real cause is still named");
  assert.match(paused.body.error.message, /paused for \d+s/);
});

test("BREAKER: the first call after the pause is a probe; success resets everything, another failure pauses for longer", async () => {
  const root = withRoot("JONAH_PROXY_KEY=k\n");
  let t = 1_000_000;
  let up = false;
  const http = fakeHttp(() => (up ? { status: 200, data: GOOGLE_JSON } : RES_502));
  const opts = { root, http, now: () => t };
  for (let i = 0; i < 3; i++) await fetchSearch("web", "q", opts);          // pause of 30 s
  t += 31_000;
  await fetchSearch("web", "probe", opts);                                  // probe fails: pause doubles to 60 s
  assert.equal(http.calls.length, 4);
  t += 31_000;
  assert.equal((await fetchSearch("web", "still paused", opts)).paused, true, "31 s later it is still inside the doubled pause");
  assert.equal(http.calls.length, 4);
  t += 31_000;
  up = true;
  assert.equal((await fetchSearch("web", "back", opts)).status, 200, "the service recovered: the probe gets through");
  const again = await fetchSearch("web", "normal", opts);
  assert.equal(again.status, 200);
  assert.equal(http.calls.length, 6, "and everything is back to normal - no lingering pause");
});

test("BREAKER: bad input (400/404) is not a service failure, and a success in between resets the count", async () => {
  const root = withRoot("JONAH_PROXY_KEY=k\n");
  const http = fakeHttp(() => RES_502);
  for (let i = 0; i < 5; i++) { await fetchSearch("web", "   ", { root, http }); await fetchSearch("nope", "q", { root, http }); }
  assert.equal(http.calls.length, 0, "validation errors never reach the service, nor count against it");
  let ok = false;
  const flaky = fakeHttp(() => (ok ? { status: 200, data: GOOGLE_JSON } : RES_502));
  await fetchSearch("web", "a", { root, http: flaky }); await fetchSearch("web", "b", { root, http: flaky });
  ok = true;
  await fetchSearch("web", "c", { root, http: flaky });
  ok = false;
  await fetchSearch("web", "d", { root, http: flaky }); await fetchSearch("web", "e", { root, http: flaky });
  assert.equal(flaky.calls.length, 5, "2 failures + success + 2 failures: never 3 in a row, so never paused");
});

test("BREAKER: a rejected key (401) counts too - asking again with the same wrong key cannot help", async () => {
  const root = withRoot("JONAH_PROXY_KEY=wrong\n");
  const http = fakeHttp(() => ({ status: 401, data: "<h1>Unauthorized</h1>" }));
  for (let i = 0; i < 3; i++) await fetchSearch("web", "q", { root, http });
  const r = await fetchSearch("web", "q", { root, http });
  assert.equal(http.calls.length, 3);
  assert.equal(r.paused, true);
});

// ============================ Google's own results page (google-serp.cjs, registered by main.cjs) as the first choice for web search

const { setWebSearchBackend } = require("../../../search-proxy.cjs");
const PAGE_ITEMS = [{ title: "Python", link: "https://www.python.org/", snippet: "Official site", displayLink: "www.python.org" }];

test("GOOGLE PAGE: when registered, web searches read Google's results page and never touch the proxy", async (t) => {
  t.after(() => setWebSearchBackend(null));
  const asked = [];
  setWebSearchBackend(async (q) => { asked.push(q); return { items: PAGE_ITEMS }; });
  const http = fakeHttp(() => { throw new Error("the proxy must not be called"); });
  const r = await fetchSearch("web", "  python  ", { root: withRoot("JONAH_PROXY_KEY=k\n"), http });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items, PAGE_ITEMS, "same Google-style shape the Trust Engine and the AI chat already read");
  assert.deepEqual(asked, ["python"]);
  assert.equal(http.calls.length, 0);
});

test("GOOGLE PAGE: a robot check (or any failure) falls back to the proxy; if both fail, the message names Google's reason first", async (t) => {
  t.after(() => setWebSearchBackend(null));
  const captcha = Object.assign(new Error("Google is asking to confirm you're not a robot. Open google.com in a Jonah tab and complete the check"), { code: "captcha" });
  setWebSearchBackend(async () => { throw captcha; });
  const root = withRoot("JONAH_PROXY_KEY=k\n");
  const ok = await fetchSearch("web", "python", { root, http: fakeHttp(() => ({ status: 200, data: GOOGLE_JSON })) });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, GOOGLE_JSON, "the backup answered");
  const down = await fetchSearch("web", "python", { root, http: fakeHttp(() => ({ status: 503, data: { error: { message: "Search request failed: upstream HTTP 429 - Queries per day" } } })) });
  assert.equal(down.status, 502);
  assert.match(down.body.error.message, /^Google is asking to confirm you're not a robot/);
  assert.match(down.body.error.message, /backup search: Search request failed: upstream HTTP 429/);
});

test("GOOGLE PAGE: images, empty queries and unknown kinds keep their old behaviour", async (t) => {
  t.after(() => setWebSearchBackend(null));
  setWebSearchBackend(async () => { throw new Error("must not be used"); });
  const root = withRoot("JONAH_PROXY_KEY=k\n");
  const http = fakeHttp(() => ({ status: 200, data: GOOGLE_JSON }));
  assert.equal((await fetchSearch("images", "cats", { root, http })).status, 200);
  assert.equal(http.calls[0].url, "https://www.jonahbrowser.store/search/images");
  assert.equal((await fetchSearch("web", "   ", { root, http })).status, 400);
  assert.equal((await fetchSearch("nope", "q", { root, http })).status, 404);
});

test("SearchBreaker: the pause doubles up to a ceiling", () => {
  const b = new SearchBreaker({ threshold: 3, baseMs: 1000, maxMs: 4000 });
  const waits = [];
  for (let i = 0; i < 7; i++) { b.fail(0, "x"); waits.push(b.until); }
  assert.deepEqual(waits, [0, 0, 1000, 2000, 4000, 4000, 4000]);
});

// ============================ eBay through jonahbrowser.store (home.html's Fashion / Toys panels; the eBay keys live on the server)

const { fetchShopping } = require("../../../search-proxy.cjs");
const EBAY_JSON = { total: 1, itemSummaries: [{ itemId: "v1|1|0", title: "Dress", price: { value: "20.00", currency: "USD" }, itemWebUrl: "https://www.ebay.com/itm/1" }] };

test("SHOPPING: forwards only known parameters to /shopping/ebay with the shared secret, and returns eBay's JSON unchanged", async () => {
  const http = fakeHttp(() => ({ status: 200, data: EBAY_JSON }));
  const r = await fetchShopping({ q: " dress ", category_ids: "15724", limit: "12", sort: "newlyListed", evil: "x", apikey: "steal" }, { root: withRoot("JONAH_PROXY_KEY=s3cret\n"), http });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, EBAY_JSON);
  assert.equal(http.calls[0].url, "https://www.jonahbrowser.store/shopping/ebay");
  assert.deepEqual(http.calls[0].params, { q: "dress", category_ids: "15724", limit: "12", sort: "newlyListed" });
  assert.equal(http.calls[0].headers["X-Jonah-Key"], "s3cret");
});

test("SHOPPING: the server's reason is passed on; a server without eBay yet (404), a wrong key and an outage are explained", async () => {
  const root = withRoot("JONAH_PROXY_KEY=k\n");
  const notConfigured = await fetchShopping({ q: "toy" }, { root, http: fakeHttp(() => ({ status: 503, data: { error: { message: "eBay search request (eBay sign-in) failed: upstream HTTP 401 - invalid_client" } } })) });
  assert.equal(notConfigured.status, 502);
  assert.match(notConfigured.body.error.message, /invalid_client/);
  assert.match((await fetchShopping({ q: "toy" }, { root, http: fakeHttp(() => ({ status: 404, data: "<h1>Not Found</h1>" })) })).body.error.message, /no eBay search yet/);
  assert.match((await fetchShopping({ q: "toy" }, { root, http: fakeHttp(() => ({ status: 401, data: "" })) })).body.error.message, /rejected JONAH_PROXY_KEY/);
  assert.match((await fetchShopping({ q: "toy" }, { root, http: fakeHttp(() => { throw new Error("ECONNREFUSED"); }) })).body.error.message, /unreachable/);
  const bad = await fetchShopping({ q: "toy", sort: "cheapest" }, { root, http: fakeHttp(() => ({ status: 400, data: { error: { message: "'sort' must be one of: ..." } } })) });
  assert.equal(bad.status, 400);
  assert.equal((await fetchShopping({ q: "  " }, { root, http: fakeHttp(() => ({})) })).status, 400);
});

test("SHOPPING relay: Jonah's pages are served, other websites are refused before anything is sent", async () => {
  const root = withRoot("JONAH_PROXY_KEY=k\n");
  const http = fakeHttp(() => ({ status: 200, data: EBAY_JSON }));
  const app = express();
  mountSearchProxy(app, { root, http });
  const server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/api/shopping/ebay?q=dress&category_ids=15724`, { headers: { Origin: "null" } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), EBAY_JSON);
    const evil = await fetch(`${base}/api/shopping/ebay?q=dress`, { headers: { Origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    assert.equal(http.calls.length, 1);
  } finally {
    server.close();
  }
});

// ============================ news through jonahbrowser.store (main.cjs 'get-news'; the NewsAPI key lives on the server)

const { fetchNews } = require("../../../search-proxy.cjs");
const NEWS_JSON = { status: "ok", totalResults: 1, articles: [{ title: "Headline", source: { name: "The Hindu" }, url: "https://thehindu.com/a" }] };

test("NEWS: asks /news/headlines with the shared secret and paging, and returns NewsAPI's JSON unchanged", async () => {
  const http = fakeHttp(() => ({ status: 200, data: NEWS_JSON }));
  const r = await fetchNews({ country: "IN", page: 2, pageSize: 12 }, { root: withRoot("JONAH_PROXY_KEY=s3cret\n"), http });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, NEWS_JSON);
  assert.equal(http.calls[0].url, "https://www.jonahbrowser.store/news/headlines");
  assert.deepEqual(http.calls[0].params, { country: "in", page: 2, pageSize: 12 });
  assert.equal(http.calls[0].headers["X-Jonah-Key"], "s3cret");
  await fetchNews({ country: "../x", page: "abc", pageSize: 5000 }, { root: withRoot("JONAH_PROXY_KEY=k\n"), http });
  assert.deepEqual(http.calls[1].params, { country: "in", page: 1, pageSize: 100 }, "odd input is made safe, not forwarded");
});

test("NEWS: the server's reason, a wrong key and an outage come back as readable errors (main.cjs then shows the last good news)", async () => {
  const root = withRoot("JONAH_PROXY_KEY=k\n");
  const limited = await fetchNews({}, { root, http: fakeHttp(() => ({ status: 503, data: { error: { message: "News request failed: upstream HTTP 429 - You have made too many requests recently.", upstream_status: 429 } } })) });
  assert.equal(limited.status, 502);
  assert.match(limited.body.error.message, /too many requests/);
  assert.match((await fetchNews({}, { root, http: fakeHttp(() => ({ status: 401, data: "" })) })).body.error.message, /rejected JONAH_PROXY_KEY/);
  assert.match((await fetchNews({}, { root, http: fakeHttp(() => { throw new Error("ETIMEDOUT"); }) })).body.error.message, /unreachable: ETIMEDOUT/);
});

// ------------------------------------------------------------------ developer access: the token goes to the licence server's origin only

test("a signed-in app sends its developer token to jonahbrowser.store, fresh on every request, next to the shared secret", async () => {
  const root = withRoot("JONAH_PROXY_KEY=s3cret\n");
  const http = fakeHttp(() => ({ status: 200, data: GOOGLE_JSON }));
  let current = "token-one";
  setLicenseTokenProvider(() => current, "https://www.jonahbrowser.store");
  try {
    await fetchSearch("web", "a", { root, http });
    current = "token-two"; // renewed a minute later
    await fetchSearch("web", "b", { root, http });
    await fetchNews({}, { root, http });
    assert.equal(http.calls[0].headers["X-Jonah-License"], "token-one");
    assert.equal(http.calls[1].headers["X-Jonah-License"], "token-two");
    assert.equal(http.calls[2].headers["X-Jonah-License"], "token-two", "news carries it too");
    assert.equal(http.calls[0].headers["X-Jonah-Key"], "s3cret", "the shared secret is unchanged");
  } finally { setLicenseTokenProvider(null); }
});

test("the token is NEVER sent to any other address, e.g. a JONAH_SEARCH_PROXY override", async () => {
  const root = withRoot("JONAH_PROXY_KEY=s3cret\nJONAH_SEARCH_PROXY=https://evil.example.com\n");
  const http = fakeHttp(() => ({ status: 200, data: GOOGLE_JSON }));
  setLicenseTokenProvider(() => "secret-token", "https://www.jonahbrowser.store");
  try {
    await fetchSearch("web", "a", { root, http });
    assert.match(http.calls[0].url, /^https:\/\/evil\.example\.com\//);
    assert.equal(http.calls[0].headers["X-Jonah-License"], undefined);
    assert.equal(http.calls[0].headers["X-Jonah-Key"], "s3cret", "(the pre-existing behaviour for the shared secret is unchanged)");
  } finally { setLicenseTokenProvider(null); }
});

test("with no token (not signed in, expired, or provider throws) the relay behaves exactly as before", async () => {
  const root = withRoot("JONAH_PROXY_KEY=s3cret\n");
  const http = fakeHttp(() => ({ status: 200, data: GOOGLE_JSON }));
  await fetchSearch("web", "a", { root, http });
  assert.equal(http.calls[0].headers["X-Jonah-License"], undefined, "no provider set");
  setLicenseTokenProvider(() => null, "https://www.jonahbrowser.store");
  await fetchSearch("web", "b", { root, http });
  assert.equal(http.calls[1].headers["X-Jonah-License"], undefined, "the client has no valid token");
  setLicenseTokenProvider(() => { throw new Error("boom"); }, "https://www.jonahbrowser.store");
  try {
    const r = await fetchSearch("web", "c", { root, http });
    assert.equal(r.status, 200, "a failing provider never breaks search");
    assert.equal(http.calls[2].headers["X-Jonah-License"], undefined);
  } finally { setLicenseTokenProvider(null); }
});
