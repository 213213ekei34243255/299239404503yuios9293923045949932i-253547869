"use strict";
// Goal script: "do it like a person" plans for browsing goals (see Noah/models/goal-script.cjs).
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseGoalScript, chooseResult, parseCount, GoalScripts } = require("../../models/goal-script.cjs");

const USER_GOAL = "Noah, open youtube.com and search for lo-fi music and scroll down search for the best one and play the song";

test("the user's YouTube goal becomes: search, scroll, pick the best, play (the 'search for the best one' is a PICK, not a query)", () => {
  assert.deepEqual(parseGoalScript(USER_GOAL), [
    { kind: "search", query: "lo-fi music" },
    { kind: "scroll", dir: "down", times: 2 },
    { kind: "pick", which: "best" },
    { kind: "play" },
  ]);
});

test("other goal shapes", () => {
  assert.deepEqual(parseGoalScript("open https://en.wikipedia.org and search for Alan Turing"), [{ kind: "search", query: "Alan Turing" }]);
  assert.deepEqual(parseGoalScript("search for pants over here"), [{ kind: "search", query: "pants" }]);
  assert.deepEqual(parseGoalScript("open youtube.com and play lo-fi music"), [{ kind: "search", query: "lo-fi music" }, { kind: "pick", which: "first" }, { kind: "play" }]);
  assert.deepEqual(parseGoalScript("search for headphones, scroll through the results, then open the first result"), [{ kind: "search", query: "headphones" }, { kind: "scroll", dir: "down", times: 3 }, { kind: "pick", which: "first" }]);
  assert.deepEqual(parseGoalScript("open youtube.com and look around"), []);
  assert.deepEqual(parseGoalScript("what is the weather"), []);
});

test("parseCount understands the ways sites write view counts", () => {
  assert.equal(parseCount("Lofi Girl by Lofi Girl 63,463,182 views 4 years ago"), 63463182);
  assert.equal(parseCount("chill beats 1.2M views"), 1.2e6);
  assert.equal(parseCount("chill beats 3.4 million views"), 3.4e6);
  assert.equal(parseCount("live radio 12K watching"), 12000);
  assert.equal(parseCount("no count here"), -1);
});

const link = (ref, name, href, y) => ({ ref, role: "link", name, href, rect: { x: 300, y, width: 300, height: 20 } });
const RESULTS = [
  link("e1", "Home", "/", 20),
  link("e2", "lofi hip hop radio beats to relax study to by Lofi Girl 1.2M watching", "/watch?v=aaa", 200),
  link("e3", "lofi hip hop radio beats to relax study to by Lofi Girl 1.2M watching", "/watch?v=aaa", 205), // thumbnail duplicate
  link("e4", "chill lofi mix by Some Channel 63,463,182 views 4 years ago", "/watch?v=bbb", 400),
  link("e5", "short clip by X 900,000,000 views", "/shorts/ccc", 600),
  link("e6", "Sponsored lofi speakers buy now cheap", "/ads/x", 650),
  link("e7", "small lofi upload by Tiny 1,200 views 1 year ago", "/watch?v=ddd", 800),
];

test("chooseResult: 'best' = most viewed real video (no shorts, ads or duplicates); 'first' = topmost; nothing below the fold", () => {
  assert.equal(chooseResult(RESULTS, "best", 900).ref, "e4");
  assert.equal(chooseResult(RESULTS, "first", 900).ref, "e2");
  assert.equal(chooseResult(RESULTS, "best", 300).ref, "e2", "only what is on screen can be chosen");
  assert.equal(chooseResult([link("e1", "Home", "/", 20)], "best", 900), null);
  const noCounts = [link("a", "first article about lofi music", "/wiki/A", 200), link("b", "second article about lofi", "/wiki/B", 300)];
  assert.equal(chooseResult(noCounts, "best", 900).ref, "a", "no counts: fall back to the first");
});

/** Walk the engine the way the agent does: each call sees the actions that ran before it. */
function walk(goal, pages, needsAnswer = false) {
  const gs = new GoalScripts();
  const recent = [];
  const out = [];
  for (let i = 0; i < 20; i++) {
    const obs = pages(recent);
    const r = gs.next({ taskId: "t", goal, obs, els: obs.elements, recent, needsAnswer });
    out.push(r);
    if (!r || r.status === "done") break;
    const a = r.actions[0];
    recent.push({ text: `${a.action} ${a.target ? a.target.ref : ""} -> ok`, ok: true });
  }
  return out;
}

test("full walk on a YouTube-like site: type into the box, scroll twice, click the most-viewed video, play", () => {
  const box = { ref: "e9", role: "combobox", name: "Search", rect: { x: 400, y: 20, width: 300, height: 30 } };
  const playBtn = { ref: "e30", role: "button", name: "Play (k)", rect: { x: 40, y: 500, width: 30, height: 30 } };
  const pages = (recent) => {
    const clicked = recent.some((r) => r.text.startsWith("click"));
    if (clicked) return { url: "https://www.youtube.com/watch?v=bbb", title: "chill lofi mix - YouTube", elements: [playBtn], viewport: { height: 900 } };
    const searched = recent.some((r) => r.text.startsWith("type"));
    return searched ? { url: "https://www.youtube.com/results?search_query=lo-fi+music", title: "lo-fi music - YouTube", elements: RESULTS, viewport: { height: 900 } } : { url: "https://www.youtube.com/", title: "YouTube", elements: [box], viewport: { height: 900 } };
  };
  const steps = walk(USER_GOAL, pages);
  const shape = steps.map((s) => (s.status === "done" ? "done" : s.actions[0].action + (s.actions[0].direction ? ":" + s.actions[0].direction : "")));
  assert.deepEqual(shape, ["type", "scroll:down", "scroll:down", "click", "click", "done"]);
  assert.deepEqual(steps[0].actions[0], { action: "type", target: { ref: "e9" }, text: "lo-fi music", clear: true, submit: true });
  assert.deepEqual(steps[3].actions[0], { action: "click", target: { ref: "e4" } }, "clicked the most-viewed result");
  assert.deepEqual(steps[4].actions[0], { action: "click", target: { ref: "e30" } }, "pressed play");
  assert.match(steps[5].result, /searched for "lo-fi music".*scrolled down.*opened "chill lofi mix/);
  assert.ok(steps.every((s) => !s.actions || s.actions[0].action !== "navigate"), "never jumps to a URL");
});

test("if the video is already playing (no play button) it finishes instead of toggling it", () => {
  const box = { ref: "e9", role: "searchbox", name: "Search", rect: { x: 0, y: 0, width: 1, height: 1 } };
  const pages = (recent) => {
    if (recent.some((r) => r.text.startsWith("click"))) return { url: "https://www.youtube.com/watch?v=bbb", title: "mix", elements: [{ ref: "e31", role: "button", name: "Pause (k)", rect: { x: 1, y: 1, width: 1, height: 1 } }], viewport: { height: 900 } };
    return recent.some((r) => r.text.startsWith("type")) ? { url: "https://www.youtube.com/results?search_query=x", title: "r", elements: RESULTS, viewport: { height: 900 } } : { url: "https://www.youtube.com/", title: "YouTube", elements: [box], viewport: { height: 900 } };
  };
  const steps = walk("search for lo-fi, open the first result and play it", pages);
  assert.equal(steps[steps.length - 1].status, "done");
  assert.ok(!steps.some((s) => s.actions && s.actions[0].target && s.actions[0].target.ref === "e31"));
});

test("a failing step is fixed and retried (settle, or reveal an off-screen box), then handed back to the model instead of looping; Jonah's own pages are left alone", () => {
  const box = { ref: "e1", role: "searchbox", name: "Search", rect: { x: 0, y: 0, width: 1, height: 1 } };
  const obs = { url: "https://x.test/", title: "x", elements: [box], viewport: { height: 900 } };
  const gs = new GoalScripts();
  const recent = [];
  const call = () => gs.next({ taskId: "f", goal: "search for cats", obs, els: obs.elements, recent });
  const fail = (text) => recent.push({ text, ok: false });
  assert.equal(call().actions[0].action, "type");
  const seen = [];
  for (let i = 0; i < 4; i++) {
    fail('type e1 "cats" -> FAILED unknown_ref');
    const settle = call();
    assert.equal(settle.actions[0].action, "wait", "a person lets the page settle before trying again");
    recent.push({ text: "wait 1200 -> ok", ok: true });
    seen.push(call().actions[0].action);
  }
  assert.deepEqual(seen, ["type", "type", "type", "type"]);
  fail('type e1 "cats" -> FAILED unknown_ref');
  assert.equal(call(), null, "gave up after several tries: the model takes over");
  assert.equal(new GoalScripts().next({ taskId: "h", goal: "search for cats", obs: { url: "file:///C:/Jonah2/home.html", elements: [] }, els: [], recent: [] }), null);
});

test("an off-screen search box (narrow window: YouTube shows only a magnifier) is opened with the icon, then typed into", () => {
  const box = { ref: "e28", role: "combobox", name: "Search", rect: { x: -500, y: 10, width: 300, height: 30 } };
  const icon = { ref: "e5", role: "button", name: "Search", rect: { x: 700, y: 10, width: 30, height: 30 } };
  const voice = { ref: "e6", role: "button", name: "Search with your voice", rect: { x: 740, y: 10, width: 30, height: 30 } };
  const obs = { url: "https://www.youtube.com/", title: "YouTube", elements: [box, voice, icon], viewport: { height: 900 } };
  const gs = new GoalScripts();
  const recent = [];
  const call = () => gs.next({ taskId: "o", goal: "search for lo-fi music", obs, els: obs.elements, recent });
  assert.equal(call().actions[0].action, "type");
  recent.push({ text: 'type e28 "lo-fi music" -> FAILED offscreen', ok: false });
  const reveal = call();
  assert.deepEqual(reveal.actions[0], { action: "click", target: { ref: "e5" } }, "the magnifier, not the voice-search button");
  recent.push({ text: "click e5 -> ok", ok: true });
  assert.equal(call().actions[0].action, "type", "then typing again");
});

test("a goal that also asks a question hands back to the model once the visible steps are done", () => {
  const box = { ref: "e1", role: "searchbox", name: "Search", rect: { x: 0, y: 0, width: 1, height: 1 } };
  const pages = (recent) => ({ url: "https://shop.test/" + (recent.length ? "search?q=laptops" : ""), title: "Shop", elements: [box], viewport: { height: 900 } });
  const steps = walk("search for laptops and tell me the cheapest one", pages, true);
  assert.equal(steps[0].actions[0].action, "type");
  assert.equal(steps[steps.length - 1], null, "the answer step is the model's");
});

const { humanNavigationBlock } = require("../../agent/human-nav.cjs");
test("human navigation guard: no URL jumps inside a site, but opening sites, goal URLs, real links and 'I am here' are fine", () => {
  const here = "https://www.youtube.com/results?search_query=lo-fi";
  const els = [{ role: "link", href: "https://www.youtube.com/watch?v=real1", name: "a real video link" }];
  const blocked = (url, goal = "open youtube.com and search for lo-fi") => humanNavigationBlock({ url, goal, currentUrl: here, elements: els });
  assert.match(blocked("https://www.youtube.com/watch?v=CFGLoQIhmow"), /Do not jump to a URL inside youtube\.com/);
  assert.match(blocked("https://youtube.com/results?search_query=lo-fi+music"), /search box/);
  assert.equal(blocked("https://www.youtube.com/"), null, "a site's home page");
  assert.equal(blocked("https://www.wikipedia.org/wiki/Lo-fi"), null, "another site: that is how you open one");
  assert.equal(blocked("https://www.youtube.com/watch?v=real1"), null, "it is a real link on the page");
  assert.equal(blocked(here), null, "already here");
  assert.equal(blocked("https://www.youtube.com/feed/trending", "go to https://www.youtube.com/feed/trending"), null, "the user gave this URL");
  assert.equal(humanNavigationBlock({ url: "https://www.youtube.com/watch?v=x", goal: "g", currentUrl: "file:///C:/Jonah2/home.html", elements: [] }), null, "from Jonah's own page");
});

test("ads are never picked; if a click opens nothing playable it tries the next-best result instead of claiming success", () => {
  const box = { ref: "e9", role: "combobox", name: "Search", rect: { x: 400, y: 20, width: 300, height: 30 } };
  const ad = link("ad1", "Godrej Row Villas Whitefield", "https://www.googleadservices.com/pagead/aclk?x=1", 150);
  const adNoHref = link("ad2", "Sponsored Row Villas book now", "", 170);
  const results = [ad, adNoHref, link("v1", "top lofi video by A 5M views", "/watch?v=one", 300), link("v2", "second lofi video by B 4M views", "/watch?v=two", 500)];
  assert.equal(chooseResult(results, "best", 900, { requireContent: true }).ref, "v1", "the ad is skipped");
  assert.equal(chooseResult(results, "best", 900, { exclude: new Set(["/watch?v=one"]), requireContent: true }).ref, "v2");
  assert.equal(chooseResult([ad, link("x1", "some other long link text here", "/about", 300)], "best", 900, { requireContent: true }), null, "no content links yet: keep waiting rather than take any link");

  const gs = new GoalScripts();
  const recent = [];
  let clicks = 0;
  const seen = [];
  for (let i = 0; i < 25; i++) {
    const searched = recent.some((r) => r.text.startsWith("type"));
    const onVideo = clicks >= 2; // the first click "opens" nothing (stays on the results page); the second opens a video
    const obs = onVideo
      ? { url: "https://www.youtube.com/watch?v=two", title: "second lofi video", elements: [{ ref: "p1", role: "button", name: "Pause (k)", rect: { x: 1, y: 1, width: 1, height: 1 } }], viewport: { height: 900 } }
      : searched
      ? { url: "https://www.youtube.com/results?search_query=x", title: "results", elements: results, viewport: { height: 900 } }
      : { url: "https://www.youtube.com/", title: "YouTube", elements: [box], viewport: { height: 900 } };
    const r = gs.next({ taskId: "ad", goal: "search for lo-fi music, open the best one and play it", obs, els: obs.elements, recent });
    seen.push(r);
    if (!r || r.status === "done") break;
    const a = r.actions[0];
    if (a.action === "click") clicks++;
    recent.push({ text: `${a.action} ${a.target ? a.target.ref : ""} -> ok`, ok: true });
  }
  const clicked = seen.filter((s) => s && s.actions && s.actions[0].action === "click").map((s) => s.actions[0].target.ref);
  assert.deepEqual(clicked, ["v1", "v2"], "first the best, then - after it opened nothing - the next best");
  const last = seen[seen.length - 1];
  assert.equal(last.status, "done");
  assert.match(last.result, /opened "second lofi video by B/);
  assert.doesNotMatch(last.result, /top lofi video/, "the failed pick is not reported");
});

test("if nothing ever opens, the script gives the task back to the model instead of claiming it played", () => {
  const box = { ref: "e9", role: "combobox", name: "Search", rect: { x: 400, y: 20, width: 300, height: 30 } };
  const results = [link("v1", "only lofi video by A 5M views", "/watch?v=one", 300)];
  const gs = new GoalScripts();
  const recent = [];
  let last;
  for (let i = 0; i < 30; i++) {
    const searched = recent.some((r) => r.text.startsWith("type"));
    const obs = searched ? { url: "https://www.youtube.com/results?search_query=x", title: "results", elements: results, viewport: { height: 900 } } : { url: "https://www.youtube.com/", title: "YouTube", elements: [box], viewport: { height: 900 } };
    last = gs.next({ taskId: "never", goal: "search for lo-fi music, open the first result and play it", obs, els: obs.elements, recent });
    if (!last || last.status === "done") break;
    const a = last.actions[0];
    recent.push({ text: `${a.action} ${a.target ? a.target.ref : ""} -> ok`, ok: true });
  }
  assert.equal(last, null, "handed back, not 'done'");
});

const { needsHuman, decideAsk } = require("../../agent/ask-policy.cjs");
test("ask policy: only sign-in / password / CAPTCHA / payment questions reach the person; everything else Noah decides itself; the same question is never asked twice", () => {
  for (const q of ["Please sign in to your account, then press Resume", "Enter the verification code we sent you", "Solve the CAPTCHA", "Should I place the order with your card?"]) assert.equal(needsHuman(q), true, q);
  for (const q of ["I keep repeating the same step without making progress. How would you like me to continue?", "The last 4 attempts failed. Should I keep trying, try something else, or stop?", "Which video do you want me to play?", "Do you want the cheapest or the best rated?"]) assert.equal(needsHuman(q), false, q);
  assert.equal(decideAsk({ question: "Which video?" }).ask, false);
  const asked = new Set();
  assert.equal(decideAsk({ question: "Please sign in", asked }).ask, true);
  asked.add("please sign in");
  assert.equal(decideAsk({ question: "Please sign in", asked }).ask, false, "already asked and handled");
  assert.equal(decideAsk({ question: "Which video?", autoDecide: false }).ask, true, "opt-out keeps the old behaviour");
  assert.equal(needsHuman("I need your help", { security: { hasPassword: true } }), true, "a login form is on screen");
});

test("with no link URLs (YouTube's AX tree has none) a video is recognised by its name; channel/nav links are not results", () => {
  const nohref = (ref, name, y) => ({ ref, role: "link", name, rect: { x: 300, y, width: 300, height: 20 } });
  const els = [
    nohref("c1", "Go to channel The Japanese Town", 120),
    nohref("h1", "YouTube Home Home Home Home", 130),
    nohref("v1", "Lofi for study by Chill 3 hours, 25 minutes", 300),
    nohref("v2", "Lofi radio by Girl 1.2M views 2 years ago 5 hours", 500),
  ];
  assert.equal(chooseResult(els, "best", 900, { requireContent: true }).ref, "v2", "the counted, most-viewed video");
  assert.equal(chooseResult(els, "first", 900, { requireContent: true }).ref, "v1");
  assert.equal(chooseResult([els[0], els[1]], "best", 900, { requireContent: true }), null, "a channel link is not a result");
});

const { composeIntentFrom, pickEditor, cleanGenerated, Composer } = require("../../models/compose.cjs");
const { RexyLegacyProvider } = require("../../models/rexy-legacy.cjs");

const JURASSIC = "Noah do me a favor and type of whole context about the Jurassic word on this page note pad okay just start typing you can write a story about the Jurassic word on this note pad you see on the page can you start writing";

test("compose: a 'write a story on the notepad' goal is recognised; searches and short literal typing are not", () => {
  assert.ok(composeIntentFrom(JURASSIC));
  assert.ok(composeIntentFrom("write a poem about the sea in the editor"));
  assert.equal(composeIntentFrom("open youtube.com and search for lo-fi music"), null);
  assert.equal(composeIntentFrom("type hello into the box"), null);
  assert.equal(composeIntentFrom("search for a story about dinosaurs"), null);
});

test("compose: the editor is the big text area, never a search box; generated text is cleaned", () => {
  const els = [
    { ref: "s1", role: "searchbox", name: "Search", rect: { x: 0, y: 0, width: 600, height: 200 } },
    { ref: "t1", role: "textbox", name: "", rect: { x: 60, y: 220, width: 1200, height: 320 } },
    { ref: "t2", role: "textbox", name: "Email", rect: { x: 0, y: 0, width: 200, height: 24 } },
  ];
  assert.equal(pickEditor(els).ref, "t1");
  assert.equal(pickEditor(els.slice(0, 1)), null);
  assert.equal(cleanGenerated("Sure, here's a 150-word story about the Jurassic:\n\nThe island woke at dawn.\n\nRaptors ran.\n\nLet me know if you want more!"), "The island woke at dawn.\n\nRaptors ran.");
  assert.equal(cleanGenerated('"A quoted story."'), "A quoted story.");
});

test("compose: the text is generated ONCE, typed ONCE at the end of the editor, then the task finishes - never a loop", async () => {
  const comp = new Composer();
  const els = [{ ref: "t1", role: "textbox", name: "", rect: { x: 60, y: 220, width: 1200, height: 320 } }];
  const obs = { url: "https://justnotepad.com/", title: "JustNotepad", elements: els };
  let generated = 0;
  const STORY = "In a hidden valley the great lizards still walked, and the humans who found them learned to be quiet. At dawn the herds crossed the river while the rangers counted every footprint. By dusk the whole island glowed orange, and nobody wanted to leave.";
  const generate = async () => { generated++; return `Sure, here you go:\n\n${STORY}`; };
  const recent = [];
  const first = await comp.next({ taskId: "j", goal: JURASSIC, obs, els, recent, generate });
  assert.equal(first.status, "continue");
  assert.deepEqual(first.actions.map((a) => a.action), ["click", "hotkey", "type"]);
  assert.equal(first.actions[0].target.ref, "t1");
  assert.match(first.actions[2].text, /^In a hidden valley/);
  assert.doesNotMatch(first.actions[2].text, /\[\d+ chars\]|Sure/);
  recent.push({ text: "click t1 -> ok", ok: true }, { text: "hotkey ctrl+End -> ok", ok: true }, { text: 'type  "In a hidden va…[103 chars]" -> ok', ok: true });
  const typedEls = [{ ...els[0], value: "In a hidden valley the great lizards still walked" }]; // the field now shows the text
  const second = await comp.next({ taskId: "j", goal: JURASSIC, obs, els: typedEls, recent, generate });
  assert.equal(second.status, "done");
  assert.match(second.result, /Typed about \d+ words/);
  assert.equal(await comp.next({ taskId: "j", goal: JURASSIC, obs, els, recent, generate }), null, "finished: it does not start again");
  assert.equal(generated, 1);
});

test("the redacted log text 'The Jurassic…[25 chars]' is never sent back to the model, and a repeat of text already typed is dropped (the loop from the screenshot)", async () => {
  const fetchLog = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    fetchLog.push(body);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ complete: false, reason: "Typing the story", actions: [{ type: "type", selector: '[data-noah-ref="t1"]', text: "The Jurassic World story begins here and goes on" }] }) };
  };
  const p = new RexyLegacyProvider({ name: "rexy", baseURL: "https://legacy.example/predict", getKey: () => null, fetch: fetchImpl, options: { keyless: true } });
  const els = [{ ref: "t1", role: "textbox", name: "note", rect: { x: 0, y: 0, width: 10, height: 10 } }];
  const meta = { goal: "please jot down my thoughts", taskId: "loop", observation: { url: "https://x.test/", title: "x", elements: els, tabs: [], pageText: { viewport: "The Jurassic World story begins here" } }, recentActions: [{ text: 'type t1 "The Jurassic…[25 chars]" -> ok [text_changed] via ax', ok: true }] };
  const res = await p.complete({ model: "m", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "t" }] }], tools: [], toolChoice: "noah_step", meta });
  const sent = JSON.stringify(fetchLog[0].memory);
  assert.doesNotMatch(sent, /\[\d+ chars\]/, "no redacted placeholder reaches the model");
  assert.equal(res.toolCalls[0].args.status, "done", "the model proposed typing what was already typed: finish instead of typing again");
  assert.ok(!(res.toolCalls[0].args.actions || []).some((a) => a.action === "type"));
});

const { promptsFor, topicFrom, looksWrong } = require("../../models/compose.cjs");
test("compose: the prompt is about the TOPIC only (no site, no 'open', no page), and an echoed request or a too-short reply is rejected", async () => {
  const goal = "Noah, open justnotepad.com and do me a favor and type of whole context about the Jurassic word on this page note pad okay just start typing you can write a story about the Jurassic word on this note pad you see on the page can you start writing";
  assert.equal(topicFrom(goal), "Jurassic World");
  const [p1, p2] = promptsFor(goal);
  assert.match(p1, /^Write a story of about 150 words about Jurassic World\./);
  for (const p of [p1, p2]) assert.doesNotMatch(p, /justnotepad|open |notepad|page/i);
  assert.equal(topicFrom("write a poem about the sea in the editor"), "sea");
  assert.match(promptsFor("please compose a letter to my landlord")[0], /^Write a letter of about 150 words for this request: compose a letter to my landlord/);
  // what actually got typed last time: the request itself
  assert.equal(looksWrong("open justnotepad.com and write a story about the Jurassic world", "open justnotepad.com and write a story about the Jurassic world"), true);
  assert.equal(looksWrong("Too short.", "write a story"), true);
  const story = "In a hidden valley the great lizards still walked, and the humans who found them learned to be quiet. At dawn the herds crossed the river while the rangers counted every footprint. By dusk the whole island glowed orange, and nobody wanted to leave.";
  assert.equal(looksWrong(story, "write a story about the Jurassic world"), false);

  // the composer retries with the second wording when the first reply is an echo, and never types the echo
  const els = [{ ref: "t1", role: "textbox", name: "", rect: { x: 0, y: 0, width: 1200, height: 320 } }];
  const obs = { url: "https://x.test/", title: "x", elements: els };
  const prompts = [];
  const generate = async (p) => { prompts.push(p); return prompts.length === 1 ? "open justnotepad.com and write a story about the Jurassic world" : story; };
  const comp = new Composer();
  const first = await comp.next({ taskId: "e", goal, obs, els, recent: [], generate });
  assert.equal(first.actions[0].action, "wait", "first reply was an echo: think again, type nothing");
  const second = await comp.next({ taskId: "e", goal, obs, els, recent: [], generate });
  assert.equal(second.actions[2].text, story);
  assert.equal(prompts.length, 2);
});

test("compose: a looping model reply is de-duplicated and capped so a readable story gets typed", () => {
  const loop = "The island was quiet at dawn. The dinosaur spoke in the words of the notepad, and it was a story that had been told for eons. ".repeat(40);
  const cleaned = cleanGenerated(loop);
  const sentences = cleaned.match(/[^.!?]+[.!?]+/g) || [];
  assert.equal(new Set(sentences.map((s) => s.trim().toLowerCase())).size, sentences.length, "no sentence appears twice");
  assert.ok(cleaned.split(/\s+/).length < 60);
  const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} tells another part of the tale with some new words ${i * 7}.`).join(" ");
  const capped = cleanGenerated(long);
  assert.ok(capped.split(/\s+/).length <= 275 && capped.split(/\s+/).length > 200, "capped near 260 words");
  assert.ok(/[.!?]$/.test(capped), "ends on a sentence boundary");
});

test("compose: if the editor wipes the text after typing (it initialised late), Noah waits and writes it once more - then stops", async () => {
  const STORY = "In a hidden valley the great lizards still walked, and the humans who found them learned to be quiet. At dawn the herds crossed the river while the rangers counted every footprint. By dusk the whole island glowed orange, and nobody wanted to leave.";
  const empty = [{ ref: "t1", role: "textbox", name: "", rect: { x: 0, y: 0, width: 1200, height: 320 } }];
  const obs = { url: "https://x.test/", title: "x", elements: empty };
  const comp = new Composer();
  const generate = async () => STORY;
  const recent = [];
  const first = await comp.next({ taskId: "w", goal: JURASSIC, obs, els: empty, recent, generate });
  assert.equal(first.actions[2].action, "type");
  recent.push({ text: 'type  "In a hidden va…[250 chars]" -> ok', ok: true });
  const settle = await comp.next({ taskId: "w", goal: JURASSIC, obs, els: empty, recent, generate }); // box is empty again
  assert.equal(settle.actions[0].action, "wait");
  const again = await comp.next({ taskId: "w", goal: JURASSIC, obs, els: empty, recent, generate });
  assert.equal(again.actions[2].action, "type", "written a second time");
  recent.push({ text: 'type  "In a hidden va…[250 chars]" -> ok', ok: true });
  const end = await comp.next({ taskId: "w", goal: JURASSIC, obs, els: empty, recent, generate }); // still empty: no third try
  assert.equal(end.status, "done");
});
