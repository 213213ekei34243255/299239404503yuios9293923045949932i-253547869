// billing.cjs — the main-process side of "Plans & Billing" and Google sign-in. The renderer only ever asks for things by NAME (a plan id,
// a provider name); it never supplies a URL. Every checkout link comes from the catalog below (or an https env var for Stripe), so a
// compromised page cannot make Jonah open an attacker's "payment" page, and nothing here ever holds a payment secret: Razorpay payment
// links and Stripe checkout links are public by design, and the webhook secrets live only on noahai.live.
//
// Entitlements shown here are INFORMATIONAL (what the server last said). Authorization is only ever decided per action by
// entitlement-gate.cjs / noahai.live - see entitlement-client.cjs.
"use strict";
const fs = require("fs");
const path = require("path");

// Display copy for the plans, taken from the product spec. The numbers here are what the page SHOWS; the server is what ENFORCES them,
// so a mismatch can only mislead a label, never grant access. AI Chat allowance for paid plans is deliberately not stated: it is a
// backend-configured value that has not been decided, and this page must not invent it.
const PLAN_CATALOG = [
  { id: "free", name: "Free", price: "$0", period: "", features: ["AI Agent: 2 trials (lifetime)", "Trust Engine: 3 uses, then a 24-hour cooldown", "Attachments: 5 uses, then a 48-hour cooldown", "AI Chat: 2 hours per day"] },
  { id: "premium", name: "Premium", price: "$1.56", period: "/month", razorpay: "https://rzp.io/rzp/1qGVkgs", stripeEnv: "STRIPE_PREMIUM_URL", features: ["AI Agent: 3 uses, then a 36-hour cooldown", "Trust Engine: 8 uses, then a 12-hour cooldown", "Attachments: 10 uses, then a 15-hour cooldown"] },
  { id: "premium_plus", name: "Premium Plus", price: "$15.63", period: "/month", razorpay: "https://rzp.io/rzp/IYxbsSpB", stripeEnv: "STRIPE_PREMIUM_PLUS_URL", features: ["AI Agent: 15 uses, then a 24-hour cooldown", "Trust Engine: 20 uses, then a 6-hour cooldown", "Attachments: 25 per day, resetting at 12:00 AM"] },
  { id: "ultra_premium_plus", name: "Ultra Premium Plus", price: "$260.50", period: "/year", razorpay: "https://rzp.io/rzp/e8TENhBn", stripeEnv: "STRIPE_ULTRA_PREMIUM_PLUS_URL", features: ["AI Agent: 20 uses, then a 6-hour cooldown", "Trust Engine: 30 uses, then a 3-hour cooldown", "Attachments: unlimited", "Early access to new features"] },
];
const PAID_IDS = new Set(PLAN_CATALOG.filter((p) => p.razorpay).map((p) => p.id));
const RAZORPAY_LINK = /^https:\/\/rzp\.io\/rzp\/[A-Za-z0-9]{4,32}$/;

// Stripe Payment Links live on buy.stripe.com (test-mode links too). Anything else - another host, http, credentials in the URL - is refused.
function validStripeLink(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.hostname !== "buy.stripe.com" || u.username || u.password || u.port) return null;
    return u.href;
  } catch { return null; }
}

/**
 * The Stripe link for a plan: the shipped billing-links.config.json (how a PACKAGED build gets it - users have no env vars), or the
 * plan's STRIPE_*_URL env var, which wins when set (development). null = not configured = no Stripe button.
 */
function stripeUrlFor(plan, env, links) {
  const fromEnv = plan.stripeEnv && env[plan.stripeEnv];
  return validStripeLink(fromEnv || (links && links.stripe && links.stripe[plan.id]));
}

function loadLinks(file = path.join(__dirname, "billing-links.config.json")) {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}

/** What the Plans page may show: copy plus which providers are actually available. Never contains a URL the page could open itself. */
function publicCatalog(env = process.env, links = {}) {
  return PLAN_CATALOG.map((p) => ({
    id: p.id, name: p.name, price: p.price, period: p.period, features: p.features,
    providers: p.razorpay ? ["razorpay", ...(stripeUrlFor(p, env, links) ? ["stripe"] : [])] : [],
  }));
}

/** The one place a checkout URL is chosen. Returns null for anything not in the catalog. */
function checkoutUrl(planId, provider, env = process.env, links = {}) {
  const plan = PLAN_CATALOG.find((p) => p.id === planId);
  if (!plan || !PAID_IDS.has(plan.id)) return null;
  if (provider === "razorpay") return RAZORPAY_LINK.test(plan.razorpay) ? plan.razorpay : null;
  if (provider === "stripe") return stripeUrlFor(plan, env, links);
  return null;
}

/**
 * Stripe Payment Links accept ?client_reference_id=..., which Stripe hands back in the checkout.session.completed webhook - an EXACT
 * link between this payment and the checkout claim registered with noahai.live (unlike Razorpay's static links, which can't carry one).
 * Stripe allows only letters, digits, - and _ (max 200); anything else would be silently dropped by Stripe, so don't send it.
 */
function withClientReference(url, intentId) {
  if (typeof intentId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(intentId)) return url;
  const u = new URL(url);
  u.searchParams.set("client_reference_id", intentId);
  return u.href;
}

const trustedSender = (e) => Boolean(e && e.sender && e.senderFrame && e.senderFrame.parent === null && e.sender.getType && e.sender.getType() === "window");

/**
 * @param {{ipcMain, gate, openExternal:(url:string)=>Promise<void>, env?:object, log?:Function}} deps  gate = entitlement-gate.cjs's gate object
 */
function registerBillingIpc({ ipcMain, gate, openExternal, env = process.env, links, linksFile, log = () => {} }) {
  const readLinks = () => links || loadLinks(linksFile); // re-read per call unless injected: editing the file needs no code change
  const guard = (fn) => async (e, ...a) => (trustedSender(e) ? fn(e, ...a) : { ok: false, error: "not allowed" });

  ipcMain.handle("billing:status", guard(async () => {
    if (!gate.enabled) return { ok: true, enabled: false, signedIn: false };
    if (!gate.client.signedIn) return { ok: true, enabled: true, signedIn: false };
    const r = await gate.client.getEntitlements();
    return { ok: true, enabled: true, signedIn: true, entitlements: r.ok ? r.entitlements : null, entitlementsError: r.ok ? null : r.reason };
  }));

  ipcMain.handle("billing:plans", guard(async () => ({ ok: true, plans: publicCatalog(env, readLinks()) })));

  ipcMain.handle("billing:sign-in", guard(async () => {
    const r = await gate.signIn();
    return r.ok ? { ok: true } : { ok: false, reason: r.reason, message: r.message };
  }));

  ipcMain.handle("billing:sign-out", guard(async () => { gate.client.signOut(); return { ok: true }; }));

  ipcMain.handle("billing:checkout", guard(async (_e, plan, provider) => {
    if (!gate.enabled) return { ok: false, error: "Billing is not enabled yet." };
    if (!gate.client.signedIn) return { ok: false, reason: "sign_in_required", error: "Sign in with Google before buying a plan, so the purchase is attached to your account." };
    let url = checkoutUrl(String(plan), String(provider), env, readLinks());
    if (!url) return { ok: false, error: "That payment option is not available." };
    // Razorpay's static links cannot carry our account id, so stake a short-lived claim first and let the server match the payment to
    // it. Without the claim the payment could not be attributed safely - so don't open the link at all if the server can't be reached.
    const intent = await gate.client.createCheckoutIntent(String(plan), String(provider));
    if (!intent.ok) return { ok: false, reason: intent.reason, error: "Could not reach the billing server. Check your connection and try again." };
    if (provider === "stripe") url = withClientReference(url, intent.intentId); // exact attribution for Stripe (see withClientReference)
    try { await openExternal(url); } catch (err) { log("could not open checkout:", err && err.message); return { ok: false, error: "Could not open your browser." }; }
    return { ok: true };
  }));
}

module.exports = { registerBillingIpc, publicCatalog, checkoutUrl, withClientReference, validStripeLink, loadLinks, PLAN_CATALOG };
