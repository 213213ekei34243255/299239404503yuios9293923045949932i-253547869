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

const DEFAULT_BASE = "https://www.jonahbrowser.store";
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
async function fetchSearch(kind, query, { root = __dirname, log = () => {}, http = axios } = {}) {
  const q = String(query || "").trim().slice(0, 300);
  if (!KINDS.has(kind)) return { status: 404, body: { error: { message: "Unknown search kind" } } };
  if (!q) return { status: 400, body: { error: { message: "Missing query parameter q" } } };
  const base = (readSetting("JONAH_SEARCH_PROXY", root) || DEFAULT_BASE).replace(/\/+$/, "");
  const key = readSetting("JONAH_PROXY_KEY", root);
  try {
    const r = await http.get(`${base}/search/${kind}`, {
      params: { q },
      headers: key ? { "X-Jonah-Key": key } : {},
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

/**
 * @param {import('express').Express} server
 * @param {{ root?: string, log?: (...a:any[]) => void, http?: { get: Function } }} [opts]
 */
function mountSearchProxy(server, opts = {}) {
  server.get("/api/search/:kind", async (req, res) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: { message: "Search relay: origin not allowed" } });
    }
    if (origin !== undefined) res.set("Access-Control-Allow-Origin", origin);
    res.set("Cache-Control", "no-store");
    const { status, body } = await fetchSearch(req.params.kind, req.query.q, opts);
    res.status(status).json(body);
  });
}

module.exports = { mountSearchProxy, fetchSearch, readSetting };
