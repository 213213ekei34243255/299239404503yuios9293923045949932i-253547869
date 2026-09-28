// search-providers.cjs
//
// Official web-search APIs, for the searches a PERSON is waiting on (the AI chat, the search page). Rendering Google's own results page in
// a hidden window (google-serp.cjs) works, but it is slow on a busy PC (measured: ~14 s with every core saturated; up to a timeout) and
// Google shows a robot check after a few quick searches - and the Trust Engine shares that reader, firing about eight searches per site.
// An API key has none of those problems: one HTTPS request, JSON back, ToS-compliant.
//
// Configure ONE of these in Jonah's .env (or the environment); the first one found is used:
//     SERPER_API_KEY=...          https://serper.dev  (Google's results as JSON; free credits on sign-up)
//     BRAVE_SEARCH_API_KEY=...    https://brave.com/search/api  (Brave's own index)
// With none set, nothing here runs and search works exactly as before (Google's page, then the jonahbrowser.store proxy).
//
// Returns the same shape everything else uses: { items: [{ title, link, snippet, displayLink }] }.
//
// HONEST STATUS: written to each service's documented response format and covered by tests with a stand-in HTTP client. It has NOT been
// run against the live services (that needs a key). Until it has, treat it as untested against the real API.

"use strict";

const axios = require("axios");

class SearchProviderError extends Error {
  /** @param {"auth"|"quota"|"network"|"http"|"empty"} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const host = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
};
const plain = (s) => String(s == null ? "" : s).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, " ").trim();
const item = (title, link, snippet) => ({ title: plain(title), link, snippet: plain(snippet).slice(0, 500), displayLink: host(link) });
const isHttp = (u) => /^https?:\/\//i.test(String(u || ""));

function failFor(status, provider) {
  if (status === 401 || status === 403) return new SearchProviderError("auth", `${provider} rejected the API key (HTTP ${status})`);
  if (status === 429 || status === 402) return new SearchProviderError("quota", `${provider}'s quota or rate limit is used up (HTTP ${status})`);
  return new SearchProviderError("http", `${provider} answered HTTP ${status}`);
}

const PROVIDERS = {
  serper: {
    label: "Serper",
    envKey: "SERPER_API_KEY",
    async search(query, key, http, { limit }) {
      const r = await http.post("https://google.serper.dev/search", { q: query, num: limit, hl: "en" }, { headers: { "X-API-KEY": key, "Content-Type": "application/json" }, timeout: 12000, validateStatus: () => true });
      if (r.status < 200 || r.status >= 300) throw failFor(r.status, "Serper");
      const organic = r.data && Array.isArray(r.data.organic) ? r.data.organic : [];
      return organic.filter((o) => isHttp(o.link) && o.title).slice(0, limit).map((o) => item(o.title, o.link, o.snippet));
    },
  },
  brave: {
    label: "Brave Search",
    envKey: "BRAVE_SEARCH_API_KEY",
    async search(query, key, http, { limit }) {
      const r = await http.get("https://api.search.brave.com/res/v1/web/search", {
        params: { q: query, count: limit, safesearch: "moderate", text_decorations: false },
        headers: { "X-Subscription-Token": key, Accept: "application/json" },
        timeout: 12000,
        validateStatus: () => true,
      });
      if (r.status < 200 || r.status >= 300) throw failFor(r.status, "Brave Search");
      const results = r.data && r.data.web && Array.isArray(r.data.web.results) ? r.data.web.results : [];
      return results.filter((o) => isHttp(o.url) && o.title).slice(0, limit).map((o) => item(o.title, o.url, o.description));
    },
  },
};

/** The first provider that has a key, or null. `readSetting(name)` reads the environment / .env (search-proxy.cjs's own reader). */
function configuredProvider(readSetting) {
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const key = readSetting(p.envKey);
    if (key) return { name, key, label: p.label };
  }
  return null;
}

/**
 * @returns {Promise<null | { items: object[], source: string }>} null when no provider is configured (nothing was tried)
 * @throws {SearchProviderError} when a configured provider failed (the caller falls back to the next search path)
 */
async function searchViaProvider(query, { readSetting, http = axios, limit = 8 } = {}) {
  const prov = configuredProvider(readSetting || (() => ""));
  if (!prov) return null;
  let items;
  try {
    items = await PROVIDERS[prov.name].search(String(query).slice(0, 300), prov.key, http, { limit });
  } catch (err) {
    if (err instanceof SearchProviderError) throw err;
    throw new SearchProviderError("network", `${prov.label} could not be reached (${String(err && err.message).slice(0, 100)})`);
  }
  if (!items.length) throw new SearchProviderError("empty", `${prov.label} returned no results`);
  return { items, source: prov.name };
}

module.exports = { searchViaProvider, configuredProvider, SearchProviderError, PROVIDERS };
