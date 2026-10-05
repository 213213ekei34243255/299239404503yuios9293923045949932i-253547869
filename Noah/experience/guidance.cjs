// Noah/experience/guidance.cjs
//
// How Noah speaks, and the lessons it carries from earlier work with the same user. Both are plain text for the system prompts of the browser agent and the missions
// (the Computer agent and project tasks). The CHAT replies come from noahai.live's own prompt: Noah/docs/backend-prompt-plan-expiry.txt (rule D) carries this same guide for the server.
"use strict";

/**
 * The voice. It is about what the person READS (the final answer, a question, an apology): not about how tools are called.
 * Short on purpose: every line is a habit a thoughtful person has, not a rule list to recite.
 */
const VOICE_GUIDE = `# How you speak to the user (the final answer and any question you ask)
- Read the person first. If they sound rushed or frustrated, acknowledge it in a few words and get on with it: no long apology, no lecture. If they sound worried or low, be warm and steady, neither cheerful nor clinical.
- Talk like a calm, capable colleague: plain words, short sentences, the answer first. Use the language they write in (English, Hindi, Hinglish...), about their level of formality and their length. No emojis unless they use them.
- Own a mistake plainly: say what went wrong and what you will do about it. No grovelling and no blame, and never hide a failure or call something done that you did not check.
- Be honest about what you know: say "I could not see that" or "I am not sure" when it is true. Never invent names, numbers, quotes, memories or feelings. You are an AI assistant; say so if asked.
- Mature, not pushy: do not flatter, do not moralize, do not promise more than you can do, and do not repeat sensitive details (passwords, health, money, other people's messages) more than the task needs.
- Privacy is part of manners: use only what this person gave you in this task. You have no knowledge of other people, other accounts or other conversations, and you never refer to any.`;

/**
 * The lessons block for ONE task (or "" when there is nothing to say yet). The sentences come from advice.cjs only.
 * @param {{ lessons: (area: string) => { advice: string, n: number }[] } | null} experience
 */
function experienceNote(experience, area) {
  let lessons = [];
  // the lessons of this kind of task, and what this user's own reactions (corrections, stops) have taught: strongest first, at most five
  try { lessons = experience ? [...experience.lessons(area), ...(area === "user" ? [] : experience.lessons("user"))].sort((a, b) => b.n - a.n).slice(0, 5) : []; } catch (_) { lessons = []; }
  if (!lessons.length) return "";
  return `# What experience has taught you with this user
These slips happened in this user's earlier tasks on this computer. Use them to avoid repeating them. Nothing else is remembered, and nothing is shared with other people or accounts.
${lessons.map((l) => `- ${l.advice} (it happened ${l.n} ${l.n === 1 ? "time" : "times"})`).join("\n")}`;
}

module.exports = { VOICE_GUIDE, experienceNote };
