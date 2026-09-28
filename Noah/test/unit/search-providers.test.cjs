// Noah/test/unit/search-providers.test.cjs
//
// The official search-API path. These use a stand-in HTTP client that answers in each service's DOCUMENTED format, so they prove Jonah's
// side (the request it makes, mapping the reply, every error, and WHICH searches may use the API). They do NOT prove the live services
// answer that way - that needs a real key (see the honest-status note in search-providers.cjs).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { searchViaProvider, configuredProvider, SearchProviderError } = require("../../../search-providers.cjs");
const { fetchSearch, setWebSearchBackend } = require("../../../search-proxy.cjs");

function fakeHttp(reply) {
  const calls = [];
  return {
    calls,
    post: async (url, body, cfg) => { calls.push({ method: "POST", url, body, cfg }); const r = await reply(); if (r instanceof Error) throw r; return r; },
    get: async (url, cfg) => { calls.push({ method: "GET", url, cfg }); const r = await reply(); if (r instanceof Error) throw r; return r; },
  };
}
const settings = (map) => (name) => map[name] || "";

const SERPER_OK = { status: 200, data: { organic: [
  { title: "Durupinar formation - Wikipedia", link: "https://en.wikipedia.org/wiki/Durupinar_formation", snippet: "The Durupinar site is a boat-shaped formation...", position: 1 },
  { title: "Researchers drill at 'Noah's Ark' site", link: "https://nypost.com/2026/09/22/drilling", snippet: "Drilling has begun.", position: 2 },
  { title: "no link result", snippet: "dropped" },
  { title: "javascript link", link: "javascript:alert(1)", snippet: "dropped" },
] } };
const BRAVE_OK = { status: 200, data: { web: { results: [
  { title: "Noah&#x27;s Ark - <strong>Latest</strong> findings", url: "https://www.bbc.com/news/ark", description: "New <strong>lab</strong> results &amp; analysis" },
  { title: "Second", url: "https://example.org/x", description: "d" },
  { title: "no url" },
] } } };

test("no key configured: nothing is tried, the caller carries on as before (null, not an error)", async () => {
  const http = fakeHttp(() => SERPER_OK);
  assert.equal(await searchViaProvider("q", { readSetting: settings({}), http }), null);
  assert.equal(http.calls.length, 0);
  assert.equal(configuredProvider(settings({})), null);
});

test("Serper: the request is a POST with the key in X-API-KEY and the query in the body; the reply maps to Jonah's result shape", async () => {
  const http = fakeHttp(() => SERPER_OK);
  const r = await searchViaProvider("Noahs ark scientists", { readSetting: settings({ SERPER_API_KEY: "sk-test" }), http });
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].method, "POST");
  assert.equal(http.calls[0].url, "https://google.serper.dev/search");
  assert.equal(http.calls[0].body.q, "Noahs ark scientists");
  assert.equal(http.calls[0].cfg.headers["X-API-KEY"], "sk-test");
  assert.equal(r.source, "serper");
  assert.equal(r.items.length, 2, "results without an http(s) link are dropped, including a javascript: one");
  assert.deepEqual(r.items[0], { title: "Durupinar formation - Wikipedia", link: "https://en.wikipedia.org/wiki/Durupinar_formation", snippet: "The Durupinar site is a boat-shaped formation...", displayLink: "en.wikipedia.org" });
});

test("Brave: GET with the key in X-Subscription-Token; markup and entities are stripped from titles and snippets", async () => {
  const http = fakeHttp(() => BRAVE_OK);
  const r = await searchViaProvider("Noahs ark", { readSetting: settings({ BRAVE_SEARCH_API_KEY: "BSA-test" }), http });
  assert.equal(http.calls[0].method, "GET");
  assert.equal(http.calls[0].url, "https://api.search.brave.com/res/v1/web/search");
  assert.equal(http.calls[0].cfg.params.q, "Noahs ark");
  assert.equal(http.calls[0].cfg.params.safesearch, "moderate");
  assert.equal(http.calls[0].cfg.headers["X-Subscription-Token"], "BSA-test");
  assert.equal(r.source, "brave");
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].title, "Noah's Ark - Latest findings");
  assert.equal(r.items[0].snippet, "New lab results & analysis");
  assert.equal(r.items[0].displayLink, "bbc.com");
});

test("when both keys exist, Serper is used first (one provider per search, never both)", async () => {
  const http = fakeHttp(() => SERPER_OK);
  const r = await searchViaProvider("q", { readSetting: settings({ SERPER_API_KEY: "a", BRAVE_SEARCH_API_KEY: "b" }), http });
  assert.equal(r.source, "serper");
  assert.equal(http.calls.length, 1);
});

test("every failure is a typed SearchProviderError the caller can act on", async () => {
  const read = settings({ SERPER_API_KEY: "k" });
  const cases = [
    [{ status: 401, data: {} }, "auth"], [{ status: 403, data: {} }, "auth"], [{ status: 429, data: {} }, "quota"], [{ status: 402, data: {} }, "quota"],
    [{ status: 500, data: {} }, "http"], [{ status: 200, data: { organic: [] } }, "empty"], [{ status: 200, data: {} }, "empty"], [new Error("ECONNRESET"), "network"],
  ];
  for (const [reply, code] of cases) {
    await assert.rejects(searchViaProvider("q", { readSetting: read, http: fakeHttp(() => reply) }), (e) => e instanceof SearchProviderError && e.code === code, `${reply.status || reply.message} -> ${code}`);
  }
});

// ------------------------------------------------------------------ who may use it (through fetchSearch)

function rootWithEnv(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-sp-"));
  fs.writeFileSync(path.join(dir, ".env"), text);
  return dir;
}
const GOOGLE_ITEMS = [{ title: "from google's page", link: "https://example.com/g", snippet: "", displayLink: "example.com" }];

test("a search a PERSON waits on (priority) uses the API and never touches Google's page", async () => {
  let googleCalls = 0;
  setWebSearchBackend(async () => { googleCalls++; return { items: GOOGLE_ITEMS }; });
  try {
    const r = await fetchSearch("web", "noahs ark", { root: rootWithEnv("SERPER_API_KEY=k\n"), priority: true, providerHttp: fakeHttp(() => SERPER_OK) });
    assert.equal(r.status, 200);
    assert.equal(r.body.jonah.source, "serper");
    assert.equal(r.body.items[0].displayLink, "en.wikipedia.org");
    assert.equal(googleCalls, 0);
  } finally { setWebSearchBackend(null); }
});

test("a BACKGROUND search (the Trust Engine's) never uses the API, so it cannot use up the quota", async () => {
  const http = fakeHttp(() => SERPER_OK);
  setWebSearchBackend(async () => ({ items: GOOGLE_ITEMS }));
  try {
    const r = await fetchSearch("web", "some site reviews", { root: rootWithEnv("SERPER_API_KEY=k\n"), providerHttp: http });
    assert.equal(r.body.jonah.source, "google-results-page");
    assert.equal(http.calls.length, 0, "the API was not called at all");
  } finally { setWebSearchBackend(null); }
});

test("if the API fails (bad key, quota, network) the search carries on to Google's page - and says so in the log", async () => {
  const logs = [];
  setWebSearchBackend(async () => ({ items: GOOGLE_ITEMS }));
  try {
    const r = await fetchSearch("web", "noahs ark", { root: rootWithEnv("SERPER_API_KEY=k\n"), priority: true, providerHttp: fakeHttp(() => ({ status: 429, data: {} })), log: (...a) => logs.push(a.join(" ")) });
    assert.equal(r.status, 200);
    assert.equal(r.body.jonah.source, "google-results-page");
    assert.ok(logs.some((l) => /search API: quota/.test(l)), logs.join(" | "));
  } finally { setWebSearchBackend(null); }
});

test("no key in .env: a priority search behaves exactly as it always did", async () => {
  const http = fakeHttp(() => SERPER_OK);
  setWebSearchBackend(async () => ({ items: GOOGLE_ITEMS }));
  try {
    const r = await fetchSearch("web", "noahs ark", { root: rootWithEnv("SOMETHING_ELSE=1\n"), priority: true, providerHttp: http });
    assert.equal(r.body.jonah.source, "google-results-page");
    assert.equal(http.calls.length, 0);
  } finally { setWebSearchBackend(null); }
});
