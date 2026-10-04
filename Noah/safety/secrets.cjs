// Noah/safety/secrets.cjs
//
// What the user types back to a mission ("here is the key: sk-...") goes into the next message to the model provider and into the mission's
// checkpoint on disk. A secret must never take that road, so a reply is cleaned BEFORE either: anything that looks like a key or token is
// replaced by a marker and the user is told. Noah never needs the value: the project loads its own secrets from its own .env.
//
// Heuristic, not a guarantee: it recognises the common key formats, credential-named assignments (API_KEY=...), and, when the mission has
// just ASKED for a secret, any long opaque token in the reply. A secret in an unusual shape can slip through, which is why the prompt also
// tells the model never to ask for a secret in the first place.

"use strict";

const MARK = "[secret removed]";

// well-known formats (the same families safety/risk.cjs refuses to type into a web page)
const KNOWN = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, // JWT
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}/g, // OpenAI / Stripe / Anthropic / OpenRouter style
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abeposr]-[A-Za-z0-9-]{10,}/g,
];
// NAME=value / NAME: value, where NAME looks like a credential: the value goes, the name stays (so the sentence still makes sense)
const ASSIGNED = /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|credential|auth)[A-Za-z0-9_.-]*)(\s*(?:(?:is|was)\s*)?[:=]\s*)(?:(["'])([^"'\r\n]{4,})\3|([^\s"']{3,}[^\s"',;.!?)\]}]))/gi; // quoted: up to the closing quote (a password may end in "!"); unquoted: cannot end in sentence punctuation ("key=abc123, region=eu" keeps its comma)
// when a secret was just asked for: a long opaque word (not an English word, not a path or URL)
const OPAQUE = /^[A-Za-z0-9_\-+/=.:]{12,}$/;
const NOT_A_SECRET = /^(?:https?:|file:|[A-Za-z]:[\\/]|\.{0,2}[\\/]|~[\\/]|www\.)/i;

/**
 * @param {string} text
 * @param {{ askedForSecret?: boolean }} [o]  true when the question this answers was about a key, password, token or secret
 * @returns {{ text: string, found: number }}
 */
function redactSecrets(text, { askedForSecret = false } = {}) {
  let s = String(text ?? "");
  let found = 0;
  for (const re of KNOWN) s = s.replace(re, () => { found++; return MARK; });
  s = s.replace(ASSIGNED, (m, name, sep, q) => { found++; return `${name}${sep}${q || ""}${MARK}${q || ""}`; });
  if (askedForSecret) {
    s = s.split(/(\s+)/).map((tok) => {
      if (!tok || /^\s+$/.test(tok) || tok.includes(MARK)) return tok;
      const bare = tok.replace(/^[("'`]+|[)"'`.,;!?]+$/g, ""); // punctuation around a pasted value is not part of it
      if (!OPAQUE.test(bare) || NOT_A_SECRET.test(bare)) return tok;
      if (!(/\d/.test(bare) || /[-_]/.test(bare) || bare.length >= 24)) return tok; // a long plain word like "configuration" is just a word
      found++;
      return tok.replace(bare, MARK);
    }).join("");
  }
  return { text: s, found };
}

/** Does a question (the mission's own words) ask the user for a secret? */
function asksForSecret(question) {
  return /\b(api[ _-]?key|secret|token|password|passwd|credential|private key|access key|auth(?:entication)? (?:key|code)|\bkey\b|[A-Z][A-Z0-9_]*_KEY\b)/i.test(String(question || ""));
}

module.exports = { redactSecrets, asksForSecret, MARK };
