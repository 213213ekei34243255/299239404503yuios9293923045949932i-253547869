// Noah/autonomy/answer-check.cjs
//
// Is every concrete detail in the answer the user will read something Noah actually RECORDED seeing?
//
// Why this exists. A task that only reports something ("check WhatsApp for unseen messages") has no machine check: the model states what it found (claim_assert, with
// evidence) and finishes. A real run recorded "1 unread message from Sunil BSNL at 4:54 pm", and three seconds later its final answer said the unread message was
// from "Jeevith" at 00:03, "Check karo", and named "Sahil": none of that was anywhere in its evidence. Every check had passed, and the user was told the wrong thing.
//
// Code cannot know what is TRUE on the screen. It can see that the answer contains names, times and quoted text that the model never wrote down as something it saw, and
// say so. That is all this does: it extracts names, quoted text and times from the answer and looks for each in the recorded evidence (and in the user's own request, which
// is where names the user supplied come from). Anything not found is reported to the user, by code, under the answer.
//
// It is a heuristic with a known cost: a true detail the model forgot to write down is flagged too (a false alarm, shown as "check it yourself"). It cannot catch a wrong
// detail that also happens to be in the evidence, or a wrong claim made in plain words.

"use strict";

// capitalised words that are not names: ordinary words, days, months, and programs that are often named in an answer without being in the evidence
const NOT_NAMES = new Set((
  "i i'm i've i'll the this that these those there here then now yes no ok okay you your yours we our they their he she it its and but or so if when while after before " +
  "sender message messages time date today yesterday tomorrow unread unseen seen recent other others all none one two three first last new old " +
  "summary result results finding findings note notes status content details answer done noah jonah checked verified opened open opening logged chat chats draft drafts " +
  "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december " +
  "windows microsoft edge chrome firefox google whatsapp web business notepad excel word powerpoint outlook explorer file files folder desktop screen window tab page " +
  "pm am please sorry thanks thank hello hi message from received sent replied reply read write wrote written opened closed clicked typed pressed saved"
).split(/\s+/));

// the combining accents that NFKD splits off a letter (built from character codes so that no invisible character sits in the source)
const COMBINING = new RegExp("[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]", "g");
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(COMBINING, "").replace(/[^\p{L}\p{N}:]+/gu, " ").replace(/\s+/g, " ").trim();
const wordsIn = (haystack) => ` ${haystack} `;
const timeKey = (h, m) => `${Number(h)}:${m}`;

/** The details of an answer that can be checked: quoted text, bold names, capitalised words in the middle of a sentence, and clock times. */
function detailsOf(answer) {
  const text = String(answer ?? "");
  const found = []; // { shown, key, kind }
  const add = (shown, kind) => { const key = norm(shown); if (key.length >= 3 && !found.some((f) => f.key === key && f.kind === kind)) found.push({ shown: String(shown).trim(), key, kind }); };

  for (const m of text.matchAll(/["“”]([^"“”\n]{2,100})["“”]/g)) add(m[1], "text");
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])['‘]([^'’\n]{2,80})['’](?![\p{L}\p{N}])/gu)) add(m[1], "text");
  for (const m of text.matchAll(/\*\*([^*\n]{2,80})\*\*/g)) {
    const inner = m[1].trim();
    if (/^\p{Lu}/u.test(inner) && inner.split(/\s+/).length <= 4 && !NOT_NAMES.has(norm(inner))) add(inner, "name");
  }
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const body = sentence.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    const afterFirst = body.replace(/^\S+\s*/, ""); // the first word of a sentence is capitalised anyway
    for (const m of afterFirst.matchAll(/(?<![\p{L}\p{N}])\p{Lu}[\p{Ll}\p{M}]{2,}(?![\p{L}\p{N}])/gu)) {
      const w = m[0];
      if (!NOT_NAMES.has(norm(w)) && !/^\p{Lu}{2,}$/u.test(w)) add(w, "name");
    }
  }
  for (const m of text.matchAll(/(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g)) found.push({ shown: m[0], key: timeKey(m[1], m[2]), kind: "time" });
  return found;
}

/**
 * @param {{ answer: string, evidence: string[], objective?: string }} o
 * @returns {string[]} the details (as written in the answer) that are not in the evidence or the request, at most six
 */
function ungroundedDetails({ answer, evidence = [], objective = "" }) {
  const corpus = norm([...evidence, objective].join(" \n "));
  const padded = wordsIn(corpus);
  const times = new Set([...[...evidence, objective].join(" ").matchAll(/(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g)].map((m) => timeKey(m[1], m[2])));
  const missing = [];
  for (const d of detailsOf(answer)) {
    const ok = d.kind === "time" ? times.has(d.key) : padded.includes(` ${d.key} `);
    if (!ok && !missing.includes(d.shown)) missing.push(d.shown);
  }
  return missing.slice(0, 6);
}

/** The plain-English heads-up for the end of the final message, or "" when there is nothing to say (or no recorded evidence to compare against). */
function groundingNote({ answer, findings, objective }) {
  if (!Array.isArray(findings) || !findings.some((f) => String(f || "").trim())) return "";
  const missing = ungroundedDetails({ answer, evidence: findings, objective });
  if (!missing.length) return "";
  const list = missing.map((d) => (/^\d{1,2}:\d{2}$/.test(d) ? d : `"${d}"`)).join(", ");
  const many = missing.length > 1;
  return `Heads-up: the answer above mentions ${list}, which ${many ? "are" : "is"} not in what Noah wrote down when it looked. ${many ? "They" : "It"} may be wrong or made up: check ${many ? "them" : "it"} yourself before relying on ${many ? "them" : "it"}. What Noah recorded seeing is quoted under "What Noah checked itself".`;
}

module.exports = { ungroundedDetails, groundingNote, detailsOf, norm };
