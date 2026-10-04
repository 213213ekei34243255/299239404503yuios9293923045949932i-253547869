// Noah/test/unit/autonomy-secrets.test.cjs - a secret typed into the chat never reaches the model or the disk (Noah/safety/secrets.cjs).
// Found because a live mission asked the user to "provide the value for PAYMENT_API_KEY": whatever they typed back would have been sent to the
// model provider and saved in the mission's checkpoint. The prompt no longer asks for a secret, and a reply that holds one is cleaned first.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { redactSecrets, asksForSecret, MARK } = require("../../safety/secrets.cjs");
const { createMission } = require("../../autonomy/mission-runner.cjs");
const { MissionStore } = require("../../autonomy/mission-store.cjs");
const { systemPrompt } = require("../../autonomy/mission-context.cjs");
const { ControlTools } = require("../../autonomy/control-tools.cjs");

const r = (text, askedForSecret = false) => redactSecrets(text, { askedForSecret });

test("well-known key formats are removed wherever they appear", () => {
  const keys = [
    "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2",
    "sk-proj-" + "abcdefghijklmnopqrstuvwx",
    "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
    "sk-ant-" + "api03-abcdefghijklmnopqrstuv",
    "ghp_" + "a".repeat(36),
    "github_pat_" + "A".repeat(40),
    "AKIA" + "IOSFODNN7EXAMPLE",
    "AIza" + "SyA".padEnd(35, "x"),
    "xoxb-" + "1234567890-abcdefghij",
    "eyJ" + "hbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0." + "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ];
  for (const k of keys) {
    const out = r(`here you go ${k} thanks`);
    assert.equal(out.found, 1, k);
    assert.equal(out.text, `here you go ${MARK} thanks`, k);
    assert.ok(!out.text.includes(k.slice(8)), "no part of it is left");
  }
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----";
  assert.equal(r(`use this:\n${pem}\nok`).text, `use this:\n${MARK}\nok`);
  assert.equal(r("-----BEGIN PRIVATE KEY-----\nMIIE\n(cut off, never closed)").text, MARK);
});

test("a credential-named assignment loses its value but keeps its name", () => {
  assert.equal(r("PAYMENT_API_KEY=abc123xyz789").text, `PAYMENT_API_KEY=${MARK}`);
  assert.equal(r("set the password: hunter2hunter2 and retry").text, `set the password: ${MARK} and retry`);
  assert.equal(r('API_KEY="abcdef123456"').text, `API_KEY="${MARK}"`);
  assert.equal(r("db_password = 'p@ss-w0rd!'").text, `db_password = '${MARK}'`);
  assert.equal(r("the token is: Zm9vYmFyYmF6").text, `the token is: ${MARK}`);
  assert.equal(r("client_secret=s3cr3t-value, region=eu").text, `client_secret=${MARK}, region=eu`);
  assert.equal(r("my password was = Tr0ub4dor&3").text, `my password was = ${MARK}`);
  assert.equal(r("the key is used for signing").found, 0, "'is' without a colon or equals sign is just a sentence");
  assert.equal(r("key=val").found, 0, "a value too short to be a secret is left alone");
  assert.equal(r("region=eu-west-1 mode=fast").found, 0, "settings that are not credentials are untouched");
});

test("when a secret was just asked for, a pasted opaque value is removed even in no known format", () => {
  assert.deepEqual(r("FAKE-DEMO-VALUE-NOT-A-REAL-KEY", true), { text: MARK, found: 1 });
  assert.equal(r("here it is: a1b2c3d4e5f6g7h8", true).text, `here it is: ${MARK}`);
  assert.equal(r("it's \"a1b2c3d4e5f6g7h8\".", true).text, `it's "${MARK}".`);
  assert.equal(r("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo", true).text, MARK, "a long token with no digit or dash is still opaque");
  assert.equal(r("it is correct-horse-battery", true).text, `it is ${MARK}`, "a shorter token with dashes and no digits (under 24 characters) is still opaque");
  assert.equal(r("it is some_long_value", true).text, `it is ${MARK}`, "and so is one with underscores");
  assert.equal(r("token abcdefghijk1", true).text, `token ${MARK}`, "and one with a digit and no dash");
  assert.equal(r("it is abcdefghijk", true).text, "it is abcdefghijk", "a plain 11-letter word is left alone");
  // ... but ordinary answers are not mangled
  for (const ok of ["yes", "use staging", "Please use the staging configuration", "the second option, please", "go ahead and install it", "continue", "C:\\Users\\me\\my-project\\config-file-name.json", "./config/some-long-file-name.json", "https://example.com/very-long-path-name", "~/projects/my-long-project-name", "www.my-long-domain-name.com"]) {
    assert.deepEqual(r(ok, true), { text: ok, found: 0 }, ok);
  }
  // not asked: an opaque word is not touched (no mangling of ordinary replies)
  assert.deepEqual(r("use feature-flag-new-checkout-v2 for the test", false), { text: "use feature-flag-new-checkout-v2 for the test", found: 0 });
});

test("empty, missing and non-string input is safe", () => {
  for (const v of ["", null, undefined, 0, {}]) assert.doesNotThrow(() => redactSecrets(v), String(v));
  assert.deepEqual(redactSecrets(""), { text: "", found: 0 });
  assert.equal(redactSecrets(null).text, "");
});

test("which questions are asking for a secret", () => {
  for (const q of ["Please provide the value for PAYMENT_API_KEY so the test suite can run successfully.", "What is the API key?", "Provide your password", "I need the access token for the service.", "Which secret should I use?", "Paste the private key", "Please provide the PAYMENT_API_KEY environment variable required by src/pay.js to run the tests."]) assert.equal(asksForSecret(q), true, q);
  for (const q of ["Which currency should I use?", "May I install globally?", "Which keyboard layout do you want?", "Should I use staging or production?", "Do you want me to change the test?", "", null]) assert.equal(asksForSecret(q), false, String(q));
});

// ---------------------------------------------------------------- end to end: the REAL runner, the REAL checkpoint file
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-sec-")));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;
function project() {
  const root = path.join(base, `p${++n}`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  return root;
}
const CRITERIA = ["criteria_add", { criteria: [{ kind: "file_exists", path: "README.md", description: "the readme exists" }] }];
function scripted(rounds) {
  const callModel = async (req) => {
    const i = callModel.requests.push(req.messages[0].content[0].text) - 1;
    const r = rounds[i];
    if (r === undefined) throw new Error(`the script ran out at round ${i + 1}`);
    return { text: "", toolCalls: r.map(([name, args]) => ({ name, args })), usage: { inputTokens: 1, outputTokens: 1 } };
  };
  callModel.requests = [];
  return callModel;
}

async function askThenAnswer(question, answer) {
  const root = project();
  const store = new MissionStore({ dir: path.join(base, `store${n}`) });
  const events = [];
  const callModel = scripted([[CRITERIA], [["ask_user", { question, kind: "input" }]], [["fs_list", { path: "." }]]]);
  const m = createMission({ objective: "Make the tests pass.", roots: [root], callModel, store, bus: { publish: (event, payload) => events.push({ event, ...payload }) }, limits: { maxIterations: 20, stallLimit: 50 } });
  const first = await m.run();
  assert.equal(first.status, "blocked_input");
  m.resume({ answer });
  m.limits.maxIterations = m.state.counters.iterations + 1;
  await m.run();
  const disk = fs.readdirSync(store.dir).map((f) => fs.readFileSync(path.join(store.dir, f), "utf8")).join("\n");
  return { shown: callModel.requests.join("\n"), after: callModel.requests[2], disk, events };
}

test("the whole road: a key typed as the answer reaches neither the model nor the checkpoint, and the user is told", async () => {
  const KEY = "sk-" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4";
  const w = await askThenAnswer("Please provide the value for PAYMENT_API_KEY so the test suite can run.", `PAYMENT_API_KEY=${KEY}`);
  assert.ok(!w.shown.includes(KEY) && !w.shown.includes("a1B2c3D4e5F6"), "the model never saw it");
  assert.ok(!w.disk.includes(KEY) && !w.disk.includes("a1B2c3D4e5F6"), "and it was never written to the disk");
  assert.match(w.after, /The user replied: PAYMENT_API_KEY=\[secret removed\]/);
  assert.match(w.after, /contained something that looks like a secret .* you must never ask for it in the chat\. If the task needs it, tell the user to put it in the project's own \.env file themselves/);
  const notice = w.events.find((e) => e.event === "mission_notice");
  assert.match(notice.text, /^Your reply looked like it contained a secret \(a key, token or password\)\. Noah removed it and did not send it to the model\./);
});

test("a bare pasted value is caught because the question asked for a secret; the same reply to another question is left alone", async () => {
  const VALUE = "FAKE-DEMO-VALUE-NOT-A-REAL-KEY";
  const asked = await askThenAnswer("What is the API key for the payment service?", VALUE);
  assert.ok(!asked.shown.includes(VALUE));
  assert.match(asked.after, /The user replied: \[secret removed\]/);
  assert.ok(asked.events.some((e) => e.event === "mission_notice"));
  const other = await askThenAnswer("Which feature flag should I turn on for the test?", "feature-flag-new-checkout-v2");
  assert.match(other.after, /The user replied: feature-flag-new-checkout-v2/, "an ordinary answer is passed on untouched");
  assert.doesNotMatch(other.after, /looks like a secret/);
  assert.ok(!other.events.some((e) => e.event === "mission_notice"));
});

test("a plain answer or a plain 'continue' is unchanged and raises no warning", async () => {
  const a = await askThenAnswer("Should I use staging or production?", "use staging");
  assert.match(a.after, /The user replied: use staging/);
  assert.ok(!a.events.some((e) => e.event === "mission_notice"));
  const root = project();
  const m = createMission({ objective: "x", roots: [root], callModel: scripted([[CRITERIA], [["ask_user", { question: "Ready?", kind: "input" }]], [["fs_list", { path: "." }]]]), limits: { maxIterations: 2, stallLimit: 50 } });
  await m.run();
  m.resume({});
  assert.deepEqual(m.notices, ["The user asked you to continue."]);
});

test("the model is no longer told to ask for a secret, and is told to ask the user to put it in .env themselves", () => {
  const prompt = systemPrompt({});
  assert.doesNotMatch(prompt, /a password or key, a choice/, "the old wording is gone");
  assert.match(prompt, /NEVER ask the user to type or paste a secret \(a key, token or password\) into this chat: what they type is sent to the model provider and saved on disk\./);
  assert.match(prompt, /put it in the project's own \.env file themselves \(you cannot read that file\)/);
  assert.match(prompt, /ask_user to tell the user exactly what is missing and how they can supply it/);
  assert.doesNotMatch(prompt, /ask_user for it\b/);
  const schema = new ControlTools({ state: {}, lifecycle: {}, verifier: {} }).schemas().find((t) => t.name === "ask_user");
  assert.match(schema.description, /NEVER ask them to type a secret into the chat/);
  assert.doesNotMatch(schema.description, /a password or key/);
});
