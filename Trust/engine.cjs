// Trust/engine.cjs
//
// The Trust Engine's scoring core - a line-for-line port of the iOS app's TrustEvidenceEngine.swift (Jonah_V12_iOS_UpdateTrust)
// so a site gets the same verdict on Windows as on iOS. Pure and side-effect free (no network, no clock): every function
// takes already-fetched data and returns a value, so it can be unit tested without mocking anything. Trust/service.cjs owns
// all the I/O and hands its results to this file.
//
// Two design rules carry over unchanged from the iOS engine, and are the reason it exists:
//   1. Missing evidence lowers CONFIDENCE, never raises RISK. A source that failed contributes to `unknownSources`, nothing else.
//   2. Evidence is weighted, not counted. Relevance / specificity / independence / severity all shrink a piece of evidence's
//      contribution before it may move the risk score ("Is KAYAK a scam? No." is not a scam report; "my kayak scam story" is
//      about a boat).
//
// Polarity: `riskScore` is 0-100 where HIGHER = MORE RISK; `trustScore` (what the panel shows) is 100 - riskScore.

"use strict";

/** @typedef {'positive'|'negative'|'unknown'} EvidenceStatus */
/** @typedef {'lowRisk'|'mediumRisk'|'highRisk'|'unknown'} RiskClassification */

/**
 * One piece of evidence the engine reasoned about.
 * relevance 0..1: does it concern THIS entity. specificity 0..1: concrete checkable detail vs a bare accusation.
 * independence 0..1: discounted toward 0 for near-duplicates. severity 0..1 (negative only): theft/fraud vs "slow support".
 */
function makeEvidence({ source, type, status, snippet, relevance = 1.0, specificity = 0.0, independence = 1.0, severity = 0.0 }) {
  return { source, type, status, snippet, relevance, specificity, independence, severity };
}

// ------------------------------------------------------------------------------------------------ relevance

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function containsWord(word, text) {
  try {
    return new RegExp("\\b" + escapeRegExp(word) + "\\b").test(text);
  } catch (_) {
    return text.includes(word);
  }
}

/**
 * How confidently a text is actually ABOUT the domain/brand being checked, not a coincidental word match.
 * A snippet naming the actual domain is a strong match (1.0); one containing only the bare brand word is weak (0.55), since
 * common-word brands collide with ordinary English constantly; neither present -> 0.0 (dropped entirely).
 */
function relevanceOf(text, brand, domain) {
  const lower = String(text || "").toLowerCase();
  let bareDomain = String(domain || "").toLowerCase();
  if (bareDomain.startsWith("www.")) bareDomain = bareDomain.slice(4);
  const domainRoot = bareDomain.split(".")[0] || bareDomain;
  const hasDomainMention = bareDomain.length > 0 && lower.includes(bareDomain);
  const hasBrandWord = !!brand && containsWord(String(brand).toLowerCase(), lower);
  const hasDomainRootWord = domainRoot.length > 2 && containsWord(domainRoot, lower);

  if (hasDomainMention) return 1.0;
  if (hasBrandWord || hasDomainRootWord) return 0.55;
  return 0.0;
}

// ------------------------------------------------------------------------------------- sentiment classification

const FRAUD_PHRASES = [
  "stole my money", "stole money", "never delivered", "never received my",
  "never arrived", "fake product", "counterfeit", "identity theft",
  "unauthorized charge", "charged me twice", "double charged",
  "never refunded", "did not refund", "won't refund",
  "took my money", "phishing", "cloned my card", "stole my card",
];

const CUSTOMER_SERVICE_PHRASES = [
  "slow support", "slow customer service", "long wait", "rude staff",
  "poor customer service", "bad customer service", "unhelpful support",
  "took forever to respond", "waited on hold", "hard to reach support",
  "customer service was", "support team was",
];

// A disputed call/ruling ("rigged", a biased referee) is real dissatisfaction but NOT a claim of an illegal act: scored like a
// customer-service gripe (severity near zero), never like "stole my money".
const CONTROVERSY_PHRASES = [
  "rigged", "fixed match", "biased referee", "unfair decision",
  "corrupt officiating", "favoritism", "match was fixed",
];

const POSITIVE_PHRASES = [
  "highly recommend", "great experience", "arrived on time", "worked perfectly",
  "no issues", "smooth process", "excellent service", "fast delivery",
  "as described", "would use again", "safe to use",
];

// Bare words that mean something only when NOT negated nearby (see negationNear).
const RISK_WORDS = ["scam", "fraud", "fake", "rip off", "ripoff", "scammed", "fraudulent"];
const LEGITIMACY_WORDS = ["legit", "legitimate", "trustworthy", "trusted", "safe", "reliable"];

const NEGATION_CUES = [
  "not", "isn't", "is not", "wasn't", "aren't", "no,", "no.", " no ",
  "never", "n't", "far from", "hardly", "nothing but", "doesn't seem",
];

/** True if a negation cue appears within a short window before OR after `index` - covers "not a scam" and "is it a scam? No". */
function negationNear(text, index, windowChars = 40) {
  const start = Math.max(0, index - windowChars);
  const end = Math.min(text.length, index + windowChars);
  const window = text.slice(start, end);
  return NEGATION_CUES.some((cue) => window.includes(cue));
}

const SPECIFICITY_PATTERNS = [
  /\$\d+/, /\d{1,2}\/\d{1,2}\/\d{2,4}/, /\d{4}-\d{2}-\d{2}/,
  /order\s*#?\s*\d+/, /booking\s*#?\s*\w*\d+/,
  /confirmation\s*#?\s*\w*\d+/, /transaction\s*#?\s*\w*\d+/,
];

function containsSpecificityMarkers(text) {
  if (SPECIFICITY_PATTERNS.some((re) => re.test(text))) return true;
  return ["booking number", "order number", "confirmation number", "screenshot", "receipt"].some((p) => text.includes(p));
}

/**
 * Classify one snippet of public text into Evidence, or null when it is not about this brand/domain at all (relevance 0) or
 * carries no signal either way. Deliberately NOT `contains("scam") -> SCAM`: every risk-word hit is first checked for a nearby
 * negation, then classified as a specific fraud claim (much more severe) or a bare accusation (weak evidence on its own).
 */
function classifySnippet(text, brand, domain) {
  const relevance = relevanceOf(text, brand, domain);
  if (!(relevance > 0.0)) return null;
  const lower = String(text).toLowerCase();
  const snippet = String(text).slice(0, 240);

  if (FRAUD_PHRASES.some((p) => lower.includes(p))) {
    return makeEvidence({ source: "review", type: "complaint", status: "negative", snippet, relevance, specificity: containsSpecificityMarkers(lower) ? 0.9 : 0.65, severity: 0.9 });
  }

  let sawUnnegatedRiskWord = false;
  let sawNegatedRiskWord = false;
  for (const word of RISK_WORDS) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(word, from);
      if (at === -1) break;
      if (negationNear(lower, at)) sawNegatedRiskWord = true;
      else sawUnnegatedRiskWord = true;
      from = at + word.length;
    }
  }
  if (sawUnnegatedRiskWord) {
    return makeEvidence({ source: "review", type: "complaint", status: "negative", snippet, relevance, specificity: containsSpecificityMarkers(lower) ? 0.6 : 0.15, severity: 0.45 });
  }
  if (sawNegatedRiskWord) {
    // "Is X a scam? No." is itself mild reassurance, not silence.
    return makeEvidence({ source: "review", type: "reassurance", status: "positive", snippet, relevance, specificity: 0.2, severity: 0.0 });
  }

  if (CUSTOMER_SERVICE_PHRASES.some((p) => lower.includes(p))) {
    // Real feedback, but a support-quality complaint is not fraud evidence: negative with severity near zero.
    return makeEvidence({ source: "review", type: "complaint", status: "negative", snippet, relevance, specificity: 0.3, severity: 0.05 });
  }
  if (CONTROVERSY_PHRASES.some((p) => lower.includes(p))) {
    return makeEvidence({ source: "review", type: "complaint", status: "negative", snippet, relevance, specificity: 0.2, severity: 0.05 });
  }
  if (LEGITIMACY_WORDS.some((w) => lower.includes(w)) || POSITIVE_PHRASES.some((p) => lower.includes(p))) {
    return makeEvidence({ source: "review", type: "endorsement", status: "positive", snippet, relevance, specificity: 0.3, severity: 0.0 });
  }
  return null;
}

// -------------------------------------------------------------------------------------------- independence

const wordSet = (text) => new Set(String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));

function jaccard(a, b) {
  if (!a.size || !b.size) return 0.0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0.0 : inter / union;
}

/**
 * Discounts near-duplicate NEGATIVE evidence toward independence 0.1: the same complaint copy-pasted or syndicated across
 * several sources must not count as several independent reports (word-overlap similarity, since syndicated text is rarely
 * byte-identical).
 */
function applyIndependenceDiscount(evidence) {
  const result = evidence.map((e) => ({ ...e }));
  for (let i = 0; i < result.length; i++) {
    if (result[i].status !== "negative") continue;
    const wordsI = wordSet(result[i].snippet);
    for (let j = 0; j < i; j++) {
      if (result[j].status !== "negative") continue;
      if (jaccard(wordsI, wordSet(result[j].snippet)) > 0.6) {
        result[i].independence = Math.max(0.1, result[i].independence * 0.3);
        break;
      }
    }
  }
  return result;
}

// ------------------------------------------------------------------------------------------------ aggregation

/** How much one piece of evidence contributes after weighting - never a flat "+1 per hit". */
function weightOf(e) {
  return e.relevance * e.independence * (0.25 + 0.75 * e.specificity) * (e.status === "negative" ? 0.2 + 0.8 * e.severity : 1.0);
}

/**
 * Combines everything gathered about one domain into a calibrated TrustAnalysis.
 *
 * A lone strong accusation is capped (one detailed fraud allegation is real evidence but not a pattern), three or more
 * credible ones are weighted UP. Confidence is computed independently of risk: how much of the evidence pipeline actually
 * worked, not which way the evidence points - so an unknown site lands at low-risk/low-confidence (or `unknown`), never
 * high-risk/low-confidence.
 *
 * @param {object} p
 * @param {string} p.domain
 * @param {{domainMatch:(boolean|null), possibleImpersonation:boolean, identityConfidence:number, identifiedEntity?:string, officialDomainGuess?:string}|null} p.domainIdentity
 * @param {object|null} p.securityEvidence
 * @param {{source:string, succeeded:boolean, texts:string[]}[]} p.sourceResults
 * @param {{trustScore:number, isEstablished:(boolean|null|undefined), scamCount:number, summary:string}|null} p.aiJudgment
 * @param {object[]} p.rawContentEvidence
 */
function aggregate({ domain, domainIdentity, securityEvidence, sourceResults, aiJudgment, rawContentEvidence }) {
  const unknownSources = sourceResults.filter((s) => !s.succeeded).map((s) => s.source);
  const contentEvidence = applyIndependenceDiscount(rawContentEvidence);

  const negatives = contentEvidence.filter((e) => e.status === "negative");
  const positives = contentEvidence.filter((e) => e.status === "positive");

  const negativeWeights = negatives.map(weightOf).sort((a, b) => b - a);
  const positiveWeight = positives.reduce((sum, e) => sum + weightOf(e), 0.0);

  const highConfidenceNegativeCount = negativeWeights.filter((w) => w > 0.5).length;
  let negativeWeightTotal = negativeWeights.reduce((a, b) => a + b, 0.0);
  if (highConfidenceNegativeCount <= 1) {
    negativeWeightTotal = Math.min(negativeWeightTotal, 0.6); // one accusation, nothing corroborating it: capped
  } else if (highConfidenceNegativeCount >= 3) {
    negativeWeightTotal *= 1.35; // a genuine pattern of independent, specific reports: weighted up
  }

  const totalContentWeight = negativeWeightTotal + positiveWeight;
  // No usable content evidence either way: "missing data != fraud", so it leans low-risk rather than a 50/50 coin flip.
  const localContentRisk = totalContentWeight <= 0.0 ? 20.0 : Math.min(100.0, Math.max(0.0, (100.0 * negativeWeightTotal) / (totalContentWeight + 1.0)));

  const aiRisk = aiJudgment ? 100.0 - aiJudgment.trustScore : null;
  let combinedContentRisk;
  if (aiRisk !== null && totalContentWeight > 0.0) combinedContentRisk = 0.6 * aiRisk + 0.4 * localContentRisk;
  else if (aiRisk !== null) combinedContentRisk = aiRisk;
  else combinedContentRisk = localContentRisk;

  // Established-entity dampening: if the domain-identity check independently found this to be the organisation's own
  // official domain, ordinary complaint noise alone must not push risk into scam territory.
  const isVerifiedOfficialDomain = !!domainIdentity && domainIdentity.domainMatch === true && (domainIdentity.identityConfidence || 0) >= 0.55;
  if (isVerifiedOfficialDomain && !(aiJudgment && aiJudgment.isEstablished === false)) {
    combinedContentRisk = Math.min(combinedContentRisk, 45.0);
  }

  let riskScore = combinedContentRisk;

  const conflictingEvidence = [];
  if (negatives.length && positives.length) {
    conflictingEvidence.push(`${positives.length} positive mention(s) and ${negatives.length} negative mention(s) were both found - evidence is mixed, not one-sided.`);
  }

  const evidence = [...contentEvidence];

  // Domain identity is direct, technical-ish evidence: weighted more heavily than any single review.
  if (domainIdentity) {
    if (domainIdentity.possibleImpersonation && domainIdentity.identityConfidence >= 0.6) {
      riskScore += 35.0;
      evidence.push(makeEvidence({
        source: "domain_identity", type: "impersonation", status: "negative",
        snippet: `Current domain (${domain}) does not match the identified official domain for ${domainIdentity.identifiedEntity || "this entity"} (${domainIdentity.officialDomainGuess || "unknown"}).`,
        relevance: 1.0, specificity: domainIdentity.identityConfidence, severity: 0.9,
      }));
    } else if (domainIdentity.domainMatch === true) {
      evidence.push(makeEvidence({
        source: "domain_identity", type: "verified", status: "positive",
        snippet: `Domain matches the identified official domain for ${domainIdentity.identifiedEntity || "this entity"}.`,
        relevance: 1.0, specificity: domainIdentity.identityConfidence,
      }));
    }
  }

  // Security evidence: only a genuine cert/trust failure counts as negative. A blocked/failed attempt is `unknown`.
  if (securityEvidence) {
    evidence.push(securityEvidence);
    if (securityEvidence.status === "negative") riskScore += 30.0;
  }

  riskScore = Math.min(100.0, Math.max(0.0, riskScore));

  // Confidence: how complete/reliable the evidence-gathering was, independent of which way riskScore leans.
  const totalSources = Math.max(1, sourceResults.length);
  const sourceSuccessRatio = sourceResults.filter((s) => s.succeeded).length / totalSources;
  const evidenceVolumeFactor = Math.min(1.0, contentEvidence.length / 6.0);
  const aiFactor = aiJudgment ? 1.0 : 0.0;
  const identityFactor = domainIdentity && domainIdentity.domainMatch !== null && domainIdentity.domainMatch !== undefined ? domainIdentity.identityConfidence || 0 : 0.0;
  let confidenceScore = 100.0 * (0.35 * sourceSuccessRatio + 0.25 * aiFactor + 0.25 * evidenceVolumeFactor + 0.15 * identityFactor);
  confidenceScore = Math.min(95.0, Math.max(5.0, confidenceScore));

  const hasStrongDirectSignal = (!!domainIdentity && domainIdentity.possibleImpersonation === true && (domainIdentity.identityConfidence || 0) >= 0.6)
    || (!!securityEvidence && securityEvidence.status === "negative");

  let riskLevel;
  if (riskScore >= 70.0) riskLevel = "highRisk";
  else if (confidenceScore < 35.0 && !hasStrongDirectSignal) riskLevel = "unknown";
  else if (riskScore >= 40.0) riskLevel = "mediumRisk";
  else riskLevel = "lowRisk";

  const reasoning = buildReasoning({
    riskLevel, confidenceScore: Math.trunc(confidenceScore), negatives, positives, unknownSources, domainIdentity, securityEvidence, aiJudgment,
  });

  const roundedRisk = Math.round(riskScore);
  return {
    riskLevel,
    riskScore: roundedRisk,
    confidenceScore: Math.round(confidenceScore),
    evidence,
    unknownSources,
    conflictingEvidence,
    reasoning,
    /** Backward-compatible 0-100 trust score (higher = more trustworthy), what the panel shows. */
    trustScore: Math.max(0, Math.min(100, 100 - roundedRisk)),
  };
}

function buildReasoning({ riskLevel, confidenceScore, negatives, positives, unknownSources, domainIdentity, securityEvidence, aiJudgment }) {
  const parts = [];
  switch (riskLevel) {
    case "highRisk": parts.push("High risk: specific, credible evidence of fraudulent or malicious behavior was found."); break;
    case "mediumRisk": parts.push("Medium risk: some concerning evidence was found, but it is not conclusive."); break;
    case "lowRisk": parts.push("Low risk: no meaningful evidence of fraud or malicious behavior was found."); break;
    default: parts.push("Unable to fully verify: reputation sources were largely unavailable, and there is no strong independent evidence either way.");
  }
  if (negatives.length) {
    const strongCount = negatives.filter((e) => weightOf(e) > 0.5).length;
    parts.push(strongCount > 0
      ? `${strongCount} specific negative report(s) found among ${negatives.length} total negative mention(s).`
      : `${negatives.length} negative mention(s) found, but none were specific or well-corroborated.`);
  }
  if (positives.length) parts.push(`${positives.length} positive mention(s) found.`);
  if (unknownSources.length) parts.push(`Sources unavailable: ${unknownSources.join(", ")} (excluded from the analysis rather than treated as negative).`);
  if (domainIdentity) {
    if (domainIdentity.possibleImpersonation) parts.push(`Domain does not match the identified official domain for ${domainIdentity.identifiedEntity || "this entity"}.`);
    else if (domainIdentity.domainMatch === true) parts.push(`Domain matches the identified official domain for ${domainIdentity.identifiedEntity || "this entity"}.`);
  }
  if (securityEvidence && securityEvidence.status === "negative") parts.push(`Security check failed: ${securityEvidence.snippet}`);
  if (aiJudgment) parts.push(`AI analysis: ${aiJudgment.summary}`);
  parts.push(`Confidence: ${confidenceScore}/100.`);
  return parts.join(" ");
}

module.exports = {
  makeEvidence, relevanceOf, classifySnippet, applyIndependenceDiscount, aggregate, weightOf,
  // exported for the tests / service
  containsSpecificityMarkers, negationNear,
};
