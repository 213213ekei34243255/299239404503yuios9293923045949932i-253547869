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

// ---------------------------------------------------------------- missions: work on a project, files and commands (not on a web page)

/** A deictic reference to the user's own project: "this project", "my repo", "the codebase". */
const PROJECT_REF = /\b(?:this|my|the|our|that)\s+(?:project|repo|repository|codebase|code\s?base|source\s?code|code|app|application|package|module|script|folder|directory|workspace)\b/i;
/** Specific to working on code with commands. */
const SETUP = /\b(?:set\s?up|bootstrap|scaffold|initiali[sz]e)\b[^.\n]{0,40}\b(?:project|repo|repository|environment|app|application|codebase|dev(?:elopment)? env)/i;
const INSTALL_DEPS = /\binstall\b[^.\n]{0,30}\b(?:dependencies|dependency|packages|deps|requirements|node modules)\b/i;
const PM_COMMAND = /\b(?:npm|npx|yarn|pnpm|bun)\s+(?:install|i|ci|run|test|start|build|init|update|upgrade|audit|exec|dlx)\b|\bpip3?\s+install\b|\bcargo\s+(?:build|test|run|check)\b|\bgo\s+(?:build|test|run|mod)\b|\bmvn\s+\w+|\bgradlew?\s+\w+|\bpython3?\s+\S+\.py\b|\bnode\s+\S+\.[cm]?js\b|\bdotnet\s+(?:build|test|run)\b|\bmake\s+\w+/i;
const GIT = /\bgit\s+(?:clone|status|diff|log|add|commit|branch|checkout|switch|merge|rebase|stash|pull|push)\b|\bcommit\s+(?:the|my|these|all)\s+(?:changes|files)\b/i;
const RUN_THINGS = /\b(?:run|execute|launch)\s+(?:all\s+)?(?:the\s+|my\s+|our\s+)?(?:unit\s+|integration\s+|e2e\s+)?(?:tests?|test\s?suite|specs?|build|linter|lint|type\s?check|migrations?|dev\s?server)\b/i;
const PROJECT_FILES = /\b(?:package\.json|requirements\.txt|cargo\.toml|pom\.xml|makefile|tsconfig\.json|dockerfile|\.gitignore)\b/i;
/** A verb and a code word, which says "work on code" (but "fix the error" could also be a web form: so it needs more than that near a browser cue). */
const FIX_THINGS = /\b(?:fix|debug|diagnose|repair|resolve|troubleshoot|investigate)\b[^.\n]{0,40}\b(?:bug|bugs|errors?|exceptions?|crash(?:es)?|failing|failures?|broken|build|tests?|lint|compile|compilation|type\s?errors?|stack\s?trace|regression)\b/i;
const CODE_WORK = /\b(?:refactor|implement|compile|lint|transpile|unit[- ]test|type[- ]?check|code[- ]review)\b/i;
/** The code word comes first: "the build is broken", "tests keep failing". (Not "the app is not working": that could be any website.) */
const BROKEN_THINGS = /\b(?:build|tests?|test suite|compile|compilation|lint|ci)\b[^.\n]{0,25}\b(?:is|are|keeps?)\s+(?:broken|failing|crashing|not working|throwing)\b/i;
/** "explain what a unit test is": a request to be told something, not a job (unless it is about the user's own project). */
const EXPLAINY = /^\s*(?:please\s+)?(?:explain|describe|define|teach me|tell me about|what'?s)\b/i;
const WRITE_CODE = /\b(?:write|create|make|generate|add|build)\b[^.\n]{0,25}\b(?:script|function|class|module|program|cli|unit tests?|test cases?|tests|endpoint|api|component|library|package|node project|python project|project|repo|repository)\b/i;
const FILE_REF = /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\b[\w.-]+[\\/])[\w .\\/-]*\.(?:js|cjs|mjs|ts|tsx|jsx|py|json|md|txt|yml|yaml|toml|java|c|cpp|h|go|rs|sh|bat|ps1|html|css)\b|\b[\w-]+\.(?:js|cjs|mjs|ts|tsx|py|json|toml|yml|yaml|rs|go|java|sh|ps1)\b/i;
const FILE_VERB = /\b(?:read|edit|change|modify|update|rename|delete|move|fix|add|remove|create|write)\b/i;
/** Says "this is about a web page / the browser". */
const BROWSER_CUE = /(?:https?:\/\/|www\.)|\b(?:[a-z0-9-]+\.(?:com|org|net|io|co|app|dev)|website|web ?site|web ?page|browser|tabs?|google|youtube|amazon|search for|search the web|click|scroll|log ?in to|sign ?in to)\b|\b(?:on|in|into|onto)\s+(?:this|the|that|my)\s+(?:note ?pad|page|tab|site|website|document|doc|editor|text ?(?:box|area)|form|screen)\b/i;
const SEARCHY = /\b(?:search|google|look up|find (?:me )?(?:an? |the |some )?(?:articles?|tutorials?|videos?|guides?|docs|documentation|examples?))\b/i;
const QUESTION_FORM = /^\s*(?:what|why|how|who|when|where|which|is|are|do|does|did|can you tell|could you tell|tell me)\b[^]*\?\s*$/i;

/**
 * Is this a job on the user's own project (files, commands, tests, git), as opposed to a web page or plain chat? Mission goals are things
 * like "set up this project and make the tests pass" or "fix the failing build"; "open youtube and play lo-fi", "search for npm tutorials" and
 * "what is a git branch?" are not. A question needs a reference to the user's own project ("why does npm test fail in this repo?") to count.
 */
function looksLikeMissionTask(goal) {
  const g = String(goal || "").trim();
  if (!g) return false;
  const mine = PROJECT_REF.test(g);
  if ((QUESTION_FORM.test(g) || EXPLAINY.test(g)) && !mine) return false;
  const searchy = SEARCHY.test(g);
  const browsy = BROWSER_CUE.test(g);
  // commands that only make sense on a project win even next to a URL ("clone https://github.com/x/y and install its dependencies")
  if (GIT.test(g) || SETUP.test(g) || INSTALL_DEPS.test(g) || RUN_THINGS.test(g) || PROJECT_FILES.test(g)) return !(browsy && searchy && !mine);
  if (PM_COMMAND.test(g)) return !(searchy && !mine);
  if (FIX_THINGS.test(g) || BROKEN_THINGS.test(g) || CODE_WORK.test(g) || WRITE_CODE.test(g)) return (!browsy && !searchy) || mine;
  if (FILE_REF.test(g) && FILE_VERB.test(g)) return !browsy && !searchy;
  return false;
}

// ---- a job on the user's Windows desktop: "open Notepad and write...", "in Excel make a table", "close the calculator window", "on my computer open File Explorer".
// It must NOT take over what the browser agent does ("open youtube and play lo-fi", "go to amazon and ...") or plain chat ("what is Excel?").
const APP_NAMES = String.raw`notepad\+\+|notepad|wordpad|calculator|ms paint|paint|excel|word|powerpoint|outlook|onenote|file explorer|windows explorer|explorer|settings|control panel|snipping tool|spotify|discord|whatsapp|telegram|slack|teams|zoom|skype|vlc|media player|photos|vs ?code|visual studio code|visual studio|android studio|git gui|7-?zip|winrar|photoshop|premiere|obs|steam|sublime|chrome|edge|firefox|brave|safari|finder|textedit|keynote|quicktime|garageband|imovie|xcode|activity monitor|system settings|system preferences|facetime|photo booth`;
const DESKTOP_APP = new RegExp(`\\b(?:${APP_NAMES})\\b`, "i");
// the app must be what is being opened or used ("open Excel", "in Notepad", "on spotify"), not merely mentioned ("search google for notepad alternatives")
const APP_USE = new RegExp(`\\b(?:open|launch|start|run|close|quit|exit|minimi[sz]e|maximi[sz]e|switch to|use|using|in|into|on|with|from)\\s+(?:(?:the|my|a|an|new)\\s+)*(?:${APP_NAMES})\\b`, "i");
const STRONG_DESKTOP_APP = /\b(notepad\+\+|notepad|wordpad|calculator|ms paint|excel|powerpoint|outlook|onenote|file explorer|windows explorer|snipping tool|spotify|discord|vlc|media player|vs ?code|visual studio code|visual studio|android studio|git gui|7-?zip|winrar|photoshop|premiere|sublime|finder|textedit|keynote|quicktime|garageband|imovie|xcode|system settings|system preferences|facetime)\b/i; // apps that are never a website
const DESKTOP_PHRASE = /\b(my (?:computer|pc|laptop|desktop|screen|mac|macbook|imac|mac mini|mac studio)|on (?:the |my )?(?:screen|desktop|mac|macbook|imac)|mac app|menu bar|(?:notes|pages|numbers|messages|mail|preview|contacts|reminders|calendar|music|books|podcasts|clock|stocks|voice memos) app|desktop app|windows app|the app|this app|an app|application|taskbar|start menu|window (?:titled|called|named))\b/i;
// When the user has CHOSEN the Web agent they said "this is about the browser": only an explicit computer reference sends the task elsewhere. A bare "on the screen" /
// "the app" / "this app" (Jonah itself) is NOT one - "turn on the radio on the screen and play it" is the homepage's radio, a browser job.
const DESKTOP_PHRASE_EXPLICIT = /\b(my (?:computer|pc|laptop|desktop|mac|macbook|imac|mac mini|mac studio)|on (?:the |my )?(?:desktop|mac|macbook|imac)|mac app|menu bar|(?:notes|pages|numbers|messages|mail|preview|contacts|reminders|calendar|music|books|podcasts|clock|stocks|voice memos) app|desktop app|windows app|taskbar|start menu|window (?:titled|called|named))\b/i;
const DESKTOP_VERB = /\b(open|launch|start|run|close|minimi[sz]e|maximi[sz]e|switch to|click|double[- ]click|right[- ]click|type|write|press|scroll|drag|screenshot|use|play|send|create|make|edit|save|add|search|find|delete|rename|copy|paste|draw|calculate|set|turn|change|show me|go to)\b/i;
const WEB_THING = /\b(youtube|gmail|google|amazon|flipkart|facebook|instagram|twitter|netflix|hotstar|wikipedia|reddit|linkedin|web ?site|web ?page|url|link|browser|tab|online|search the web)\b/i;
const URL_LIKE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|org|net|in|io|co|dev|app|ai|edu|gov)\b/i;

/** @param {{ webChosen?: boolean }} [opts] webChosen: the user picked the Web agent themselves, so only an explicit computer/app reference counts as a computer job. */
function looksLikeDesktopTask(goal, { webChosen = false } = {}) {
  const g = String(goal || "").trim();
  if (!g) return false;
  if (QUESTION_FORM.test(g) || EXPLAINY.test(g)) return false;
  const phrase = (webChosen ? DESKTOP_PHRASE_EXPLICIT : DESKTOP_PHRASE).test(g);
  if (!APP_USE.test(g) && !phrase) return false;
  if (!DESKTOP_VERB.test(g)) return false;
  // a website or an address, with nothing that says "an app on my computer": that is the browser agent's job
  if ((WEB_THING.test(g) || URL_LIKE.test(g)) && !phrase && !STRONG_DESKTOP_APP.test(g)) return false;
  return true;
}

// ---- a READ-ONLY question about the page in front of the user: "summarize this page", "what is this article about", "explain this", "tl;dr".
// It needs one read of the page and an answer, not a task with plans and clicks, so it goes to chat (which is given the page's text), in Auto and Chat mode.
const PAGE_NOUN = String.raw`(?:page|article|tab|site|web ?site|web ?page|document|doc|post|story|blog(?: post)?|paper|pdf|thread|text|essay|review|report|recipe|listing|news|content)`;
const PAGE_REF = new RegExp(String.raw`\b(?:this|these|the current|the open|current|that)\s+(?:${PAGE_NOUN})\b|\bthe\s+(?:page|article|site|website|web ?page|document|post|blog|story)\s+(?:i(?:'m| am)\s+(?:on|reading|viewing|looking at)|(?:open|here))\b|\bwhat(?:'s| is) on (?:the |this )?(?:page|screen)\b`, "i");
const PAGE_READ_VERB = /\b(?:summari[sz]e|summary|tl;?dr|recap|sum (?:it )?up|(?:key|main) (?:points?|ideas?|takeaways?)|gist|outline|highlights|explain|describe|what(?:'s| is| are| does)|tell me about|translate|simplify|paraphrase|analy[sz]e|critique|proofread|review)\b/i;
const PAGE_ACTION = /\b(?:click|press|scroll|type|fill|submit|log ?in|sign ?in|buy|purchase|order|download|play|open|go to|navigate|close|bookmark|refresh|reload|search|google|look up|find me|book|add to cart|checkout|write|compose|draft|send|post)\b/i;
const BARE_SUMMARY = /^(?:please\s+|pls\s+|can you\s+|could you\s+|would you\s+|just\s+)*(?:give me |write |make |do |get me )?(?:a |an |the )?(?:quick |short |brief |detailed |bullet(?:ed)? |one[- ]line )*(?:summari[sz]e|summary|tl;?dr|recap|sum (?:it )?up|key points|main points|key takeaways)(?:\s+(?:it|this|that|for me|please|pls|now|in (?:\d+|a few|two|three|five|one) (?:sentences?|bullet points?|bullets?|points?|lines?|words?|paragraphs?)|in (?:simple|plain) (?:words|english|terms)|in bullet points?|briefly|shortly))*[.!?\s]*$/i;

/**
 * Is this a read-only question about the open page (summarize / explain / what is it about / translate it)? Never a task that does something on it.
 * A message that names an address, asks to search, or asks to click / type / buy / play ... is NOT one.
 */
function looksLikePageQuestion(goal) {
  const g = String(goal || "").trim();
  if (!g || g.length > 300) return false;
  if (/https?:\/\/|www\./i.test(g) || PAGE_ACTION.test(g)) return false;
  if (BARE_SUMMARY.test(g)) return true;
  return PAGE_REF.test(g) && PAGE_READ_VERB.test(g);
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

module.exports = { looksLikePageQuestion, looksLikeBrowserTask, looksLikeMissionTask, looksLikeDesktopTask, controlOf, isFollowUp, stripAgentModePhrase, stripAddress, BROWSER_VERBS };
