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

/** Search hits -> the block the server's prompt calls "Web Search Results" (empty when there is nothing to show). */
function formatSearchResults(query, items) {
  const lines = (items || [])
    .slice(0, 5)
    .map((it, i) => `${i + 1}. ${String(it.title || "").trim()} - ${String(it.snippet || "").replace(/\s+/g, " ").trim()}`.slice(0, 260));
  return lines.length ? `Web search results for "${query}":\n${lines.join("\n")}${STICK_TO_RESULTS}` : "";
}

module.exports = { needsGrounding, admitsNotKnowing, formatSearchResults };
