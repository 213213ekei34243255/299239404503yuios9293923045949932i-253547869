// jonah-history.js - Jonah's own History panel (side panel, iPhone-style glass look): search, pages grouped by day with their
// site icons, open a page, remove one page, and clear history for the last hour / today / all time. Built on Chromium's real
// history (chrome.history); nothing is sent anywhere.
(function () {
  "use strict";
  const STYLE = `
    .jh-search { padding: 4px 0 6px; }
    .jh-search input { width: 100%; box-sizing: border-box; padding-left: 36px !important;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2.4' stroke-linecap='round'><circle cx='11' cy='11' r='7'/><path d='m20 20-3.5-3.5'/></svg>") !important;
      background-repeat: no-repeat !important; background-position: 12px center !important; }
    .jh-day { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .02em; color: rgba(235,235,245,.6); margin: 16px 6px 8px; }
    .jh-list { background: rgba(255,255,255,.055); border: .5px solid rgba(255,255,255,.09); border-radius: 22px; overflow: hidden; }
    .jh-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; cursor: pointer; transition: background .15s; }
    .jh-row + .jh-row { border-top: .5px solid rgba(255,255,255,.08); }
    .jh-row:hover { background: rgba(255,255,255,.06); }
    .jh-ico { width: 32px; height: 32px; border-radius: 9px; flex: none; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.08); }
    .jh-ico img { width: 18px; height: 18px; }
    .jh-txt { flex: 1; min-width: 0; }
    .jh-title { font-size: 15px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .jh-host { font-size: 12.5px; color: rgba(235,235,245,.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .jh-time { font-size: 12px; color: rgba(235,235,245,.4); flex: none; }
    .jh-del { width: 26px; height: 26px; border-radius: 50%; flex: none; display: none; align-items: center; justify-content: center; font-size: 11px;
      background: rgba(118,118,128,.3); color: #fff; }
    .jh-row:hover .jh-del { display: flex; }
    .jh-row:hover .jh-time { display: none; }
    .jh-del:hover { background: #ff453a; }
    .jh-empty { text-align: center; padding: 48px 16px; color: rgba(235,235,245,.55); }
    .jh-empty b { display: block; font-size: 20px; color: #f5f5f7; margin-bottom: 6px; }
    .jh-more { text-align: center; padding: 14px; color: rgba(235,235,245,.4); font-size: 13px; }
    .jh-clear { display: flex; gap: 8px; flex-wrap: wrap; margin: 18px 0 6px; }
    html body .jonah-tool-panel .jh-clear button { flex: 1 1 0; min-width: 0; white-space: nowrap; padding: 9px 6px !important; font-size: 13px !important; background: rgba(255,69,58,.16) !important; color: #ff6961 !important; box-shadow: none !important; }
  `;
  const PAGE = 120;
  let panel = null, query = "", oldest = Date.now(), items = [], loading = false, finished = false;

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return u; } };
  const favicon = (u) => chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(u)}&size=32`);
  function dayLabel(t) {
    const d = new Date(t), today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((today - day) / 86400000);
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  }

  async function load(reset) {
    if (loading || (finished && !reset)) return;
    loading = true;
    if (reset) { items = []; oldest = Date.now(); finished = false; }
    const found = await chrome.history.search({ text: query, startTime: 0, endTime: oldest, maxResults: PAGE });
    const fresh = found.filter((h) => /^https?:/i.test(h.url) && !items.some((x) => x.id === h.id));
    items = items.concat(fresh);
    if (found.length < PAGE) finished = true;
    if (found.length) oldest = Math.min(...found.map((h) => h.lastVisitTime)) - 1;
    loading = false;
    render();
  }

  function render() {
    const box = panel && panel.querySelector(".jh-body"); if (!box) return;
    if (!items.length) {
      box.innerHTML = `<div class="jh-empty"><b>${query ? "No matches" : "No history yet"}</b>${query ? "Try other words." : "Pages you visit show up here."}</div>`;
      return;
    }
    let html = "", last = "";
    for (const h of items) {
      const label = dayLabel(h.lastVisitTime);
      if (label !== last) { html += (last ? "</div>" : "") + `<div class="jh-day">${esc(label)}</div><div class="jh-list">`; last = label; }
      html += `<div class="jh-row" data-url="${esc(h.url)}">
        <div class="jh-ico"><img src="${favicon(h.url)}" alt=""></div>
        <div class="jh-txt"><div class="jh-title">${esc(h.title || host(h.url))}</div><div class="jh-host">${esc(host(h.url))}</div></div>
        <div class="jh-time">${new Date(h.lastVisitTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
        <div class="jh-del" data-del="${esc(h.url)}" title="Remove from history">✕</div></div>`;
    }
    html += "</div>" + (finished ? "" : `<div class="jh-more">Scroll for more</div>`);
    box.innerHTML = html;
  }

  async function clearRange(kind) {
    const label = { hour: "the last hour", today: "today", all: "all time" }[kind];
    if (!window.confirm(`Clear your browsing history for ${label}? This cannot be undone.`)) return;
    if (kind === "all") await chrome.history.deleteAll();
    else {
      const start = kind === "hour" ? Date.now() - 3600000 : new Date().setHours(0, 0, 0, 0);
      await chrome.history.deleteRange({ startTime: start, endTime: Date.now() });
    }
    load(true);
  }

  function openHistory() {
    if (!document.getElementById("jonah-history-style")) { const s = document.createElement("style"); s.id = "jonah-history-style"; s.textContent = STYLE; document.head.appendChild(s); }
    panel = createToolPanel("history", "History", `
      <div class="jh-search"><input id="jhSearch" placeholder="Search history" autocomplete="off"></div>
      <div class="jh-body"></div>
      <div class="jh-clear"><button data-clear="hour">Clear last hour</button><button data-clear="today">Clear today</button><button data-clear="all">Clear all</button></div>`);
    query = "";
    let timer = null;
    panel.querySelector("#jhSearch").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => { query = e.target.value.trim(); load(true); }, 200); });
    panel.addEventListener("click", async (e) => {
      const del = e.target.closest("[data-del]");
      if (del) { e.stopPropagation(); await chrome.history.deleteUrl({ url: del.dataset.del }); items = items.filter((x) => x.url !== del.dataset.del); render(); return; }
      const clr = e.target.closest("[data-clear]");
      if (clr) { clearRange(clr.dataset.clear); return; }
      const row = e.target.closest(".jh-row");
      if (row) {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab) chrome.tabs.update(tab.id, { url: row.dataset.url }); else chrome.tabs.create({ url: row.dataset.url });
      }
    });
    panel.addEventListener("scroll", () => { if (panel.scrollTop + panel.clientHeight > panel.scrollHeight - 300) load(false); });
    load(true);
  }
  window.openJonahHistory = openHistory;
})();
