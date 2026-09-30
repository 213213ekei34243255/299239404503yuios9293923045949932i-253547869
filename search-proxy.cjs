// search-proxy.cjs
//
// Local relay from Jonah's own pages (search.html, home.html) to the Jonah search proxy that holds the Google
// Custom Search credentials server-side (https://www.jonahbrowser.store, see its /search/web and /search/images).
//
// Why a relay instead of calling the proxy from the page: the proxy demands a shared-secret header
// (X-Jonah-Key). Putting that in search.html would ship it in a file the app serves to every page. Here it is read
// from the environment / the project's .env (JONAH_PROXY_KEY) in the main process and never reaches a page.
//
//   GET http://127.0.0.1:5589/api/search/web?q=...
//   GET http://127.0.0.1:5589/api/search/images?q=...
//
// Responses are Google Custom Search JSON, unchanged (that is what the proxy returns), so callers keep using
// `data.items`. Failures come back in Google's own error shape ({ error: { message } }) with a readable message.

"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { searchViaProvider } = require("./search-providers.cjs");

const DEFAULT_BASE = "https://www.jonahbrowser.store";

// Developer access: once the app is signed in, its short-lived token goes to the search server in X-Jonah-License, and the server lifts the
// rate limit for it. The token is only ever sent to the licence server's own origin (never to a JONAH_SEARCH_PROXY override), and it is read
// fresh for every request because it is renewed every minute. Without a token nothing is added and the relay behaves exactly as before.
let licenseToken = { get: null, origin: "" };
function setLicenseTokenProvider(get, origin) { licenseToken = { get: typeof get === "function" ? get : null, origin: String(origin || "") }; }
function upstreamHeaders(key, base) {
  const headers = key ? { "X-Jonah-Key": key } : {};
  try {
    if (licenseToken.get && licenseToken.origin && new URL(base).origin === licenseToken.origin) {
      const token = licenseToken.get();
      if (token) headers["X-Jonah-License"] = token;
    }
  } catch (_) { /* no token this time */ }
  return headers;
}
const KINDS = new Set(["web", "images"]);
// file:// pages report the origin "null"; Jonah's own UI server is 127.0.0.1:5589. Other web pages get nothing.
const ALLOWED_ORIGINS = new Set(["null", "http://127.0.0.1:5589", "http://localhost:5589"]);

/** One value from process.env or the project's .env (only the requested name is ever read from the file). */
function readSetting(name, root) {
  if (process.env[name]) return process.env[name].trim();
  try {
    const text = fs.readFileSync(path.join(root, ".env"), "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim().replace(/^set\s+/i, "").replace(/^export\s+/, "");
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m || m[1] !== name) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  } catch (_) {
    /* no .env */
  }
  return "";
}

/**
 * Ask the proxy. Always resolves { status, body }: status 200 with Google's JSON on success, otherwise 4xx/5xx with a
 * body in Google's error shape ({ error: { message } }).
 * @param {"web"|"images"} kind
 * @param {string} query
 * @param {{ root?: string, log?: (...a:any[]) => void, http?: { get: Function } }} [opts]
 */
// ------------------------------------------------------------------------------------------------ backing off after failures
//
// A failing search service used to be hammered: each page visited fired ~20 requests at it (the Trust Engine's review queries, each
// retried once), all failing with HTTP 502 - and if the cause is a small daily Google quota, that traffic is what keeps it empty. After
// `threshold` failures in a row the service is left alone for a while (30 s, doubling to 5 min); the first request after the pause is
// a probe, and one success resets everything. The answer during a pause is immediate and says so.
class SearchBreaker {
  constructor({ threshold = 3, baseMs = 30_000, maxMs = 300_000 } = {}) {
    Object.assign(this, { threshold, baseMs, maxMs, failures: 0, until: 0, lastMessage: "Search proxy is not responding" });
  }
  blocked(now) { return now < this.until; }
  ok() { this.failures = 0; this.until = 0; }
  fail(now, message) {
    this.failures++;
    this.lastMessage = String(message || this.lastMessage);
    if (this.failures >= this.threshold) this.until = now + Math.min(this.baseMs * 2 ** (this.failures - this.threshold), this.maxMs);
  }
}
const breakers = new WeakMap(); // one per HTTP client, so the real axios shares one and a test's fake client has its own
const breakerFor = (http) => {
  if (!breakers.has(http)) breakers.set(http, new SearchBreaker());
  return breakers.get(http);
};

// ------------------------------------------------------------------------------------------------ Google's own results page
//
// When Jonah is running, main.cjs registers google-serp.cjs here: web searches (Trust Engine, AI chat, the search-google IPC) then read
// Google's real results page first, and the jonahbrowser.store proxy (Google's Custom Search API) is only the backup - used when Google
// shows its robot check or cannot be reached. Outside Electron (unit tests, scripts) nothing is registered and the proxy is used as before.
let webBackend = null;

/** @param {((query: string) => Promise<{ items: object[] }>) | null} fn */
function setWebSearchBackend(fn) {
  webBackend = typeof fn === "function" ? fn : null;
}

async function fetchSearch(kind, query, opts = {}) {
  const q = String(query || "").trim().slice(0, 300);
  // A search a PERSON is waiting on (the AI chat passes `priority`) uses an official search API when a key is configured in .env: one HTTPS
  // request, nothing to render, no robot check (search-providers.cjs). Background searches (the Trust Engine's ~8 per site) never do, so
  // they cannot use up the API's quota. If the API fails for any reason the search carries on down the old paths below.
  if (kind === "web" && q && opts.priority) {
    try {
      const viaApi = await searchViaProvider(q, { readSetting: (name) => readSetting(name, opts.root || __dirname), http: opts.providerHttp });
      if (viaApi) return { status: 200, body: { kind: "customsearch#search", items: viaApi.items, jonah: { source: viaApi.source } } };
    } catch (err) {
      (opts.log || (() => {}))("search API:", (err && err.code) || "error", "-", err && err.message);
    }
  }
  if (kind === "web" && webBackend && q) {
    try {
      const { items } = await webBackend(q, { priority: !!opts.priority });
      return { status: 200, body: { kind: "customsearch#search", items: items || [], jonah: { source: "google-results-page" } } };
    } catch (err) {
      const log = opts.log || (() => {});
      log("Google results page:", (err && err.code) || "error", "-", err && err.message);
      const backup = await fetchViaProxy(kind, query, opts);
      if (backup.status === 200) return backup;
      const backupMessage = (backup.body && backup.body.error && backup.body.error.message) || `HTTP ${backup.status}`;
      return { status: 502, paused: backup.paused, body: { error: { message: `${(err && err.message) || "Google search failed"} (backup search: ${backupMessage})` } } };
    }
  }
  return fetchViaProxy(kind, query, opts);
}

async function fetchViaProxy(kind, query, opts = {}) {
  const http = opts.http || axios;
  const breaker = opts.breaker || breakerFor(http);
  const clock = opts.now || Date.now;
  if (KINDS.has(kind) && String(query || "").trim() && breaker.blocked(clock())) {
    const secs = Math.max(1, Math.ceil((breaker.until - clock()) / 1000));
    return { status: 502, paused: true, body: { error: { message: `${breaker.lastMessage} (search paused for ${secs}s after repeated failures)` } } };
  }
  const r = await fetchSearchOnce(kind, query, opts);
  if (r.status === 502) breaker.fail(clock(), r.body && r.body.error && r.body.error.message); // every network / upstream failure is normalised to 502 below
  else if (r.status === 200) breaker.ok();
  return r;
}

async function fetchSearchOnce(kind, query, { root = __dirname, log = () => {}, http = axios } = {}) {
  const q = String(query || "").trim().slice(0, 300);
  if (!KINDS.has(kind)) return { status: 404, body: { error: { message: "Unknown search kind" } } };
  if (!q) return { status: 400, body: { error: { message: "Missing query parameter q" } } };
  const base = (readSetting("JONAH_SEARCH_PROXY", root) || DEFAULT_BASE).replace(/\/+$/, "");
  const key = readSetting("JONAH_PROXY_KEY", root);
  try {
    const r = await http.get(`${base}/search/${kind}`, {
      params: { q },
      headers: upstreamHeaders(key, base),
      timeout: 12_000,
      validateStatus: () => true,
    });
    if (r.status === 401) {
      log("search proxy rejected the request (401): JONAH_PROXY_KEY is missing or wrong");
      return { status: 502, body: { error: { message: key ? "The search proxy rejected JONAH_PROXY_KEY" : "Search proxy needs JONAH_PROXY_KEY: add it to Jonah's .env" } } };
    }
    if (r.status >= 200 && r.status < 300 && r.data && typeof r.data === "object") return { status: 200, body: r.data };
    const message = r.data && r.data.error && r.data.error.message ? r.data.error.message : `Search proxy answered HTTP ${r.status}`;
    return { status: 502, body: { error: { message } } };
  } catch (err) {
    log("search proxy request failed:", err.message);
    return { status: 502, body: { error: { message: `Search proxy unreachable: ${err.message}` } } };
  }
}

// ------------------------------------------------------------------------------------------------ eBay (through the proxy)
//
// home.html's Fashion / Toys panels: eBay listings through jonahbrowser.store's /shopping/ebay, which holds the eBay keys. Only
// these parameters are passed on; eBay's JSON (itemSummaries[]) comes back unchanged.
const SHOPPING_PARAMS = ["q", "limit", "offset", "sort", "min_price", "max_price", "condition", "buying", "marketplace", "category_ids"];

async function fetchShopping(query, { root = __dirname, log = () => {}, http = axios } = {}) {
  const params = {};
  for (const name of SHOPPING_PARAMS) {
    const value = query && query[name];
    if (typeof value === "string" && value.trim()) params[name] = value.trim().slice(0, 350);
  }
  if (!params.q) return { status: 400, body: { error: { message: "Missing query parameter q" } } };
  const base = (readSetting("JONAH_SEARCH_PROXY", root) || DEFAULT_BASE).replace(/\/+$/, "");
  const key = readSetting("JONAH_PROXY_KEY", root);
  try {
    const r = await http.get(`${base}/shopping/ebay`, { params, headers: upstreamHeaders(key, base), timeout: 15_000, validateStatus: () => true });
    if (r.status === 401) {
      log("shopping proxy rejected the request (401): JONAH_PROXY_KEY is missing or wrong");
      return { status: 502, body: { error: { message: key ? "The search proxy rejected JONAH_PROXY_KEY" : "Search proxy needs JONAH_PROXY_KEY: add it to Jonah's .env" } } };
    }
    if (r.status >= 200 && r.status < 300 && r.data && typeof r.data === "object") return { status: 200, body: r.data };
    const message = r.data && r.data.error && r.data.error.message
      ? r.data.error.message
      : r.status === 404 ? "the server at jonahbrowser.store has no eBay search yet (deploy the latest Jonah-Backend)" : `Shopping proxy answered HTTP ${r.status}`;
    return { status: r.status === 400 ? 400 : 502, body: { error: { message } } };
  } catch (err) {
    log("shopping proxy request failed:", err.message);
    return { status: 502, body: { error: { message: `Search proxy unreachable: ${err.message}` } } };
  }
}

// ------------------------------------------------------------------------------------------------ news (through the proxy)
//
// The home pages' news grid (main.cjs 'get-news'): jonahbrowser.store's /news/headlines holds the NewsAPI key and does the same
// thing Jonah used to do itself - the country's top headlines, or the newest technology articles when there are none.
// NewsAPI's JSON ({ articles: [...] }) comes back unchanged.
async function fetchNews({ country = "in", page = 1, pageSize = 12 } = {}, { root = __dirname, log = () => {}, http = axios } = {}) {
  const params = {
    country: /^[a-z]{2}$/i.test(String(country)) ? String(country).toLowerCase() : "in",
    page: Math.min(Math.max(parseInt(page, 10) || 1, 1), 100),
    pageSize: Math.min(Math.max(parseInt(pageSize, 10) || 12, 1), 100),
  };
  const base = (readSetting("JONAH_SEARCH_PROXY", root) || DEFAULT_BASE).replace(/\/+$/, "");
  const key = readSetting("JONAH_PROXY_KEY", root);
  try {
    const r = await http.get(`${base}/news/headlines`, { params, headers: upstreamHeaders(key, base), timeout: 15_000, validateStatus: () => true });
    if (r.status === 401) {
      log("news proxy rejected the request (401): JONAH_PROXY_KEY is missing or wrong");
      return { status: 502, body: { error: { message: key ? "The search proxy rejected JONAH_PROXY_KEY" : "Search proxy needs JONAH_PROXY_KEY: add it to Jonah's .env" } } };
    }
    if (r.status >= 200 && r.status < 300 && r.data && typeof r.data === "object") return { status: 200, body: r.data };
    const message = r.data && r.data.error && r.data.error.message ? r.data.error.message : `News proxy answered HTTP ${r.status}`;
    return { status: 502, body: { error: { message } } };
  } catch (err) {
    log("news proxy request failed:", err.message);
    return { status: 502, body: { error: { message: `Search proxy unreachable: ${err.message}` } } };
  }
}

/** Jonah's own pages only (file:// pages report the origin "null"); every other website is refused. */
function allowOrigin(req, res) {
  const origin = req.headers.origin;
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) {
    res.status(403).json({ error: { message: "Search relay: origin not allowed" } });
    return false;
  }
  if (origin !== undefined) res.set("Access-Control-Allow-Origin", origin);
  res.set("Cache-Control", "no-store");
  return true;
}

/**
 * @param {import('express').Express} server
 * @param {{ root?: string, log?: (...a:any[]) => void, http?: { get: Function } }} [opts]
 */
function mountSearchProxy(server, opts = {}) {
  server.get("/api/search/:kind", async (req, res) => {
    if (!allowOrigin(req, res)) return;
    const { status, body } = await fetchSearch(req.params.kind, req.query.q, opts);
    res.status(status).json(body);
  });
  server.get("/api/shopping/ebay", async (req, res) => {
    if (!allowOrigin(req, res)) return;
    const { status, body } = await fetchShopping(req.query, opts);
    res.status(status).json(body);
  });
}

module.exports = { mountSearchProxy, fetchSearch, fetchShopping, fetchNews, setWebSearchBackend, setLicenseTokenProvider, readSetting, SearchBreaker };
