// billing-panel.js
//
// "Plans & Billing" and Google sign-in, in the browser shell. Everything the server or the plan catalog says is set with textContent
// (never innerHTML). This page never sees or chooses a payment URL: it names a plan and a provider and the main process opens the
// matching link (billing.cjs), after registering the checkout claim with noahai.live.
//
// Nothing here authorizes anything: what a plan allows is enforced by noahai.live on every gated action. This is the display.

"use strict";

(function () {
  const api = window.api && window.api.billing;
  if (!api) return;

  const css = `
  #billingOverlay{position:fixed;inset:0;z-index:2147483000;background:rgba(8,6,14,.72);backdrop-filter:blur(6px);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:48px 16px;font-family:Arial,sans-serif}
  #billingOverlay.hidden{display:none}
  .bl-box{width:min(1040px,100%);background:#14101f;color:#eae6ff;border:1px solid rgba(255,255,255,.1);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.6);padding:22px}
  .bl-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
  .bl-head h2{margin:0;font-size:20px}
  .bl-x{background:none;border:0;color:#eae6ff;font-size:20px;cursor:pointer;opacity:.8}
  .bl-account{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0 16px;font-size:13px;opacity:.95}
  .bl-btn{background:#7c5cff;color:#fff;border:0;border-radius:9px;padding:9px 14px;font-weight:700;cursor:pointer;font-size:13px}
  .bl-btn.alt{background:rgba(255,255,255,.1)}
  .bl-btn:disabled{opacity:.5;cursor:default}
  .bl-pay-btn{display:inline-flex;align-items:center;gap:8px;background:#fff;color:#1a1530}
  .bl-pay-btn:hover{background:#f1eeff}
  .bl-pay-btn img{display:block}
  .bl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
  .bl-card{border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:14px;background:rgba(255,255,255,.03);display:flex;flex-direction:column;gap:8px}
  .bl-card.current{border-color:#00ff9c;box-shadow:0 0 0 1px #00ff9c inset}
  .bl-name{font-weight:700;font-size:15px}
  .bl-price{font-size:22px;font-weight:700}
  .bl-price small{font-size:12px;opacity:.7;font-weight:400}
  .bl-card ul{margin:0;padding-left:16px;font-size:12.5px;line-height:1.5;opacity:.92;flex:1}
  .bl-pay{display:flex;gap:6px;flex-wrap:wrap}
  .bl-msg{margin-top:12px;font-size:13px;min-height:18px}
  .bl-msg.err{color:#ff8a8a}
  .bl-note{margin-top:10px;font-size:12px;opacity:.7;line-height:1.5}
  .bl-usage{margin:0 0 14px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.05);font-size:12.5px;line-height:1.6}
  #billingSignin{position:fixed;right:20px;bottom:20px;z-index:2147482000;width:300px;background:#14101f;color:#eae6ff;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:14px;box-shadow:0 10px 40px rgba(0,0,0,.6);font-family:Arial,sans-serif;font-size:13px}
  #billingSignin.hidden{display:none}
  #billingSignin p{margin:0 0 10px;line-height:1.5}
  #billingSignin .row{display:flex;gap:8px}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  let overlay = null, msgEl = null, busy = false;
  let lastStatus = { enabled: false, signedIn: false };

  const FEATURE_ROWS = [["agent", "AI Agent"], ["trust-engine", "Trust Engine"], ["trustEngine", "Trust Engine"], ["attachment", "Attachments"], ["attachments", "Attachments"], ["chat", "AI Chat"]];
  const fmtCooldown = (t) => {
    const secs = typeof t === "number" ? t : Math.floor(Date.parse(t) / 1000);
    if (!Number.isFinite(secs)) return "";
    const mins = Math.max(1, Math.round((secs * 1000 - Date.now()) / 60000));
    return ` - available again in ${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`}`;
  };

  /** Tolerates the server's shape: reads plan + per-feature remaining if present, shows nothing it cannot recognise (never guesses). */
  function usageLines(ent) {
    if (!ent || typeof ent !== "object") return [];
    const feats = ent.features && typeof ent.features === "object" ? ent.features : ent;
    const seen = new Set(), out = [];
    for (const [key, label] of FEATURE_ROWS) {
      const f = feats[key];
      if (!f || typeof f !== "object" || seen.has(label)) continue;
      seen.add(label);
      let line = label + ": ";
      if (typeof f.remaining === "number") line += typeof f.limit === "number" ? `${f.remaining} of ${f.limit} left` : `${f.remaining} left`;
      else if (typeof f.remainingSeconds === "number") line += `${Math.round(f.remainingSeconds / 60)} min left today`;
      else if (f.unlimited) line += "unlimited";
      else continue;
      if (f.cooldownUntil) line += fmtCooldown(f.cooldownUntil);
      out.push(line);
    }
    return out;
  }

  function setMsg(text, isErr) { if (msgEl) { msgEl.textContent = text || ""; msgEl.className = "bl-msg" + (isErr ? " err" : ""); } }

  let promptMsg = null;
  // Shows in the Plans page if it is open AND in the launch card if that is showing - a failed sign-in must never be silent.
  function notify(text, isErr) {
    setMsg(text, isErr);
    if (promptMsg) { promptMsg.textContent = text || ""; promptMsg.style.color = isErr ? "#ff8a8a" : "inherit"; }
  }

  async function signIn() {
    if (busy) return { ok: false };
    busy = true;
    notify("Complete sign-in in your browser…");
    let ok = false;
    try {
      const r = await api.signIn();
      ok = Boolean(r && r.ok);
      if (!ok) notify((r && r.message) || "Sign-in could not be completed.", true);
      else notify("");
      return { ok };
    } finally { busy = false; await refresh(); if (ok) hideSigninPrompt(); }
  }

  async function checkout(plan, provider) {
    if (busy) return;
    busy = true;
    setMsg("Opening checkout…");
    try {
      const r = await api.checkout(plan, provider);
      if (r && r.ok) { setMsg("Checkout opened in your browser. Once the payment completes, this page checks for your upgrade automatically."); watchForUpgrade(); }
      else if (r && r.reason === "sign_in_required") setMsg(r.error, true);
      else setMsg((r && r.error) || "Could not start checkout.", true);
    } finally { busy = false; }
  }

  // After a checkout is opened, ask the server every few seconds whether the plan changed (the grant happens server-side, when the
  // payment provider's webhook arrives - seconds to a minute or two after paying). Stops on a change, on close, or after 5 minutes.
  let watchTimer = null;
  function watchForUpgrade() {
    if (watchTimer) clearInterval(watchTimer);
    const started = Date.now();
    const startPlan = lastStatus && lastStatus.entitlements ? lastStatus.entitlements.plan : null;
    watchTimer = setInterval(async () => {
      if (Date.now() - started > 5 * 60 * 1000 || !overlay || overlay.classList.contains("hidden")) { clearInterval(watchTimer); watchTimer = null; return; }
      try {
        const st = await api.status();
        const plan = st && st.entitlements ? st.entitlements.plan : null;
        if (plan && plan !== startPlan) { clearInterval(watchTimer); watchTimer = null; await render(); setMsg("Your plan has been upgraded."); }
      } catch (_) { /* try again on the next tick */ }
    }, 6000);
  }

  async function render() {
    if (!overlay) return;
    const box = overlay.querySelector(".bl-box");
    box.replaceChildren();
    const head = node("div", "bl-head");
    head.append(node("h2", null, "Plans & Billing"));
    const x = node("button", "bl-x", "✕"); x.type = "button"; x.setAttribute("aria-label", "Close"); x.addEventListener("click", closeBilling);
    head.append(x);
    box.append(head);

    const [st, pl] = await Promise.all([api.status(), api.plans()]);
    lastStatus = st || lastStatus;

    const acct = node("div", "bl-account");
    if (!st || !st.enabled) {
      acct.append(node("span", null, "Billing is not switched on in this version of Jonah yet."));
    } else if (!st.signedIn) {
      acct.append(node("span", null, "Sign in with Google to use Jonah's AI features and to buy or restore a plan."));
      const b = node("button", "bl-btn", "Sign in with Google"); b.type = "button"; b.addEventListener("click", signIn); acct.append(b);
    } else {
      const plan = st.entitlements && (st.entitlements.planName || st.entitlements.plan);
      acct.append(node("span", null, "Signed in" + (plan ? " · current plan: " + String(plan) : "")));
      const rf = node("button", "bl-btn alt", "Refresh"); rf.type = "button";
      rf.addEventListener("click", async () => { await render(); setMsg("Updated."); }); acct.append(rf);
      const b = node("button", "bl-btn alt", "Sign out"); b.type = "button";
      b.addEventListener("click", async () => { await api.signOut(); await render(); }); acct.append(b);
    }
    box.append(acct);

    if (st && st.signedIn) {
      const lines = usageLines(st.entitlements);
      if (lines.length) { const u = node("div", "bl-usage"); for (const l of lines) u.append(node("div", null, l)); box.append(u); }
      else if (st.entitlementsError) box.append(node("div", "bl-usage", "Could not load your current usage right now."));
    }

    const currentId = st && st.entitlements && typeof st.entitlements.plan === "string" ? st.entitlements.plan : null;
    const grid = node("div", "bl-grid");
    for (const p of (pl && pl.plans) || []) {
      const card = node("div", "bl-card" + (currentId === p.id ? " current" : ""));
      card.append(node("div", "bl-name", p.name));
      const price = node("div", "bl-price", p.price); if (p.period) price.append(node("small", null, " " + p.period.replace("/", "/ "))); card.append(price);
      const ul = node("ul"); for (const f of p.features) ul.append(node("li", null, f)); card.append(ul);
      if (currentId === p.id) card.append(node("div", null, "Your current plan"));
      else if (p.providers.length) {
        const pay = node("div", "bl-pay");
        for (const prov of p.providers) {
          const name = prov === "razorpay" ? "Razorpay" : "Stripe";
          const b = node("button", "bl-btn bl-pay-btn");
          const logo = document.createElement("img"); logo.src = `assets/pay/${prov}.svg`; logo.alt = ""; logo.width = 18; logo.height = 18;
          b.append(logo, node("span", null, "Pay with " + name));
          b.type = "button"; b.setAttribute("aria-label", "Pay with " + name); b.addEventListener("click", () => checkout(p.id, prov)); pay.append(b);
        }
        card.append(pay);
      }
      grid.append(card);
    }
    box.append(grid);
    msgEl = node("div", "bl-msg"); box.append(msgEl);
    box.append(node("div", "bl-note", "Your plan is tied to your Google account: after reinstalling Jonah, sign in with the same account to restore it. Limits are enforced by Jonah's server on every use. Payments are completed on Razorpay's or Stripe's own page - Jonah never sees your card details."));
  }

  async function refresh() { if (overlay && !overlay.classList.contains("hidden")) await render(); }

  function openBilling() {
    if (!overlay) {
      overlay = node("div"); overlay.id = "billingOverlay"; overlay.append(node("div", "bl-box"));
      overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closeBilling(); });
      document.body.append(overlay);
    }
    overlay.classList.remove("hidden");
    render();
  }
  function closeBilling() { if (overlay) overlay.classList.add("hidden"); }

  // ---------------------------------------------------------------- sign-in prompt at launch (never blocks browsing)
  let prompt = null;
  function hideSigninPrompt() { if (prompt) prompt.classList.add("hidden"); }
  function showSigninPrompt() {
    if (!prompt) {
      prompt = node("div"); prompt.id = "billingSignin";
      prompt.append(node("p", null, "Sign in with Google to use Jonah's AI Agent, Trust Engine and attachments. Signing in also lets you restore a purchased plan after reinstalling."));
      promptMsg = node("p"); promptMsg.style.minHeight = "0"; prompt.append(promptMsg);
      const row = node("div", "row");
      const go = node("button", "bl-btn", "Sign in with Google"); go.type = "button"; go.addEventListener("click", async () => { go.disabled = true; try { await signIn(); } finally { go.disabled = false; } });
      const later = node("button", "bl-btn alt", "Not now"); later.type = "button"; later.addEventListener("click", hideSigninPrompt);
      row.append(go, later); prompt.append(row); document.body.append(prompt);
    }
    prompt.classList.remove("hidden");
  }

  window.openBilling = openBilling;
  window.billingSignIn = signIn;

  // The assistant panel is an iframe: it asks the shell to open this page. Only that iframe's window is believed.
  window.addEventListener("message", (e) => {
    const frame = document.querySelector("#aiPanel iframe");
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data || {};
    if (d.type === "billing:open") openBilling();
    if (d.type === "billing:sign-in") { showSigninPrompt(); signIn(); } // the launch card is where a failure message is shown if the Plans page is closed
  });

  window.addEventListener("DOMContentLoaded", async () => {
    try { const st = await api.status(); lastStatus = st; if (st && st.enabled && !st.signedIn) showSigninPrompt(); } catch (_) { /* billing is optional chrome; never break the shell */ }
  });
})();
