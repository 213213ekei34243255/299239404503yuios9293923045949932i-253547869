// Noah/test/unit/rexy-chat.test.cjs
//
// The bug reported live: the chat panel showed a bare "…" for an ordinary message ("Good Morning. Its a good weather
// uk chills") and never recovered. Root cause: the hosted /predict endpoint does not always answer chat mode with
// { answer }; for many questions it answers { needs_web_search: true, search_query }, asking the caller to search the
// web and come back. Rexy/llm.cjs's chat() assumed the Flask route "always" returns { answer } and silently dropped
// that request, returning an empty string; Rexy/runtime.cjs turned that empty string into a bare "…" - which looked
// exactly like a stuck typing indicator, not a completed (if unhelpful) reply.

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const SEARCH_PROXY_PATH = require.resolve("../../../search-proxy.cjs");
const LLM_PATH = require.resolve("../../../Rexy/llm.cjs");
const RUNTIME_PATH = require.resolve("../../../Rexy/runtime.cjs");

/** Install a fake search-proxy module before Rexy/llm.cjs (or anything else) requires it, and a fake global fetch for
 * the /predict endpoint. Returns a restore() that undoes both and clears the require caches used here. */
function withFakes({ fetchSearch, predictResponses }) {
  const originalFetch = global.fetch;
  const originalSearchModule = require.cache[SEARCH_PROXY_PATH];
  require.cache[SEARCH_PROXY_PATH] = { id: SEARCH_PROXY_PATH, filename: SEARCH_PROXY_PATH, loaded: true, exports: { fetchSearch } };
  delete require.cache[LLM_PATH];
  delete require.cache[RUNTIME_PATH];

  const calls = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    const reply = predictResponses.shift();
    return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => reply, text: async () => JSON.stringify(reply) };
  };

  return {
    calls,
    restore() {
      global.fetch = originalFetch;
      if (originalSearchModule) require.cache[SEARCH_PROXY_PATH] = originalSearchModule;
      else delete require.cache[SEARCH_PROXY_PATH];
      delete require.cache[LLM_PATH];
      delete require.cache[RUNTIME_PATH];
    },
  };
}

test("chat(): a plain { answer } reply is returned as-is, and no search is attempted", async () => {
  const f = withFakes({
    fetchSearch: async () => { throw new Error("must not be called"); },
    predictResponses: [{ answer: "It's a clear, cool morning." }],
  });
  try {
    const LLMClient = require(LLM_PATH);
    const llm = new LLMClient({});
    const reply = await llm.chat({ message: "Good morning" });
    assert.equal(reply, "It's a clear, cool morning.");
    assert.equal(f.calls.length, 1);
  } finally {
    f.restore();
  }
});

test("chat(): 'needs_web_search' triggers a REAL search, and the follow-up answer is returned - not a silently dropped request", async () => {
  const searchCalls = [];
  const f = withFakes({
    fetchSearch: async (kind, query) => {
      searchCalls.push({ kind, query });
      return { status: 200, body: { items: [{ title: "UK Weather Today", snippet: "Cold and clear across most of the UK, highs around 4C." }] } };
    },
    predictResponses: [
      { needs_web_search: true, search_query: "UK weather today" },
      { answer: "It's cold and clear across most of the UK today, highs around 4C." },
    ],
  });
  try {
    const LLMClient = require(LLM_PATH);
    const llm = new LLMClient({});
    // (a phrasing the client's own fact-lookup trigger does not catch, so this exercises the SERVER-asks path specifically)
    const reply = await llm.chat({ message: "should I bring an umbrella tomorrow" });
    assert.equal(searchCalls.length, 1, "the search was actually performed");
    assert.equal(searchCalls[0].kind, "web");
    assert.match(searchCalls[0].query, /UK weather today/i);
    assert.match(reply, /cold and clear/i, "the real answer came back, not an empty string");
    assert.equal(f.calls.length, 2, "one initial call plus one follow-up with the search results");
    // web_content, NOT page_content: the server only stops asking for a search when it receives web_content (verified
    // live: results sent as page_content came back as { needs_web_search } again and the user got "I don't have an answer")
    assert.match(f.calls[1].web_content, /UK Weather Today/, "the follow-up carries the search results as web_content");
    assert.equal(f.calls[1].page_content, undefined);
  } finally {
    f.restore();
  }
});

test("chat(): a search that finds nothing (or fails) degrades to an empty string, not an infinite loop or a crash", async () => {
  const f = withFakes({
    fetchSearch: async () => ({ status: 200, body: { items: [] } }),
    predictResponses: [{ needs_web_search: true, search_query: "an obscure query" }],
  });
  try {
    const LLMClient = require(LLM_PATH);
    const llm = new LLMClient({});
    const reply = await llm.chat({ message: "tell me about an obscure query" });
    assert.equal(reply, "");
    assert.equal(f.calls.length, 1, "no follow-up call when the search returned nothing to add");
  } finally {
    f.restore();
  }
});

test("chat(): a follow-up call that ALSO asks for a search does not loop (page_content already present)", async () => {
  const searchCalls = [];
  const f = withFakes({
    fetchSearch: async () => { searchCalls.push(1); return { status: 200, body: { items: [{ title: "T", snippet: "S" }] } }; },
    predictResponses: [
      { needs_web_search: true, search_query: "x" },
      { needs_web_search: true, search_query: "x" }, // the model asks again even with search results attached
    ],
  });
  try {
    const LLMClient = require(LLM_PATH);
    const llm = new LLMClient({});
    const reply = await llm.chat({ message: "x" });
    assert.equal(searchCalls.length, 1, "the search-triggered follow-up is only attempted once, never recursively");
    assert.equal(reply, "");
  } finally {
    f.restore();
  }
});

// ---- grounding: search only when it is needed, never on every message ------------------------------------------------

const HITS = { status: 200, body: { items: [{ title: "Iron Man - Wikipedia", snippet: "Robert Downey Jr. portrayed Tony Stark in Iron Man (2008)." }] } };

test("grounding: a fact lookup is answered WITH the web results (a small model made up 'Mark Ruffalo, 1979' for this)", async () => {
  const searches = [];
  const f = withFakes({ fetchSearch: async (kind, q) => { searches.push(q); return HITS; }, predictResponses: [{ answer: "Iron Man is played by Robert Downey Jr., first in the 2008 film." }] });
  try {
    const llm = new (require(LLM_PATH))({});
    const reply = await llm.chat({ message: "who is Ironman" });
    assert.match(reply, /Robert Downey/);
    assert.deepEqual(searches, ["who is Ironman"]);
    assert.equal(f.calls.length, 1, "searched first, then ONE model call - not ask, search, ask again");
    assert.match(f.calls[0].web_content, /Robert Downey Jr\. portrayed Tony Stark/);
  } finally { f.restore(); }
});

test("grounding: greetings, chit-chat, opinions, writing and questions about Noah never trigger a search", async () => {
  for (const message of ["Good morning", "how are you doing??", "thanks babe", "who are you", "who made you", "tell me a joke", "write a poem about the sea", "what do you think about pineapple on pizza", "Good morning. Its a good weather uk chills"]) {
    const f = withFakes({ fetchSearch: async () => { throw new Error("must not search for: " + message); }, predictResponses: [{ answer: "Sure." }] });
    try {
      const reply = await new (require(LLM_PATH))({}).chat({ message });
      assert.equal(reply, "Sure.", message);
      assert.equal(f.calls.length, 1, message);
      assert.equal(f.calls[0].web_content, undefined, message);
    } finally { f.restore(); }
  }
});

test("grounding: when the model itself says it does not know, the web is tried before that answer reaches the user", async () => {
  const searches = [];
  const f = withFakes({
    fetchSearch: async (kind, q) => { searches.push(q); return HITS; },
    predictResponses: [{ answer: "I'm not sure about that, my training data has a cutoff." }, { answer: "It was released in 2008." }],
  });
  try {
    const reply = await new (require(LLM_PATH))({}).chat({ message: "remind me about that indie film everyone liked" });
    assert.equal(reply, "It was released in 2008.");
    assert.equal(searches.length, 1);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].web_content, undefined, "the first ask is a plain one");
    assert.ok(f.calls[1].web_content, "the second carries the results");
  } finally { f.restore(); }
});

test("grounding: no results / a failing search degrades to the model's own answer - never an empty reply, never a second search", async () => {
  let searches = 0;
  const empty = withFakes({ fetchSearch: async () => { searches++; return { status: 200, body: { items: [] } }; }, predictResponses: [{ answer: "It is a famous armoured hero." }] });
  try {
    assert.equal(await new (require(LLM_PATH))({}).chat({ message: "who is Ironman" }), "It is a famous armoured hero.");
    assert.equal(searches, 1);
  } finally { empty.restore(); }
  const failing = withFakes({ fetchSearch: async () => { throw new Error("proxy down"); }, predictResponses: [{ answer: "I'm not sure." }] });
  try {
    const reply = await new (require(LLM_PATH))({}).chat({ message: "who is Ironman" });
    assert.match(reply, /^I'm not sure\./, "the model's own words come first");
    assert.match(reply, /couldn't check the web just now/, "...but the reader is told the web was NOT checked (a failed search is no longer silent)");
    assert.equal(failing.calls.length, 1, "the failed search is not retried by the second trigger");
  } finally { failing.restore(); }
});

// ============================ a search OUTAGE must say so (reported: the proxy answered HTTP 502 to every query, and the chat only ever said
// "I don't have an answer for that right now", so an outage looked like the assistant not knowing)

const PROXY_502 = { status: 502, body: { error: { message: "Search proxy answered HTTP 502" } } };

test("OUTAGE: a lookup the model can only answer by searching, with the search down, says the web could not be checked - not 'I don't have an answer'", async () => {
  const f = withFakes({ fetchSearch: async () => PROXY_502, predictResponses: [{ needs_web_search: true, search_query: "ok when is Avengers Endgame Encore releasing?" }] });
  try {
    const reply = await new (require(LLM_PATH))({}).chat({ message: "ok when is Avengers Endgame Encore releasing?" });
    assert.match(reply, /couldn't check the web for that just now/);
    assert.match(reply, /HTTP 502/);
    assert.match(reply, /can't give you a reliable answer/);
    assert.doesNotMatch(reply, /rephrase/i);
    assert.equal(f.calls.length, 1, "no pointless second model call after a failed search");
  } finally { f.restore(); }
});

test("OUTAGE: an answer from memory to a fact lookup is labelled as unchecked when the search was down (no silent hallucination)", async () => {
  const f = withFakes({ fetchSearch: async () => PROXY_502, predictResponses: [{ answer: "Ironman was created by Stan Lee and Jack Kirby." }] });
  try {
    const reply = await new (require(LLM_PATH))({}).chat({ message: "who is Ironman" });
    assert.match(reply, /^Ironman was created by Stan Lee/);
    assert.match(reply, /couldn't check the web just now - the search service returned an error, HTTP 502 - so this comes from memory and may be out of date or wrong/);
  } finally { f.restore(); }
});

test("OUTAGE: a rejected/missing search key is named as such", async () => {
  const f = withFakes({ fetchSearch: async () => ({ status: 502, body: { error: { message: "The search proxy rejected JONAH_PROXY_KEY" } } }), predictResponses: [{ needs_web_search: true, search_query: "weather in London" }] });
  try {
    assert.match(await new (require(LLM_PATH))({}).chat({ message: "tell me the weather in London" }), /search key is missing or was rejected/);
  } finally { f.restore(); }
});

test("OUTAGE: 'no results' is NOT an outage - it keeps the old behaviour (no failure message)", async () => {
  const f = withFakes({ fetchSearch: async () => ({ status: 200, body: { items: [] } }), predictResponses: [{ needs_web_search: true, search_query: "nothing findable" }] });
  try {
    assert.equal(await new (require(LLM_PATH))({}).chat({ message: "tell me about nothing findable" }), "");
  } finally { f.restore(); }
});

test("the search is made for the QUESTION, cleaned of chatter: 'ok when is X releasing?' -> 'when is X releasing'", async () => {
  const queries = [];
  const f = withFakes({
    fetchSearch: async (_k, q) => { queries.push(q); return { status: 200, body: { items: [{ title: "Avengers: Endgame re-release", snippet: "Re-release set for later this year." }] } }; },
    predictResponses: [{ answer: "It is set for later this year." }],
  });
  try {
    await new (require(LLM_PATH))({}).chat({ message: "ok when is Avengers Endgame Encore releasing?" });
    assert.deepEqual(queries, ["when is Avengers Endgame Encore releasing"]);
  } finally { f.restore(); }
});

test("FOLLOW-UP: 'can you check the web' after a question searches for THAT question, not for the words 'can you check the web'", async () => {
  const queries = [];
  const f = withFakes({
    fetchSearch: async (_k, q) => { queries.push(q); return { status: 200, body: { items: [{ title: "T", snippet: "S" }] } }; },
    predictResponses: [{ answer: "First answer." }, { answer: "Checked answer." }],
  });
  try {
    const RexyRuntime = require(RUNTIME_PATH);
    const LLMClient = require(LLM_PATH);
    const fakeThis = { llm: new LLMClient({}), memory: { export: () => ({ sessionId: "t" }) } };
    await RexyRuntime.prototype._chatReply.call(fakeThis, "ok when is Avengers Endgame Encore releasing?");
    const reply = await RexyRuntime.prototype._chatReply.call(fakeThis, "can you check the web");
    assert.equal(reply, "Checked answer.");
    assert.deepEqual(queries, ["when is Avengers Endgame Encore releasing", "when is Avengers Endgame Encore releasing"], "both searches are about the real question");
    assert.ok(f.calls.every((c) => c.message !== "can you check the web"), "the model is never sent the follow-up wording as if it were the question");
  } finally { f.restore(); }
});

test("FOLLOW-UP: with no previous question there is nothing to re-ask, so the message is sent as it is", async () => {
  const f = withFakes({ fetchSearch: async () => ({ status: 200, body: { items: [] } }), predictResponses: [{ answer: "Sure." }] });
  try {
    const RexyRuntime = require(RUNTIME_PATH);
    const fakeThis = { llm: new (require(LLM_PATH))({}), memory: { export: () => ({ sessionId: "t" }) } };
    await RexyRuntime.prototype._chatReply.call(fakeThis, "can you check the web");
    assert.equal(f.calls[0].message, "can you check the web");
  } finally { f.restore(); }
});

test("isBareSearchFollowUp / toSearchQuery: only a bare 'do it with the web' follow-up is rewritten; real questions and tasks are left alone", () => {
  const { isBareSearchFollowUp, toSearchQuery, describeSearchFailure } = require("../../../Rexy/grounding.cjs");
  for (const t of ["can you check the web", "search it", "google it", "look it up", "check online", "please search the internet", "ok can you just check the web again", "try the web"]) assert.equal(isBareSearchFollowUp(t), true, t);
  for (const t of ["search for laptops under 50000", "when is Endgame releasing", "check the web for the Avengers release date", "hello", "who is Ironman", "can you check my spelling", ""]) assert.equal(isBareSearchFollowUp(t), false, t);
  assert.equal(toSearchQuery("ok when is Avengers Endgame Encore releasing?"), "when is Avengers Endgame Encore releasing");
  assert.equal(toSearchQuery("hey can you tell me who is the president of France please"), "who is the president of France");
  assert.equal(toSearchQuery("weather"), "weather");
  assert.match(describeSearchFailure({ body: { error: { message: "Search proxy answered HTTP 502" } } }), /HTTP 502/);
  assert.match(describeSearchFailure({ body: { error: { message: "Search proxy unreachable: ENOTFOUND" } } }), /could not be reached/);
  assert.match(describeSearchFailure({}), /not responding/);
  // once the server reports Google's own reason, the reader is told what to fix
  const g = (message) => describeSearchFailure({ body: { error: { message } } });
  assert.match(g("Search request failed: Google returned HTTP 429: Quota exceeded for quota metric 'Queries' and limit 'Queries per day'"), /quota is used up/);
  assert.match(g("Google returned HTTP 400: API key not valid. Please pass a valid API key."), /rejected the search server's API key/);
  assert.match(g("Google returned HTTP 403: Custom Search API has not been used in project 123 before or it is disabled."), /switched off/);
  assert.match(g("Google returned HTTP 403: This project has no billing account"), /billing/);
  assert.match(g("Search proxy answered HTTP 502"), /HTTP 502/, "a bare 502 still says what it can");
  assert.match(g("The search proxy rejected JONAH_PROXY_KEY"), /search key is missing or was rejected/);
});

test("grounding: the server's own canned 'no matching command' reply is not mistaken for the model not knowing", async () => {
  const f = withFakes({ fetchSearch: async () => { throw new Error("must not search"); }, predictResponses: [{ answer: "I couldn't find a matching command. Try again with clearer words." }] });
  try {
    assert.match(await new (require(LLM_PATH))({}).chat({ message: "open the pod bay doors" }), /matching command/);
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

// ---- typed vs spoken: only what answers something the user SPOKE is read aloud -----------------------------------------

function submitWith({ source, route, browsy = false, mode }) {
  const RexyRuntime = require(RUNTIME_PATH);
  const events = [];
  const chats = [];
  const fakeThis = {
    noah: { isAvailable: () => true, route: route || (() => ({ handled: false, kind: "chat" })), submit: () => "agent-id" },
    log: { info() {}, warn() {} },
    emit: (name, payload) => events.push([name, payload]),
    _notifyRenderer() {},
    _looksLikeBrowserTask: () => browsy,
    _runChatGoal: (entry) => chats.push(entry),
    lastSubmit: null,
  };
  const id = RexyRuntime.prototype.submitGoal.call(fakeThis, "hello there", { source, mode });
  return { id, events, chats, fakeThis };
}

test("typed vs spoken: every chat entry carries how it was given, so the voice orb can stay silent for typed messages", () => {
  const f = withFakes({ fetchSearch: async () => HITS, predictResponses: [] });
  try {
    assert.equal(submitWith({}).chats[0].source, "text", "no source given = typed");
    assert.equal(submitWith({ source: "text" }).chats[0].source, "text");
    assert.equal(submitWith({ source: "voice" }).chats[0].source, "voice");
    assert.equal(submitWith({ source: "anything else" }).chats[0].source, "text", "only 'voice' counts as spoken");
    assert.equal(submitWith({ source: "voice", mode: "chat", browsy: true }).chats[0].source, "voice");
  } finally { f.restore(); }
});

test("typed vs spoken: a control reply ('Stopped.') and an agent hand-off keep the source too", async () => {
  const f = withFakes({ fetchSearch: async () => HITS, predictResponses: [] });
  try {
    const control = submitWith({ source: "text", route: () => ({ handled: true, kind: "control", reply: "Stopped." }) });
    await new Promise((r) => setImmediate(r));
    const completed = control.events.find(([n]) => n === "goal:completed")[1];
    assert.deepEqual([completed.reason, completed.source], ["Stopped.", "text"]);

    const seen = [];
    submitWith({ source: "voice", route: (text, opts) => { seen.push(opts.source); return { handled: true, kind: "agent", id: "a1" }; } });
    assert.deepEqual(seen, ["voice"], "the router (and so the agent session) is told it was spoken");
  } finally { f.restore(); }
});

test("the end-to-end reply for a genuinely unanswerable message is an honest sentence, never a bare '…'", async () => {
  const f = withFakes({
    fetchSearch: async () => ({ status: 200, body: { items: [] } }),
    predictResponses: [{ needs_web_search: true, search_query: "nothing findable" }],
  });
  try {
    const RexyRuntime = require(RUNTIME_PATH);
    const LLMClient = require(LLM_PATH);
    // _chatReply only touches this.llm and this.memory: exercise it directly rather than constructing a full runtime
    // (which wires up Observer/Bridge/Vision/Voice against a real Electron window).
    const fakeThis = { llm: new LLMClient({}), memory: { export: () => ({ sessionId: "t" }) } };
    const reply = await RexyRuntime.prototype._chatReply.call(fakeThis, "tell me about nothing findable");
    assert.notEqual(reply, "…");
    assert.match(reply, /don't have an answer|rephrase/i);
  } finally {
    f.restore();
  }
});

// ============================ reported live: the results said Endgame is re-released "in September, under the name Avengers
// Endgame: Encore", and the hosted model answered "The release date for Avengers: Endgame Encore in 2026 is not yet known."

const ENCORE_HITS = { status: 200, body: { items: [
  { title: "Avengers: Endgame", link: "https://en.wikipedia.org/wiki/Avengers:_Endgame", snippet: "Avengers: Endgame is a 2019 American superhero film based on the Marvel Comics superhero team the Avengers. Produced by Marvel Studios and distributed" },
  { title: "Avengers: Doomsday", link: "https://en.wikipedia.org/wiki/Avengers:_Doomsday", snippet: "coinciding with the re-release of Endgame in September, under the name Avengers Endgame: Encore. Avengers: Doomsday is scheduled to be released in the United States" },
  { title: "Production of Avengers: Doomsday and Avengers: Secret Wars", link: "https://en.wikipedia.org/wiki/Production_of_Avengers", snippet: "respectively the fifth and sixth installments in the Avengers film series following Avengers: Endgame (2019), and the 39th and 40th films of the Marvel Cinematic" },
  { title: "Characters of the Marvel Cinematic Universe: A-L", link: "https://en.wikipedia.org/wiki/Characters_of_the_MCU", snippet: "Tom (September 23, 2026). \"Avengers: Endgame Encore Leaks Reveal New Ending and Additional Scenes That Connect to Avengers: Doomsday, Including Several" },
  { title: "Marvel Cinematic Universe timeline", link: "https://en.wikipedia.org/wiki/MCU_timeline", snippet: "timeline order to their releases, but Phase Three saw many of the films overlapping with each other." },
] } };

test("chat(): the model wrongly says the results don't answer it -> asked ONCE more with only the relevant results, and that answer is used", async () => {
  const queries = [];
  const f = withFakes({
    fetchSearch: async (_k, q) => { queries.push(q); return ENCORE_HITS; },
    predictResponses: [
      { answer: "The release date for Avengers: Endgame Encore in 2026 is not yet known." },
      { answer: "Reports say Avengers: Endgame is re-released in September 2026 as Avengers: Endgame Encore." },
    ],
  });
  try {
    const LLMClient = require(LLM_PATH);
    const reply = await new LLMClient({}).chat({ message: "When is Avengers Endgame Encore releasing>" });
    assert.deepEqual(queries, ["When is Avengers Endgame Encore releasing"], "the stray '>' is not searched for");
    assert.equal(reply, "Reports say Avengers: Endgame is re-released in September 2026 as Avengers: Endgame Encore.");
    const retry = f.calls[1].web_content;
    assert.match(retry, /re-release of Endgame in September/);
    assert.doesNotMatch(retry, /2019 American superhero film/, "the second try only carries the results that are about the question");
    assert.match(retry, /Reports say/);
    assert.equal(f.calls.length, 2, "one extra try at most");
  } finally {
    f.restore();
  }
});

test("chat(): if the second try still won't use them, the user sees what the results say (site + date), not the model's claim", async () => {
  const f = withFakes({
    fetchSearch: async () => ENCORE_HITS,
    predictResponses: [{ answer: "The release date for Avengers: Endgame Encore in 2026 is not yet known." }, { answer: "It is not yet known." }],
  });
  try {
    const LLMClient = require(LLM_PATH);
    const reply = await new LLMClient({}).chat({ message: "When is Avengers Endgame Encore releasing?" });
    assert.doesNotMatch(reply, /not yet known/);
    assert.match(reply, /^Here's what the search results say:/);
    assert.match(reply, /re-release of Endgame in September, under the name Avengers Endgame: Encore.*\(en\.wikipedia\.org\)/);
    assert.doesNotMatch(reply, /2019 American superhero film/, "results that do not mention what was asked are left out");
  } finally {
    f.restore();
  }
});

const RONALDO_HITS = { status: 200, body: { items: [
  { title: "Is Cristiano Ronaldo playing for Portugal vs. Wales in ...", link: "https://sports.yahoo.com/articles/ronaldo-portugal-wales", displayLink: "sports.yahoo.com", snippet: "2 days ago — Cristiano Ronaldo is still going strong with Portugal. will participate in four upcoming UEFA Nations League matches. Ronaldo is set to start ..." },
  { title: "Is Cristiano Ronaldo playing today? Confirmed lineups for ...", link: "https://worldsoccertalk.com/news/ronaldo-lineups", displayLink: "worldsoccertalk.com", snippet: "2 days ago — Cristiano Ronaldo is set to headline a new era for Portugal when the reigning Nations League champion begins its title defence against Wales ...Read more" },
] } };

test("chat(): Google's snippet decorations ('2 days ago —', 'Read more') become a date label, for the model and in quotes", async () => {
  const f = withFakes({ fetchSearch: async () => RONALDO_HITS, predictResponses: [{ answer: "It is not confirmed whether Ronaldo is playing." }, { answer: "I could not confirm it." }] });
  try {
    const LLMClient = require(LLM_PATH);
    const reply = await new LLMClient({}).chat({ message: "Is Cristiano Ronaldo playing today?" });
    const sent = f.calls[0].web_content;
    assert.match(sent, /\(sports\.yahoo\.com, 2 days ago\) - Cristiano Ronaldo is still going strong/, "the model is told how recent each result is");
    assert.doesNotMatch(sent, /Read more|2 days ago —/);
    assert.match(reply, /• "Cristiano Ronaldo is set to headline a new era for Portugal .*against Wales…" \(worldsoccertalk\.com, 2 days ago\)/);
    assert.doesNotMatch(reply, /Read more/);
  } finally {
    f.restore();
  }
});

test("chat(): a normal grounded answer, or a 'not found' with no relevant results, is passed through unchanged", async () => {
  const f = withFakes({ fetchSearch: async () => ENCORE_HITS, predictResponses: [{ answer: "It is re-released in September 2026 as Avengers: Endgame Encore." }] });
  try {
    const LLMClient = require(LLM_PATH);
    assert.equal(await new LLMClient({}).chat({ message: "When is Avengers Endgame Encore releasing?" }), "It is re-released in September 2026 as Avengers: Endgame Encore.");
  } finally {
    f.restore();
  }
  const g = withFakes({ fetchSearch: async () => ENCORE_HITS, predictResponses: [{ answer: "I could not confirm when the Zorblax 9 launches from the search results." }] });
  try {
    const LLMClient = require(LLM_PATH);
    assert.match(await new LLMClient({}).chat({ message: "When is the Zorblax 9 launching?" }), /could not confirm when the Zorblax 9/);
  } finally {
    g.restore();
  }
});
