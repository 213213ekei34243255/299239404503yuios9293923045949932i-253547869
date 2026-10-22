// Rexy/chat-complete.cjs - a chat reply that is COMPLETE, whatever the server's output limit.
//
// Measured on the real chat server (2026-10-09): it received all 150 questions of a long message, but ended its reply at about 1800 characters, in the middle of a line ("Answer 119:"),
// and said nothing. This asks again for exactly what is missing (a message that stands on its own, so the server needs no memory of the earlier turn) until every part of the user's
// message is answered, then puts the pieces together in order. A message with one part is left alone unless its reply visibly stops in the middle of a thought.
"use strict";

const { splitParts, coverage, continuationMessage, tokensOf } = require("../Noah/intake/request.cjs");

const CUT_LOOKS_LIKE = /(?:[:,\-–]|\b(?:and|or|but|the|a|an|of|to|is|are|with|for|in|on|by|that|which))\s*$/i;

/** The words the user wrote before the first part ("answer each in the form Answer N: X"): they apply to every part, so a continuation repeats them. */
function introOf(message) {
  const lines = String(message || "").replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((l) => /^\s*(?:(?:question|q|task|step|part|item|point)\s*)?\d{1,3}\s*[.):\-]\s+\S|^\s*[-*•]\s+\S/i.test(l));
  return first > 0 ? lines.slice(0, first).join(" ").replace(/\s+/g, " ").trim() : "";
}

/** A numbered answer line appears once: when the same number comes up again (the continuation re-answered something), the first complete one stays. */
function dedupeNumbered(text) {
  const seen = new Set();
  const re = /^\s*(?:\*\*)?(?:answer|ans|a|q|question|part|item|point|step)?\s*#?(\d{1,3})\s*[.):\-\u2013]/i;
  return String(text || "").split("\n").filter((l) => { const m = re.exec(l); if (!m) return true; if (seen.has(m[1])) return false; seen.add(m[1]); return true; }).join("\n");
}

/** Drop the last line when it stops in the middle of a thought (the continuation will do that part again). */
function withoutDanglingTail(reply) {
  const lines = String(reply || "").replace(/\r\n?/g, "\n").split("\n");
  const last = lines[lines.length - 1] || "";
  return CUT_LOOKS_LIKE.test(last) && !/[.?!)"'\]]\s*$/.test(last) ? lines.slice(0, -1).join("\n").trimEnd() : String(reply || "").trimEnd();
}

/**
 * @param {object} o
 * @param {string} o.message                          what the user wrote, whole
 * @param {(message: string) => Promise<string>} o.ask  sends ONE message to the model and returns its reply text ("" when it has none)
 * @param {number} [o.maxRounds]                       how many follow-up requests at most
 * @param {(msg: string) => void} [o.log]
 * @returns {Promise<{ text: string, rounds: number, parts: number, unanswered: number[] }>}
 */
async function completeChat({ message, ask, maxRounds = 12, log = () => {} }) {
  const parts = splitParts(message);
  const first = String(await ask(String(message)) || "");
  if (!first.trim()) return { text: first, rounds: 0, parts: parts.length, unanswered: [] };

  // ---- a single request: only a reply that visibly stops in the middle is continued (a few times), and only a long one (a short one ending in ":" is just how it was written)
  if (parts.length < 2) {
    let text = first, rounds = 0;
    while (rounds < 3 && text.length >= 600 && CUT_LOOKS_LIKE.test(text.split("\n").pop() || "") && !/[.?!)"'\]]\s*$/.test(text)) {
      const tail = text.slice(-400);
      const more = String(await ask(`Your last reply was cut off. Continue EXACTLY where it stopped, without repeating anything. It ended with: "${tail.replace(/\s+/g, " ")}"`) || "").trim();
      if (!more) break;
      rounds++;
      text = `${text.trimEnd()}${/^[a-z,;:)]/.test(more) ? " " : "\n"}${more}`;
    }
    return { text, rounds, parts: 0, unanswered: [] };
  }

  // ---- several parts: ask again for exactly what is missing until nothing is
  const intro = introOf(message);
  let text = first;
  let rounds = 0;
  let stalls = 0;
  let c = coverage(parts, text);
  while ((c.missing.length || c.cutOff) && rounds < maxRounds && stalls < 2) {
    const want = c.missing.length ? c.missing : [];
    if (!want.length) break; // cut off at the very end with nothing left to ask for
    const before = want.length;
    log(`[chat] reply covers ${parts.length - before} of ${parts.length} parts${c.cutOff ? " and stops mid-line" : ""}: asking for ${before} more`);
    const more = String(await ask(continuationMessage(want, { intro })) || "").trim();
    rounds++;
    if (!more) { stalls++; continue; }
    text = dedupeNumbered(`${withoutDanglingTail(text)}\n${more}`);
    c = coverage(parts, text);
    if (c.missing.length >= before) stalls++; else stalls = 0;
  }
  const unanswered = c.missing.map((p) => p.n);
  if (unanswered.length) text = `${text.trimEnd()}\n\n(I could not get answers for part${unanswered.length === 1 ? "" : "s"} ${unanswered.slice(0, 20).join(", ")}${unanswered.length > 20 ? ", ..." : ""} of your message. Ask me again for ${unanswered.length === 1 ? "that one" : "those"}.)`;
  return { text, rounds, parts: parts.length, unanswered };
}

module.exports = { completeChat, introOf, withoutDanglingTail, dedupeNumbered, CUT_LOOKS_LIKE, tokensOf };
