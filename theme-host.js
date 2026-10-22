// theme-host.js - the bridge between Jonah's home page and the browser window: keeps the chrome and the assistant panel in step with the colour picked on the home page, and opens the hubs from the home page dock.
// The home page announces the colour; webview-preload.js forwards it here as an "ipc-message" (only from Jonah's own home.html, only a six-digit hex).
(function () {
  "use strict";
  const T = window.JonahTheme;
  if (!T) return;
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const panels = () => [...document.querySelectorAll("#aiPanel iframe")];
  function toPanel(hex) { panels().forEach((f) => { try { f.contentWindow.postMessage({ type: "jonah-theme", hex }, "*"); } catch (_) { /* panel not loaded yet: it asks again when it loads */ } }); }
  /** Recolour the browser, the assistant panel AND every open Jonah home page (they keep their own saved copy). Used by the picker on the home page and by the Aesthetic Lab. */
  function setAll(hex) {
    const clean = T.set(hex); toPanel(clean);
    document.querySelectorAll("webview").forEach((wv) => { try { if (/\/home\.html(\?|#|$)/.test(String(wv.getURL ? wv.getURL() : wv.src))) wv.executeJavaScript(`window.JonahTheme && JonahTheme.set(${JSON.stringify(clean)})`).catch(() => {}); } catch (_) { /* not ready */ } });
    return clean;
  }
  function attach(wv) {
    if (!wv || wv.__jonahThemeAttached) return;
    wv.__jonahThemeAttached = true;
    wv.addEventListener("ipc-message", (e) => {
      if (e.channel === "jonah-theme" && e.args && HEX.test(String(e.args[0]))) setAll(String(e.args[0]));
      else if (e.channel === "jonah-open-hub" && e.args && ["game", "creator", "aesthetic"].includes(String(e.args[0])) && window.openHub) window.openHub(String(e.args[0]));
    });
  }
  window.JonahThemeHost = { attach, setAll };
  attach(document.getElementById("browser"));
  panels().forEach((f) => f.addEventListener("load", () => toPanel(T.readStored())));
})();
