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

module.exports = { verifyCompletion, looksLikeRefusalOrChat, REFUSAL_OR_CHAT };
