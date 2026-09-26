// Trust/service.cjs
//
// The Trust Engine's I/O side - a port of the iOS app's TrustService.swift (Jonah_V12_iOS_UpdateTrust). Gathers evidence from
// several independent sources (Reddit JSON + RSS, Quora / review platforms through Jonah's own search backend, and that same
// backend as a PRIMARY reputation source), classifies it with Trust/engine.cjs, verifies the domain's identity and (deep scan)
// its TLS certificate, adds the noahai.live /predict model's own holistic read as ONE input among several, and returns a
// TrustResult. Every source reports success/failure explicitly: a tool failure is `unknown` evidence (it lowers confidence),
// never negative evidence.
//
// What is intentionally NOT ported: iOS's subscription tiers (EntitlementManager: free-trial limits, cooldown, and the
// Premium-Plus "deep scan"). Windows has no tiers, so the deep scan is a button the user presses (see index.html) instead of
// a paywall, and there is no usage gate. The pipeline itself is otherwise the same, step for step.
//
// I/O is injected (`deps`) so the pipeline can be tested without a network.

"use strict";

const engine = require("./engine.cjs");

// ------------------------------------------------------------------------------------------------- static lists

// A small, deliberately short list of unambiguous global platforms kept purely as a fast path - NOT how "well-known company" is
// meant to be handled in general (KAYAK, FIFA, banks, airlines... are judged by the evidence pipeline). Same entries as iOS,
// including its substring matching (`domain.contains(entry)`).
const TRUSTED_DOMAINS = [
  "google.com", "youtube.com", "instagram.com",
  "facebook.com", "twitter.com", "x.com",
  "discord.com", "amazon.com", "wikipedia.org",
  "linkedin.com", "github.com", "microsoft.com",
  "apple.com", "netflix.com", "web.whatsapp.com", "jonahbrowser.com", "cogniaistudios.com", "cristiano ronaldo",
  "chatgpt.com", "bing.com", "grok.com", "snapchat.com",
  "tiktok.com", "cloudflare.com", "reddit.com", "uefa.com",
];

// Hand-curated negative counterpart: a domain the operator has directly identified as a scam, checked before any lookup.
const KNOWN_SCAM_DOMAINS = ["onlinelegalindia.com"];

const isTrusted = (domain) => TRUSTED_DOMAINS.some((d) => domain.includes(d));
const isKnownScam = (domain) => KNOWN_SCAM_DOMAINS.some((d) => domain.includes(d));

function brandFrom(domain) {
  let d = domain;
  if (d.startsWith("www.")) d = d.slice(4);
  const first = d.split(".")[0] || d;
  return first.replace(/-/g, " ").replace(/_/g, " ").toLowerCase();
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

const PREDICT_ENDPOINT = "https://www.noahai.live/predict";

/** Network blips worth one quiet retry (dropped connection, timeout, DNS hiccup) rather than a real failure. */
function isTransient(err) {
  if (!err) return false;
  if (err.transient) return true;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  const code = (err.cause && err.cause.code) || err.code || "";
  if (/^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT)$/.test(code)) return true;
  return /fetch failed|network|timed out|timeout|socket hang up|ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_(RESET|TIMED_OUT|CLOSED)|TIMED_OUT)/i.test(String((err && err.message) || ""));
}

// A genuine certificate / trust failure (direct, meaningful security evidence) - unlike a timeout, a reset, or a WAF blocking an
// unrecognised client, which are TOOL failures and stay `unknown`. Matches Chromium's net errors (what Electron's net stack reports).
const CERT_FAILURE = /ERR_CERT|ERR_TLS_CERT|CERT_(?:HAS_EXPIRED|NOT_YET_VALID|UNTRUSTED|REVOKED)|UNABLE_TO_VERIFY_LEAF|UNABLE_TO_GET_ISSUER|SELF_SIGNED|DEPTH_ZERO/i;

// -------------------------------------------------------------------------------------------- default I/O (main process)

function defaultDeps() {
  const rnd = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  return {
    randomUA: rnd,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (...a) => console.log("[TrustEngine]", ...a),
    // Jonah's own search backend (the same proxy the search page uses; Google Custom Search JSON). Throws on failure so "the
    // request failed" stays distinct from "it succeeded with no results".
    search: async (query) => {
      const { fetchSearch } = require("../search-proxy.cjs");
      const r = await fetchSearch("web", query, {});
      if (r.status !== 200) {
        const message = (r.body && r.body.error && r.body.error.message) || `search proxy answered ${r.status}`;
        const e = new Error(message);
        // Only a dropped connection / timeout is worth a quiet retry. The proxy's own "HTTP 502" is a HANDLED upstream failure (a quota, a bad
        // key, a broken route): asking again cannot fix it - and, twice per query, ten queries per page, it is what flooded a failing service.
        e.transient = r.status === 502 && !r.paused && /unreachable|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(message);
        throw e;
      }
      return ((r.body && r.body.items) || []).map((it) => ({ title: it.title || "", snippet: it.snippet || "", link: it.link || "" }));
    },
    // Plain HTTP for Reddit and /predict.
    fetch: (url, opts) => fetch(url, opts),
    // The certificate probe goes through Chromium's own network stack (Electron `net`): the same certificate verifier, and the
    // same trust store, the user's own browsing uses. Falls back to Node's fetch outside Electron (tests, scripts).
    secureFetch: (url, opts) => {
      try {
        const { net } = require("electron");
        if (net && typeof net.fetch === "function") return net.fetch(url, opts);
      } catch (_) { /* not running inside Electron */ }
      return fetch(url, opts);
    },
    predictEndpoint: PREDICT_ENDPOINT,
    sessionId: "trust_win_" + Math.random().toString(36).slice(2),
    deviceId: "win_" + Math.random().toString(36).slice(2),
  };
}

// -------------------------------------------------------------------------------------------------------- the service

class TrustService {
  /** @param {Partial<ReturnType<typeof defaultDeps>>} [deps] */
  constructor(deps = {}) {
    this.d = { ...defaultDeps(), ...deps };
  }

  /**
   * Checks one hostname (e.g. "example.com") and returns a full trust result. `deepScan` pulls from EVERY source instead of
   * stopping at the first non-empty one, keeps more snippets, runs the real security/HTTPS check, and asks the AI for a longer
   * source-by-source explanation. A whole-check ceiling (60 s, deep 100 s) means a hung source can never leave the panel
   * spinning: it reports "unverified", not a low score - a tool failure is not evidence of risk.
   * @returns {Promise<TrustResult>}
   */
  async checkDomain(rawDomain, { deepScan = false } = {}) {
    const ceilingMs = this.d.ceilingMs ?? (deepScan ? 100 : 60) * 1000;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({
        score: 60, community: 60, security: "Check timed out",
        issues: ["Trust lookup took too long"], source: "none",
        riskLevel: "unknown", riskScore: 40, confidenceScore: 10,
        unknownSources: ["all sources (timed out)"], conflictingEvidence: [],
        reasoning: "The trust check itself timed out before any evidence could be gathered - this is a tool failure, not evidence of risk, so the result is reported as unverified rather than as a low score.",
      }), ceilingMs);
    });
    try {
      const first = await Promise.race([this._performCheck(String(rawDomain || ""), deepScan).catch((err) => { this.d.log("check failed:", err && err.message); return null; }), timeout]);
      return first || {
        score: 60, community: 60, security: "No data found",
        issues: ["No community discussions found for this site"], source: "none",
        riskLevel: "unknown", riskScore: 45, confidenceScore: 10,
        unknownSources: ["all sources"], conflictingEvidence: [],
        reasoning: "No usable result came back from the check - reported as unverified rather than as a low score.",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------- security check (deep scan only)

  /**
   * A genuine, local security check - not a third-party malware database lookup (that needs an API key, so it is not claimed).
   * Verifies that HTTPS to this host succeeds with a browser-like request, that its certificate is valid and trusted, and that
   * it does not silently redirect to a different domain. Evidence is `negative` ONLY for a certificate/trust failure; any other
   * failure (timeout, reset, a WAF blocking an unrecognised client) is `unknown` - the check simply did not run, which says
   * nothing about the site's security (the exact false positive this design fixes: a bare HEAD blocked by bot protection on a
   * legitimate, high-traffic site read as "insecure").
   */
  async _securityCheck(host) {
    const ev = (status, snippet, extra = {}) => engine.makeEvidence({ source: "security", type: "security", status, snippet, relevance: 1.0, ...extra });
    let url;
    try { url = new URL(`https://${host}`).href; } catch (_) { return ev("unknown", "Couldn't form a connection URL for this host."); }

    try {
      const res = await this.d.secureFetch(url, { method: "HEAD", headers: { "User-Agent": this.d.randomUA() }, signal: AbortSignal.timeout(8000) });
      let finalHost = "";
      try { finalHost = new URL(res.url || url).hostname; } catch (_) { /* keep empty */ }
      // example.com <-> www.example.com is the same domain (iOS compares the raw hosts and called that "a different domain")
      const bare = (h) => h.replace(/^www\./, "");
      if (finalHost && bare(finalHost) !== bare(host)) {
        return ev("unknown", `Connection succeeded but redirected to a different domain (${finalHost}) - not itself evidence of risk (CDNs, regional domains, and load balancers commonly do this), but not a clean same-domain confirmation either.`);
      }
      return ev("positive", "Valid HTTPS connection with a trusted certificate, same domain.", { specificity: 1.0 });
    } catch (err) {
      const msg = String((err && err.message) || "");
      const code = String((err && err.cause && err.cause.code) || err.code || "");
      if (CERT_FAILURE.test(msg) || CERT_FAILURE.test(code)) {
        return ev("negative", "Invalid or untrusted HTTPS certificate.", { specificity: 1.0, severity: 0.9 });
      }
      return ev("unknown", `Couldn't establish a secure connection (${msg || "unknown error"}) - this may just mean the site blocks automated requests, not that it's insecure.`);
    }
  }

  // ---------------------------------------------------------------- domain identity

  /**
   * Establishes, BEFORE any reputation evidence is weighed, what entity this domain belongs to and whether it is plausibly that
   * entity's real domain. A soft signal: `domainMatch` only becomes false (impersonation) when search results for the brand's
   * own name consistently point to a DIFFERENT domain - never merely because the search found little, which stays null
   * (unknown, not suspicious).
   */
  async _verifyDomainIdentity(rawDomain, brand) {
    // DELIBERATE FIX vs the iOS original: result hosts are compared with "www." stripped (see below), but iOS compares them to
    // the RAW host ("www.kayak.com"). For every www. site that made the domain "not appear" in results about itself, so the top
    // result (kayak.com) looked like a DIFFERENT domain: "possible impersonation", +35 risk, on a legitimate site.
    const domain = rawDomain.startsWith("www.") ? rawDomain.slice(4) : rawDomain;
    const empty = { currentDomain: domain, identifiedEntity: null, officialDomainGuess: null, domainMatch: null, possibleImpersonation: false, identityConfidence: 0.0 };
    let results = await this.d.search(`${brand} official website`).catch(() => null);
    if (!results || !results.length) results = await this.d.search(`"${domain}" official site`).catch(() => null);
    if (!results || !results.length) return empty;

    const hostCounts = new Map();
    for (const r of results) {
      let host;
      try { host = new URL(r.link).hostname; } catch (_) { continue; }
      if (!host) continue;
      if (host.startsWith("www.")) host = host.slice(4);
      host = host.toLowerCase();
      hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
    }
    if (!hostCounts.size) return empty;

    let topHost = null;
    let topCount = 0;
    for (const [h, c] of hostCounts) if (c > topCount) { topHost = h; topCount = c; }

    const domainAppearsInResults = hostCounts.has(domain);
    const totalMentions = Math.max(1, [...hostCounts.values()].reduce((a, b) => a + b, 0));
    const topHostShare = topCount / totalMentions;

    if (domainAppearsInResults) {
      const domainShare = (hostCounts.get(domain) || 0) / totalMentions;
      return { currentDomain: domain, identifiedEntity: brand, officialDomainGuess: domain, domainMatch: true, possibleImpersonation: false, identityConfidence: 0.6 + 0.3 * domainShare };
    }
    if (topHost !== domain && topHostShare >= 0.5) {
      return { currentDomain: domain, identifiedEntity: brand, officialDomainGuess: topHost, domainMatch: false, possibleImpersonation: true, identityConfidence: topHostShare };
    }
    return { ...empty, identifiedEntity: brand, identityConfidence: 0.2 };
  }

  // ---------------------------------------------------------------- sources

  async _fetchRedditJSON(query, retries = 2) {
    const url = `https://www.reddit.com/search.json?${new URLSearchParams({ q: query, limit: "10", sort: "relevance" })}`;
    let attempt = 0;
    while (attempt < retries) {
      attempt += 1;
      try {
        const res = await this.d.fetch(url, { headers: { "User-Agent": this.d.randomUA(), Accept: "application/json, text/plain, */*" }, signal: AbortSignal.timeout(10000) });
        if (res.status === 429) {
          await this.d.sleep(Math.pow(2, attempt) * 3 * 1000);
          continue;
        }
        if (!(res.status >= 200 && res.status <= 299)) return { texts: [], succeeded: false };
        const json = await res.json();
        const texts = json.data.children.map((c) => `${c.data.title} ${c.data.selftext ?? ""}`);
        return { texts, succeeded: true };
      } catch (err) {
        if (isTransient(err) && attempt < retries) {
          await this.d.sleep(1000);
          continue;
        }
        return { texts: [], succeeded: false };
      }
    }
    return { texts: [], succeeded: false };
  }

  async _fetchRedditRSS(query) {
    const url = `https://www.reddit.com/search.rss?${new URLSearchParams({ q: query, limit: "10", sort: "relevance" })}`;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const res = await this.d.fetch(url, { headers: { "User-Agent": this.d.randomUA(), Accept: "application/rss+xml, application/xml, text/xml, */*" }, signal: AbortSignal.timeout(10000) });
        if (!(res.status >= 200 && res.status <= 299)) return { texts: [], succeeded: false };
        const xml = await res.text();
        const texts = [];
        for (const m of xml.matchAll(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/g)) {
          if (!m[1].toLowerCase().includes("reddit: the front page")) texts.push(m[1]);
        }
        return { texts, succeeded: true };
      } catch (err) {
        if (isTransient(err) && attempt < 2) {
          await this.d.sleep(1000);
          continue;
        }
        return { texts: [], succeeded: false };
      }
    }
  }

  /** null (not []) when the request FAILED, so "failed" stays distinct from "succeeded with no results". */
  async _fetchViaSearch(query, attempt = 1) {
    try {
      const results = await this.d.search(query);
      return results.map((r) => `${r.title} ${r.snippet}`);
    } catch (err) {
      if (isTransient(err) && attempt < 2) {
        await this.d.sleep(1000);
        return this._fetchViaSearch(query, attempt + 1);
      }
      return null;
    }
  }

  _fetchViaSearchSite(query, sites) {
    const filter = sites.map((s) => `site:${s}`).join(" OR ");
    return this._fetchViaSearch(`(${filter}) ${query}`);
  }

  // ---------------------------------------------------------------- /predict

  /** The AI backend's own holistic read: ONE input to aggregate(), never the sole authority and never replaced by a keyword counter on failure. */
  async _analyzeWithPredict(brand, texts, deepScan, attempt = 1) {
    // The server rate-limits this per device (a 429 with `cooldownRemainingSeconds`, the iOS free-trial limit). iOS turns that
    // into a "limit reached" screen through its subscription manager; there is no such screen here, so while the cooldown runs
    // the AI read is simply skipped (no pointless requests) and the panel says why (see `notes` in _performCheck).
    if (this.aiCooldownUntil && Date.now() < this.aiCooldownUntil) return null;
    let prompt = `You are a trust and safety analyst. Judge how trustworthy the website/brand "${brand}" is.

STEP 1 — is "${brand}" a well-known, established name? Ask: would most ordinary people in its home country or worldwide immediately recognize it? Say YES for anything like: a large company or retailer, a bank, an airline, a telecom or automaker, a restaurant or food chain (e.g. McDonald's, Starbucks, Domino's, KFC, Subway — local or global chains alike), a university, a government agency, a sports league/team/governing body AND the well-known executives/coaches/athletes/officials associated with them, a game publisher or entertainment company, a news outlet (private or state-run), a celebrity or public figure. This list is just examples — apply the same "would people recognize this name" test to ANY brand, business, or person, in any category, even ones not listed here. Only say NO for a brand, app, or seller that is small, obscure, or that you don't recognize at all.

STEP 2 — if YES (established): the word "scam" or "fraud" appearing INSIDE a snippet's text is NOT itself evidence of anything — people use that word loosely to vent about normal business problems (a late delivery, a bad referee call, a price hike, a rude employee, a policy they dislike, a personal opinion about a public figure). Ignore that word entirely and instead ask: does this snippet describe one SPECIFIC, verifiable, illegal act — stolen money, a fake/counterfeit product, identity theft, a rigged/fixed outcome? If not, it is just a complaint, not evidence. A well-known name should score in the 55-90 range even with many angry complaints, unless MULTIPLE snippets independently describe the same specific illegal act. Getting this wrong and calling a real, established brand or person a "scam" is the single worst mistake this tool can make — it destroys trust in every future result. When unsure, score higher and call it "complaints" or "mixed feedback," never "scam."

STEP 3 — if NO (unrecognized/obscure): judge normally, and it can be scored low if the evidence supports it.

Before answering, decide isEstablished (true/false) from STEP 1. That decision must be internally consistent with the score you give in STEP 2/3.`;

    const snippetCap = deepScan ? 25 : 10;
    if (!texts.length) {
      prompt += "\n\nNo public community posts were found about it anywhere. Base your judgement on your own knowledge of this brand. If you don't recognize it at all, return score 50 and say so in the summary.";
    } else {
      // The hosted /predict chat handler answers ANY message containing an http(s):// URL with "Opening the link: ..." before it
      // ever reaches the model (measured live: search snippets carry URLs, so the whole analysis prompt was swallowed and the AI
      // read silently dropped out). The model does not need raw URLs to judge a brand, so they are masked in the prompt only -
      // classification (Trust/engine.cjs) still sees the original text, where a domain mention is what makes a snippet relevant.
      const numbered = texts.slice(0, snippetCap).map((t, i) => `${i + 1}. ${String(t).replace(/https?:\/\/\S+/gi, "[link]")}`).join("\n");
      prompt += `\n\nHere are up to ${snippetCap} snippets of real public discussion (Reddit posts / search results) mentioning it:\n${numbered}`;
    }
    if (deepScan) {
      prompt += '\n\nThis is a deep scan for a paying subscriber — in addition to the fields below, also write a longer "detailedAnalysis": 3-5 sentences that walks through what the evidence actually shows, snippet by snippet where relevant (what was found, which platform it came from, and why it does or doesn\'t support the score you gave). Be specific rather than generic.';
    }
    prompt += `\n\nRespond with ONLY a valid JSON object — no markdown fences, no explanation, nothing else. Put "isEstablished" first since it's your STEP 1 decision, before you commit to a score:\n{"isEstablished": <true or false>, "score": <integer 0-100, higher = more trustworthy>, "summary": "<one short sentence>", "scamCount": <integer, count ONLY snippets describing a specific verifiable illegal act>, "complaintCount": <integer>, "positiveCount": <integer>, "issues": ["<issue1>", "<issue2>"]${deepScan ? ', "detailedAnalysis": "<3-5 sentence explanation>"' : ""}}`;

    // The hosted server special-cases exactly this user_agent string (it skips the "needs the page / needs a web search"
    // round-trips that would otherwise swallow a long analysis prompt whose own JSON schema contains the word "summary").
    // Keep it byte-identical to the iOS client's until the server accepts a platform-specific one.
    const payload = {
      message: prompt, mode: "chat", session_id: this.d.sessionId, url: "trust-engine", page_content: "",
      user_agent: "Jonah-iOS-TrustEngine", platform: "windows",
      language: (Intl.DateTimeFormat().resolvedOptions().locale || "en-US"), timestamp: new Date().toISOString(),
      tier: "free", device_id: this.d.deviceId,
    };

    try {
      const res = await this.d.fetch(this.d.predictEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(35000) });
      if (res.status === 429) {
        let seconds = NaN;
        try { seconds = Number(JSON.parse(await res.text()).cooldownRemainingSeconds); } catch (_) { /* no body */ }
        this.aiCooldownUntil = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60 * 1000);
        this.d.log(`predict 429 - the server says this device's trial is on cooldown (${Number.isFinite(seconds) ? Math.round(seconds) + "s" : "unknown length"})`);
        return null;
      }
      if (!(res.status >= 200 && res.status <= 299)) {
        this.d.log(`predict HTTP ${res.status} (attempt ${attempt})`);
        return null;
      }
      let jsonText = await res.text();
      try {
        const wrapper = JSON.parse(jsonText);
        if (wrapper && typeof wrapper.answer === "string") jsonText = wrapper.answer;
      } catch (_) { /* the body itself may be the JSON object */ }

      const objectText = /\{[\s\S]*\}/.exec(jsonText);
      if (!objectText) {
        this.d.log("predict response had no JSON object in it:", jsonText.slice(0, 200));
        return null;
      }
      let parsed;
      try { parsed = JSON.parse(objectText[0]); } catch (err) {
        this.d.log("predict decode failed:", err.message, "- raw body was:", objectText[0].slice(0, 500));
        return null;
      }
      if (typeof parsed.score !== "number" || !Number.isFinite(parsed.score) || typeof parsed.summary !== "string") {
        this.d.log("predict decode failed: missing score/summary");
        return null;
      }
      return {
        trustScore: Math.round(parsed.score),
        isEstablished: typeof parsed.isEstablished === "boolean" ? parsed.isEstablished : null,
        scamCount: Number.isFinite(parsed.scamCount) ? parsed.scamCount : 0,
        summary: parsed.summary,
      };
    } catch (err) {
      if (isTransient(err) && attempt < 2) {
        await this.d.sleep(1000);
        return this._analyzeWithPredict(brand, texts, deepScan, attempt + 1);
      }
      return null;
    }
  }

  // ---------------------------------------------------------------- the pipeline

  async _performCheck(rawDomain, deepScan) {
    const d = this.d;
    const domain = rawDomain.toLowerCase();
    const brand = brandFrom(domain);
    d.log(`checking domain=${domain} brand=${brand} deepScan=${deepScan}`);

    if (isTrusted(domain)) {
      d.log("domain is on the hard-coded trusted list, skipping lookups");
      return { score: 85, community: 85, security: "Trusted platform", issues: ["Widely recognized service"], source: "trusted-list", unknownSources: [], conflictingEvidence: [] };
    }
    if (isKnownScam(domain)) {
      d.log("domain is on the hard-coded known-scam list, skipping lookups");
      return { score: 5, community: 5, security: "Reported scam - avoid", issues: ["This site has been flagged as a scam"], source: "known-scam-list", unknownSources: [], conflictingEvidence: [] };
    }

    // The four independent groups run concurrently (the iOS client runs them one after another): the inputs and the result are
    // identical, only the waiting is shorter. Their order in `sourceResults` below is preserved, since "primary source" is the
    // first one with any text.
    const gatherReddit = async () => {
      const out = [];
      let jsonTexts = [];
      let jsonOk = false;
      for (const q of [`${brand} scam OR fraud`, `${brand} review legit`]) {
        const r = await this._fetchRedditJSON(q);
        jsonTexts = jsonTexts.concat(r.texts);
        jsonOk = jsonOk || r.succeeded;
      }
      out.push({ source: "reddit-json", succeeded: jsonOk, texts: jsonTexts, error: jsonOk ? null : "request failed" });
      if (!jsonTexts.length || deepScan) {
        let rssTexts = [];
        let rssOk = false;
        for (const q of [`${brand} scam OR fraud`, `${brand} review legit`]) {
          const r = await this._fetchRedditRSS(q);
          rssTexts = rssTexts.concat(r.texts);
          rssOk = rssOk || r.succeeded;
        }
        out.push({ source: "reddit-rss", succeeded: rssOk, texts: rssTexts, error: rssOk ? null : "request failed" });
      }
      return out;
    };

    // Jonah's own search backend as a PRIMARY source with varied queries (not just "brand + scam", which alone invites the
    // "Is KAYAK a scam? No." kind of noise - classifySnippet's negation/relevance handling is what makes a wide net safe).
    const gatherCustomSearch = async () => {
      const queries = [`"${domain}" reviews`, `${brand} reviews`, `${brand} scam`, `${brand} complaints`, `${brand} fraud`, `${brand} user experiences`, `${brand} customer complaints`, `${brand} legitimate`];
      let texts = [];
      let failed = false;
      let misses = 0;
      for (const q of queries) {
        const fetched = await this._fetchViaSearch(q);
        if (fetched) { texts = texts.concat(fetched); misses = 0; }
        else {
          failed = true;
          // two failures in a row with nothing to show: the service is down, and six more queries cannot change that
          if (++misses >= 2 && texts.length === 0) break;
        }
        if (texts.length >= 20 && !deepScan) break;
      }
      const ok = !(failed && texts.length === 0);
      return { source: "custom-search", succeeded: ok, texts, error: ok ? null : "request failed" };
    };

    const [domainIdentity, securityEvidence, redditResults, custom] = await Promise.all([
      this._verifyDomainIdentity(domain, brand),
      deepScan ? this._securityCheck(domain) : Promise.resolve(null),
      gatherReddit(),
      gatherCustomSearch(),
    ]);
    d.log(`domain identity: match=${domainIdentity.domainMatch} impersonation=${domainIdentity.possibleImpersonation} confidence=${domainIdentity.identityConfidence}`);

    const sourceResults = [...redditResults, custom];

    if (!custom.texts.length || deepScan) {
      const quora = await this._fetchViaSearchSite(`${brand} scam OR fraud OR legit`, ["quora.com"]);
      sourceResults.push({ source: "quora", succeeded: quora !== null, texts: quora || [], error: quora === null ? "request failed" : null });
      const reviewSites = await this._fetchViaSearchSite(`${brand} reviews`, ["trustpilot.com", "sitejabber.com", "consumeraffairs.com", "bbb.org", "google.com/maps"]);
      sourceResults.push({ source: "review-sites", succeeded: reviewSites !== null, texts: reviewSites || [], error: reviewSites === null ? "request failed" : null });
    }

    const primarySource = (sourceResults.find((s) => s.texts.length) || {}).source || "none";
    const allTexts = sourceResults.flatMap((s) => s.texts);
    d.log(`domain=${domain} gathered ${allTexts.length} raw text(s) from ${sourceResults.length} source(s), unknown=${JSON.stringify(sourceResults.filter((s) => !s.succeeded).map((s) => s.source))}`);

    // Classify each snippet into weighted Evidence (relevance/negation/specificity-aware, not a bare keyword count)
    const contentEvidence = allTexts.map((t) => engine.classifySnippet(t, brand, domain)).filter(Boolean);
    const relevantForAi = [];
    const seen = new Set();
    for (const t of allTexts) {
      if (!(engine.relevanceOf(t, brand, domain) > 0.0) || seen.has(t)) continue;
      seen.add(t);
      relevantForAi.push(t);
      if (relevantForAi.length >= (deepScan ? 25 : 10)) break;
    }
    d.log(`domain=${domain} ${contentEvidence.length} classified evidence item(s) from ${relevantForAi.length}/${allTexts.length} relevant text(s)`);

    d.log("calling /predict...");
    const aiJudgment = await this._analyzeWithPredict(brand, relevantForAi, deepScan);
    if (!aiJudgment) d.log("/predict unavailable - proceeding with evidence-engine-only analysis (NOT a keyword fallback)");

    const analysis = engine.aggregate({ domain, domainIdentity, securityEvidence, sourceResults, aiJudgment, rawContentEvidence: contentEvidence });

    const issuesFromEvidence = contentEvidence
      .filter((e) => e.status === "negative")
      .sort((a, b) => b.relevance * b.specificity * b.severity - a.relevance * a.specificity * a.severity)
      .slice(0, 4)
      .map((e) => e.snippet.slice(0, 120));

    const summary = aiJudgment ? aiJudgment.summary : shortSummary(analysis.riskLevel, analysis.riskScore);

    // Plain-language notes the panel shows under the verdict (not part of the iOS result): why the AI read is missing when the
    // reason is the server's rate limit, so "Unable to fully verify" is not mistaken for the sources having failed.
    const notes = [];
    if (!aiJudgment && this.aiCooldownUntil && Date.now() < this.aiCooldownUntil) {
      const minutes = Math.max(1, Math.ceil((this.aiCooldownUntil - Date.now()) / 60000));
      notes.push(`The AI analysis is rate-limited for about ${minutes} more minute${minutes === 1 ? "" : "s"}, so this score uses the collected evidence only.`);
    }

    return {
      score: analysis.trustScore,
      community: analysis.trustScore,
      security: summary,
      issues: issuesFromEvidence.length ? issuesFromEvidence : [summary],
      source: aiJudgment ? "noah-predict" : primarySource !== "none" ? primarySource : "evidence-engine",
      detailedAnalysis: deepScan ? analysis.reasoning : null,
      securityScanNotes: securityEvidence ? [securityEvidence.snippet] : null,
      riskLevel: analysis.riskLevel,
      riskScore: analysis.riskScore,
      confidenceScore: analysis.confidenceScore,
      unknownSources: analysis.unknownSources,
      conflictingEvidence: analysis.conflictingEvidence,
      reasoning: analysis.reasoning,
      notes,
    };
  }
}

function shortSummary(riskLevel, riskScore) {
  switch (riskLevel) {
    case "highRisk": return "Specific, corroborated evidence of risk found";
    case "mediumRisk": return "Some concerning evidence found, not conclusive";
    case "lowRisk": return riskScore < 15 ? "No meaningful evidence of risk found" : "Mostly positive, with minor complaints";
    default: return "Unable to fully verify - independent sources were unavailable";
  }
}

/**
 * Per-session cache keyed by lowercased host (iOS's TrustResultCache): a host visited earlier in the session shows its score
 * again instantly instead of re-running the (slow) check. An entry expires after `ttlMs` so a long session still refreshes.
 */
class TrustResultCache {
  constructor({ ttlMs = 30 * 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }

  get(host, { deepScan = false } = {}) {
    const hit = this.map.get(host);
    if (!hit || this.now() - hit.at > this.ttlMs) return null;
    // a quick result cannot stand in for a deep scan the user asked for
    if (deepScan && !hit.deepScan) return null;
    return hit.result;
  }

  store(host, result, { deepScan = false } = {}) {
    this.map.set(host, { result, deepScan, at: this.now() });
  }
}

module.exports = { TrustService, TrustResultCache, brandFrom, isTrusted, isKnownScam, isTransient, TRUSTED_DOMAINS, KNOWN_SCAM_DOMAINS, shortSummary };
