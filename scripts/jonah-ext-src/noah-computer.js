// noah-computer.js - Noah's panel side of Jonah's computer agent. The agent itself (Electron Jonah's Noah/autonomy + Noah/desktop, unchanged)
// runs in <exe dir>\noah-native (noah-native-host.cjs, in Node), started by Chromium's native messaging when this file connects to it.
//   - computer tasks ("open Notepad and write...") and project tasks (files, commands, tests in a folder you pick) go there, through
//     Electron's own CommandRouter running there;
//   - its events come back as "noah:event" (the panel shows them as in Electron) and its results as rexy:goal-* chat messages;
//   - its requests to noahai.live are signed HERE with the Jonah account's device key (the key never leaves the browser);
//   - Stop / Pause / Continue / confirmation answers go there too. Closing the connection stops it at once.
(function () {
  "use strict";
  const HOST = "com.cogniai.jonah.noah";
  const post = (type, payload) => window.postMessage({ type, payload }, "*");
  const A = () => window.JonahAccount || null;

  let port = null, state = null, connecting = null, seq = 0, lastError = "";
  const waiting = new Map();
  const listeners = new Set();

  // Administrator access (Windows; OFF by default). Remembered by Jonah; the helper is told on connect and when it changes.
  // Only Noah's Windows helper runs elevated (after Windows' own prompt) - the browser and web pages never do.
  const ADMIN_KEY = "jonahNoahAdmin";
  let adminOn = false, adminLive = null;
  const adminLoaded = chrome.storage.local.get(ADMIN_KEY).then((r) => { adminOn = r && r[ADMIN_KEY] === true; }).catch(() => {});
  function adminView() {
    const live = adminLive || {};
    return {
      supported: true,
      enabled: adminOn,
      elevated: !!live.elevated,
      declinedAtStart: !!live.declined || !!live.declinedAtStart,
      note: adminOn ? (live.elevated ? "" : live.declinedAtStart ? "" : "Windows will ask for permission the next time Noah works on your computer.") : "",
      message: adminOn && live.declinedAtStart ? "Windows did not give permission: Noah works normally (without administrator rights)." : undefined,
    };
  }
  async function setAdmin(enabled) {
    await adminLoaded;
    adminOn = enabled === true;
    adminLive = adminOn ? adminLive : null;
    await chrome.storage.local.set({ [ADMIN_KEY]: adminOn }).catch(() => {});
    if (port) port.postMessage({ t: "admin", enabled: adminOn });
    return adminView();
  }

  function accountMsg() {
    const a = A();
    let signedIn = false, accountId = null;
    try { signedIn = !!(a && a.isSignedIn()); accountId = a && a.accountId ? a.accountId() : null; } catch (_) { /* not ready */ }
    return { signedIn, accountId, baseURL: a ? a.baseURL : null };
  }

  function connect() {
    if (port && state) return Promise.resolve(state);
    if (connecting) return connecting;
    connecting = adminLoaded.then(() => new Promise((resolve, reject) => {
      let p;
      try { p = chrome.runtime.connectNative(HOST); } catch (e) { connecting = null; reject(e); return; }
      port = p;
      const timer = setTimeout(() => { if (!state) { lastError = "Noah's computer helper did not start in time."; try { p.disconnect(); } catch (_) {} cleanup(); reject(new Error(lastError)); } }, 45_000);
      const cleanup = () => {
        clearTimeout(timer);
        if (port === p) { port = null; state = null; }
        connecting = null;
        for (const [, w] of waiting) w.reject(new Error("Noah's computer helper stopped."));
        waiting.clear();
      };
      p.onDisconnect.addListener(() => {
        lastError = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "Noah's computer helper stopped.";
        const wasReady = !!state;
        cleanup();
        if (!wasReady) reject(new Error(lastError));
        listeners.forEach((f) => { try { f({ type: "disconnected", error: lastError }); } catch (_) {} });
      });
      p.onMessage.addListener((m) => {
        if (!m) return;
        switch (m.t) {
          case "admin-state":
            adminLive = m.state || null;
            post("noah:admin-state", adminView());
            return;
          case "ready":
            state = m.state || {};
            clearTimeout(timer);
            p.postMessage(Object.assign({ t: "hello" }, accountMsg(), { config: currentConfig(), admin: adminOn }));
            connecting = null;
            resolve(state);
            return;
          case "state":
            state = m.state || state;
            return;
          case "result": {
            const w = waiting.get(m.id);
            if (!w) return;
            waiting.delete(m.id);
            if (m.error) w.reject(new Error(m.error)); else w.resolve(m.value);
            return;
          }
          case "event":
            onEvent(m.evt);
            return;
          case "sign": {
            const a = A();
            Promise.resolve(a ? a.signedHeaders(m.method, m.path, m.body || "") : Promise.reject(new Error("no Jonah account")))
              .then((headers) => p.postMessage({ t: "rpc-reply", reqId: m.reqId, value: { headers } }))
              .catch((e) => p.postMessage({ t: "rpc-reply", reqId: m.reqId, error: String(e && e.message || e) }));
            return;
          }
          case "signin": {
            const a = A();
            Promise.resolve(a ? a.signIn() : false)
              .then(() => { p.postMessage(Object.assign({ t: "account" }, accountMsg())); p.postMessage({ t: "rpc-reply", reqId: m.reqId, value: { signedIn: accountMsg().signedIn } }); })
              .catch((e) => p.postMessage({ t: "rpc-reply", reqId: m.reqId, error: String(e && e.message || e) }));
            return;
          }
          case "websearch": // the chat's answer needs fresh facts (Electron: search-proxy.cjs -> google-serp.cjs)
            googleSearch(String(m.query || ""))
              .then((r) => p.postMessage({ t: "rpc-reply", reqId: m.reqId, value: r }))
              .catch((e) => p.postMessage({ t: "rpc-reply", reqId: m.reqId, value: { error: String(e && e.message || e), code: (e && e.code) || "error" } }));
            return;
          case "focus": // the Stop bar's Review button
            attention(true);
            return;
          case "notify":
            try {
              chrome.notifications.create("", { type: "basic", iconUrl: chrome.runtime.getURL("icons/jonah-128.png"), title: String(m.title || "Noah"), message: String(m.body || "").slice(0, 300) });
            } catch (_) { /* notifications off */ }
            return;
          default:
            return;
        }
      });
    }));
    return connecting;
  }

  function currentConfig() {
    try { return window.JonahNoah && window.JonahNoah.config ? window.JonahNoah.config.get() : null; } catch (_) { return null; }
  }

  function call(method, args, timeoutMs = 60_000) {
    return connect().then(() => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error("Noah's computer helper did not answer.")); }, timeoutMs);
      waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      port.postMessage(Object.assign({ t: "account" }, accountMsg())); // the sign-in state can change at any time
      port.postMessage({ t: "call", id, method, args: args || {} });
    }));
  }

  // ---- the confirmation card ("Noah needs your OK": Allow / Cancel) and the "Waiting for you / Continue" card.
  // In Electron every Noah event also reached noah-overlay.js, drawn over Jonah's window, and THAT is where these cards live. Computer
  // tasks have no web page to draw on, so the same overlay (unchanged) is mounted here, in Noah's panel, showing only its cards; its
  // buttons answer the computer agent. (Without it a confirmation had nowhere to be answered and the task waited for ever.)
  let overlay = null, overlayLoading = null;
  const PANEL_CARDS_CSS = ".noah-status,.noah-stop,.noah-cursor,.noah-ripple,.noah-trail,.noah-target,.noah-focus{display:none!important}" +
    ".noah-confirm,.noah-takeover{bottom:110px!important;box-sizing:border-box!important;width:calc(100vw - 24px)!important;max-width:460px;pointer-events:auto}";
  function ensureOverlay() {
    if (overlay) return Promise.resolve(overlay);
    if (overlayLoading) return overlayLoading;
    overlayLoading = (async () => {
      if (!window.NoahOverlay) await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "js/noah-overlay.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
      const css = await fetch(chrome.runtime.getURL("css/noah-overlay.css")).then((r) => r.text()).catch(() => "");
      const host = document.createElement("jonah-noah-cards");
      host.style.cssText = "all:initial !important; position:fixed !important; inset:0 !important; z-index:2147483000 !important; pointer-events:none !important; display:block !important;";
      const shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = css + PANEL_CARDS_CSS;
      shadow.appendChild(style);
      // what the overlay's buttons call (Electron: window.noah.*)
      if (!window.noah) window.noah = { stop: () => window.JonahComputer.stop(), resume: () => window.JonahComputer.resume(), confirm: (id, allow) => window.JonahComputer.confirm(id, allow) };
      const ov = window.NoahOverlay.mount({ webviewRect: () => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }) });
      const root = document.getElementById("noahOverlay");
      if (root) shadow.appendChild(root);
      document.documentElement.appendChild(host);
      ov.applyConfig({ cursor: { mode: "off" } });
      overlay = ov;
      return ov;
    })().finally(() => { overlayLoading = null; });
    return overlayLoading;
  }
  const CARD_EVENTS = new Set(["confirm_request", "confirm_resolved", "safety", "ask_user", "session_state"]);
  function toCards(e) {
    let evt = e;
    // a computer task ending is "mission_result" / "mission_finished": the overlay knows "task_finished" (it clears its cards)
    if (e.event === "mission_result" || e.event === "mission_finished") evt = { event: "task_finished", status: e.status === "completed" || e.status === "done" ? "completed" : "cancelled" };
    else if (!CARD_EVENTS.has(e.event)) return;
    if (!overlay && evt.event !== "confirm_request" && evt.event !== "safety" && evt.event !== "ask_user") return;
    ensureOverlay().then((o) => o.handle(evt)).catch((err) => console.warn("[noah] cards:", err));
  }
  // bring Jonah forward (taskbar flash, as Electron did) and on demand (the Stop bar's Review button, a notification click)
  function attention(focus) {
    chrome.windows.getCurrent().then((w) => chrome.windows.update(w.id, focus ? { focused: true, drawAttention: false } : { drawAttention: true })).catch(() => {});
  }
  try { chrome.notifications.onClicked.addListener(() => attention(true)); } catch (_) { /* notifications off */ }

  // ---- the chat's web search: js/jonah-google-search.js (Electron's google-serp.cjs rules; shared with the Trust Engine)
  const googleSearch = (query) => self.JonahGoogleSearch.search(query);

  // what Electron's index.cjs turned into chat messages, plus the live events for the panel's status line and Activity view
  function onEvent(e) {
    if (!e) return;
    post("noah:event", e);
    toCards(e);
    if (e.event === "confirm_request") attention(false);
    listeners.forEach((f) => { try { f({ type: "event", evt: e }); } catch (_) {} });
    switch (e.event) {
      case "ask_user":
        post("rexy:goal-paused", { result: { message: e.question, paused: true }, agent: true });
        break;
      case "mission_result":
        if (e.status === "cancelled" && e.text === "Stopped.") break;
        if (e.resumable) post("rexy:goal-paused", { result: { message: e.text, paused: true }, agent: true });
        else if (e.status === "impossible" || e.status === "unsafe") post("rexy:goal-error", { error: e.text, agent: true });
        else post("rexy:goal-completed", { reason: e.text, agent: true });
        break;
      default:
        break;
    }
  }

  window.JonahComputer = {
    connect,
    /** Electron's CommandRouter decides, in the helper: computer task, project task, answer to a question, stop/continue, or "not mine". */
    route: (text, { mode = "computer", source = "text" } = {}) => call("route", { text, mode, source }, 120_000),
    stop: () => (port ? call("stop", {}, 10_000).catch(() => null) : Promise.resolve(null)),
    pause: () => (port ? call("pause", {}, 10_000).catch(() => null) : Promise.resolve(null)),
    resume: () => (port ? call("resume", {}, 10_000).catch(() => null) : Promise.resolve(null)),
    confirm: (id, allow) => { if (port) port.postMessage({ t: "confirm", id: String(id), allow: allow === true }); },
    config: (patch) => { if (port) port.postMessage({ t: "config", patch: patch || {} }); },
    state: () => state,
    connected: () => !!(port && state),
    isBusy: () => !!(state && (state.running || state.awaiting || state.canResume)),
    lastError: () => lastError,
    /** read-only check: the helper starts, its Windows UI Automation part answers and lists the open windows (moves nothing) */
    selftest: () => call("selftest", {}, 120_000),
    googleSearch: (q) => googleSearch(q), // diagnostics
    ocr: (base64) => call("ocr", { image: base64 }, 60_000),
    adminGet: async () => { await adminLoaded; return adminView(); },
    adminSet: setAdmin,
    _call: (method, args, ms) => call(method, args, ms), // diagnostics (the helper only answers calls it knows)
    onChange: (f) => { listeners.add(f); return () => listeners.delete(f); },
  };
})();
