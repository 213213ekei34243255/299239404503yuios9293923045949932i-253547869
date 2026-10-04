// Noah/test/unit/autonomy-working-set.test.cjs - the files a mission has read, kept in the briefing and kept current (Noah/autonomy/working-set.cjs)
// A live run showed why this exists: with only a one-line note left of a file read two rounds earlier, the real model edited text that was not in the file.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { WorkingSet, MAX_ENTRIES } = require("../../autonomy/working-set.cjs");

/** A fake disk: path -> { text, mtimeMs }, and the two functions the working set needs. */
function disk(initial = {}) {
  const files = new Map(Object.entries(initial).map(([p, text]) => [p, { text, mtimeMs: 1000 }]));
  const reads = [];
  const read = (p, a = {}) => {
    const f = files.get(p);
    if (!f) return { ok: false, code: "not_found" };
    const all = f.text.split("\n");
    const start = a.offset || 1;
    const lim = a.limit || 2000;
    const slice = all.slice(start - 1, start - 1 + lim);
    reads.push({ p, ...a });
    return { ok: true, path: p, content: slice.map((l, i) => `${String(start + i).padStart(6)}\t${l}`).join("\n"), startLine: start, endLine: start - 1 + slice.length, totalLines: all.length, truncated: start - 1 + slice.length < all.length };
  };
  return {
    files, reads,
    set: (p, text) => files.set(p, { text, mtimeMs: (files.get(p)?.mtimeMs || 1000) + 1 }),
    del: (p) => files.delete(p),
    statOf: (p) => (files.has(p) ? { mtimeMs: files.get(p).mtimeMs, size: files.get(p).text.length } : null),
    readFile: async (p, a) => read(p, a),
    read,
  };
}
const ws = (d, o = {}) => new WorkingSet({ statOf: d.statOf, readFile: d.readFile, ...o });
const learn = (set, d, p, a = {}) => set.remember(a, d.read(p, a));

test("what was read is kept with its place in the file, and what failed or is not text is not", () => {
  const d = disk({ "src/a.js": "line one\nline two" });
  const s = ws(d);
  learn(s, d, "src/a.js");
  const [e] = s.entries();
  assert.deepEqual([e.path, e.startLine, e.endLine, e.totalLines, e.partial], ["src/a.js", 1, 2, 2, false]);
  assert.match(e.content, /^ {5}1\tline one\n {5}2\tline two$/);
  s.remember({}, { ok: false, code: "not_found" });
  s.remember({}, { ok: true, path: "x", content: 42 });
  s.remember({}, null);
  assert.equal(s.entries().length, 1);
});

test("a working set with no budget is off", () => {
  const d = disk({ a: "x" });
  const s = ws(d, { maxChars: 0 });
  assert.equal(s.enabled, false);
  learn(s, d, "a");
  assert.deepEqual(s.entries(), []);
  return s.refresh(); // and refreshing it does nothing, quietly
});

test("the file used most recently comes first, and reading a file again moves it up", () => {
  const d = disk({ a: "A".repeat(50), b: "B".repeat(50), c: "C".repeat(50) });
  const s = ws(d);
  for (const p of ["a", "b", "c"]) learn(s, d, p);
  assert.deepEqual(s.entries().map((e) => e.path), ["c", "b", "a"]);
  learn(s, d, "a");
  assert.deepEqual(s.entries().map((e) => e.path), ["a", "c", "b"]);
});

test("the budget is respected: a long file is cut at a line boundary and says so, and files that no longer fit are left out", () => {
  const long = Array.from({ length: 200 }, (_, i) => `row ${i + 1} ${"x".repeat(20)}`).join("\n");
  const d = disk({ big: long, small: "tiny" });
  const s = ws(d, { maxChars: 1500, perFile: 800 });
  learn(s, d, "big");
  const [e] = s.entries();
  assert.equal(e.partial, true);
  assert.ok(e.content.length <= 800);
  assert.match(e.content, /\trow \d+ x{20}$/, "ends on a whole line");
  assert.equal(e.endLine, e.startLine + e.content.split("\n").length - 1, "the line range matches what is shown");
  assert.ok(e.endLine < e.totalLines);

  const d2 = disk({ a: "a\n".repeat(400), b: "b\n".repeat(400), c: "c\n".repeat(400) });
  const s2 = ws(d2, { maxChars: 1100, perFile: 600 });
  for (const p of ["a", "b", "c"]) learn(s2, d2, p);
  const shown = s2.entries();
  assert.ok(shown.length >= 1 && shown.length < 3, `${shown.length} shown: not all three fit`);
  assert.equal(shown[0].path, "c", "the newest is the one kept");
  assert.ok(shown.reduce((n, x) => n + x.content.length, 0) <= 1100);
});

test("a file read THIS round is left out (its result already shows it in full)", () => {
  const d = disk({ a: "x", b: "y" });
  const s = ws(d);
  learn(s, d, "a"); learn(s, d, "b");
  assert.deepEqual(s.entries({ skipPaths: new Set(["b"]) }).map((e) => e.path), ["a"]);
  assert.deepEqual(s.entries({ skipPaths: ["a", "b"] }), []);
});

test("refresh: unchanged files are not read again; a changed file is, and moves to the front", async () => {
  const d = disk({ a: "old a", b: "old b" });
  const s = ws(d);
  learn(s, d, "a"); learn(s, d, "b");
  d.reads.length = 0;
  await s.refresh();
  assert.equal(d.reads.length, 0, "nothing changed, nothing read");
  d.set("a", "NEW a, longer");
  await s.refresh();
  assert.deepEqual(d.reads.map((r) => r.p), ["a"]);
  const [first] = s.entries();
  assert.equal(first.path, "a");
  assert.match(first.content, /NEW a, longer/);
  d.set("b", "old b"); // same size, newer time: still a change
  d.reads.length = 0;
  await s.refresh();
  assert.deepEqual(d.reads.map((r) => r.p), ["b"], "a changed time alone is enough");
});

test("refresh: a deleted file is forgotten, and a file that can no longer be read is dropped", async () => {
  const d = disk({ gone: "x", locked: "y", fine: "z" });
  const s = ws(d);
  for (const p of ["gone", "locked", "fine"]) learn(s, d, p);
  d.del("gone");
  await s.refresh();
  assert.deepEqual(s.entries().map((e) => e.path).sort(), ["fine", "locked"], "the deleted one is gone");
  // a file that changed but can no longer be read (it became protected, say) is dropped: nothing stale is ever shown
  const unreadable = new WorkingSet({ statOf: d.statOf, readFile: async () => ({ ok: false, code: "protected_path" }) });
  unreadable.remember({}, { ok: true, path: "locked", content: "old", startLine: 1, endLine: 1, totalLines: 1, truncated: false });
  d.set("locked", "changed again");
  await unreadable.refresh();
  assert.deepEqual(unreadable.entries(), []);
});

test("touch() forces a re-read even when the disk looks the same, and the original slice of the file is re-read", async () => {
  const d = disk({ f: Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n") });
  const s = ws(d);
  learn(s, d, "f", { offset: 10, limit: 5 });
  d.reads.length = 0;
  s.touch("f");
  await s.refresh();
  assert.deepEqual(d.reads, [{ p: "f", offset: 10, limit: 5 }]);
  const [e] = s.entries();
  assert.deepEqual([e.startLine, e.endLine], [10, 14]);
  s.touch("never-read"); // harmless
  s.drop("f");
  assert.deepEqual(s.entries(), []);
});

test("it never holds more than a handful of files: the least recently used goes first", () => {
  const d = disk(Object.fromEntries(Array.from({ length: MAX_ENTRIES + 3 }, (_, i) => [`f${i}`, "x"])));
  const s = ws(d, { maxChars: 100000 });
  for (let i = 0; i < MAX_ENTRIES + 3; i++) learn(s, d, `f${i}`);
  const names = s.entries().map((e) => e.path);
  assert.equal(names.length, MAX_ENTRIES);
  assert.ok(!names.includes("f0") && !names.includes("f1") && !names.includes("f2"));
  assert.equal(names[0], `f${MAX_ENTRIES + 2}`);
});
