// Noah/test/unit/intake.test.cjs - the shared way the app handles what the user wrote (Noah/intake/request.cjs): never cut, parts listed, answers checked against the parts.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../../intake/request.cjs");

const numbered = (n) => Array.from({ length: n }, (_, i) => `Question ${i + 1}: what is ${i + 1} plus 100?`).join("\n");

test("normalizing never cuts: only line endings and NULs change, and a message above the hard limit is FLAGGED, not trimmed", () => {
  const big = "x".repeat(R.MAX_REQUEST_CHARS + 5);
  const n = R.normalizeRequest(big);
  assert.equal(n.chars, R.MAX_REQUEST_CHARS + 5);
  assert.equal(n.text.length, R.MAX_REQUEST_CHARS + 5);
  assert.equal(n.tooLong, true);
  assert.equal(R.normalizeRequest("a\r\nb\rc\u0000d  ").text, "a\nb\ncd");
  assert.equal(R.normalizeRequest(null).text, "");
  assert.equal(R.normalizeRequest(undefined).chars, 0);
  assert.equal(R.normalizeRequest(12345).text, "12345");
  assert.equal(R.normalizeRequest("x".repeat(50_000)).tooLong, false, "50 000 characters is fine");
});

test("parts: numbered lines, bullets, separate lines, or the questions of one paragraph; a single request has none", () => {
  assert.deepEqual(R.splitParts(numbered(5)).map((p) => p.n), [1, 2, 3, 4, 5]);
  assert.equal(R.splitParts("1. Open Notepad\n2) Write hello\n3. Save it as test.txt").length, 3);
  assert.equal(R.splitParts("Please do these:\n- make a table\n- add a chart\n* email it to Sam").length, 3);
  assert.equal(R.splitParts("Find the cheapest flight\nThen book a hotel near the airport\nAnd tell me the total cost").length, 3);
  const para = R.splitParts("What is the capital of France? Who wrote Hamlet? How many legs does a spider have?");
  assert.equal(para.length, 3);
  assert.ok(para.every((p) => p.question));
  assert.deepEqual(R.splitParts("open youtube"), []);
  assert.deepEqual(R.splitParts("Please summarise this article for me, thanks."), []);
  assert.deepEqual(R.splitParts(""), []);
  assert.deepEqual(R.splitParts(null), []);
  // continuation lines belong to their part
  const multi = R.splitParts("1. Build a table of the prices\n   sorted from lowest to highest\n2. Chart it");
  assert.equal(multi.length, 2);
  assert.match(multi[0].text, /sorted from lowest to highest/);
});

test("a real reply that stops mid-line ('Answer 119:') is detected as cut off, and exactly the unanswered parts come back as missing", () => {
  const parts = R.splitParts(numbered(150));
  assert.equal(parts.length, 150);
  const reply = Array.from({ length: 118 }, (_, i) => `Answer ${i + 1}: ${i + 101}`).join("\n") + "\nAnswer 119:";
  const c = R.coverage(parts, reply);
  assert.equal(c.cutOff, true);
  assert.deepEqual([c.missing[0].n, c.missing[c.missing.length - 1].n, c.missing.length], [119, 150, 32]);
  const full = Array.from({ length: 150 }, (_, i) => `Answer ${i + 1}: ${i + 101}`).join("\n");
  const ok = R.coverage(parts, full);
  assert.deepEqual([ok.missing.length, ok.cutOff], [0, false]);
});

test("coverage by words: a prose answer that deals with each question counts; one that skips a question is caught; nothing is claimed for a part with nothing to match", () => {
  const parts = R.splitParts("What is the capital of France? Who wrote Hamlet? How many legs does a spider have?");
  const good = "The capital of France is Paris. Hamlet was written by Shakespeare. A spider has eight legs.";
  assert.deepEqual(R.coverage(parts, good).missing, []);
  const skipped = R.coverage(parts, "The capital of France is Paris. A spider has eight legs.");
  assert.deepEqual(skipped.missing.map((p) => p.n), [2]);
  assert.equal(R.coverage(parts, "").missing.length, 3, "an empty answer answers nothing");
  assert.deepEqual(R.coverage([], "anything").missing, []);
});

test("an answer that merely repeats or numbers the questions without answering is not a cut-off, and a complete one ending in a full stop is never 'cut off'", () => {
  const parts = R.splitParts("1. Name a colour\n2. Name an animal\n3. Name a city");
  const done = "1. Blue.\n2. Dog.\n3. Paris.";
  assert.deepEqual(R.coverage(parts, done), { missing: [], cutOff: false });
  assert.equal(R.coverage(parts, "1. Blue.\n2. Dog.\n3. Paris and").cutOff, true);
  assert.equal(R.coverage(parts, "1. Blue.\n2. Dog.\n3.").missing.length >= 1, true);
});

test("the continuation message names ONLY the missing parts, keeps their numbers, and stands on its own", () => {
  const parts = R.splitParts(numbered(10));
  const missing = parts.slice(7);
  const m = R.continuationMessage(missing, { intro: "Answer each in the form Answer N: X" });
  assert.match(m, /^Some parts of my earlier message were not answered yet/);
  assert.match(m, /Answer each in the form Answer N: X/);
  assert.ok(m.includes("Question 8: what is 8 plus 100?") && m.includes("Question 10: what is 10 plus 100?"));
  assert.ok(!m.includes("Question 7:"), "parts that were answered are not asked again");
  const unnumbered = R.splitParts("Find a flight\nBook a hotel\nRent a car");
  assert.match(R.continuationMessage(unnumbered.slice(1)), /\n2\. Book a hotel\n3\. Rent a car$/);
});

test("a long request is shown whole up to the limit; beyond it as a numbered digest of EVERY part with the way to read the rest; the slices cover the text exactly", () => {
  const short = numbered(30);
  const v1 = R.viewForModel(short);
  assert.equal(v1.complete, true);
  assert.equal(v1.lines[0], short);
  const long = Array.from({ length: 400 }, (_, i) => `${i + 1}. ${"detail ".repeat(20)}number ${i + 1}`).join("\n");
  assert.ok(long.length > R.FULL_VIEW_CHARS);
  const v2 = R.viewForModel(long);
  assert.equal(v2.complete, false);
  assert.match(v2.lines[0], /a long request: \d+ characters, 400 parts; call request_read/);
  assert.ok(v2.lines.some((l) => l.startsWith("80. ")), "digest numbered per part");
  assert.ok(v2.lines.some((l) => /^\(\+320 more parts/.test(l)), "and says what it left out");
  // reading the whole thing back slice by slice gives exactly the text
  let off = 0, back = "";
  for (let guard = 0; guard < 1000 && off !== null; guard++) { const s = R.readSlice(long, off); back += s.text; off = s.next; assert.equal(s.total, long.length); }
  assert.equal(back, long, "nothing is lost between the slices");
  assert.deepEqual(R.readSlice("abc", 99), { text: "", offset: 3, next: null, total: 3 });
  assert.deepEqual(R.readSlice("abc", "nonsense"), { text: "abc", offset: 0, next: null, total: 3 });
});

test("the rule that goes into every prompt names the number of parts, and is empty for a single request", () => {
  assert.equal(R.partsRule([]), "");
  assert.match(R.partsRule(R.splitParts(numbered(7))), /has 7 parts\. Deal with EVERY one, in order, and in your final answer address each part by its number/);
});
