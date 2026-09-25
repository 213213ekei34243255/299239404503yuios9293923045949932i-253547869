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
    assert.equal(await new (require(LLM_PATH))({}).chat({ message: "who is Ironman" }), "I'm not sure.", "the admission is returned as-is, and the failed search is not retried by the second trigger");
    assert.equal(failing.calls.length, 1);
  } finally { failing.restore(); }
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
