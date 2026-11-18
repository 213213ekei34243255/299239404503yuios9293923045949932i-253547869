// noah-boot.js - starts Electron Jonah's Noah agent (noah-bundle.js, unchanged code) inside Jonah's side panel, the way
// Noah/index.cjs + Noah/ipc.cjs did in Electron: config, core (tabs, browser control, safety, executor, verifier), model router,
// agent and command router; the agent's events go to Noah's panel as "noah:event" (ai-panel.html already shows them).
// Not started here: desktop/computer missions and the desktop guard (they drive Windows itself, which a browser page cannot).
(function () {
  "use strict";
  window.JonahNoahReady = (async () => {
    const B = window.NoahBuiltins;
    await B.ready();
    const R = window.NoahRequire;
    const log = (...a) => console.log("[noah]", ...a);
    const post = (type, payload) => window.postMessage({ type, payload }, "*");

    // the parts of an Electron BrowserWindow the core touches; the browser's real tabs are in browser/tabs.cjs
    const rect = () => ({ x: 0, y: 0, width: screen.availWidth, height: screen.availHeight });
    const mainWindow = {
      id: 0, isDestroyed: () => false, isFocused: () => document.hasFocus(), isMinimized: () => false, focus() {},
      getBounds: rect, getContentBounds: rect, on() {}, once() {}, removeListener() {},
      webContents: { id: 0, send() {}, on() {}, once() {}, removeListener() {}, isDestroyed: () => false, executeJavaScript: async () => null },
    };
    const electron = Object.assign({}, B.modules.electron, { webContents: { fromId: () => null, getAllWebContents: () => [] } });

    const dataDir = "/noah-data";
    const { ConfigStore } = R("config.cjs");
    const { createCore } = R("core.cjs");

    // Jonah fix for Noah's click check (agent/verifier.cjs compares page fingerprints before/after a click). The focused-element
    // part of the fingerprint is "tag|id|value", so ticking a radio button right after ticking another one with the same value
    // ("1" on a quiz, "yes" on a form) looked like NOTHING changed: a correct click was reported "no effect", the model retried
    // already-ticked answers and finally gave up as "stuck". The fingerprint now also carries which radios/checkboxes are ticked
    // and what each dropdown shows, so any change to an answer counts as a change.
    {
      const { Observer } = R("perception/observer.cjs");
      const FORM_STATE = `(() => { try { let h = 5381; const add = (t) => { for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; };
        const all = document.querySelectorAll("input[type=radio],input[type=checkbox],[role=radio],[role=checkbox],[role=switch],[role=option],select");
        for (let i = 0; i < all.length && i < 3000; i++) { const e = all[i];
          const on = e.tagName === "SELECT" ? "s" + e.selectedIndex : (e.checked || e.getAttribute("aria-checked") === "true" || e.getAttribute("aria-selected") === "true") ? "1" : "";
          if (on) add(i + ":" + on + ";"); }
        return String(h); } catch (e) { return ""; } })()`;
      const base = Observer.prototype.fingerprint;
      Observer.prototype.fingerprint = async function () {
        const fp = await base.apply(this, arguments);
        if (!fp || fp.dialog || fp.error) return fp;
        const forms = await this.cdp.evaluate(FORM_STATE, { timeoutMs: 2000 }).catch(() => "");
        if (forms) fp.active = (fp.active || "") + "#forms:" + forms;
        return fp;
      };
    }
    const { ModelRouter } = R("models/router.cjs");
    const { NoahAgent } = R("agent/noah-agent.cjs");
    const { CommandRouter } = R("agent/command-router.cjs");

    const config = new ConfigStore({ dir: dataDir, appRoot: "/noah", env: {}, safeStorage: electron.safeStorage });
    const core = createCore({ mainWindow, electron, config, dataDir, log });
    // The hosted brain, as in Electron: noahai.live (/api/llm/step), ready while the Jonah account is signed in; requests signed
    // with this device's key (jonah-account.js).
    const providers = {};
    const A = window.JonahAccount;
    if (A) {
      await A.ready;
      const { NoahaiProvider } = R("models/noahai.cjs");
      providers.noahai = new NoahaiProvider({ name: "noahai", baseURL: A.baseURL, getKey: () => null, isSignedIn: A.isSignedIn, getAuthHeaders: A.signedHeaders, options: config.get().providers.noahai });
    }
    const router = new ModelRouter({ config, bus: core.bus, providers, log });
    let experience = null;
    try { experience = R("experience/index.cjs").createExperience({ dir: dataDir + "/experience", bus: core.bus, getAccountId: () => null, log }); } catch (err) { log("experience off:", err.message); }
    const agent = new NoahAgent({ core, router, config, dataDir, log, experience });
    const commandRouter = new CommandRouter({ session: core.session, agent, missions: null, log, experience });

    const tabs = core.tabs || (core.browser && core.browser.tabs);

    // ---- Noah's overlay on the page (Electron: noah-overlay.js over the <webview>): purple cursor, status, STOP, confirmations
    let overlayTab = null, overlayCss = null;
    async function ensureOverlay() {
      try {
        const t = tabs && (await tabs.active());
        if (!t || !/^https?:/.test(t.url || "")) return null;
        const target = { tabId: t.wcId };
        // the overlay's CSS goes inside its closed shadow root (noah-overlay-page.js), not into the page's own styles
        if (overlayCss == null) overlayCss = await fetch(chrome.runtime.getURL("css/noah-overlay.css")).then((r) => r.text()).catch(() => "");
        await chrome.scripting.executeScript({ target, func: (css) => { window.__jonahNoahCss = css; }, args: [overlayCss] });
        await chrome.scripting.executeScript({ target, files: ["js/noah-overlay.js", "js/noah-overlay-page.js"] });
        overlayTab = t.wcId;
        chrome.tabs.sendMessage(overlayTab, { type: "noah:overlay-config", cfg: config.publicView() }).catch(() => {});
        return overlayTab;
      } catch (_) { return null; } // a page Jonah may not draw on (browser pages, the Web Store): the panel still shows progress
    }
    const toOverlay = (evt) => { if (overlayTab != null) chrome.tabs.sendMessage(overlayTab, { type: "noah:overlay-event", evt }).catch(() => {}); };
    // a new page (navigation, new tab) needs the overlay again while a task runs
    chrome.tabs.onUpdated.addListener((id, change) => { if (agent.current && change.status === "complete") ensureOverlay(); });
    chrome.tabs.onActivated.addListener(() => { if (agent.current) ensureOverlay(); });
    // the overlay's buttons
    chrome.runtime.onMessage.addListener((m, sender) => {
      if (!m || m.type !== "noah:overlay-cmd" || !sender.tab) return;
      if (m.cmd === "stop") agent.stop("user_button");
      else if (m.cmd === "resume") agent.resume();
      else if (m.cmd === "confirm") core.safety.resolveConfirmation(String(m.id), m.allow === true);
    });

    core.bus.subscribe((evt) => {
      if (!evt) return;
      if (evt.event === "task_started") ensureOverlay().then(() => toOverlay(evt));
      else toOverlay(evt); // the overlay draws the cursor from mouse/keyboard/scroll events
      if (/^(mouse|scroll|keyboard)_action$/.test(evt.event)) return; // the panel gets the human-relevant subset
      post("noah:event", evt);
      // stop debugging the tabs when a task is over (Chromium's "debugging" bar goes away)
      if (evt.event === "task_finished" && tabs && tabs.detachAll) setTimeout(() => { if (!agent.current) tabs.detachAll(); }, 1500);
    });

    window.JonahNoah = { agent, config, core, router, commandRouter };
    log("Noah is ready; agent available:", agent.isAvailable());
    return window.JonahNoah;
  })();
  window.JonahNoahReady.catch((err) => console.error("[noah] could not start:", err));
})();
