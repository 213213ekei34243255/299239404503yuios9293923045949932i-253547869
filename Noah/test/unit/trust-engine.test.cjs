"use strict";
// The Trust Engine ported from the iOS app (Jonah_V12_iOS_UpdateTrust): scoring core, the network pipeline (with the network
// faked), the certificate probe, and the main-process controller. The design rules under test are the iOS engine's own:
// missing evidence lowers CONFIDENCE and never raises RISK; evidence is weighted, not counted.

const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../../../Trust/engine.cjs");
const { TrustService, TrustResultCache, brandFrom } = require("../../../Trust/service.cjs");
const { createTrustController, isCheckableHost } = require("../../../Trust/controller.cjs");

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);
const ev = (o) => engine.makeEvidence({ source: "review", type: "complaint", ...o });
const okSource = (source, texts = []) => ({ source, succeeded: true, texts });
const failedSource = (source) => ({ source, succeeded: false, texts: [] });
const identity = (o = {}) => ({ currentDomain: "x.com", identifiedEntity: null, officialDomainGuess: null, domainMatch: null, possibleImpersonation: false, identityConfidence: 0, ...o });

// ------------------------------------------------------------------------------------------------------------ relevance

test("relevance: the domain itself is a strong match, the bare brand word a weak one, neither is dropped", () => {
  assert.equal(engine.relevanceOf("I booked on kayak.com last week", "kayak", "kayak.com"), 1.0);
  assert.equal(engine.relevanceOf("my kayak scam story, a boat", "kayak", "www.kayak.com"), 0.55);
  assert.equal(engine.relevanceOf("nothing to do with it", "kayak", "kayak.com"), 0.0);
  assert.equal(engine.relevanceOf("kayaking is fun", "kayak", "kayak.com"), 0.0, "a longer word is not the brand word");
});

// --------------------------------------------------------------------------------------------- snippet classification

test("classify: 'Is KAYAK a scam? No.' is reassurance, NOT a scam report (the false positive this engine exists to fix)", () => {
  const e = engine.classifySnippet("Is KAYAK a scam? No, it is legit", "kayak", "kayak.com");
  assert.equal(e.status, "positive");
  assert.equal(e.type, "reassurance");
});

test("classify: a specific fraud claim is severe, a bare accusation is weak, support/controversy complaints are near-zero severity", () => {
  const fraud = engine.classifySnippet("kayak.com took my money, order #48213, never refunded", "kayak", "kayak.com");
  assert.deepEqual([fraud.status, fraud.severity, fraud.specificity], ["negative", 0.9, 0.9]);
  const bare = engine.classifySnippet("kayak.com is a scam", "kayak", "kayak.com");
  assert.deepEqual([bare.status, bare.severity, bare.specificity], ["negative", 0.45, 0.15]);
  const support = engine.classifySnippet("kayak.com had poor customer service", "kayak", "kayak.com");
  assert.deepEqual([support.status, support.severity], ["negative", 0.05]);
  const rigged = engine.classifySnippet("fifa.com everything is rigged", "fifa", "fifa.com");
  assert.deepEqual([rigged.status, rigged.severity], ["negative", 0.05], "a disputed ruling is not a fraud claim");
});

test("classify: endorsements are positive, off-topic text and signal-free text are dropped", () => {
  assert.equal(engine.classifySnippet("highly recommend kayak.com", "kayak", "kayak.com").type, "endorsement");
  assert.equal(engine.classifySnippet("this is a scam, totally", "kayak", "kayak.com"), null, "not about this site at all");
  assert.equal(engine.classifySnippet("kayak.com opened a new office in Berlin", "kayak", "kayak.com"), null, "on topic but no signal either way");
});

test("independence: a copy-pasted complaint is not counted as several independent reports", () => {
  const text = "kayak.com took my money and never refunded my booking, order #48213 total scam artists";
  const out = engine.applyIndependenceDiscount([ev({ status: "negative", snippet: text }), ev({ status: "negative", snippet: text + "!" }), ev({ status: "positive", snippet: text })]);
  assert.equal(out[0].independence, 1.0);
  near(out[1].independence, 0.3);
  assert.equal(out[2].independence, 1.0, "only negative evidence is discounted");
});

// ----------------------------------------------------------------------------------------------------------- aggregation

const agg = (o) => engine.aggregate({ domain: "x.com", domainIdentity: null, securityEvidence: null, sourceResults: [okSource("s")], aiJudgment: null, rawContentEvidence: [], ...o });

test("aggregate: failed sources lower CONFIDENCE, they never raise risk (missing data is not fraud)", () => {
  const out = agg({ sourceResults: [failedSource("reddit-json"), failedSource("custom-search")] });
  assert.equal(out.riskLevel, "unknown");
  assert.equal(out.riskScore, 20, "no evidence leans low-risk, not a coin flip");
  assert.equal(out.confidenceScore, 5);
  assert.deepEqual(out.unknownSources, ["reddit-json", "custom-search"]);
  assert.equal(out.trustScore, 80);
  assert.match(out.reasoning, /Sources unavailable: reddit-json, custom-search \(excluded from the analysis rather than treated as negative\)/);
});

test("aggregate: ONE fraud allegation among plenty of praise is capped - it does not become 'scam' on its own", () => {
  const fraud = ev({ status: "negative", snippet: "a", specificity: 0.9, severity: 0.9 });
  const praise = Array.from({ length: 20 }, (_, i) => ev({ type: "endorsement", status: "positive", snippet: "praise " + i, specificity: 0.3 }));
  const out = agg({ rawContentEvidence: [fraud, ...praise], sourceResults: [okSource("a"), okSource("b")] });
  assert.ok(out.riskScore < 40, `risk ${out.riskScore}`);
  assert.equal(out.riskLevel, "lowRisk");
  assert.match(out.conflictingEvidence[0], /20 positive mention\(s\) and 1 negative mention\(s\)/);
});

test("aggregate: a pattern of several independent, specific fraud reports IS high risk", () => {
  const reports = ["stole my money on order #1 total loss", "counterfeit goods shipped, receipt attached", "phishing email then charged me twice on 2024-05-01"].map((snippet) => ev({ status: "negative", snippet, specificity: 0.9, severity: 0.9 }));
  const out = agg({ rawContentEvidence: reports, sourceResults: [okSource("a")] });
  assert.equal(out.riskLevel, "highRisk");
  assert.ok(out.riskScore >= 70);
  assert.match(out.reasoning, /^High risk:.*3 specific negative report\(s\) found among 3 total/);
});

test("aggregate: the AI's own read is blended in (60% AI / 40% local content), and is one input, not the authority", () => {
  const praise = ev({ type: "endorsement", status: "positive", snippet: "p", specificity: 0.3 });
  const out = agg({ rawContentEvidence: [praise], aiJudgment: { trustScore: 90, isEstablished: true, scamCount: 0, summary: "Established." }, sourceResults: [okSource("a")] });
  assert.equal(out.riskScore, 6); // 0.6*10 + 0.4*0
  assert.equal(out.trustScore, 94);
  assert.match(out.reasoning, /AI analysis: Established\./);
  // with no content evidence at all, the AI's risk is used as-is
  assert.equal(agg({ aiJudgment: { trustScore: 30, isEstablished: false, scamCount: 2, summary: "s" } }).riskScore, 70);
});

test("aggregate: a verified official domain caps complaint noise at 45, unless the AI says it is NOT an established entity", () => {
  const many = Array.from({ length: 4 }, (_, i) => ev({ status: "negative", snippet: "took my money " + i * 7919, specificity: 0.9, severity: 0.9 }));
  const official = identity({ domainMatch: true, identityConfidence: 0.8 });
  assert.ok(agg({ rawContentEvidence: many, domainIdentity: official }).riskScore <= 45);
  assert.ok(agg({ rawContentEvidence: many, domainIdentity: official, aiJudgment: { trustScore: 20, isEstablished: false, scamCount: 3, summary: "s" } }).riskScore > 45);
});

test("aggregate: impersonation adds 35, a genuine certificate failure adds 30, a merely UNKNOWN security check adds nothing", () => {
  const base = agg({}).riskScore; // 20
  const imp = agg({ domainIdentity: identity({ domainMatch: false, possibleImpersonation: true, identityConfidence: 0.8, identifiedEntity: "kayak", officialDomainGuess: "kayak.com" }) });
  assert.equal(imp.riskScore, base + 35);
  assert.match(imp.evidence.at(-1).snippet, /does not match the identified official domain for kayak \(kayak\.com\)/);
  const cert = agg({ securityEvidence: engine.makeEvidence({ source: "security", type: "security", status: "negative", snippet: "Invalid or untrusted HTTPS certificate.", severity: 0.9 }) });
  assert.equal(cert.riskScore, base + 30);
  const unknown = agg({ securityEvidence: engine.makeEvidence({ source: "security", type: "security", status: "unknown", snippet: "Couldn't verify" }) });
  assert.equal(unknown.riskScore, base, "a blocked or failed probe is a tool failure, not a security finding");
});

test("aggregate: low confidence yields 'unknown' unless there is a strong direct signal; risk >= 70 is high regardless", () => {
  const cert = engine.makeEvidence({ source: "security", type: "security", status: "negative", snippet: "bad cert", severity: 0.9 });
  const strong = agg({ sourceResults: [failedSource("a")], securityEvidence: cert });
  assert.notEqual(strong.riskLevel, "unknown", "a certificate failure is direct evidence even when every source failed");
  assert.equal(agg({ sourceResults: [failedSource("a")] }).riskLevel, "unknown");
});

// -------------------------------------------------------------------------------------------------------- the service

const KAYAK_SNIPPETS = [
  { title: "KAYAK reviews", snippet: "Is kayak.com legit? Yes, highly recommend for flight search", link: "https://www.kayak.com/" },
  { title: "Is KAYAK a scam?", snippet: "No, kayak.com is not a scam, it is legit", link: "https://www.kayak.com/about" },
];

function makeService(over = {}) {
  const calls = { search: [], fetch: [], secure: [] };
  const deps = {
    log: () => {},
    sleep: async () => {},
    randomUA: () => "UA",
    search: async (q) => { calls.search.push(q); return KAYAK_SNIPPETS; },
    fetch: async (url, opts) => {
      calls.fetch.push({ url: String(url), opts });
      if (String(url).includes("reddit.com")) return { status: 403, json: async () => ({}), text: async () => "" };
      return { status: 200, text: async () => JSON.stringify({ answer: JSON.stringify({ isEstablished: true, score: 88, summary: "Established travel site with mostly positive feedback.", scamCount: 0 }) }) };
    },
    secureFetch: async () => ({ url: "https://kayak.com/" }),
    ...over,
  };
  return { svc: new TrustService(deps), calls };
}

test("brand: derived from the host the way iOS does it", () => {
  assert.equal(brandFrom("www.kayak.com"), "kayak");
  assert.equal(brandFrom("my-cool_site.co.uk"), "my cool site");
});

test("service: the short trusted list and the known-scam list answer instantly, with no lookups", async () => {
  const { svc, calls } = makeService();
  const g = await svc.checkDomain("www.google.com");
  assert.deepEqual([g.score, g.source, g.security], [85, "trusted-list", "Trusted platform"]);
  const s = await svc.checkDomain("onlinelegalindia.com");
  assert.deepEqual([s.score, s.source, s.security], [5, "known-scam-list", "Reported scam - avoid"]);
  assert.equal(calls.search.length + calls.fetch.length, 0);
});

test("service: a well-known site with a good reputation scores well (KAYAK, the reported false positive), source = the AI read", async () => {
  const { svc } = makeService();
  const r = await svc.checkDomain("www.kayak.com");
  assert.equal(r.source, "noah-predict");
  assert.ok(r.score >= 80, `score ${r.score}`);
  assert.equal(r.riskLevel, "lowRisk");
  assert.equal(r.security, "Established travel site with mostly positive feedback.");
  assert.deepEqual(r.issues, [r.security], "no negative evidence: the summary stands in for the mentions");
  assert.equal(r.detailedAnalysis, null, "not a deep scan");
  assert.equal(r.securityScanNotes, null);
  assert.deepEqual(r.unknownSources, ["reddit-json", "reddit-rss"], "Reddit refused (403): unknown, not negative");
});

test("service: /predict is called with the server's trust-engine contract, and the snippets are numbered into the prompt", async () => {
  const { svc, calls } = makeService();
  await svc.checkDomain("www.kayak.com");
  const predict = calls.fetch.find((c) => c.url.includes("noahai.live/predict"));
  const body = JSON.parse(predict.opts.body);
  assert.equal(body.mode, "chat");
  assert.equal(body.url, "trust-engine");
  assert.equal(body.page_content, "");
  assert.equal(body.user_agent, "Jonah-iOS-TrustEngine", "the server special-cases exactly this string");
  assert.match(body.message, /how trustworthy the website\/brand "kayak" is/);
  assert.match(body.message, /Here are up to 10 snippets of real public discussion/);
  assert.match(body.message, /1\. KAYAK reviews Is kayak\.com legit/);
  assert.match(body.message, /"score": <integer 0-100, higher = more trustworthy>/);
  assert.doesNotMatch(body.message, /detailedAnalysis/, "only a deep scan asks for it");
});

test("predict: URLs inside snippets are masked in the prompt (the server answers 'Opening the link' to any message containing one)", async () => {
  const { svc, calls } = makeService();
  await svc._analyzeWithPredict("kayak", ["see https://www.kayak.com/hotels for details", "and http://x.example/a?b=1 too"], false);
  const message = JSON.parse(calls.fetch.at(-1).opts.body).message;
  assert.doesNotMatch(message, /https?:\/\//i, "no URL may reach the server inside the prompt");
  assert.match(message, /1\. see \[link\] for details/);
  assert.match(message, /2\. and \[link\] too/);
});

test("service: when /predict fails the evidence engine still answers - it never falls back to a keyword counter", async () => {
  const { svc } = makeService({ fetch: async () => ({ status: 500, text: async () => "boom" }) });
  const r = await svc.checkDomain("www.kayak.com");
  assert.notEqual(r.source, "noah-predict");
  assert.equal(r.source, "custom-search", "the first source that produced text");
  assert.ok(r.score >= 75, "'Is KAYAK a scam? No.' must not read as a scam report even without the AI");
  assert.equal(r.riskLevel, "lowRisk");
});

test("service: every lookup failing is reported as UNVERIFIED (unknown), not as a low score", async () => {
  const boom = async () => { throw new Error("offline"); };
  const { svc } = makeService({ search: boom, fetch: boom });
  const r = await svc.checkDomain("www.kayak.com");
  assert.equal(r.riskLevel, "unknown");
  assert.equal(r.source, "evidence-engine");
  assert.ok(r.score >= 75, `a tool failure must not lower the score (got ${r.score})`);
  assert.match(r.security, /Unable to fully verify/);
  assert.equal(r.unknownSources.includes("custom-search"), true);
});

test("service: deep scan runs the certificate probe, asks for the long analysis and keeps more snippets", async () => {
  const { svc, calls } = makeService();
  const r = await svc.checkDomain("www.kayak.com", { deepScan: true });
  assert.deepEqual(r.securityScanNotes, ["Valid HTTPS connection with a trusted certificate, same domain."].map((s) => s), "same-domain probe");
  assert.ok(r.detailedAnalysis && /Confidence: \d+\/100/.test(r.detailedAnalysis));
  const body = JSON.parse(calls.fetch.find((c) => c.url.includes("noahai.live/predict")).opts.body);
  assert.match(body.message, /Here are up to 25 snippets/);
  assert.match(body.message, /"detailedAnalysis": "<3-5 sentence explanation>"/);
  assert.ok(calls.search.some((q) => /site:quora\.com/.test(q)), "deep scan also asks Quora and the review sites");
  assert.ok(calls.search.some((q) => /site:trustpilot\.com/.test(q)));
});

test("security probe: only a genuine certificate failure is negative evidence; blocks, timeouts and redirects are unknown", async () => {
  const probe = async (secureFetch) => (await makeService({ secureFetch }).svc._securityCheck("kayak.com"));
  assert.equal((await probe(async () => ({ url: "https://kayak.com/" }))).status, "positive");
  const cert = await probe(async () => { throw new TypeError("net::ERR_CERT_DATE_INVALID"); });
  assert.deepEqual([cert.status, cert.severity], ["negative", 0.9]);
  assert.equal((await probe(async () => { throw new TypeError("net::ERR_CERT_AUTHORITY_INVALID"); })).status, "negative");
  assert.equal((await probe(async () => { throw new TypeError("net::ERR_CONNECTION_TIMED_OUT"); })).status, "unknown");
  assert.equal((await probe(async () => { throw new Error("net::ERR_CONNECTION_RESET"); })).status, "unknown", "a WAF resetting an unrecognised client says nothing about security");
  const redirected = await probe(async () => ({ url: "https://www.other-domain.net/" }));
  assert.equal(redirected.status, "unknown");
  assert.match(redirected.snippet, /redirected to a different domain \(www\.other-domain\.net\)/);
});

test("domain identity: results pointing at ANOTHER domain flag impersonation; little evidence stays unknown, never suspicious", async () => {
  const fake = (links) => makeService({ search: async () => links.map((link) => ({ title: "t", snippet: "s", link })) }).svc;
  const imp = await fake(["https://www.paypal.com/a", "https://paypal.com/b", "https://paypal.com/c"])._verifyDomainIdentity("paypa1-secure.com", "paypa1 secure");
  assert.deepEqual([imp.domainMatch, imp.possibleImpersonation, imp.officialDomainGuess], [false, true, "paypal.com"]);
  const match = await fake(["https://kayak.com/a", "https://www.kayak.com/b"])._verifyDomainIdentity("kayak.com", "kayak");
  assert.equal(match.domainMatch, true);
  assert.ok(match.identityConfidence >= 0.6 && match.identityConfidence <= 0.9);
  const none = await makeService({ search: async () => [] }).svc._verifyDomainIdentity("kayak.com", "kayak");
  assert.deepEqual([none.domainMatch, none.possibleImpersonation], [null, false]);
  const split = await fake(["https://a.com/", "https://b.com/", "https://c.com/"])._verifyDomainIdentity("kayak.com", "kayak");
  assert.deepEqual([split.domainMatch, split.possibleImpersonation], [null, false], "no clear majority elsewhere: unknown, not impersonation");
});

test("domain identity: a www. host is not 'impersonating' itself (the iOS original compares the raw host and flags every www. site)", async () => {
  const svc = makeService({ search: async () => KAYAK_SNIPPETS }).svc; // results are kayak.com / www.kayak.com
  const id = await svc._verifyDomainIdentity("www.kayak.com", "kayak");
  assert.deepEqual([id.domainMatch, id.possibleImpersonation], [true, false]);
  const probe = await makeService({ secureFetch: async () => ({ url: "https://kayak.com/" }) }).svc._securityCheck("www.kayak.com");
  assert.equal(probe.status, "positive", "www <-> apex is the same domain, not 'a different domain'");
});

test("service: a check that hangs is cut off at the ceiling and reported as unverified", async () => {
  const { svc } = makeService({ search: () => new Promise(() => {}), ceilingMs: 30 });
  const r = await svc.checkDomain("www.kayak.com");
  assert.deepEqual([r.score, r.source, r.riskLevel, r.security], [60, "none", "unknown", "Check timed out"]);
  assert.deepEqual(r.unknownSources, ["all sources (timed out)"]);
});

test("predict: a 429 (server-side cooldown) or garbage is treated as 'no AI read', never as a verdict", async () => {
  for (const reply of [{ status: 429, text: async () => "{}" }, { status: 200, text: async () => "no json here" }, { status: 200, text: async () => JSON.stringify({ answer: '{"score": "high"}' }) }]) {
    const { svc } = makeService({ fetch: async (url) => (String(url).includes("reddit.com") ? { status: 403, text: async () => "" } : reply) });
    assert.equal(await svc._analyzeWithPredict("kayak", [], false), null);
  }
});

test("predict: after a 429 the AI read is skipped (no hammering) and the result says why", async () => {
  let predictCalls = 0;
  const { svc } = makeService({
    fetch: async (url) => {
      if (String(url).includes("reddit.com")) return { status: 403, text: async () => "" };
      predictCalls++;
      return { status: 429, text: async () => JSON.stringify({ error: "cooldown", cooldownRemainingSeconds: 150 }) };
    },
  });
  const first = await svc.checkDomain("www.kayak.com");
  assert.equal(predictCalls, 1);
  assert.equal(first.source, "custom-search");
  assert.match(first.notes[0], /rate-limited for about 3 more minutes.*evidence only/);
  await svc.checkDomain("www.bbc.co.uk");
  assert.equal(predictCalls, 1, "still cooling down: the server is not asked again");
});

// ---------------------------------------------------------------------------------------------- cache and controller

test("controller: only public hostnames are ever looked up", () => {
  for (const h of ["kayak.com", "www.bbc.co.uk", "a-b.example.org"]) assert.equal(isCheckableHost(h), true, h);
  for (const h of ["localhost", "127.0.0.1", "192.168.1.5", "8.8.8.8", "intranet", "printer.local", "nas.lan", "[::1]", "host:8080", "user@host.com", "", "a..b.com", ".com", "x".repeat(300) + ".com"]) assert.equal(isCheckableHost(h), false, h);
});

test("controller: results are cached per host for the session, deep scans are separate, retry bypasses, concurrent checks share one run", async () => {
  let runs = 0;
  const service = { checkDomain: async (host, { deepScan }) => { runs++; await new Promise((r) => setTimeout(r, 5)); return { score: 70, source: "noah-predict", host, deepScan }; } };
  const c = createTrustController({ service });
  const [a, b] = await Promise.all([c.check("kayak.com"), c.check("kayak.com")]);
  assert.equal(runs, 1, "two simultaneous checks of one host run once");
  assert.equal(a.result, b.result);
  assert.equal((await c.check("kayak.com")).cached, true);
  assert.equal(runs, 1);
  assert.equal((await c.check("kayak.com", { deepScan: true })).cached, false, "a quick result cannot stand in for a deep scan");
  assert.equal(runs, 2);
  assert.equal((await c.check("kayak.com", { force: true })).cached, false, "Retry check skips the cache");
  assert.equal(runs, 3);
  assert.deepEqual(await c.check("localhost"), { ok: false, skipped: true, error: "not a checkable public host" });
});

test("controller: a 'nothing was checked' result (source none) is not cached - it is usually a one-off blip", async () => {
  let runs = 0;
  const c = createTrustController({ service: { checkDomain: async () => { runs++; return { score: 60, source: "none" }; } } });
  await c.check("kayak.com");
  await c.check("kayak.com");
  assert.equal(runs, 2);
});

test("cache: entries expire so a long session still refreshes", () => {
  let now = 0;
  const cache = new TrustResultCache({ ttlMs: 1000, now: () => now });
  cache.store("a.com", { score: 1 });
  assert.equal(cache.get("a.com").score, 1);
  now = 1001;
  assert.equal(cache.get("a.com"), null);
});
