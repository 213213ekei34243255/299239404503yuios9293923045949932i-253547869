// Noah/test/unit/goal-verifier.test.cjs - goal-level verification (Noah/autonomy/goal-verifier.cjs)
// The runner and the file system are FAKES here (this file tests the verification logic, not process spawning: the real
// workspace-scoped tools are tested with real processes in their own file).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { MissionState } = require("../../autonomy/mission-state.cjs");
const { GoalVerifier } = require("../../autonomy/goal-verifier.cjs");
const { Lifecycle } = require("../../autonomy/lifecycle.cjs");

function env({ commands = {}, files = {} } = {}) {
  const state = new MissionState({ objective: "make it work" });
  const calls = [];
  let running = 0;
  let maxRunning = 0;
  const fake = {
    commands,
    files,
    run: async (cmd, opts) => {
      calls.push({ cmd, ...opts });
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setImmediate(r));
      running--;
      const r = fake.commands[cmd];
      if (r instanceof Error) throw r;
      return r || { exitCode: 0, output: "" };
    },
    exists: async (p) => p in fake.files,
    readFile: async (p) => {
      if (!(p in fake.files)) throw new Error(`ENOENT: ${p}`);
      return fake.files[p];
    },
  };
  const verifier = new GoalVerifier({ state, run: fake.run, exists: fake.exists, readFile: fake.readFile });
  return { state, verifier, fake, calls, maxRunning: () => maxRunning };
}
const only = (e, spec) => { e.state.addCriteria(spec); return e.state.criteria.at(-1); };

test("no criteria means the mission cannot succeed, and says why", () => {
  const e = env();
  assert.equal(e.verifier.status().passed, false);
  assert.equal(e.verifier.status().reason, "no_criteria");
  assert.match(e.verifier.canSucceed(), /no success criteria/);
});

test("a command criterion passes on the expected exit code and records the tail of the output as evidence", async () => {
  const e = env({ commands: { "npm test": { exitCode: 0, output: "lots of output\n...\n12 passing" } } });
  const c = only(e, { kind: "command", cmd: "npm test", cwd: "C:/proj", timeoutMs: 5000 });
  const r = await e.verifier.check(c);
  assert.equal(r.passed, true);
  assert.match(r.evidence, /exit 0.*12 passing/s);
  assert.deepEqual(e.calls, [{ cmd: "npm test", cwd: "C:/proj", timeoutMs: 5000 }]);
  assert.equal(e.verifier.status().passed, true);
  assert.equal(e.verifier.canSucceed(), true);
});

test("a command criterion fails on the wrong exit code, a timeout, or the wrong output", async () => {
  const e = env({
    commands: {
      "npm test": { exitCode: 1, output: "x".repeat(2000) + "\n2 failing: parser handles empty input" },
      "node a.js": { exitCode: 0, output: "started" },
      "node b.js": { exitCode: 0, output: "Warning: deprecated" },
      "npm start": { exitCode: 0, output: "ok", timedOut: true },
    },
  });
  const t = await e.verifier.check(only(e, { kind: "command", cmd: "npm test" }));
  assert.equal(t.passed, false);
  assert.match(t.evidence, /exit 1, expected 0/);
  assert.match(t.evidence, /2 failing: parser handles empty input/, "the END of the output is what is kept: that is where the reason is");
  assert.ok(t.evidence.length < 700);
  assert.equal((await e.verifier.check(only(e, { kind: "command", cmd: "node a.js", outputIncludes: "listening on" }))).passed, false);
  assert.equal((await e.verifier.check(only(e, { kind: "command", cmd: "node a.js", outputIncludes: "started" }))).passed, true);
  assert.equal((await e.verifier.check(only(e, { kind: "command", cmd: "node b.js", outputExcludes: "Warning" }))).passed, false);
  const to = await e.verifier.check(only(e, { kind: "command", cmd: "npm start" }));
  assert.equal(to.passed, false, "a timeout is a failure even if the exit code looks fine");
  assert.match(to.evidence, /timed out/);
});

test("a command that is EXPECTED to fail can be a criterion (expectExit)", async () => {
  const e = env({ commands: { "node bad.js": { exitCode: 1, output: "SyntaxError" } } });
  assert.equal((await e.verifier.check(only(e, { kind: "command", cmd: "node bad.js", expectExit: 1 }))).passed, true);
});

test("a runner that blows up is a FAILED check, never a crash", async () => {
  const e = env({ commands: { "boom": new Error("spawn EACCES") } });
  const c = only(e, { kind: "command", cmd: "boom" });
  const r = await e.verifier.check(c);
  assert.equal(r.passed, false);
  assert.match(r.evidence, /the check could not run: spawn EACCES/);
  assert.equal(e.state.verificationFor(c.id).passed, false);
});

test("file criteria: exists, absent, contains (text and pattern), and unreadable", async () => {
  const e = env({ files: { "src/app.js": "export function main() {}\n// TODO later", "big.txt": "a".repeat(1_000_000) + "NEEDLE" } });
  const ok = async (spec) => (await e.verifier.check(only(e, spec))).passed;
  assert.equal(await ok({ kind: "file_exists", path: "src/app.js" }), true);
  assert.equal(await ok({ kind: "file_exists", path: "src/missing.js" }), false);
  assert.equal(await ok({ kind: "file_absent", path: "src/missing.js" }), true);
  assert.equal(await ok({ kind: "file_absent", path: "src/app.js" }), false);
  assert.equal(await ok({ kind: "file_contains", path: "src/app.js", text: "export function main" }), true);
  assert.equal(await ok({ kind: "file_contains", path: "src/app.js", text: "nope" }), false);
  assert.equal(await ok({ kind: "file_contains", path: "src/app.js", pattern: "^// TODO" }), true, "patterns match per line");
  assert.equal(await ok({ kind: "file_contains", path: "src/app.js", pattern: "function\\s+other" }), false);
  const unreadable = await e.verifier.check(only(e, { kind: "file_contains", path: "gone.txt", text: "x" }));
  assert.equal(unreadable.passed, false);
  assert.match(unreadable.evidence, /could not read gone\.txt/);
  assert.equal(await ok({ kind: "file_contains", path: "big.txt", text: "NEEDLE" }), false, "only the first megabyte is searched");
});

test("a pass goes stale when a file changes, and runAll re-runs exactly the stale checks", async () => {
  const e = env({ commands: { "npm test": { exitCode: 0, output: "ok" }, "npm run lint": { exitCode: 0, output: "clean" } } });
  e.state.addCriteria([{ kind: "command", cmd: "npm test" }, { kind: "command", cmd: "npm run lint" }]);
  assert.deepEqual((await e.verifier.runAll()).ran, ["c1", "c2"]);
  assert.equal(e.verifier.status().passed, true);
  assert.deepEqual((await e.verifier.runAll()).ran, [], "nothing changed: nothing is re-run");

  e.state.recordFileChange({ path: "src/app.js", op: "edit" });
  const s = e.verifier.status();
  assert.equal(s.passed, false);
  assert.equal(s.reason, "stale");
  assert.deepEqual(s.stale, ["c1", "c2"]);
  assert.match(e.verifier.canSucceed(), /changed after these were checked.*c1, c2/);

  e.calls.length = 0;
  const r = await e.verifier.runAll();
  assert.deepEqual(r.ran, ["c1", "c2"]);
  assert.equal(r.passed, true);
  assert.equal(e.calls.length, 2);
});

test("running the tests does not make the tests stale; a command that can change files does", async () => {
  const e = env();
  e.state.addCriteria([{ kind: "command", cmd: "npm test" }]);
  await e.verifier.runAll();
  e.state.recordCommand({ cmd: "npm test", exitCode: 0 }); // a verifying command: mutates false
  assert.equal(e.verifier.status().passed, true);
  e.state.recordCommand({ cmd: "npm run codegen", exitCode: 0, mutates: true });
  assert.equal(e.verifier.status().reason, "stale");
});

test("a change that lands WHILE a check runs makes that result stale (the version is read before running)", async () => {
  const e = env();
  e.fake.commands["slow"] = { exitCode: 0, output: "fine" };
  const realRun = e.fake.run;
  e.verifier.run = async (cmd, opts) => {
    const r = await realRun(cmd, opts);
    e.state.recordFileChange({ path: "changed-during-the-check.js" });
    return r;
  };
  const c = only(e, { kind: "command", cmd: "slow" });
  await e.verifier.check(c);
  assert.equal(e.state.verificationFor(c.id).passed, true);
  assert.equal(e.state.isFresh(c.id), false);
  assert.equal(e.verifier.status().reason, "stale");
});

test("a failing check that is still current is not re-run on its own; force re-runs everything", async () => {
  const e = env({ commands: { "npm test": { exitCode: 1, output: "1 failing" } } });
  e.state.addCriteria([{ kind: "command", cmd: "npm test" }]);
  await e.verifier.runAll();
  assert.equal(e.verifier.status().reason, "failing");
  assert.deepEqual(e.verifier.status().failing.map((f) => f.id), ["c1"]);
  assert.match(e.verifier.status().failing[0].evidence, /1 failing/);
  assert.match(e.verifier.canSucceed(), /still failing: c1/);
  assert.deepEqual((await e.verifier.runAll()).ran, [], "running the same failing check again changes nothing");
  assert.deepEqual((await e.verifier.runAll({ force: true })).ran, ["c1"]);
  e.fake.commands["npm test"] = { exitCode: 0, output: "all good" };
  e.state.recordFileChange({ path: "the-fix.js", op: "edit" });
  assert.equal((await e.verifier.runAll()).passed, true);
});

test("checks run one after another, in order", async () => {
  const e = env();
  e.state.addCriteria([{ kind: "command", cmd: "a" }, { kind: "command", cmd: "b" }, { kind: "command", cmd: "c" }]);
  await e.verifier.runAll();
  assert.deepEqual(e.calls.map((c) => c.cmd), ["a", "b", "c"]);
  assert.equal(e.maxRunning(), 1);
});

test("claims need concrete evidence, cannot be used for machine checks, never go stale, and are reported as asserted", async () => {
  const e = env();
  e.state.addCriteria([{ kind: "claim", description: "report the cheapest laptop" }, { kind: "file_exists", path: "report.md" }]);
  assert.throws(() => e.verifier.assertClaim("c1", "done"), /concrete evidence/);
  assert.throws(() => e.verifier.assertClaim("c1", ""), /concrete evidence/);
  assert.throws(() => e.verifier.assertClaim("c2", "I made the file already"), /machine-checked/);
  assert.throws(() => e.verifier.assertClaim("c9", "something long enough here"), /unknown criterion/);
  e.verifier.assertClaim("c1", "the shop page lists the 16GB model at 61,999");
  e.fake.files["report.md"] = "x";
  await e.verifier.runAll();
  assert.equal(e.verifier.status().passed, true);
  assert.deepEqual(e.verifier.status().unverifiedClaims, ["c1"]);
  e.state.recordFileChange({ path: "unrelated.js" });
  assert.equal(e.state.isFresh("c1"), true, "a claim does not go stale");
  assert.equal(e.state.isFresh("c2"), false);
  assert.equal((await e.verifier.check(e.state.criteria[0])).passed, false, "check() never turns a claim green");
  assert.match(e.verifier.summaryText(), /ASSERTED .*report the cheapest laptop.*not machine-checked/);
});

test("optional criteria never block success, but at least one required criterion must exist", async () => {
  const e = env({ commands: { "npm run lint": { exitCode: 1, output: "style" } } });
  e.state.addCriteria([{ kind: "command", cmd: "npm run lint", required: false }]);
  await e.verifier.runAll();
  assert.equal(e.verifier.status().reason, "no_required_criteria");
  assert.equal(e.verifier.status().passed, false);
  e.state.addCriteria([{ kind: "file_exists", path: "a" }]);
  e.fake.files.a = "";
  await e.verifier.runAll();
  assert.equal(e.verifier.status().passed, true, "a failing optional check does not block");
  assert.match(e.verifier.summaryText(), /FAIL .*npm run lint/);
});

test("summaryText gives the honest account: PASS, FAIL, STALE, NOT RUN", async () => {
  const e = env({ commands: { "npm test": { exitCode: 1, output: "1 failing" } } });
  e.state.addCriteria([{ kind: "command", cmd: "npm test" }, { kind: "file_exists", path: "a" }, { kind: "file_exists", path: "b" }]);
  e.fake.files.a = "";
  await e.verifier.check(e.state.criteria[0]);
  await e.verifier.check(e.state.criteria[1]);
  e.state.recordFileChange({ path: "z" });
  const lines = e.verifier.summaryText().split("\n");
  assert.match(lines[0], /^STALE /);
  assert.match(lines[1], /^STALE /);
  assert.match(lines[2], /^NOT RUN /);
  await e.verifier.runAll();
  const after = e.verifier.summaryText().split("\n");
  assert.match(after[0], /^FAIL .*1 failing/);
  assert.match(after[1], /^PASS .*a exists/);
  assert.match(after[2], /^FAIL .*b does not exist/);
});

test("end to end with the lifecycle: success is refused until every check is green AND current", async () => {
  const e = env({ commands: { "npm test": { exitCode: 1, output: "1 failing" } } });
  e.state.addCriteria([{ kind: "command", cmd: "npm test" }]);
  const lc = new Lifecycle({ canPlan: () => (e.state.criteria.length ? true : "no criteria"), canSucceed: () => e.verifier.canSucceed() });
  for (const p of ["plan", "act", "observe", "reason", "verify"]) lc.to(p);

  assert.throws(() => lc.finish("succeeded"), /not checked yet: c1/);
  await e.verifier.runAll();
  assert.throws(() => lc.finish("succeeded"), /still failing: c1/);

  e.fake.commands["npm test"] = { exitCode: 0, output: "all passing" };
  e.state.recordFileChange({ path: "src/fix.js", op: "edit" });
  await e.verifier.runAll();
  assert.equal(e.verifier.status().passed, true);

  e.state.recordFileChange({ path: "src/oops.js", op: "edit" }); // one more edit AFTER the green run
  assert.throws(() => lc.finish("succeeded"), /changed after these were checked/);
  await e.verifier.runAll();
  assert.equal(lc.finish("succeeded", "tests pass").kind, "succeeded");
});
