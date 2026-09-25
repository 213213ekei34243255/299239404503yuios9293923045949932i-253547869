// trust-panel.js
//
// The floating "Jonah Trust Score" card - the Windows counterpart of the iOS TrustViewModel + TrustPanelView. It watches the
// active tab, decides whether it is on a NEW site worth checking (not a hash/query change, not Jonah's own pages, not a local or
// IP address), asks the main process's Trust Engine (Trust/) for a verdict, and shows it.
//
// It lives in the browser shell, not inside the visited page (the old panel injected HTML into the guest page, where the page
// itself could read or tamper with it). Every string that came from the network is set with textContent, never innerHTML.

"use strict";

(function () {
  const state = {
    enabled: true, // the "Trust Panel" menu switch
    host: null, // last host handed to a check (iOS: lastCheckedHost)
    visible: false,
    loading: false,
    deep: false, // the check in flight / on screen is a deep scan
    result: null,
    error: null,
    token: 0, // a newer check supersedes an older one still in flight
  };

  const $ = (id) => document.getElementById(id);

  // Mirrors Trust/controller.cjs's guard: nothing internal or private is ever sent out to be "checked".
  function checkableHost(url) {
    let u;
    try { u = new URL(url); } catch (_) { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const h = u.hostname.toLowerCase();
    if (!h || !h.includes(".") || !/^[a-z0-9.-]+$/.test(h)) return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return null;
    if (/\.(localhost|local|internal|lan|home|corp|test|invalid|example)$/.test(h)) return null;
    return h;
  }

  // Same bands as iOS: red below 40, yellow below 60, green from 60.
  const colorFor = (score) => (score == null ? "rgba(255,255,255,0.5)" : score < 40 ? "#ff3b3b" : score < 60 ? "#ffd93b" : "#00ff9c");

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function list(title, items) {
    const box = node("div", "trust-list");
    box.appendChild(node("h4", null, title));
    for (const it of items) box.appendChild(node("div", null, "•  " + it));
    return box;
  }

  function link(label, onClick) {
    const b = node("button", "trust-link", label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function render() {
    const card = $("trustCard");
    if (!card) return;
    if (!state.visible || !state.enabled) {
      card.classList.add("hidden");
      return;
    }
    card.classList.remove("hidden");
    const score = state.result ? state.result.score : null;
    card.style.setProperty("--trust-glow", colorFor(score));

    const body = $("trustBody");
    body.replaceChildren();

    if (state.loading) {
      const row = node("div", "trust-loading");
      if (state.deep) {
        row.append(node("span", "trust-shield", "🛡"), node("span", null, "Deep security scan…"));
      } else {
        row.append(node("span", "trust-spin"), node("span", null, "Checking"));
      }
      body.appendChild(row);
      return;
    }

    if (state.error || !state.result) {
      body.appendChild(node("div", "trust-summary", state.error || "Couldn't check this site."));
      body.appendChild(link("Retry check", () => window.trustRetry()));
      return;
    }

    const r = state.result;
    const big = node("div", "trust-score", `${r.score}/100`);
    big.style.color = colorFor(r.score);
    body.appendChild(big);
    body.appendChild(node("div", "trust-summary", "🧠 " + r.security));
    if (Array.isArray(r.notes)) for (const n of r.notes) body.appendChild(node("div", "trust-note", n));

    if (Array.isArray(r.issues) && r.issues.length) body.appendChild(list("TOP MENTIONS", r.issues.slice(0, 4)));
    if (Array.isArray(r.securityScanNotes) && r.securityScanNotes.length) body.appendChild(list("SECURITY SCAN", r.securityScanNotes));

    body.appendChild(node("div", "trust-source", "source: " + r.source));

    if (r.detailedAnalysis) body.appendChild(link("Why flagged?", () => openDetail(r.detailedAnalysis)));
    // source "none" = nothing actually got checked (every lookup failed or the whole check timed out): most often a one-off
    // network blip, not a real "no data" verdict, so offer a quick way to try again.
    if (r.source === "none") body.appendChild(link("Retry check", () => window.trustRetry()));
    // iOS gates the deep scan behind Premium Plus/Ultra; Windows has no tiers, so it is simply a button. Only when the evidence
    // engine actually ran (riskLevel is absent for the trusted-list / known-scam-list fast paths) and it wasn't deep already.
    if (r.riskLevel && !r.detailedAnalysis && r.source !== "none") body.appendChild(link("Run deep scan", () => window.trustDeepScan()));
  }

  function openDetail(text) {
    const box = $("trustDetail");
    if (!box) return;
    $("trustDetailText").textContent = text;
    box.classList.remove("hidden");
  }

  async function runCheck(host, { deep = false, force = false } = {}) {
    const token = ++state.token;
    state.visible = true;
    state.loading = true;
    state.deep = deep;
    state.result = null;
    state.error = null;
    render();

    // The Trust Engine bounds itself (60 s, deep 100 s), but the spinner must never depend on that alone: if the main process has
    // not answered a little after its own ceiling, stop waiting and offer a retry instead of leaving "Checking" up forever.
    let res;
    let timer;
    try {
      const patience = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: "timed out" }), (deep ? 115 : 75) * 1000); });
      res = await Promise.race([window.api.trustCheck(host, { deepScan: deep, force }), patience]);
    } catch (err) {
      res = { ok: false, error: err && err.message };
    } finally {
      clearTimeout(timer);
    }
    if (token !== state.token) return; // superseded by a newer navigation or check
    state.loading = false;
    if (res && res.ok && res.result) state.result = res.result;
    else if (res && res.skipped) state.visible = false;
    else state.error = "Couldn't check this site right now.";
    render();
  }

  /** Call whenever the active tab's page may have changed (navigation, tab switch). Same-host changes are ignored. */
  function syncTrust() {
    if (!state.enabled) return;
    const page = typeof currentPage === "function" ? currentPage() : { url: "" };
    const host = checkableHost(page.url);
    if (!host) {
      // Jonah's own pages, about:blank, local/IP addresses: nothing to say
      state.host = null;
      state.token++;
      state.visible = false;
      render();
      return;
    }
    if (host === state.host) return;
    state.host = host;
    runCheck(host);
  }

  window.syncTrust = syncTrust;
  window.trustRetry = () => { if (state.host) runCheck(state.host, { deep: state.deep, force: true }); };
  window.trustDeepScan = () => { if (state.host) runCheck(state.host, { deep: true }); };
  window.trustHide = () => { state.visible = false; state.token++; render(); }; // the ✕: gone until the next NEW site
  // The "Trust Panel" menu item: turns automatic checking on/off.
  window.toggleTrust = () => {
    state.enabled = !state.enabled;
    if (!state.enabled) {
      state.token++;
      state.visible = false;
      render();
    } else {
      state.host = null;
      syncTrust();
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    $("trustClose")?.addEventListener("click", () => window.trustHide());
    $("trustDetailDone")?.addEventListener("click", () => $("trustDetail").classList.add("hidden"));
    $("trustDetail")?.addEventListener("click", (e) => { if (e.target === $("trustDetail")) $("trustDetail").classList.add("hidden"); });
  });
})();
