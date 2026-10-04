// Noah/test/unit/mission-state.test.cjs - the structured mission state (Noah/autonomy/mission-state.cjs)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { MissionState, normalizeCriterion, LIMITS } = require("../../autonomy/mission-state.cjs");

const clock = () => { let t = 1000; return () => (t += 10); };
const make = (objective = "Set up the project and make the tests pass") => new MissionState({ objective, now: clock() });

test("success criteria are validated, all-or-nothing, and keep their ids", () => {
  const s = make();
  const ids = s.addCriteria([{ kind: "command", cmd: " npm test " }, { kind: "file_exists", path: "src\\index.js" }]);
  assert.deepEqual(ids, ["c1", "c2"]);
  assert.equal(s.criteria[0].cmd, "npm test");
  assert.equal(s.criteria[0].expectExit, 0);
  assert.equal(s.criteria[0].timeoutMs, 120000);
  assert.equal(s.criteria[1].path, "src/index.js", "paths are stored with forward slashes");
  // one bad entry stores NOTHING
  assert.throws(() => s.addCriteria([{ kind: "command", cmd: "ok" }, { kind: "command" }]), /needs `cmd`/);
  assert.equal(s.criteria.length, 2);
  assert.deepEqual(s.addCriteria({ kind: "claim", description: "report the final answer" }), ["c3"], "ids carry on after a failed batch");
});

test("each criterion kind rejects what it cannot check", () => {
  assert.throws(() => normalizeCriterion({ kind: "telepathy" }, "c1"), /unknown criterion kind/);
  assert.throws(() => normalizeCriterion(null, "c1"), /must be an object/);
  assert.throws(() => normalizeCriterion({ kind: "file_exists" }, "c1"), /needs `path`/);
  assert.throws(() => normalizeCriterion({ kind: "file_contains", path: "a" }, "c1"), /`text` or `pattern`/);
  assert.throws(() => normalizeCriterion({ kind: "file_contains", path: "a", pattern: "(" }, "c1"), /not a valid regular expression/);
  assert.throws(() => normalizeCriterion({ kind: "claim" }, "c1"), /needs a `description`/);
  assert.equal(normalizeCriterion({ kind: "command", cmd: "x", timeoutMs: 99_999_999 }, "c1").timeoutMs, 600_000, "timeouts are capped");
  assert.equal(normalizeCriterion({ kind: "command", cmd: "x", expectExit: 2 }, "c1").expectExit, 2);
  assert.equal(normalizeCriterion({ kind: "command", cmd: "x", required: false }, "c1").required, false);
  const s = make();
  assert.throws(() => s.addCriteria(Array.from({ length: LIMITS.criteria + 1 }, () => ({ kind: "file_exists", path: "a" }))), /at most/);
  assert.throws(() => s.addCriteria([]), /no success criteria/);
});

test("revising the plan keeps what already happened", () => {
  const s = make();
  s.setPlan(["Read the README", "Install dependencies", "Run the tests"]);
  const [a, b, c] = s.steps;
  s.startStep(a.id);
  s.completeStep(a.id, "README says: npm install, npm test");
  s.startStep(b.id);
  // replan: same wording (any case/spacing) keeps status and evidence; a new step appears; "Run the tests" is dropped
  s.setPlan(["read the  README", "Install dependencies", "Fix the broken import", "Re-run the build"], "install failed: missing module");
  assert.deepEqual(s.steps.map((x) => [x.text, x.status]), [["Read the README", "done"], ["Install dependencies", "active"], ["Fix the broken import", "pending"], ["Re-run the build", "pending"]]);
  assert.equal(s.steps[0].evidence, "README says: npm install, npm test");
  assert.equal(s.steps[0].id, a.id);
  assert.equal(s.counters.replans, 1);
  assert.deepEqual(s.planRevisions[0].dropped, [c.text]);
  assert.equal(s.planRevisions[0].added, 2);
  assert.match(s.planRevisions[0].reason, /missing module/);
  // a finished step the new plan leaves out stays as history instead of vanishing
  s.setPlan(["Fix the broken import"]);
  assert.deepEqual(s.steps.map((x) => x.text), ["Read the README", "Fix the broken import"]);
  assert.equal(s.steps[0].status, "done");
  assert.throws(() => s.setPlan([]), /at least one step/);
  assert.throws(() => s.setPlan(["", "  "]), /at least one step/);
});

test("steps: one active at a time, done is final, blocked records why", () => {
  const s = make();
  s.setPlan(["one", "two", "three"]);
  s.startStep("s1");
  s.startStep("s2");
  assert.deepEqual(s.steps.map((x) => x.status), ["pending", "active", "pending"]);
  assert.equal(s.activeStep().id, "s2");
  s.completeStep("s2", "done it");
  assert.equal(s.activeStep(), null);
  assert.throws(() => s.startStep("s2"), /already done/);
  assert.throws(() => s.blockStep("s2", "x"), /already done/);
  assert.throws(() => s.startStep("s99"), /unknown step/);
  s.blockStep("s3", "needs an API key");
  assert.equal(s.steps[2].status, "blocked");
  assert.match(s.render(), /\[!\] s3 three \(blocked: needs an API key\)/);
  assert.equal(s.completeStep("s2", "again").evidence, "done it", "completing twice changes nothing");
});

test("sourceVersion moves only when the work product may have changed", () => {
  const s = make();
  assert.equal(s.sourceVersion, 0);
  s.recordCommand({ cmd: "npm test", exitCode: 0 }); // verifying does not change the work
  s.recordCommand({ cmd: "git status", exitCode: 0 });
  assert.equal(s.sourceVersion, 0);
  s.recordCommand({ cmd: "npm install", exitCode: 0, mutates: true });
  assert.equal(s.sourceVersion, 1);
  assert.equal(s.counters.fileChanges, 0, "a command is not one of Noah's own file edits");
  s.recordFileChange({ path: "src\\app.js", op: "edit" });
  assert.equal(s.sourceVersion, 2);
  assert.equal(s.counters.fileChanges, 1);
  assert.deepEqual(Object.keys(s.files), ["src/app.js"]);
  assert.throws(() => s.recordFileChange({ path: "" }), /needs a path/);
});

test("a check goes stale when the work changes, a claim does not", () => {
  const s = make();
  s.addCriteria([{ kind: "command", cmd: "npm test" }, { kind: "claim", description: "report the result" }]);
  s.recordVerification("c1", { passed: true, evidence: "exit 0" });
  s.recordVerification("c2", { passed: true, evidence: "I read the page: price is 61,999", asserted: true });
  assert.ok(s.isFresh("c1") && s.isFresh("c2"));
  s.recordFileChange({ path: "a.js" });
  assert.equal(s.isFresh("c1"), false);
  assert.equal(s.isFresh("c2"), true);
  assert.equal(s.isFresh("c-none"), false);
  assert.throws(() => s.recordVerification("c9", { passed: true }), /unknown criterion/);
});

test("repeatOf: the same failed command with nothing changed is a repeat; any change, success or other folder is not", () => {
  const s = make();
  assert.equal(s.repeatOf("npm test"), null, "never ran");
  s.recordCommand({ cmd: "npm test", cwd: "C:\\proj", exitCode: 1, tail: "1 failing" });
  assert.equal(s.repeatOf("npm test", "C:/proj").exitCode, 1);
  assert.equal(s.repeatOf("  NPM   test ", "C:/proj").exitCode, 1, "wording-insensitive");
  assert.equal(s.repeatOf("npm test", "C:/other"), null, "another folder is another command");
  s.recordFileChange({ path: "fix.js" });
  assert.equal(s.repeatOf("npm test", "C:/proj"), null, "the work changed: worth trying again");
  s.recordCommand({ cmd: "npm test", cwd: "C:/proj", exitCode: 1 });
  assert.ok(s.repeatOf("npm test", "C:/proj"));
  s.recordCommand({ cmd: "npm test", cwd: "C:/proj", exitCode: 0 });
  assert.equal(s.repeatOf("npm test", "C:/proj"), null, "the latest run passed");
  // timeouts count as failures
  s.recordCommand({ cmd: "npm run dev", exitCode: null, timedOut: true });
  assert.ok(s.repeatOf("npm run dev"));
});

test("repeatOf: a failing command that itself changes files is still blocked right after, and freed by a later change", () => {
  const s = make();
  s.recordCommand({ cmd: "npm install", exitCode: 1, mutates: true });
  assert.ok(s.repeatOf("npm install"), "retrying a failed install unchanged must not loop forever");
  s.recordFileChange({ path: "package.json", op: "edit" });
  assert.equal(s.repeatOf("npm install"), null);
});

test("errors are counted by signature; meeting a new error is progress, meeting the same one again is not", () => {
  const s = make();
  s.tick();
  assert.equal(s.recordError({ signature: "MODULE_NOT_FOUND:left-pad", kind: "missing_module", message: "Cannot find module 'left-pad'", hint: "npm install left-pad" }), 1);
  assert.equal(s.stalledFor(), 0);
  s.tick();
  s.tick();
  assert.equal(s.stalledFor(), 2);
  assert.equal(s.recordError({ signature: "MODULE_NOT_FOUND:left-pad" }), 2);
  assert.equal(s.stalledFor(), 2, "the same error again is not movement");
  s.recordError({ signature: "SYNTAX:app.js:3", kind: "syntax" });
  assert.equal(s.stalledFor(), 0, "a different error means the first one was passed");
  assert.equal(s.recordError({ signature: "" }), 0);
  const rep = s.repeatedErrors(2);
  assert.equal(rep.length, 1);
  assert.equal(rep[0][0], "MODULE_NOT_FOUND:left-pad");
  assert.equal(rep[0][1].hint, "npm install left-pad");
});

test("the error table is bounded and keeps the newest and the most repeated", () => {
  const s = make();
  for (let i = 0; i < 5; i++) s.recordError({ signature: "chronic" });
  for (let i = 0; i < LIMITS.errors + 10; i++) s.recordError({ signature: `one-off-${i}` });
  assert.ok(Object.keys(s.errors).length <= LIMITS.errors);
  assert.ok(s.errors.chronic && s.errors.chronic.count === 5, "the most repeated failure survives");
  assert.ok(s.errors[`one-off-${LIMITS.errors + 9}`], "the newest survives");
});

test("hypotheses: no duplicates, a rejected one proposed again is flagged, and settling one is progress once", () => {
  const s = make();
  s.tick();
  const h = s.addHypothesis("Node version is too old for this package");
  assert.deepEqual(h, { id: "h1", status: "open", existing: false });
  assert.deepEqual(s.addHypothesis("node version is too OLD for this package"), { id: "h1", status: "open", existing: true });
  s.tick();
  s.tick();
  s.resolveHypothesis("h1", "rejected", "node -v prints 20.11, package needs >=18");
  assert.equal(s.stalledFor(), 0);
  assert.deepEqual(s.addHypothesis("Node version is too old for this package"), { id: "h1", status: "rejected", existing: true });
  s.tick();
  s.resolveHypothesis("h1", "rejected", "again");
  assert.equal(s.stalledFor(), 1, "settling an already-settled one is not progress");
  assert.deepEqual(s.openHypotheses(), []);
  assert.throws(() => s.resolveHypothesis("h1", "maybe"), /confirmed.*rejected/);
  assert.throws(() => s.resolveHypothesis("h42", "confirmed"), /unknown hypothesis/);
  assert.throws(() => s.addHypothesis("  "), /needs text/);
});

test("looking at something NEW, replanning and forming a hypothesis are progress; looking again is not", () => {
  const s = make();
  s.tick(); s.tick(); s.tick();
  assert.equal(s.stalledFor(), 3);
  assert.equal(s.noteExplored("fs_read:src/a.js"), true);
  assert.equal(s.stalledFor(), 0);
  s.tick(); s.tick();
  assert.equal(s.noteExplored("fs_read:src/a.js"), false, "the same file again is not movement");
  assert.equal(s.stalledFor(), 2);
  assert.equal(s.noteExplored(""), false);
  s.setPlan(["one", "two"]);
  assert.equal(s.stalledFor(), 0, "a plan is movement");
  s.tick();
  s.addHypothesis("the cause is in the parser");
  assert.equal(s.stalledFor(), 0, "a new hypothesis is movement");
  s.tick(); s.tick();
  s.addHypothesis("The cause is in the parser");
  assert.equal(s.stalledFor(), 2, "the same hypothesis again is not");
  for (let i = 0; i < 600; i++) s.noteExplored(`k${i}`);
  assert.equal(s.explored.length, 500, "bounded");
  assert.deepEqual(MissionState.restore(s.snapshot()).explored, s.explored, "and it survives a restore");
});

test("what was tried and what was seen are recorded and bounded", () => {
  const s = make();
  assert.throws(() => s.recordTried({ what: "x", outcome: "great" }), /outcome/);
  for (let i = 0; i < 50; i++) { s.recordTried({ what: `try ${i}`, outcome: "failed" }); s.recordObservation({ tool: "fs.read", summary: `saw ${i}` }); }
  assert.equal(s.tried.length, LIMITS.tried);
  assert.equal(s.observations.length, LIMITS.observations);
  assert.equal(s.tried.at(-1).what, "try 49");
});

test("render shows the verification marks that tell the model what is really green", () => {
  const s = make();
  s.addCriteria([{ kind: "command", cmd: "npm test" }, { kind: "file_exists", path: "dist/app.js" }, { kind: "claim", description: "report the cheapest price" }, { kind: "command", cmd: "npm run lint", required: false }]);
  const marks = () => Object.fromEntries(s.render().split("\n").filter((l) => /^\[.\] c\d/.test(l)).map((l) => [l.slice(4, 6), l.slice(0, 3)]));
  assert.deepEqual(marks(), { c1: "[ ]", c2: "[ ]", c3: "[ ]", c4: "[ ]" });
  s.recordVerification("c1", { passed: true });
  s.recordVerification("c2", { passed: false });
  s.recordVerification("c3", { passed: true, asserted: true, evidence: "read it off the page" });
  assert.deepEqual(marks(), { c1: "[x]", c2: "[!]", c3: "[~]", c4: "[ ]" });
  s.recordFileChange({ path: "x.js" });
  assert.deepEqual(marks(), { c1: "[?]", c2: "[?]", c3: "[~]", c4: "[ ]" });
  assert.match(s.render(), /c4 .* \(optional\)/);
});

test("a command's diagnosis, when it has one, replaces the raw output line in the briefing", () => {
  const s = make();
  s.recordCommand({ cmd: "npm test", exitCode: 1, tail: "noise line one\nnoise line two", diagnosis: "2 tests failing: adds, deep - 2 !== 3" });
  s.recordCommand({ cmd: "npm run lint", exitCode: 1, tail: "3 problems" });
  const out = s.render();
  assert.match(out, /\$ npm test -> exit 1 \| 2 tests failing: adds, deep - 2 !== 3/);
  assert.doesNotMatch(out, /noise line two/);
  assert.match(out, /\$ npm run lint -> exit 1 \| 3 problems/, "without a diagnosis the last output line is shown, as before");
});

test("render with no criteria says so instead of hiding the gap", () => {
  const out = make().render();
  assert.match(out, /## Done when\n\(nothing yet/);
  assert.match(out, /## Mission\nSet up the project/);
});

test("render stays inside its budget after a very long mission, and still carries what must never be lost", () => {
  const s = make("Fix the failing build");
  s.addCriteria([{ kind: "command", cmd: "npm test", description: "the full test suite passes" }, { kind: "file_exists", path: "dist/index.js" }]);
  s.setPlan(Array.from({ length: 25 }, (_, i) => `step number ${i} with a reasonably long description of what to do`));
  s.completeStep("s1", "ok");
  s.completeStep("s2", "ok");
  s.startStep("s3");
  s.setNext("Open src/parser.js and fix the off-by-one at line 41");
  s.addHypothesis("The parser drops the last token when the input ends without a newline");
  for (let i = 0; i < 120; i++) s.recordCommand({ cmd: `node scripts/step-${i}.js --flag value --another-flag value`, cwd: "C:/proj", exitCode: i % 3 ? 0 : 1, tail: `line one\nresult ${i} ${"x".repeat(200)}`, mutates: i % 5 === 0 });
  for (let i = 0; i < 400; i++) s.recordFileChange({ path: `src/generated/file-${i}.js`, op: "write" });
  for (let i = 0; i < 60; i++) { s.recordTried({ what: `attempt ${i}: ${"y".repeat(150)}`, outcome: "failed", note: "z".repeat(100) }); s.recordError({ signature: `sig-${i}`, message: "m".repeat(300), hint: "h".repeat(150) }); s.recordError({ signature: `sig-${i}` }); }
  for (const max of [6000, 3000, 1500]) {
    const out = s.render({ maxChars: max });
    assert.ok(out.length <= max, `render(${max}) was ${out.length} chars`);
    assert.match(out, /## Mission\nFix the failing build/);
    assert.match(out, /\[ \] c1 the full test suite passes/);
    assert.match(out, /## Next\nOpen src\/parser\.js and fix the off-by-one/);
    assert.match(out, /## Open hypotheses\nh1: The parser drops the last token/);
    assert.match(out, /\(2 steps done\)/);
    assert.match(out, /\[>\] s3 /);
  }
  const full = s.render({ maxChars: 6000 });
  assert.match(full, /\(\+\d+ more\)/, "a long plan is shown as its next steps plus a count");
  assert.match(full, /step-119\.js/, "the newest command is kept");
  assert.doesNotMatch(full, /step-0\.js/, "the oldest is what gets cut");
});

test("when the must-keep sections alone overflow, they are shortened, never dropped", () => {
  const s = make("O".repeat(900));
  s.addCriteria(Array.from({ length: 12 }, (_, i) => ({ kind: "claim", description: `criterion ${i}: ${"d".repeat(180)}` })));
  s.setPlan(Array.from({ length: 25 }, (_, i) => `step ${i} ${"p".repeat(150)}`));
  s.startStep("s1");
  s.setNext("N".repeat(500));
  for (let i = 0; i < 8; i++) s.addHypothesis(`hypothesis ${i} ${"h".repeat(200)}`);
  for (let i = 0; i < 10; i++) s.recordCommand({ cmd: `cmd ${i}`, exitCode: 1 });
  const normal = s.render({ maxChars: 100_000 });
  assert.ok(normal.length > 4000, "the fixture really is big");
  const out = s.render({ maxChars: 2500 });
  assert.ok(out.length <= 2500, `was ${out.length}`);
  assert.match(out, /## Mission\nO{100}/);
  assert.match(out, /\[ \] c1 criterion 0/);
  assert.match(out, /\[ \] c12 criterion 11/, "every criterion is still listed");
  assert.match(out, /## Plan[\s\S]*\[>\] s1 /);
  assert.match(out, /## Next\nN{50}/, "what to do next survives");
  assert.match(out, /## Open hypotheses\nh1: hypothesis 0/);
  assert.doesNotMatch(out, /## Recent commands/, "the optional sections went first");
  // and the absurdly small budget still obeys the limit (last resort)
  assert.ok(s.render({ maxChars: 150 }).length <= 150);
});

test("the least important sections are cut first, and the cut is announced", () => {
  const s = make("obj");
  for (let i = 0; i < 30; i++) { s.recordCommand({ cmd: `cmd ${i} ${"p".repeat(60)}`, exitCode: 0 }); s.recordTried({ what: `idea ${i} ${"q".repeat(100)}` }); }
  const roomy = s.render({ maxChars: 6000 });
  assert.match(roomy, /## Already tried/);
  const tight = s.render({ maxChars: 600 });
  assert.ok(tight.length <= 600);
  assert.match(tight, /## Mission\nobj/);
  assert.doesNotMatch(tight, /## Already tried[\s\S]*idea 0 /, "oldest 'tried' entries go first");
  assert.match(roomy, /\(\+\d+ earlier not shown\)/);
});

test("snapshot is plain JSON, a deep copy, and restores into a state that carries on exactly where it stopped", () => {
  const s = make();
  s.addCriteria([{ kind: "command", cmd: "npm test" }]);
  s.setPlan(["a", "b"]);
  s.startStep("s1");
  s.recordCommand({ cmd: "npm test", exitCode: 1, tail: "boom" });
  s.recordFileChange({ path: "f.js" });
  s.recordVerification("c1", { passed: false, evidence: "exit 1" });
  s.addHypothesis("something");
  s.recordError({ signature: "e1", message: "bad" });
  s.setNext("do the next thing");
  const snap = s.snapshot();
  assert.ok(!("_now" in snap), "no function in the snapshot");
  const json = JSON.parse(JSON.stringify(snap));
  assert.deepEqual(json, snap, "survives JSON unchanged");
  snap.steps[0].text = "tampered";
  assert.equal(s.steps[0].text, "a", "the snapshot is a copy");

  const back = MissionState.restore(json, { now: clock() });
  assert.equal(back.id, s.id);
  assert.equal(back.sourceVersion, 1);
  assert.equal(back.isFresh("c1"), s.isFresh("c1"));
  assert.equal(back.render(), s.render());
  assert.equal(back.repeatOf("npm test"), null, "the file change since keeps the version logic intact after restore");
  // ids continue, no collisions
  assert.deepEqual(back.addCriteria({ kind: "file_exists", path: "x" }), ["c2"]);
  assert.equal(back.addHypothesis("another").id, "h2");
  back.setPlan(["a", "b", "c"]);
  assert.equal(back.steps.at(-1).id, "s3");
  assert.equal(MissionState.restore(null).objective, "");
});

test("the clock can be injected (so persisted timestamps are testable)", () => {
  const s = new MissionState({ objective: "x", now: () => 4242 });
  s.recordFileChange({ path: "a" });
  assert.equal(s.files.a.at, 4242);
  assert.equal(s.createdAt, 4242);
});
