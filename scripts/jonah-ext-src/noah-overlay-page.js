// noah-overlay-page.js - puts Electron Jonah's Noah overlay (noah-overlay.js, unchanged: purple cursor, click ripples, highlights,
// typing ring, status pill, confirmation card, takeover banner and STOP button) on the page Noah is working on. Noah's panel sends
// it the agent's events; its buttons (Stop / Resume / Allow / Deny) go back to the agent. Injected only while Noah works.
//
// In Electron the overlay was a separate layer drawn OVER the <webview>, so Noah never saw it: not in the page text, not in the
// element list, not in screenshots. Here it has to live in the page, so it is kept just as invisible to Noah:
//  - it sits in a CLOSED shadow root on a host element under <html> (not <body>), so the page's text, element count and
//    accessibility tree do not change when the status pill or a click ripple changes (the verifier compares exactly those
//    to tell whether a click did anything; an overlay inside <body> made every click look like it worked);
//  - the host is aria-hidden, so the overlay's STOP button is never offered to Noah as something to click;
//  - Noah's screenshots hide the host for the instant of the capture (noah/screenshot.cjs), so the model sees the page only.
(function () {
  "use strict";
  if (window.__jonahNoahOverlay) return;
  window.__jonahNoahOverlay = true;
  const send = (cmd, extra) => chrome.runtime.sendMessage(Object.assign({ type: "noah:overlay-cmd", cmd }, extra || {})).catch(() => {});
  // what the overlay calls in Electron (window.noah.*)
  window.noah = { stop: () => send("stop"), resume: () => send("resume"), confirm: (id, allow) => send("confirm", { id, allow: !!allow }) };
  if (!window.NoahOverlay) return;

  const host = document.createElement("jonah-noah-layer");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial !important; position:fixed !important; inset:0 !important; z-index:2147483000 !important; pointer-events:none !important; display:block !important;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = window.__jonahNoahCss || "";
  shadow.appendChild(style);

  const ov = window.NoahOverlay.mount({ webviewRect: () => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }) });
  if (!ov) return;
  // mount() adds the layer to <body> (as in Electron); move it into the hidden host before anything is drawn
  const root = document.getElementById("noahOverlay");
  if (root) shadow.appendChild(root);
  (document.documentElement || document.body).appendChild(host);
  // pages that rebuild <html>'s children (single-page apps) would drop the host: put it back
  const keep = new MutationObserver(() => { if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host); });
  if (document.documentElement) keep.observe(document.documentElement, { childList: true });

  chrome.runtime.onMessage.addListener((m) => {
    if (!m) return;
    // Electron drew this layer OVER the page (CSS px x zoom); here it is INSIDE the page, where the event's CSS px are already right.
    if (m.type === "noah:overlay-event" && m.evt) ov.handle(Object.assign({}, m.evt, { zoomFactor: 1 }));
    else if (m.type === "noah:overlay-config" && m.cfg) ov.applyConfig(m.cfg);
  });
})();
