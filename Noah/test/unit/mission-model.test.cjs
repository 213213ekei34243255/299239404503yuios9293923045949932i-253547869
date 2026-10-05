// Noah/test/unit/mission-model.test.cjs - "the model could not be reached (rexy HTTP 400: Missing goal)" on a Mac, and the fix.
//
// A real Mac test of the unlimited build showed the computer agent pausing again and again with that message, while the same app worked on the user's Windows PC. Cause: tasks
// (the "mission" role) use Jonah's hosted model (Gemini behind noahai.live), which is served ONLY to a signed-in Jonah account (the account is the identity every request is
// signed with). The Windows PC had signed in once and kept the session; the Mac never had, and an unlimited build (billing off) never asks. The router then fell back to the
// legacy text backend, which takes one goal string and no tool calls ("Missing goal"), so every request failed and "continue" failed the same way.
// Now: no legacy fallback for tasks; when a task is asked for and nobody is signed in, the app opens the one-time Google sign-in itself (never mid-task) and says so; "continue"
// does not resume into the same failure.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ModelRouter, RouterError } = require("../../models/router.cjs");
const { NoahaiProvider } = require("../../models/noahai.cjs");
const { ScriptedProvider } = require("../../models/scripted.cjs");
const { ConfigStore } = require("../../config.cjs");
const { EventBus } = require("../../events.cjs");
const { MissionService } = require("../../autonomy/service.cjs");
const { AgentSession } = require("../../agent/session.cjs");
const { CommandRouter } = require("../../agent/command-router.cjs");
const M = require("../../autonomy/no-model.cjs");

const REQ = { system: "s", messages: [{ role: "user", content: [{ type: "text", text: "t" }] }], tools: [], toolChoice: null };
const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const settle = () => new Promise((r) => setImmediate(r));

/** A legacy backend that counts how often it is asked, and answers the way the real one does to a task request. */
class LegacyBackend {
  constructor() { this.name = "rexy"; this.type = "rexy"; this.calls = 0; }
  isReady() { return true; }
  async complete() { this.calls++; throw Object.assign(new Error("rexy HTTP 400: Missing goal."), { code: "unknown" }); }
}
function routerWith({ env = {}, signedIn = false, legacy = new LegacyBackend() } = {}) {
  const cfg = new ConfigStore({ env });
  const hosted = new NoahaiProvider({ name: "noahai", baseURL: "http://hosted.invalid", getKey: () => null, isSignedIn: () => signedIn, getAuthHeaders: async () => ({ "X-Jonah-Signature": "x" }), options: {} });
  const providers = { rexy: legacy, noahai: hosted };
  if (env.GEMINI_API_KEY) providers.google = new ScriptedProvider(() => ({ status: "done", summary: "g", result: "g" }), { name: "google" });
  return { router: new ModelRouter({ config: cfg, bus: new EventBus(), providers }), legacy };
}

// ------------------------------------------------------------------------------------------------ the router
test("a task never goes to the legacy backend: signed out, with no key, there is simply no model, and the router says so", async () => {
  const { router, legacy } = routerWith();
  assert.deepEqual(router.usable("mission"), [], "the legacy backend is not offered for a task");
  await assert.rejects(() => router.call("mission", REQ), (e) => e instanceof RouterError && e.code === "NO_MODEL" && e.message === M.NO_MODEL_REPLY);
  assert.equal(legacy.calls, 0, "the legacy backend was never even asked (it answers every task with HTTP 400: Missing goal)");
});

test("everything else still gets the legacy backend as its last resort (chat and the browser agent are unchanged)", () => {
  const { router } = routerWith();
  assert.deepEqual(router.usable("browser").map((c) => c.provider), ["rexy"]);
  assert.deepEqual(router.usable("fast").map((c) => c.provider), ["rexy"]);
  assert.deepEqual(router.usable("mission", { needsVision: true }), []);
});

test("signed in, a task uses Jonah's own model first; a key the user set themselves still counts as a model", () => {
  const signed = routerWith({ signedIn: true });
  assert.deepEqual(signed.router.usable("mission").map((c) => c.provider), ["noahai"]);
  const both = routerWith({ signedIn: true, env: { GEMINI_API_KEY: "AIza-test-key-0123456789" } });
  assert.deepEqual(both.router.usable("mission").map((c) => c.provider), ["noahai", "google"], "the hosted model first, a key of the user's own as the fallback");
  const keyOnly = routerWith({ env: { GEMINI_API_KEY: "AIza-test-key-0123456789" } });
  assert.deepEqual(keyOnly.router.usable("mission").map((c) => c.provider), ["google"]);
});

// ------------------------------------------------------------------------------------------------ the service
function service({ available = true, desktop = true, modelAccess } = {}) {
  const bus = new EventBus();
  const told = [];
  bus.subscribe((e) => { if (e.event === "mission_result") told.push(e); });
  const core = { bus, session: new AgentSession({ bus }), safety: { confirm: async () => false, denyAllPending: () => {} } };
  const state = { available };
  const router = { usable: () => (state.available ? [{ provider: "scripted" }] : []), call: async () => ({ text: "", toolCalls: [{ name: "give_up", args: { reason: "test" } }], usage: {} }) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-mm-"));
  const svc = new MissionService({ router, core, dataDir: dir, pickFolder: async () => null, desktop, modelAccess, makeBridge: () => ({ stop() {}, dispose() {}, windows: async () => [], userIdle: async () => ({ idleMs: 9999 }) }) });
  return { svc, dir, told, state };
}
const cleanup = (...ws) => ws.forEach((w) => fs.rmSync(w.dir, { recursive: true, force: true }));
/** A sign-in the test can finish by hand. */
function fakeSignIn({ signedIn = false } = {}) {
  const f = { calls: 0, signedIn, finish: null };
  f.access = { isSignedIn: () => f.signedIn, signIn: () => { f.calls++; return new Promise((resolve, reject) => { f.finish = resolve; f.fail = reject; }); } };
  return f;
}

test("no model and no way to sign in from the app: a task does not start and the user is told why (no pause loop)", () => {
  const w = service({ available: false });
  for (const kind of ["desktop", "project"]) {
    const r = w.svc.start("do something", { kind });
    assert.deepEqual([r.ok, r.reply], [false, M.NO_MODEL_REPLY], kind);
  }
  assert.equal(w.svc.isRunning(), false);
  assert.match(M.NO_MODEL_REPLY, /signed in to Jonah/);
  assert.doesNotMatch(M.NO_MODEL_REPLY, /Gemini|API key/i, "the user is never asked for an AI key");
  cleanup(w);
});

test("not signed in: the one-time Google sign-in is opened for the user's request, once at a time, and the result is posted to the chat", async () => {
  const si = fakeSignIn();
  const w = service({ available: false, modelAccess: si.access });
  const first = w.svc.start("open notes and write hi", { kind: "desktop" });
  assert.deepEqual([first.ok, first.reply], [false, M.SIGN_IN_STARTED_REPLY]);
  assert.equal(si.calls, 1, "the browser sign-in was started");
  assert.match(M.SIGN_IN_STARTED_REPLY, /opened your browser/);
  const again = w.svc.start("open notes and write hi", { kind: "desktop" });
  assert.equal(again.reply, M.SIGN_IN_WAITING_REPLY, "asking again while the browser is open does not open a second sign-in");
  assert.equal(si.calls, 1);
  si.finish({ ok: true, accountId: "acct" });
  await settle(); await settle();
  assert.equal(w.told.length, 1);
  assert.deepEqual([w.told[0].status, w.told[0].text, w.told[0].resumable], ["succeeded", M.SIGNED_IN_REPLY, false], "the chat says you are signed in");
  si.signedIn = true; w.state.available = true; // the hosted model is ready now
  assert.equal(w.svc.start("open notes and write hi", { kind: "desktop" }).ok, true, "and the next request starts");
  cleanup(w);
});

test("a sign-in that is cancelled, times out or crashes is reported in plain words and can be tried again", async () => {
  for (const [how, expect] of [["cancel", /Signing in did not finish \(Sign-in was cancelled\.\)/], ["fail", /Signing in did not work \(boom\)/]]) {
    const si = fakeSignIn();
    const w = service({ available: false, modelAccess: si.access });
    w.svc.start("x", { kind: "desktop" });
    if (how === "cancel") si.finish({ ok: false, reason: "denied", message: "Sign-in was cancelled." }); else si.fail(new Error("boom"));
    await settle(); await settle();
    assert.equal(w.told.length, 1, how);
    assert.equal(w.told[0].status, "impossible", how);
    assert.match(w.told[0].text, expect);
    assert.match(w.told[0].text, /Ask me again to try once more/);
    assert.equal(w.svc.start("x", { kind: "desktop" }).reply, M.SIGN_IN_STARTED_REPLY, "a new sign-in is opened on the next request: " + how);
    assert.equal(si.calls, 2);
    cleanup(w);
  }
  const sync = service({ available: false, modelAccess: { isSignedIn: () => false, signIn: () => { throw new Error("no browser"); } } });
  assert.equal(sync.svc.start("x", { kind: "desktop" }).reply, M.SIGN_IN_STARTED_REPLY);
  await settle(); await settle();
  assert.match(sync.told[0].text, /Signing in did not work \(no browser\)/, "even a sign-in that fails at once is reported, not thrown");
  cleanup(sync);
});

test("already signed in but the hosted model is not taking requests: no pointless second sign-in, an honest message", () => {
  const si = fakeSignIn({ signedIn: true });
  const w = service({ available: false, modelAccess: si.access });
  assert.equal(w.svc.start("x", { kind: "desktop" }).reply, M.SIGNED_IN_NO_MODEL_REPLY);
  assert.equal(si.calls, 0);
  const throwing = service({ available: false, modelAccess: { isSignedIn: () => { throw new Error("x"); }, signIn: () => Promise.resolve({ ok: true }) } });
  assert.equal(throwing.svc.start("x", { kind: "desktop" }).reply, M.SIGN_IN_STARTED_REPLY, "a status that cannot be read counts as not signed in");
  cleanup(w, throwing);
});

test("on a system without the desktop the message says so, and no sign-in is opened for it", () => {
  const si = fakeSignIn();
  const w = service({ available: false, desktop: false, modelAccess: si.access });
  const r = w.svc.start("open notes", { kind: "desktop" });
  assert.equal(r.ok, false);
  assert.match(r.reply, /Windows and macOS/);
  assert.equal(si.calls, 0);
  cleanup(w);
});

test("'continue' and answering a question do not resume a paused task into the same failure; they start the sign-in; with a model they carry on", async () => {
  const paused = { running: false, runner: { lc: { terminal: { resumable: true, kind: "budget_paused" } }, resume() { paused.resumed = (paused.resumed || 0) + 1; } }, endedAt: Date.now(), goal: "g", source: "text", kind: "desktop" };
  const si = fakeSignIn();
  const none = service({ available: false, modelAccess: si.access });
  none.svc.current = paused;
  const r = none.svc.resume({});
  assert.deepEqual([r.ok, r.reply], [false, M.SIGN_IN_STARTED_REPLY], "\"continue\" opens the sign-in");
  assert.equal(paused.resumed, undefined, "nothing was resumed");
  assert.equal(none.svc.answer("yes", {}).reply, M.SIGN_IN_WAITING_REPLY);
  const nothing = service({ available: false, modelAccess: fakeSignIn().access });
  assert.equal(nothing.svc.resume({}).reply, "There is no project task to continue.", "with nothing to continue the answer is the old, honest one, and no sign-in is opened");
  const withModel = service({ available: true });
  withModel.svc.current = paused;
  withModel.svc._run = async () => {};
  assert.equal(withModel.svc.resume({}).ok, true);
  assert.equal(paused.resumed, 1);
  cleanup(none, nothing, withModel);
});

test("Computer agent mode with no model starts the sign-in and says so; an unsupported system only says that; an older service falls back to the plain text", () => {
  const mk = (missions) => new CommandRouter({ session: new AgentSession({ bus: new EventBus() }), agent: { submit() {}, stop() {}, pause() {}, resume() { return { ok: true }; } }, missions });
  const base = { isDesktopAvailable: () => false, isAvailable: () => false, isRunning: () => false, awaitingAnswer: () => false, hasResumable: () => false };
  let asked = 0;
  const r = mk({ ...base, desktop: true, requestModelAccess: () => { asked++; return { started: true, reply: M.SIGN_IN_STARTED_REPLY }; } }).route("open notes", { mode: "computer" });
  assert.equal(r.reply, M.SIGN_IN_STARTED_REPLY);
  assert.equal(asked, 1);
  const plain = mk({ ...base, desktop: true }).route("open notes", { mode: "computer" });
  assert.equal(plain.reply, M.COMPUTER_AGENT_UNAVAILABLE);
  assert.match(plain.reply, /Windows and on macOS/);
  assert.match(plain.reply, /signed in to Jonah/);
  const unsupported = mk({ ...base, desktop: false, requestModelAccess: () => { asked++; return { reply: "x" }; } }).route("open notes", { mode: "computer" });
  assert.match(unsupported.reply, /not available on this system/);
  assert.equal(asked, 1, "no sign-in for a system that cannot run the computer agent anyway");
});

// ------------------------------------------------------------------------------------------------ the wiring
test("the pieces are wired: the shell passes the sign-in to Noah, which passes it to the mission service; nothing asks for an AI key", () => {
  assert.match(read("main.cjs"), /signIn: \(\) => entitlementGate\.signInForModel\(\)/);
  assert.match(read("Noah/index.cjs"), /modelAccess = hosted && typeof hosted\.signIn === "function" \? \{ isSignedIn: hosted\.isSignedIn, signIn: hosted\.signIn \} : null/);
  assert.match(read("Noah/index.cjs"), /new MissionService\(\{[^}]*\bmodelAccess\b/);
  assert.match(read("entitlement-gate.cjs"), /signIn, signInForModel \}/);
  for (const f of ["ai-panel.html", "preload.cjs", "noah-renderer.js", "Noah/ipc.cjs"]) assert.doesNotMatch(read(f), /noahModelKey|saveModelKey|noah:save-model-key|model-key-save/, `${f} has no AI-key box or plumbing`);
  for (const m of Object.values(M)) assert.doesNotMatch(m, /Gemini|API key|aistudio/i, "no message asks the user for an AI key");
});
