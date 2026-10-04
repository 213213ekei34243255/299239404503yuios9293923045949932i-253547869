// Noah/test/unit/autonomy-shell.test.cjs - the shell tool (Noah/autonomy/tools/shell.cjs), with REAL processes
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Workspace } = require("../../autonomy/tools/workspace.cjs");
const { ShellTool, cleanEnv, cleanOutput, elide } = require("../../autonomy/tools/shell.cjs");
const { MissionState } = require("../../autonomy/mission-state.cjs");

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-sh-")));
const root = path.join(base, "proj");
fs.mkdirSync(path.join(root, "sub"), { recursive: true });
const NODE = `"${process.execPath}"`;
const node = (file) => `${NODE} ${file}`;
const script = (name, body) => fs.writeFileSync(path.join(root, name), body);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const waitDead = async (pids, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (!pids.some(alive)) return true; await sleep(100); } return false; };
const spawned = [];
test.after(() => { for (const p of spawned) if (alive(p)) { try { process.kill(p, "SIGKILL"); } catch (_) { /* gone */ } } fs.rmSync(base, { recursive: true, force: true }); });

script("hello.js", `console.log("hello"); console.error("err-line");`);
script("fail.js", `require("fs").appendFileSync("runs.txt", "x"); console.log("about to fail"); process.exit(3);`);
script("count.js", `require("fs").appendFileSync("runs.txt", "x"); console.log("counted");`);
script("ansi.js", `process.stdout.write("\\x1b[31mred\\x1b[0m\\nprogress 10%\\rprogress 50%\\rprogress 100%\\ndone\\n");`);
script("big.js", `for (let i = 1; i <= 5000; i++) console.log("line " + i); console.log("THE END");`);
script("cwd.js", `console.log(process.cwd());`);
script("env.js", `console.log(JSON.stringify({ secret: typeof process.env.SECRET_TEST_KEY, ci: process.env.CI, noColor: process.env.NO_COLOR, hasPath: !!(process.env.PATH || process.env.Path) }));`);
script("stdin.js", `process.stdin.resume(); process.stdin.on("end", () => console.log("stdin-closed")); process.stdin.on("data", () => {});`);
script("sleep.js", `console.log("started"); setInterval(() => {}, 1000);`);
script("tree.js", `const { spawn } = require("child_process"); const g = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); require("fs").writeFileSync("pids.txt", process.pid + "," + g.pid); console.log("tree up"); setInterval(() => {}, 1000);`);
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "demo", scripts: { start: "node sleep.js" } }));
const runs = () => (fs.existsSync(path.join(root, "runs.txt")) ? fs.readFileSync(path.join(root, "runs.txt"), "utf8").length : 0);

function make({ mode = "autonomous", confirm, logDir } = {}) {
  const ws = new Workspace({ roots: [root] });
  const state = new MissionState({ objective: "test" });
  return { ws, state, shell: new ShellTool({ workspace: ws, state, confirm, getMode: () => mode, logDir }) };
}

test("a command's output (stdout and stderr) and exit code come back, and the run is recorded", async () => {
  const { shell, state } = make();
  const r = await shell.run({ cmd: node("hello.js") });
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /hello/);
  assert.match(r.output, /err-line/);
  assert.equal(r.cwd, ".");
  assert.ok(r.durationMs >= 0 && r.durationMs < 20000);
  assert.equal(state.commands.length, 1);
  assert.equal(state.commands[0].exitCode, 0);
  assert.equal(state.commands[0].kind, "run_script");
  assert.equal(state.sourceVersion, 1, "running a script may change files, so it counts as a change");
});

test("a failing command is a normal result with its exit code and output, not an exception", async () => {
  const { shell, state } = make();
  const r = await shell.run({ cmd: node("fail.js") });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.equal(r.code, "nonzero_exit");
  assert.match(r.output, /about to fail/);
  assert.equal(state.commands[0].exitCode, 3);
  assert.match(state.commands[0].tail, /about to fail/);
});

test("a program that does not exist is a failed command with the shell's message", async () => {
  const { shell } = make();
  const r = await shell.run({ cmd: "definitely-not-a-program-xyz" });
  assert.equal(r.ok, false);
  assert.notEqual(r.exitCode, 0);
  assert.ok(r.output.length > 0);
});

test("the working folder is honoured, and must be inside the workspace", async () => {
  const { shell, state } = make();
  const r = await shell.run({ cmd: `${NODE} ../cwd.js`, cwd: "sub" });
  assert.equal(r.ok, true);
  assert.equal(r.output.trim().toLowerCase(), path.join(root, "sub").toLowerCase());
  assert.equal(r.cwd, "sub");
  const out = await shell.run({ cmd: node("hello.js"), cwd: ".." });
  assert.equal(out.ok, false);
  assert.equal(out.code, "outside_workspace");
  const missing = await shell.run({ cmd: node("hello.js"), cwd: "nope" });
  assert.equal(missing.code, "invalid_path");
  const file = await shell.run({ cmd: node("hello.js"), cwd: "hello.js" });
  assert.equal(file.code, "invalid_path");
  assert.equal(state.commands.length, 1, "nothing ran for the refused folders");
});

test("colour codes are removed and a progress bar keeps only its last frame", async () => {
  const { shell } = make();
  const r = await shell.run({ cmd: node("ansi.js") });
  assert.match(r.output, /red/);
  assert.doesNotMatch(r.output, /\x1b/);
  assert.match(r.output, /progress 100%/);
  assert.doesNotMatch(r.output, /progress 10%|progress 50%/);
  assert.match(r.output, /done/);
});

test("a long output is shown as its start and its END, the cut is announced, and the whole thing is kept in a log file", async () => {
  const logDir = path.join(base, "logs");
  const { shell } = make({ logDir });
  const r = await shell.run({ cmd: node("big.js") });
  assert.equal(r.ok, true);
  assert.equal(r.elided, true);
  assert.ok(r.output.length < 14000, `shown ${r.output.length} chars`);
  assert.match(r.output, /line 1\n/);
  assert.match(r.output, /THE END/, "the end is what matters");
  assert.match(r.output, /\[\d+ lines \(\d+ characters\) not shown\]/);
  assert.ok(r.outputPath && fs.existsSync(r.outputPath));
  const whole = fs.readFileSync(r.outputPath, "utf8");
  assert.match(whole, /line 2500\n/);
  assert.match(whole, /THE END/);
  const noLog = await make().shell.run({ cmd: node("big.js") });
  assert.equal(noLog.outputPath, undefined);
});

test("the child gets a scrubbed environment: Jonah's own secrets never reach it", async () => {
  process.env.SECRET_TEST_KEY = "hunter2";
  try {
    const { shell } = make();
    const r = await shell.run({ cmd: node("env.js") });
    assert.deepEqual(JSON.parse(r.output.trim().split("\n").pop()), { secret: "undefined", ci: "1", noColor: "1", hasPath: true });
    const env = cleanEnv();
    assert.equal(Object.keys(env).some((k) => /secret_test_key|api_key|token/i.test(k)), false);
  } finally {
    delete process.env.SECRET_TEST_KEY;
  }
});

test("nothing can wait for input: stdin is closed", async () => {
  const { shell } = make();
  const t0 = Date.now();
  const r = await shell.run({ cmd: node("stdin.js"), timeoutMs: 15000 });
  assert.equal(r.ok, true);
  assert.match(r.output, /stdin-closed/);
  assert.ok(Date.now() - t0 < 12000);
});

test("a timeout stops the command AND everything it started", async () => {
  const { shell } = make();
  const t0 = Date.now();
  const r = await shell.run({ cmd: node("tree.js"), timeoutMs: 2500 });
  const pids = fs.readFileSync(path.join(root, "pids.txt"), "utf8").split(",").map(Number);
  spawned.push(...pids);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  assert.equal(r.code, "timeout");
  assert.match(r.output, /tree up/, "the output before the stop is kept");
  assert.ok(Date.now() - t0 < 9000, `took ${Date.now() - t0}ms`);
  assert.equal(pids.length, 2);
  assert.equal(await waitDead(pids), true, `a process of the tree is still alive: ${pids.filter(alive)}`);
});

test("an abort stops a running command", async () => {
  const { shell } = make();
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 1200);
  const t0 = Date.now();
  const r = await shell.run({ cmd: node("sleep.js"), timeoutMs: 60000 }, { signal: ctl.signal });
  assert.equal(r.code, "aborted");
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 10000);
  const early = new AbortController();
  early.abort();
  assert.equal((await shell.run({ cmd: node("hello.js") }, { signal: early.signal })).code, "aborted");
});

test("a server-like command is stopped early and the message says why", async () => {
  const { shell, state } = make();
  const r = await shell.run({ cmd: "npm start", timeoutMs: 4000 });
  assert.equal(r.timedOut, true);
  assert.match(r.message, /server or watcher/);
  assert.equal(state.commands[0].timedOut, true);
});

test("a blocked command is refused with a reason and nothing runs", async () => {
  const { shell, state } = make();
  for (const cmd of ["sudo echo hi", "cat .env", "powershell -enc AAAA"]) {
    const r = await shell.run({ cmd });
    assert.equal(r.ok, false, cmd);
    assert.equal(r.code, "blocked", cmd);
    assert.match(r.message, /will not run this/);
  }
  assert.equal(state.commands.length, 0);
});

test("a high-risk command asks first; a refusal means it does not run, in any way", async () => {
  const marker = path.join(root, "marker.txt");
  const risky = `${NODE} -e "require('fs').writeFileSync('marker.txt','x');/*execSync*/"`;
  const asked = [];
  let answer = false;
  const { shell, state } = make({ confirm: async (req) => { asked.push(req); return answer; } });
  if (fs.existsSync(marker)) fs.unlinkSync(marker);

  let r = await shell.run({ cmd: risky });
  assert.equal(r.code, "user_denied");
  assert.equal(fs.existsSync(marker), false, "declined: it must not have run");
  assert.equal(asked.length, 1);
  assert.match(asked[0].summary, /writeFileSync/);
  assert.equal(asked[0].risk.level, "high");
  assert.equal(state.commands.length, 0);

  answer = true;
  r = await shell.run({ cmd: risky });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(marker), true, "approved: it ran");
  assert.equal(asked.length, 2);
  fs.unlinkSync(marker);

  // a confirmation that throws is a refusal, and so is having no way to ask at all
  const thrower = make({ confirm: async () => { throw new Error("card failed"); } });
  assert.equal((await thrower.shell.run({ cmd: risky })).code, "user_denied");
  assert.equal((await make().shell.run({ cmd: risky })).code, "user_denied");
  assert.equal(fs.existsSync(marker), false);
});

test("the user's mode decides what asks: supervised asks for a script, autonomous does not", async () => {
  let asks = 0;
  const confirm = async () => { asks++; return false; };
  const auto = make({ mode: "autonomous", confirm });
  assert.equal((await auto.shell.run({ cmd: node("hello.js") })).ok, true);
  assert.equal(asks, 0);
  const sup = make({ mode: "supervised", confirm });
  assert.equal((await sup.shell.run({ cmd: node("hello.js") })).code, "user_denied");
  assert.equal(asks, 1);
  assert.equal((await sup.shell.run({ cmd: `${NODE} -v` })).ok, true, "reading never asks");
  assert.equal(asks, 1);
});

test("the same failed command is not run again until something changes (and retry:true allows one more)", async () => {
  const { shell, state } = make();
  const before = runs();
  const first = await shell.run({ cmd: node("fail.js") });
  assert.equal(first.exitCode, 3);
  assert.equal(runs(), before + 1);

  const again = await shell.run({ cmd: node("fail.js") });
  assert.equal(again.code, "repeat_blocked");
  assert.match(again.message, /already ran this exact command \(exit 3\)/);
  assert.equal(again.previous.exitCode, 3);
  assert.equal(runs(), before + 1, "it was NOT run again");
  assert.equal(state.commands.length, 1, "a refused repeat is not a run");

  state.recordFileChange({ path: "fix.js", op: "edit" }); // something changed: trying again is reasonable
  assert.equal((await shell.run({ cmd: node("fail.js") })).exitCode, 3);
  assert.equal(runs(), before + 2);

  assert.equal((await shell.run({ cmd: node("fail.js") })).code, "repeat_blocked");
  assert.equal((await shell.run({ cmd: node("fail.js"), retry: true })).exitCode, 3, "one retry for a failure that looked temporary");
  assert.equal(runs(), before + 3);
  assert.equal((await shell.run({ cmd: node("fail.js"), retry: true })).code, "repeat_blocked", "but only one");
  assert.equal(runs(), before + 3);
});

test("a command that succeeds can be repeated freely", async () => {
  const { shell } = make();
  const before = runs();
  assert.equal((await shell.run({ cmd: node("count.js") })).ok, true);
  assert.equal((await shell.run({ cmd: node("count.js") })).ok, true);
  assert.equal(runs(), before + 2);
});

test("the verifier's runner re-runs checks (no repeat gate) and turns refusals into failed checks", async () => {
  const { shell } = make();
  const run = shell.runner();
  const before = runs();
  const a = await run(node("fail.js"), {});
  const b = await run(node("fail.js"), {});
  assert.deepEqual([a.exitCode, b.exitCode, a.timedOut], [3, 3, false]);
  assert.match(a.output, /about to fail/);
  assert.equal(runs(), before + 2);
  const refused = await run("sudo echo hi", {});
  assert.equal(refused.exitCode, null);
  assert.match(refused.output, /will not run this/);
  assert.equal((await run(node("hello.js"), { cwd: "../outside" })).exitCode, null);
});

test("a failed command comes back DIAGNOSED, and the failure is counted by signature in the mission state", async () => {
  script("missing.js", `require("./nope-xyz");`);
  const { shell, state } = make();
  const r = await shell.run({ cmd: node("missing.js") });
  assert.equal(r.ok, false);
  assert.equal(r.diagnosis.kind, "missing_module");
  assert.equal(r.diagnosis.file, "missing.js");
  assert.equal(r.diagnosis.occurrences, 1);
  assert.match(r.diagnosis.summary, /cannot find the file "\.\/nope-xyz"/);
  assert.match(r.diagnosis.hint, /Check the spelling/);
  assert.equal(state.errors["missing_module:./nope-xyz"].count, 1);
  assert.match(state.commands[0].diagnosis, /nope-xyz/);
  assert.match(state.render(), /\$ .*missing\.js -> exit 1 \| cannot find the file/, "the briefing shows the diagnosis, not a raw output line");

  state.recordFileChange({ path: "unrelated.js" }); // something changed, so trying again is allowed: and it fails the same way
  const again = await shell.run({ cmd: node("missing.js") });
  assert.equal(again.diagnosis.occurrences, 2);
  assert.deepEqual(state.repeatedErrors(2).map(([sig]) => sig), ["missing_module:./nope-xyz"]);
  assert.match(state.render(), /## Failures that keep happening[\s\S]*x2 \[missing_module\]/);

  const blocked = await shell.run({ cmd: node("missing.js") });
  assert.equal(blocked.code, "repeat_blocked");
  assert.match(blocked.previous.diagnosis, /nope-xyz/, "the refusal reminds the model what the failure was");
  assert.equal(blocked.diagnosis, undefined, "a refused repeat is not a new failure");
  assert.equal(state.errors["missing_module:./nope-xyz"].count, 2);
});

test("a success has no diagnosis, a timeout is diagnosed as a timeout, and an abort is not a failure to diagnose", async () => {
  const { shell, state } = make();
  const good = await shell.run({ cmd: node("hello.js") });
  assert.equal(good.diagnosis, undefined);
  assert.deepEqual(state.errors, {});
  const slow = await shell.run({ cmd: node("sleep.js"), timeoutMs: 1500 });
  assert.equal(slow.diagnosis.kind, "timeout");
  assert.match(slow.diagnosis.hint, /Do not run it again unchanged/);
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 800);
  const stopped = await shell.run({ cmd: `${NODE} sleep.js --again`, timeoutMs: 60000 }, { signal: ctl.signal });
  assert.equal(stopped.code, "aborted");
  assert.equal(stopped.diagnosis, undefined);
});

test("cleanOutput and elide", () => {
  assert.equal(cleanOutput("\x1b[1;32mok\x1b[0m"), "ok");
  assert.equal(cleanOutput("a\rb\rc\nd"), "c\nd");
  assert.equal(cleanOutput("line\r\nnext"), "line\nnext");
  assert.equal(elide("short").elided, false);
  const long = Array.from({ length: 3000 }, (_, i) => `row ${i}`).join("\n");
  const e = elide(long);
  assert.equal(e.elided, true);
  assert.match(e.text, /row 0\n/);
  assert.match(e.text, /row 2999$/);
  assert.match(e.text, /\[\d+ lines/);
});
