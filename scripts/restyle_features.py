"""One-off: rewrites the panels in jonah-ext-src/jonah-features.js in the iPhone Settings style (grouped rounded lists,
switches, big rounded buttons). Run once: python -I restyle_features.py"""
from pathlib import Path

p = Path(__file__).parent / "jonah-ext-src" / "jonah-features.js"
s = p.read_text(encoding="utf-8")


def replace_between(s, a, b, new):
    i = s.index(a)
    j = s.index(b, i)
    return s[:i] + new + s[j:]


FOCUS = r'''  async function openFocus() {
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

'''

PRIVACY = r'''  async function openPrivacy() {
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

'''

NOTES = r'''  async function openNotifications() {
    const list = (await send("jonah:notifications")) || [];
    const items = list.map((n) => `<div class="jg-item" style="padding:12px 16px;align-items:flex-start"><div><div style="font-weight:600">${esc(n.title)}</div>${n.body ? `<div class="jg-sub">${esc(n.body)}</div>` : ""}</div><span class="jg-note-time">${new Date(n.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>`).join("");
    const p = createToolPanel("notifications", "Notifications", list.length
      ? `<div class="jg-list">${items}</div><button class="ghost" id="jfClear" style="width:100%">Clear all</button>`
      : `<div class="jg-list jg-hero"><div class="jg-num" style="font-size:44px">\u{1F514}</div><div class="jg-sub">No notifications yet</div></div>`);
    const c = p.querySelector("#jfClear"); if (c) c.onclick = async () => { await send("jonah:notifications:clear"); openNotifications(); };
  }

'''

BILLING = r'''  async function openBilling() {
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

'''

LATER = r'''  function openTrust() {
    createToolPanel("trust", "Trust Score", `
      <div class="jg-list jg-hero"><div class="jg-num" style="font-size:44px">\u{1F6E1}️</div><div class="jg-sub">Coming soon</div></div>
      <div class="jg-caption">The Trust Panel checks how trustworthy a website is from reviews, scam reports and web search. Its search runs through Jonah's server with a private key that is not built into this browser, so it comes together with signing in to a Jonah account.</div>`);
  }
  function openOrb() {
    createToolPanel("orb", "Voice Orb", `
      <div class="jg-list jg-hero"><div class="jg-num" style="font-size:44px">\u{1F399}️</div><div class="jg-sub">Off - coming soon</div></div>
      <div class="jg-caption">Talking to Noah (and the wake word "Noah") comes in a later update together with Noah's voice. Typing to Noah in the chat works now.</div>`);
  }

'''

s = replace_between(s, "  async function openFocus() {", "  // ------------------------------------------------------------------ No Ads & Trackers", FOCUS)
s = replace_between(s, "  async function openPrivacy() {", "  // ------------------------------------------------------------------ Notifications", PRIVACY)
s = replace_between(s, "  async function openNotifications() {", "  // ------------------------------------------------------------------ Plans & Billing", NOTES)
s = replace_between(s, "  async function openBilling() {", "  // ------------------------------------------------------------------ not moved over yet", BILLING)
s = replace_between(s, "  function openTrust() {", "  window.JonahFeatures =", LATER)
p.write_text(s, encoding="utf-8", newline="\n")
print("ok")
