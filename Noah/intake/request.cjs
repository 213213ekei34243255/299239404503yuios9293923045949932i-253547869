// Noah/intake/request.cjs - ONE way for the whole app (chat, the Web agent, the Computer agent and project tasks) to handle what the user wrote.
//
// What went wrong before (measured, 2026-10-09):
//   * a task's objective was cut to 1000 characters when stored and to 600 in the briefing the model reads on EVERY round: a long message with several instructions
//     reached the agent as its first few lines;
//   * the chat server RECEIVES a long message whole (150 numbered questions arrived) but ends its reply at about 1800 characters, mid-line ("Answer 119:"), and nobody noticed;
//   * the panel's one-line text box turned line breaks into nothing.
// The rules here: the message is NEVER cut; its parts are listed so that none is forgotten; an answer is checked against the parts, and whatever is missing or cut off is
// asked for again (in smaller pieces), then the pieces are put together in order. Nothing in this file calls a model or the network.
"use strict";

/** The largest message the app accepts. Above it the user is TOLD (nothing is silently cut). Far above anything a person types; a pasted document belongs in an attachment. */
const MAX_REQUEST_CHARS = 200_000;
/** A request this long or shorter is shown to a model in full; longer, as a numbered digest of its parts with the rest readable on demand. */
const FULL_VIEW_CHARS = 8_000;
const DIGEST_PART_CHARS = 350;
const READ_SLICE_CHARS = 4_000;

/** Line endings made uniform, NUL characters removed; nothing else is touched (no trimming of the middle, no cutting). */
function normalizeRequest(input) {
  const text = String(input === undefined || input === null ? "" : input).replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
  const trimmed = text.trim();
  return { text: trimmed, chars: trimmed.length, tooLong: trimmed.length > MAX_REQUEST_CHARS };
}

const MARKER = /^\s*(?:(?:question|q|task|step|part|item|point)\s*)?(\d{1,3})\s*[.):\-]\s+\S|^\s*[-*•]\s+\S/i;
const SENTENCE_END = /(?<=[.?!])\s+(?=[A-Z0-9"'(\[])/;
const questionish = (s) => /\?\s*["')\]]*\s*$/.test(s.trim()) || /^(what|why|how|when|where|who|which|can|could|should|is|are|do|does|did|will|would)\b/i.test(s.trim());

/**
 * The parts of a message: [{ n, text, question }]. A message with fewer than two parts has none (it is one request). Parts come from numbered or bulleted lines (with their continuation
 * lines), else from separate lines, else from the questions inside one paragraph.
 */
function splitParts(text) {
  const t = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!t) return [];
  const lines = t.split("\n");
  const parts = [];
  // 1. numbered / bulleted lines
  const marked = lines.filter((l) => MARKER.test(l)).length;
  if (marked >= 2) {
    let cur = null;
    let started = false;
    for (const line of lines) {
      if (MARKER.test(line)) { if (cur) parts.push(cur); cur = line.trim(); started = true; }
      else if (cur !== null && line.trim()) cur += " " + line.trim();
      else if (cur === null && line.trim() && started) parts.push(line.trim()); // after the list: its own part
      else if (cur !== null && !line.trim()) { parts.push(cur); cur = null; }
      // (lines before the first marker are the introduction: they belong to every part, see introOf in Rexy/chat-complete.cjs)
    }
    if (cur) parts.push(cur);
  } else {
    // 2. separate non-empty lines (three or more), 3. else the questions of one paragraph
    const real = lines.map((l) => l.trim()).filter(Boolean);
    if (real.length >= 3) real.forEach((l) => parts.push(l));
    else {
      const sentences = t.replace(/\n+/g, " ").split(SENTENCE_END).map((s) => s.trim()).filter(Boolean);
      const qs = sentences.filter((s) => /\?\s*$/.test(s));
      if (qs.length >= 2 || (sentences.length >= 3 && qs.length >= 1)) sentences.forEach((s) => parts.push(s));
    }
  }
  const out = parts.map((p) => p.trim()).filter((p) => p.length >= 3);
  if (out.length < 2) return [];
  return out.map((p, i) => ({ n: i + 1, text: p, question: questionish(p), marked: MARKER.test(p) }));
}

const STOP = new Set("the and for you your with that this from have has had are was were will would could should what when where which who whom why how can does did not but all any each please also then than into about over under just like want need make give tell show let get got its it's i'm you're don't".split(" "));
const tokensOf = (s) => (String(s || "").toLowerCase().match(/[a-z0-9ऀ-ॿ]+/g) || []).filter((w) => /^\d+$/.test(w) || (w.length >= 3 && !STOP.has(w)));

/** The leading number of a part, if it has one ("3.", "Question 3:"). */
function numberOf(part) {
  const m = /^\s*(?:(?:question|q|task|step|part|item|point)\s*)?(\d{1,3})\s*[.):\-]/i.exec(part.text);
  return m ? Number(m[1]) : part.n;
}

const DANGLING = /(?:^|\n)[^\n]{0,60}[:,\-–]\s*$|\b(?:and|or|but|the|a|an|of|to|is|are|with|for)\s*$/i;

/**
 * Which parts has this answer NOT dealt with? A part counts as answered when the answer has a line for its number ("Answer 7:", "7.", "Q7") or shares enough of its words.
 * The last line of an answer that stops in the middle of a thought ("Answer 119:") is NOT counted, because the reply was probably cut off there.
 * @returns {{ missing: { n: number, text: string, question: boolean }[], cutOff: boolean }}
 */
function coverage(parts, answer) {
  const a = String(answer || "").replace(/\r\n?/g, "\n").trim();
  if (!parts || !parts.length) return { missing: [], cutOff: false };
  let body = a;
  let cutOff = false;
  const lastLine = a.split("\n").pop() || "";
  if (a && DANGLING.test(lastLine) && !/[.?!)"'\]]\s*$/.test(lastLine)) { cutOff = true; body = a.slice(0, a.length - lastLine.length); }
  const lines = body.split("\n");
  const answerTokens = new Set(tokensOf(body));
  const lineFor = (num) => new RegExp(`^\\s*(?:\\*\\*)?(?:answer|ans|a|q|question|part|item|point|step)?\\s*#?${num}\\s*(?:[.):\\-\\u2013]|\\b)`, "i");
  const hasNumberedLine = (num) => lines.some((l) => lineFor(num).test(l) && l.trim().replace(/^\W*\w*\s*#?\d+\W*/, "").length > 1);
  // an answer written as a numbered list is checked by its numbers ONLY (a value such as "119" in another line must not count as answering question 119)
  const numberedAnswer = lines.filter((l) => /^\s*(?:\*\*)?(?:(?:answer|ans|a|q|question|part|item|point|step)\s*)?#?\d{1,3}\s*[.):\-\u2013]/i.test(l)).length >= Math.max(2, Math.ceil(parts.length / 2));
  const missing = [];
  for (const p of parts) {
    if (hasNumberedLine(numberOf(p))) continue;
    if (numberedAnswer && p.marked) { missing.push(p); continue; }
    const ids = (p.text.match(/\b[A-Z0-9][A-Z0-9_]*(?:-[A-Z0-9_]+)+\b/g) || []).filter((w) => /\d/.test(w)); // an identifier the part asks to be repeated, such as ZEBRA-1234
    if (ids.length && ids.every((w) => body.includes(w))) continue;
    const shout = !p.marked ? (p.text.match(/\b[A-Z]{4,}\b/g) || []) : []; // a word the part asks to be said, such as DONE
    if (shout.length && shout.every((w) => body.includes(w))) continue;
    const toks = [...new Set(tokensOf(p.text.replace(/^\s*(?:(?:question|q|task|step|part|item|point)\s*)?\d{1,3}\s*[.):\-]\s*/i, "")))].filter((w) => !/^\d+$/.test(w));
    if (toks.length < 1) { missing.push(p); continue; } // nothing to match on and no line for its number: not answered
    const hit = toks.filter((w) => answerTokens.has(w)).length;
    if (hit / toks.length >= 0.4 && hit >= (toks.length >= 3 ? 2 : 1)) continue;
    missing.push(p);
  }
  return { missing, cutOff };
}

/** A message that names ONLY the missing parts (self-contained: the server needs no memory of the earlier turn). */
function continuationMessage(missing, { intro = "" } = {}) {
  const head = "Some parts of my earlier message were not answered yet (the reply was cut off). Please answer ONLY the parts below, in order, each one completely, keeping their numbers.";
  const ctx = intro ? `\n\nContext from my earlier message: ${intro.slice(0, 600)}` : "";
  return `${head}${ctx}\n\n${missing.map((p) => (/^\s*\d{1,3}\s*[.):\-]/.test(p.text) || /^\s*(?:question|q|part|task|step|item|point)\s*\d/i.test(p.text) ? p.text : `${p.n}. ${p.text}`)).join("\n")}`;
}

/** The numbered digest a model sees for a very long request: every part, each cut to `perPart` characters with the cut shown. */
function digest(text, { perPart = DIGEST_PART_CHARS, maxParts = 80 } = {}) {
  const parts = splitParts(text);
  if (!parts.length) {
    const t = String(text || "");
    return [`1. ${t.slice(0, perPart * 4)}${t.length > perPart * 4 ? " [...cut here: the full text is read with request_read]" : ""}`];
  }
  const numbered = (p) => /^\s*(?:(?:question|q|part|task|step|item|point)\s*)?\d{1,3}\s*[.):\-]/i.test(p.text); // the part already carries its own number: do not number it twice
  const shown = parts.slice(0, maxParts).map((p) => `${numbered(p) ? "" : `${p.n}. `}${p.text.length > perPart ? `${p.text.slice(0, perPart)} [...${p.text.length - perPart} more characters]` : p.text}`);
  if (parts.length > maxParts) shown.push(`(+${parts.length - maxParts} more parts: read the full text with request_read)`);
  return shown;
}

/** How a model is shown the request: the whole text when it is not very long, else the digest and how to read the rest. */
function viewForModel(text, { full = FULL_VIEW_CHARS } = {}) {
  const t = String(text || "");
  const parts = splitParts(t);
  if (t.length <= full) {
    return { complete: true, lines: [t], parts, long: false };
  }
  return { complete: false, long: true, parts, lines: [`(a long request: ${t.length} characters, ${parts.length || 1} part${parts.length === 1 ? "" : "s"}; call request_read to read the full text, ${READ_SLICE_CHARS} characters per call)`, ...digest(t)] };
}

/** One slice of the full text for the request_read tool. */
function readSlice(text, offset = 0, size = READ_SLICE_CHARS) {
  const t = String(text || "");
  const start = Math.max(0, Math.min(Number.isFinite(Number(offset)) ? Math.floor(Number(offset)) : 0, t.length));
  const end = Math.min(t.length, start + Math.max(200, Math.min(size, 8000)));
  return { text: t.slice(start, end), offset: start, next: end < t.length ? end : null, total: t.length };
}

/** The one rule every prompt gets, for a message with several parts. */
function partsRule(parts) {
  if (!parts || parts.length < 2) return "";
  return `The user's message has ${parts.length} parts. Deal with EVERY one, in order, and in your final answer address each part by its number. If you cannot do or answer a part, say so for that number: never skip one silently.`;
}

module.exports = { MAX_REQUEST_CHARS, FULL_VIEW_CHARS, READ_SLICE_CHARS, normalizeRequest, splitParts, coverage, continuationMessage, digest, viewForModel, readSlice, partsRule, tokensOf };
