// Noah/test/unit/media-search.test.cjs
//
// Regression tests for the reported bug: "do me a favour ... find a song on youtube ... like Cold song ... by NCS" got a
// plain-chat refusal reported as "Done", and "search for the song named Cold by NCS" searched for that literal phrase
// and (via view-count ranking alone) could open an unrelated "Maroon 5 - Cold" instead of an NCS release.
//
// Root causes fixed:
//   1. models/rexy-legacy.cjs trusted the hosted model's self-reported `complete: true` with no verification at all -
//      ACTION SUCCESS (a tool call returning ok) is not TASK SUCCESS (the user's goal actually being achieved).
//   2. models/goal-script.cjs's search-query extraction kept "the song named ..." filler verbatim, and its result
//      picker (chooseResult) had no way to prefer a result that actually named the requested artist/channel.
//   3. A goal shaped like "find/play <title> by <artist>" (no "search for"/"like"/"named") produced no script at all
//      (or, for "play it" alone, a lone unreachable {kind:'play'}), leaving the raw weak model with no scaffolding.

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseGoalScript, chooseResult, GoalScripts } = require("../../models/goal-script.cjs");
const { verifyCompletion, looksLikeRefusalOrChat } = require("../../models/completion-guard.cjs");
const { RexyLegacyProvider, goalNeedsAnswer } = require("../../models/rexy-legacy.cjs");

const MSG1 = "do me a favour its winter chills out here find a song on youtube go to youtube which can give us chill like Cold song if its possible by NCS";
const MSG2 = "Can you search for the song named Cold by NCS";
const MSG3 = "Find Cold by NCS on YouTube and play it";
const MSG4 = "Search Cold.";
const MSG5 = "Find a chill song like Cold by NCS and play it";

// ---- TEST 1-5 from the bug report: the parsed script shape for each request -------------------------------------

test("TEST 1: 'Go to YouTube.' implies no search/pick/play script (handled by the deterministic open-URL path, not this)", () => {
  assert.deepEqual(parseGoalScript("Go to YouTube."), []);
});

test("TEST 2: 'Go to YouTube and search Cold by NCS.' searches ONLY - it does not assume a video should be opened", () => {
  assert.deepEqual(parseGoalScript("Go to YouTube and search Cold by NCS."), [{ kind: "search", query: "Cold by NCS" }]);
});

test("TEST 3 / repro msg3: 'Find Cold by NCS on YouTube and play it' searches, opens the NCS match, then plays it (not a lone unreachable 'play')", () => {
  assert.deepEqual(parseGoalScript(MSG3), [
    { kind: "search", query: "Cold NCS" },
    { kind: "pick", which: "best", artist: "NCS" },
    { kind: "play" },
  ]);
});

test("TEST 4: 'Search Cold.' searches for exactly 'Cold' - it does not invent an artist or assume which 'Cold'", () => {
  assert.deepEqual(parseGoalScript(MSG4), [{ kind: "search", query: "Cold" }]);
});

test("TEST 5 / repro msg1 & msg5: a loose 'find a [chill] song like X ... by Y [and play it]' resolves to search + artist-aware pick (+ play if asked)", () => {
  assert.deepEqual(parseGoalScript(MSG5), [
    { kind: "search", query: "Cold NCS" },
    { kind: "pick", which: "best", artist: "NCS" },
    { kind: "play" },
  ]);
  // msg1: no "play" verb at all -> find and open a match, but do not start playback that was never asked for
  assert.deepEqual(parseGoalScript(MSG1), [
    { kind: "search", query: "Cold NCS" },
    { kind: "pick", which: "best", artist: "NCS" },
  ]);
});

test("repro msg2: 'search for the song named Cold by NCS' searches for the TITLE, not the filler sentence", () => {
  assert.deepEqual(parseGoalScript(MSG2), [{ kind: "search", query: "Cold by NCS" }]);
});

test("a goal with no media context is left alone (no false-positive script for ordinary page tasks)", () => {
  for (const g of ["find the login button and click it", "find the cheapest laptop and buy it", "get me the total on this invoice", "discover more settings"]) {
    assert.deepEqual(parseGoalScript(g), [], g);
  }
});

// ---- follow-up bug: "search for the song named Cold by NCS play it" and a standalone "Play the song please" -------

test("'search for X ... play it' in ONE message: the search query stops before 'play' (it used to swallow 'play it' into the query), and a pick is inserted since nothing said 'best'/'first'", () => {
  assert.deepEqual(parseGoalScript("Its a cold weather open youtube and search for the song named Cold by NCS play it"), [
    { kind: "search", query: "Cold by NCS" },
    { kind: "pick", which: "best", artist: "NCS" },
    { kind: "play" },
  ]);
});

test("a bare 'Play the song please' / 'play it' names nothing new to search for - it is just 'play', not 'search for song please'", () => {
  assert.deepEqual(parseGoalScript("Play the song please"), [{ kind: "play" }]);
  assert.deepEqual(parseGoalScript("play it"), [{ kind: "play" }]);
});

test("intent: 'play' is a browser verb and a follow-up action, so 'Play the song please' reaches the agent instead of falling to plain chat (it used to get 'I don't have the capability to play songs')", () => {
  const intent = require("../../agent/intent.cjs");
  assert.equal(intent.looksLikeBrowserTask("Play the song please"), true);
  assert.equal(intent.looksLikeBrowserTask("play it"), true);
  assert.equal(intent.isFollowUp("Play the song please"), true, "a short follow-up right after a search/browse task");
});

test("GoalScripts: a standalone {kind:'play'} that starts on a results page (nothing picked yet) opens the best real result itself, instead of only waiting for a video that never opens", () => {
  const gs = new GoalScripts();
  const results = [
    link("v1", "Some Unrelated Cover Song 900,000 views", "/watch?v=other", 200),
    link("v2", "NEFFEX - Cold [NCS Release] 61,000,000 views", "/watch?v=ncs", 400),
  ];
  const obs = { url: "https://www.youtube.com/results?search_query=Cold+by+NCS", title: "Cold by NCS - YouTube", elements: results, viewport: { height: 900 } };
  const step1 = gs.next({ taskId: "playnow", goal: "Play the song please", obs, els: results, recent: [] });
  assert.equal(step1.actions[0].action, "click");
  assert.equal(step1.actions[0].target.ref, "v2", "the most-watched real result, the way a person would");
  // once the click "opens" the video, the play step continues normally and finishes
  const watchObs = { url: "https://www.youtube.com/watch?v=ncs", title: "NEFFEX - Cold [NCS Release]", elements: [{ ref: "p1", role: "button", name: "Pause (k)", rect: { x: 1, y: 1, width: 1, height: 1 } }], viewport: { height: 900 } };
  const step2 = gs.next({ taskId: "playnow", goal: "Play the song please", obs: watchObs, els: watchObs.elements, recent: [{ text: "click v2 -> ok", ok: true }] });
  assert.equal(step2.status, "done");
  assert.match(step2.result, /opened "NEFFEX/);
});

// ---- TEST 8 shape: ambiguous results (item 5) - an artist qualifier must actually steer the pick -------------------

const link = (ref, name, href, y) => ({ ref, role: "link", name, href, rect: { x: 300, y, width: 300, height: 20 } });
const MIXED_RESULTS = [
  link("v1", "Maroon 5 - Cold (Lyrics) ft Future 61,000,000 views 9 years ago", "/watch?v=maroon", 200),
  link("v2", "Cold - NCS Release 1,200,000 views 3 years ago", "/watch?v=ncs", 400),
];

test("chooseResult prefers the named artist/channel over a merely more-viewed unrelated result (the reported 'Maroon 5' mismatch)", () => {
  const best = chooseResult(MIXED_RESULTS, "best", 900);
  assert.equal(best.ref, "v1", "without an artist hint, view count alone still wins (unchanged behaviour)");
  const withArtist = chooseResult(MIXED_RESULTS, "best", 900, { artist: "NCS" });
  assert.equal(withArtist.ref, "v2", "the NCS release is preferred even though it has fewer views");
  assert.equal(withArtist.artistMatched, true);
});

test("TEST 8: no matching artist result -> chooseResult still returns something usable but marks it unmatched, and the script says so honestly instead of a false success", () => {
  const noNcs = [link("v1", "Maroon 5 - Cold (Lyrics) 61,000,000 views", "/watch?v=maroon", 200)];
  const r = chooseResult(noNcs, "best", 900, { artist: "NCS" });
  assert.equal(r.ref, "v1");
  assert.equal(r.artistMatched, false, "honestly marked as not a real match, not silently accepted as one");

  const gs = new GoalScripts();
  const recent = [];
  const box = { ref: "e9", role: "combobox", name: "Search", rect: { x: 400, y: 20, width: 300, height: 30 } };
  let last;
  for (let i = 0; i < 20; i++) {
    const searched = recent.some((r2) => r2.text.startsWith("type"));
    const obs = searched
      ? { url: "https://www.youtube.com/results?search_query=x", title: "results", elements: noNcs, viewport: { height: 900 } }
      : { url: "https://www.youtube.com/", title: "YouTube", elements: [box], viewport: { height: 900 } };
    last = gs.next({ taskId: "noartist", goal: MSG3, obs, els: obs.elements, recent });
    if (!last || last.status === "done") break;
    const a = last.actions[0];
    recent.push({ text: `${a.action} ${a.target ? a.target.ref : ""} "${a.text || ""}" -> ok`, ok: true });
  }
  // never actually reaches "done" here (no play button in this fixture / not on a watch page), but the pick step must
  // have recorded the honest caveat as soon as it opened the non-matching result
  assert.equal(gs._s.get("noartist").artistUnmatched, "NCS");
});

// ---- the completion guard: ACTION SUCCESS != TASK SUCCESS ---------------------------------------------------------

test("looksLikeRefusalOrChat recognises the exact text that closed out a real task as 'done' with nothing done", () => {
  assert.equal(looksLikeRefusalOrChat("I'm sorry, but I don't have any attached content or a previous conversation to refer to. How can I assist you now?"), true);
  assert.equal(looksLikeRefusalOrChat("As an AI, I do not have access to real-time video playback."), true);
  assert.equal(looksLikeRefusalOrChat("Reached the requested page."), false);
  assert.equal(looksLikeRefusalOrChat("Searched for Cold NCS and opened the top result."), false);
});

test("verifyCompletion: a claim backed by nothing (no action ever ran) is not trusted, even with an innocuous reason", () => {
  assert.equal(verifyCompletion({ reason: "Done", tookAction: false, everActedThisTask: false }).trusted, false);
  assert.equal(verifyCompletion({ reason: "I'm sorry, I don't have any attached content.", tookAction: false, everActedThisTask: true }).trusted, false, "a refusal is never trusted, whatever else happened");
  assert.equal(verifyCompletion({ reason: "Reached the requested page.", tookAction: false, everActedThisTask: true }).trusted, true, "a real prior action backs a plausible-sounding completion");
  assert.equal(verifyCompletion({ reason: "Clicked the link.", tookAction: true, everActedThisTask: false }).trusted, true, "an action in this very step is also evidence");
});

// ---- a second, independently-found instance of the same "false completion" bug: a relative-clause "which" was read as a
// question, routing msg1 into the answer-from-page path, whose OWN older/narrower refusal check let a differently-worded
// chat refusal slip through as a reported "answer" -----------------------------------------------------------------

test("'...youtube WHICH can give us chill...' is a relative clause, not a question: goalNeedsAnswer must not fire on it", () => {
  assert.equal(goalNeedsAnswer(MSG1), false);
  // real which-questions still work
  assert.equal(goalNeedsAnswer("tell me which one is cheaper"), true);
  assert.equal(goalNeedsAnswer("which is the best laptop here"), true);
  assert.equal(goalNeedsAnswer("Which video do you want me to play?"), true);
});

test("the answer-from-page path uses the SAME refusal detector as the main completion guard (a chat-style refusal is never reported as a completed page-read)", async () => {
  const refusalText = "I'm sorry, but I don't have a \"page\" attached to this message. I don't have any specific web page open in my browser.";
  const f = fakeFetch((body) => (body.mode === "chat" ? { answer: refusalText } : { complete: false, actions: [{ type: "navigate", url: "https://example.com/results?q=x" }] }));
  const p = new RexyLegacyProvider({ name: "rexy", baseURL: "https://legacy.example/predict", getKey: () => null, fetch: f, options: { keyless: true } });
  const els = [];
  const obs = { url: "https://example.com/results?q=x", title: "Results", elements: els, tabs: [], pageText: { viewport: "some results" } };
  // Force the "answer from page" branch: a question-shaped goal, already on the target page, with prior successful actions.
  const recent = [{ text: "navigate https://example.com/ -> ok", ok: true }, { text: "navigate https://example.com/results?q=x -> ok", ok: true }, { text: "navigate https://example.com/results?q=x -> ok", ok: true }];
  const res = await p.complete({ system: "s", messages: [], tools: [], toolChoice: "noah_step", meta: { goal: "tell me which one is cheaper", observation: obs, taskId: "refusal2", recentActions: recent } });
  assert.notEqual(res.toolCalls[0].args.status, "done", "a chat refusal must never become a reported answer");
});

// ---- the reported bug, end to end through the adapter --------------------------------------------------------------

const fakeFetch = (handler) => async (_url, opts) => {
  const r = await handler(JSON.parse(opts.body));
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => (typeof r === "string" ? r : JSON.stringify(r)) };
};

test("repro: a first step with zero prior actions that self-reports 'complete' with a chat refusal is NOT reported as done", async () => {
  const f = fakeFetch(() => ({ complete: true, reason: "I'm sorry, but I don't have any attached content or a previous conversation to refer to. How can I assist you now?", actions: [] }));
  const p = new RexyLegacyProvider({ name: "rexy", baseURL: "https://legacy.example/predict", getKey: () => null, fetch: f, options: { keyless: true } });
  const obs = { url: "https://www.youtube.com/", title: "YouTube", elements: [], tabs: [], pageText: { viewport: "" } };
  const res = await p.complete({ system: "s", messages: [], tools: [], toolChoice: "noah_step", meta: { goal: "look around for something interesting", observation: obs, taskId: "repro1", recentActions: [] } });
  const args = res.toolCalls[0].args;
  assert.notEqual(args.status, "done", "a refusal must never be reported as a completed task");
  assert.ok(!/attached content|previous conversation/i.test(args.result || ""), "the refusal text is not repeated to the user as an answer");
});

test("a repeated-search-typing loop finishes with a MEANINGFUL result (what was typed, where it landed), not the generic notepad-only 'Typed the text once.'", async () => {
  const f = fakeFetch(() => ({ complete: false, actions: [{ type: "type", selector: '[data-noah-ref="e1"]', text: "Cold by NCS" }] }));
  const p = new RexyLegacyProvider({ name: "rexy", baseURL: "https://legacy.example/predict", getKey: () => null, fetch: f, options: { keyless: true } });
  const els = [{ ref: "e1", role: "textbox", name: "Search", rect: { x: 0, y: 0, width: 300, height: 30 } }];
  const obs = { url: "https://www.youtube.com/results?search_query=Cold+by+NCS", title: "Cold by NCS - YouTube", elements: els, tabs: [], pageText: { viewport: "Cold by NCS search results" } };
  const recent = [{ text: 'type e1 "Cold by NCS" -> ok [text_changed] via ax', ok: true }];
  // a goal shape that is neither a Composer writing task nor a GoalScripts-recognised search/pick/play script, so this
  // exercises the RAW model path where the repeated-type guard actually lives
  const res = await p.complete({ system: "s", messages: [], tools: [], toolChoice: "noah_step", meta: { goal: "please look up Cold by NCS for me", observation: obs, taskId: "loopfix", recentActions: recent } });
  const args = res.toolCalls[0].args;
  assert.equal(args.status, "done");
  assert.notEqual(args.result, "Typed the text once.", "the generic notepad-only wording must not leak into a search/browse outcome");
  assert.match(args.result, /Cold by NCS/, "says what was typed");
  assert.match(args.result, /YouTube/, "says where it landed");
});

test("repro: 'complete: true' backed by a real prior action IS trusted (the fix does not make Noah refuse genuine completions)", async () => {
  const f = fakeFetch(() => ({ complete: true, reason: "Reached the requested page.", actions: [] }));
  const p = new RexyLegacyProvider({ name: "rexy", baseURL: "https://legacy.example/predict", getKey: () => null, fetch: f, options: { keyless: true } });
  const obs = { url: "https://example.com/", title: "Example", elements: [], tabs: [], pageText: { viewport: "" } };
  const res = await p.complete({ system: "s", messages: [], tools: [], toolChoice: "noah_step", meta: { goal: "open example.com", observation: obs, taskId: "repro2", recentActions: [{ text: "navigate https://example.com/ -> ok", ok: true }] } });
  assert.equal(res.toolCalls[0].args.status, "done");
  assert.equal(res.toolCalls[0].args.result, "Reached the requested page.");
});
