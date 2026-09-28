// Noah/test/unit/google-serp.test.cjs
//
// google-serp.cjs's queue (one search at a time; a person's search jumps ahead of WAITING background ones), its robot-check pause, and
// the patient re-read of a page that is slow to answer - with a fake browser window, so timing and order are exact. (The in-page
// reader itself, and Google's real pages, are exercised by running the real thing: see the notes in the memory file.)
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGoogleSearch } = require("../../../google-serp.cjs");

/** A stand-in for Electron's BrowserWindow. `behave(query, callNo)` returns the page the reader would see, throws, or returns a promise. */
function fakeWindows(behave) {
  const state = { order: [], reads: {}, concurrent: 0, maxConcurrent: 0 };
  class FakeWindow {
    constructor() {
      this._q = "";
      this._loading = false;
      this.webContents = {
        setAudioMuted() {},
        setUserAgent() {},
        setWindowOpenHandler() {},
        once: (ev, cb) => { if (ev === "dom-ready") setImmediate(cb); },
        removeListener() {},
        stop() {},
        isLoading: () => this._loading,
        getURL: () => `https://www.google.com/search?q=${encodeURIComponent(this._q)}`,
        executeJavaScript: async () => {
          const q = this._q;
          state.reads[q] = (state.reads[q] || 0) + 1;
          state.concurrent++;
          state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
          try {
            return await behave(q, state.reads[q], this);
          } finally {
            state.concurrent--;
          }
        },
      };
    }
    isDestroyed() { return false; }
    destroy() {}
    loadURL(url) {
      this._q = decodeURIComponent(new URL(url).searchParams.get("q"));
      state.order.push(this._q);
      this._loading = true;
      return new Promise(() => {}); // never settles: the reader goes by dom-ready, like the real page that keeps loading
    }
  }
  return { FakeWindow, state };
}
const page = (q, extra = {}) => ({ captcha: false, consent: false, items: [{ title: `result for ${q}`, link: `https://example.com/${encodeURIComponent(q)}`, snippet: "s", displayLink: "example.com" }], noResults: false, url: `https://www.google.com/search?q=${encodeURIComponent(q)}`, ...extra });
const make = (behave, opts = {}) => {
  const { FakeWindow, state } = fakeWindows(behave);
  const logs = [];
  const g = createGoogleSearch({ BrowserWindow: FakeWindow, minGapMs: 0, sleep: async () => {}, readTimeoutMs: 60, patientReadMs: 150, loadTimeoutMs: 200, log: (...a) => logs.push(a.join(" ")), ...opts });
  return { g, state, logs };
};

test("searches run one at a time, in order", async () => {
  const { g, state } = make(async (q) => page(q));
  const results = await Promise.all(["a", "b", "c", "d"].map((q) => g.search(q)));
  assert.deepEqual(state.order, ["a", "b", "c", "d"]);
  assert.equal(state.maxConcurrent, 1, "never two pages being read at once");
  assert.deepEqual(results.map((r) => r.items[0].title), ["result for a", "result for b", "result for c", "result for d"]);
});

test("a person's search jumps ahead of WAITING background searches, but never interrupts the one running", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { g, state } = make(async (q) => {
    if (q === "bg1") await gate; // bg1 is running (its page is being read) while the others queue up behind it
    return page(q);
  }, { readTimeoutMs: 5000 });
  const all = [g.search("bg1"), g.search("bg2"), g.search("bg3")];
  await new Promise((r) => setTimeout(r, 30));
  const chat = g.search("chat question", { priority: true });
  const chat2 = g.search("second chat question", { priority: true });
  release();
  await Promise.all([...all, chat, chat2]);
  assert.deepEqual(state.order, ["bg1", "chat question", "second chat question", "bg2", "bg3"], "priority ones first (in their own order), background ones after, the running one undisturbed");
});

test("a robot check pauses searches - priority ones too (the rules are Google's, not ours to skip)", async () => {
  const { g } = make(async (q) => (q === "trigger" ? page(q, { captcha: true, items: [] }) : page(q)));
  await assert.rejects(g.search("trigger"), (e) => e.code === "captcha");
  await assert.rejects(g.search("anything", { priority: true }), (e) => e.code === "captcha" && /not a robot/i.test(e.message));
});

test("a page that is slow to answer is read AGAIN while it is still loading (it answered late, not never)", async () => {
  const { g, state, logs } = make(async (q, callNo) => {
    if (callNo === 1) return new Promise(() => {}); // the first read never comes back inside the limit (a busy page)
    return page(q);
  });
  const r = await g.search("slow one");
  assert.equal(r.items.length, 1);
  assert.equal(state.reads["slow one"], 2, "read twice");
  assert.ok(logs.some((l) => /still loading/.test(l)), logs.join(" | "));
});

test("the second wait is LONGER than the first: a page that answers after the first limit but inside the patient one still succeeds", async () => {
  const { g } = make(async (q, callNo) => {
    if (callNo === 1) return new Promise(() => {});
    await new Promise((r) => setTimeout(r, 100)); // slower than the 60 ms first limit, faster than the 150 ms patient limit
    return page(q);
  });
  const r = await g.search("late but not dead");
  assert.equal(r.items.length, 1);
});

test("when the retry also fails, it fails clearly and says WHY (page url, loading state) instead of a bare timeout", async () => {
  const { g, logs } = make(async () => new Promise(() => {}));
  await assert.rejects(g.search("hopeless"), (e) => e.code === "timeout");
  assert.ok(logs.some((l) => /the read timed out; url=.*loading=true/.test(l)), logs.join(" | "));
});

test("a failed search does not block the ones behind it", async () => {
  const { g } = make(async (q) => { if (q === "bad") throw new Error("renderer crashed"); return page(q); });
  const results = await Promise.allSettled([g.search("bad"), g.search("good")]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
});
