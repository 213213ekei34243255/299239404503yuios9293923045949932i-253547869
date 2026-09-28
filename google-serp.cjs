// google-serp.cjs
//
// Web search through Google's own results page. Jonah opens https://www.google.com/search?q=... in a hidden window of the browser's
// own session ("persist:main": the same cookies, consent choice and "I'm not a robot" clearance as the user's tabs), waits for it to
// load and reads the results from the page, like a person reading them. The Trust Engine and the AI chat's web search use it through
// search-proxy.cjs, and get the same shape as before: { items: [{ title, link, snippet, displayLink }] }.
//
// Google's limits are respected, never worked around:
//   * one search at a time, at least MIN_GAP_MS apart;
//   * when Google shows its "unusual traffic" check (a CAPTCHA), nothing here tries to solve it. Automatic searches pause and the
//     error says why. They resume as soon as the user completes the check in a normal Jonah tab (same session: Google's clearance
//     cookie is shared), or after the pause (5 min, growing to an hour if Google keeps asking).

"use strict";

const SEARCH_URL = "https://www.google.com/search";
const MIN_GAP_MS = 1500;
const LOAD_TIMEOUT_MS = 15000;
const READ_TIMEOUT_MS = 5000;
const PATIENT_READ_MS = 22000; // the second, long wait for a page that is still loading (its thread is busy, not dead)
const CAPTCHA_PAUSES_MS = [5, 15, 30, 60].map((minutes) => minutes * 60 * 1000);
const CLEARANCE_COOKIE = "GOOGLE_ABUSE_EXEMPTION"; // set by Google when a person completes its check

class GoogleSearchError extends Error {
  /** @param {"captcha"|"consent"|"load_failed"|"timeout"|"unexpected_page"|"closed"} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Runs INSIDE the results page (serialised with toString), so it must be self-contained. Reads the organic results the way they are
// shown: every result title is an <h3> inside its link. Ads (#tads / #bottomads) and Google's own navigation links are skipped.
function readResultsPage() {
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const isGoogle = (host) => /(^|\.)google\.[a-z.]+$/i.test(host);
  const captcha = location.pathname.startsWith("/sorry") || !!document.querySelector("#captcha-form, form[action*='/sorry'], #recaptcha");
  const consent = /(^|\.)consent\.google\./i.test(location.hostname) || !!document.querySelector("form[action*='consent.google']");
  const items = [];
  const seen = new Set();
  const root = document.querySelector("#rso") || document.querySelector("#search") || document.body;
  if (!captcha && !consent && root) {
    // The site a result points to. Google often links through its own redirect: /url?q=<address> (unwrapped here) or
    // /goto?url=<opaque token> (no address in it). For the opaque kind, the address Google SHOWS under the title (<cite>,
    // "https://www.python.org › about") names the site; that is what the Trust Engine needs (it compares result sites).
    const httpUrl = (value) => {
      try {
        const u = new URL(value, location.href);
        return /^https?:$/.test(u.protocol) ? u : null;
      } catch (_) {
        return null;
      }
    };
    const siteOf = (a, box) => {
      const direct = httpUrl(a.href);
      if (!direct) return null;
      if (!isGoogle(direct.hostname) || !/^\/(url|goto)\b/.test(direct.pathname)) return direct;
      for (const source of [direct, httpUrl(a.getAttribute("ping") || "")]) {
        for (const key of ["q", "url", "u"]) {
          const inner = source && httpUrl(source.searchParams.get(key) || "");
          if (inner && !isGoogle(inner.hostname)) return inner;
        }
      }
      const shown = clean((box && box.querySelector("cite") || {}).innerText || "").split("›")[0].trim().replace(/\s+/g, "");
      const fromCite = shown && httpUrl(/^https?:\/\//i.test(shown) ? shown : `https://${shown}`);
      // a real hostname only: for video results <cite> holds things like "3. 1K views · 10 months ago", which is not a site
      return fromCite && /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(fromCite.hostname) && !isGoogle(fromCite.hostname) ? fromCite : null;
    };
    for (const heading of root.querySelectorAll("a h3")) {
      const a = heading.closest("a");
      if (!a || a.closest("#tads, #bottomads, [data-text-ad]")) continue;
      const box = a.closest("div.MjjYud, div.g, div[data-hveid], div[data-sokoban-container]") || a.parentElement;
      const link = siteOf(a, box);
      if (!link) continue;
      if (isGoogle(link.hostname) && /^\/(search|webhp|imgres|maps|preferences|advanced_search)\b/.test(link.pathname)) continue;
      if (seen.has(link.href)) continue;
      const title = clean(heading.innerText || heading.textContent);
      if (!title) continue;
      let snippet = "";
      const shown = box && box.querySelector("[data-sncf], .VwiC3b, [style*='-webkit-line-clamp']");
      if (shown && !a.contains(shown)) snippet = clean(shown.innerText);
      if (!snippet && box) {
        // no known snippet element: the result's own text minus its title and its address line ("python.org › about")
        snippet = (box.innerText || "").split("\n").map(clean)
          .filter((line) => line && line !== title && !line.includes("›") && !/^https?:\/\//.test(line) && line.length > 25)
          .join(" ");
      }
      seen.add(link.href);
      items.push({ title, link: link.href, snippet: snippet.slice(0, 500), displayLink: link.hostname });
      if (items.length >= 10) break;
    }
  }
  const text = document.body ? document.body.innerText : "";
  const noResults = !items.length && /did not match any documents|No results found for/i.test(text);
  return { captcha, consent, items, noResults, url: location.href };
}

const READ_SCRIPT = `(${readResultsPage.toString()})()`;

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); }),
  ]);
}

/**
 * @param {{ BrowserWindow: any, session?: any, partition?: string, userAgent?: string, log?: Function,
 *           now?: () => number, sleep?: (ms: number) => Promise<void>, minGapMs?: number, loadTimeoutMs?: number, readTimeoutMs?: number }} deps
 */
function createGoogleSearch({
  BrowserWindow, session, partition = "persist:main", userAgent, log = () => {}, now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), minGapMs = MIN_GAP_MS, loadTimeoutMs = LOAD_TIMEOUT_MS, readTimeoutMs = READ_TIMEOUT_MS, patientReadMs = PATIENT_READ_MS,
}) {
  let win = null;
  const jobs = []; // waiting searches, in the order they will run
  let running = false;
  let lastAt = 0;
  let pausedUntil = 0;
  let strikes = 0;
  let closed = false;

  // When the user completes Google's check in a normal tab, Google sets its clearance cookie in this same session: resume at once.
  if (session && typeof session.fromPartition === "function") {
    try {
      session.fromPartition(partition).cookies.on("changed", (_event, cookie, _cause, removed) => {
        if (!removed && cookie && cookie.name === CLEARANCE_COOKIE && pausedUntil > now()) {
          log("Google's check was completed in a tab: automatic searches resume");
          pausedUntil = 0;
          strikes = 0;
        }
      });
    } catch (_) { /* cookie events unavailable: the timed pause still applies */ }
  }

  function pauseMessage() {
    const minutes = Math.max(1, Math.ceil((pausedUntil - now()) / 60000));
    return `Google is asking to confirm you're not a robot. Open google.com in a Jonah tab and complete the check; automatic searches (Trust Engine, AI chat) are paused until then, or for about ${minutes} more minute${minutes === 1 ? "" : "s"}.`;
  }

  function windowFor() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, images: false },
    });
    win.webContents.setAudioMuted(true);
    if (userAgent) win.webContents.setUserAgent(userAgent);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    return win;
  }

  async function searchOnce(query) {
    if (closed) throw new GoogleSearchError("closed", "Jonah is closing");
    if (now() < pausedUntil) throw new GoogleSearchError("captcha", pauseMessage());
    const wait = lastAt + minGapMs - now();
    if (wait > 0) await sleep(wait);
    lastAt = now();

    const w = windowFor();
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&hl=en`;
    // Read as soon as the page's HTML is in (dom-ready): the results are in it. Waiting for the WHOLE page to finish loading
    // (Google keeps fetching scripts, images and pings long after) is what made searches time out inside Jonah.
    let loadError = null;
    let onReady = null;
    const loaded = w.loadURL(url).then(() => "loaded", (err) => { loadError = err; return "failed"; });
    const ready = new Promise((resolve) => { onReady = () => resolve("ready"); w.webContents.once("dom-ready", onReady); });
    let timedOut = false;
    try {
      await withTimeout(Promise.race([loaded, ready]), loadTimeoutMs, () => new GoogleSearchError("timeout", "Google did not answer in time"));
    } catch (err) {
      if (!(err instanceof GoogleSearchError)) throw err;
      timedOut = true; // still slow: read whatever has arrived before giving up
    } finally {
      w.webContents.removeListener("dom-ready", onReady);
    }
    // ERR_ABORTED (-3) happens when Google redirects mid-load (e.g. to its check page): read whatever page we ended up on
    if (loadError && !/ERR_ABORTED|\(-3\)/.test(String(loadError.message))) {
      throw new GoogleSearchError("load_failed", `Google could not be reached (${String(loadError.message || loadError).slice(0, 120)})`);
    }
    let page;
    const read = (ms = readTimeoutMs) => withTimeout(w.webContents.executeJavaScript(READ_SCRIPT, true), ms, () => new GoogleSearchError("timeout", "Google's page could not be read in time"));
    try {
      try {
        page = await read();
      } catch (err) {
        // A page whose scripts are still running answers LATE, not never (its thread is busy): read once more, but only while it is loading.
        const loading = !w.isDestroyed() && w.webContents.isLoading();
        log(`the read timed out; url=${w.isDestroyed() ? "(window gone)" : String(w.webContents.getURL()).slice(0, 90)} loading=${loading} timedOutLoading=${timedOut}`);
        if (!(err instanceof GoogleSearchError) || !loading) throw err;
        // Measured: with the PC busy (all cores saturated) the same page needed ~14 s in total; two 5-second reads were not enough on a
        // real machine. The script is queued in the page's thread and runs the moment that thread is free, so the second wait is long.
        log(`Google's page was still loading when the read timed out: waiting up to ${Math.round(patientReadMs / 1000)} s more`);
        page = await read(patientReadMs);
      }
    } catch (err) {
      throw timedOut ? new GoogleSearchError("timeout", "Google did not answer in time") : err;
    }
    try { w.webContents.stop(); } catch (_) { /* the rest of the page is not needed */ }
    if (!page || typeof page !== "object" || (timedOut && !page.captcha && !page.consent && !(page.items && page.items.length))) {
      throw new GoogleSearchError("timeout", "Google did not answer in time");
    }

    if (page.captcha) {
      pausedUntil = now() + CAPTCHA_PAUSES_MS[Math.min(strikes, CAPTCHA_PAUSES_MS.length - 1)];
      strikes += 1;
      log(`Google showed its robot check; automatic searches paused (strike ${strikes})`);
      throw new GoogleSearchError("captcha", pauseMessage());
    }
    if (page.consent) throw new GoogleSearchError("consent", "Google is showing its cookie-consent page. Open google.com in a Jonah tab and choose an option once; searches work after that.");
    if (!/^https:\/\/www\.google\.[a-z.]+\/search/i.test(page.url)) throw new GoogleSearchError("unexpected_page", "Google's results page did not open (was it blocked by Focus Mode or a filter?)");
    strikes = 0;
    return { items: page.items, noResults: page.noResults };
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (jobs.length) {
        const job = jobs.shift();
        try {
          job.resolve(await searchOnce(job.query));
        } catch (err) {
          job.reject(err);
        }
      }
    } finally {
      running = false;
    }
  }

  /**
   * Search Google. Resolves { items: [{ title, link, snippet, displayLink }], noResults }. Rejects with GoogleSearchError.
   * One search runs at a time. `priority` is for a searcher a PERSON is waiting on (the AI chat): it goes ahead of every search
   * still WAITING in line (the Trust Engine queues about eight per site it checks) but never interrupts the one already running,
   * and the gap and robot-check rules apply to it exactly as to any other.
   */
  function search(query, { priority = false } = {}) {
    return new Promise((resolve, reject) => {
      const job = { query: String(query || "").trim(), priority: !!priority, resolve, reject };
      if (job.priority) {
        const firstBackground = jobs.findIndex((j) => !j.priority);
        jobs.splice(firstBackground < 0 ? jobs.length : firstBackground, 0, job);
      } else {
        jobs.push(job);
      }
      pump();
    });
  }

  function close() {
    closed = true;
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  return { search, close, status: () => ({ pausedUntil, strikes }) };
}

module.exports = { createGoogleSearch, GoogleSearchError, readResultsPage, MIN_GAP_MS, CAPTCHA_PAUSES_MS };
