// Noah/test/unit/chat-complete.test.cjs - a chat reply is COMPLETE whatever the server's output limit (Rexy/chat-complete.cjs), and the runtime really uses it.
// The fake server below behaves like the real one measured on 2026-10-09: it receives the whole message and ends its reply after about 1800 characters, mid-line.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { completeChat, introOf, withoutDanglingTail } = require("../../../Rexy/chat-complete.cjs");
const { splitParts } = require("../../intake/request.cjs");
const LLMClient = require("../../../Rexy/llm.cjs");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const numbered = (n) => Array.from({ length: n }, (_, i) => `Question ${i + 1}: what is ${i + 1} plus 100?`).join("\n");
const long = (n) => `Please answer each numbered question below in order, one line each, like "Answer 7: 107".\n\n${numbered(n)}\n\nLast of all, say DONE.`;

/** A server that answers every "Question N" it can SEE in the message, but never more than `cap` characters per reply, cutting mid-line like the real one. */
function truncatingServer({ cap = 1800, drop = null } = {}) {
  const seen = [];
  const ask = async (message) => {
    seen.push(message);
    const qs = [...String(message).matchAll(/what is (\d+) plus 100\?/gi)].map((m) => Number(m[1]));
    const lines = qs.filter((n) => !(drop && drop(n, message))).map((n) => `Answer ${n}: ${n + 100}`);
    let out = lines.join("\n");
    if (/say DONE/.test(message) && out.length + 5 <= cap) out += "\nDONE";
    return out.length > cap ? out.slice(0, cap) : out;
  };
  return { ask, seen };
}

test("a reply cut off in the middle of a long numbered list is completed: every question answered, once, in order", async () => {
  const s = truncatingServer();
  const message = long(150);
  const first = await s.ask(message);
  assert.ok(first.length <= 1800 && !/Answer 150/.test(first), "the fake server really does cut the reply (as the real one did)");
  s.seen.length = 0;
  const r = await completeChat({ message, ask: s.ask });
  const nums = [...r.text.matchAll(/Answer (\d+): (\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.deepEqual(nums.map((x) => x[0]), Array.from({ length: 150 }, (_, i) => i + 1), "all 150 answered, in order, none twice");
  assert.ok(nums.every(([n, v]) => v === n + 100), "and correct");
  assert.deepEqual(r.unanswered, []);
  assert.ok(r.rounds >= 1 && r.rounds <= 12, `${r.rounds} follow-up requests`);
  assert.ok(!/could not get answers/.test(r.text));
  // every follow-up stood on its own and named only what was missing
  for (const m of s.seen.slice(1)) {
    assert.match(m, /^Some parts of my earlier message were not answered yet/);
    assert.match(m, /Answer each|one line each/, "the user's own instruction on HOW to answer came along");
  }
  assert.ok(!s.seen[1].includes("Question 1: what"), "a follow-up never repeats parts that were answered");
});

test("a complete reply costs exactly one request; a single request is never asked twice; an empty reply is returned as it is", async () => {
  let calls = 0;
  const r1 = await completeChat({ message: long(20), ask: async (m) => { calls++; return numbered(20).split("\n").map((l, i) => `Answer ${i + 1}: ${i + 101}`).join("\n") + "\nDONE"; } });
  assert.deepEqual([calls, r1.rounds, r1.unanswered.length], [1, 0, 0]);
  calls = 0;
  const r2 = await completeChat({ message: "what is the capital of France?", ask: async () => { calls++; return "Paris."; } });
  assert.deepEqual([calls, r2.text], [1, "Paris."]);
  calls = 0;
  const r3 = await completeChat({ message: long(10), ask: async () => { calls++; return ""; } });
  assert.deepEqual([calls, r3.text], [1, ""], "no reply: nothing is invented, nothing is retried at once");
});

test("a part the server keeps skipping is REPORTED at the end, never dropped silently, and the loop stops (no endless asking)", async () => {
  const s = truncatingServer({ cap: 100000, drop: (n) => n === 7 });
  const r = await completeChat({ message: long(12), ask: s.ask });
  assert.deepEqual(r.unanswered, [7]);
  assert.match(r.text, /I could not get answers for part 7 of your message/);
  assert.ok(r.rounds <= 3, `stopped after ${r.rounds} follow-ups`);
  assert.match(r.text, /Answer 12: 112/);
});

test("a single long answer that stops in the middle of a thought is continued from where it stopped; a short one ending in a colon is left alone", async () => {
  const body = "The history of the printing press begins in the fifteenth century, when " + "Gutenberg improved movable type and ".repeat(30);
  const asked = [];
  const r = await completeChat({ message: "Tell me the history of the printing press in detail", ask: async (m) => { asked.push(m); return asked.length === 1 ? body + "and the" : "spread across Europe within decades."; } });
  assert.equal(asked.length, 2);
  assert.match(asked[1], /Your last reply was cut off\. Continue EXACTLY where it stopped/);
  assert.match(r.text, /and the spread across Europe within decades\.$/);
  let calls = 0;
  const short = await completeChat({ message: "list my options", ask: async () => { calls++; return "Here are your options:"; } });
  assert.deepEqual([calls, short.text], [1, "Here are your options:"]);
});

test("helpers: the intro before the first part, and a cut last line is dropped before the continuation is appended", () => {
  assert.equal(introOf(long(3)), "Please answer each numbered question below in order, one line each, like \"Answer 7: 107\".");
  assert.equal(introOf("1. a\n2. b"), "");
  assert.equal(withoutDanglingTail("Answer 1: 101\nAnswer 2:"), "Answer 1: 101");
  assert.equal(withoutDanglingTail("Answer 1: 101\nAnswer 2: 102."), "Answer 1: 101\nAnswer 2: 102.");
});

test("through the REAL client: the long message goes out whole in the first request, and the follow-ups carry the same session id", async () => {
  const original = global.fetch;
  const bodies = [];
  const s = truncatingServer({ cap: 700 });
  global.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    bodies.push(b);
    const answer = await s.ask(b.message);
    return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ answer }), text: async () => JSON.stringify({ answer }) };
  };
  const log = console.log; console.log = () => {};
  try {
    const llm = new LLMClient({ endpoint: "http://127.0.0.1:9/predict" });
    const message = long(60);
    const r = await completeChat({ message, ask: (m) => llm.chat({ message: m }) });
    assert.equal(bodies[0].message, message, "request 1 carries the complete message, character for character");
    assert.ok(bodies.length >= 2 && bodies.every((b) => b.session_id === bodies[0].session_id));
    assert.deepEqual([...r.text.matchAll(/Answer (\d+):/g)].map((m) => Number(m[1])), Array.from({ length: 60 }, (_, i) => i + 1));
    assert.equal(splitParts(message).length, 61, "60 numbered questions + the closing instruction");
  } finally { global.fetch = original; console.log = log; }
});

test("the runtime's chat path uses it, and a list of questions is not sent to a web search (its first 300 characters make a useless query)", () => {
  const runtime = fs.readFileSync(path.join(ROOT, "Rexy/runtime.cjs"), "utf8");
  assert.ok(runtime.includes("require(\"./chat-complete.cjs\").completeChat({") && runtime.includes("const reply = done.text;"));
  const llm = fs.readFileSync(path.join(ROOT, "Rexy/llm.cjs"), "utf8");
  assert.ok(llm.includes("if (!searched && !severalParts && needsGrounding(text)) {") && llm.includes("if (!searched && !severalParts && admitsNotKnowing(first.answer)) {"));
});

test("a closing instruction AFTER the list is a part of its own: it is asked for when missing, and a repeated numbered line is kept once", async () => {
  const { dedupeNumbered } = require("../../../Rexy/chat-complete.cjs");
  const { coverage } = require("../../intake/request.cjs");
  const msg = `Answer in order.\n\n${numbered(4)}\n\nLast of all, repeat the code ZEBRA-4821.`;
  const parts = splitParts(msg);
  assert.equal(parts.length, 5);
  const answers = [1, 2, 3, 4].map((n) => `Answer ${n}: ${n + 100}`).join("\n");
  assert.deepEqual(coverage(parts, answers).missing.map((p) => p.n), [5], "numbered answers do not cover the closing instruction");
  assert.deepEqual(coverage(parts, `${answers}\nZEBRA-4821`).missing, []);
  assert.equal(dedupeNumbered("Answer 1: 101\nAnswer 2: 102\nAnswer 2: 102\nAnswer 3: 103\nnote"), "Answer 1: 101\nAnswer 2: 102\nAnswer 3: 103\nnote");
  // end to end: the server leaves the closing line out on request 1; the follow-up supplies it, and nothing is answered twice
  const asked = [];
  const r = await completeChat({ message: msg, ask: async (m) => { asked.push(m); return asked.length === 1 ? answers : (/ZEBRA-4821/.test(m) ? "The code is ZEBRA-4821" : "") ; } });
  assert.equal(asked.length, 2);
  assert.match(r.text, /ZEBRA-4821/);
  assert.deepEqual(r.unanswered, []);
});

test("when a follow-up answers a question that was already answered, that numbered line appears once in the joined reply", async () => {
  const msg = `Answer in order.\n\n${numbered(5)}`;
  const asked = [];
  const r = await completeChat({
    message: msg,
    ask: async (m) => {
      asked.push(m);
      if (asked.length === 1) return "Answer 1: 101\nAnswer 2: 102\nAnswer 3: 103"; // cut here: 4 and 5 missing
      return "Answer 3: 103\nAnswer 4: 104\nAnswer 5: 105"; // the follow-up repeats 3
    },
  });
  assert.deepEqual([...r.text.matchAll(/Answer (\d+):/g)].map((m) => Number(m[1])), [1, 2, 3, 4, 5]);
});
