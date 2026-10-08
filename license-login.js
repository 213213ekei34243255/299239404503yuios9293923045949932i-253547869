// Login window logic. It never stores the password or any "signed in" state: it hands the typed credentials to the app's main
// process (which asks the licence server) and shows whatever the main process says.
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const form = $("form"), user = $("u"), pass = $("p"), go = $("go"), notice = $("notice"), status = $("status");
  const api = window.jonahLicense;

  function showNotice(text) { notice.textContent = text || ""; notice.hidden = !text; }
  function busy(on) { go.disabled = on; user.disabled = on; pass.disabled = on; }

  $("quit").addEventListener("click", () => api.quit());

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    showNotice(""); status.textContent = "Checking your access...";
    busy(true);
    let r;
    try { r = await api.login(user.value, pass.value); } catch { r = { ok: false, message: "Something went wrong. Please try again." }; }
    pass.value = ""; // never keep the password around
    if (r && r.ok) { status.textContent = "Signed in. Starting Jonah..."; return; } // the main process closes this window
    status.textContent = "";
    showNotice((r && r.message) || "Sign-in failed.");
    if (r && r.retryAfterSeconds) status.textContent = "Try again in about " + r.retryAfterSeconds + " seconds.";
    busy(false);
    pass.focus();
  });

  (async () => {
    let info = { configured: true, notice: null };
    try { info = await api.init(); } catch { /* keep defaults */ }
    if (info && info.notice) showNotice(info.notice.message);
    if (info && info.configured === false) { showNotice(info.setupMessage || "Developer access is not set up on this copy of the app."); busy(true); $("quit").focus(); return; }
    user.focus();
  })();
})();
