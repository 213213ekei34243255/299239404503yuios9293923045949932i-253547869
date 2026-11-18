// jonah-features.js - the panels behind Jonah's menu (Electron: features.js, billing-panel.js, trust-panel.js), for Jonah on Chromium.
// They open over Noah's chat in the side panel with the same tool-panel look as the calculator and the hubs (createToolPanel).
(function () {
  "use strict";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const send = (type, extra) => chrome.runtime.sendMessage(Object.assign({ type }, extra || {}));
  const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");

  // ------------------------------------------------------------------ Focus Mode (Electron: features.js renderFocusPanel)
  async function openFocus() {
    const s = await send("jonah:settings:get");
    const f = s.focusMode;
    const active = f.pomodoroEndsAt && f.pomodoroEndsAt > Date.now();
    const left = active ? Math.ceil((f.pomodoroEndsAt - Date.now()) / 60000) : 0;
    const p = createToolPanel("focus", "Focus Mode", `
      <div class="jg-list jg-hero"><div class="jg-num">${active ? left + "m" : "25m"}</div><div class="jg-sub">${active ? "left in this focus session" : "Pomodoro focus session"}</div></div>
      <button class="jg-big-btn ${active ? "stop" : ""}" id="jfPomo">${active ? "Stop" : "Start Focus"}</button>
      <div style="height:18px"></div>
      <div class="jg-list">
        <div class="jg-item"><div>Block on a schedule<div class="jg-sub">${hhmm(f.scheduleStart)} - ${hhmm(f.scheduleEnd)}</div></div><input type="checkbox" id="jfSched" ${f.scheduleEnabled ? "checked" : ""}></div>
      </div>
      <div class="jg-title">Blocked sites</div>
      <div class="jg-list">
        <div class="jg-chips">${f.sites.map((x) => `<span class="jg-chip">${esc(x)}<span class="jg-x" data-site="${esc(x)}" title="Remove">✕</span></span>`).join("") || `<span class="jg-sub">No sites yet</span>`}</div>
        <div class="jg-add"><input id="jfNew" placeholder="Add a site, e.g. reddit.com"><button id="jfAdd">Add</button></div>
      </div>
      <div class="jg-caption">While a focus session runs (or during the schedule), these sites show a Focus Mode page instead.</div>`);
    p.querySelector("#jfPomo").onclick = async () => { await send("jonah:focus", { action: active ? "stop" : "start", minutes: 25 }); openFocus(); };
    p.querySelector("#jfSched").onchange = (e) => send("jonah:settings:set", { patch: { focusMode: { scheduleEnabled: e.target.checked } } });
    p.querySelectorAll(".jg-x").forEach((el) => { el.onclick = async () => { await send("jonah:settings:set", { patch: { focusMode: { sites: f.sites.filter((x) => x !== el.dataset.site) } } }); openFocus(); }; });
    const add = async () => {
      const v = p.querySelector("#jfNew").value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return;
      await send("jonah:settings:set", { patch: { focusMode: { sites: Array.from(new Set([...f.sites, v])) } } });
      openFocus();
    };
    p.querySelector("#jfAdd").onclick = add;
    p.querySelector("#jfNew").onkeydown = (e) => { if (e.key === "Enter") add(); };
  }

  // ------------------------------------------------------------------ No Ads & Trackers (Electron: features.js renderPrivacyPanel)
  async function openPrivacy() {
    const [s, stats] = await Promise.all([send("jonah:settings:get"), send("jonah:privacy:stats")]);
    const p = createToolPanel("privacy", "No Ads &amp; Trackers", `
      <div class="jg-list jg-hero"><div class="jg-num">${Number(stats && stats.trackersBlockedCount) || 0}</div><div class="jg-sub">trackers blocked</div></div>
      <div class="jg-list">
        <div class="jg-item">Block pop-up ads<input type="checkbox" id="jfAds" ${s.adBlockEnabled ? "checked" : ""}></div>
        <div class="jg-item">Block known trackers<input type="checkbox" id="jfTrk" ${s.trackerBlockEnabled ? "checked" : ""}></div>
      </div>
      <div class="jg-caption">The same ad and tracker lists as Jonah on Electron, blocked by the browser itself before they load.</div>`);
    p.querySelector("#jfAds").onchange = (e) => send("jonah:settings:set", { patch: { adBlockEnabled: e.target.checked } });
    p.querySelector("#jfTrk").onchange = (e) => send("jonah:settings:set", { patch: { trackerBlockEnabled: e.target.checked } });
  }

  // ------------------------------------------------------------------ Notifications (Electron: features.js notification centre)
  async function openNotifications() {
    const list = (await send("jonah:notifications")) || [];
    const items = list.map((n) => `<div class="jg-item" style="padding:12px 16px;align-items:flex-start"><div><div style="font-weight:600">${esc(n.title)}</div>${n.body ? `<div class="jg-sub">${esc(n.body)}</div>` : ""}</div><span class="jg-note-time">${new Date(n.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>`).join("");
    const p = createToolPanel("notifications", "Notifications", list.length
      ? `<div class="jg-list">${items}</div><button class="ghost" id="jfClear" style="width:100%">Clear all</button>`
      : `<div class="jg-list jg-hero"><div class="jg-num" style="font-size:44px">\u{1F514}</div><div class="jg-sub">No notifications yet</div></div>`);
    const c = p.querySelector("#jfClear"); if (c) c.onclick = async () => { await send("jonah:notifications:clear"); openNotifications(); };
  }

  // ------------------------------------------------------------------ Plans & Billing (Electron: billing-panel.js; plans from www.noahai.live/api/plans)
  async function openBilling() {
    const p = createToolPanel("billing", "Plans", `<div class="jg-caption" style="margin:0">Loading plans...</div>`, { wide: true });
    let plans = [];
    try { const r = await fetch("https://www.noahai.live/api/plans", { credentials: "omit" }); const j = await r.json(); plans = Array.isArray(j.plans) ? j.plans : []; } catch (_) { /* offline */ }
    const body = p.querySelector(".jtp-body");
    if (!plans.length) { body.innerHTML = `<div class="jg-caption" style="margin:0">Could not load the plans right now. Try again in a moment.</div>`; return; }
    const cap = (k) => k.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
    const feat = (f) => Object.entries(f || {}).filter(([, v]) => v && typeof v === "object" && v.limit).map(([k, v]) => `${esc(cap(k))}: ${esc(v.limit)}${v.type === "lifetime" ? " in total" : v.cooldown_hours ? ` every ${esc(v.cooldown_hours)} h` : ""}`);
    body.innerHTML = `
      <div class="jg-plans">${plans.map((pl) => `
        <div class="jg-plan"><div class="jg-plan-name">${esc(pl.name)}</div><div class="jg-plan-price">${esc(pl.price || "")}</div>
          <ul>${feat(pl.features).map((f) => `<li>${f}</li>`).join("")}</ul>
          ${pl.checkout && pl.checkout.stripe ? `<button class="jf-pay" data-url="${esc(pl.checkout.stripe)}">Pay with card</button>` : ""}
          ${pl.checkout && pl.checkout.razorpay ? `<button class="ghost jf-pay" data-url="${esc(pl.checkout.razorpay)}">Pay with Razorpay</button>` : ""}
        </div>`).join("")}</div>
      <div class="jg-caption" style="margin:14px 4px 0">Signing in to a Jonah account (to use a plan in this browser) comes in a later update.</div>`;
    body.querySelectorAll(".jf-pay").forEach((b) => { b.onclick = () => { const u = b.dataset.url; if (/^https:\/\/(buy\.stripe\.com|rzp\.io)\//.test(u)) chrome.tabs.create({ url: u }); }; });
  }

  // ------------------------------------------------------------------ Trust Panel (Electron: the "Trust Panel" menu switch + trust-panel.js)
  // The Trust Engine (Electron's Trust/*.cjs, in Noah's helper) checks each new site and shows the "Jonah Trust Score" card on the page
  // (js/jonah-trust.js + js/jonah-trust-card.js). Here: the on/off switch, and the current site's verdict with a check / deep-scan button.
  async function openTrust() {
    const ask = (cmd, extra) => chrome.runtime.sendMessage(Object.assign({ type: "jonah:trust-cmd", cmd }, extra || {}));
    const p = createToolPanel("trust", "Trust Score", `<div class="jg-caption" style="margin:0">Loading...</div>`);
    const body = p.querySelector(".jtp-body");
    const colorFor = (s) => (s == null ? "inherit" : s < 40 ? "#ff3b3b" : s < 60 ? "#ffd93b" : "#00c97a");
    async function draw() {
      if (!document.body.contains(p)) return;
      const st = (await Promise.race([ask("get").catch(() => null), new Promise((r) => setTimeout(() => r(null), 4000))])) || {};
      const r = st.result;
      body.innerHTML = `
        <div class="jg-list jg-hero"><div class="jg-num" id="jtScore" style="font-size:40px">\u{1F6E1}️</div><div class="jg-sub" id="jtHost"></div></div>
        <div class="jg-list">
          <div class="jg-item"><div>Check sites automatically</div><input type="checkbox" id="jtOn" ${st.enabled !== false ? "checked" : ""}></div>
        </div>
        <div class="jg-list" id="jtFindings"></div>
        <div style="display:flex;gap:8px"><button id="jtCheck" style="flex:1">Check this site</button><button class="ghost" id="jtDeep" style="flex:1">Deep scan</button></div>`;
      const hostEl = body.querySelector("#jtHost"), scoreEl = body.querySelector("#jtScore"), f = body.querySelector("#jtFindings");
      hostEl.textContent = st.host ? st.host : "Open a website to see its score";
      if (st.loading) { scoreEl.textContent = "…"; hostEl.textContent = (st.host || "") + " - checking"; }
      else if (r) {
        scoreEl.textContent = `${r.score}/100`; scoreEl.style.color = colorFor(r.score);
        const add = (label, value) => { const d = document.createElement("div"); d.className = "jg-item"; const a = document.createElement("div"); a.textContent = label; const b = document.createElement("div"); b.className = "jg-sub"; b.style.textAlign = "right"; b.textContent = value; d.append(a, b); f.appendChild(d); };
        add("Verdict", String(r.security || ""));
        if (Array.isArray(r.issues) && r.issues.length) add("Top mentions", r.issues.slice(0, 3).join(" · "));
        add("Source", String(r.source || ""));
      } else if (st.error) hostEl.textContent = (st.host || "") + " - " + st.error;
      if (!f.children.length) f.remove();
      body.querySelector("#jtOn").onchange = async (e) => { await ask("enable", { enabled: e.target.checked }); setTimeout(draw, 300); };
      body.querySelector("#jtCheck").onclick = async () => { const x = await ask("check", { force: true }); if (x && x.error) hostEl.textContent = x.error; setTimeout(draw, 300); };
      body.querySelector("#jtDeep").onclick = async () => { const x = await ask("check", { deep: true }); if (x && x.error) hostEl.textContent = x.error; setTimeout(draw, 300); };
      if (st.loading) setTimeout(draw, 1500);
    }
    draw();
  }
  // Electron Jonah's voice: the round voice orb (click, speak, Noah answers aloud) and the wake word "Noah" - both live in Noah's panel
  // (js/voice-orb.js). Speech is recognised on this computer (Moonshine, in Noah's helper); Noah's voice comes from the Kokoro voice server.
  function openOrb() {
    const orbOn = window.JonahOrb ? window.JonahOrb.isOn() : true;
    const p = createToolPanel("orb", "Voice", `
      <div class="jg-list jg-hero"><div class="jg-num" style="font-size:44px">\u{1F399}️</div><div class="jg-sub" id="jfWakeState">Talk to Noah</div></div>
      <div class="jg-list">
        <div class="jg-item"><div>Voice orb<div class="jg-sub">The round button in Noah's panel: click it and speak</div></div><input type="checkbox" id="jfOrb" ${orbOn ? "checked" : ""}></div>
        <div class="jg-item"><div>Wake word "Noah"<div class="jg-sub">Say "Noah, ..." while Noah's panel is open</div></div><input type="checkbox" id="jfWake"></div>
      </div>
      <div class="jg-caption">What you say is turned into text on this computer (nothing is recorded or sent anywhere until "Noah" is heard). Noah's spoken answers come from Jonah's voice server.</div>`);
    const wakeBox = p.querySelector("#jfWake"), state = p.querySelector("#jfWakeState");
    p.querySelector("#jfOrb").onchange = (e) => { if (window.JonahOrb) window.JonahOrb.set(e.target.checked); };
    wakeBox.onchange = () => window.postMessage({ type: "noah:wake", enabled: wakeBox.checked }, "*");
    const onState = (e) => {
      if (e.source !== window || !e.data || e.data.type !== "noah:wake-state") return;
      if (!document.body.contains(p)) { window.removeEventListener("message", onState); return; }
      const s = e.data.payload || {};
      wakeBox.checked = !!s.enabled;
      state.textContent = s.error ? s.error : s.phase === "loading" ? "Getting ready to listen..." : s.phase === "listening" || s.phase === "capturing" ? "Listening for “Noah”" : "Talk to Noah";
    };
    window.addEventListener("message", onState);
    window.postMessage({ type: "noah:wake-get" }, "*");
  }

  window.JonahFeatures = { openFocus, openPrivacy, openNotifications, openBilling, openTrust, openOrb };
})();
