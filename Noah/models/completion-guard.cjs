// Noah/models/completion-guard.cjs
//
// ACTION SUCCESS != TASK SUCCESS.
//
// The hosted step model (models/rexy-legacy.cjs) reports its own completion in its own JSON envelope: `{ complete: true,
// reason: "..." }`. That flag used to be trusted completely. A real user asked Noah to find a YouTube song; the model,
// given a goal shape it had no deterministic script for, returned `complete: true` with a chat-style non-answer as
// `reason` ("I'm sorry, but I don't have any attached content or a previous conversation to refer to. How can I assist
// you now?") for a task on which NOTHING had actually happened yet - no navigation, no search, no click. Noah reported
// that text to the user with a green "done" checkmark.
//
// A model claiming "I finished" is not evidence that it finished. This is the one gate every self-reported completion
// from that model passes through before Noah repeats it to the user as a fact.

"use strict";

// Boilerplate a chat model produces when it is confused, refusing, or has no idea what page it is on - never a genuine,
// verified answer to a browsing goal. Exactly the first line of this closed out a real task as "done" with nothing done.
const REFUSAL_OR_CHAT =
  /couldn'?t find a matching command|try again with clearer words|invalid input|opening the link|needs_web_search|needs_page_content|\bi'?m sorry\b|\bi (?:can'?t|cannot|am unable|do not|don'?t) (?:have|know|understand)\b|\bno (?:attached|previous) (?:content|conversation)\b|how can i (?:assist|help)|\bas an ai\b|i do not have access/i;

/** Does this look like a refusal / generic chat reply rather than something actually observed on the page? */
function looksLikeRefusalOrChat(text) {
  return REFUSAL_OR_CHAT.test(String(text || ""));
}

// A generated ANSWER that is really the model asking for input or saying it cannot see the question - reported: "Please provide the list of
// thirty questions you need me to solve ... I cannot see the questions in the empty notepad you have attached." was typed into an answer
// box as if it were the solution. Never type one of these; retry or stop instead.
const NON_ANSWER =
  /\bplease (?:provide|paste|share|send|give|specify|tell|upload)\b|\bi (?:cannot|can'?t|can’t|am unable to|do not|don'?t|don’t) (?:see|find|view|access|read) (?:the |any |your |those |these |a |an )?(?:questions?|problems?|content|text|list|attachment|page|notepad|document|input)\b|\bno (?:questions?|problems?|content|text|attachment)s? (?:was|were|is|are|has been|have been)? ?(?:provided|attached|visible|included|given|shown)\b|\b(?:empty|blank) (?:notepad|page|document|text ?box)\b|\bonce you (?:paste|provide|share|send)\b|\b(?:paste|share|provide|send) (?:me )?(?:the|those|these|your) (?:questions?|problems?|list|content|text)\b|\bi(?:'m| am) (?:ready|standing by|waiting)\b|\bstanding by for\b|\bcould you (?:please )?(?:provide|clarify|share|specify)\b|\bcan you (?:please )?(?:provide|clarify|share|specify)\b|\blet me know (?:the|which|what)\b/i;
// Generic study advice instead of a solution - reported in a "Written Solution Challenge" box: "When you arrive at the final answer, make sure
// to clearly state it ... Remember to double-check your work ... Taking the University Mathematics - 30 Question MCQ seriously ... Good luck!"
// (a model asked to answer the box's PLACEHOLDER rather than the problem). None of these belong in a worked solution.
const ADVICE = /\b(?:good luck|best of luck|i hope (?:this|that) helps|feel free to|don'?t hesitate|double-?check your (?:work|answer)|before submitting your (?:final )?answer|taking the .{0,80}seriously|engaging with the (?:problems|questions)|build your skills|critical thinking)\b/i;
// A problem that asks for working ("show all steps", "prove", "derive") and reads as maths must be answered with maths: real working always
// contains equations or symbols. Prose with none is not a solution to it.
const MATHY_QUESTION = /[=∫∑√π^]|\d\s*[+\-×÷*\/^]\s*\d|\b(?:integral|derivative|limit|lim|matrix|matrices|eigen\w*|series|equation|determinant|diagonali[sz]\w*|converge\w*|differentiate|integrate|simplify|evaluate|solve|compute|calculate|prove|derive)\b/i;
const NEEDS_WORKING = /\b(?:show|steps?|working|derive|derivation|prove|proof|justify|procedure|explain|every|complete)\b/i;
const MATH_EVIDENCE = /[=≈≠≤≥∫∑√π∞]|\d\s*[+\-×÷*\/^·]\s*[\d(a-zA-Z]|\b[a-zA-Z]\s*\(\s*[\w+\-]+\s*\)|\^|[²³⁴ⁿ]/g;
function lacksMathEvidence(question, answer) {
  const q = String(question || "");
  if (!MATHY_QUESTION.test(q) || !NEEDS_WORKING.test(q)) return false;
  return (String(answer || "").match(MATH_EVIDENCE) || []).length < 2;
}
const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/**
 * Is this generated text NOT an answer to the question it was asked about? Empty, a refusal / generic chat reply, a request for the
 * question or for more input, or just the question / the box's placeholder echoed back.
 */
function looksLikeNonAnswer(text, { question = "", hint = "" } = {}) {
  const t = String(text || "").trim();
  if (t.length < 2) return true;
  if (looksLikeRefusalOrChat(t) || NON_ANSWER.test(t) || ADVICE.test(t)) return true;
  if (lacksMathEvidence(question, t)) return true;
  const flat = squash(t);
  return !!flat && (flat === squash(question) || (!!hint && flat === squash(hint)));
}

/**
 * Is the model's self-reported completion trustworthy?
 * @param {object} o
 * @param {string} [o.reason]            the model's own explanation for why it thinks the goal is done
 * @param {boolean} o.tookAction         did an action actually run in THIS step's response?
 * @param {boolean} o.everActedThisTask  has any action actually succeeded for this task before now?
 * @returns {{ trusted: boolean, why?: string }}
 */
function verifyCompletion({ reason, tookAction = false, everActedThisTask = false } = {}) {
  if (looksLikeRefusalOrChat(reason)) {
    return { trusted: false, why: "the model's own explanation reads like a refusal or a generic chat reply, not something it verified on the page" };
  }
  if (!tookAction && !everActedThisTask) {
    return { trusted: false, why: "nothing has actually been done for this task yet (no action has succeeded)" };
  }
  return { trusted: true };
}

module.exports = { verifyCompletion, looksLikeRefusalOrChat, looksLikeNonAnswer, REFUSAL_OR_CHAT };
