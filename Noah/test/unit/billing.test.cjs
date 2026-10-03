// Noah/test/unit/billing.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { registerBillingIpc, publicCatalog, checkoutUrl, PLAN_CATALOG } = require("../../../billing.cjs");
const { createEntitlementGate } = require("../../../entitlement-gate.cjs");
const { createStandInServer } = require("./entitlement-stand-in-server.cjs");

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

const okSender = { sender: { getType: () => "window" }, senderFrame: { parent: null } };
function makeIpc() {
  const handlers = new Map();
  return { handle: (ch, fn) => handlers.set(ch, fn), call: (ch, ev, ...a) => handlers.get(ch)(ev, ...a) };
}
async function setup({ env = {}, serverUrl, standIn, links = {} } = {}) { // links default {}: tests must not depend on the Stripe links shipped in billing-links.config.json
  const stand = standIn || createStandInServer();
  const url = serverUrl || (await stand.listen());
  const gate = createEntitlementGate({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "jonah-bill-")), safeStorage: keychain("k"), serverUrl: url, allowInsecureLoopback: true, openExternal: googleSaysYouAre("alice") });
  const ipc = makeIpc();
  const opened = [];
  registerBillingIpc({ ipcMain: ipc, gate, openExternal: async (u) => { opened.push(u); }, env, links });
  return { stand, gate, ipc, opened, close: () => stand.close() };
}

// ------------------------------------------------------------------ catalog / URL selection

test("catalog: prices and the four plans match the product spec", () => {
  const byId = Object.fromEntries(PLAN_CATALOG.map((p) => [p.id, p]));
  assert.deepEqual(Object.keys(byId), ["free", "premium", "premium_plus", "ultra_premium_plus"]);
  assert.equal(byId.premium.price + byId.premium.period, "$1.56/month");
  assert.equal(byId.premium_plus.price + byId.premium_plus.period, "$15.63/month");
  assert.equal(byId.ultra_premium_plus.price + byId.ultra_premium_plus.period, "$260.50/year");
});

test("catalog: the three Razorpay links are exactly the ones supplied, and Free has none", () => {
  assert.equal(checkoutUrl("premium", "razorpay", {}), "https://rzp.io/rzp/1qGVkgs");
  assert.equal(checkoutUrl("premium_plus", "razorpay", {}), "https://rzp.io/rzp/IYxbsSpB");
  assert.equal(checkoutUrl("ultra_premium_plus", "razorpay", {}), "https://rzp.io/rzp/e8TENhBn");
  assert.equal(checkoutUrl("free", "razorpay", {}), null);
});

test("catalog: Stripe is offered only when its https URL is configured - never invented, never http", () => {
  assert.equal(checkoutUrl("premium", "stripe", {}), null);
  assert.equal(checkoutUrl("premium", "stripe", { STRIPE_PREMIUM_URL: "http://pay.example/p" }), null, "plain http is refused");
  assert.equal(checkoutUrl("premium", "stripe", { STRIPE_PREMIUM_URL: "javascript:alert(1)" }), null);
  assert.equal(checkoutUrl("premium", "stripe", { STRIPE_PREMIUM_URL: "not a url" }), null);
  assert.equal(checkoutUrl("premium", "stripe", { STRIPE_PREMIUM_URL: "https://buy.stripe.com/test_x" }), "https://buy.stripe.com/test_x");
  const withStripe = publicCatalog({ STRIPE_PREMIUM_URL: "https://buy.stripe.com/test_x" });
  assert.deepEqual(withStripe.find((p) => p.id === "premium").providers, ["razorpay", "stripe"]);
  assert.deepEqual(withStripe.find((p) => p.id === "premium_plus").providers, ["razorpay"], "an unconfigured plan stays Razorpay-only");
  assert.deepEqual(publicCatalog({}).find((p) => p.id === "free").providers, []);
});

test("checkoutUrl: only catalog plan ids and known providers resolve - a page-supplied URL or odd key never does", () => {
  for (const bad of ["https://evil.example", "__proto__", "constructor", "", "Premium", "premium ", null, undefined, {}]) {
    assert.equal(checkoutUrl(bad, "razorpay", {}), null, String(bad));
  }
  assert.equal(checkoutUrl("premium", "paypal", {}), null);
  assert.equal(checkoutUrl("premium", "https://evil.example", {}), null);
});

test("the catalog shown to the page contains copy only - no payment URL it could open itself", () => {
  assert.doesNotMatch(JSON.stringify(publicCatalog({ STRIPE_PREMIUM_URL: "https://buy.stripe.com/test_x" })), /rzp\.io|stripe\.com|https?:/);
});

test("the catalog states nothing about paid-plan AI Chat allowance (undecided - must not be invented)", () => {
  for (const p of PLAN_CATALOG.filter((x) => x.id !== "free")) assert.ok(!p.features.some((f) => /chat/i.test(f)), p.id);
});

// ------------------------------------------------------------------ IPC behaviour

test("IPC: only a window's top-level frame may call billing handlers (a subframe or webview is refused)", withEnabled(async () => {
  const w = await setup();
  try {
    const bad = [{ sender: { getType: () => "webview" }, senderFrame: { parent: null } }, { sender: { getType: () => "window" }, senderFrame: { parent: {} } }, {}, null];
    for (const ev of bad) for (const ch of ["billing:status", "billing:plans", "billing:sign-in", "billing:sign-out", "billing:checkout"]) {
      assert.deepEqual(await w.ipc.call(ch, ev, "premium", "razorpay"), { ok: false, error: "not allowed" }, ch);
    }
    assert.equal(w.opened.length, 0);
  } finally { await w.close(); }
}));

test("IPC: billing:status reports signed-out, then signed-in with the server's entitlements after billing:sign-in", withEnabled(async () => {
  const w = await setup();
  try {
    assert.deepEqual(await w.ipc.call("billing:status", okSender), { ok: true, enabled: true, signedIn: false });
    assert.deepEqual(await w.ipc.call("billing:sign-in", okSender), { ok: true });
    const st = await w.ipc.call("billing:status", okSender);
    assert.equal(st.signedIn, true);
    assert.equal(st.entitlements.agent.remaining, 2);
    await w.ipc.call("billing:sign-out", okSender);
    assert.equal((await w.ipc.call("billing:status", okSender)).signedIn, false);
  } finally { await w.close(); }
}));

test("IPC: with the feature flag off, status says so and checkout refuses", async () => {
  process.env.JONAH_ENTITLEMENTS_ENABLED = "0"; // forces OFF even though the shipped config is on
  try { await flagOffBody(); } finally { delete process.env.JONAH_ENTITLEMENTS_ENABLED; }
});
async function flagOffBody() {
  const w = await setup();
  try {
    assert.deepEqual(await w.ipc.call("billing:status", okSender), { ok: true, enabled: false, signedIn: false });
    assert.equal((await w.ipc.call("billing:checkout", okSender, "premium", "razorpay")).ok, false);
    assert.equal(w.opened.length, 0);
  } finally { await w.close(); }
}

test("IPC: a failed sign-in returns the plain message and stays signed out", withEnabled(async () => {
  const stand = createStandInServer();
  const url = await stand.listen();
  const gate = createEntitlementGate({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "jonah-bill-")), safeStorage: keychain("k"), serverUrl: url, allowInsecureLoopback: true,
    openExternal: async (a) => { const u = new URL(a); await fetch(`${u.searchParams.get("redirect_uri")}?error=access_denied&state=${u.searchParams.get("state")}`); } });
  const ipc = makeIpc();
  registerBillingIpc({ ipcMain: ipc, gate, openExternal: async () => {}, env: {} });
  try {
    assert.deepEqual(await ipc.call("billing:sign-in", okSender), { ok: false, reason: "denied", message: "Sign-in was cancelled." });
    assert.equal((await ipc.call("billing:status", okSender)).signedIn, false);
  } finally { await stand.close(); }
}));

// ------------------------------------------------------------------ checkout

test("checkout: signed out -> refused, nothing opened, and the user is told to sign in so the purchase attaches to an account", withEnabled(async () => {
  const w = await setup();
  try {
    const r = await w.ipc.call("billing:checkout", okSender, "premium", "razorpay");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "sign_in_required");
    assert.equal(w.opened.length, 0);
  } finally { await w.close(); }
}));

test("checkout: signed in -> registers the intent with the server FIRST, then opens exactly the catalog's Razorpay link", withEnabled(async () => {
  const w = await setup();
  try {
    await w.ipc.call("billing:sign-in", okSender);
    const order = [];
    const realReq = w.gate.client._request.bind(w.gate.client);
    w.gate.client._request = async (m, p, b) => { order.push(p); return realReq(m, p, b); };
    const ipc = makeIpc();
    registerBillingIpc({ ipcMain: ipc, gate: w.gate, openExternal: async (u) => { order.push("open:" + u); }, env: {} });
    const r = await ipc.call("billing:checkout", okSender, "premium_plus", "razorpay");
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(order, ["/api/checkout/intent", "open:https://rzp.io/rzp/IYxbsSpB"]);
  } finally { await w.close(); }
}));

test("checkout: if the billing server cannot record the intent, the payment page is NOT opened (an unattributable payment is worse than none)", withEnabled(async () => {
  const w = await setup();
  try {
    await w.ipc.call("billing:sign-in", okSender);
    await w.stand.close();
    const r = await w.ipc.call("billing:checkout", okSender, "premium", "razorpay");
    assert.equal(r.ok, false);
    assert.match(r.error, /billing server/);
    assert.equal(w.opened.length, 0);
  } finally { /* already closed */ }
}));

test("checkout: a page-supplied URL, unknown plan, Free plan, or unconfigured Stripe all refuse without opening anything", withEnabled(async () => {
  const w = await setup();
  try {
    await w.ipc.call("billing:sign-in", okSender);
    for (const [plan, prov] of [["https://evil.example/pay", "razorpay"], ["free", "razorpay"], ["nope", "razorpay"], ["premium", "stripe"], ["premium", "https://evil.example"], ["premium", "paypal"]]) {
      const r = await w.ipc.call("billing:checkout", okSender, plan, prov);
      assert.equal(r.ok, false, `${plan}/${prov}`);
    }
    assert.equal(w.opened.length, 0);
  } finally { await w.close(); }
}));

test("checkout: Stripe opens its configured link tagged with the checkout claim's id (client_reference_id), after registering that claim", withEnabled(async () => {
  const w = await setup({ env: { STRIPE_ULTRA_PREMIUM_PLUS_URL: "https://buy.stripe.com/test_ultra" } });
  try {
    await w.ipc.call("billing:sign-in", okSender);
    assert.deepEqual(await w.ipc.call("billing:checkout", okSender, "ultra_premium_plus", "stripe"), { ok: true });
    assert.equal(w.opened.length, 1);
    const u = new URL(w.opened[0]);
    assert.equal(u.origin + u.pathname, "https://buy.stripe.com/test_ultra");
    assert.match(u.searchParams.get("client_reference_id"), /^[A-Za-z0-9_-]{1,200}$/, "the intent id, in the only alphabet Stripe keeps");
  } finally { await w.close(); }
}));

test("Stripe links: only https://buy.stripe.com is accepted - no other host, http, credentials or port", () => {
  const { validStripeLink } = require("../../../billing.cjs");
  assert.equal(validStripeLink("https://buy.stripe.com/test_abc"), "https://buy.stripe.com/test_abc");
  assert.equal(validStripeLink("https://buy.stripe.com/abc123?prefilled_promo_code=X"), "https://buy.stripe.com/abc123?prefilled_promo_code=X");
  for (const bad of ["http://buy.stripe.com/x", "https://stripe.com/x", "https://buy.stripe.com.evil.example/x", "https://evil.example/buy.stripe.com", "https://user:pw@buy.stripe.com/x", "https://buy.stripe.com:8443/x", "javascript:alert(1)", "", null, undefined, 42]) {
    assert.equal(validStripeLink(bad), null, String(bad));
  }
});

test("Stripe links come from the shipped billing-links.config.json (a packaged build has no env vars); the env var wins when set; null/garbage hides the button", () => {
  const links = { stripe: { premium: "https://buy.stripe.com/cfg_premium", premium_plus: null, ultra_premium_plus: "https://evil.example/x" } };
  assert.equal(checkoutUrl("premium", "stripe", {}, links), "https://buy.stripe.com/cfg_premium");
  assert.equal(checkoutUrl("premium", "stripe", { STRIPE_PREMIUM_URL: "https://buy.stripe.com/env_premium" }, links), "https://buy.stripe.com/env_premium");
  assert.equal(checkoutUrl("premium_plus", "stripe", {}, links), null, "an empty slot = no Stripe button");
  assert.equal(checkoutUrl("ultra_premium_plus", "stripe", {}, links), null, "a non-Stripe host in the file is ignored");
  const cat = publicCatalog({}, links);
  assert.deepEqual(cat.find((p) => p.id === "premium").providers, ["razorpay", "stripe"]);
  assert.deepEqual(cat.find((p) => p.id === "premium_plus").providers, ["razorpay"]);
  assert.deepEqual(cat.find((p) => p.id === "ultra_premium_plus").providers, ["razorpay"]);
});

test("billing-links.config.json carries exactly the three Stripe links supplied, each valid; loadLinks tolerates a missing or garbled file", () => {
  const { loadLinks, validStripeLink } = require("../../../billing.cjs");
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../billing-links.config.json"), "utf8"));
  assert.deepEqual(shipped.stripe, {
    premium: "https://buy.stripe.com/00waEXcTE8wibeYdBp0Ny00",
    premium_plus: "https://buy.stripe.com/7sYdR9g5Q6oa82MdBp0Ny01",
    ultra_premium_plus: "https://buy.stripe.com/dRm28r9HsaEq2IsdBp0Ny02",
  });
  for (const v of Object.values(shipped.stripe)) assert.equal(validStripeLink(v), v);
  assert.deepEqual(publicCatalog({}, shipped).filter((p) => p.providers.includes("stripe")).map((p) => p.id), ["premium", "premium_plus", "ultra_premium_plus"], "all three paid plans show a Stripe button");
  assert.doesNotMatch(JSON.stringify(shipped), /sk_|whsec_|rk_/, "no Stripe secret belongs in this file");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-links-"));
  assert.deepEqual(loadLinks(path.join(d, "missing.json")), {});
  fs.writeFileSync(path.join(d, "bad.json"), "{nope");
  assert.deepEqual(loadLinks(path.join(d, "bad.json")), {});
});

test("withClientReference: adds the id only when Stripe would keep it (letters, digits, - _ up to 200), and keeps existing query params", () => {
  const { withClientReference } = require("../../../billing.cjs");
  assert.equal(withClientReference("https://buy.stripe.com/x", "abc-123_DEF"), "https://buy.stripe.com/x?client_reference_id=abc-123_DEF");
  assert.equal(withClientReference("https://buy.stripe.com/x?locale=en", "id1"), "https://buy.stripe.com/x?locale=en&client_reference_id=id1");
  for (const bad of ["has space", "semi;colon", "a&b=c", "x".repeat(201), "", null, undefined]) assert.equal(withClientReference("https://buy.stripe.com/x", bad), "https://buy.stripe.com/x", String(bad));
});
