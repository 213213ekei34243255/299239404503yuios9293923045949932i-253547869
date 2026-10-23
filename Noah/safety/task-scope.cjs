// Noah/safety/task-scope.cjs
//
// Two questions the action gate asks that do not depend on what the model says:
//
//   readOnlyGoal(goal)     did the user only ask Noah to READ or LOOK SOMETHING UP? ("summarize this page", "find the opening hours", "what does X cost")
//                          Such a task has no reason to upload, download, paste, fill in a form, log in or send anything. If the page steers it that way anyway
//                          (an injected instruction), the action is the mismatch: it is held for the user's OK (risk.cjs, category "task_mismatch").
//   outboundCarry(url, …)  is this a jump to a site the task never named and never visited, with a long piece of data riding in the address? That is how text read
//                          off a page leaves it, so it is held for the user's OK (category "outbound_carry") even when nothing looked suspicious.
//
// Pure functions, no model. Heuristics on purpose: they only ever ADD a question; they never remove one the other rules ask.

"use strict";

const { hostMatches } = require("./url-guard.cjs");

const READ_WORDS = /\b(summari[sz]e|summary|read|find|look(?:\s+|-)?up|search(?:\s+for)?|what(?:'s|\s+is|\s+are|\s+does)?|who|when|where|which|how\s+(?:much|many|long|old|do|does)|compare|check|tell\s+me|list|show\s+me|explain|describe|review|research|price|cost|hours|weather|news|define|translate|extract|collect|gather)\b/i;
// anything that writes to a site, signs in, spends, sends, or moves a file: a goal containing one of these is NOT read-only
const DOING_WORDS = /\b(send|post|publish|reply|comment|email|e-?mail|message|dm|share|tweet|book|reserve|buy|purchase|order|pay|checkout|subscribe|sign\s*(?:up|in|on)|log\s*(?:in|into)|login|register|apply|submit|fill(?:\s+(?:in|out))?|enter|type|upload|attach|download|save|install|delete|remove|cancel|create|add|write|edit|update|change|set|configure|transfer|donate|vote|like|follow|connect|authori[sz]e|approve|accept)\b/i;

function readOnlyGoal(goal) {
  const g = String(goal || "").trim();
  if (!g || g.length > 600) return false;
  return READ_WORDS.test(g) && !DOING_WORDS.test(g);
}

/** Host names written in the goal ("on example.com", "https://docs.example.org/x"). */
function goalHosts(goal) {
  const out = new Set();
  const text = String(goal || "");
  for (const m of text.matchAll(/(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:[/?#][^\s]*)?/gi)) out.add(m[1].toLowerCase().replace(/^www\./, ""));
  return out;
}

const LONG_VALUE = 60;

/** Does the address carry a long value in its query or fragment? (a normal search query or page id is far shorter) */
function carriesLongValue(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const parts = [];
    for (const [, v] of u.searchParams) parts.push(v);
    const frag = u.hash.replace(/^#/, "");
    if (frag) { if (frag.includes("=")) for (const [, v] of new URLSearchParams(frag)) parts.push(v); else parts.push(frag); }
    return parts.some((v) => v.length >= LONG_VALUE);
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} rawUrl
 * @param {{ visited: Set<string>, goalHosts: Set<string> }} scope  origins already loaded in this task, hosts the goal named
 */
function outboundCarry(rawUrl, { visited = new Set(), goalHosts: named = new Set() } = {}) {
  let u;
  try { u = new URL(rawUrl); } catch (_) { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (visited.has(u.origin)) return false;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const h of named) if (hostMatches(host, h)) return false;
  return carriesLongValue(rawUrl);
}

module.exports = { readOnlyGoal, goalHosts, carriesLongValue, outboundCarry, LONG_VALUE };
