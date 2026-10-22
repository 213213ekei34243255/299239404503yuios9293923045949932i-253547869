// Noah/test/unit/web-mode-and-page-chat.test.cjs
//
// Two things a real user hit:
//  1. In Web agent mode, "turn on the radio on the screen play it. click once" was refused ("That sounds like a job on an app on your computer ...") because "on the
//     screen" + "click" + "play" matched the desktop rules. A user who PICKED the Web agent said "this is about the browser": only an explicit computer reference
//     may send the task elsewhere.
//  2. Chat could not summarize the page the user had open: it was never given the page. "summarize this page" / "what is this about" now read the open tab and
//     answer from it (and in Auto mode they no longer start a slow agent run).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { looksLikeDesktopTask, looksLikePageQuestion, looksLikeBrowserTask } = require("../../agent/intent.cjs");
const { CommandRouter } = require("../../agent/command-router.cjs");
const { AgentSession } = require("../../agent/session.cjs");
const { EventBus } = require("../../events.cjs");
const { classifyGoal } = require("../../../entitlement-gate.cjs");

const RADIO = "turn on the radio on the screen play it. click once";

function routerWith() {
  const calls = [];
  const missions = { isAvailable: () => true, isDesktopAvailable: () => true, isRunning: () => false, awaitingAnswer: () => false, canResume: () => false, hasResumable: () => false, start: (g, o) => { calls.push(["start", g, o]); return { ok: true, id: "m1" }; }, answer: () => ({ ok: false }), stop() {}, pause() {}, resume: () => ({ ok: true }) };
  const agent = { submit: (...a) => { calls.push(["agent", a[0]]); return "a1"; }, stop() {}, pause() {}, resume: () => ({ ok: true }) };
  return { router: new CommandRouter({ session: new AgentSession({ bus: new EventBus() }), agent, missions }), calls };
}

test("the user's exact radio request is a browser job in Web mode, and still a computer job when the user left the choice to Auto", () => {
  assert.equal(looksLikeDesktopTask(RADIO, { webChosen: true }), false);
  assert.equal(looksLikeDesktopTask(RADIO), true, "Auto mode keeps its old behaviour (existing tests pin it)");
  const { router, calls } = routerWith();
  const r = router.route(RADIO, { mode: "web" });
  assert.equal(r.kind, "agent", JSON.stringify(r));
  assert.deepEqual(calls[0], ["agent", RADIO]);
});

test("Web mode still hands real computer jobs to the computer agent (explicit app or computer words)", () => {
  for (const g of ["open notepad and write a shopping list", "on my computer open file explorer", "open the calculator", "on my windows laptop close the taskbar", "open spotify and play something"]) {
    assert.equal(looksLikeDesktopTask(g, { webChosen: true }), true, g);
    const { router } = routerWith();
    const r = router.route(g, { mode: "web" });
    assert.equal(r.kind, "control", g); assert.equal(r.control, "mode", g);
  }
});

test("things you do on a web page stay browser jobs in Web mode, whatever the wording", () => {
  for (const g of ["click the play button on the screen", "press play on the radio on this page", "on the screen click the search box and type shoes", "scroll down the screen and open the news", "turn up the volume of the radio on the screen", "play the radio on the screen"]) {
    assert.equal(looksLikeDesktopTask(g, { webChosen: true }), false, g);
    const { router } = routerWith();
    assert.equal(router.route(g, { mode: "web" }).kind, "agent", g);
  }
});

test("page questions: summarize / explain / what is this about, about the OPEN page", () => {
  for (const g of ["summarize this page", "Summarise", "tl;dr", "give me a summary", "what is this page about?", "explain this article", "can you summarize it in 3 bullet points", "key points please", "what does this site say?", "translate this page to hindi", "summarize this page in 5 bullets", "please summarize in simple words", "recap this article", "what's on this page?", "summarize the article I'm reading"]) assert.equal(looksLikePageQuestion(g), true, g);
});

test("...and NOT things that only sound similar: other topics, other addresses, searches, actions", () => {
  for (const g of ["summarize the history of rome", "summary of the french revolution", "what is photosynthesis?", "click on this page", "summarize https://example.com/a", "search for a summary of this", "open this page in a new tab", "buy this product", "write a summary of my day", "play this video", "explain this", "hello", "", "what is a page table in an operating system?"]) assert.equal(looksLikePageQuestion(g), false, g);
});

test("Auto and Chat answer a page question with CHAT; Web and Computer mode (the user's explicit choice) are left alone", () => {
  for (const mode of ["auto", "chat", undefined]) {
    const { router, calls } = routerWith();
    assert.equal(router.route("summarize this page", { mode }).kind, "chat", String(mode));
    assert.equal(calls.length, 0, "no agent run was started");
  }
  const web = routerWith(); assert.equal(web.router.route("summarize this page", { mode: "web" }).kind, "agent");
  assert.equal(looksLikeBrowserTask("summarize this page"), true, "it IS still page work for anything that asks");
  const computer = routerWith(); assert.equal(computer.router.route("summarize this page", { mode: "computer" }).kind, "mission");
  const act = routerWith(); assert.equal(act.router.route("click on this page and type hello", { mode: "auto" }).kind, "agent", "an action on the page is still the agent's");
});

test("billing: a page question in Auto is a CHAT use (as the router handles it), explicit modes are unchanged", () => {
  assert.equal(classifyGoal("summarize this page", "auto"), "chat");
  assert.equal(classifyGoal("summarize this page", "chat"), "chat");
  assert.equal(classifyGoal("summarize this page", "web"), "agent");
  assert.equal(classifyGoal("summarize this page", "computer"), "agent");
  assert.equal(classifyGoal("click on this page and type hello", "auto"), "agent");
});

// ------------------------------------------------------------------ the chat reply gets the page

const RUNTIME_PATH = require.resolve("../../../Rexy/runtime.cjs");
function fakeRuntime({ page, bridgeFails = false } = {}) {
  const sent = [];
  const reads = [];
  const bridge = {
    getPageText: async () => { reads.push("text"); if (bridgeFails) throw new Error("no page"); return page.text; },
    getTitle: () => page.title, getCurrentURL: () => page.url,
  };
  const self = { bridge, log: { warn() {}, info() {} }, memory: { export: () => ({ sessionId: "t" }) }, llm: { chat: async (o) => { sent.push(o); return "THE SUMMARY"; } } };
  self._readActivePage = require(RUNTIME_PATH).prototype._readActivePage;
  return { self, sent, reads, chat: (goal, opts) => require(RUNTIME_PATH).prototype._chatReply.call(self, goal, opts) };
}
const ARTICLE = "The Zorblax Expedition reached the northern ridge on Tuesday. Leader Mara Quill said the team found three new glacier lakes and mapped 40 km of unexplored valley. " .repeat(3);

test("'summarize this page' sends the open page's text as page_content, tells the model what it is, and never searches the web", async () => {
  const f = fakeRuntime({ page: { text: ARTICLE, title: "Zorblax Expedition News", url: "https://news.example/zorblax" } });
  const reply = await f.chat("summarize this page");
  assert.equal(reply, "THE SUMMARY");
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].pageContent, /^Page title: Zorblax Expedition News\nPage address: https:\/\/news\.example\/zorblax\n\nThe Zorblax Expedition/);
  assert.match(f.sent[0].message, /^summarize this page/); assert.match(f.sent[0].message, /ONLY the open web page attached as page content/);
});

test("a long page is cut at 18,000 characters and the model is told it only has the first part", async () => {
  const f = fakeRuntime({ page: { text: "word ".repeat(9000), title: "Long", url: "https://x.example/long" } });
  await f.chat("tl;dr");
  assert.ok(f.sent[0].pageContent.length < 18300 && /\[the rest of the page was cut\]/.test(f.sent[0].pageContent));
  assert.match(f.sent[0].message, /only its first part is attached/);
});

test("a page with no readable text, or no page at all, gets an honest answer and the model is NOT asked", async () => {
  const empty = fakeRuntime({ page: { text: "  ", title: "Video", url: "https://v.example/watch" } });
  assert.match(await empty.chat("summarize this page"), /could not find readable text on this page \("Video"\)/);
  assert.equal(empty.sent.length, 0);
  const none = fakeRuntime({ page: { text: "", title: "", url: "" }, bridgeFails: true });
  assert.match(await none.chat("what is this page about?"), /could not read the page in front of you/);
  assert.equal(none.sent.length, 0);
});

test("a message that is NOT about the page does not read it (no needless page reads, nothing attached)", async () => {
  const f = fakeRuntime({ page: { text: ARTICLE, title: "T", url: "https://x.example" } });
  await f.chat("what is photosynthesis?");
  assert.deepEqual(f.reads, []); assert.equal(f.sent[0].pageContent, undefined); assert.equal(f.sent[0].message, "what is photosynthesis?");
});

test("attached files win over the open page: the page is not read when files were attached", async () => {
  const f = fakeRuntime({ page: { text: ARTICLE, title: "T", url: "https://x.example" } });
  await f.chat("summarize this page", { attachments: { text: "FILE TEXT", files: [] } });
  assert.deepEqual(f.reads, []); assert.equal(f.sent[0].pageContent, "FILE TEXT");
});
