// Noah/safety/risk.cjs
//
// Classifies how consequential ONE action is, from facts the code can observe
// (action type, the element actually under the pointer, page/origin context,
// task taint) plus the model's declared intent. The model's claims can only
// RAISE risk, never lower it: effective = max(code_computed, model_declared).
//
// Levels: low < medium < high < blocked.

"use strict";

const LEVELS = ["low", "medium", "high", "blocked"];
const rank = (l) => LEVELS.indexOf(l);
const max = (a, b) => (rank(a) >= rank(b) ? a : b);

// Label vocabularies (matched against element text/name AND the model's `intent`).
const PURCHASE_FINAL = /\b(buy now|place (?:your |the )?order|complete (?:the )?(?:purchase|order|payment)|confirm (?:the )?(?:order|purchase|payment)|pay(?: now| securely)?|purchase|order now|submit order|book now|confirm booking|reserve now|subscribe|start (?:my )?(?:free )?trial|donate|send money|transfer funds?|make payment)\b/i;
const CHECKOUT_STEP = /\b(proceed to (?:checkout|payment)|checkout|go to payment|continue to payment|add payment|enter card)\b/i;
const SEND_PUBLISH = /\b(send(?: message| email| mail)?|post(?: comment| reply)?|publish|tweet|share|reply|comment|forward|submit (?:review|comment|post)|go live|broadcast)\b/i;
const DELETE_LIKE = /\b(delete|remove|erase|trash|discard|clear (?:all|history|data|cache)|close account|deactivate|terminate|cancel (?:subscription|order|account|membership)|wipe|permanently)\b/i;
const SECURITY_LIKE = /\b(change (?:your )?password|update password|reset password|new password|security settings?|two[- ]factor|2fa|mfa|api keys?|access tokens?|revoke|authori[sz]e|grant access|allow access|connect account|link account|manage permissions?|sign out everywhere|recovery (?:email|phone|codes?))\b/i;
const CONSENT_LIKE = /\b(i agree|accept (?:all )?(?:terms|cookies|conditions|policy)|agree and continue|accept and continue|accept all|allow all|consent)\b/i;
const PERMISSION_PROMPT = /\b(allow|enable) (?:notifications?|location|camera|microphone|access)\b/i;
const LOGIN_LIKE = /\b(log ?in|sign ?in|authenticate|verify)\b/i;
const ADD_TO_CART = /\b(add to (?:cart|basket|bag)|save for later|wishlist|add to list)\b/i;

const SENSITIVE_DOMAIN = /(^|\.)(paypal|stripe|venmo|wise|revolut|coinbase|binance|kraken|robinhood|chase|bankofamerica|wellsfargo|citibank|hsbc|barclays|sbi\.co|hdfcbank|icicibank|axisbank|kotak|paytm|phonepe|razorpay|gpay|zelle|schwab|fidelity|vanguard|americanexpress|capitalone)\.|(^|\.)([a-z0-9-]*bank[a-z0-9-]*)\.|^(accounts\.google\.com|myaccount\.google\.com|login\.live\.com|account\.microsoft\.com|appleid\.apple\.com|id\.apple\.com|mail\.google\.com|outlook\.live\.com|outlook\.office\.com|passwords\.google\.com)$/i;

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}

function labelOf(ctx) {
  const el = ctx.element || {};
  return [el.text, el.name, el.label, ctx.action?.target?.text, ctx.action?.intent, ctx.action?.reason].filter(Boolean).join(" | ").slice(0, 400);
}

/**
 * @param {object} ctx
 * @param {object} ctx.action        validated action
 * @param {object} [ctx.element]     { role, name, text, type, href, isPassword, formHasPassword, formAction } for the actual target
 * @param {object} [ctx.page]        { url, origin, hasPassword, hasPayment }
 * @param {boolean} [ctx.tainted]
 * @param {boolean} [ctx.clipboardOwned]  Noah copied the clipboard content itself
 * @param {boolean} [ctx.focusInSecret]   keyboard focus is inside a password/payment field
 * @param {boolean} [ctx.originChange]    navigation target origin differs from current
 * @param {object}  [ctx.config]
 * @returns {{ level: string, categories: string[], reasons: string[] }}
 */
function classifyRisk(ctx) {
  const { action, page = {}, config = {} } = ctx;
  const categories = [];
  const reasons = [];
  let level = "low";
  const raise = (l, cat, why) => {
    level = max(level, l);
    if (cat && !categories.includes(cat)) categories.push(cat);
    if (why) reasons.push(why);
  };
  const label = labelOf(ctx);
  const host = hostOf(page.url);
  const sensitiveDomain = SENSITIVE_DOMAIN.test(host);
  const spec = require("../protocol/actions.cjs").ACTIONS[action.action] || {};

  // ---- read-only actions never mutate anything
  if (!spec.mutates && !["scroll", "hover", "move"].includes(action.action) && action.action !== "download_file") {
    return { level: "low", categories, reasons };
  }

  // ---- credential and payment entry: Noah does not type secrets
  if (action.action === "type" || action.action === "form_input" || action.action === "paste" || action.action === "key_press") {
    const el = ctx.element || {};
    if (el.isPassword || ctx.focusInSecret || (el.type === "password")) {
      if (action.action === "key_press" && !/^[a-z0-9]$/i.test(action.key || "")) {
        /* navigation keys inside a password field are harmless */
      } else {
        raise("blocked", "credential_entry", "Noah never types into password or payment fields. Ask the user to enter it themselves (ask_user), then continue.");
      }
    }
  }

  // ---- text typed by the model that looks like a secret
  if (action.action === "type" && typeof action.text === "string") {
    if (/\b(?:\d[ -]?){13,19}\b/.test(action.text) && luhn(action.text.replace(/\D/g, ""))) raise("blocked", "payment_card", "Text looks like a payment card number");
    if (/\b\d{3}-\d{2}-\d{4}\b/.test(action.text)) raise("high", "government_id", "Text looks like an SSN");
    if (/(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})/.test(action.text)) raise("blocked", "secret_material", "Text looks like an API key or token");
  }

  // ---- what is being clicked / submitted
  const clicking = ["click", "double_click", "right_click", "mouse_up"].includes(action.action);
  const submitting = (action.action === "key_press" && /^(enter|return)$/i.test(action.key || "")) || (action.action === "type" && action.submit);
  if (clicking || submitting || action.action === "form_input") {
    const isAddToCart = ADD_TO_CART.test(label);
    if (PURCHASE_FINAL.test(label) && !isAddToCart) raise("high", "purchase", `Looks like a purchase/payment action: "${label.slice(0, 80)}"`);
    else if (CHECKOUT_STEP.test(label) && !isAddToCart) raise("medium", "checkout_step", `Checkout step: "${label.slice(0, 80)}"`);
    if (SEND_PUBLISH.test(label) && !/^search|find|sort|filter|share link$/i.test(label.trim())) {
      const el = ctx.element || {};
      if (!el.role || /button|submit|link/i.test(el.role + " " + (el.tag || "")) || el.type === "submit" || submitting) raise("high", "send_publish", `Sends or publishes content: "${label.slice(0, 80)}"`);
    }
    if (DELETE_LIKE.test(label)) raise("high", "destructive", `Destructive action: "${label.slice(0, 80)}"`);
    if (SECURITY_LIKE.test(label)) raise("high", "security_setting", `Account/security change: "${label.slice(0, 80)}"`);
    if (CONSENT_LIKE.test(label)) raise("medium", "consent", `Accepting terms/cookies: "${label.slice(0, 80)}"`);
    if (PERMISSION_PROMPT.test(label)) raise("medium", "permission_grant", `Granting a permission: "${label.slice(0, 80)}"`);
    if (LOGIN_LIKE.test(label) && (page.hasPassword || ctx.element?.formHasPassword)) raise("medium", "login", "Submitting a login form");
    if ((submitting || (ctx.element?.type === "submit")) && (page.hasPayment || ctx.element?.formHasPayment)) raise("high", "payment_form_submit", "Submitting a form that contains payment fields");
    else if ((submitting || ctx.element?.type === "submit") && (page.hasPassword || ctx.element?.formHasPassword)) raise("medium", "sensitive_form_submit", "Submitting a form that contains a password field");
  }

  // ---- files
  if (action.action === "upload_file") raise("high", "file_upload", `Uploads a local file: ${action.path}`);
  if (action.action === "download_file") {
    const require_ = require("./url-guard.cjs");
    if (require_.isExecutableDownload(action.url || ctx.element?.href || label)) raise("blocked", "executable_download", "Executable/installer downloads are not allowed");
    else raise("medium", "download", "Downloads a file to this computer");
  }
  if (action.action === "paste" && !ctx.clipboardOwned) raise("high", "foreign_clipboard", "Clipboard content was not copied by Noah in this task (could be the user's private data)");

  // ---- closing a tab the user opened is destructive (their work may be in it)
  if (action.action === "close_tab" && ctx.tabOwned === false) raise("high", "destructive", `Closes a tab you opened: "${(ctx.element?.text || "").slice(0, 60)}"`);

  // ---- navigation
  if (action.action === "navigate" || action.action === "new_tab") {
    if (ctx.originChange && ctx.tainted) raise("high", "tainted_navigation", "Page content contained instruction-like text and this navigates to a different site");
    else if (ctx.originChange && sensitiveDomain) raise("medium", "leaves_sensitive_site", "Leaves a sensitive site");
  }

  // ---- domain context
  if (sensitiveDomain && (clicking || submitting || action.action === "type" || action.action === "form_input")) {
    raise("medium", "sensitive_domain", `Acting on a sensitive site (${host})`);
  }

  // ---- taint: transmitting actions after injection-like content need a human
  if (ctx.tainted) {
    if (["type", "paste", "form_input", "upload_file", "download_file"].includes(action.action)) raise("high", "tainted_transmit", "The page contained instruction-like content; transmitting data needs confirmation");
    else if (clicking || submitting) raise("medium", "tainted_interaction", "The page contained instruction-like content");
  }

  // ---- model-declared intent may only raise
  const intent = String(action.intent || "");
  if (intent) {
    if (PURCHASE_FINAL.test(intent)) raise("high", "purchase", `Model declared intent: ${intent}`);
    if (DELETE_LIKE.test(intent) || SECURITY_LIKE.test(intent) || SEND_PUBLISH.test(intent)) raise("high", "declared_consequential", `Model declared intent: ${intent}`);
  }

  // vision/coordinate clicks with no readable label on a page with sensitive fields
  if (clicking && !ctx.element?.text && !ctx.element?.name && (page.hasPayment || page.hasPassword)) raise("medium", "unlabeled_on_sensitive_page", "Unlabelled click on a page with payment/password fields");

  return { level, categories, reasons };
}

function luhn(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = +digits[i];
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

module.exports = { classifyRisk, LEVELS, rank, max, SENSITIVE_DOMAIN, luhn };
