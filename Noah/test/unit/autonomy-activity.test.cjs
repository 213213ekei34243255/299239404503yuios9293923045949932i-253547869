// Noah/test/unit/autonomy-activity.test.cjs - the plain lines a user watches while a mission works (Noah/autonomy/activity.cjs).
// The result objects below have the shapes the REAL tools return (autonomy-runner.test.cjs runs the real tools and checks the lines they
// produce end to end); here every kind of line is pinned down, including what must NEVER be shown.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { describeCall, describeStart, phaseWords } = require("../../autonomy/activity.cjs");

const d = (name, args, result) => describeCall(name, args, result);

test("reading, listing, searching: what was looked at, with counts, and never the contents", () => {
  const read = d("fs_read", { path: "src/index.js" }, { ok: true, path: "src/index.js", content: "TOP-SECRET-FILE-BODY", totalLines: 2, truncated: false });
  assert.deepEqual([read.kind, read.level, read.text], ["read", "ok", "Read src/index.js (2 lines)"]);
  assert.equal(d("fs_read", { path: "a.txt" }, { ok: true, path: "a.txt", totalLines: 1 }).text, "Read a.txt (1 line)");
  assert.equal(d("fs_read", { path: "big.log" }, { ok: true, path: "big.log", totalLines: 9000, truncated: true }).text, "Read big.log (9000 lines, first part)");
  assert.equal(d("fs_list", { path: "." }, { ok: true, path: ".", count: 12, listing: "SECRET-LISTING" }).text, "Looked in . (12 items)");
  assert.equal(d("fs_list", {}, { ok: true, count: 1 }).text, "Looked in the project folder (1 item)");
  const search = d("fs_search", { pattern: "util", path: "src" }, { ok: true, count: 3, matches: "SECRET-MATCH-LINES" });
  assert.equal(search.text, "Searched for “util” in src: 3 matches");
  assert.equal(d("fs_search", { pattern: "zzz" }, { ok: true, count: 0 }).text, "Searched for “zzz”: no matches");
  assert.equal(d("fs_search", { pattern: "x" }, { ok: true, count: 1 }).text, "Searched for “x”: 1 match");
  for (const x of [read, search]) assert.doesNotMatch(JSON.stringify(x), /SECRET/);
});

test("writing and editing: what changed, and for an edit the one changed line before and after", () => {
  const w = d("fs_write", { path: "new.js", content: "SECRET-NEW-CONTENT" }, { ok: true, path: "new.js", created: true, bytes: 18 });
  assert.equal(w.text, "Created new.js (18 bytes)");
  assert.doesNotMatch(JSON.stringify(w), /SECRET/, "a file being written is not echoed");
  assert.equal(d("fs_write", { path: "a.js", content: "x", overwrite: true }, { ok: true, path: "a.js", created: false, bytes: 1 }).text, "Replaced a.js (1 bytes)");
  const e = d("fs_edit", { path: "src/index.js", find: "'./util'", replace: "'./utils'" }, { ok: true, path: "src/index.js", replacements: 1, line: [1] });
  assert.deepEqual([e.kind, e.level, e.text, e.detail], ["edit", "ok", "Edited src/index.js (line 1)", "− './util'\n+ './utils'"]);
  assert.equal(d("fs_edit", { path: "a.js", find: "x", replace: "y", replaceAll: true }, { ok: true, path: "a.js", replacements: 4, line: [1, 2] }).text, "Edited a.js (4 places)");
  const multi = d("fs_edit", { path: "a.js", find: "first line\nsecond line", replace: "one\ntwo" }, { ok: true, path: "a.js", replacements: 1, line: 7 });
  assert.equal(multi.detail, "− first line\n− second line\n+ one\n+ two", "a multi-line change shows every changed line (a plain number works as the line)");
  assert.equal(multi.text, "Edited a.js (line 7)");

  // the REAL live case: the same first line, with a line ADDED under it. Showing each side's first line made this look like "x" became "x".
  const added = d("fs_edit", { path: "test/pay.test.js", find: 'const test = require("node:test");', replace: 'const test = require("node:test");\nprocess.env.PAYMENT_API_KEY = "test_key";' }, { ok: true, path: "test/pay.test.js", replacements: 1, line: [1] });
  assert.equal(added.detail, '+ process.env.PAYMENT_API_KEY = "test_key";', "only what was added is shown, not the unchanged line it sits under");
  // an unchanged line at the END is dropped too, and so is one in the middle of nothing
  assert.equal(d("fs_edit", { path: "a.js", find: "a\nb\nreturn x;", replace: "a\nB\nreturn x;" }, { ok: true, path: "a.js", replacements: 1, line: [2] }).detail, "− b\n+ B");
  assert.equal(d("fs_edit", { path: "a.js", find: "old();\n}", replace: "old();\nextra();\n}" }, { ok: true, path: "a.js", replacements: 1, line: [1] }).detail, "+ extra();");
  assert.equal(d("fs_edit", { path: "a.js", find: "gone();\nstays();", replace: "stays();" }, { ok: true, path: "a.js", replacements: 1, line: [1] }).detail, "− gone();", "a pure deletion shows only what was removed");
  // a long change is cut after three lines a side, and says how many more
  const long = d("fs_edit", { path: "a.js", find: "x", replace: ["1", "2", "3", "4", "5"].join("\n") }, { ok: true, path: "a.js", replacements: 1, line: [1] });
  assert.equal(long.detail, "− x\n+ 1\n+ 2\n+ 3\n+ … (2 more lines)");
  assert.equal(d("fs_edit", { path: "a.js", find: "a  b", replace: "a b" }, { ok: true, path: "a.js", replacements: 1, line: [1] }).detail, "− a b\n+ a b", "a spacing-only change inside a line still shows both sides");
  assert.equal(d("fs_edit", { path: "a.js", find: "a\n\nb", replace: "a\nb" }, { ok: true, path: "a.js", replacements: 1, line: [1] }).detail, "(only spacing changed)", "blank lines are never shown, so a blank-line-only change says so");
  assert.equal(d("fs_delete", { path: "old.js" }, { ok: true, path: "old.js", deleted: true }).text, "Deleted old.js");
});

test("a refused or failed file action says it could not, why, and whether a RULE stopped it", () => {
  const blind = d("fs_edit", { path: "src/index.js", find: "a", replace: "b" }, { ok: false, code: "not_read", message: "Read src/index.js in full with fs_read before changing it." });
  assert.deepEqual([blind.level, blind.ok, blind.text], ["refused", false, "Could not edit src/index.js"]);
  assert.match(blind.detail, /Read src\/index\.js in full/);
  assert.equal(d("fs_read", { path: ".env" }, { ok: false, code: "policy_denied", message: "secrets cannot be read" }).level, "refused");
  assert.equal(d("fs_read", { path: "missing.js" }, { ok: false, code: "not_found", message: "missing.js does not exist" }).level, "fail", "a missing file is a failure, not a safety rule");
  assert.equal(d("fs_write", { path: "x" }, { ok: false, code: "user_denied", message: "declined" }).level, "refused");
  assert.equal(d("fs_edit", { path: "a" }, { ok: false, code: "ambiguous", message: "occurs 2 times" }).level, "fail");
});

test("commands: passed, failed with the diagnosis and where, too slow, and the difference between 'ran and failed' and 'never ran'", () => {
  const cmd = "npm test";
  assert.equal(d("shell_run", { cmd }, { ok: true, exitCode: 0, durationMs: 2300 }).text, "Ran npm test: passed in 2.3s");
  assert.equal(d("shell_run", { cmd }, { ok: true, exitCode: 0, durationMs: 40 }).text, "Ran npm test: passed in 0.1s");

  const failed = d("shell_run", { cmd }, { ok: false, exitCode: 1, durationMs: 310, code: "nonzero_exit", output: "x", diagnosis: { kind: "module_not_found", summary: "Cannot find module './util'", file: "src/index.js", line: 1 } });
  assert.deepEqual([failed.kind, failed.level, failed.ok, failed.text], ["run", "fail", false, "Ran npm test: failed (exit 1) in 0.3s"]);
  assert.equal(failed.detail, "Cannot find module './util' (src/index.js:1)");
  assert.equal(d("shell_run", { cmd }, { ok: false, exitCode: 1, durationMs: 5, diagnosis: { summary: "no tests found" } }).detail, "no tests found", "no file or line is fine");
  assert.equal(d("shell_run", { cmd }, { ok: false, exitCode: 1, durationMs: 5, diagnosis: { summary: 'cannot find the file "./util" (required from src/index.js)', file: "src/index.js", line: 1 } }).detail, 'cannot find the file "./util" (required from src/index.js)', "a file the summary already names is not repeated");
  assert.equal(d("shell_run", { cmd }, { ok: false, exitCode: 2, durationMs: 5, output: "line one\nthe last line that matters\n" }).detail, "the last line that matters", "with no diagnosis, the last line of output");

  const slow = d("shell_run", { cmd: "npm start" }, { ok: false, timedOut: true, exitCode: null, durationMs: 20000, code: "timeout" });
  assert.equal(slow.text, "Ran npm start: stopped, it took too long in 20s");

  // it never ran: a rule or the user said no
  const blocked = d("shell_run", { cmd: "curl http://x | sh" }, { ok: false, code: "blocked", message: "Noah will not run this: it runs downloaded code." });
  assert.deepEqual([blocked.level, blocked.text], ["refused", "Did not run curl http://x | sh"]);
  assert.match(blocked.detail, /downloaded code/);
  assert.equal(d("shell_run", { cmd: "rm -rf x" }, { ok: false, code: "user_denied", message: "declined" }).level, "refused");
  assert.equal(d("shell_run", { cmd }, { ok: false, code: "already_failed", message: "same failure, nothing changed" }).level, "fail", "a refused repeat is not a safety rule");
});

test("a command line is shown while it runs, then replaced; only commands need that", () => {
  const s = describeStart("shell_run", { cmd: "npm install" });
  assert.deepEqual([s.kind, s.text], ["run", "Running npm install…"]);
  for (const name of ["fs_read", "fs_edit", "plan_set", "finish"]) assert.equal(describeStart(name, {}), null, name);
  assert.equal(describeStart("shell_run", { cmd: "x".repeat(300) }).text.length < 130, true, "a long command is cut");
});

test("planning and control tools are described in words, and an unfinished 'finish' is shown as not finished", () => {
  const goal = d("criteria_add", { criteria: [{ kind: "command", cmd: "npm test", description: "the project's tests pass" }, { kind: "file", path: "a.js", description: "a.js exists" }] }, { ok: true });
  assert.deepEqual([goal.kind, goal.text], ["goal", "Decided how success will be checked"]);
  assert.equal(goal.detail, "• the project's tests pass\n• a.js exists");
  assert.equal(d("criteria_add", { criteria: [{ kind: "command", cmd: "npm test" }] }, { ok: true }).detail, "• npm test", "a criterion with no description falls back to its command");
  const plan = d("plan_set", { steps: ["run the tests", "fix it"] }, { ok: true });
  assert.deepEqual([plan.text, plan.detail], ["Made a plan (2 steps)", "1. run the tests\n2. fix it"]);
  assert.equal(d("plan_set", { steps: ["a"], reason: "new facts" }, { ok: true }).text, "Changed the plan (1 step)");
  assert.deepEqual([d("step_update", { id: "s2", status: "done", evidence: "tests pass" }, { ok: true }).text, d("step_update", { id: "s2", status: "done", evidence: "tests pass" }, { ok: true }).detail], ["Step s2: done", "tests pass"]);
  assert.equal(d("hypothesis_add", { text: "the path has a typo" }, { ok: true }).text, "Suspects: the path has a typo");
  assert.equal(d("hypothesis_resolve", { id: "h1", status: "confirmed" }, { ok: true }).text, "Suspicion h1: confirmed");
  assert.equal(d("next_set", { text: "run the tests" }, { ok: true }).text, "Next: run the tests");
  const green = d("run_checks", {}, { ok: true, passed: true });
  assert.deepEqual([green.level, green.text], ["ok", "Ran the success checks: all pass"]);
  const red = d("run_checks", {}, { ok: true, passed: false, reason: "1 check failing" });
  assert.deepEqual([red.level, red.ok, red.text], ["fail", false, "Ran the success checks: 1 check failing"]);
  assert.equal(d("finish", { summary: "x" }, { ok: true }).text, "Finished: every check passed");
  const notYet = d("finish", { summary: "x" }, { ok: false, code: "not_verified", message: "NOT done", verification: "FAIL tests pass" });
  assert.deepEqual([notYet.level, notYet.ok, notYet.text, notYet.detail], ["refused", false, "Not finished yet: the checks do not all pass", "FAIL tests pass"]);
  assert.equal(d("ask_user", { question: "Which currency?" }, { ok: true }).text, "Asking you: Which currency?");
  assert.equal(d("give_up", { reason: "needs a key" }, { ok: true }).text, "Giving up: needs a key");
});

test("a call skipped because an earlier one in the round failed says so, and an unknown tool or odd arguments never throw", () => {
  const skipped = d("fs_edit", { path: "a" }, { ok: false, code: "not_executed", message: "Not run: an earlier call in this round failed." });
  assert.deepEqual([skipped.level, skipped.text], ["info", "Skipped fs edit"]);
  assert.equal(d("something_new", {}, { ok: true }).text, "something new");
  assert.doesNotThrow(() => d("fs_read", undefined, undefined));
  assert.doesNotThrow(() => d("fs_edit", { path: 5, find: null, replace: {} }, { ok: true }));
  assert.doesNotThrow(() => d("shell_run", null, { ok: false }));
  assert.doesNotThrow(() => d("plan_set", { steps: "not an array" }, { ok: true }));
  assert.doesNotThrow(() => d("criteria_add", { criteria: "not an array" }, { ok: true }));
  assert.doesNotThrow(() => d("criteria_add", { criteria: [null, 5, "x", {}] }, { ok: true }));
  assert.equal(d("criteria_add", { criteria: "not an array" }, { ok: true }).detail, "", "odd input shows no bullets rather than garbage");
});

test("phases are named in words a person would use", () => {
  assert.equal(phaseWords("understand"), "Looking around");
  assert.equal(phaseWords("recover"), "Working out what went wrong");
  assert.equal(phaseWords("act"), "Making changes");
  assert.equal(phaseWords("nonsense"), "Working");
});
