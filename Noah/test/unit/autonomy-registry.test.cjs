// Noah/test/unit/autonomy-registry.test.cjs - the tool registry (Noah/autonomy/tools/registry.cjs), and a whole small mission on a real
// broken project: REAL processes and files, a SCRIPTED sequence of tool calls standing in for the model (this proves the machinery
// - tools, policy, state, verifier, lifecycle - not that any model can drive it)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Workspace } = require("../../autonomy/tools/workspace.cjs");
const { ToolRegistry, validateArgs, DEFS } = require("../../autonomy/tools/registry.cjs");
const { MissionState } = require("../../autonomy/mission-state.cjs");
const { GoalVerifier } = require("../../autonomy/goal-verifier.cjs");
const { Lifecycle } = require("../../autonomy/lifecycle.cjs");
const { sanitizeSchema } = require("../../models/google.cjs");

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-reg-")));
const root = path.join(base, "proj");
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const P = (...a) => path.join(root, ...a);
const put = (rel, content) => { fs.mkdirSync(path.dirname(P(rel)), { recursive: true }); fs.writeFileSync(P(rel), content); };
const NODE_TEST = `"${process.execPath}" --test`;

function broken() {
  fs.rmSync(root, { recursive: true, force: true });
  put("package.json", JSON.stringify({ name: "demo", version: "1.0.0" }));
  put("src/index.js", "const { add } = require('./util');\nmodule.exports = { add };\n");
  put("src/utils.js", "exports.add = (a, b) => a + b;\n");
  put("test/index.test.js", 'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../src/index.js");\ntest("adds", () => assert.equal(add(2, 3), 5));\n');
}
function make(opts = {}) {
  const ws = new Workspace({ roots: [root] });
  const state = new MissionState({ objective: "Fix the failing test in this project and prove it passes." });
  const reg = new ToolRegistry({ workspace: ws, state, getMode: () => opts.mode || "autonomous", confirm: opts.confirm, logDir: path.join(base, "logs") });
  return { ws, state, reg };
}

test("the tool definitions are valid function-calling schemas that a provider will accept as they are", () => {
  broken();
  const { reg } = make();
  const schemas = reg.schemas();
  assert.deepEqual(schemas.map((s) => s.name).sort(), ["blender_run", "blender_verify_export", "creative_inventory", "dependency_install", "ffmpeg_run", "fs_delete", "fs_edit", "fs_list", "fs_read", "fs_search", "fs_write", "media_probe", "python_run", "resolve_run", "shell_run"]);
  for (const s of schemas) {
    assert.match(s.name, /^[a-zA-Z0-9_]+$/, "no dots: not every provider allows them");
    assert.ok(s.description.length > 20);
    assert.equal(s.parameters.type, "object");
    assert.ok(Object.keys(s.parameters.properties).length >= 1);
    for (const [k, v] of Object.entries(s.parameters.properties)) assert.ok(["string", "integer", "boolean"].includes(v.type) && v.description, `${s.name}.${k}`);
    for (const r of s.parameters.required) assert.ok(r in s.parameters.properties);
    assert.deepEqual(sanitizeSchema(s.parameters), s.parameters, `${s.name}: Gemini's schema sanitiser would change it`);
  }
  assert.deepEqual(schemas.find((s) => s.name === "fs_edit").parameters.required, ["path", "find", "replace"]);
  assert.deepEqual(schemas.find((s) => s.name === "shell_run").parameters.required, ["cmd"]);
  assert.deepEqual(schemas.find((s) => s.name === "fs_list").parameters.required, []);
});

test("arguments are checked strictly, and the correction names the valid ones", () => {
  const v = (name, args) => validateArgs(name, DEFS[name], args);
  const bad = v("fs_read", { filepath: "a.js" });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /unknown argument "filepath" \(valid: path, offset, limit\)/);
  assert.match(v("fs_read", {}).message, /"path" is required/);
  assert.match(v("fs_read", { path: 5 }).message, /"path" must be text/);
  assert.match(v("fs_read", { path: "a", offset: 1.5 }).message, /whole number/);
  assert.match(v("fs_write", { path: "a", content: "x", overwrite: "maybe" }).message, /true or false/);
  assert.match(v("shell_run", { command: "ls" }).message, /unknown argument "command" \(valid: cmd, cwd, timeoutMs, retry\)/);
  assert.match(v("fs_read", []).message, /must be an object/);
  // numbers and booleans sent as text are accepted: that is a harmless slip, not a mistake worth a round trip
  assert.deepEqual(v("fs_read", { path: "a.js", offset: "10", limit: " 5 " }).args, { path: "a.js", offset: 10, limit: 5 });
  assert.deepEqual(v("fs_write", { path: "a", content: "", overwrite: "TRUE" }).args, { path: "a", content: "", overwrite: true });
  assert.deepEqual(v("fs_list", null).args, {});
  assert.deepEqual(v("fs_list", { path: null }).args, {}, "null means 'not given'");
  assert.equal(v("fs_read", { path: "" }).ok, false, "an empty path is not a path");
  assert.equal(v("fs_write", { path: "a", content: "" }).ok, true, "empty content is a valid file");
});

test("lists and fixed choices are validated too, and a list sent as JSON text is accepted", () => {
  const { P } = require("../../autonomy/tools/registry.cjs");
  const def = { params: { steps: P.strings("s", true), mode: P.oneOf("m", ["a", "b"]), items: P.objects("i", { x: { type: "string", description: "x" } }) } };
  const v = (args) => validateArgs("t", def, args);
  assert.deepEqual(v({ steps: ["a", "b"], mode: "a", items: [{ x: "1" }] }).args, { steps: ["a", "b"], mode: "a", items: [{ x: "1" }] });
  assert.deepEqual(v({ steps: '["a","b"]' }).args, { steps: ["a", "b"] });
  assert.match(v({ steps: "just text" }).message, /"steps" must be a list of text items/);
  assert.match(v({ steps: ["a", 2] }).message, /item 2 of "steps" must be text/);
  assert.match(v({ steps: ["a"], mode: "c" }).message, /"mode" must be one of: a, b/);
  assert.match(v({ steps: ["a"], items: ["x"] }).message, /item 1 of "items" must be an object/);
  assert.match(v({ steps: Array.from({ length: 51 }, () => "x") }).message, /too many items/);
});

test("isMutating tells a change from a look, using the command policy for shell commands", async () => {
  broken();
  const { reg } = make();
  for (const [name, args, expected] of [
    ["fs_read", { path: "a" }, false], ["fs_list", {}, false], ["fs_search", { pattern: "x" }, false],
    ["fs_write", { path: "a", content: "" }, true], ["fs_edit", { path: "a", find: "x", replace: "y" }, true], ["fs_delete", { path: "a" }, true],
    ["shell_run", { cmd: NODE_TEST }, false], ["shell_run", { cmd: "git status" }, false], ["shell_run", { cmd: "ls -la" }, false],
    ["shell_run", { cmd: "npm install" }, true], ["shell_run", { cmd: "git commit -m x" }, true], ["shell_run", { cmd: "node scripts/x.js" }, true],
    ["shell_run", { cmd: "ls", cwd: "../elsewhere" }, true], ["shell_run", { cmd: "sudo ls" }, true], ["shell_run", { cmd: "" }, true],
  ]) assert.equal(reg.isMutating(name, args), expected, `${name} ${JSON.stringify(args)}`);
});

test("execute: a bad call is a normal failed result that says what to do; an unknown tool lists the valid ones", async () => {
  broken();
  const { reg } = make();
  const r = await reg.execute("fs_read", { filepath: "src/index.js" });
  assert.deepEqual([r.ok, r.code], [false, "invalid_arguments"]);
  const u = await reg.execute("read_file", { path: "x" });
  assert.equal(u.code, "unknown_tool");
  assert.match(u.message, /fs_read/);
  const ok = await reg.execute("fs_read", { path: "src/index.js" });
  assert.equal(ok.ok, true);
});

test("every call leaves a one-line observation in the mission state", async () => {
  broken();
  const { reg, state } = make();
  await reg.execute("fs_read", { path: "src/index.js" });
  await reg.execute("fs_list", {});
  await reg.execute("fs_search", { pattern: "add" });
  await reg.execute("fs_read", { path: ".env" });
  await reg.execute("shell_run", { cmd: `"${process.execPath}" -v` });
  const notes = state.observations.map((o) => o.summary);
  assert.match(notes[0], /^fs_read src\/index\.js \(lines 1-2 of 2\)$/);
  assert.match(notes[1], /^fs_list \. \(\d+ entries\)$/);
  assert.match(notes[2], /^fs_search \/add\/ -> \d+ matches$/);
  assert.equal(notes[3], "fs_read .env failed: protected_path");
  assert.match(notes[4], /^shell_run .* -> exit 0$/);
});

test("the verifier's file and command access is the same workspace-scoped access, and a refused path FAILS the check", async () => {
  broken();
  const { reg, state } = make();
  const env = reg.verifierEnv();
  assert.equal(await env.exists("src/index.js"), true);
  assert.equal(await env.exists("src/nope.js"), false);
  assert.match(await env.readFile("src/utils.js"), /exports\.add/);
  await assert.rejects(() => env.exists("../outside.txt"), /outside the folders/);
  await assert.rejects(() => env.readFile(".env"), /secret/);
  const v = new GoalVerifier({ state, ...env });
  state.addCriteria([{ kind: "file_absent", path: "../outside/never.txt" }, { kind: "file_contains", path: ".env", text: "x" }, { kind: "command", cmd: "sudo echo hi" }]);
  await v.runAll();
  const s = v.status();
  assert.equal(s.passed, false);
  assert.deepEqual(s.failing.map((f) => f.id), ["c1", "c2", "c3"], "a path or command the policy refuses is a failed check, never a quiet pass");
  assert.match(s.failing[0].evidence, /could not run/);
  assert.match(s.failing[2].evidence, /will not run this/);
});

test("a whole small mission: fix a real failing test, with every guard in the way", async () => {
  broken();
  const { reg, state } = make();
  state.addCriteria([{ kind: "command", cmd: NODE_TEST, description: "the project's tests pass" }]);
  const verifier = new GoalVerifier({ state, ...reg.verifierEnv() });
  const lc = new Lifecycle({ canPlan: () => (state.criteria.length ? true : "no criteria"), canSucceed: () => verifier.canSucceed() });
  state.setPlan(["Run the tests", "Find out why they fail", "Fix it", "Run the tests again"]);
  const call = (name, args) => reg.execute(name, args);

  // understand -> plan -> act: the first run fails, and the failure names the cause
  lc.to("plan");
  lc.to("act");
  const first = await call("shell_run", { cmd: NODE_TEST });
  assert.equal(first.ok, false);
  assert.equal(first.exitCode, 1);
  assert.match(first.output, /Cannot find module '\.\/util'/);
  assert.equal(first.diagnosis.kind, "missing_module", "the cause is named, not left for the model to dig out of the test runner's output");
  assert.equal(first.diagnosis.file, "src/index.js");
  assert.match(first.diagnosis.hint, /\.\/util vs \.\/utils/);
  assert.equal(state.sourceVersion, 0, "running the tests changed nothing");
  lc.to("observe");
  lc.to("reason");

  // the model's reflex: run it again. The gate says no and why
  const again = await call("shell_run", { cmd: NODE_TEST });
  assert.equal(again.code, "repeat_blocked");
  assert.equal(state.commands.length, 1);

  // inspect, then change the right thing
  lc.to("inspect");
  const read = await call("fs_read", { path: "src/index.js" });
  assert.match(read.content, /require\('\.\/util'\)/);
  const search = await call("fs_search", { pattern: "exports\\.add" });
  assert.match(search.matches, /src\/utils\.js:1/);
  lc.to("observe");
  lc.to("reason");
  lc.to("act");
  const edit = await call("fs_edit", { path: "src/index.js", find: "'./util'", replace: "'./utils'" });
  assert.equal(edit.ok, true);
  assert.equal(state.sourceVersion, 1);
  const second = await call("shell_run", { cmd: NODE_TEST });
  assert.equal(second.ok, true, second.output);
  assert.equal(state.sourceVersion, 1, "a passing test run is not a change either");

  // verification: success is refused until the CHECKS (not the model's own run) are green and current
  lc.to("observe");
  lc.to("reason");
  lc.to("verify");
  assert.throws(() => lc.finish("succeeded"), /not checked yet: c1/);
  const r1 = await verifier.runAll();
  assert.equal(r1.passed, true);

  // one more edit after the green run makes the result stale: it has to be checked again
  lc.to("reason");
  lc.to("act");
  state.completeStep("s1", "ran the tests: 1 failing");
  await call("fs_read", { path: "src/index.js" });
  assert.equal((await call("fs_edit", { path: "src/index.js", find: "module.exports", replace: "// the add function\nmodule.exports" })).ok, true);
  lc.to("observe");
  lc.to("reason");
  lc.to("verify");
  assert.throws(() => lc.finish("succeeded"), /changed after these were checked/);
  assert.equal((await verifier.runAll()).passed, true);
  const end = lc.finish("succeeded", "all checks pass");
  assert.equal(end.kind, "succeeded");

  // the account of what happened
  const brief = state.render();
  assert.match(brief, /\[x\] c1 the project's tests pass/);
  assert.match(brief, /src\/index\.js \(edit x2\)/);
  assert.match(verifier.summaryText(), /^PASS {6}the project's tests pass: exit 0/);
  assert.equal(get("src/index.js"), "const { add } = require('./utils');\n// the add function\nmodule.exports = { add };\n");
  assert.ok(state.observations.length >= 7);
});

function get(rel) { return fs.readFileSync(P(rel), "utf8"); }

test("the same mission under supervised mode asks before each change, and a refusal changes nothing", async () => {
  broken();
  const asked = [];
  const { reg, state } = make({ mode: "supervised", confirm: async (r) => { asked.push(r.summary); return false; } });
  await reg.execute("fs_read", { path: "src/index.js" });
  const e = await reg.execute("fs_edit", { path: "src/index.js", find: "'./util'", replace: "'./utils'" });
  assert.equal(e.code, "user_denied");
  assert.equal(get("src/index.js"), "const { add } = require('./util');\nmodule.exports = { add };\n");
  assert.equal(state.sourceVersion, 0);
  const sh = await reg.execute("shell_run", { cmd: NODE_TEST });
  assert.equal(sh.exitCode, 1, "running the tests (verifying) never asks");
  assert.deepEqual(asked, ["Edit src/index.js"]);
});
