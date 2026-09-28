// Noah/safety/url-guard.cjs
//
// Hard boundaries on where the AGENT may navigate. Enforced in code, after the
// model has spoken and before anything touches the browser (Comet-style
// isUrlBlocked). The scheme is checked with a URL parser, not a string prefix,
// and the same check is re-applied after redirects (see browser controller).

"use strict";

const net = require("net");
const { DRAWING_TOOL_URL } = require("../models/draw-goal.cjs");

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

// The ONE, single, hardcoded exception to "http/https only": Jonah's own bundled drawing tool (see draw-goal.cjs's
// header comment for why this is safe - it is never built from a URL a model or a page supplies, so this does not
// give the agent general file:// access; only this one exact URL). Compared against the PARSED/reserialized form so
// this can never be tricked by a string that merely starts with the right text.
let drawingToolNormalized = null;
try {
  drawingToolNormalized = new URL(DRAWING_TOOL_URL).toString();
} catch (_) {
  /* leave null: the exception simply never matches */
}

function isPrivateHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  const kind = net.isIP(h);
  if (kind === 4) {
    const [a, b] = h.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (kind === 6) {
    return h === "::1" || h === "::" || /^f[cd]/i.test(h) || /^fe[89ab]/i.test(h) || /^::ffff:(10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\./i.test(h);
  }
  // numeric / hex / octal IPv4 obfuscation (e.g. http://2130706433/)
  if (/^(0x[0-9a-f]+|\d+)$/i.test(h)) return true;
  return false;
}

function hostMatches(host, pattern) {
  const p = String(pattern).toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!p) return false;
  const h = host.toLowerCase();
  if (p.startsWith("*.")) return h === p.slice(2) || h.endsWith(p.slice(1));
  return h === p || h.endsWith("." + p);
}

/**
 * @param {string} rawUrl
 * @param {object} policy
 * @param {string[]} [policy.allowedDomains]   if non-empty, ONLY these hosts (and subdomains)
 * @param {string[]} [policy.blockedDomains]   always blocked
 * @param {boolean}  [policy.allowLocalhost]   allow loopback/private ranges (tests, local dev)
 * @returns {{ allowed: boolean, url?: string, reason?: string, code?: string, host?: string }}
 */
function checkNavigation(rawUrl, policy = {}) {
  let text = String(rawUrl || "").trim();
  if (!text) return { allowed: false, code: "empty", reason: "empty URL" };
  if (/^(back|forward|reload)$/i.test(text)) return { allowed: true, url: text.toLowerCase(), history: true };
  if (text === "about:blank") return { allowed: true, url: text, host: "" };
  // A URL without a scheme is https:// (Anthropic browser-use guidance). Do not guess other schemes.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text) || /^[a-z0-9.-]+:\d+(\/|$)/i.test(text)) text = "https://" + text.replace(/^\/\//, "");
  let u;
  try {
    u = new URL(text);
  } catch (_) {
    return { allowed: false, code: "invalid", reason: `"${rawUrl}" is not a valid URL` };
  }
  if (u.protocol === "file:" && drawingToolNormalized && u.toString() === drawingToolNormalized) {
    return { allowed: true, url: u.toString(), host: "" };
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) {
    return { allowed: false, code: "scheme", reason: `scheme "${u.protocol}" is not allowed (only http/https). Blocked: ${u.protocol}` };
  }
  if (u.username || u.password) return { allowed: false, code: "userinfo", reason: "URLs with embedded credentials (user:pass@) are not allowed" };
  const host = u.hostname.toLowerCase();
  if (!policy.allowLocalhost && isPrivateHost(host)) {
    return { allowed: false, code: "private_host", reason: `"${host}" is a local/private address; Noah does not browse local or internal network services`, host };
  }
  for (const b of policy.blockedDomains || []) {
    if (hostMatches(host, b)) return { allowed: false, code: "blocked_domain", reason: `${host} is on the blocked domain list`, host };
  }
  const allow = policy.allowedDomains || [];
  if (allow.length && !allow.some((a) => hostMatches(host, a))) {
    return { allowed: false, code: "not_allowlisted", reason: `${host} is not on the allowed domain list`, host };
  }
  return { allowed: true, url: u.toString(), host, origin: u.origin };
}

/** Cookie-exfiltration check: does an outgoing URL/text contain a live cookie value? */
function containsCookieValue(text, cookieValues) {
  const t = String(text || "");
  if (t.length < 16) return false;
  for (const v of cookieValues || []) {
    if (v && v.length >= 16 && t.includes(v)) return true;
  }
  return false;
}

/** Heuristic: does a URL look like it carries encoded/bulk data in its query or fragment? */
function looksLikeDataCarrier(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const blob = (u.search + u.hash).slice(1);
    if (blob.length > 400) return true;
    if (/[A-Za-z0-9+/_-]{120,}={0,2}/.test(blob)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

const EXECUTABLE_EXT = /\.(exe|msi|bat|cmd|com|scr|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|jar|apk|dmg|pkg|app|sh|bash|run|bin|cpl|lnk|reg|hta|iso|dll|msix|appx)(?:$|[?#])/i;

function isExecutableDownload(urlOrName) {
  return EXECUTABLE_EXT.test(String(urlOrName || ""));
}

module.exports = { checkNavigation, isPrivateHost, hostMatches, containsCookieValue, looksLikeDataCarrier, isExecutableDownload, EXECUTABLE_EXT };
