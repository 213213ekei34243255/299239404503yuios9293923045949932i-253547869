// menu.js - what the items of Jonah's ⋮ menu and book menu do (menu.html, book.html).
// Browser parts use Chromium's own pages (Downloads, Bookmarks, History, Settings); Jonah's tools and panels open over Noah's chat in
// the side panel (jonah-shell.js opens the one asked for).
(function () {
  "use strict";
  let windowId = null;
  chrome.windows.getCurrent().then((w) => { windowId = w.id; }).catch(() => {});

  const CHROMIUM_PAGES = { bookmarks: "chrome://bookmarks" };
  const PANEL_VIEWS = new Set(["downloads", "history", "models", "trust", "billing", "focus", "privacy", "notifications", "orb", "hub:game", "hub:creator", "hub:aesthetic",
    "study:today", "study:focus", "study:cards", "study:ai", "calc", "abacus", "formula", "notes"]);

  function openInSidePanel(view) {
    // open() first, in the click itself: Chromium only opens the side panel straight from a user action
    if (windowId != null) chrome.sidePanel.open({ windowId }).catch(() => {});
    chrome.storage.session.set({ jonahOpen: { view, t: Date.now() } }).finally(() => setTimeout(() => window.close(), 150));
  }

  async function act(what) {
    if (CHROMIUM_PAGES[what]) { await chrome.tabs.create({ url: CHROMIUM_PAGES[what] }); window.close(); return; }
    if (what === "readAloud") {
      const r = await chrome.runtime.sendMessage({ type: "jonah:readAloud" });
      if (r && r.error) { document.getElementById("readAloudBtn").textContent = r.error; setTimeout(() => window.close(), 1800); return; }
      window.close(); return;
    }
    if (what === "cite") {
      // the citation card opens inside the page itself, as in Jonah on Electron
      chrome.runtime.sendMessage({ type: "jonah:cite" }).finally(() => window.close());
      return;
    }
    if (PANEL_VIEWS.has(what)) openInSidePanel(what);
  }

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (el) act(el.dataset.act);
  });

  // the Read aloud item says "Stop reading" while Jonah is reading
  chrome.storage.session.get("jonahReading").then(({ jonahReading }) => {
    const el = document.getElementById("readAloudBtn");
    if (el && jonahReading) el.textContent = "Stop reading";
  }).catch(() => {});
})();
