"use strict";
// google-serp.cjs: web search through Google's own results page in a hidden window. The window is faked here (no Electron); the page
// reader itself (readResultsPage) runs against real HTML in Noah/bench/integration/google-serp-check.cjs.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createGoogleSearch, GoogleSearchError, CAPTCHA_PAUSES_MS } = require("../../../google-serp.cjs");

const RESULTS = { url: "https://www.google.com/search?q=python&hl=en", captcha: false, consent: false, noResults: false, items: [{ title: "Python", link: "https://www.python.org/", snippet: "s", displayLink: "www.python.org" }] };
const CAPTCHA = { url: "https://www.google.com/sorry/index?continue=x", captcha: true, consent: false, items: [] };

/** A fake Electron: `pages(url)` returns what the loaded page reads as (or an Error the load throws, or "hang"). */
function fakeElectron(pages) {
  const windows = [];
  const loads = [];
  const cookieListeners = [];
  let active = 0;
  let maxActive = 0;
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.current = null;
      windows.push(this);
      this.webContents = Object.assign(new EventEmitter(), {
        setAudioMuted: () => {},
        setUserAgent: (ua) => { this.userAgent = ua; },
        setWindowOpenHandler: () => {},
        stop: () => { this.stopped = true; },
        executeJavaScript: async () => { const page = this.current; active -= 1; return page; },
      });
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    async loadURL(url) {
      loads.push(url);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const page = pages(url);
      this.current = null;
      if (page === "hang") return new Promise(() => {});
      if (page && page.slowLoad) {
        // the HTML (and so the results) arrive at once, but the page never finishes loading its extras
        await new Promise((r) => setTimeout(r, 5));
        this.current = page.page;
        this.webContents.emit("dom-ready");
        return new Promise(() => {});
      }
      await new Promise((r) => setTimeout(r, 5));
      if (page instanceof Error) { active -= 1; throw page; }
      this.current = page;
      this.webContents.emit("dom-ready");
    }
  }
  const session = { fromPartition: (p) => ({ cookies: { on: (event, cb) => cookieListeners.push({ p, event, cb }) } }) };
  const emitCookie = (cookie, removed = false) => cookieListeners.forEach((l) => l.cb({}, cookie, "explicit", removed));
  return { BrowserWindow: FakeWindow, session, windows, loads, emitCookie, maxActive: () => maxActive };
}

function clock(start = 1_000_000) {
  const c = { t: start, slept: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.slept.push(ms); c.t += ms; };
  return c;
}

test("reads Google's results page in ONE hidden window of the browser's own session", async () => {
  const e = fakeElectron(() => RESULTS);
  const c = clock();
  const g = createGoogleSearch({ BrowserWindow: e.BrowserWindow, session: e.session, userAgent: "UA/1", now: c.now, sleep: c.sleep });
  const r = await g.search("  python language  ");
  assert.deepEqual(r.items, RESULTS.items);
  assert.equal(e.loads[0], "https://www.google.com/search?q=python%20language&hl=en");
  await g.search("second");
  assert.equal(e.windows.length, 1, "the hidden window is reused");
  const w = e.windows[0];
  assert.equal(w.options.show, false);
  assert.equal(w.options.webPreferences.partition, "persist:main", "same cookies / consent / robot-check clearance as the user's tabs");
  assert.equal(w.options.webPreferences.sandbox, true);
  assert.equal(w.options.webPreferences.nodeIntegration, false);
  assert.equal(w.userAgent, "UA/1");
});

test("one search at a time, spaced at least MIN_GAP apart", async () => {
  const e = fakeElectron(() => RESULTS);
  const c = clock();
  const g = createGoogleSearch({ BrowserWindow: e.BrowserWindow, now: c.now, sleep: c.sleep, minGapMs: 1500 });
  await Promise.all([g.search("a"), g.search("b"), g.search("c")]);
  assert.equal(e.maxActive(), 1, "never two pages loading at once");
  assert.deepEqual(c.slept, [1500, 1500], "the 2nd and 3rd searches waited for the gap");
  assert.equal(e.loads.length, 3);
});

test("ROBOT CHECK: never solved; searches pause (no page is even loaded) and the message tells the user what to do", async () => {
  let page = CAPTCHA;
  const e = fakeElectron(() => page);
  const c = clock();
  const g = createGoogleSearch({ BrowserWindow: e.BrowserWindow, session: e.session, now: c.now, sleep: c.sleep, minGapMs: 0 });
  await assert.rejects(g.search("q1"), (err) => err instanceof GoogleSearchError && err.code === "captcha" && /complete the check/.test(err.message) && /5 more minutes/.test(err.message));
  await assert.rejects(g.search("q2"), { code: "captcha" });
  assert.equal(e.loads.length, 1, "while paused Google is not asked again");

  c.t += CAPTCHA_PAUSES_MS[0] + 1;
  await assert.rejects(g.search("q3"), { code: "captcha" }, "after the pause one attempt is made; still a check -> a longer pause");
  assert.equal(e.loads.length, 2);
  assert.equal(g.status().pausedUntil, c.t + CAPTCHA_PAUSES_MS[1]);

  c.t += CAPTCHA_PAUSES_MS[1] + 1;
  page = RESULTS;
  assert.equal((await g.search("q4")).items.length, 1);
  assert.equal(g.status().strikes, 0, "a normal page resets the escalation");
});

test("ROBOT CHECK: when the user completes Google's check in a tab (clearance cookie), searches resume at once", async () => {
  let page = CAPTCHA;
  const e = fakeElectron(() => page);
  const c = clock();
  const g = createGoogleSearch({ BrowserWindow: e.BrowserWindow, session: e.session, now: c.now, sleep: c.sleep, minGapMs: 0 });
  await assert.rejects(g.search("q"), { code: "captcha" });
  e.emitCookie({ name: "SOME_OTHER_COOKIE" });
  await assert.rejects(g.search("q"), { code: "captcha" }, "an unrelated cookie changes nothing");
  e.emitCookie({ name: "GOOGLE_ABUSE_EXEMPTION" });
  page = RESULTS;
  assert.equal((await g.search("q")).items.length, 1);
});

test("consent page, a blocked/redirected page, load failures and timeouts are reported with clear codes", async () => {
  const c = clock();
  const make = (pages, extra = {}) => createGoogleSearch({ BrowserWindow: fakeElectron(pages).BrowserWindow, now: c.now, sleep: c.sleep, minGapMs: 0, ...extra });
  await assert.rejects(make(() => ({ ...RESULTS, consent: true, items: [] })).search("q"), (err) => err.code === "consent" && /choose an option/.test(err.message));
  await assert.rejects(make(() => ({ ...RESULTS, url: "file:///C:/Jonah2/focus-blocked.html?site=google.com", items: [] })).search("q"), { code: "unexpected_page" });
  await assert.rejects(make(() => new Error("ERR_NAME_NOT_RESOLVED (-105) loading 'https://www.google.com/search'")).search("q"), (err) => err.code === "load_failed" && /could not be reached/.test(err.message));
  await assert.rejects(make(() => "hang", { loadTimeoutMs: 30 }).search("q"), { code: "timeout" });
});

test("results are read as soon as the page's HTML is in - a page that never finishes loading is NOT a timeout (the bug seen in Jonah)", async () => {
  const e = fakeElectron(() => ({ slowLoad: true, page: RESULTS }));
  const g = createGoogleSearch({ BrowserWindow: e.BrowserWindow, now: Date.now, sleep: async () => {}, minGapMs: 0, loadTimeoutMs: 200 });
  const started = Date.now();
  assert.equal((await g.search("q")).items.length, 1);
  assert.ok(Date.now() - started < 150, "did not wait for the page to finish loading");
  assert.equal(e.windows[0].stopped, true, "the rest of the page is not loaded");
  assert.equal(e.windows[0].webContents.listenerCount("dom-ready"), 0, "no listeners pile up across searches");
});

test("a load 'aborted' by a redirect still reads the page it landed on (Google redirecting to its check page)", async () => {
  const e = fakeElectron(() => { const err = new Error("ERR_ABORTED (-3) loading 'https://www.google.com/search?q=q'"); return err; });
  // the abort happens, but the window did land on the check page: simulate by pre-setting the page the window shows
  const g = createGoogleSearch({ BrowserWindow: e.BrowserWindow, now: Date.now, sleep: async () => {}, minGapMs: 0 });
  const pending = g.search("q");
  await new Promise((r) => setTimeout(r, 1));
  e.windows[0].current = CAPTCHA;
  await assert.rejects(pending, { code: "captcha" });
});

test("close(): the hidden window is destroyed (so it cannot keep Jonah running) and later searches refuse", async () => {
  const e = fakeElectron(() => RESULTS);
  const g = createGoogleSearch({ BrowserWindow: e.BrowserWindow, now: Date.now, sleep: async () => {}, minGapMs: 0 });
  await g.search("q");
  g.close();
  assert.equal(e.windows[0].isDestroyed(), true);
  await assert.rejects(g.search("q"), { code: "closed" });
});
