// Noah/test/unit/autonomy-diagnoser.test.cjs - failure diagnosis (Noah/autonomy/diagnoser.cjs)
// RECORDED samples: real output of node, python, git, npm and the shell, captured on this machine (fixtures/diagnoser-samples.json).
// DOCUMENTED samples: hand-written from each tool's documented format, for tools that are not installed here. They are labelled, because
// they prove the parser follows the documentation, not that it matches a particular version's output.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { diagnose, shortPath, stable } = require("../../autonomy/diagnoser.cjs");
const fixture = require("./fixtures/diagnoser-samples.json");

const CWD = "C:\\proj";
const sample = (name) => {
  const s = fixture.samples.find((x) => x.name === name);
  assert.ok(s, `no recorded sample named ${name}`);
  return s;
};
const dx = (name, cwd = CWD) => {
  const s = sample(name);
  return diagnose({ cmd: s.cmd, exitCode: s.exitCode, output: s.output, cwd });
};

test("RECORDED: a successful command has nothing to diagnose", () => {
  const s = sample("success-control");
  assert.equal(diagnose({ cmd: s.cmd, exitCode: s.exitCode, output: s.output }), null);
});

test("RECORDED: a missing local file names the file that asked for it and says what to check", () => {
  const d = dx("node-missing-module");
  assert.equal(d.kind, "missing_module");
  assert.equal(d.signature, "missing_module:./nope");
  assert.equal(d.file, "a.js");
  assert.deepEqual(d.detail, { module: "./nope", local: true });
  assert.match(d.summary, /cannot find the file "\.\/nope" \(required from a\.js\)/);
  assert.match(d.hint, /singular\/plural slip such as \.\/util vs \.\/utils/);
});

test("RECORDED: a missing package (ESM) is a missing package, with the install hint", () => {
  const d = dx("node-esm-missing-package");
  assert.equal(d.kind, "missing_module");
  assert.deepEqual(d.detail, { module: "nope-pkg", local: false });
  assert.equal(d.file, "f.mjs");
  assert.match(d.hint, /npm install nope-pkg/);
  assert.match(d.hint, /typo/);
});

test("RECORDED: syntax errors give file and line, and warn that the cause is usually on an EARLIER line", () => {
  const d = dx("node-syntax-error");
  assert.deepEqual([d.kind, d.file, d.line, d.signature], ["syntax_error", "b.js", 3, "syntax_error:b.js:3"]);
  assert.match(d.hint, /lines just BEFORE it/);
  const py = dx("python-syntax-error");
  assert.deepEqual([py.kind, py.file, py.line], ["syntax_error", "py_syntax.py", 1]);
});

test("RECORDED: reference and type errors point at the user's own line, not at node internals", () => {
  const r = dx("node-reference-error");
  assert.deepEqual([r.kind, r.file, r.line, r.signature], ["reference_error", "c.js", 2, "reference_error:missingVar"]);
  assert.match(r.hint, /Search the project for "missingVar"/);
  const t = dx("node-type-error");
  assert.deepEqual([t.kind, t.file, t.line], ["type_error", "d.js", 2]);
  assert.match(t.summary, /Cannot read properties of undefined \(reading 'bar'\)/);
  assert.match(t.hint, /what produces that value/);
  const py = dx("python-name-error");
  assert.deepEqual([py.kind, py.file, py.line, py.detail.name], ["reference_error", "py_name.py", 2, "missing_var"]);
});

test("RECORDED: bad JSON is told apart from a syntax error in the code", () => {
  const d = dx("node-json-parse");
  assert.equal(d.kind, "json_parse");
  assert.match(d.hint, /not valid JSON/);
});

test("RECORDED: a busy port, with the port number", () => {
  const d = dx("node-port-in-use");
  assert.equal(d.kind, "port_in_use");
  assert.ok(Number.isInteger(d.detail.port) && d.detail.port > 0);
  assert.equal(d.signature, `port_in_use:${d.detail.port}`);
  assert.equal(d.file, "g.js");
  assert.match(d.hint, /earlier run of this same server/);
});

test("RECORDED: file-system errors say which path, and what to check", () => {
  const nf = dx("node-file-not-found");
  assert.deepEqual([nf.kind, nf.detail.path, nf.file], ["file_not_found", "missing.txt", "h.js"]);
  assert.match(nf.hint, /cwd/);
  const dir = dx("node-is-directory");
  assert.equal(dir.kind, "is_directory");
});

test("RECORDED: an uncaught error is a runtime error at the user's own line (also through an npm script)", () => {
  for (const [name, file] of [["node-plain-throw", "k.js"], ["node-unhandled-rejection", "j.js"], ["npm-run-fails", "k.js"]]) {
    const d = dx(name);
    assert.equal(d.kind, "runtime_error", name);
    assert.deepEqual([d.file, d.line], [file, 1], name);
  }
});

test("RECORDED: failing node:test tests: which ones, the assertion, and where", () => {
  const d = dx("node-test-failures");
  assert.equal(d.kind, "test_failure");
  assert.deepEqual(d.detail.tests, ["adds", "deep"]);
  assert.equal(d.signature, "test_failure:adds|deep");
  assert.equal(d.file, "test/t.test.js");
  assert.equal(d.line, 3);
  assert.match(d.summary, /2 tests failing: adds, deep/);
  assert.match(d.summary, /Expected values to be strictly equal: 2 !== 3/);
  assert.match(d.hint, /do not edit a test just to make it pass/);
});

test("RECORDED: python exceptions and failing unittest", () => {
  const imp = dx("python-import-error");
  assert.deepEqual([imp.kind, imp.detail.module, imp.detail.python, imp.file, imp.line], ["missing_module", "nope_mod", true, "py_import.py", 1]);
  const z = dx("python-zero-division");
  assert.equal(z.kind, "python_exception");
  assert.deepEqual([z.file, z.line, z.detail.exception], ["py_zero.py", 1, "ZeroDivisionError"]);
  const u = dx("python-unittest-failure");
  assert.equal(u.kind, "test_failure");
  assert.deepEqual(u.detail.tests, ["test_add"]);
  assert.match(u.summary, /AssertionError: 2 != 3/);
});

test("RECORDED: shell, git and npm failures", () => {
  const c = dx("shell-command-not-found");
  assert.deepEqual([c.kind, c.detail.program], ["command_not_found", "definitely-not-a-program-xyz"]);
  assert.match(c.hint, /npx|npm run/);
  assert.equal(dx("git-not-a-repository").kind, "not_a_git_repo");
  const m = dx("npm-missing-script");
  assert.deepEqual([m.kind, m.signature], ["missing_script", "missing_script:nope"]);
  assert.match(m.hint, /scripts/);
});

test("RECORDED: every recorded failure gets a real diagnosis (no empty fields, no leaked user names)", () => {
  const failing = fixture.samples.filter((s) => s.exitCode !== 0);
  assert.ok(failing.length >= 20, `only ${failing.length} recorded failures`);
  for (const s of failing) {
    const d = diagnose({ cmd: s.cmd, exitCode: s.exitCode, output: s.output, cwd: CWD });
    assert.ok(d && d.kind && d.summary && d.hint && d.signature, s.name);
    assert.notEqual(d.kind, "unknown_failure", `${s.name} should be recognised`);
    assert.ok(d.signature.length <= 160, s.name);
    assert.doesNotMatch(JSON.stringify(s), /SHARON|SHAUN/i, `${s.name}: a real user name is in the fixture`);
  }
});

test("RECORDED (npm, if captured): a real peer-dependency conflict, a missing package and a missing package.json", { skip: !fixture.samples.some((s) => s.name === "npm-install-peer-conflict") && "npm samples not captured" }, () => {
  const c = dx("npm-install-peer-conflict");
  assert.equal(c.kind, "dependency_conflict");
  assert.match(c.summary, /react-dom@17\.0\.2 needs react@17\.0\.2 but react@18\.2\.0 is installed/);
  assert.match(c.hint, /update react-dom/);
  assert.match(c.hint, /--legacy-peer-deps/);
  assert.match(c.hint, /changes nothing/);
  assert.equal(c.signature, "dependency_conflict:react");
  assert.equal(dx("npm-install-no-package-json").kind, "no_package_json");
  const u = dx("npm-install-unknown-package");
  assert.ok(["package_not_found", "network"].includes(u.kind), `got ${u.kind}`);
});

// --------------------------------------------------------------------------------------------------------------- DOCUMENTED formats

test("DOCUMENTED: jest, pytest, mocha, go test and cargo test", () => {
  const jest = diagnose({ exitCode: 1, cwd: "/p", output: "FAIL src/add.test.js\n  ● add › adds numbers\n\n    expect(received).toBe(expected)\n\n    Expected: 3\n    Received: 2\n\n      at Object.<anonymous> (src/add.test.js:4:21)\n\nTests:       1 failed, 2 passed, 3 total\n" });
  assert.equal(jest.kind, "test_failure");
  assert.deepEqual(jest.detail.tests, ["add › adds numbers"]);
  const summaryOnly = diagnose({ exitCode: 1, output: "Test Suites: 1 failed, 1 total\nTests:       2 failed, 1 passed, 3 total\nSnapshots:   0 total\n" });
  assert.equal(summaryOnly.kind, "test_failure", "the summary line alone is enough (some reporters print no per-test blocks)");
  const blocksOnly = diagnose({ exitCode: 1, output: "  ● add › adds numbers\n\n    expect(received).toBe(expected)\n\n    Expected: 3\n    Received: 2\n" });
  assert.deepEqual([blocksOnly.kind, blocksOnly.detail.tests], ["test_failure", ["add › adds numbers"]], "and so are the per-test blocks alone (cut-off output)");
  const pytest = diagnose({ exitCode: 1, output: "=========================== short test summary info ============================\nFAILED tests/test_add.py::test_add - assert 2 == 3\n========================= 1 failed, 2 passed in 0.12s ==========================\n" });
  assert.deepEqual([pytest.kind, pytest.detail.tests], ["test_failure", ["tests/test_add.py::test_add"]]);
  const mocha = diagnose({ exitCode: 1, output: "  2 passing (8ms)\n  1 failing\n\n  1) add\n       adds numbers:\n     AssertionError: expected 2 to equal 3\n" });
  assert.deepEqual([mocha.kind, mocha.detail.tests], ["test_failure", ["add"]]);
  const go = diagnose({ exitCode: 1, output: "--- FAIL: TestAdd (0.00s)\n    add_test.go:9: got 2, want 3\nFAIL\nFAIL\texample.com/m\t0.002s\n" });
  assert.deepEqual([go.kind, go.detail.tests], ["test_failure", ["TestAdd"]]);
  const cargo = diagnose({ exitCode: 101, output: "running 2 tests\ntest tests::adds ... FAILED\ntest tests::ok ... ok\n\nfailures:\n\n---- tests::adds stdout ----\nthread 'tests::adds' panicked at 'assertion failed'\n" });
  assert.deepEqual([cargo.kind, cargo.detail.tests], ["test_failure", ["tests::adds"]]);
});

test("DOCUMENTED: TypeScript and C-style compiler errors name the first one", () => {
  const ts = diagnose({ exitCode: 2, cwd: "/p", output: "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts(9,1): error TS2304: Cannot find name 'x'.\n\nFound 2 errors.\n" });
  assert.deepEqual([ts.kind, ts.file, ts.line, ts.column, ts.detail.count, ts.detail.code], ["type_check_error", "src/a.ts", 3, 5, 2, "TS2322"]);
  assert.match(ts.hint, /FIRST error first/);
  const gcc = diagnose({ exitCode: 1, output: "main.c:7:5: error: expected ';' before 'return'\n" });
  assert.deepEqual([gcc.kind, gcc.file, gcc.line], ["compile_error", "main.c", 7]);
});

test("DOCUMENTED: npm network and registry errors", () => {
  const net = diagnose({ exitCode: 1, output: "npm error code ENOTFOUND\nnpm error syscall getaddrinfo\nnpm error errno ENOTFOUND\nnpm error network request to https://registry.npmjs.org/left-pad failed\n" });
  assert.equal(net.kind, "network");
  assert.match(net.hint, /Nothing in the code needs fixing/);
  const nf = diagnose({ exitCode: 1, output: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/leftpad-xyz - Not found\nnpm error 404  'leftpad-xyz@^1.0.0' is not in this registry.\n" });
  assert.deepEqual([nf.kind, nf.detail.package], ["package_not_found", "leftpad-xyz"]);
  const old = diagnose({ exitCode: 1, output: "npm ERR! code ERESOLVE\nnpm ERR! Found: react@18.2.0\nnpm ERR! peer react@\"^17.0.0\" from old-widget@2.0.1\n" });
  assert.equal(old.kind, "dependency_conflict", "the older `npm ERR!` prefix is understood too");
  const perm = diagnose({ exitCode: 1, output: "npm error code EACCES\nnpm error syscall mkdir\n" });
  assert.equal(perm.kind, "permission");
});

test("DOCUMENTED: git conflicts and clean trees", () => {
  assert.equal(diagnose({ exitCode: 1, output: "Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.\n" }).kind, "merge_conflict");
  assert.equal(diagnose({ exitCode: 1, output: "On branch main\nnothing to commit, working tree clean\n" }).kind, "nothing_to_commit");
});

// --------------------------------------------------------------------------------------------------------------- properties

test("a timeout is a timeout whatever the output says, and its signature is stable per command", () => {
  const a = diagnose({ cmd: "npm start", exitCode: null, timedOut: true, output: "Error: listen EADDRINUSE :::3000" });
  assert.equal(a.kind, "timeout");
  assert.equal(a.signature, diagnose({ cmd: "npm start", exitCode: null, timedOut: true, output: "" }).signature);
  assert.notEqual(a.signature, diagnose({ cmd: "npm test", exitCode: null, timedOut: true, output: "" }).signature);
  assert.match(a.hint, /Do not run it again unchanged/);
});

test("the SAME failure keeps the same signature when only timings, slashes or paths differ", () => {
  const out = (ms, p) => `✖ adds (${ms}ms)\nℹ tests 1\nℹ fail 1\n\n✖ failing tests:\n\ntest at ${p}:3:1\n✖ adds (${ms}ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n  \n  2 !== 3\n`;
  const a = diagnose({ exitCode: 1, output: out("7.69", "test\\t.test.js"), cwd: "C:\\proj" });
  const b = diagnose({ exitCode: 1, output: out("12.01", "test/t.test.js"), cwd: "C:/proj" });
  assert.equal(a.signature, b.signature);
  const s1 = diagnose({ exitCode: 1, output: "C:\\proj\\b.js:3\n  return 2;\n         ^\n\nSyntaxError: Unexpected number\n", cwd: "C:\\proj" });
  const s2 = diagnose({ exitCode: 1, output: "/home/u/proj/b.js:3\n  return 2;\n         ^\n\nSyntaxError: Unexpected number\n", cwd: "/home/u/proj" });
  assert.equal(s1.signature, s2.signature);
  assert.notEqual(diagnose({ exitCode: 1, output: out("1", "t.js").split("adds").join("other") }).signature, a.signature, "a different failing test is a different failure");
});

test("DOCUMENTED: a stack that starts inside a dependency points at the user's own first frame", () => {
  const d = diagnose({ exitCode: 1, cwd: "C:\\proj", output: "ReferenceError: foo is not defined\n    at helper (C:\\proj\\node_modules\\lib\\index.js:10:5)\n    at Object.<anonymous> (C:\\proj\\src\\app.js:7:3)\n    at Module._compile (node:internal/modules/cjs/loader:1830:14)\n" });
  assert.deepEqual([d.kind, d.file, d.line], ["reference_error", "src/app.js", 7]);
});

test("a failing-test signature does not depend on the order the tests are listed in", () => {
  const out = (a, b) => `ℹ fail 2\n\n✖ failing tests:\n\ntest at t.js:1:1\n✖ ${a} (1ms)\n  AssertionError [ERR_ASSERTION]: boom\n\ntest at t.js:5:1\n✖ ${b} (2ms)\n  AssertionError [ERR_ASSERTION]: boom\n`;
  assert.equal(diagnose({ exitCode: 1, output: out("alpha", "beta") }).signature, diagnose({ exitCode: 1, output: out("beta", "alpha") }).signature);
});

test("a failure that is not recognised is said to be unknown, with the most telling line and a call for a hypothesis", () => {
  const d = diagnose({ exitCode: 7, output: "starting up\nconnecting...\nfatal: the flux capacitor refused the request\nbye\n" });
  assert.equal(d.kind, "unknown_failure");
  assert.match(d.summary, /flux capacitor refused/);
  assert.match(d.hint, /specific hypothesis/);
  assert.equal(d.signature, diagnose({ exitCode: 7, output: "fatal: the flux capacitor refused the request\n" }).signature);
  const silent = diagnose({ exitCode: 2, output: "" });
  assert.deepEqual([silent.kind, silent.signature], ["unknown_failure", "exit_code:2"]);
  assert.match(silent.summary, /printed nothing/);
});

test("colour codes in the output do not hide a failure", () => {
  const d = diagnose({ exitCode: 1, output: "\x1b[31mReferenceError: foo is not defined\x1b[0m\n    at run (/p/a.js:4:2)\n", cwd: "/p" });
  assert.deepEqual([d.kind, d.file, d.line], ["reference_error", "a.js", 4]);
});

test("path helpers", () => {
  assert.equal(shortPath("C:\\proj\\src\\a.js", "C:\\proj"), "src/a.js");
  assert.equal(shortPath("c:/PROJ/src/a.js", "C:\\proj"), "src/a.js", "case-insensitive on the folder");
  assert.equal(shortPath("/home/u/proj/node_modules/dep/i.js", "/elsewhere"), "node_modules/dep/i.js");
  assert.equal(shortPath("/other/place/x.js", "/home/u"), "/other/place/x.js");
  assert.equal(stable("took 12.5 ms at C:\\a\\b.js 0xdeadbeef"), "took # ms at <path> <hex>".replace("# ms", "<t>"));
});
