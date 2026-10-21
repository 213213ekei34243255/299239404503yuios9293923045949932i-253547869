// downloads-ui.js - the Downloads page: every file with its live progress bar, speed and time left, and what you can do with it.
// The list belongs to the main process (downloads/manager.cjs); this only shows it and sends actions (window.downloads, see preload.cjs).
// Colours are theme variables, so the page follows the user's chosen colour.
(function () {
  "use strict";
  const DC = window.DownloadsCore;
  if (!DC) return;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const api = () => window.downloads;

  let list = [], seen = null, open = false, sig = "", filter = "", flashTimer = null;
  const panelEl = () => document.getElementById("jonah-tool-downloads");

  function injectStyles() {
    if (document.getElementById("dlStyles")) return;
    const st = document.createElement("style");
    st.id = "dlStyles";
    st.textContent = `
    .jonah-tool-panel.dl-panel { width: 600px; max-width: calc(100vw - 40px); max-height: 82vh; background: linear-gradient(160deg, rgba(var(--p-26-18-37),0.985), rgba(var(--p-10-8-16),0.985)); border-color: rgba(var(--p-168-139-250),0.4);
      box-shadow: 0 0 28px rgba(var(--p-139-92-246),0.28), 0 10px 36px rgba(0,0,0,0.6); }
    .jonah-tool-panel.dl-panel .jtp-header { background: rgba(var(--p-16-13-26),0.95); color: rgb(var(--p-216-201-255)); border-bottom-color: rgba(var(--p-168-139-250),0.3); }
    .jonah-tool-panel.dl-panel .jtp-body { padding: 0; }
    .dl-top { padding: 12px 16px 10px; border-bottom: 1px solid rgba(var(--p-168-139-250),0.16); position: sticky; top: 50px; z-index: 2; background: rgba(var(--p-16-13-26),0.97); }
    .dl-row { display: flex; gap: 8px; align-items: center; }
    .dl-top input { flex: 1; min-width: 0; background: rgba(0,0,0,0.4); border: 1px solid rgba(var(--p-168-139-250),0.28); color: #fff; border-radius: 9px; padding: 7px 10px; font-size: 13px; font-family: inherit; }
    .dl-top input:focus { outline: none; border-color: rgb(var(--p-168-139-250)); }
    .dl-sum { margin-top: 10px; padding: 10px 12px; border-radius: 11px; background: rgba(var(--p-139-92-246),0.16); border: 1px solid rgba(var(--p-168-139-250),0.3); }
    .dl-sum b { font-size: 14px; } .dl-sum .sub { font-size: 12px; color: rgba(var(--p-235-232-245),0.75); margin-top: 3px; }
    .dl-group { padding: 12px 16px 2px; font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase; color: rgb(var(--p-168-139-250)); font-weight: bold; }
    .dl-item { display: flex; gap: 12px; margin: 8px 12px; padding: 12px; border-radius: 13px; background: rgba(0,0,0,0.3); border: 1px solid rgba(var(--p-168-139-250),0.14); }
    .dl-item.active { border-color: rgba(var(--p-168-139-250),0.45); background: rgba(var(--p-139-92-246),0.1); }
    .dl-tile { flex: none; width: 46px; height: 54px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 12px; letter-spacing: .5px; color: #fff; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.18); }
    .dl-tile.k-archive { background: linear-gradient(160deg, #b8860b, #8a6508); } .dl-tile.k-document { background: linear-gradient(160deg, #2f6fcb, #1f4c93); } .dl-tile.k-image { background: linear-gradient(160deg, #2e9b6a, #1f6e4a); }
    .dl-tile.k-video { background: linear-gradient(160deg, #cb3b57, #912a3f); } .dl-tile.k-audio { background: linear-gradient(160deg, #1f9aa8, #156b75); } .dl-tile.k-app { background: linear-gradient(160deg, #cf6a2c, #9b4b1c); }
    .dl-tile.k-code { background: linear-gradient(160deg, #5b6b82, #3d4859); } .dl-tile.k-other { background: linear-gradient(160deg, rgba(var(--p-139-92-246),1), rgba(var(--p-109-40-217),1)); }
    .dl-main { flex: 1; min-width: 0; }
    .dl-name { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
    .dl-name .n { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .dl-chip { flex: none; font-size: 11px; padding: 2px 9px; border-radius: 999px; background: rgba(255,255,255,0.1); }
    .dl-chip.downloading { background: rgba(var(--p-139-92-246),0.4); } .dl-chip.paused, .dl-chip.interrupted { background: rgba(255,190,60,0.28); color: #ffe2a0; }
    .dl-chip.completed { background: rgba(80,220,140,0.26); color: #aaffd0; } .dl-chip.failed, .dl-chip.cancelled { background: rgba(255,80,100,0.28); color: #ffc0c8; }
    .dl-meta { font-size: 12px; color: rgba(var(--p-235-232-245),0.68); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dl-meta b { color: #fff; font-weight: 600; }
    .dl-bar { height: 8px; border-radius: 6px; margin: 9px 0 3px; background: rgba(255,255,255,0.12); overflow: hidden; position: relative; }
    .dl-bar > i { display: block; height: 100%; border-radius: 6px; background: linear-gradient(90deg, rgb(var(--p-168-139-250)), rgb(var(--p-139-92-246))); transition: width .35s ease; }
    .dl-bar.paused > i { background: linear-gradient(90deg, #f5b942, #e89a1f); }
    .dl-bar.unknown > i { width: 35% !important; position: absolute; animation: dlSlide 1.2s ease-in-out infinite; }
    @keyframes dlSlide { 0% { left: -35%; } 100% { left: 100%; } }
    .dl-pct { font-size: 12px; color: rgba(var(--p-235-232-245),0.85); display: flex; justify-content: space-between; }
    .dl-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    .dl-btn { background: rgba(255,255,255,0.09); border: 1px solid rgba(var(--p-168-139-250),0.25); color: #fff; border-radius: 8px; padding: 5px 11px; font-size: 12px; cursor: pointer; transition: .15s; font-family: inherit; }
    .dl-btn:hover { background: rgba(var(--p-139-92-246),0.4); } .dl-btn.primary { background: linear-gradient(135deg, rgba(var(--p-139-92-246),0.8), rgba(var(--p-109-40-217),0.7)); border-color: transparent; } .dl-btn.danger:hover { background: rgba(255,80,100,0.4); }
    .dl-note { font-size: 12px; margin-top: 5px; color: #ffc0c8; } .dl-note.soft { color: rgba(var(--p-235-232-245),0.6); }
    .dl-empty { padding: 36px 24px 40px; text-align: center; color: rgba(var(--p-235-232-245),0.7); font-size: 13px; line-height: 1.6; }
    .dl-empty b { display: block; font-size: 16px; color: #fff; margin-bottom: 6px; }
    #dlChip { position: fixed; left: 18px; bottom: 64px; z-index: 999999; min-width: 230px; background: rgba(var(--p-16-13-26),0.95); color: #fff; border: 1px solid rgba(var(--p-168-139-250),0.6); border-radius: 14px; padding: 9px 14px 10px; font: 13px Arial,sans-serif; cursor: pointer; box-shadow: 0 0 14px rgba(var(--p-139-92-246),0.4); }
    #dlChip .t { font-weight: bold; } #dlChip .s { font-size: 11px; opacity: .8; margin-top: 2px; } #dlChip .dl-bar { margin: 7px 0 0; height: 5px; }
    `;
    document.head.appendChild(st);
  }

  // ------------------------------------------------------------------ pieces
  const visible = () => { const q = filter.trim().toLowerCase(); return q ? list.filter((d) => (d.name + " " + (d.host || "")).toLowerCase().includes(q)) : list; };
  const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };

  function bar(d) {
    const p = DC.pct(d.received, d.total);
    return `<div class="dl-bar ${d.status === "paused" ? "paused " : ""}${p === null ? "unknown" : ""}" data-bar="${esc(d.id)}"><i style="width:${p === null ? 35 : p}%"></i></div>`;
  }
  /** The line under the name. For a running file it carries the numbers that change every moment (patched in place, see patch()). */
  function detail(d) {
    if (d.status === "downloading" || d.status === "paused" || d.status === "interrupted") {
      const size = d.total > 0 ? `<b>${DC.fmtBytes(d.received)}</b> of ${DC.fmtBytes(d.total)}` : `<b>${DC.fmtBytes(d.received)}</b> downloaded`;
      const speed = d.status === "downloading" ? DC.fmtSpeed(d.speedBps) : "";
      const eta = d.status === "downloading" && d.etaSec !== null && d.etaSec !== undefined ? DC.fmtEta(d.etaSec) + " left" : "";
      return [size, speed, eta].filter(Boolean).join(" · ");
    }
    return [d.total > 0 ? DC.fmtBytes(d.total) : DC.fmtBytes(d.received), d.host ? "from " + d.host : "", d.endedAt ? (d.status === "completed" ? "finished " : "") + when(d.endedAt) : ""].filter(Boolean).map((x) => esc(x)).join(" · ");
  }
  function actions(d) {
    const b = (act, label, cls = "") => `<button class="dl-btn ${cls}" data-act="${act}" data-id="${esc(d.id)}">${label}</button>`;
    if (d.status === "downloading") return b("pause", "Pause") + b("cancel", "Cancel", "danger");
    if (d.status === "paused") return b("resume", "Resume", "primary") + b("cancel", "Cancel", "danger");
    if (d.status === "interrupted") return (d.canResume ? b("resume", "Resume", "primary") : "") + b("retry", "Retry", d.canResume ? "" : "primary") + b("remove", "Remove");
    if (d.status === "completed") return d.exists === false ? b("retry", "Download again", "primary") + b("remove", "Remove") : b("open", "Open", "primary") + b("show", "Show in folder") + b("remove", "Remove");
    return b("retry", "Try again", "primary") + b("remove", "Remove");
  }
  function note(d) {
    if (d.status === "completed" && d.exists === false) return `<div class="dl-note">This file was moved or deleted.</div>`;
    if (d.note && d.status !== "completed") return `<div class="dl-note${d.status === "paused" ? " soft" : ""}">${esc(d.note)}</div>`;
    return "";
  }
  function card(d) {
    const t = DC.typeInfo(d.name), live = d.status === "downloading" || d.status === "paused";
    const p = DC.pct(d.received, d.total);
    return `<div class="dl-item${live ? " active" : ""}" data-card="${esc(d.id)}">
      <div class="dl-tile k-${t.kind}">${esc(t.label)}</div>
      <div class="dl-main">
        <div class="dl-name"><span class="n" title="${esc(d.name)}">${esc(d.name)}</span><span class="dl-chip ${d.status}">${esc(DC.statusText(d))}</span></div>
        <div class="dl-meta" data-detail="${esc(d.id)}" title="${esc(d.url)}">${detail(d)}</div>
        ${live ? bar(d) + `<div class="dl-pct"><span data-pct="${esc(d.id)}">${p === null ? "Size unknown" : p + "%"}</span><span></span></div>` : ""}
        ${note(d)}
        <div class="dl-actions">${actions(d)}</div>
      </div></div>`;
  }
  function summaryBox() {
    const s = DC.summary(list);
    if (!s.running && !s.paused) return "";
    const line = s.running ? [s.running + (s.running === 1 ? " file" : " files") + " downloading", DC.fmtSpeed(s.speedBps), s.etaSec !== null ? DC.fmtEta(s.etaSec) + " left" : ""].filter(Boolean).join(" · ") : "";
    return `<div class="dl-sum" id="dlSum"><b>${esc(line || (s.paused + " paused"))}</b>${s.pct !== null ? `<div class="dl-bar" style="margin:8px 0 0"><i style="width:${s.pct}%"></i></div>` : ""}${s.running && s.paused ? `<div class="sub">${s.paused} paused</div>` : ""}</div>`;
  }

  function render() {
    const p = panelEl(); if (!p) { open = false; return; }
    const finished = list.some((d) => !DC.isActive(d) && d.status !== "interrupted");
    const rows = visible();
    const groups = DC.groupByDay(rows, new Date());
    const body = !list.length
      ? `<div class="dl-empty"><b>No downloads yet</b>Files you download show up here with their progress, so you can pause, open or find them.</div>`
      : !rows.length ? `<div class="dl-empty"><b>Nothing matches</b>No download has "${esc(filter)}" in its name.</div>`
      : groups.map((g) => `<div class="dl-group">${esc(g.label)}</div>${g.items.map(card).join("")}`).join("") + `<div style="height:10px"></div>`;
    p.querySelector(".jtp-body").innerHTML = `<div class="dl-top"><div class="dl-row"><input id="dlSearch" placeholder="Search downloads" value="${esc(filter)}" autocomplete="off"><button class="dl-btn" data-act="clear" ${finished ? "" : "disabled"}>Clear finished</button></div><div id="dlSumWrap">${summaryBox()}</div></div>${body}`;
    sig = signature();
  }
  const signature = () => visible().map((d) => d.id + d.status + d.exists + d.canResume + (d.note || "")).join("|") + "#" + filter;

  /** Between two full renders only the moving numbers change: patch them in place so the buttons do not flicker under the mouse. */
  function patch() {
    const p = panelEl(); if (!p) return;
    for (const d of list) {
      if (d.status !== "downloading" && d.status !== "paused") continue;
      const bi = p.querySelector(`[data-bar="${CSS.escape(d.id)}"] i`), pc = DC.pct(d.received, d.total);
      if (bi && pc !== null) bi.style.width = pc + "%";
      const det = p.querySelector(`[data-detail="${CSS.escape(d.id)}"]`); if (det) det.innerHTML = detail(d);
      const pe = p.querySelector(`[data-pct="${CSS.escape(d.id)}"]`); if (pe) pe.textContent = pc === null ? "Size unknown" : pc + "%";
    }
    const w = p.querySelector("#dlSumWrap"); if (w) w.innerHTML = summaryBox();
  }

  // ------------------------------------------------------------------ the floating chip while the panel is closed
  function chip() {
    let c = document.getElementById("dlChip");
    const s = DC.summary(list);
    if (panelEl() || (!s.running && !s.paused && !c)) { if (c && panelEl()) c.remove(); return; }
    if (!s.running && !s.paused) return; // a "finished" message is shown by flash() and removes itself
    if (!c) { c = document.createElement("div"); c.id = "dlChip"; c.title = "Open Downloads"; c.onclick = () => openDownloads(); document.body.appendChild(c); }
    const first = list.find((d) => d.status === "downloading" || d.status === "paused");
    c.innerHTML = `<div class="t">${s.running ? (s.running === 1 && first ? esc(first.name.length > 28 ? first.name.slice(0, 27) + "…" : first.name) : s.running + " downloads") : "Paused"}</div><div class="s">${esc([s.pct !== null ? s.pct + "%" : "", DC.fmtSpeed(s.speedBps), s.etaSec !== null ? DC.fmtEta(s.etaSec) + " left" : ""].filter(Boolean).join(" · ") || "Starting...")}</div>${s.pct !== null ? `<div class="dl-bar"><i style="width:${s.pct}%"></i></div>` : ""}`;
  }
  function flash(text) {
    clearTimeout(flashTimer);
    let c = document.getElementById("dlChip");
    if (panelEl()) return;
    if (!c) { c = document.createElement("div"); c.id = "dlChip"; c.onclick = () => openDownloads(); document.body.appendChild(c); }
    c.innerHTML = `<div class="t">${esc(text)}</div><div class="s">Click to see it</div>`;
    flashTimer = setTimeout(() => { const x = document.getElementById("dlChip"); if (x && !DC.summary(list).running) x.remove(); }, 4500);
  }

  // ------------------------------------------------------------------ events
  function onList(next) {
    const prev = new Map(list.map((d) => [d.id, d]));
    list = Array.isArray(next) ? next : [];
    if (seen === null) seen = new Set(list.map((d) => d.id)); // what was already there at startup does not pop the page open
    const fresh = list.filter((d) => !seen.has(d.id) && d.status === "downloading");
    list.forEach((d) => seen.add(d.id));
    for (const d of list) { const was = prev.get(d.id); if (was && was.status !== "completed" && d.status === "completed") { try { new Notification("Download finished", { body: d.name }); } catch (_) { /* notifications unavailable */ } flash("Finished: " + (d.name.length > 30 ? d.name.slice(0, 29) + "…" : d.name)); } }
    if (fresh.length && !panelEl()) { openDownloads(); return; }
    if (panelEl()) { if (signature() !== sig) render(); else patch(); }
    chip();
  }

  async function onClick(e) {
    const t = e.target.closest("[data-act]"); if (!t || t.disabled) return;
    const act = t.dataset.act, id = t.dataset.id;
    if (act === "clear") { await api().act("x", "clear"); return; }
    let opts;
    if (act === "open") {
      const d = list.find((x) => x.id === id);
      if (d && DC.isRisky(d.name)) { if (!confirm(`"${d.name}" is a kind of file that can run programs on your computer.\n\nOnly open it if you trust where it came from. Open it anyway?`)) return; opts = { confirmed: true }; }
    }
    const r = await api().act(id, act, opts);
    if (r && !r.ok && r.error) alert(r.error);
  }

  async function openDownloads() {
    injectStyles();
    if (!api()) { alert("Downloads are only available in the Jonah app."); return; }
    const p = createToolPanel("downloads", "Downloads", `<div></div>`, { wide: true });
    p.classList.add("dl-panel"); open = true;
    const c = document.getElementById("dlChip"); if (c) c.remove();
    p.addEventListener("click", onClick);
    p.addEventListener("input", (e) => { if (e.target.id === "dlSearch") { filter = e.target.value; render(); const i = document.getElementById("dlSearch"); if (i) { i.focus(); i.setSelectionRange(filter.length, filter.length); } } });
    const close = p.querySelector(".jtp-close"); if (close) close.addEventListener("click", () => { open = false; filter = ""; setTimeout(chip, 0); });
    try { list = await api().list(); } catch (_) { /* keep what we have */ }
    seen = new Set([...(seen || []), ...list.map((d) => d.id)]);
    render();
  }
  window.openDownloads = openDownloads;
  window.DownloadsUI = { list: () => list, render, onList, chip };

  if (api()) {
    api().list().then((l) => { list = l; seen = new Set(l.map((d) => d.id)); chip(); }).catch(() => { seen = new Set(); });
    api().onChanged(onList);
  }
})();
