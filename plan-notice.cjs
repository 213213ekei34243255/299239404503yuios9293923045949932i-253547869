// plan-notice.cjs - the words for "your paid plan ended, so you are back on Free until you pay again".
//
// The rule itself lives on noahai.live (it decides the plan on every request: when a paid period is over without a new payment the account is simply on Free again, and a
// new payment puts the paid plan back). This file only says it to the user, from what the server sent: `previousPlan` and `expiredAt` are OPTIONAL, and nothing here
// authorizes or changes anything. See Noah/docs/backend-prompt-plan-expiry.txt for what the server is asked to do.
"use strict";

const { toUnixSeconds } = require("./entitlement-client.cjs");

const NAMES = { free: "Free", premium: "Premium", premium_plus: "Premium Plus", ultra_premium_plus: "Ultra Premium Plus" };

function planName(id) {
  if (typeof id === "string" && NAMES[id]) return NAMES[id];
  return typeof id === "string" && /^[A-Za-z0-9 _-]{1,40}$/.test(id) ? id.replace(/_/g, " ") : "paid";
}

/** "12 Oct 2026" from unix seconds or an ISO date; "" when it is not a date. (UTC, so the day does not depend on where the computer is.) */
function dayOf(v) {
  const sec = toUnixSeconds(v);
  if (!Number.isFinite(sec) || sec <= 0) return "";
  try { return new Date(sec * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }); } catch (_) { return ""; }
}

function endedSentence({ previousPlan, expiredAt } = {}) {
  const when = dayOf(expiredAt);
  return `Your ${planName(previousPlan)} plan ended${when ? ` on ${when}` : ""}, so your account is back on Free until you pay again.`;
}

/** For the Plans page: the notice for the entitlements the server last sent, or "" when the plan has not ended (or is paid again). */
function planNotice(ent) {
  if (!ent || typeof ent !== "object") return "";
  const ended = ent.subscriptionStatus === "expired" || (typeof ent.previousPlan === "string" && ent.previousPlan !== "");
  if (!ended || (ent.plan && ent.plan !== "free")) return "";
  return endedSentence(ent);
}

module.exports = { endedSentence, planNotice, planName, dayOf };
