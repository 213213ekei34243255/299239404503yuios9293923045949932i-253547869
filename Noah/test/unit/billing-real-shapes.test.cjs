// Noah/test/unit/billing-real-shapes.test.cjs - the app against the EXACT JSON the noahai.live session says its server returns (reply of 2026-10-05): nested `features`, `previousPlan` /
// `expiredAt` / `subscriptionStatus: "expired"` for a plan that ended, and the 403 bodies. Copied from that reply, not from my stand-in server.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { EntitlementClient } = require("../../../entitlement-client.cjs");
const { blockedFeatureMessage } = require("../../../entitlement-gate.cjs");
const { planNotice } = require("../../../plan-notice.cjs");

const ROOT = path.resolve(__dirname, "..", "..", "..");

// GET /api/entitlements for an expired Premium account, as the server session printed it
const EXPIRED = {
  earlyAccess: false, expiredAt: "2026-11-12T11:57:12Z",
  features: {
    agent: { cooldownUntil: null, limit: 2, period: "lifetime", remaining: 2, used: 0 },
    attachment: { cooldownUntil: null, limit: 5, period: "48h_cooldown", remaining: 5, used: 0 },
    chat: { cooldownUntil: null, limit: 7200, period: "24h_rolling", remaining: 7200, used: 0 },
    "trust-engine": { cooldownUntil: null, limit: 3, period: "24h_cooldown", remaining: 3, used: 0 },
  },
  plan: "free", planName: "Free", previousPlan: "premium", renewsAt: null, status: "expired", subscriptionStatus: "expired",
};
// 403 bodies of POST /api/usage/<feature>
const AGENT_403 = { authorized: false, cooldownUntil: null, expiredAt: "2026-11-13T11:57:12Z", plan: "free", previousPlan: "premium", reason: "lifetime_exhausted" };
const TRUST_403 = { authorized: false, cooldownUntil: "2026-11-15T11:57:12Z", expiredAt: "2026-11-13T11:57:12Z", plan: "free", previousPlan: "premium", reason: "cooldown" };

test("the Plans page notice reads the real expired-account JSON", () => {
  assert.equal(planNotice(EXPIRED), "Your Premium plan ended on 12 Nov 2026, so your account is back on Free until you pay again.");
  assert.equal(planNotice({ ...EXPIRED, plan: "premium", status: "active", subscriptionStatus: "active", previousPlan: undefined, expiredAt: undefined }), "");
  assert.equal(planNotice({ plan: "free", subscriptionStatus: "none", features: EXPIRED.features }), "", "a never-paid Free account: no previousPlan, no notice");
});

// ---- the client: the real 403 bodies become refusals that say it
function clientAnswering(status, json) {
  const c = new EntitlementClient({ serverUrl: "http://127.0.0.1:1", device: { publicKey: () => "x" }, allowInsecureLoopback: true });
  c.accountId = "acct";
  c._request = async () => ({ ok: true, status, json });
  return c;
}

test("the client keeps previousPlan and expiredAt from the server's 403 and the gate says so first", async () => {
  const r = await clientAnswering(403, AGENT_403).consumeUsage("agent");
  assert.deepEqual([r.authorized, r.reason, r.plan, r.previousPlan], [false, "lifetime_exhausted", "free", "premium"]);
  assert.equal(r.expiredAt, Date.parse("2026-11-13T11:57:12Z") / 1000);
  assert.equal(blockedFeatureMessage("agent", r), "Your Premium plan ended on 13 Nov 2026, so your account is back on Free until you pay again. AI Agent limit reached. Your free lifetime trials are used up. Upgrade to continue.");
  const t = await clientAnswering(403, TRUST_403).consumeUsage("trust-engine");
  assert.deepEqual([t.reason, t.previousPlan], ["cooldown", "premium"]);
  assert.ok(t.cooldownUntil > 0, "the ISO cooldown became unix seconds");
  assert.match(blockedFeatureMessage("trust-engine", t), /^Your Premium plan ended on 13 Nov 2026, so your account is back on Free until you pay again\. Trust Engine limit reached\. Available again in /);
});

test("the old reason 'subscription_expired' is gone from the server, and the app does not need it: the sentence comes from previousPlan and expiredAt", () => {
  const msg = blockedFeatureMessage("agent", { reason: "lifetime_exhausted", plan: "free", previousPlan: "premium", expiredAt: "2026-11-13T11:57:12Z" });
  assert.match(msg, /^Your Premium plan ended on 13 Nov 2026/);
  assert.match(blockedFeatureMessage("agent", { reason: "subscription_expired" }), /back on Free until you pay again/, "and a server that still sent it would be understood");
});

// ---- the Plans page's usage lines (browser script: run in a sandbox with a tiny fake page, and reach its function through a test-only line added to a COPY of the source)
function loadUsageLines() {
  let src = fs.readFileSync(path.join(ROOT, "billing-panel.js"), "utf8");
  const end = src.lastIndexOf("})();");
  assert.ok(end > 0);
  src = src.slice(0, end) + "globalThis.__usageLines = usageLines;\n" + src.slice(end);
  const el = () => ({ className: "", textContent: "", append() {}, appendChild() {}, addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, style: {} });
  const document = { createElement: el, head: { appendChild() {} }, body: { appendChild() {} }, querySelector: () => null, getElementById: () => null, addEventListener() {} };
  const sandbox = { window: { api: { billing: {} }, addEventListener() {} }, document, console, Date, Math, Number, Object, Array, String, Set, Promise };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "billing-panel.js" });
  return sandbox.__usageLines;
}

test("the usage lines read the real nested features, and show AI Chat in minutes (the server counts it in seconds)", () => {
  const raw = loadUsageLines();
  const usageLines = (x) => JSON.parse(JSON.stringify(raw(x))); // (an array from the sandbox has another realm's prototype)
  assert.deepEqual(usageLines(EXPIRED), ["AI Agent: 2 of 2 left", "Trust Engine: 3 of 3 left", "Attachments: 5 of 5 left", "AI Chat: 120 of 120 min left"]);
  const used = JSON.parse(JSON.stringify(EXPIRED));
  used.features.chat.remaining = 5400; used.features.agent.remaining = 0; used.features.agent.used = 2;
  const lines = usageLines(used);
  assert.equal(lines[0], "AI Agent: 0 of 2 left");
  assert.equal(lines[3], "AI Chat: 90 of 120 min left");
  const cooling = JSON.parse(JSON.stringify(EXPIRED));
  cooling.features["trust-engine"] = { limit: 3, period: "24h_cooldown", remaining: 0, used: 3, cooldownUntil: new Date(Date.now() + 5 * 3600 * 1000 + 60_000).toISOString() };
  assert.match(usageLines(cooling)[1], /^Trust Engine: 0 of 3 left - available again in 5h \d+m$/);
  assert.deepEqual(usageLines(null), []);
  assert.deepEqual(usageLines({ plan: "free" }), []);
});
