// Noah/test/unit/plan-expiry.test.cjs - two rules of the plans:
//   1. When a paid plan's period is over without a new payment, the account is on Free again until it is paid once more (the server decides; the client says it and honours it).
//   2. The Web agent and the Computer agent are ONE feature, "AI Agent": whatever limit applies to the Agent applies to both, and they draw from the same allowance.
// Proven against the repository's stand-in server (NOT noahai.live): the real server is asked for the same rule in Noah/docs/backend-prompt-plan-expiry.txt.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createEntitlementGate, blockedFeatureMessage } = require("../../../entitlement-gate.cjs");
const { endedSentence, planNotice, planName, dayOf } = require("../../../plan-notice.cjs");
const { registerBillingIpc, PLAN_CATALOG } = require("../../../billing.cjs");
const { createStandInServer } = require("./entitlement-stand-in-server.cjs");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const DAY = 24 * 3600;

function keychain(secret) {
  const key = crypto.createHash("sha256").update(secret).digest();
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", key, iv); const enc = Buffer.concat([c.update(s, "utf8"), c.final()]); return Buffer.concat([iv, c.getAuthTag(), enc]); },
    decryptString: (b) => { const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"); },
  };
}
const googleSaysYouAre = (sub) => async (authUrl) => {
  const u = new URL(authUrl);
  await fetch(`${u.searchParams.get("redirect_uri")}?code=GOOD:${sub}:${crypto.randomBytes(6).toString("hex")}&state=${u.searchParams.get("state")}`);
};
const withEnabled = (fn) => async () => {
  const before = process.env.JONAH_ENTITLEMENTS_ENABLED;
  process.env.JONAH_ENTITLEMENTS_ENABLED = "1";
  try { await fn(); } finally { if (before === undefined) delete process.env.JONAH_ENTITLEMENTS_ENABLED; else process.env.JONAH_ENTITLEMENTS_ENABLED = before; }
};
async function world() {
  const clock = { t: Math.floor(Date.now() / 1000) };
  const stand = createStandInServer({ now: () => clock.t, authNow: () => Math.floor(Date.now() / 1000) }); // the plan's calendar moves; the signatures stay on real time
  const url = await stand.listen();
  const gate = createEntitlementGate({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "jonah-plan-")), safeStorage: keychain("k"), serverUrl: url, allowInsecureLoopback: true, openExternal: googleSaysYouAre("alice") });
  assert.equal((await gate.signIn()).ok, true);
  return { clock, stand, gate, close: () => stand.close() };
}

test("a paid plan whose period is over puts the account back on Free until it is paid once again", withEnabled(async () => {
  const w = await world();
  try {
    const endsAt = w.clock.t + 30 * DAY;
    w.stand.grantPlan("alice", "premium", endsAt);
    let ent = (await w.gate.client.getEntitlements()).entitlements;
    assert.deepEqual([ent.plan, ent.subscriptionStatus], ["premium", "active"]);
    assert.equal(planNotice(ent), "", "nothing to say while the plan is paid");

    for (let i = 0; i < 3; i++) assert.equal((await w.gate.gate("agent")).allowed, true, `paid agent use ${i + 1}`);
    const over = await w.gate.gate("agent");
    assert.equal(over.allowed, false, "the paid allowance is the paid one");
    assert.equal(over.plan, "premium");
    assert.ok(!/plan ended/.test(over.message), "a paid plan that has not ended does not say it ended");

    w.clock.t = endsAt + 1; // the 30 days are over and nobody paid again
    ent = (await w.gate.client.getEntitlements()).entitlements;
    assert.deepEqual([ent.plan, ent.subscriptionStatus, ent.previousPlan], ["free", "expired", "premium"]);
    assert.equal(planNotice(ent), `Your Premium plan ended on ${dayOf(endsAt)}, so your account is back on Free until you pay again.`);

    // Free's own limits now apply (2 lifetime trials)...
    assert.equal((await w.gate.gate("agent")).allowed, true);
    assert.equal((await w.gate.gate("agent")).allowed, true);
    const refused = await w.gate.gate("agent");
    assert.equal(refused.allowed, false);
    assert.equal(refused.reason, "lifetime_exhausted");
    assert.equal(refused.plan, "free");
    assert.equal(refused.previousPlan, "premium");
    assert.equal(refused.message, `Your Premium plan ended on ${dayOf(endsAt)}, so your account is back on Free until you pay again. AI Agent limit reached. Your free lifetime trials are used up. Upgrade to continue.`);
    assert.equal((await w.gate.gate("control")).allowed, true, "steering a running task stays free");

    // ...until it is paid once more
    w.stand.grantPlan("alice", "premium", w.clock.t + 30 * DAY);
    const again = await w.gate.gate("agent");
    assert.equal(again.allowed, true);
    ent = (await w.gate.client.getEntitlements()).entitlements;
    assert.deepEqual([ent.plan, ent.subscriptionStatus], ["premium", "active"]);
    assert.equal(planNotice(ent), "", "paid again: the notice is gone");
  } finally { await w.close(); }
}));

test("the Web agent and the Computer agent are one feature with one allowance", withEnabled(async () => {
  const w = await world();
  try {
    const { classifyGoal } = w.gate;
    for (const [goal, mode] of [["open youtube and search lofi", "web"], ["open youtube and search lofi", "agent"], ["open notes and write hello", "computer"], ["anything", "web"], ["anything", "computer"]]) assert.equal(classifyGoal(goal, mode), "agent", `${mode}: ${goal}`);
    assert.equal(classifyGoal("open youtube.com and search for lofi", "auto"), "agent", "auto: a browser job");
    assert.equal(classifyGoal("open notepad and type hello", "auto"), "agent", "auto: a job on the user's apps");
    assert.equal(classifyGoal("fix the failing tests in my project", "auto"), "agent", "auto: a project job");
    assert.equal(classifyGoal("what is the capital of France", "auto"), "chat");
    assert.equal(classifyGoal("stop", "web"), "agent", "an explicit agent mode is an agent use (a bare 'stop' is a control only in auto, on a task that exists)");
    // free plan: 2 lifetime uses TOGETHER, whichever agent they were spent on
    const web = () => w.gate.gate(classifyGoal("open youtube and search lofi", "web"));
    const computer = () => w.gate.gate(classifyGoal("open notes and write hello", "computer"));
    assert.equal((await web()).allowed, true);
    assert.equal((await computer()).allowed, true);
    const third = await computer();
    assert.deepEqual([third.allowed, third.reason], [false, "lifetime_exhausted"]);
    const fourth = await web();
    assert.deepEqual([fourth.allowed, fourth.reason], [false, "lifetime_exhausted"], "the Web agent is refused for the same reason");
    assert.match(third.message, /^AI Agent limit reached/);
  } finally { await w.close(); }
}));

test("the words: the ended-plan sentence, the plan names and the date", () => {
  assert.equal(planName("premium"), "Premium");
  assert.equal(planName("premium_plus"), "Premium Plus");
  assert.equal(planName("ultra_premium_plus"), "Ultra Premium Plus");
  assert.equal(planName("some_new_plan"), "some new plan");
  assert.equal(planName("<script>alert(1)</script>"), "paid");
  assert.equal(planName(undefined), "paid");
  const sec = Date.UTC(2026, 9, 12, 12, 0, 0) / 1000;
  assert.equal(dayOf(sec), "12 Oct 2026");
  assert.equal(dayOf("2026-10-12T23:59:59Z"), "12 Oct 2026", "an ISO date reads the same");
  assert.equal(dayOf("nonsense"), "");
  assert.equal(dayOf(null), "");
  assert.equal(endedSentence({ previousPlan: "premium", expiredAt: sec }), "Your Premium plan ended on 12 Oct 2026, so your account is back on Free until you pay again.");
  assert.equal(endedSentence({ previousPlan: "premium" }), "Your Premium plan ended, so your account is back on Free until you pay again.", "no date, no 'on'");
});

test("the Plans page notice appears only for a plan that ended and has not been paid again", () => {
  const sec = Date.UTC(2026, 9, 12) / 1000;
  assert.match(planNotice({ plan: "free", subscriptionStatus: "expired", previousPlan: "premium", expiredAt: sec }), /^Your Premium plan ended on 12 Oct 2026/);
  assert.match(planNotice({ subscriptionStatus: "expired" }), /^Your paid plan ended, so your account is back on Free/, "the server may send only the status");
  assert.equal(planNotice({ plan: "premium", subscriptionStatus: "active" }), "");
  assert.equal(planNotice({ plan: "premium", subscriptionStatus: "expired", previousPlan: "premium_plus" }), "", "paid again, whatever else is left in the record");
  assert.equal(planNotice({ plan: "free", subscriptionStatus: "none" }), "");
  for (const junk of [null, undefined, 7, "x", [], {}]) assert.equal(planNotice(junk), "");
});

test("a refusal after a plan ended says so first; one before it ended, a sign-in or a network problem does not", () => {
  const ended = { previousPlan: "premium", plan: "free", expiredAt: Date.UTC(2026, 9, 12) / 1000 };
  const sentence = "Your Premium plan ended on 12 Oct 2026, so your account is back on Free until you pay again.";
  assert.equal(blockedFeatureMessage("agent", { ...ended, reason: "lifetime_exhausted" }), `${sentence} AI Agent limit reached. Your free lifetime trials are used up. Upgrade to continue.`);
  assert.match(blockedFeatureMessage("trust-engine", { ...ended, reason: "cooldown", cooldownUntil: Date.now() / 1000 + 3 * 3600 }), new RegExp(`^${sentence} Trust Engine limit reached\\. Available again in`));
  assert.match(blockedFeatureMessage("chat", { ...ended, reason: "refused" }), new RegExp(`^${sentence} AI Chat limit reached`));
  assert.match(blockedFeatureMessage("chat", { reason: "subscription_expired" }), /expired.*AI Chat/);
  assert.match(blockedFeatureMessage("chat", { reason: "subscription_expired" }), /back on Free until you pay again/);
  for (const reason of ["sign_in_required", "server_unreachable", "account_suspended"]) assert.ok(!/plan ended/.test(blockedFeatureMessage("agent", { ...ended, reason })), reason);
  assert.ok(!/plan ended/.test(blockedFeatureMessage("agent", { reason: "lifetime_exhausted", plan: "free" })), "a Free user who never paid");
  assert.ok(!/plan ended/.test(blockedFeatureMessage("agent", { reason: "cooldown", plan: "premium", previousPlan: "premium" })), "still on a paid plan");
});

test("the Plans screen's status carries the notice from the main process, and says that the Agent is both agents", async () => {
  const handlers = {};
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
  const sec = Date.UTC(2026, 9, 12) / 1000;
  const gate = { enabled: true, client: { signedIn: true, getEntitlements: async () => ({ ok: true, entitlements: { plan: "free", subscriptionStatus: "expired", previousPlan: "premium", expiredAt: sec } }) } };
  registerBillingIpc({ ipcMain, gate, openExternal: async () => {}, links: {}, env: {} });
  const trusted = { sender: { getType: () => "window" }, senderFrame: { parent: null } };
  const st = await handlers["billing:status"](trusted);
  assert.equal(st.ok, true);
  assert.equal(st.planNotice, "Your Premium plan ended on 12 Oct 2026, so your account is back on Free until you pay again.");
  gate.client.getEntitlements = async () => ({ ok: true, entitlements: { plan: "premium", subscriptionStatus: "active" } });
  assert.equal((await handlers["billing:status"](trusted)).planNotice, "");
  gate.client.getEntitlements = async () => ({ ok: false, reason: "server_unreachable" });
  assert.equal((await handlers["billing:status"](trusted)).planNotice, "", "no entitlements, no notice");
  for (const p of PLAN_CATALOG) assert.ok(p.features.some((f) => f.startsWith("AI Agent (Web agent + Computer agent): ")), `${p.id} says the Agent covers both`);
  const panel = read("billing-panel.js");
  assert.ok(panel.includes("st.planNotice") && panel.includes("The AI Agent covers both the Web agent and the Computer agent"));
});

test("the server is asked for the rule in writing", { skip: !fs.existsSync(path.join(ROOT, "Noah/docs/backend-prompt-plan-expiry.txt")) && "the briefing is not part of this checkout" }, () => {
  const doc = read("Noah/docs/backend-prompt-plan-expiry.txt");
  for (const must of [/BRIEFING FOR THE noahai\.live BACKEND SESSION/, /back on Free/i, /previousPlan/, /expiredAt/, /subscriptionStatus/, /web agent and the computer agent/i, /session_id/]) assert.match(doc, must);
  // the other session is asked to LOOK first and to build only what is missing (the owner's instruction), and to answer in one table
  for (const must of [/CHECK FIRST what already exists, then build ONLY what is missing/, /STEP 1 - AUDIT\. Do NOT change anything yet/, /THERE \/ PARTLY \/ NOT THERE/, /STEP 2 - BUILD ONLY WHAT IS MISSING/, /A1\./, /B1\./, /C1\./, /D1\./, /rule \| THERE \/ PARTLY \/ NOT THERE/, /RULE E - LEARNING FROM USERS' RESPONSES/, /E1\./, /E2\./, /E3\./, /consent switch per account, default OFF/, /Never put one user's records into another user's prompt/, /five rules below \(A, B, C, D, E\)/]) assert.match(doc, must);
  assert.ok(!/No training or fine-tuning on users' conversations, and no collection of them/.test(doc), "it no longer says the opposite of what the owner asked");
  assert.ok(!/please build it, then tell me/.test(doc), "it no longer says 'just build it'");
});
