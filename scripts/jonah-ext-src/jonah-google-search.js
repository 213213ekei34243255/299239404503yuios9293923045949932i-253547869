// jonah-google-search.js - the web search Jonah's own features use (the AI chat's answers, the Trust Engine): Google's own results page,
// read in the user's own Jonah, like a person reading it. Electron Jonah's google-serp.cjs, the same rules:
//   * one search at a time, at least 1.5 s apart;
//   * Google's "not a robot" check is NEVER solved: automatic searches pause (5, 15, 30, then 60 minutes) and the user is told to complete
//     it in a normal tab; the cookie-consent page is reported;
//   * the results are read by Electron's readResultsPage() (js/google-results.js), unchanged.
// Electron used a hidden window; here it is a small MINIMIZED Jonah window, muted, kept for a minute between searches, and each search is
// taken out of the history so automatic searches do not fill it. Used by Noah's panel (noah-computer.js) and the background (Trust Engine).
(function (root) {
  "use strict";
  const SEARCH_URL = "https://www.google.com/search";
  const MIN_GAP_MS = 1500, LOAD_TIMEOUT_MS = 15000, IDLE_CLOSE_MS = 60000;
  const CAPTCHA_PAUSES_MS = [5, 15, 30, 60].map((m) => m * 60000);
  let searchWin = null, searchTab = null, idleTimer = null, lastAt = 0, pausedUntil = 0, strikes = 0, chain = Promise.resolve();
  const searchError = (code, message) => Object.assign(new Error(message), { code });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pauseMessage = () => {
    const minutes = Math.max(1, Math.ceil((pausedUntil - Date.now()) / 60000));
    return `Google is asking to confirm you're not a robot. Open google.com in a Jonah tab and complete the check; automatic searches (AI chat, Trust Engine) are paused until then, or for about ${minutes} more minute${minutes === 1 ? "" : "s"}.`;
  };
  async function searchTabReady() {
    if (searchTab != null) { try { await chrome.tabs.get(searchTab); return searchTab; } catch (_) { searchTab = null; searchWin = null; } }
    const w = await chrome.windows.create({ url: "about:blank", state: "minimized", focused: false, type: "normal" });
    searchWin = w.id;
    searchTab = w.tabs && w.tabs[0] ? w.tabs[0].id : (await chrome.tabs.query({ windowId: w.id }))[0].id;
    await chrome.tabs.update(searchTab, { muted: true }).catch(() => {});
    return searchTab;
  }
  function closeSearchWindowSoon() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(close, IDLE_CLOSE_MS);
  }
  function close() { const id = searchWin; searchWin = null; searchTab = null; if (id != null) chrome.windows.remove(id).catch(() => {}); }
  if (typeof root.addEventListener === "function" && typeof document !== "undefined") root.addEventListener("pagehide", close);
  async function searchOnce(query) {
    if (Date.now() < pausedUntil) throw searchError("captcha", pauseMessage());
    const wait = lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    const tabId = await searchTabReady();
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&hl=en`;
    await chrome.tabs.update(tabId, { url });
    // read as soon as the HTML is in (Electron: dom-ready), not when every image and ping has finished
    const t0 = Date.now();
    let page = null;
    while (Date.now() - t0 < LOAD_TIMEOUT_MS) {
      await sleep(400);
      let tab; try { tab = await chrome.tabs.get(tabId); } catch (_) { throw searchError("closed", "The search window was closed."); }
      if (!/^https:\/\/(www\.google\.|consent\.google\.)/i.test(tab.url || "")) continue;
      try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: root.JonahReadGoogleResults });
        page = res && res.result;
      } catch (_) { page = null; } // still navigating
      if (page && (page.captcha || page.consent || (page.items && page.items.length) || page.noResults || tab.status === "complete")) break;
    }
    chrome.history.deleteUrl({ url }).catch(() => {});
    closeSearchWindowSoon();
    if (!page) throw searchError("timeout", "Google did not answer in time");
    if (page.captcha) {
      pausedUntil = Date.now() + CAPTCHA_PAUSES_MS[Math.min(strikes, CAPTCHA_PAUSES_MS.length - 1)];
      strikes += 1;
      throw searchError("captcha", pauseMessage());
    }
    if (page.consent) throw searchError("consent", "Google is showing its cookie-consent page. Open google.com in a Jonah tab and choose an option once; searches work after that.");
    if (!/^https:\/\/www\.google\.[a-z.]+\/search/i.test(page.url || "")) throw searchError("unexpected_page", "Google's results page did not open (was it blocked by Focus Mode or a filter?)");
    strikes = 0;
    return { items: page.items || [], noResults: !!page.noResults };
  }
  root.JonahGoogleSearch = {
    /** one at a time, in order; resolves { items: [{ title, link, snippet, displayLink }], noResults } or rejects with .code */
    search(query) {
      const run = chain.then(() => searchOnce(String(query || "").slice(0, 300)));
      chain = run.catch(() => {});
      return run;
    },
    paused: () => Date.now() < pausedUntil,
    close,
  };
})(typeof self !== "undefined" ? self : this);
