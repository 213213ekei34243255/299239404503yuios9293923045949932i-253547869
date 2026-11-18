// jonah-models.js - "Jonah Account" screen (⋮ menu). Signing in to the Jonah account with Google gives Noah's web agent its brain,
// noahai.live, as in Electron Jonah (Plans & Billing / account). The user signs in on Google's own page; Jonah never sees the password.
(function () {
  "use strict";
  const REASONS = { cancelled: "Sign-in was cancelled.", timeout: "Sign-in took too long. Please try again.", state_mismatch: "Sign-in could not be checked. Please try again.",
    server_unreachable: "Jonah's server could not be reached. Check the internet and try again.", access_denied: "Google sign-in was declined." };

  async function openAccount() {
    const p = createToolPanel("models", "Jonah Account", `<div class="jg-caption" style="margin:0">Loading...</div>`);
    await window.JonahAccount.ready;
    render(p);
  }

  function render(p, note) {
    const A = window.JonahAccount;
    const signed = A.isSignedIn();
    p.querySelector(".jtp-body").innerHTML = `
      <div class="jg-list jg-hero"><div class="jg-num" style="font-size:44px">${signed ? "✅" : "\u{1F464}"}</div>
        <div style="font-size:18px;font-weight:600;margin-top:8px">${signed ? "Signed in" : "Not signed in"}</div>
        <div class="jg-sub">${signed ? "Noah's web agent uses noahai.live" : "Sign in so Noah's web agent can work on websites for you"}</div></div>
      ${note ? `<div class="jg-caption" style="margin:0 6px 14px;color:#ff8a80">${note}</div>` : ""}
      ${signed
        ? `<button class="ghost jg-big-btn" id="jaOut">Sign out</button>`
        : `<button class="jg-big-btn" id="jaIn">Sign in with Google</button>
           <div class="jg-caption" style="margin:14px 6px 0">Google's sign-in page opens in a new tab. You sign in there yourself; Jonah never sees your password. Your plan and limits come from your Jonah account (Plans &amp; Billing).</div>`}`;
    const out = p.querySelector("#jaOut");
    if (out) out.onclick = async () => { await A.signOut(); render(p); };
    const inp = p.querySelector("#jaIn");
    if (inp) inp.onclick = async () => {
      inp.disabled = true; inp.textContent = "Waiting for Google...";
      const r = await A.signIn();
      render(p, r.ok ? "" : (REASONS[r.reason] || "Sign-in did not finish (" + r.reason + ")."));
    };
  }
  window.openJonahModels = openAccount;
})();
