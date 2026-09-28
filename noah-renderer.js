// noah-renderer.js  (classic script, loaded by index.html after renderer.js)
//
// Shell-side bridge for Noah:
//   1. window.NoahRenderer  - what the main process asks of the shell: the tab
//      list (with each <webview>'s webContents id), tab switching/creation, and
//      the live <webview> rectangle used to place the cursor overlay.
//   2. Event relay          - main -> overlay + AI panel, panel -> main.
//
// No page ever sees any of this: it lives in the shell window, which is not
// reachable from <webview> guests. The AI panel <iframe> talks to it through
// postMessage, and only messages whose source is that iframe are honoured.

(function () {
  "use strict";

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (_) {
      return fallback;
    }
  }

  function tabsSource() {
    const list = typeof tabData !== "undefined" ? tabData : [];
    const active = typeof activeTabIndex !== "undefined" ? activeTabIndex : 0;
    return { list, active };
  }

  function activeWebview() {
    const { list, active } = tabsSource();
    return (list[active] && list[active].webview) || document.getElementById("browser");
  }

  window.NoahRenderer = {
    /** [{ index, wcId, title, url, active, partition }] */
    tabs() {
      const { list, active } = tabsSource();
      return list.map((t, i) => ({
        index: i,
        wcId: safe(() => t.webview.getWebContentsId(), null),
        title: t.title || "",
        url: safe(() => t.webview.getURL(), t.url || ""),
        active: i === active,
        partition: safe(() => t.webview.getAttribute("partition"), null),
      }));
    },

    switchTab(index) {
      if (typeof switchTab !== "function") return false;
      switchTab(index);
      return true;
    },

    /** Open a tab. `partition` (optional) puts it in a separate, non-shared session. */
    newTab(url, partition) {
      if (typeof createNewTab !== "function") return false;
      createNewTab(url || "home.html", partition ? { partition } : {});
      return true;
    },

    closeTab(index) {
      if (typeof closeTab !== "function") return false;
      const el = document.querySelectorAll(".tab")[index];
      if (!el) return false;
      closeTab(el);
      return true;
    },

    /** The active <webview>'s rectangle in shell CSS px. */
    webviewRect() {
      const w = activeWebview();
      if (!w) return null;
      const r = w.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },

    activeWebview,
  };

  // ------------------------------------------------------------------ relay
  function panelFrame() {
    return document.querySelector("#aiPanel iframe");
  }

  function toPanel(type, payload) {
    const f = panelFrame();
    if (f && f.contentWindow) f.contentWindow.postMessage({ type, payload }, "*");
  }

  function init() {
    if (!window.noah) return; // preload did not expose the Noah API (older shell)
    const overlay = window.NoahOverlay ? window.NoahOverlay.mount(window.NoahRenderer) : null;

    window.noah.getTheme().then((theme) => overlay && overlay.applyTheme(theme)).catch(() => {});
    window.noah.getConfig().then((cfg) => {
      overlay && overlay.applyConfig(cfg);
      toPanel("noah:config", cfg);
    }).catch(() => {});

    window.noah.onEvent((evt) => {
      if (overlay) overlay.handle(evt);
      // The panel gets the human-relevant subset (no per-frame mouse noise).
      switch (evt.event) {
        case "mouse_action":
        case "scroll_action":
        case "keyboard_action":
          break;
        default:
          toPanel("noah:event", evt);
      }
    });

    window.addEventListener("message", (e) => {
      const f = panelFrame();
      if (!f || e.source !== f.contentWindow) return; // only our own panel
      const d = e.data || {};

      // A link clicked inside an assistant reply opens in a new tab (the panel must never navigate itself away). http(s) only.
      if (d.type === "noah:open-url") {
        try {
          const u = new URL(String(d.url));
          if (u.protocol === "http:" || u.protocol === "https:") window.NoahRenderer.newTab(u.href);
        } catch (_) { /* not a URL: ignore */ }
        return;
      }

      // A file attached in the panel: the bytes go to the main process (which reads it); the panel gets back only an id + summary.
      if (d.type === "noah:attach-file") {
        const reqId = String(d.reqId || "").slice(0, 40);
        const reply = (result) => toPanel("noah:attach-result", { reqId, result });
        if (!window.api || typeof window.api.attachFile !== "function") return reply({ ok: false, error: "File attachments are not available in this build." });
        if (!(d.data instanceof ArrayBuffer)) return reply({ ok: false, error: "The file was not received." });
        window.api.attachFile(String(d.name || "file"), new Uint8Array(d.data)).then(reply).catch((err) => reply({ ok: false, error: "Could not read this file: " + (err && err.message ? err.message : err) }));
        return;
      }
      if (d.type === "noah:attach-remove") {
        if (window.api && window.api.removeAttachment && typeof d.id === "string") window.api.removeAttachment(d.id).catch(() => {});
        return;
      }
      if (d.type === "noah:attach-clear") {
        if (window.api && window.api.clearAttachments) window.api.clearAttachments().catch(() => {});
        return;
      }

      if (d.type !== "noah:cmd") return;
      switch (d.cmd) {
        case "submit": return void (typeof d.goal === "string" && window.noah.submit(d.goal));
        case "stop": return void window.noah.stop();
        case "pause": return void window.noah.pause();
        case "resume": return void window.noah.resume();
        case "confirm": return void window.noah.confirm(d.id, !!d.allow);
        case "config":
          return void window.noah.setConfig(d.patch || {}).then((cfg) => {
            overlay && overlay.applyConfig(cfg);
            toPanel("noah:config", cfg);
          });
        case "get-config":
          return void window.noah.getConfig().then((cfg) => toPanel("noah:config", cfg));
        case "get-state":
          return void window.noah.getState().then((st) => st && st.session && toPanel("noah:event", Object.assign({ event: "session_state" }, st.session))).catch(() => {});
        case "resume-task": return void window.noah.resumeTask(d.taskId);
        default: return undefined;
      }
    });

    // ESC stops the agent even if focus is in the shell (main also listens for
    // keys inside the webview; this covers the shell chrome).
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") window.noah.stop();
    }, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
