// Noah/safety/injection.cjs
//
// Indirect prompt-injection handling. The web page is UNTRUSTED INPUT; it can
// never redefine Noah's instructions. Defence is layered:
//
//   1. Structural: page content reaches the model only inside nonce-delimited
//      <untrusted_page_content> blocks, and the system prompt states the trust
//      hierarchy (see agent/prompts.cjs).
//   2. Detection (this file): heuristic scanning of everything that enters the
//      model context (text, element names, titles, URLs). It never blocks
//      reading; it raises a *taint* flag and annotates findings.
//   3. Enforcement (safety/policy.cjs): once a task is tainted, actions that
//      transmit data or leave the current origin need explicit confirmation,
//      independent of what the model says. Heuristics can be evaded, which is
//      why enforcement does not depend on them being right.

"use strict";

const PATTERNS = [
  { id: "ignore_previous", weight: 5, re: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|directions?|guidelines?|messages?)/i },
  { id: "new_instructions", weight: 3, re: /\b(new|updated|additional|real|actual|secret) (instructions?|task|objective|goal|directive)s?\b\s*[:\-]/i },
  { id: "system_prompt", weight: 3, re: /\b(system prompt|developer message|system message|your (?:hidden |secret )?(?:instructions|guidelines|rules|programming)|you are (?:now |actually )?(?:an? )?(?:ai|assistant|agent|chatgpt|claude|gemini|language model))\b/i },
  { id: "role_markup", weight: 4, re: /(^|\n)\s*(system|assistant|developer|user)\s*:|<\s*\/?\s*(system|assistant|instructions?|tool_?call|function_?call)\s*>|\[\s*\/?(system|inst)\s*\]|<\|(im_start|im_end|system)\|>/i },
  { id: "addresses_agent", weight: 3, re: /\b(ai|assistant|agent|llm|language model|noah|claude|gpt|gemini|comet|copilot)\b[\s,:;-]{1,3}(?:please\s+)?(?:you\s+(?:must|should|need to|will)|must now|now|immediately|first)\b/i },
  { id: "exfiltration", weight: 6, re: /\b(send|post|forward|upload|email|e-mail|submit|exfiltrate|leak|transmit|copy|paste|type|enter)\b[^.\n]{0,60}\b(cookies?|passwords?|tokens?|credentials?|api[ _-]?keys?|session|secrets?|private key|ssh|history|clipboard|contacts|otp|one[- ]time|credit card|card number|cvv|ssn)\b/i },
  { id: "navigate_command", weight: 2, re: /\b(navigate|go|visit|open|fetch|load|browse|redirect)\s+(?:to\s+|the (?:url|link|page)\s+)?https?:\/\/\S+/i },
  { id: "concealment", weight: 6, re: /\b(do not|don't|never|without)\b[^.\n]{0,12}\b(tell|inform|mention|reveal|show|notify|alert|ask)\b[^.\n]{0,20}\b(the )?(user|human|owner|person)/i },
  { id: "urgency_authority", weight: 3, re: /\b(urgent|immediately|critical|mandatory|required)\b[^.\n]{0,40}\b(you must|the assistant|the agent|the ai)\b/i },
  { id: "purchase_command", weight: 4, re: /\b(buy|purchase|order|checkout|pay|transfer|wire|donate|subscribe)\b[^.\n]{0,40}\b(now|immediately|silently|without (?:asking|confirmation))/i },
  { id: "delete_command", weight: 4, re: /\b(delete|erase|wipe|remove|close)\b[^.\n]{0,30}\b(all|every|account|files?|emails?|data|history)\b[^.\n]{0,25}\b(now|immediately|without)/i },
  { id: "hidden_markers", weight: 5, re: /\b(begin|start|end) (?:of )?(?:hidden|secret|system|injected) (?:instructions?|prompt|section)\b/i },
  { id: "jailbreak", weight: 5, re: /\b(jailbreak|DAN mode|developer mode (?:enabled|on)|no restrictions|unfiltered mode)\b/i },
  { id: "permission_claim", weight: 5, re: /\b(the user (?:has )?(?:already )?(?:authori[sz]ed|approved|consented|allowed|confirmed|requested)|authori[sz]ed by (?:the )?(?:user|admin|anthropic|openai|perplexity|google)|admin(?:istrator)? override|(?:this is a )?test mode|pre-?approved)\b/i },
];

const ZERO_WIDTH = /[​-‏⁠⁡-⁤﻿­]/g;
const TAINT_THRESHOLD = 5;

function excerpt(text, index, len) {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + len + 60);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** Scan one string. Returns findings only (no side effects). */
function scan(text, source = "page") {
  const out = [];
  if (!text || typeof text !== "string") return out;
  const s = text.length > 60000 ? text.slice(0, 60000) : text;
  for (const p of PATTERNS) {
    const m = p.re.exec(s);
    if (m) out.push({ id: p.id, weight: p.weight, source, excerpt: excerpt(s, m.index, m[0].length) });
  }
  const zw = s.match(ZERO_WIDTH);
  if (zw && zw.length >= 8) out.push({ id: "hidden_characters", weight: 2, source, excerpt: `${zw.length} zero-width/invisible characters` });
  return out;
}

/** Scan several [source, text] pairs and aggregate. */
function scanMany(pairs) {
  const findings = [];
  const seen = new Set();
  for (const [source, text] of pairs) {
    for (const f of scan(text, source)) {
      const key = `${f.id}|${f.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(f);
    }
  }
  const score = findings.reduce((n, f) => n + f.weight, 0);
  return { findings: findings.slice(0, 12), score, tainted: score >= TAINT_THRESHOLD };
}

/** Remove characters that hide content from humans but not from models. */
function neutralize(text) {
  return String(text || "").replace(ZERO_WIDTH, "");
}

/**
 * Wrap untrusted text so it cannot terminate its own delimiter or impersonate
 * a role. `nonce` is random per task and never appears in page content.
 */
function wrapUntrusted(source, text, nonce) {
  const body = neutralize(text).replace(/<\/?\s*untrusted_page_content[^>]*>/gi, "[tag removed]");
  return `<untrusted_page_content nonce="${nonce}" source="${source}">\n${body}\n</untrusted_page_content nonce="${nonce}">`;
}

module.exports = { scan, scanMany, neutralize, wrapUntrusted, PATTERNS, TAINT_THRESHOLD };
