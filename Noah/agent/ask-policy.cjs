// Noah/agent/ask-policy.cjs
//
// When may Noah stop and ask the person? Only for things a person has to do: sign in, a password or code, a CAPTCHA, a
// payment. Everything else ("which one?", "I keep repeating myself, what now?") Noah has to work out itself: re-read the
// page, pick the most sensible interpretation and carry on. Pausing for every doubt made agent runs unwatchable.

"use strict";

const HUMAN_ONLY = /\b(log ?in|sign ?in|sign ?up|password|passcode|credentials?|username|2fa|two[- ]factor|verification code|security code|one[- ]time|otp|captcha|are you (?:a )?human|i'?m not a robot|payment|card number|cvv|credit card|debit card|checkout|place (?:the |your )?order|pay(?:ment)? for|purchase|permission to|consent)\b/i;

/** Does this question genuinely need the person? */
function needsHuman(question, obs) {
  const q = String(question || "");
  if (HUMAN_ONLY.test(q)) return true;
  // a login/payment form is on screen and the model is asking for input to fill it
  if ((obs?.security?.hasPassword || obs?.hints?.hasPassword || obs?.hints?.hasPayment) && /\b(enter|type|provide|fill|help|need)\b/i.test(q)) return true;
  return false;
}

const norm = (q) => String(q || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);

/**
 * Decide whether to actually pause for this question.
 * @returns {{ ask: boolean, why: string }}
 */
function decideAsk({ question, obs, asked = new Set(), autoDecide = true }) {
  if (autoDecide === false) return { ask: true, why: "autoDecide is off" };
  if (!needsHuman(question, obs)) return { ask: false, why: "not something only a person can do: decide by yourself" };
  if (asked.has(norm(question))) return { ask: false, why: "already asked this and the person handled it" };
  return { ask: true, why: "needs the person" };
}

module.exports = { needsHuman, decideAsk, norm, HUMAN_ONLY };
