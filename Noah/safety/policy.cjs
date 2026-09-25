// Noah/safety/policy.cjs
//
// Turns a risk classification into a decision under the user's confirmation
// policy. "Autonomous where safe, confirm where consequential."
//
//   autonomous  confirm HIGH; allow medium/low (medium is logged)
//   supervised  confirm MEDIUM and HIGH
//   strict      confirm every state-changing action
//
// Independent of mode: BLOCKED is always denied; categories in
// ALWAYS_CONFIRM are confirmed even in `autonomous`.

"use strict";

const { rank } = require("./risk.cjs");

const MODES = ["autonomous", "supervised", "strict"];
const ALWAYS_CONFIRM = new Set(["purchase", "send_publish", "destructive", "security_setting", "file_upload", "payment_form_submit", "foreign_clipboard", "tainted_transmit", "tainted_navigation"]);

const DEFAULT_POLICY = Object.freeze({
  mode: "autonomous",
  confirmTimeoutMs: 120_000,
  allowCredentialTyping: false,
  allowLocalhost: false,
  allowedDomains: [],
  blockedDomains: [],
  confirmAlwaysDomains: [], // any state-changing action on these hosts needs confirmation
});

function decide(risk, { mode = "autonomous", action, mutates = true, hostConfirmAlways = false } = {}) {
  const m = MODES.includes(mode) ? mode : "autonomous";
  if (risk.level === "blocked") return { decision: "deny", why: risk.reasons[0] || "blocked by policy" };
  const forced = risk.categories.some((c) => ALWAYS_CONFIRM.has(c));
  if (forced || rank(risk.level) >= rank("high")) return { decision: "confirm", why: risk.reasons[0] || "consequential action" };
  if (hostConfirmAlways && mutates) return { decision: "confirm", why: "This site requires confirmation for every change" };
  if (m === "supervised" && rank(risk.level) >= rank("medium")) return { decision: "confirm", why: risk.reasons[0] || "supervised mode" };
  if (m === "strict" && mutates) return { decision: "confirm", why: "strict mode confirms every change" };
  return { decision: "allow", why: risk.level === "medium" ? `allowed (medium): ${risk.reasons[0] || ""}` : "low risk" };
}

module.exports = { decide, MODES, ALWAYS_CONFIRM, DEFAULT_POLICY };
