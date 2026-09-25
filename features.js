/**
 * features.js
 * -----------------------------------------------------------------------
 * Renderer logic for the features layered on top of the existing Jonah
 * shell (index.html / main.cjs / preload.cjs):
 *
 *   - Light / dark theme toggle (shell chrome + forced-dark CSS injected
 *     into the active webview for sites with no dark theme of their own)
 *   - Focus Mode panel (site list, schedule, Pomodoro timer)
 *   - Incognito window launcher
 *   - In-app Notification Center (app events; camera/mic/site
 *     notifications themselves are handled at the OS/session level in
 *     main.cjs so every site gets them automatically)
 *   - "Read Aloud" — extracts the current page's text and speaks it
 *     through the existing Kokoro TTS pipeline (same voice/endpoint the
 *     voice orb uses).
 *
 * Everything here talks to window.api (see preload.cjs) and to the
 * #browser <webview> already defined in index.html.
 * -----------------------------------------------------------------------
 */

(function () {

  const $ = (sel) => document.querySelector(sel);
  function activeWebview() {
    // tabData/activeTabIndex are defined in renderer.js; fall back to the
    // single #browser webview if a multi-tab renderer isn't wired up yet.
    try {
      if (typeof tabData !== "undefined" && tabData[activeTabIndex]?.webview) {
        return tabData[activeTabIndex].webview;
      }
    } catch (e) {}
    return document.getElementById("browser");
  }

  // =====================================================================
  // NOTIFICATION CENTER
  // =====================================================================
  const notifications = [];
  const MAX_NOTIFICATIONS = 50;

  function pushNotification(title, body, icon) {
    notifications.unshift({ title, body: body || "", icon: icon || "🔔", time: new Date() });
    if (notifications.length > MAX_NOTIFICATIONS) notifications.length = MAX_NOTIFICATIONS;
    updateNotificationBadge();
    renderNotificationPanelIfOpen();
  }
  window.jonahNotify = pushNotification; // exposed so other scripts/features can log events

  function updateNotificationBadge() {
    const badge = document.getElementById("notifBadge");
    if (!badge) return;
    if (notifications.length === 0) { badge.style.display = "none"; return; }
    badge.style.display = "flex";
    badge.textContent = notifications.length > 9 ? "9+" : String(notifications.length);
  }

  function renderNotificationPanelIfOpen() {
    const panel = document.getElementById("notificationPanel");
    if (panel) renderNotificationPanel(panel);
  }

  function toggleNotificationPanel() {
    let panel = document.getElementById("notificationPanel");
    if (panel) { panel.remove(); return; }

    panel = document.createElement("div");
    panel.id = "notificationPanel";
    panel.className = "jonah-panel";
    document.body.appendChild(panel);
    renderNotificationPanel(panel);
  }

  function renderNotificationPanel(panel) {
    panel.innerHTML = `
      <div class="panel-header">
        🔔 Notifications
        <span title="Clear all" id="notifClearBtn">🗑</span>
        <span title="Close" id="notifCloseBtn">✕</span>
      </div>
      <div class="panel-body">
        ${
          notifications.length === 0
            ? "<div class='panel-item panel-empty'>No notifications yet</div>"
            : notifications.map(n => `
              <div class="panel-item notif-item">
                <div class="notif-title">${n.icon} ${escapeHtml(n.title)}</div>
                ${n.body ? `<div class="notif-body">${escapeHtml(n.body)}</div>` : ""}
                <div class="notif-time">${n.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
              </div>
            `).join("")
        }
      </div>
    `;
    panel.querySelector("#notifCloseBtn").onclick = () => panel.remove();
    panel.querySelector("#notifClearBtn").onclick = () => {
      notifications.length = 0;
      updateNotificationBadge();
      renderNotificationPanel(panel);
    };
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // Feed real app events into the notification center.
  if (window.api?.onTrackerBlocked) {
    let lastMilestone = 0;
    window.api.onTrackerBlocked(({ host, total }) => {
      // Don't spam one entry per request — surface every 10th block plus
      // the very first, which is plenty to feel "it's working".
      if (total === 1 || total - lastMilestone >= 10) {
        lastMilestone = total;
        pushNotification("Tracker blocked", `${host} — ${total} blocked total`, "🛡");
      }
    });
  }

  // =====================================================================
  // FOCUS MODE
  // =====================================================================
  function toggleFocusPanel() {
    let panel = document.getElementById("focusPanel");
    if (panel) { panel.remove(); return; }
    panel = document.createElement("div");
    panel.id = "focusPanel";
    panel.className = "jonah-panel";
    document.body.appendChild(panel);
    renderFocusPanel(panel);
  }

  async function renderFocusPanel(panel) {
    const settings = await window.api.getSettings();
    const f = settings.focusMode;
    const pomodoroActive = f.pomodoroEndsAt && f.pomodoroEndsAt > Date.now();
    const remainingMin = pomodoroActive ? Math.ceil((f.pomodoroEndsAt - Date.now()) / 60000) : 0;

    panel.innerHTML = `
      <div class="panel-header">
        🧘 Focus Mode
        <span id="focusCloseBtn">✕</span>
      </div>
      <div class="panel-body">
        <div class="focus-row">
          <button id="pomodoroBtn" class="focus-btn">
            ${pomodoroActive ? `Stop (${remainingMin}m left)` : "Start 25m Pomodoro"}
          </button>
        </div>
        <div class="focus-row">
          <label><input type="checkbox" id="scheduleToggle" ${f.scheduleEnabled ? "checked" : ""}> Block on a schedule</label>
        </div>
        <div class="focus-row focus-sites-label">Blocked sites</div>
        <div class="focus-sites" id="focusSitesList">
          ${f.sites.map(s => `<div class="focus-site-chip">${escapeHtml(s)} <span data-site="${escapeHtml(s)}" class="remove-site">✕</span></div>`).join("")}
        </div>
        <div class="focus-row">
          <input type="text" id="newSiteInput" placeholder="add-site.com">
          <button id="addSiteBtn">Add</button>
        </div>
      </div>
    `;

    panel.querySelector("#focusCloseBtn").onclick = () => panel.remove();

    panel.querySelector("#pomodoroBtn").onclick = async () => {
      if (pomodoroActive) {
        await window.api.stopPomodoro();
        pushNotification("Focus Mode", "Pomodoro stopped", "🧘");
      } else {
        await window.api.startPomodoro(25);
        pushNotification("Focus Mode", "25 minute Pomodoro started", "🧘");
      }
      renderFocusPanel(panel);
    };

    panel.querySelector("#scheduleToggle").onchange = async (e) => {
      await window.api.updateFocus({ scheduleEnabled: e.target.checked });
    };

    panel.querySelectorAll(".remove-site").forEach(el => {
      el.onclick = async () => {
        const site = el.getAttribute("data-site");
        const updated = f.sites.filter(s => s !== site);
        await window.api.updateFocus({ sites: updated });
        renderFocusPanel(panel);
      };
    });

    panel.querySelector("#addSiteBtn").onclick = async () => {
      const input = panel.querySelector("#newSiteInput");
      const val = input.value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!val) return;
      const updated = Array.from(new Set([...f.sites, val]));
      await window.api.updateFocus({ sites: updated });
      renderFocusPanel(panel);
    };
  }

  // =====================================================================
  // INCOGNITO
  // =====================================================================
  async function openIncognito() {
    await window.api.openIncognitoWindow();
  }

  // =====================================================================
  // READ ALOUD (reuses the same remote Kokoro TTS endpoint as the voice
  // orb — window.api.kokoroSpeak — so no second voice/config to maintain)
  // =====================================================================
  const READ_ALOUD_VOICE = "af_heart";
  let _readAloudState = { playing: false, cancelled: false, audio: null };

  function splitIntoChunks(text, maxLen = 320) {
    const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]*/g) || [text];
    const chunks = [];
    let current = "";
    for (const s of sentences) {
      if ((current + s).length > maxLen && current) {
        chunks.push(current.trim());
        current = "";
      }
      current += s;
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.filter(Boolean);
  }

  async function extractPageText() {
    const wv = activeWebview();
    if (!wv) return "";
    try {
      const text = await wv.executeJavaScript(`
        (function() {
          const clone = document.body.cloneNode(true);
          clone.querySelectorAll('script,style,noscript,nav,footer,svg').forEach(el => el.remove());
          return clone.innerText || "";
        })();
      `);
      return (text || "").trim();
    } catch (e) {
      console.error("[read-aloud] extraction failed:", e);
      return "";
    }
  }

  async function playChunk(text) {
    const result = await window.api.kokoroSpeak(text, { voice: READ_ALOUD_VOICE, speed: 1 });
    if (!result?.success) throw new Error(result?.error || "TTS failed");

    const binary = atob(result.audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: result.mimeType || "audio/wav" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    _readAloudState.audio = audio;

    try {
      await new Promise((resolve, reject) => {
        audio.onended = resolve;
        audio.onerror = () => reject(new Error("playback failed"));
        audio.play().catch(reject);
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function setReadAloudButtonState(state) {
    const item = document.getElementById("readAloudBtn");
    if (!item) return;
    item.textContent = state === "playing" ? "⏹ Stop reading" : "🔊 Read page aloud";
    item.classList.toggle("active", state === "playing");
  }

  async function toggleReadAloud() {
    if (_readAloudState.playing) {
      _readAloudState.cancelled = true;
      _readAloudState.audio?.pause();
      _readAloudState.playing = false;
      setReadAloudButtonState("idle");
      return;
    }

    setReadAloudButtonState("loading");
    const text = await extractPageText();
    if (!text) {
      pushNotification("Read Aloud", "Couldn't find readable text on this page", "🔊");
      setReadAloudButtonState("idle");
      return;
    }

    const chunks = splitIntoChunks(text).slice(0, 60); // sane cap for very long pages
    _readAloudState.playing = true;
    _readAloudState.cancelled = false;
    setReadAloudButtonState("playing");

    try {
      for (const chunk of chunks) {
        if (_readAloudState.cancelled) break;
        await playChunk(chunk);
      }
    } catch (e) {
      console.error("[read-aloud] error:", e);
      pushNotification("Read Aloud", "Playback stopped — " + e.message, "🔊");
    } finally {
      _readAloudState.playing = false;
      setReadAloudButtonState("idle");
    }
  }

  // =====================================================================
  // PRIVACY REPORT (No-ads-and-trackers panel, mirrors the iOS app)
  // =====================================================================
  async function togglePrivacyPanel() {
    let panel = document.getElementById("privacyPanel");
    if (panel) { panel.remove(); return; }
    panel = document.createElement("div");
    panel.id = "privacyPanel";
    panel.className = "jonah-panel";
    document.body.appendChild(panel);
    await renderPrivacyPanel(panel);
  }

  async function renderPrivacyPanel(panel) {
    const settings = await window.api.getSettings();
    const stats = await window.api.getPrivacyStats();
    panel.innerHTML = `
      <div class="panel-header">
        🛡 No Ads & Trackers
        <span id="privacyCloseBtn">✕</span>
      </div>
      <div class="panel-body">
        <div class="focus-row"><label><input type="checkbox" id="adBlockToggle" ${settings.adBlockEnabled ? "checked" : ""}> Block pop-up ads</label></div>
        <div class="focus-row"><label><input type="checkbox" id="trackerBlockToggle" ${settings.trackerBlockEnabled ? "checked" : ""}> Block known trackers</label></div>
        <div class="privacy-stat">${stats.trackersBlockedCount || 0}<br><span>trackers blocked</span></div>
      </div>
    `;
    panel.querySelector("#privacyCloseBtn").onclick = () => panel.remove();
    panel.querySelector("#adBlockToggle").onchange = (e) => window.api.setSettings({ adBlockEnabled: e.target.checked });
    panel.querySelector("#trackerBlockToggle").onchange = (e) => window.api.setSettings({ trackerBlockEnabled: e.target.checked });
  }

  function closeBrowserMenu() {
    document.getElementById("browserMenu")?.classList.add("hidden");
  }

  // =====================================================================
  // INIT
  // =====================================================================
  async function init() {
    // Incognito badge on window title if launched with ?incognito=1
    if (new URLSearchParams(location.search).get("incognito") === "1") {
      document.title = "Jonah (Incognito)";
      document.body.classList.add("incognito-window");
      const badge = document.createElement("div");
      badge.className = "incognito-badge";
      badge.textContent = "🕶 Incognito";
      document.body.appendChild(badge);
    }

    updateNotificationBadge();

    // Wire up the new entries inside the existing ⋮ menu.
    document.getElementById("focusModeBtn")?.addEventListener("click", () => { closeBrowserMenu(); toggleFocusPanel(); });
    document.getElementById("incognitoBtn")?.addEventListener("click", () => { closeBrowserMenu(); openIncognito(); });
    document.getElementById("notifBellBtn")?.addEventListener("click", () => { closeBrowserMenu(); toggleNotificationPanel(); });
    document.getElementById("readAloudBtn")?.addEventListener("click", () => { closeBrowserMenu(); toggleReadAloud(); });
    document.getElementById("privacyBtn")?.addEventListener("click", () => { closeBrowserMenu(); togglePrivacyPanel(); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose a couple of things other scripts (renderer.js, voice-orb.js)
  // might want to call into.
  window.jonahFeatures = { toggleFocusPanel, openIncognito, toggleReadAloud, togglePrivacyPanel };

})();
