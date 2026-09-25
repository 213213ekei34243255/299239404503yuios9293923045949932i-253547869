// Noah/test/unit/code-compose.test.cjs
//
// "Write a whole big program of palindrome ... on the page code snippet" on online-python.com: the editor there is Ace, which
// is not in the accessibility tree, and typing code into it key by key corrupts it. These tests pin the behaviour that fixed it.

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const cc = require("../../models/code-compose.cjs");
const { Composer, composeIntentFrom } = require("../../models/compose.cjs");
const { RexyLegacyProvider } = require("../../models/rexy-legacy.cjs");

const GOAL = "do me a favour write a whole big program of palindrome accepting 30 different input numbers including fibonacci tribonacci on the page code snippet";
const CODE = "def is_palindrome(n):\n    s = str(n)\n    return s == s[::-1]\n\ndef fibonacci(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\nfor i in range(30):\n    print(i, is_palindrome(i), fibonacci(i))";
const FENCED = "```python\n" + CODE + "\n```";
const aceEditor = { ref: "e9", role: "textbox", name: "Code editor (Ace)", rect: { x: 218, y: 117, width: 765, height: 310 }, states: { multiline: true }, synthetic: true };
const OBS = { url: "https://www.online-python.com/", title: "Online Python - IDE, Editor, Compiler, Interpreter", pageText: { viewport: "main.py 1 Run Share" } };

test("a 'write a program ... on the page code snippet' goal is a CODE writing goal (it used to fall through to the step model)", () => {
  const i = composeIntentFrom(GOAL);
  assert.ok(i, "recognised as a writing task");
  assert.equal(i.code, true);
  assert.equal(composeIntentFrom("write a story about dinosaurs on this notepad").code, false, "prose stays prose");
  assert.equal(composeIntentFrom("search for python tutorials"), null);
});

test("the task is pulled out of the request; the language comes from the request, then the page, then defaults to Python", () => {
  assert.equal(cc.taskFrom(GOAL), "palindrome accepting 30 different input numbers including fibonacci tribonacci");
  assert.equal(cc.languageFor("write a javascript function"), "JavaScript");
  assert.equal(cc.languageFor("write a program", "Online Python - IDE"), "Python");
  assert.equal(cc.languageFor("write a java program"), "Java", "java is not javascript");
  assert.equal(cc.languageFor("write a program", "Some editor"), "Python");
  const [first] = cc.codePromptsFor({ request: GOAL, language: "Python" });
  assert.match(first.message, /^Write a complete Python program: palindrome/);
  assert.doesNotMatch(first.message, /favour|page|snippet/i, "no chatter and no mention of the page (the hosted chat mode echoes those)");
});

test("the model's fenced answer becomes plain code; junk and broken Python are rejected", () => {
  assert.equal(cc.cleanGeneratedCode(FENCED), CODE);
  assert.equal(cc.cleanGeneratedCode("Sure, here is the code:\n" + CODE), CODE);
  assert.equal(cc.looksLikeCode(CODE, "Python"), true);
  assert.equal(cc.looksLikeCode('{"needs_web_search":true,"search_query":"Write a complete Python program"}', "Python"), false);
  assert.equal(cc.looksLikeCode("I am sorry, I cannot write that program for you right now.\nPlease try again later.\nThanks", "Python"), false);
  const broken = "def is_fibonacci(n):\n    return n > 0\n\ndef is tribonacci(n):\n    return n > 1\n\nprint(is_fibonacci(3))";
  assert.equal(cc.looksLikeCode(broken, "Python"), false, "'def is tribonacci(n)' is not valid Python");
  assert.ok(cc.cleanGeneratedCode("x = 1\n".repeat(2000)).length <= cc.MAX_CODE, "fits one type action");
});

test("composer: code goes in as ONE insert into the editor, replacing the starter code; never key by key", async () => {
  const composer = new Composer();
  const asked = [];
  const generate = async (message, page) => (asked.push({ message, page }), FENCED);
  const step = await composer.next({ taskId: "code1", goal: GOAL, obs: OBS, els: [aceEditor], recent: [], generate, context: null });
  assert.equal(step.status, "continue");
  assert.deepEqual(step.actions.map((a) => a.action), ["click", "hotkey", "type"]);
  assert.equal(step.actions[0].target.ref, "e9", "clicks the Ace editor the observer added");
  assert.equal(step.actions[1].combo, "ctrl+a", "a fresh program replaces the site's starter code");
  assert.equal(step.actions[2].mode, "insert", "typing code key by key corrupts it (autocomplete, auto-indent)");
  assert.equal(step.actions[2].text, CODE);
  assert.match(asked[0].message, /Python/);
});

test("composer: it reports success only when the code is really on the page, and says so honestly when it cannot tell", async () => {
  const mk = async (pageText) => {
    const composer = new Composer();
    await composer.next({ taskId: "c2" + pageText.length, goal: GOAL, obs: OBS, els: [aceEditor], recent: [], generate: async () => FENCED, context: null });
    return composer.next({ taskId: "c2" + pageText.length, goal: GOAL, obs: { ...OBS, pageText: { viewport: pageText } }, els: [aceEditor], recent: [{ ok: true, text: 'type e9 "def is_palindrome(n):…[400 chars]"' }], generate: async () => FENCED, context: null });
  };
  const yes = await mk("main.py 11 for i in range(30): 12 print(i, is_palindrome(i), fibonacci(i)) Run");
  assert.equal(yes.status, "done");
  assert.match(yes.result, /^Wrote 10 lines of Python code/);
  const no = await mk("main.py 1 Run Share");
  assert.equal(no.status, "done");
  assert.match(no.result, /could not read it back to confirm/, "no false 'done, all good'");
});

test("composer: a code task with no editor on the page gives up with a clear message instead of typing somewhere random", async () => {
  const composer = new Composer();
  const outs = [];
  for (let i = 0; i < 6; i++) outs.push(await composer.next({ taskId: "noeditor", goal: GOAL, obs: OBS, els: [{ ref: "e1", role: "textbox", name: "Command Line Arguments", rect: { x: 0, y: 0, width: 300, height: 30 } }], recent: [], generate: async () => FENCED, context: null }));
  const step = outs.find((o) => o && o.status === "give_up");
  assert.ok(step, "gives up (after waiting a moment for the editor to load)");
  assert.match(step.summary, /could not find a code editor/);
});

test("composer: junk answers are retried, and after four tries it gives up honestly", async () => {
  const composer = new Composer();
  let n = 0;
  const generate = async () => (n++, '{"needs_web_search":true,"search_query":"Write a complete Python program"}');
  const outs = [];
  for (let i = 0; i < 6; i++) outs.push(await composer.next({ taskId: "junk", goal: GOAL, obs: OBS, els: [aceEditor], recent: [], generate, context: null }));
  assert.equal(outs.filter((o) => o && o.status === "continue").length, 3);
  assert.ok(outs.find((o) => o && o.status === "give_up"));
  assert.equal(n, 4);
});

test("a follow-up after writing code continues the CODE (appends), not a prose paragraph", async () => {
  const composer = new Composer();
  const context = { previousGoals: [GOAL], lastGoal: GOAL, lastWritten: CODE, browser: { url: OBS.url } };
  const asked = [];
  const more = "def tribonacci(n):\n    a, b, c = 0, 0, 1\n    for _ in range(n):\n        a, b, c = b, c, a + b + c\n    return a\n\nprint(tribonacci(10))";
  const step = await composer.next({ taskId: "cont", goal: "add more to it", obs: OBS, els: [aceEditor], recent: [], generate: async (m, p) => (asked.push({ m, p }), more), context });
  assert.ok(step && step.actions, "handled by the composer");
  assert.equal(step.actions[1].combo, "ctrl+End", "appends after the existing code");
  assert.equal(step.actions[2].mode, "insert");
  assert.ok(step.actions[2].text.startsWith("\n\n"));
  assert.match(asked[0].m, /^Write more Python code/);
  assert.match(asked[0].p, /is_palindrome/, "the code so far is the page the model reads");
});

test("legacy adapter: it will not say 'Typed the text once.' when nothing typed is visible on the page", async () => {
  const p = new RexyLegacyProvider({ name: "rexy", baseURL: "https://legacy.example/predict", getKey: () => null, fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ complete: false, actions: [{ type: "type", selector: '[data-noah-ref="e2"]', text: "def is_palindrome(n): return n" }] }) }), options: { keyless: true } });
  const els = [{ ref: "e2", role: "textbox", name: "Command Line Arguments", rect: { x: 0, y: 0, width: 300, height: 30 }, states: {} }];
  const recent = [{ ok: true, text: 'type e2 "def is_palindrome…[30 chars]"' }, { ok: true, text: "click e1" }];
  const shown = async (pageText) => (await p.complete({ system: "s", messages: [], tools: [], toolChoice: "noah_step", meta: { goal: "write something in the box", observation: { url: "https://x.example/", title: "x", elements: els, tabs: [], pageText: { viewport: pageText } }, taskId: "h" + pageText.length, recentActions: recent } })).toolCalls[0].args;
  assert.equal((await shown("main.py 1 Run Share")).status, "give_up", "not on the page: honest failure");
  assert.equal((await shown("1 def is_palindrome(n): 2 return")).status, "done", "on the page: done");
});
