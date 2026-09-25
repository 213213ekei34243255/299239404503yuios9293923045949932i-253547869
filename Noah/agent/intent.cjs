// Noah/agent/intent.cjs
//
// What is the user asking for? Pure functions, shared by voice and text (both go through the CommandRouter):
//
//   looksLikeBrowserTask   a message that asks for something to be DONE in the browser (open, search, write on this page...)
//   controlOf              "continue" / "stop" / "pause" spoken on their own
//   isFollowUp             a short fragment that only makes sense against the task that was just running
//                          ("continue writing the story", "on the notepad please", "make it longer")
//   stripAgentModePhrase   "turn on agentic mode" is not a command: there is nothing to turn on, the agent is always available

"use strict";

const BROWSER_VERBS = [
  "open", "go to", "goto", "navigate", "visit", "click", "type",
  "search", "find", "fill", "submit", "login", "sign in", "scroll", "answer",
  "download", "upload", "bookmark", "tab", "screenshot", "extract",
  "reload", "back", "forward", "play",
  // wordier phrasing common in voice transcripts
  "look into", "look at", "check out", "pull up", "load up",
  "take me to", "bring up", "browse to", "browse", "see this",
  "observe", "look up",
  // multi-step objectives the computer-use agent handles
  "research", "compare", "buy", "purchase", "order", "book", "reserve", "drag",
  "log in", "log into", "sign into", "shop for", "look for", "add to cart", "checkout",
  "fill out", "move the", "update the", "rename", "create a",
];
const VERB_PATTERN = new RegExp("\\b(" + BROWSER_VERBS.join("|") + ")\\b");
const WEB_TARGET = /\b(website|site|homepage|web ?page|\.com|\.org|\.net)\b/;
const WRITE_VERB = /\b(write|type|compose|draft|jot|paste|enter|fill|add|put)\b/;
const ACT_ON_PAGE = /\b(write|type|compose|draft|jot|paste|enter|fill|copy|select|delete|clear|edit|summari[sz]e|read|scroll|click|translate|explain|rewrite|add|put|answer|check)\b/;
const INTO_SOMETHING = /\b(?:on|in|into|onto|at|to)\s+(?:this|the|that|my|a|an)\s+(?:note ?pad|notes?|page|document|doc|editor|text ?(?:box|area|editor)|textbox|site|website|tab|screen|window|sheet|spreadsheet|form|field|box|input)\b/;
const THIS_THING = /\b(?:this|the current|that)\s+(?:page|tab|site|website|note ?pad|document|form|screen|window)\b/;

/** Does this message ask for something to be done in the browser? */
function looksLikeBrowserTask(goal) {
  const g = String(goal || "").toLowerCase();
  const actsOnPage =
    (INTO_SOMETHING.test(g) && WRITE_VERB.test(g)) ||
    (THIS_THING.test(g) && ACT_ON_PAGE.test(g)) ||
    (/\b(note ?pad|google docs?|text ?editor)\b/.test(g) && ACT_ON_PAGE.test(g));
  return VERB_PATTERN.test(g) || WEB_TARGET.test(g) || actsOnPage || /https?:\/\//.test(g);
}

const CONTROL = {
  resume: /^(?:ok(?:ay)?[, ]+|so[, ]+|now[, ]+)?(?:please[, ]+)?(?:continue|resume|go on|carry on|keep going|proceed|go ahead)(?:[, ]+please)?[.!\s]*$/i,
  stop: /^(?:ok(?:ay)?[, ]+)?(?:please[, ]+)?(?:stop|cancel|abort|never ?mind|that'?s enough|stop it|stop that|stop now)(?:[, ]+please)?[.!\s]*$/i,
  pause: /^(?:please[, ]+)?(?:pause|hold on|hold it|wait)(?:[, ]+please)?[.!\s]*$/i,
};
/** @returns {'resume'|'stop'|'pause'|null} */
function controlOf(text) {
  const t = String(text || "").trim();
  for (const [name, re] of Object.entries(CONTROL)) if (re.test(t)) return name;
  return null;
}

const GREETING = /^(?:hey|hi|hello|yo|thanks?|thank you|ok(?:ay)?|cool|nice|great|good|bye|goodbye|yes|no|sure|hmm+|test(?:ing)?)(?:[, ]+(?:noah|jonah|there))?[.!?\s]*$/i;
const QUESTION = /^(?:what|why|how|who|when|where|which|is|are|do you|does|did|can you tell|could you tell|tell me)\b.*\?\s*$/i;
const CONTINUATION = /\b(continue|keep (?:going|writing|typing)|go on|carry on|more|again|next|rest|finish|whole|longer|shorter|another|also|then|too)\b/;
const FOLLOW_UP_ACTION = /\b(story|paragraph|sentence|text|letter|essay|poem|note ?pad|notes?|page|write|writing|type|typing|add|paste|delete|clear|scroll|click|select|copy|read|summari[sz]e|translate|rewrite|edit|fix|shorten|lengthen|expand|play|pause|song|video|track|answer|question|questions|form)\b/;
const LEADING_PREPOSITION = /^(?:and |also |then |now |ok(?:ay)? |please )*(?:on|in|into|onto|at|to|for)\s+(?:the|this|that|my|your|ur)\b/;

/**
 * Is this a short fragment that continues the task that was just running? The caller has already checked that such a task
 * exists (AgentSession.hasRecentTask): on its own "on the notepad please" is nothing.
 */
function isFollowUp(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t || GREETING.test(t)) return false;
  if (t.split(/\s+/).length > 16) return false;
  if (QUESTION.test(t)) return false;
  return CONTINUATION.test(t) || FOLLOW_UP_ACTION.test(t) || LEADING_PREPOSITION.test(t);
}

const AGENT_MODE_PHRASE = /\b(?:(?:please\s+)?(?:turn|switch|put|set)\s+(?:on\s+|the\s+|to\s+)*(?:agent(?:ic)?|noah)(?:\s+mode)?(?:\s+on)?|(?:agent(?:ic)?|noah)\s+mode(?:\s+on)?)\b/gi;
/** "on the notepad on ur screen turn the agentic mode" -> "on the notepad on ur screen" (there is no mode to turn on). */
function stripAgentModePhrase(text) {
  const before = String(text || "");
  const after = before.replace(AGENT_MODE_PHRASE, " ").replace(/\s+/g, " ").trim();
  return { text: after, hadPhrase: after !== before.replace(/\s+/g, " ").trim() };
}

/** Drop the wake word / address ("Noah, ...") so it is not part of the task. */
function stripAddress(text) {
  return String(text || "").replace(/^\s*(?:hey\s+|ok(?:ay)?\s+)?noah\s*[,:]?\s*/i, "").trim();
}

module.exports = { looksLikeBrowserTask, controlOf, isFollowUp, stripAgentModePhrase, stripAddress, BROWSER_VERBS };
