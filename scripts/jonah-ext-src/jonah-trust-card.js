// jonah-trust-card.js - Electron Jonah's floating "Jonah Trust Score" card (index.html #trustCard + trust-panel.js render() + style.css),
// drawn over the page by Jonah's background (jonah-trust.js). It lives in a CLOSED shadow root on its own element, so the page can neither
// read it nor restyle it (Electron moved the card out of the page for exactly that reason; a closed layer is the browser-extension way to
// keep that promise). Every string that came from the network is set with textContent, never innerHTML.
(function () {
  "use strict";
  if (window.__jonahTrustCard) return;
  window.__jonahTrustCard = true;

  const CSS = `
:host { all: initial; }
#trustCard {
  --trust-glow: rgba(255,255,255,0.5);
  position: fixed; top: 16px; right: 16px; width: 240px; box-sizing: border-box; padding: 14px; border-radius: 18px;
  background: rgba(0,0,0,0.55); backdrop-filter: blur(22px); -webkit-backdrop-filter: blur(22px);
  border: 1px solid rgba(255,255,255,0.08);
  box-shadow: 0 0 20px color-mix(in srgb, var(--trust-glow) 35%, transparent);
  color: #fff; font-family: 'Inter', 'Segoe UI', Arial, sans-serif; z-index: 2147482000; pointer-events: auto;
  animation: trustFadeIn 0.2s ease-out;
}
#trustCard.hidden { display: none; }
.trust-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.trust-title { font-size: 13px; font-weight: 700; color: #00ebff; }
.trust-x { cursor: pointer; opacity: 0.6; font-size: 13px; background: none; border: none; color: #fff; padding: 0 2px; }
.trust-x:hover { opacity: 1; }
.trust-score { font-size: 30px; font-weight: 700; margin: 2px 0 6px; text-shadow: 0 0 8px color-mix(in srgb, currentColor 60%, transparent); }
.trust-summary { font-size: 12px; color: rgba(255,255,255,0.85); line-height: 1.35; }
.trust-note { margin-top: 6px; font-size: 10.5px; line-height: 1.3; color: #fbbf24; }
.trust-list { margin-top: 8px; }
.trust-list h4 { margin: 0 0 3px; font-size: 10px; font-weight: 700; letter-spacing: 0.4px; color: rgba(255,255,255,0.5); }
.trust-list div { font-size: 11px; color: rgba(255,255,255,0.8); margin-bottom: 3px; line-height: 1.3; overflow-wrap: anywhere; }
.trust-source { margin-top: 8px; font-size: 9px; color: rgba(255,255,255,0.3); }
.trust-link { display: block; margin-top: 6px; padding: 0; background: none; border: none; cursor: pointer; font: 600 11px 'Inter', 'Segoe UI', Arial, sans-serif; color: #00ebff; text-align: left; }
.trust-link:hover { text-decoration: underline; }
.trust-loading { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; color: rgba(255,255,255,0.7); }
.trust-spin { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.25); border-top-color: #fff; border-radius: 50%; animation: trustSpin 0.8s linear infinite; }
.trust-shield { font-size: 15px; animation: trustPulse 0.9s ease-in-out infinite alternate; }
#trustDetail { position: fixed; inset: 0; z-index: 2147482500; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; pointer-events: auto; }
#trustDetail.hidden { display: none; }
.trust-detail-box { width: min(520px, 90vw); max-height: 70vh; overflow: auto; background: rgb(18,16,28); border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; padding: 18px 20px; color: #f2f4f8; font: 14px/1.5 'Inter', 'Segoe UI', Arial, sans-serif; }
.trust-detail-box h3 { margin: 0 0 10px; font-size: 15px; }
.trust-detail-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.trust-detail-box button { margin-top: 14px; padding: 7px 18px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); color: #fff; cursor: pointer; font-weight: 600; }
@keyframes trustFadeIn { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: translateX(0); } }
@keyframes trustSpin { to { transform: rotate(360deg); } }
@keyframes trustPulse { from { opacity: 0.35; } to { opacity: 1; } }`;

  const hostEl = document.createElement("jonah-trust-card");
  hostEl.setAttribute("aria-live", "polite");
  hostEl.style.cssText = "all:initial !important; position:fixed !important; inset:0 !important; z-index:2147482000 !important; pointer-events:none !important; display:block !important;";
  const shadow = hostEl.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.appendChild(style);

  const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const send = (cmd, extra) => chrome.runtime.sendMessage(Object.assign({ type: "jonah:trust-cmd", cmd }, extra || {})).catch(() => {});

  // the card (Electron index.html)
  const card = node("div", "hidden"); card.id = "trustCard"; card.setAttribute("role", "status");
  const head = node("div", "trust-head");
  const close = node("button", "trust-x", "✕"); close.type = "button"; close.setAttribute("aria-label", "Close");
  head.append(node("span", "trust-title", "Jonah Trust Score"), close);
  const body = node("div"); body.id = "trustBody";
  card.append(head, body);
  // "Why flagged?"
  const detail = node("div", "hidden"); detail.id = "trustDetail"; detail.setAttribute("role", "dialog"); detail.setAttribute("aria-label", "Why flagged?");
  const box = node("div", "trust-detail-box");
  const detailText = node("div", "trust-detail-text");
  const done = node("button", null, "Done"); done.type = "button";
  box.append(node("h3", null, "Why flagged?"), detailText, done);
  detail.append(box);
  shadow.append(card, detail);

  close.addEventListener("click", () => { card.classList.add("hidden"); send("close"); });
  done.addEventListener("click", () => detail.classList.add("hidden"));
  detail.addEventListener("click", (e) => { if (e.target === detail) detail.classList.add("hidden"); });

  // Same bands as iOS / Electron: red below 40, yellow below 60, green from 60.
  const colorFor = (score) => (score == null ? "rgba(255,255,255,0.5)" : score < 40 ? "#ff3b3b" : score < 60 ? "#ffd93b" : "#00ff9c");
  const list = (title, items) => { const b = node("div", "trust-list"); b.appendChild(node("h4", null, title)); for (const it of items) b.appendChild(node("div", null, "•  " + it)); return b; };
  const link = (label, onClick) => { const b = node("button", "trust-link", label); b.type = "button"; b.addEventListener("click", onClick); return b; };

  /** Electron trust-panel.js render(), for one view: { loading, deep, result, error } (null = hide) */
  function render(view) {
    if (!view) { card.classList.add("hidden"); detail.classList.add("hidden"); return; }
    card.classList.remove("hidden");
    const score = view.result ? view.result.score : null;
    card.style.setProperty("--trust-glow", colorFor(score));
    body.replaceChildren();
    if (view.loading) {
      const row = node("div", "trust-loading");
      if (view.deep) row.append(node("span", "trust-shield", "\u{1F6E1}️"), node("span", null, "Deep security scan…"));
      else row.append(node("span", "trust-spin"), node("span", null, "Checking"));
      body.appendChild(row);
      return;
    }
    if (view.error || !view.result) {
      body.appendChild(node("div", "trust-summary", view.error || "Couldn't check this site."));
      body.appendChild(link("Retry check", () => send("retry")));
      return;
    }
    const r = view.result;
    const big = node("div", "trust-score", `${r.score}/100`);
    big.style.color = colorFor(r.score);
    body.appendChild(big);
    body.appendChild(node("div", "trust-summary", "" + (r.security || "")));
    if (Array.isArray(r.notes)) for (const n of r.notes) body.appendChild(node("div", "trust-note", String(n)));
    if (Array.isArray(r.issues) && r.issues.length) body.appendChild(list("TOP MENTIONS", r.issues.slice(0, 4).map(String)));
    if (Array.isArray(r.securityScanNotes) && r.securityScanNotes.length) body.appendChild(list("SECURITY SCAN", r.securityScanNotes.map(String)));
    body.appendChild(node("div", "trust-source", "source: " + r.source));
    if (r.detailedAnalysis) body.appendChild(link("Why flagged?", () => { detailText.textContent = String(r.detailedAnalysis); detail.classList.remove("hidden"); }));
    if (r.source === "none") body.appendChild(link("Retry check", () => send("retry")));
    if (r.riskLevel && !r.detailedAnalysis && r.source !== "none") body.appendChild(link("Run deep scan", () => send("deep")));
  }

  chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "jonah:trust-card") render(m.view); });
  (document.documentElement || document.body).appendChild(hostEl);
  // pages that rebuild <html>'s children would drop the card: put it back
  const keep = new MutationObserver(() => { if (!hostEl.isConnected && document.documentElement) document.documentElement.appendChild(hostEl); });
  if (document.documentElement) keep.observe(document.documentElement, { childList: true });
})();
