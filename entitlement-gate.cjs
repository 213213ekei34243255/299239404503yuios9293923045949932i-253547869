// entitlement-gate.cjs — the ONE place every gated feature (Agent, Trust Engine, attachments, Chat) asks "am I allowed to do this
// right now". It never decides on its own: every call goes through entitlement-client.cjs to noahai.live, live, every time. See that
// module's own header for why a network failure is always a refusal, never a silent allow.
//
// ROLLOUT SAFETY: this only enforces anything when JONAH_ENTITLEMENTS_ENABLED=1 is set. Until noahai.live's real entitlement endpoints
// exist and are confirmed working, every gate() call passes through unconditionally - the existing app keeps working exactly as it does
// today. Flip the flag on once the backend is live and tested; nothing here should be "on" by silent default before then.
"use strict";
const path = require("path");
const { createEntitlementDeviceStore } = require("./entitlement-device.cjs");
const { EntitlementClient, createSessionStore, DEFAULT_BASE } = require("./entitlement-client.cjs");
const { looksLikeBrowserTask, controlOf } = require("./Noah/agent/intent.cjs");

/**
 * Predicts which feature a rexy:goal call will become, WITHOUT calling into RexyRuntime/Noah's real router (which has side effects -
 * e.g. actually executing "stop"). This mirrors Rexy/runtime.cjs submitGoal's own classification order as closely as a side-effect-free
 * prediction can:
 *   1. an explicit mode ("chat"/"agent" - the user's own UI toggle) is unambiguous and always honoured as given.
 *   2. "auto": a recognised control word ("continue"/"stop"/"pause"...) on an existing session is free - not a new Agent use.
 *   3. "auto", otherwise: Noah/agent/intent.cjs's own looksLikeBrowserTask - the exact function submitGoal itself uses for this case.
 *
 * OPEN ITEM, by design not silently guessed further: Noah's real router can also treat a short fragment as a FOLLOW-UP continuation of
 * the task already in front of the user (Noah/agent/intent.cjs's isFollowUp), and when Noah is configured its command router may make
 * a different call than this prediction for edge cases this function cannot see without the side effects of actually routing. A
 * mismatch here is a usage-accounting ACCURACY question, never a security one: the server independently counts whatever is actually
 * submitted as "agent" usage regardless of what this function predicted, so nothing can be bypassed by it being wrong.
 */
function classifyGoal(goal, mode, { hasAttachments = false } = {}) {
  if (mode === "chat" || mode === "agent") return mode;
  if (controlOf(goal)) return "control"; // free: steering an already-running/paused task, not a new use
  // mirrors submitGoal's own one extra "auto" override: attached files + text that clearly refers to them means chat, even if the
  // wording would otherwise look like a browser task ("answer the questions in the attached file" reads like ACT_ON_PAGE text).
  if (hasAttachments && require("./attachments.cjs").referencesAttachment(goal)) return "chat";
  return looksLikeBrowserTask(goal) ? "agent" : "chat";
}

/**
 * Is billing enforcement on? The env var wins when set ("1" on, "0" off) - handy for development and tests. Otherwise the app's own
 * entitlements.config.json decides, which is how a PACKAGED build (where users have no env vars) is switched on: edit the file to
 * {"enabled": true} before building. A missing, unreadable or malformed file means OFF.
 */
function entitlementsEnabled({ env = process.env, configFile = path.join(__dirname, "entitlements.config.json") } = {}) {
  if (env.JONAH_ENTITLEMENTS_ENABLED === "1") return true;
  if (env.JONAH_ENTITLEMENTS_ENABLED === "0") return false;
  try { return JSON.parse(require("fs").readFileSync(configFile, "utf8")).enabled === true; } catch { return false; }
}

function createEntitlementGate({ userDataDir, safeStorage, openExternal, serverUrl = process.env.JONAH_ENTITLEMENTS_URL || DEFAULT_BASE, allowInsecureLoopback = false, googleClientId, signInTimeoutMs, configFile, log = () => {} }) {
  const enabled = entitlementsEnabled({ configFile });
  const device = createEntitlementDeviceStore({ dir: path.join(userDataDir, "entitlement"), safeStorage });
  const sessionStore = createSessionStore({ file: path.join(userDataDir, "entitlement", "entitlement-session.json") });
  const client = new EntitlementClient({ serverUrl, device, allowInsecureLoopback, googleClientId, signInTimeoutMs, sessionStore, log });

  /**
   * Opens the user's real browser for Google sign-in. Called ONLY from an explicit user-facing step (the sign-in screen / a "Sign in"
   * button) - never implicitly from inside gate(), so a gated action can't surprise the user with a browser window mid-task.
   */
  async function signIn(opts = {}) {
    if (!enabled) return { ok: true, bypass: "entitlements_disabled" };
    if (client.signedIn) return { ok: true, accountId: client.accountId };
    const r = await client.loginWithGoogle({ openExternal, ...opts });
    log(r.ok ? "signed in" : `sign-in failed: ${r.reason}${r.message ? " (" + r.message + ")" : ""}`);
    return r.ok ? r : { ...r, message: signInMessage(r.reason) };
  }

  /**
   * The single gate call. `feature` is "agent" | "trust-engine" | "attachment" | "chat"; "control" is never gated (free).
   * Returns { allowed: true, remaining, cooldownUntil } or { allowed: false, reason, message, cooldownUntil, plan } - `message` is
   * plain text ready to show the user (see blockedFeatureMessage), never raw server internals. Not signed in => `sign_in_required`.
   */
  async function gate(feature, extra = {}) {
    if (!enabled) return { allowed: true, bypass: "entitlements_disabled" };
    if (feature === "control") return { allowed: true };
    if (!client.signedIn) return { allowed: false, reason: "sign_in_required", message: blockedFeatureMessage(feature, { reason: "sign_in_required" }) };
    const r = await client.consumeUsage(feature, extra);
    if (r.authorized) return { allowed: true, remaining: r.remaining, cooldownUntil: r.cooldownUntil };
    log(`refused ${feature}: reason=${r.reason} plan=${r.plan || "?"} cooldownUntil=${r.cooldownUntil || "-"}`);
    return { allowed: false, reason: r.reason, cooldownUntil: r.cooldownUntil || null, plan: r.plan, message: blockedFeatureMessage(feature, r) };
  }

  return { enabled, device, client, classifyGoal, gate, signIn };
}

const FEATURE_LABEL = { agent: "AI Agent", "trust-engine": "Trust Engine", attachment: "Attachments", chat: "AI Chat" };

function signInMessage(reason) {
  switch (reason) {
    case "denied": return "Sign-in was cancelled.";
    case "timeout": return "Sign-in timed out. Please try again.";
    case "state_mismatch": return "That sign-in attempt was not valid. Please try again.";
    case "account_suspended": return "This account has been suspended. Contact Customer Care Service if you think this is a mistake.";
    case "server_unreachable": return "Cannot reach the authorization server. Check your internet connection and try again.";
    case "rate_limited": return "Too many sign-in attempts. Please wait a few minutes and try again.";
    case "invalid_id_token":
    case "token_exchange_failed": return "Google sign-in could not be verified. Please try again.";
    case "not_configured": return "The authorization server address is not configured securely.";
    default: return "Sign-in could not be completed. Please try again.";
  }
}

function blockedFeatureMessage(feature, r) {
  const label = FEATURE_LABEL[feature] || feature;
  switch (r.reason) {
    case "sign_in_required": return `Sign in with Google to use ${label}.`;
    case "server_unreachable": return "Cannot reach the authorization server. Check your internet connection and try again.";
    case "account_suspended": return "This account has been suspended. Contact Customer Care Service if you think this is a mistake.";
    case "subscription_expired": return `Your subscription has expired. Renew to keep using ${label}.`;
    case "lifetime_exhausted": return `${label} limit reached. Your free lifetime trials are used up. Upgrade to continue.`;
    default: break;
  }
  if ((r.reason === "cooldown" || r.reason === "daily_limit") && r.cooldownUntil) {
    const mins = Math.max(1, Math.round((r.cooldownUntil * 1000 - Date.now()) / 60000));
    const h = Math.floor(mins / 60), m = mins % 60;
    return `${label} limit reached. Available again in ${h > 0 ? `${h}h ${m}m` : `${m}m`}. Upgrade or purchase additional usage to continue.`;
  }
  return `${label} limit reached. Upgrade or purchase additional usage to continue.`;
}

module.exports = { createEntitlementGate, entitlementsEnabled, classifyGoal, blockedFeatureMessage, signInMessage };
