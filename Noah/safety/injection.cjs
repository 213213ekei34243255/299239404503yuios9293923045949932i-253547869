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
  // "New instructions:" and also "New instructions from the maintainer:" (the optional from/by/for phrase is what the plain form missed)
  { id: "new_instructions", weight: 3, re: /\b(new|updated|additional|revised|real|actual|secret) (instructions?|task|objective|goal|directive)s?\b(?:\s+(?:from|by|for)\s+[^.\n:\-]{1,30})?\s*[:\-]/i },
  { id: "system_prompt", weight: 3, re: /\b(system prompt|developer message|system message|your (?:hidden |secret )?(?:instructions|guidelines|rules|programming)|you are (?:now |actually )?(?:an? )?(?:ai|assistant|agent|chatgpt|claude|gemini|language model))\b/i },
  { id: "role_markup", weight: 4, re: /(^|\n)\s*(system|assistant|developer|user)\s*:|<\s*\/?\s*(system|assistant|instructions?|tool_?call|function_?call)\s*>|\[\s*\/?(system|inst)\s*\]|<\|(im_start|im_end|system)\|>/i },
  { id: "addresses_agent", weight: 3, re: /\b(ai|assistant|agent|llm|language model|noah|claude|gpt|gemini|comet|copilot)\b[\s,:;-]{1,3}(?:please\s+)?(?:you\s+(?:must|should|need to|will)|must now|now|immediately|first)\b/i },
  { id: "exfiltration", weight: 6, re: /\b(send|post|forward|upload|email|e-mail|submit|exfiltrate|leak|transmit|copy|paste|type|enter)\b[^.\n]{0,60}\b(cookies?|passwords?|tokens?|credentials?|api[ _-]?keys?|session|secrets?|private key|ssh|history|clipboard|contacts|otp|one[- ]time|credit card|card number|cvv|ssn)\b/i },
  { id: "navigate_command", weight: 2, re: /\b(navigate|go|visit|open|fetch|load|browse|redirect)\s+(?:to\s+|the (?:url|link|page)\s+)?https?:\/\/\S+/i },
  // hiding it from the user: "do not tell the user", and also "do not mention this note" (a note/message/comment/section about itself)
  { id: "concealment", weight: 6, re: /\b(do not|don't|never|without)\b[^.\n]{0,12}\b(tell|inform|mention|reveal|show|notify|alert|ask)\b[^.\n]{0,20}\b(the )?(user|human|owner|person|(?:this|that|these|those|the) (?:notes?|messages?|comments?|instructions?|sections?)\b)/i },
  // a note addressed to the AI that reads the page/file: "NOTE TO THE AI ASSISTANT", "instructions for any agent"
  { id: "note_to_ai", weight: 3, re: /\b(notes?|messages?|notices?|instructions?|attention|important|warning|reminder|requests?)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+|an?\s+)?(?:ai|a\.i\.|llms?|language models?|assistants?|agents?|bots?|copilot|claude|gemini|gpt|chatgpt|noah)\b/i },
  // cancelling what the user asked: "the user's instructions are outdated"
  { id: "instructions_outdated", weight: 5, re: /\b(?:the\s+)?(?:user['’]?s?|original|previous|earlier|old|above)\s+(?:instructions?|requests?|tasks?|prompts?|rules?)\s+(?:is|are|was|were)\s+(?:now\s+)?(?:outdated|obsolete|wrong|invalid|void|cancell?ed|superseded|incorrect|overridden|no longer (?:valid|needed|relevant))\b/i },
  // telling the AI to report a result that is not true: "then tell the user that all tests pass"
  { id: "false_report", weight: 4, re: /\b(tell|say|report|claim|state|inform)\b[^.\n]{0,20}\b(?:the )?(?:user|human)\b[^.\n]{0,30}\b(?:that )?(?:everything|all (?:the )?(?:tests?|checks?)|it)\b[^.\n]{0,15}\b(?:pass(?:ed|es)?|work(?:s|ed)?|succe(?:ed|eded|ss))/i },
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
  // Text a person cannot see (same colour as the background, transparent, tiny, off-screen: the observer reports it as source "hidden_text") has no innocent reason to
  // sound like an instruction to an AI. ANY instruction-like finding in it taints the task by itself; a large amount of hidden text is a smaller signal on its own.
  const hidden = findings.filter((f) => f.source === "hidden_text");
  if (hidden.length) findings.push({ id: "hidden_instruction", weight: TAINT_THRESHOLD, source: "hidden_text", excerpt: hidden[0].excerpt });
  else {
    const big = pairs.find(([source, text]) => source === "hidden_text" && String(text || "").length >= 200);
    if (big) findings.push({ id: "hidden_text_large", weight: 2, source: "hidden_text", excerpt: `${String(big[1]).length} characters of text a person cannot see` });
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
