// Rexy/grounding.cjs
//
// When should a chat reply be backed by a live web search instead of trusted from the hosted model's memory?
//
// Not on every message: a greeting, an opinion, a joke or a piece of writing gains nothing from a search and would just be
// slower. But the hosted model is small and cannot tell when it is guessing - a real reported answer to "who is Ironman" was
// "portrayed by Mark Ruffalo ... first appearance in 1979", stated as confidently as a correct one. So there are two triggers
// that do not depend on the model knowing its own limits:
//
//   1. needsGrounding(message)     the QUESTION is a fact lookup a small model tends to invent answers for (who/when/where
//                                  a named thing, how many/old/tall, latest/current/today, prices, scores, ...)
//   2. admitsNotKnowing(answer)    the model itself says it does not know / is unsure / has a knowledge cutoff
//
// Both are deliberately narrow and cheap (no model call). Search results go back to the server as `web_content`, the field
// its own prompt treats as "freshly retrieved, more current than your memory".

"use strict";

// Questions about the assistant itself ("who are you", "who made you", "what is your name") are answered from its own
// identity, never from the web.
const ABOUT_THE_ASSISTANT = /\b(?:you|your|yours|yourself|noah|rexy)\b/i;

// The user wants something MADE or DONE, not looked up.
const NOT_A_LOOKUP = /^\s*(?:please\s+)?(?:write|draft|compose|rewrite|translate|summari[sz]e|explain|solve|calculate|compute|code|debug|fix|create|generate|make|tell me a|give me a|help me|can you (?:write|help|explain|solve))\b/i;

// The user is talking about the page in front of them, which is its own (attached) context.
const ABOUT_THIS_PAGE = /\b(?:this|the current)\s+(?:page|site|website|article|tab|document|post|video)\b/i;

// Question shapes that are lookups by construction. They must start near the front of the message (or the message must be
// a question), so "I already know who is coming tonight" in the middle of a sentence is not swept in.
const LOOKUP_SHAPES = [
  // who is / who played / who won / who created ... (people and entities: the most confabulated question type)
  /\bwho(?:'s|s)?\s+(?:is|are|was|were|played|plays|won|wins|created|made|invented|discovered|directed|wrote|founded|owns|sang|sings|scored|painted|composed|starred|voices|voiced)\b/i,
  // when / where a named thing happened or is
  /\b(?:when|where)\s+(?:is|are|was|were|did|does|do|will)\b/i,
  // quantities and measurements
  /\bhow\s+(?:many|much|old|tall|far|big|large|heavy|fast)\b/i,
  /\bhow\s+long\s+(?:is|was|does|did|has|have)\b/i,
  /\bwhat\s+(?:year|date|day|time)\b/i,
  /\bwhich\s+(?:year|country|city|company|team|player|movie|film|song|album|book|actor|actress|singer|band)\b/i,
];

// Things that change, or that a memory can only guess at. On their own these words appear in plain chit-chat ("its a good
// weather today"), so they only count when the message is phrased as a question or a request.
const TIME_SENSITIVE = /\b(?:release date|net worth|population of|stock price|price of|weather|forecast|latest|newest|current(?:ly)?|today|tonight|yesterday|this (?:week|month|year|season)|right now|breaking|news|score of|final score|winner|champion|standings|prime minister|president of|ceo of)\b/i;
const QUESTION_OR_REQUEST = /\?|^\W*(?:what|whats|what's|how|is|are|will|does|do|did|when|where|who|which|tell me|give me|show me|find|any|latest|current|news|weather|price|score)\b/i;

// "what is Ironman" / "what's Tesla": a definition question about a NAMED thing (capitalised or numeric) is a lookup;
// "what is a black hole" / "what is love" is general knowledge a model handles without a search.
const NAMED_ENTITY = /\b(?:what|who|where|when)(?:'s|s| is| are| was| were)\s+(?:the |a |an )?([A-Za-z0-9][\w'.-]*)/i;

// "hey can you tell me who is the president of France": the "you" is a polite lead-in, not a question about the assistant.
const POLITE_LEAD_IN = /^\W*(?:(?:hey|hi|hello|ok|okay|so|please)\W+)*(?:(?:can|could|would|will)\s+you|do\s+you\s+know|you\s+know)\s+(?:please\s+)?(?:tell\s+me|show\s+me|find\s+out|find|give\s+me|let\s+me\s+know|know)?\s*/i;

/** Should this chat message be answered from a live web search rather than the model's memory? */
function needsGrounding(message) {
  const text = String(message || "").trim();
  if (text.length < 6 || text.length > 400) return false;
  if (ABOUT_THE_ASSISTANT.test(text.replace(POLITE_LEAD_IN, "")) || NOT_A_LOOKUP.test(text) || ABOUT_THIS_PAGE.test(text)) return false;
  const near = (re) => {
    const m = re.exec(text);
    return !!m && (m.index <= 30 || text.includes("?"));
  };
  if (LOOKUP_SHAPES.some(near)) return true;
  if (TIME_SENSITIVE.test(text) && QUESTION_OR_REQUEST.test(text)) return true;
  const named = NAMED_ENTITY.exec(text);
  return !!(named && /^[A-Z0-9]/.test(named[1]));
}

// A hosted-server canned reply that merely LOOKS like an admission ("I couldn't find a matching command") is the server's
// command handler talking, not the model saying it does not know.
const SERVER_CANNED = /matching command|clearer words|invalid input/i;
const ADMITS_NOT_KNOWING = new RegExp(
  [
    "i (?:do not|don't|dont) (?:know|have (?:any )?(?:information|data|details|access|real[- ]time|up[- ]to[- ]date|current|knowledge))",
    "i(?:'m| am) (?:not sure|unsure|not certain|not aware|not familiar|unable to (?:find|verify|confirm|access|browse|look up|provide))",
    "i (?:can(?:not|'t)|couldn't|could not) (?:browse|access the internet|verify|confirm|look (?:it )?up|find (?:any|that|information|details))",
    "as of my (?:last |latest )?(?:knowledge|training|update)",
    "(?:knowledge|training(?: data)?) (?:cut-?off|limit)",
    "(?:no|don't have|do not have) (?:reliable |up[- ]to[- ]date |current |real[- ]time )?(?:information|records?|data) (?:about|on|regarding|for)",
    "not (?:aware|familiar) (?:of|with)",
  ].join("|"),
  "i"
);

/** Did the model just say it does not know (so a search should be tried before giving that answer to the user)? */
function admitsNotKnowing(answer) {
  const text = String(answer || "");
  if (!text || SERVER_CANNED.test(text)) return false;
  return ADMITS_NOT_KNOWING.test(text);
}

// Handing the hosted (small) model search results is not enough on its own: it read them and then added invented details
// anyway (measured live, 5 runs of "who is Ironman" WITH a correct Wikipedia snippet attached: made-up first appearances,
// creators and actors in 4 of 5). The same results plus this one instruction: 0 of 5, and the answers stayed inside what
// the snippet actually says. If the results do not contain the answer it says so - honest, and not a reason to search again.
const STICK_TO_RESULTS = "\nAnswer ONLY from the search results above. Do not add facts that are not in them. If they do not contain the answer, say you could not confirm it from the search results.";

// Google's snippets start with how old the page is ("2 days ago — Ronaldo is set to start...", "12 Sept 2026 — ...") and can end
// with "Read more". The age is worth keeping (it is how "today" questions get answered) but as a label, not as snippet text.
const LEADING_AGE = /^((?:\d+\s+(?:second|minute|min|hour|hr|day|week|month|year)s?\s+ago)|(?:\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4})|(?:[A-Za-z]{3,9}\.?\s+\d{1,2},\s+\d{4})|yesterday|today)\s*[—–-]\s*/i;

/** A search snippet without Google's decorations: { text, age } ("2 days ago" / "12 Sept 2026" / ""). */
function cleanSnippet(snippet) {
  let text = String(snippet || "").replace(/\s+/g, " ").trim();
  let age = "";
  const m = LEADING_AGE.exec(text);
  if (m) {
    age = m[1];
    text = text.slice(m[0].length);
  }
  text = text.replace(/\s*(?:\.{3}|…)?\s*Read more\s*$/i, "…").replace(/\s*\.{3}$/, "…").trim();
  return { text, age };
}

function siteOf(it) {
  const host = String((it && it.displayLink) || "").replace(/^www\./, "");
  if (host) return host;
  try {
    return new URL(it.link).hostname.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

function resultLine(it, i) {
  const { text, age } = cleanSnippet(it.snippet);
  const label = [siteOf(it), age].filter(Boolean).join(", ");
  return `${i + 1}. ${String(it.title || "").trim()}${label ? ` (${label})` : ""} - ${text}`.slice(0, 320);
}

/** Search hits -> the block the server's prompt calls "Web Search Results" (empty when there is nothing to show). */
function formatSearchResults(query, items) {
  const lines = (items || []).slice(0, 5).map(resultLine);
  return lines.length ? `Web search results for "${query}":\n${lines.join("\n")}${STICK_TO_RESULTS}` : "";
}

// The hosted model sometimes says the results do not answer the question when they plainly do. Measured live: the results said
// Endgame is re-released "in September, under the name Avengers Endgame: Encore" and the model replied "The release date for
// Avengers: Endgame Encore in 2026 is not yet known." When the model says that, but results clearly mention what was asked, the
// user is shown what the results actually say (with where each came from) instead of the model's claim.
const SAYS_NOT_IN_RESULTS = /\b(?:not (?:yet )?(?:known|available|announced|confirmed|mentioned|specified|provided|found|listed|clear)|unknown|could(?:n't| not) (?:confirm|find|determine)|(?:do|does) not (?:contain|mention|say|include|specify|provide)|no (?:information|details|mention|confirmed|official))\b/i;
const QUERY_STOPWORDS = new Set("what whats when where who whos which how is are was were will would does did do the a an of in on at for to and or it its be been this that there their about tell me please can could you your any".split(" "));

function saysNotInResults(answer) {
  return SAYS_NOT_IN_RESULTS.test(String(answer || ""));
}

/** The results (at most `limit`) that mention most of what was asked; [] when none clearly does. */
function relevantResults(query, items, limit = 3) {
  const terms = [...new Set((String(query || "").toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || []).filter((w) => w.length >= 3 && !QUERY_STOPWORDS.has(w)))];
  if (!terms.length) return [];
  const needed = Math.max(Math.min(2, terms.length), Math.ceil(terms.length * 0.6));
  return (items || []).slice(0, 8)
    .map((it) => {
      const text = `${it.title || ""} ${it.snippet || ""}`;
      return { it, score: terms.filter((t) => new RegExp(`\\b${t.replace(/[^a-z0-9]/g, "\\$&")}`, "i").test(text)).length };
    })
    .filter((s) => s.score >= needed && cleanSnippet(s.it.snippet).text)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.it);
}

/** A second, narrower try: ONLY the results that are about the question, and an instruction to answer from them (reporting,
 * not inventing: "reports say..." when they only expect something). */
function formatFocusedResults(query, items) {
  return `Search results about "${query}":\n${items.map(resultLine).join("\n")}\nThese results are about the question. Answer it in one or two sentences using what they say. If they only report or expect something ("set to", "expected to"), say that ("Reports say ..."). Mention how recent they are when it matters. Do not add facts that are not in them.`;
}

/** The results that mention what was asked, quoted with their site and age; "" when none clearly does. */
function quoteRelevantResults(query, items) {
  const best = relevantResults(query, items, 2);
  if (!best.length) return "";
  const lines = best.map((it) => {
    const { text, age } = cleanSnippet(it.snippet);
    const label = [siteOf(it), age].filter(Boolean).join(", ");
    return `• "${text.slice(0, 260)}"${label ? ` (${label})` : ""}`;
  });
  return `Here's what the search results say:\n${lines.join("\n")}`;
}

/**
 * Why a search attempt failed, in words a person can act on. A failed search used to be invisible: the reply fell back to the model's
 * memory (or a vague "I don't have an answer") and nothing said the WEB had not been checked at all - so a search outage (the proxy
 * answering HTTP 502 to every query) looked like the assistant simply not knowing.
 */
function describeSearchFailure(results) {
  const msg = String((results && results.body && results.body.error && results.body.error.message) || (results && results.message) || "");
  const http = /\bHTTP (\d{3})\b/.exec(msg);
  // Reasons Google itself gives (once the server passes them on instead of hiding them behind a bare 502): say what to fix.
  if (/quota|rate ?limit|too many requests|queries per (?:day|minute)/i.test(msg)) return "Google's search quota is used up (the free quota resets daily)";
  if (/api[ _-]?key (?:is )?(?:not valid|invalid|expired)|API_KEY_INVALID/i.test(msg)) return "Google rejected the search server's API key";
  if (/has not been used|is disabled|accessNotConfigured|SERVICE_DISABLED|not enabled|not been enabled/i.test(msg)) return "the Custom Search API is switched off for the server's Google project";
  if (/billing/i.test(msg)) return "the search server's Google project has no billing set up";
  if (/JONAH_PROXY_KEY|rejected/i.test(msg)) return "the search key is missing or was rejected";
  // Google's own page was too slow (a busy PC) AND the backup failed: say that, not a vague "not responding"
  if (/could not be read in time|did not answer in time/i.test(msg)) return "Google's search page was too slow to load (your computer may be busy) and the backup search did not answer";
  if (http) return `the search service returned an error, HTTP ${http[1]}`;
  if (/unreachable|ENOTFOUND|ECONN|timeout|timed out|network/i.test(msg)) return "the search service could not be reached";
  return "the search service is not responding";
}
const searchDownAnswer = (why) => `I couldn't check the web for that just now (${why}), so I can't give you a reliable answer. Please try again in a moment.`;
const fromMemoryNote = (why) => `(I couldn't check the web just now - ${why} - so this comes from memory and may be out of date or wrong.)`;

/** The message as a search query: "ok when is X releasing?" -> "when is X releasing" (no chatter, no polite lead-in, no trailing "please"). */
function toSearchQuery(text) {
  const original = String(text || "").trim().replace(/\s+/g, " ");
  let q = original.replace(/^\W*(?:(?:ok(?:ay)?|so|hey|hi|hello|well|please|and|then)\W+)+/i, "");
  q = q.replace(POLITE_LEAD_IN, "");
  q = q.replace(/\W*\bplease\b\W*$/i, "").replace(/[\s?!>.]+$/, "").trim();
  return q || original;
}

// "can you check the web", "search it", "google it", "look it up", "try the internet": a follow-up that says HOW to answer the question just
// asked, not a question of its own. Searching for those words is pointless; the search must be about the previous question.
const FOLLOW_UP_FILLER = new Set(["can", "could", "would", "will", "you", "please", "just", "ok", "okay", "so", "hey", "then", "now", "again", "the", "it", "that", "this", "up", "on", "in", "at", "for", "me", "us", "try", "check", "search", "look", "google", "browse", "find", "out", "web", "internet", "online", "net", "yourself", "and", "a", "quick", "little", "bit", "more", "also"]);
const FOLLOW_UP_VERB = new Set(["check", "search", "look", "google", "browse", "find", "try"]);
const FOLLOW_UP_TARGET = new Set(["web", "internet", "online", "net", "google", "it", "that", "this"]);
function isBareSearchFollowUp(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 60) return false;
  const words = t.toLowerCase().match(/[a-z']+/g) || [];
  return words.length > 0 && words.every((w) => FOLLOW_UP_FILLER.has(w)) && words.some((w) => FOLLOW_UP_VERB.has(w)) && words.some((w) => FOLLOW_UP_TARGET.has(w));
}

module.exports = { needsGrounding, admitsNotKnowing, formatSearchResults, describeSearchFailure, searchDownAnswer, fromMemoryNote, toSearchQuery, isBareSearchFollowUp, saysNotInResults, relevantResults, formatFocusedResults, quoteRelevantResults, cleanSnippet };
