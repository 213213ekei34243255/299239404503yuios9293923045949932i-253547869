// jonah-trust.js - the Trust Engine's watcher, in Jonah's background (loaded by background.js). Electron Jonah's trust-panel.js did this
// in the browser shell: watch the active tab, and on a NEW site worth checking (not a hash/query change, not Jonah's own pages, not a local
// or IP address) ask the Trust Engine (Electron's Trust/*.cjs, unchanged, in Noah's helper) for a verdict and show the "Jonah Trust Score"
// card. The card is js/jonah-trust-card.js, drawn over the page in a closed layer the page cannot read.
//   jonahTrustEnabled (chrome.storage.local, default on) = Electron's "Trust Panel" menu switch.
(function (root) {
  "use strict";
  const HOST_NAME = "com.cogniai.jonah.noah";
  const KEY = "jonahTrustEnabled";
  const IDLE_MS = 3 * 60 * 1000; // the helper is let go after 3 minutes without a check (it starts again in under a second)

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

  // ---- Noah's helper, for the Trust Engine only (the panel has its own connection for Noah)
  let port = null, ready = null, seq = 0, idle = null;
  const waiting = new Map();
  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      let p;
      try { p = chrome.runtime.connectNative(HOST_NAME); } catch (e) { ready = null; reject(e); return; }
      port = p;
      const timer = setTimeout(() => { try { p.disconnect(); } catch (_) {} gone("Noah's helper did not start in time."); }, 30000);
      const gone = (why) => {
        clearTimeout(timer);
        if (port === p) { port = null; ready = null; }
        for (const [, w] of waiting) w.reject(new Error(why));
        waiting.clear();
        reject(new Error(why));
      };
      p.onDisconnect.addListener(() => gone((chrome.runtime.lastError && chrome.runtime.lastError.message) || "Noah's helper stopped."));
      p.onMessage.addListener((m) => {
        if (!m) return;
        if (m.t === "ready") { clearTimeout(timer); p.postMessage({ t: "hello", signedIn: false }); resolve(p); return; }
        if (m.t === "result") { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.error ? w.reject(new Error(m.error)) : w.resolve(m.value); } return; }
        if (m.t === "websearch") {
          root.JonahGoogleSearch.search(String(m.query || ""))
            .then((r) => p.postMessage({ t: "rpc-reply", reqId: m.reqId, value: r }))
            .catch((e) => p.postMessage({ t: "rpc-reply", reqId: m.reqId, value: { error: String((e && e.message) || e), code: (e && e.code) || "error" } }));
          return;
        }
        if (m.t === "sign" || m.t === "signin") p.postMessage({ t: "rpc-reply", reqId: m.reqId, error: "not used by the Trust Engine" });
      });
    });
    return ready;
  }
  async function call(method, args, ms) {
    await connect();
    clearTimeout(idle);
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const t = setTimeout(() => { waiting.delete(id); reject(new Error("Noah's helper did not answer.")); }, ms);
      waiting.set(id, {
        resolve: (v) => { clearTimeout(t); idleSoon(); resolve(v); },
        reject: (e) => { clearTimeout(t); idleSoon(); reject(e); },
      });
      port.postMessage({ t: "call", id, method, args });
    });
  }
  function idleSoon() {
    clearTimeout(idle);
    idle = setTimeout(() => { if (port && !waiting.size) { try { port.disconnect(); } catch (_) {} port = null; ready = null; } }, IDLE_MS);
  }

  // ---- state per tab: the host on screen and its card's state (Electron: one state for the active tab)
  const tabs = new Map(); // tabId -> { host, token, loading, deep, result, error, hidden }
  // Chromium stops an idle background after ~30 s and its memory goes with it: each tab's verdict is kept in session storage, so a
  // woken background still knows what it showed (and does not check the same site again, or forget to show the card after a reload).
  const SESSION_KEY = "jonahTrustTabs";
  const loaded = chrome.storage.session.get(SESSION_KEY).then((r) => {
    for (const [id, v] of Object.entries((r && r[SESSION_KEY]) || {})) {
      if (!v || !v.host || (!v.result && !v.error)) continue; // a check that was cut off: done again when needed
      tabs.set(Number(id), Object.assign({}, v, { loading: false }));
    }
  }).catch(() => {});
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const out = {};
      for (const [id, v] of tabs) if (v && v.host && (v.result || v.error)) out[id] = { host: v.host, deep: !!v.deep, result: v.result || null, error: v.error || null, hidden: !!v.hidden, token: v.token || 0 };
      chrome.storage.session.set({ [SESSION_KEY]: out }).catch(() => {});
    }, 200);
  }
  let enabled = true;
  chrome.storage.local.get(KEY).then((r) => { enabled = !(r && r[KEY] === false); }).catch(() => {});

  async function show(tabId, st) {
    if (st.hidden) return;
    const view = { loading: st.loading, deep: st.deep, result: st.result, error: st.error };
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["js/jonah-trust-card.js"] });
      await chrome.tabs.sendMessage(tabId, { type: "jonah:trust-card", view });
    } catch (_) { /* a page Jonah may not draw on (browser pages, the Web Store, a PDF) */ }
  }
  function hideCard(tabId) { chrome.tabs.sendMessage(tabId, { type: "jonah:trust-card", view: null }).catch(() => {}); }

  async function runCheck(tabId, host, { deep = false, force = false } = {}) {
    const st = tabs.get(tabId) || {};
    const token = (st.token || 0) + 1;
    Object.assign(st, { host, token, loading: true, deep, result: null, error: null, hidden: false });
    tabs.set(tabId, st);
    show(tabId, st);
    let res;
    try {
      // the engine bounds itself (60 s, deep 100 s); the card never waits longer than a little after that
      res = await Promise.race([call("trustCheck", { host, deepScan: deep, force }, (deep ? 115 : 75) * 1000), new Promise((r) => setTimeout(() => r({ ok: false, error: "timed out" }), (deep ? 115 : 75) * 1000))]);
    } catch (err) {
      res = { ok: false, error: err && err.message };
    }
    const now = tabs.get(tabId);
    if (!now || now.token !== token) return; // a newer site or check took over
    now.loading = false;
    if (res && res.ok && res.result) now.result = res.result;
    else if (res && res.skipped) { now.hidden = true; hideCard(tabId); return; }
    else now.error = "Couldn't check this site right now.";
    save();
    show(tabId, now);
  }

  /** the active tab may be on a new site (navigation, tab switch): Electron trust-panel.js syncTrust() */
  async function sync(tabId, url) {
    await loaded;
    if (!enabled) return;
    const host = checkableHost(url || "");
    const st = tabs.get(tabId);
    if (!host) { if (st) { st.host = null; st.token = (st.token || 0) + 1; } return; }
    if (st && st.host === host) { if (!st.hidden && (st.result || st.loading || st.error)) show(tabId, st); return; } // same site: the card again after a reload
    runCheck(tabId, host);
  }

  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status === "complete" && tab.active) sync(tabId, tab.url);
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") sync(tabId, t.url); }).catch(() => {});
  });
  chrome.tabs.onRemoved.addListener((tabId) => { tabs.delete(tabId); save(); });

  // the card's buttons, and the Trust Panel (menu) asking about the current site
  // the start page's Trending News: Noah's helper asks jonahbrowser.store with the owner's key (never given to a page)
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (!m || m.type !== "jonah:news" || !sender || sender.id !== chrome.runtime.id) return;
    call("news", { page: m.page || 1 }, 30000).then(reply, (e) => reply({ error: String((e && e.message) || e) }));
    return true;
  });

  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (!m || m.type !== "jonah:trust-cmd") return;
    (async () => {
      await loaded;
      // the card's buttons speak for their own web page; Jonah's own pages (the Trust Panel in the side panel or in a tab) ask about
      // the web page in front of the user
      const fromWebPage = sender.tab && /^https?:/i.test(sender.url || sender.tab.url || "");
      const tabId = fromWebPage ? sender.tab.id
        : ((await chrome.tabs.query({ active: true, lastFocusedWindow: true })).find((t) => /^https?:/i.test(t.url || "")) ||
           (await chrome.tabs.query({ active: true })).find((t) => /^https?:/i.test(t.url || "")) || {}).id;
      const st = tabId != null ? tabs.get(tabId) : null;
      switch (m.cmd) {
        case "close": if (st) { st.hidden = true; save(); } return { ok: true };            // the ✕: gone until the next NEW site
        case "retry": if (st && st.host) runCheck(tabId, st.host, { deep: st.deep, force: true }); return { ok: true };
        case "deep": if (st && st.host) runCheck(tabId, st.host, { deep: true }); return { ok: true };
        case "check": { // the Trust Panel's "Check this site" (also when the switch is off)
          const t = await chrome.tabs.get(tabId);
          const host = checkableHost(t.url || "");
          if (!host) return { ok: false, error: "This page is not a public website, so there is nothing to check." };
          runCheck(tabId, host, { deep: !!m.deep, force: !!m.force });
          return { ok: true };
        }
        case "get": {
          // the Trust Panel opened on a site nothing is known about yet (a tab opened before Jonah's background woke up): check it now
          if ((!st || !st.host) && tabId != null) {
            const t = await chrome.tabs.get(tabId).catch(() => null);
            const host = t && checkableHost(t.url || "");
            if (host) { runCheck(tabId, host); return { enabled, host, loading: true, result: null, error: null }; }
          }
          return { enabled, host: st ? st.host : null, loading: !!(st && st.loading), result: st ? st.result : null, error: st ? st.error : null };
        }
        case "enable":
          enabled = m.enabled !== false;
          await chrome.storage.local.set({ [KEY]: enabled });
          if (!enabled) { for (const [id] of tabs) hideCard(id); tabs.clear(); }
          else if (tabId != null) { const t = await chrome.tabs.get(tabId); sync(tabId, t.url); }
          return { ok: true, enabled };
        default: return { ok: false };
      }
    })().then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
    return true;
  });

  root.JonahTrust = { checkableHost, call };
})(self);
