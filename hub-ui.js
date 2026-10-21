// hub-ui.js - Game Hub, Creator Studio and Aesthetic Lab: the three panels opened from the dock on the home page (or the book menu).
// Logic is in hub-core.js (unit-tested); outside data comes through window.hubs (main process: feeds, PC readings, moodboard images). Saved data: localStorage
// "jonahHubs" for small things, IndexedDB "jonahHubImages" for moodboard pictures. Colours are theme variables (--p-R-G-B), so the panels follow the user's colour.
(function () {
  "use strict";
  const HC = window.HubCore;
  if (!HC) return;
  const { esc } = HC;
  const KEY = "jonahHubs";

  // ------------------------------------------------------------------ saved data
  const defaults = () => ({
    game: { watch: [], days: {}, budgetMin: 180, breakEvery: 60, give: { platform: "pc", type: "game", sort: "popularity" }, deals: { upper: 15, sort: "Savings" } },
    creator: { items: [], ideas: [], income: [], lists: [], accounts: [], cfg: { restDays: [0], capacity: 25 } },
    aesthetic: { boards: [{ id: "b1", name: "My board", images: [] }] },
  });
  const merge = (d, s) => { for (const k of Object.keys(d)) if (s && typeof s[k] === typeof d[k] && d[k] && typeof d[k] === "object" && !Array.isArray(d[k])) merge(d[k], s[k]); else if (s && s[k] !== undefined && typeof s[k] === typeof d[k]) d[k] = s[k]; return d; };
  let S = load();
  function load() { try { return merge(defaults(), JSON.parse(localStorage.getItem(KEY) || "null") || {}); } catch (_) { return defaults(); } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (_) { /* storage unavailable: it just won't persist */ } }
  const uid = () => Math.random().toString(36).slice(2, 10);

  // moodboard pictures (blobs) live in IndexedDB: localStorage is far too small for them
  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open("jonahHubImages", 1); r.onupgradeneeded = () => r.result.createObjectStore("images", { keyPath: "id" }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
    const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction("images", mode); const out = fn(t.objectStore("images")); t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error); }); };
    return { put: (rec) => tx("readwrite", (s) => s.put(rec)), get: (id) => tx("readonly", (s) => s.get(id)), del: (id) => tx("readwrite", (s) => s.delete(id)) };
  })();

  // ------------------------------------------------------------------ styles
  function injectStyles() {
    if (document.getElementById("hubStyles")) return;
    const st = document.createElement("style");
    st.id = "hubStyles";
    st.textContent = `
    .jonah-tool-panel.hub-panel { width: 720px; max-width: calc(100vw - 40px); background: linear-gradient(160deg, rgba(var(--p-26-18-37),0.985), rgba(var(--p-10-8-16),0.985)); border-color: rgba(var(--p-168-139-250),0.4);
      box-shadow: 0 0 28px rgba(var(--p-139-92-246),0.28), 0 10px 36px rgba(0,0,0,0.6); }
    .jonah-tool-panel.hub-panel .jtp-header { background: rgba(var(--p-16-13-26),0.95); color: rgb(var(--p-216-201-255)); border-bottom-color: rgba(var(--p-168-139-250),0.3); }
    .jonah-tool-panel.hub-panel .jtp-close:hover { color: rgb(var(--p-168-139-250)); }
    .jonah-tool-panel.hub-panel input, .jonah-tool-panel.hub-panel select, .jonah-tool-panel.hub-panel textarea { background: rgba(0,0,0,0.38); border: 1px solid rgba(var(--p-168-139-250),0.28); color: #fff; border-radius: 8px; padding: 7px 9px; font-size: 13px; font-family: inherit; }
    .jonah-tool-panel.hub-panel input:focus, .jonah-tool-panel.hub-panel select:focus, .jonah-tool-panel.hub-panel textarea:focus { outline: none; border-color: rgb(var(--p-168-139-250)); }
    .jonah-tool-panel.hub-panel button.hb-btn { background: linear-gradient(135deg, rgba(var(--p-139-92-246),0.75), rgba(var(--p-109-40-217),0.65)); border: none; color: #fff; border-radius: 8px; padding: 7px 12px; cursor: pointer; font-size: 12px; transition: .2s; }
    .jonah-tool-panel.hub-panel button.hb-btn:hover { box-shadow: 0 0 12px rgba(var(--p-139-92-246),0.7); transform: translateY(-1px); }
    .jonah-tool-panel.hub-panel button.hb-btn.ghost { background: rgba(255,255,255,0.09); }
    .jonah-tool-panel.hub-panel button.hb-btn.big { padding: 9px 16px; font-size: 14px; font-weight: bold; }
    .jonah-tool-panel.hub-panel button.hb-btn:disabled { opacity: .45; cursor: default; transform: none; box-shadow: none; }
    .hb-tabs { display: flex; gap: 4px; padding: 10px 14px 0; flex-wrap: wrap; border-bottom: 1px solid rgba(var(--p-168-139-250),0.2); }
    .hb-tab { padding: 7px 12px; border-radius: 9px 9px 0 0; background: rgba(255,255,255,0.05); color: rgb(var(--p-235-232-245)); font-size: 12px; cursor: pointer; border: none; transition: .15s; }
    .hb-tab:hover { background: rgba(255,255,255,0.12); }
    .hb-tab.active { background: linear-gradient(180deg, rgba(var(--p-139-92-246),0.55), rgba(var(--p-139-92-246),0.15)); color: #fff; font-weight: bold; box-shadow: inset 0 2px 0 rgb(var(--p-168-139-250)); }
    .hb-card { background: rgba(0,0,0,0.3); border: 1px solid rgba(var(--p-168-139-250),0.14); border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
    .hb-card h4 { margin: 0 0 8px; font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase; color: rgb(var(--p-168-139-250)); font-weight: bold; }
    .hb-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .hb-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; } .hb-grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    @media (max-width: 700px) { .hb-grid2, .hb-grid3 { grid-template-columns: 1fr; } }
    .hb-muted { color: rgba(var(--p-235-232-245),0.62); font-size: 12px; } .hb-empty { color: rgba(var(--p-235-232-245),0.6); font-size: 12px; padding: 6px 0; }
    .hb-pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; background: rgba(255,255,255,0.1); color: #fff; white-space: nowrap; }
    .hb-pill.ok { background: rgba(80,220,140,0.26); color: #aaffd0; } .hb-pill.warn, .hb-pill.warm { background: rgba(255,190,60,0.28); color: #ffe2a0; } .hb-pill.bad { background: rgba(255,80,100,0.3); color: #ffc0c8; } .hb-pill.free { background: linear-gradient(90deg, #22c55e, #16a34a); font-weight: bold; }
    .hb-item { display: flex; gap: 10px; align-items: center; padding: 8px; border-radius: 10px; background: rgba(255,255,255,0.05); margin-bottom: 6px; }
    .hb-item img.thumb { width: 92px; height: 52px; object-fit: cover; border-radius: 7px; flex: none; background: rgba(0,0,0,0.4); }
    .hb-item .grow { flex: 1; min-width: 0; } .hb-item .t { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hb-item .meta { font-size: 11px; color: rgba(var(--p-235-232-245),0.62); margin-top: 2px; }
    .hb-was { text-decoration: line-through; opacity: .55; margin-right: 4px; }
    .hb-bar { height: 8px; border-radius: 6px; background: rgba(255,255,255,0.12); overflow: hidden; } .hb-bar > i { display: block; height: 100%; border-radius: 6px; background: linear-gradient(90deg, rgb(var(--p-168-139-250)), rgb(var(--p-139-92-246))); transition: width .4s; }
    .hb-bar.warn > i { background: linear-gradient(90deg,#f59e0b,#f97316); } .hb-bar.bad > i { background: linear-gradient(90deg,#f97316,#ef4444); }
    .hb-big { font-size: 28px; font-weight: 700; line-height: 1.1; } .hb-x { cursor: pointer; opacity: .55; padding: 0 5px; } .hb-x:hover { opacity: 1; }
    .hb-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: rgba(var(--p-235-232-245),0.75); }
    .hb-find { padding: 7px 10px; border-radius: 9px; font-size: 13px; margin-bottom: 6px; background: rgba(255,255,255,0.06); border-left: 4px solid #22c55e; }
    .hb-find.warn { border-left-color: #f59e0b; background: rgba(245,158,11,0.12); } .hb-find.bad { border-left-color: #ef4444; background: rgba(239,68,68,0.14); }
    .hb-week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 5px; } .hb-day { background: rgba(255,255,255,0.05); border-radius: 9px; padding: 6px; min-height: 96px; font-size: 11px; min-width: 0; overflow: hidden; } .hb-day.rest { background: rgba(var(--p-139-92-246),0.12); } .hb-day.today { outline: 1px solid rgb(var(--p-168-139-250)); }
    .hb-day .dn { font-weight: 700; margin-bottom: 4px; color: rgb(var(--p-216-201-255)); } .hb-chip { display: block; padding: 3px 5px; border-radius: 6px; margin-bottom: 3px; background: rgba(var(--p-139-92-246),0.3); cursor: pointer; overflow: hidden; word-break: break-word; max-height: 5em; font-size: 11px; line-height: 1.25; } .hb-chip small { opacity: .7; font-size: 10px; }
    .hb-chip.posted { opacity: .5; text-decoration: line-through; }
    .hb-sw { display: inline-flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; font-size: 11px; width: 92px; text-align: center; }
    .hb-sw i { display: block; width: 76px; height: 76px; border-radius: 14px; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.25), 0 4px 12px rgba(0,0,0,0.4); transition: .15s; } .hb-sw:hover i { transform: scale(1.06); }
    .hb-imgs { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 8px; } .hb-imgs .im { position: relative; aspect-ratio: 1; border-radius: 10px; overflow: hidden; background: rgba(0,0,0,0.4); cursor: pointer; } .hb-imgs img { width: 100%; height: 100%; object-fit: cover; display: block; } .hb-imgs .im .hb-x { position: absolute; top: 3px; right: 3px; background: rgba(0,0,0,0.6); border-radius: 50%; width: 20px; height: 20px; text-align: center; line-height: 20px; padding: 0; opacity: .9; }
    .hb-spin { display: inline-block; width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.25); border-top-color: rgb(var(--p-168-139-250)); animation: hbSpin .8s linear infinite; vertical-align: -2px; } @keyframes hbSpin { to { transform: rotate(360deg); } }
    .hb-spark { width: 100%; height: 34px; } .hb-link { color: rgb(var(--p-168-139-250)); cursor: pointer; text-decoration: underline; }
    #hubSessionChip { position: fixed; left: 18px; bottom: 18px; z-index: 999999; background: rgba(var(--p-16-13-26),0.94); color: #fff; border: 1px solid rgba(var(--p-168-139-250),0.6); border-radius: 999px; padding: 8px 14px; font: bold 13px Arial,sans-serif; cursor: pointer; box-shadow: 0 0 14px rgba(var(--p-139-92-246),0.4); }
    `;
    document.head.appendChild(st);
  }

  // ------------------------------------------------------------------ helpers
  const openLink = (url) => { try { if (/^https:\/\//.test(String(url))) createNewTab(String(url)); } catch (_) { /* no tab available */ } };
  const activeView = () => { try { const t = tabData[activeTabIndex]; return t && t.webview; } catch (_) { return null; } };
  const todayKey = () => HC.dateKey(new Date());
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); return true; } catch (_) { return false; } };
  function notify(msg) { try { new Notification("Jonah", { body: msg }); } catch (_) { /* notifications unavailable */ } }
  function beep() { try { const ac = new (window.AudioContext || window.webkitAudioContext)(); const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 660; g.gain.value = 0.06; o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.25); } catch (_) { /* no audio */ } }
  const hubs = () => window.hubs;
  async function feed(name, params) {
    if (!hubs()) return { ok: false, error: "This part needs the Jonah app (it is not available in this window)." };
    try { return await hubs().feed(name, params); } catch (err) { return { ok: false, error: String(err && err.message || err).slice(0, 100) }; }
  }
  const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? "just now" : s < 5400 ? Math.round(s / 60) + " min ago" : Math.round(s / 3600) + " h ago"; };

  // ------------------------------------------------------------------ the panel shell shared by the three hubs
  const HUBS = {
    game: { title: "Game Hub", tabs: [["free", "Free games"], ["deals", "Deals"], ["session", "Play session"], ["vitals", "PC vitals"]], view: () => gameView },
    creator: { title: "Creator Studio", tabs: [["plan", "Plan"], ["ideas", "Ideas"], ["income", "Deals & income"], ["lists", "Checklists"], ["captions", "Captions"], ["accounts", "Accounts"]], view: () => creatorView },
    aesthetic: { title: "Aesthetic Lab", tabs: [["looks", "Looks"], ["boards", "Moodboards"], ["palette", "Palette"], ["reference", "Reference"]], view: () => aestheticView },
  };
  const ui = { hub: null, tab: { game: "free", creator: "plan", aesthetic: "looks" }, open: false, week: 0, pickIdx: null, palette: null, pageImgs: null, ai: { busy: false, text: "", err: "" }, flash: "" };
  const cache = { giveaways: null, epic: null, deals: null, search: null, vitals: null, watchNow: null };
  const panelEl = () => document.getElementById("jonah-tool-hub");
  const rerender = () => { const p = panelEl(); if (!p || !ui.hub) return; stopVitals(); p.querySelector("#hbTabs").innerHTML = tabsHtml(); p.querySelector("#hbBody").innerHTML = `<div style="padding:12px 14px">${HUBS[ui.hub].view()()}</div>`; afterRender(); };
  const tabsHtml = () => `<div class="hb-tabs">${HUBS[ui.hub].tabs.map(([id, l]) => `<button class="hb-tab${ui.tab[ui.hub] === id ? " active" : ""}" data-act="tab" data-v="${id}">${l}</button>`).join("")}</div>`;

  function openHub(name, tab) {
    if (!HUBS[name]) return;
    injectStyles();
    ui.hub = name; if (tab) ui.tab[name] = tab; ui.open = true;
    const p = createToolPanel("hub", HUBS[name].title, `<div id="hbTabs"></div><div id="hbBody"></div>`, { wide: true });
    p.classList.add("hub-panel");
    p.querySelector(".jtp-body").style.padding = "0";
    const close = p.querySelector(".jtp-close"); if (close) close.addEventListener("click", () => { ui.open = false; stopVitals(); sessionPaint(); });
    p.addEventListener("click", onClick); p.addEventListener("change", onChange); p.addEventListener("input", onInput);
    p.addEventListener("paste", onPaste);
    rerender();
  }
  window.openHub = openHub;

  // ================================================================== GAME HUB
  const PLATFORMS = [["pc", "PC (all)"], ["steam", "Steam"], ["epic-games-store", "Epic"], ["gog", "GOG"], ["itchio", "itch.io"], ["drm-free", "DRM-free"], ["ps5", "PS5"], ["ps4", "PS4"], ["xbox-series-xs", "Xbox Series"], ["xbox-one", "Xbox One"], ["switch", "Switch"], ["android", "Android"], ["ios", "iOS"]];
  const stateLine = (what, d) => (d && d.loading ? `<span class="hb-spin"></span> <span class="hb-muted">Loading ${what}...</span>` : d && d.err ? `<span class="hb-pill bad">${esc(d.err)}</span> <button class="hb-btn ghost" data-act="retry">Try again</button>` : "");

  function gameView() {
    const t = ui.tab.game;
    if (t === "free") return freeView();
    if (t === "deals") return dealsView();
    if (t === "session") return sessionView();
    return vitalsView();
  }

  function freeView() {
    const g = S.game.give, e = cache.epic, gp = cache.giveaways, now = Date.now();
    const epicHtml = !e || e.loading || e.err ? stateLine("Epic's free games", e || { loading: true }) : (() => {
      const f = e.data.free.map((x) => `<div class="hb-item">${x.image ? `<img class="thumb" src="${esc(x.image)}" alt="">` : ""}<div class="grow"><div class="t">${esc(x.title)}</div><div class="meta">${x.originalPrice ? `<span class="hb-was">${esc(x.originalPrice)}</span>` : ""}<span class="hb-pill free">FREE</span> ${esc(HC.endsIn(x.endDate, now))}</div></div><button class="hb-btn" data-act="open" data-url="${esc(x.url)}">Claim</button></div>`).join("");
      const up = e.data.upcoming.map((x) => `<div class="hb-item"><div class="grow"><div class="t">${esc(x.title)}</div><div class="meta">free from ${new Date(x.startDate).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</div></div></div>`).join("");
      return (f || `<div class="hb-empty">Nothing is free on Epic right now.</div>`) + (up ? `<div class="hb-muted" style="margin:8px 0 4px">Coming next</div>${up}` : "") + `<div class="hb-muted" style="margin-top:6px">Epic's other discounts are sales, not free games, and are left out.</div>`;
    })();
    const cards = !gp || gp.loading || gp.err ? stateLine("giveaways", gp || { loading: true }) : gp.data.items.length ? gp.data.items.map((x) => `<div class="hb-item">${x.thumb ? `<img class="thumb" src="${esc(x.thumb)}" alt="">` : ""}<div class="grow"><div class="t" title="${esc(x.title)}">${esc(x.title)}</div><div class="meta">${x.worth ? `<span class="hb-was">${esc(x.worth)}</span>` : ""}<span class="hb-pill free">FREE</span> ${esc(x.platforms.slice(0, 3).join(" · "))}${x.endDate ? " · " + esc(HC.endsIn(x.endDate, now)) : ""}${x.users ? " · " + x.users.toLocaleString() + " claimed" : ""}</div></div><button class="hb-btn" data-act="open" data-url="${esc(x.url)}">Claim</button></div>`).join("") : `<div class="hb-empty">No giveaways match that filter right now.</div>`;
    return `
      <div class="hb-card"><h4>Epic Games Store - free this week</h4>${epicHtml}</div>
      <div class="hb-card"><h4>Giveaways</h4>
        <div class="hb-row" style="margin-bottom:8px"><select data-cfg="give.platform">${PLATFORMS.map(([v, l]) => `<option value="${v}" ${g.platform === v ? "selected" : ""}>${l}</option>`).join("")}</select>
          <select data-cfg="give.type">${[["game", "Full games"], ["loot", "DLC & loot"], ["beta", "Beta keys"]].map(([v, l]) => `<option value="${v}" ${g.type === v ? "selected" : ""}>${l}</option>`).join("")}</select>
          <select data-cfg="give.sort">${[["popularity", "Most popular"], ["value", "Highest value"], ["date", "Newest"]].map(([v, l]) => `<option value="${v}" ${g.sort === v ? "selected" : ""}>${l}</option>`).join("")}</select>
          <button class="hb-btn ghost" data-act="reloadFree">Refresh</button></div>
        ${cards}
        <div class="hb-muted" style="margin-top:8px">Giveaway data from <span class="hb-link" data-act="open" data-url="https://www.gamerpower.com">GamerPower.com</span>. Always check the store page before you claim.</div></div>`;
  }
  async function loadFree(force) {
    cache.epic = { loading: true }; cache.giveaways = { loading: true }; if (ui.hub === "game" && ui.tab.game === "free") rerender();
    const [e, g] = await Promise.all([feed("epic", {}), feed("giveaways", S.game.give)]);
    cache.epic = e.ok ? { data: e.data, at: Date.now() } : { err: e.error };
    cache.giveaways = g.ok ? { data: g.data, at: Date.now() } : { err: g.error };
    if (ui.hub === "game" && ui.tab.game === "free") rerender();
  }

  function dealsView() {
    const d = S.game.deals, res = cache.deals, sr = cache.search, w = S.game.watch;
    const store = (id) => (res && res.data && res.data.stores[id]) || "";
    const dealRow = (x) => `<div class="hb-item">${x.thumb ? `<img class="thumb" src="${esc(x.thumb)}" alt="">` : ""}<div class="grow"><div class="t" title="${esc(x.title)}">${esc(x.title)}</div><div class="meta">${x.normal ? `<span class="hb-was">${esc(HC.fmtMoney(x.normal))}</span>` : ""}<b>${esc(HC.fmtMoney(x.sale))}</b> <span class="hb-pill ok">-${x.savings}%</span> ${esc(store(x.storeID))}${x.steamPercent ? " · " + x.steamPercent + "% positive" : ""}${x.metacritic ? " · Metacritic " + x.metacritic : ""}</div></div><button class="hb-btn" data-act="open" data-url="${esc(x.url)}">View</button><button class="hb-btn ghost" data-act="watchFromDeal" data-gid="${esc(x.gameID)}" data-title="${esc(x.title)}" data-price="${x.sale === null ? "" : x.sale}" title="Watch this game's price">Watch</button></div>`;
    const watchRows = w.map((x) => { const now = cache.watchNow && cache.watchNow.byId[x.gameID]; const hit = now && now.cheapest !== null && now.cheapest <= Number(x.target); return `<div class="hb-item"><div class="grow"><div class="t">${esc(x.title)}</div><div class="meta">alert at or under <b>${esc(HC.fmtMoney(x.target))}</b> · now ${now ? esc(HC.fmtMoney(now.cheapest)) : "<span class='hb-spin'></span>"}${now && now.cheapestEver !== null ? " · lowest ever " + esc(HC.fmtMoney(now.cheapestEver)) : ""}</div></div>${hit ? `<span class="hb-pill free">At your price!</span><button class="hb-btn" data-act="open" data-url="${esc(now.url)}">Buy</button>` : ""}<span class="hb-x" data-act="unwatch" data-gid="${esc(x.gameID)}">✕</span></div>`; }).join("");
    const draft = ui.watchDraft ? `<div class="hb-card" style="border-color:rgb(var(--p-168-139-250))"><h4>Price alert</h4><div class="hb-row"><span>Tell me when <b>${esc(ui.watchDraft.title)}</b> is at or under $</span><input id="wdTarget" type="number" min="0.5" step="0.5" value="${ui.watchDraft.target}" style="width:90px"><button class="hb-btn" data-act="watchSave">Watch it</button><button class="hb-btn ghost" data-act="watchCancel">Cancel</button></div><div id="wdMsg" class="hb-muted" style="margin-top:4px">Jonah checks the price whenever you open this tab.</div></div>` : "";
    return `
      ${draft}
      <div class="hb-card"><h4>Find a game's lowest price</h4><div class="hb-row"><input id="dlTitle" placeholder="e.g. Portal, Hades, Stardew..." style="flex:1;min-width:180px"><button class="hb-btn" data-act="dealSearch">Search</button></div>
        <div id="dlSearch" style="margin-top:8px">${sr ? (sr.loading ? stateLine("results", sr) : sr.err ? stateLine("", sr) : sr.data.items.length ? sr.data.items.map((x) => `<div class="hb-item">${x.thumb ? `<img class="thumb" src="${esc(x.thumb)}" alt="">` : ""}<div class="grow"><div class="t">${esc(x.title)}</div><div class="meta">cheapest now <b>${esc(HC.fmtMoney(x.cheapest))}</b></div></div>${x.url ? `<button class="hb-btn" data-act="open" data-url="${esc(x.url)}">View</button>` : ""}<button class="hb-btn ghost" data-act="watchFromGame" data-gid="${esc(x.gameID)}" data-title="${esc(x.title)}" data-price="${x.cheapest === null ? "" : x.cheapest}">Watch</button></div>`).join("") : `<div class="hb-empty">No games found for that name.</div>`) : ""}</div></div>
      <div class="hb-card"><h4>Price watchlist (${w.length})</h4>${watchRows || `<div class="hb-empty">Watch a game with the button and Jonah tells you here when it drops to your price. It checks when you open this tab.</div>`}</div>
      <div class="hb-card"><h4>Best PC deals right now</h4><div class="hb-row" style="margin-bottom:8px"><label class="hb-field">Up to<select data-cfg="deals.upper">${[5, 10, 15, 30, 60].map((n) => `<option value="${n}" ${Number(d.upper) === n ? "selected" : ""}>$${n}</option>`).join("")}</select></label><label class="hb-field">Sort by<select data-cfg="deals.sort">${[["Savings", "Biggest discount"], ["Deal Rating", "Best deal rating"], ["Reviews", "Best reviewed"], ["Price", "Cheapest"], ["recent", "Newest deal"]].map(([v, l]) => `<option value="${v}" ${d.sort === v ? "selected" : ""}>${l}</option>`).join("")}</select></label><button class="hb-btn ghost" style="align-self:flex-end" data-act="reloadDeals">Refresh</button></div>
        ${!res || res.loading || res.err ? stateLine("deals", res || { loading: true }) : res.data.items.map(dealRow).join("") || `<div class="hb-empty">No deals match.</div>`}
        <div class="hb-muted" style="margin-top:8px">Prices from <span class="hb-link" data-act="open" data-url="https://www.cheapshark.com">CheapShark</span>; stores can change a price at any time.</div></div>`;
  }
  async function loadDeals() {
    cache.deals = { loading: true }; if (ui.hub === "game" && ui.tab.game === "deals") rerender();
    const r = await feed("deals", { upperPrice: S.game.deals.upper, sortBy: S.game.deals.sort, pageSize: 12 });
    cache.deals = r.ok ? { data: r.data, at: Date.now() } : { err: r.error };
    if (ui.hub === "game" && ui.tab.game === "deals") rerender();
  }
  async function loadWatch() {
    if (!S.game.watch.length) { cache.watchNow = { byId: {} }; return; }
    const r = await feed("cheapestFor", { ids: S.game.watch.map((x) => x.gameID) });
    cache.watchNow = { byId: Object.fromEntries((r.ok ? r.data.items : []).map((x) => [x.gameID, x])) };
    if (ui.hub === "game" && ui.tab.game === "deals") rerender();
  }

  // ---- play session (module level: it keeps running with the panel closed)
  const sess = { on: false, startedAt: 0, lastBreak: 0, minuteTimer: null, tick: null, nagged: false };
  function sessionStart() { if (sess.on) return; sess.on = true; sess.startedAt = Date.now(); sess.lastBreak = 0; sess.nagged = false; sess.tick = setInterval(sessionTick, 1000); sessionTick(); }
  function creditMinutes(m) { if (m <= 0) return; const k = todayKey(); S.game.days[k] = S.game.days[k] || { min: 0 }; S.game.days[k].min += m; save(); }
  let credited = 0;
  function sessionTick() {
    if (!sess.on) return;
    const mins = Math.floor((Date.now() - sess.startedAt) / 60000);
    if (mins > credited) { creditMinutes(mins - credited); credited = mins; }
    const b = HC.breakDue(sess.startedAt, sess.lastBreak, Date.now(), S.game.breakEvery);
    if (b.due && !sess.nagged) { sess.nagged = true; beep(); notify(`You have been playing for ${HC.fmtDur(b.sinceMin)} - stand up, drink some water, look at something far away.`); }
    const bs = HC.budgetState(((S.game.days[todayKey()] || {}).min) || 0, S.game.budgetMin);
    if (bs.over && !sess.overNag) { sess.overNag = true; beep(); notify(`You have passed today's play budget (${HC.fmtDur(S.game.budgetMin)}).`); }
    sessionPaint();
    if (ui.open && ui.hub === "game" && ui.tab.game === "session") { const el = document.getElementById("hbSessClock"); if (el) el.textContent = fmtClock(Date.now() - sess.startedAt); const bn = document.getElementById("hbBreakNow"); if (bn) bn.style.display = b.due ? "" : "none"; }
  }
  function sessionStop() { if (!sess.on) return; sessionTick(); sess.on = false; clearInterval(sess.tick); credited = 0; sess.overNag = false; sessionPaint(); }
  const fmtClock = (ms) => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return (h ? h + ":" : "") + String(m).padStart(h ? 2 : 1, "0") + ":" + String(s % 60).padStart(2, "0"); };
  function sessionPaint() {
    let chip = document.getElementById("hubSessionChip");
    if (sess.on && !(panelEl() && ui.hub === "game")) {
      if (!chip) { chip = document.createElement("div"); chip.id = "hubSessionChip"; chip.title = "Open the play session"; chip.onclick = () => openHub("game", "session"); document.body.appendChild(chip); }
      chip.innerHTML = `${esc(fmtClock(Date.now() - sess.startedAt))}`;
    } else if (chip) chip.remove();
  }
  function sessionView() {
    const days = HC.sessionDays(S.game.days, new Date()), today = days[days.length - 1].min, bs = HC.budgetState(today, S.game.budgetMin), max = Math.max(60, ...days.map((d) => d.min));
    const b = sess.on ? HC.breakDue(sess.startedAt, sess.lastBreak, Date.now(), S.game.breakEvery) : { due: false, sinceMin: 0 };
    return `
      <div class="hb-card" style="text-align:center"><div class="hb-muted">${sess.on ? "Playing now" : "Not playing"}</div><div class="hb-big" id="hbSessClock">${sess.on ? fmtClock(Date.now() - sess.startedAt) : "0:00"}</div>
        <div class="hb-row" style="justify-content:center;margin-top:10px">${sess.on ? `<button class="hb-btn big" data-act="sessStop">End session</button><button class="hb-btn ghost" id="hbBreakNow" data-act="sessBreak" style="${b.due ? "" : "display:none"}">I took a break</button>` : `<button class="hb-btn big" data-act="sessStart">Start a play session</button>`}</div>
        <div class="hb-muted" style="margin-top:8px">Jonah can only time what you tell it - press start when you start playing.</div></div>
      <div class="hb-grid2"><div class="hb-card"><h4>Today</h4><div class="hb-big">${esc(HC.fmtDur(today))}</div><div class="hb-bar ${bs.level === "ok" ? "" : bs.level}" style="margin:8px 0"><i style="width:${Math.min(100, bs.pct)}%"></i></div><div class="hb-muted">${bs.over ? `${esc(HC.fmtDur(-bs.left))} over your ${esc(HC.fmtDur(S.game.budgetMin))} budget` : `${esc(HC.fmtDur(bs.left))} left of ${esc(HC.fmtDur(S.game.budgetMin))}`}</div></div>
        <div class="hb-card"><h4>Your rules</h4><div class="hb-row"><label class="hb-field">Daily budget (min)<input type="number" min="0" max="1440" data-cfg="budgetMin" value="${S.game.budgetMin}" style="width:90px"></label><label class="hb-field">Break every (min, 0 = off)<input type="number" min="0" max="240" data-cfg="breakEvery" value="${S.game.breakEvery}" style="width:90px"></label></div></div></div>
      <div class="hb-card"><h4>Last 7 days</h4><div style="display:flex;gap:8px;align-items:flex-end;height:84px">${days.map((d) => `<div style="flex:1;text-align:center;font-size:10px"><div title="${d.min} min" style="height:${Math.round((d.min / max) * 60) + 2}px;border-radius:5px 5px 0 0;background:linear-gradient(180deg,rgb(var(--p-168-139-250)),rgb(var(--p-139-92-246)))"></div>${d.label}<br><span class="hb-muted">${d.min ? HC.fmtDur(d.min) : "-"}</span></div>`).join("")}</div></div>`;
  }

  // ---- PC vitals
  const vit = { timer: null, history: [], busy: false };
  function stopVitals() { if (vit.timer) { clearInterval(vit.timer); vit.timer = null; } }
  async function pollVitals() {
    if (vit.busy || !hubs()) return; vit.busy = true;
    const r = await (async () => { try { return await hubs().system(); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })();
    vit.busy = false;
    cache.vitals = r.ok ? { data: r.data, at: Date.now() } : { err: r.error };
    if (r.ok) { vit.history.push({ cpu: r.data.cpu.loadPct, t: r.data.hottest }); if (vit.history.length > 60) vit.history.shift(); }
    if (ui.open && ui.hub === "game" && ui.tab.game === "vitals") { const b = document.getElementById("hbBody"); if (b) b.innerHTML = `<div style="padding:12px 14px">${vitalsView()}</div>`; }
  }
  function startVitals() { stopVitals(); pollVitals(); vit.timer = setInterval(pollVitals, 5000); }
  const spark = (vals, color) => { const v = vals.filter((x) => x !== null && x !== undefined); if (v.length < 2) return ""; const mx = Math.max(...v, 1), mn = Math.min(...v, 0); const pts = v.map((x, i) => `${Math.round((i / (v.length - 1)) * 200)},${Math.round(30 - ((x - mn) / (mx - mn || 1)) * 28)}`).join(" "); return `<svg class="hb-spark" viewBox="0 0 200 32" preserveAspectRatio="none"><polyline fill="none" stroke="${color}" stroke-width="1.6" points="${pts}"/></svg>`; };
  function vitalsView() {
    const c = cache.vitals;
    if (!c) return `<div class="hb-card"><span class="hb-spin"></span> <span class="hb-muted">Reading your computer (the first reading takes a couple of seconds)...</span></div>`;
    if (c.err) return `<div class="hb-card"><span class="hb-pill bad">${esc(c.err)}</span></div>`;
    const s = c.data;
    const bar = (pct, lvl) => `<div class="hb-bar ${lvl || ""}" style="margin:6px 0"><i style="width:${Math.min(100, Math.max(0, pct))}%"></i></div>`;
    const lvl = (p) => (p >= 92 ? "bad" : p >= 80 ? "warn" : "");
    const temps = s.temps.map((t) => `<div class="hb-row" style="justify-content:space-between"><span class="hb-muted">${esc(t.label)}</span><span class="hb-pill ${HC.tempLevel(t.c)}">${t.c.toFixed(1)}°C</span></div>`).join("");
    const gpuNv = s.gpus.map((g) => `<div style="margin-top:6px"><b>${esc(g.name)}</b><div class="hb-row" style="justify-content:space-between"><span class="hb-muted">Temperature</span><span class="hb-pill ${HC.tempLevel(g.tempC)}">${g.tempC === null ? "n/a" : g.tempC + "°C"}</span></div><div class="hb-muted">${g.utilPct === null ? "" : g.utilPct + "% busy"}${g.memTotalMB ? " · " + Math.round(g.memUsedMB) + "/" + Math.round(g.memTotalMB) + " MB" : ""}${g.powerW ? " · " + g.powerW + " W" : ""}</div></div>`).join("");
    const gpuNames = !s.gpus.length ? s.gpuNames.map((g) => `<div class="hb-muted">${esc(g.name)}${g.ramGB ? " · " + g.ramGB + " GB" : ""}</div>`).join("") : "";
    return `
      <div class="hb-row" style="justify-content:space-between;margin-bottom:8px"><span class="hb-muted">${esc(s.cpu.model)} · ${s.cpu.threads} threads · on for ${s.uptimeHours} h · updated ${esc(ago(c.at))}</span><span class="hb-muted">refreshes every 5 s</span></div>
      <div class="hb-card"><h4>What Jonah found</h4>${s.findings.map((f) => `<div class="hb-find ${f.level}">${esc(f.text)}</div>`).join("")}</div>
      <div class="hb-grid3">
        <div class="hb-card"><h4>CPU</h4><div class="hb-big">${s.cpu.loadPct === null ? "-" : s.cpu.loadPct + "%"}</div>${bar(s.cpu.loadPct || 0, lvl(s.cpu.loadPct || 0))}${spark(vit.history.map((h) => h.cpu), "rgb(var(--p-168-139-250))")}</div>
        <div class="hb-card"><h4>Memory</h4><div class="hb-big">${s.memory.usedPct}%</div>${bar(s.memory.usedPct, lvl(s.memory.usedPct))}<div class="hb-muted">${(s.memory.totalGB - s.memory.freeGB).toFixed(1)} of ${s.memory.totalGB} GB used</div></div>
        <div class="hb-card"><h4>Temperature</h4><div class="hb-big">${s.hottest === null ? "-" : s.hottest.toFixed(0) + "°C"}</div><div class="hb-muted" style="margin-bottom:4px">${s.hottest === null ? "no sensor" : "hottest sensor"}</div>${spark(vit.history.map((h) => h.t), "#f59e0b")}</div>
      </div>
      <div class="hb-grid2">
        <div class="hb-card"><h4>Temperatures</h4>${temps || `<div class="hb-empty">This computer does not expose temperature sensors to Windows.</div>`}<div class="hb-muted" style="margin-top:6px">These are the laptop maker's thermal zones - the closest Windows gives without special drivers - not necessarily the CPU core itself.</div></div>
        <div class="hb-card"><h4>Graphics</h4>${gpuNv}${gpuNames}${s.gpus.length ? "" : `<div class="hb-muted" style="margin-top:4px">GPU temperature is only readable on NVIDIA cards.</div>`}</div>
      </div>
      <div class="hb-grid2">
        <div class="hb-card"><h4>Battery</h4>${s.battery ? `<div class="hb-big">${s.battery.percent === null ? "-" : s.battery.percent + "%"}</div>${bar(s.battery.percent || 0, s.battery.percent <= 15 ? "bad" : s.battery.percent <= 30 ? "warn" : "")}<div class="hb-muted">${esc(s.battery.state)}${s.battery.minutesLeft ? " · about " + esc(HC.fmtDur(s.battery.minutesLeft)) + " left" : ""}</div>` : `<div class="hb-empty">No battery (a desktop, or Windows cannot see one).</div>`}</div>
        <div class="hb-card"><h4>Network</h4>${s.net ? `<div class="hb-row" style="justify-content:space-between"><span>↓ download</span><b>${esc(HC.fmtBytes(s.net.rxBps))}</b></div><div class="hb-row" style="justify-content:space-between"><span>↑ upload</span><b>${esc(HC.fmtBytes(s.net.txBps))}</b></div><div class="hb-muted">${esc(s.net.adapter || "")}</div>` : `<div class="hb-empty">Not available on this system.</div>`}</div>
      </div>
      <div class="hb-card"><h4>Storage</h4>${s.disks.map((d) => `<div><div class="hb-row" style="justify-content:space-between"><b>${esc(d.drive)}</b><span class="hb-muted">${d.freeGB} GB free of ${d.totalGB} GB</span></div>${bar(d.usedPct, lvl(d.usedPct))}</div>`).join("") || `<div class="hb-empty">No drives read.</div>`}</div>
      ${s.jonah ? `<div class="hb-card"><h4>Jonah itself</h4><div class="hb-muted">The browser is using about <b>${s.jonah.cpuPct}%</b> CPU and <b>${s.jonah.memMB} MB</b> of memory across ${s.jonah.processes} processes. Jonah only reads these numbers - it never changes or closes anything on your computer.</div></div>` : ""}
      ${s.notes.length ? `<div class="hb-muted">${s.notes.map(esc).join("<br>")}</div>` : ""}`;
  }

  // ================================================================== CREATOR STUDIO
  const C = () => S.creator;
  function creatorView() { const t = ui.tab.creator; return t === "plan" ? planView() : t === "ideas" ? ideasView() : t === "income" ? incomeView() : t === "lists" ? listsView() : t === "captions" ? captionsView() : accountsView(); }

  function planView() {
    const base = new Date(); base.setDate(base.getDate() + ui.week * 7);
    const plan = HC.weekPlan(C().items, base, { restDays: C().cfg.restDays, capacityHours: C().cfg.capacity }), today = todayKey();
    const pipe = HC.pipeline(C().items);
    const defWhen = (() => { const d = new Date(Date.now() + 86400000); d.setHours(12, 0, 0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); })();
    return `
      ${plan.warnings.map((w) => `<div class="hb-find warn">${esc(w)}</div>`).join("")}
      <div class="hb-card"><div class="hb-row" style="justify-content:space-between;margin-bottom:8px"><div class="hb-row"><button class="hb-btn ghost" data-act="weekPrev">Prev</button><b>${plan.days[0].date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${plan.days[6].date.toLocaleDateString(undefined, { day: "numeric", month: "short" })}</b><button class="hb-btn ghost" data-act="weekNext">Next</button>${ui.week ? `<button class="hb-btn ghost" data-act="weekNow">This week</button>` : ""}</div><span class="hb-pill ${plan.overbooked ? "bad" : "ok"}">~${Math.round(plan.hours)}h of ${plan.capacityHours}h</span></div>
        <div class="hb-week">${plan.days.map((d) => `<div class="hb-day${d.isRest ? " rest" : ""}${d.key === today ? " today" : ""}"><div class="dn">${d.date.toLocaleDateString(undefined, { weekday: "short" })} ${d.date.getDate()}${d.isRest ? " · rest" : ""}</div>${d.items.map((i) => `<span class="hb-chip ${i.status}" data-act="advance" data-id="${i.id}" title="${esc(i.title)} - ${esc(i.platform)} - ${esc(i.status)} (click: next stage, right-click: delete)">${esc(i.title)}<br><small>${esc(i.platform)} · ${esc(i.status)}</small></span>`).join("")}</div>`).join("")}</div></div>
      <div class="hb-card"><h4>Add to the plan</h4><div class="hb-row"><input id="cpTitle" placeholder="What are you making?" style="flex:2;min-width:150px"><select id="cpPlat">${HC.PLATFORMS.map((p) => `<option>${p}</option>`).join("")}</select><select id="cpKind">${Object.entries(HC.KINDS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("")}</select><input type="datetime-local" id="cpWhen" value="${defWhen}"><button class="hb-btn" data-act="planAdd">Add</button></div></div>
      <div class="hb-grid2"><div class="hb-card"><h4>Pipeline</h4>${HC.STATUSES.map((s) => `<div class="hb-row" style="justify-content:space-between"><span style="text-transform:capitalize">${s}</span><span class="hb-pill">${pipe[s].length}</span></div>`).join("")}</div>
        <div class="hb-card"><h4>Your limits</h4><div class="hb-muted" style="margin-bottom:6px">Days off (Jonah warns when you plan work on one):</div><div class="hb-row">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((n, i) => `<label style="font-size:12px"><input type="checkbox" data-cfg="rest" data-d="${i}" ${C().cfg.restDays.includes(i) ? "checked" : ""}> ${n}</label>`).join("")}</div><label class="hb-field" style="margin-top:8px">Most hours of content work per week<input type="number" min="1" max="100" data-cfg="capacity" value="${C().cfg.capacity}" style="width:90px"></label></div></div>`;
  }

  function ideasView() {
    const q = (ui.ideaQ || "").toLowerCase(); const list = C().ideas.filter((i) => !q || (i.text + " " + (i.url || "")).toLowerCase().includes(q));
    return `
      <div class="hb-card"><h4>Capture an idea</h4><div class="hb-row"><input id="idText" placeholder="Type it before you lose it, press Enter..." style="flex:1;min-width:200px"><button class="hb-btn" data-act="ideaAdd">Save</button><button class="hb-btn ghost" data-act="ideaClip" title="Save the page you have open (and any text you selected)">Clip this page</button></div><div id="idMsg" class="hb-muted" style="margin-top:6px"></div></div>
      <div class="hb-card"><div class="hb-row" style="justify-content:space-between;margin-bottom:8px"><h4 style="margin:0">Inbox (${C().ideas.length})</h4><input id="idSearch" placeholder="Search ideas" value="${esc(ui.ideaQ || "")}" style="width:160px"></div>
        ${list.map((i) => `<div class="hb-item"><div class="grow"><div class="t" style="white-space:normal">${esc(i.text)}</div><div class="meta">${new Date(i.at).toLocaleDateString()}${i.url ? ` · <span class="hb-link" data-act="open" data-url="${esc(i.url)}">source</span>` : ""}${HC.hashtags(i.text).length ? " · " + esc(HC.hashtags(i.text).join(" ")) : ""}</div></div><button class="hb-btn ghost" data-act="ideaToPlan" data-id="${i.id}" title="Turn into a planned post">→ Plan</button><span class="hb-x" data-act="ideaDel" data-id="${i.id}">✕</span></div>`).join("") || `<div class="hb-empty">${C().ideas.length ? "Nothing matches." : "No ideas yet. Capture them the moment you have them - sorting comes later."}</div>`}</div>`;
  }

  function incomeView() {
    const s = HC.incomeSummary(C().income, Date.now()), cur = "$";
    return `
      <div class="hb-grid3"><div class="hb-card"><h4>Paid in ${esc(s.monthName)}</h4><div class="hb-big">${cur}${s.thisMonth.toFixed(0)}</div></div><div class="hb-card"><h4>3-month average</h4><div class="hb-big">${cur}${s.avg3.toFixed(0)}</div><div class="hb-muted">paid, per month</div></div><div class="hb-card"><h4>Still owed to you</h4><div class="hb-big">${cur}${s.owed.toFixed(0)}</div>${s.overdue.length ? `<div class="hb-pill bad" style="margin-top:4px">${cur}${s.overdueTotal.toFixed(0)} overdue</div>` : ""}</div></div>
      <div class="hb-card"><h4>Add a deal or payment</h4><div class="hb-row"><input id="inBrand" placeholder="Brand / client" style="flex:1;min-width:120px"><input id="inWhat" placeholder="What (1 reel + 3 stories)" style="flex:1;min-width:140px"><input id="inAmt" type="number" min="0" step="1" placeholder="Amount" style="width:90px"><select id="inStatus">${HC.INCOME_STATUSES.map((x) => `<option>${x}</option>`).join("")}</select><label class="hb-field" style="margin:0">Due / paid on<input id="inDue" type="date"></label><button class="hb-btn" data-act="incomeAdd" style="align-self:flex-end">Add</button></div></div>
      <div class="hb-card"><h4>Deals (${C().income.length})</h4>${C().income.slice().sort((a, b) => Date.parse(b.due || 0) - Date.parse(a.due || 0)).map((e) => `<div class="hb-item"><div class="grow"><div class="t">${esc(e.brand)}${e.what ? " · " + esc(e.what) : ""}</div><div class="meta">${cur}${Number(e.amount || 0).toFixed(0)}${e.due ? " · " + (e.status === "paid" ? "paid " : "due ") + new Date(e.due).toLocaleDateString() : ""}</div></div><span class="hb-pill ${e.status === "paid" ? "ok" : s.overdue.includes(e.id) ? "bad" : ""}">${s.overdue.includes(e.id) ? "overdue" : esc(e.status)}</span>${e.status !== "paid" ? `<button class="hb-btn ghost" data-act="incomeNext" data-id="${e.id}">→ ${esc(HC.INCOME_STATUSES[HC.INCOME_STATUSES.indexOf(e.status) + 1] || "paid")}</button>` : ""}<span class="hb-x" data-act="incomeDel" data-id="${e.id}">✕</span></div>`).join("") || `<div class="hb-empty">No deals yet. Money worries are creators' biggest stress, so track what is agreed, delivered, invoiced and paid.</div>`}
        <div class="hb-muted" style="margin-top:8px">Simple tallies only - not tax or financial advice.</div></div>`;
  }

  function listsView() {
    return `
      <div class="hb-card"><h4>Start a checklist</h4><div class="hb-row">${Object.keys(HC.CHECKLISTS).map((n) => `<button class="hb-btn" data-act="listStart" data-name="${esc(n)}">+ ${esc(n)}</button>`).join("")}</div><div class="hb-row" style="margin-top:8px"><input id="lsName" placeholder="Name it (e.g. Autumn lookbook reel)" style="flex:1;min-width:160px"><button class="hb-btn ghost" data-act="listNamed">Start with the name</button></div></div>
      ${C().lists.map((l) => { const done = l.checked.length; return `<div class="hb-card"><div class="hb-row" style="justify-content:space-between"><b>${esc(l.title)}</b><span><span class="hb-pill ${done === l.items.length ? "ok" : ""}">${done}/${l.items.length}</span> <span class="hb-x" data-act="listDel" data-id="${l.id}">✕</span></span></div><div class="hb-bar" style="margin:8px 0"><i style="width:${Math.round((done / l.items.length) * 100)}%"></i></div>${l.items.map((it, i) => `<label class="hb-item" style="cursor:pointer"><input type="checkbox" data-act="listCheck" data-id="${l.id}" data-i="${i}" ${l.checked.includes(i) ? "checked" : ""} style="width:auto"><span class="grow" style="${l.checked.includes(i) ? "text-decoration:line-through;opacity:.55" : ""}">${esc(it)}</span></label>`).join("")}</div>`; }).join("") || `<div class="hb-empty">No checklists yet.</div>`}`;
  }

  function captionsView() {
    const a = ui.ai, cf = ui.cap || { platform: "Instagram", text: "", topic: "", tone: "friendly" };
    const chk = HC.captionCheck(cf.text, cf.platform);
    return `
      <div class="hb-card"><h4>Check a caption</h4><div class="hb-row" style="margin-bottom:6px"><select id="cpPlatform">${HC.PLATFORMS.map((p) => `<option ${cf.platform === p ? "selected" : ""}>${p}</option>`).join("")}</select><span id="cpCount" class="hb-pill ${chk.over ? "bad" : chk.near ? "warn" : "ok"}">${chk.count} / ${chk.limit}</span><span id="cpTags" class="hb-pill">${chk.tags} hashtags</span></div>
        <textarea id="cpText" rows="4" style="width:100%;box-sizing:border-box" placeholder="Write or paste your caption...">${esc(cf.text)}</textarea><div class="hb-muted" id="cpNote" style="margin-top:4px">${esc(chk.note)}</div><div class="hb-row" style="margin-top:6px"><button class="hb-btn ghost" data-act="capCopy">Copy</button></div></div>
      <div class="hb-card"><h4>Ideas</h4><div class="hb-row"><input id="cpTopic" placeholder="What is the post about?" value="${esc(cf.topic)}" style="flex:1;min-width:180px"><select id="cpTone">${["friendly", "funny", "calm", "bold", "professional", "poetic"].map((t) => `<option ${cf.tone === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
        <div class="hb-row" style="margin-top:8px"><button class="hb-btn" data-act="tagsRule"># Hashtag ideas (instant)</button><button class="hb-btn" data-act="capAI" ${a.busy ? "disabled" : ""}>Caption ideas (AI)</button></div>
        <div class="hb-muted" style="margin-top:6px">Hashtags are built from your words, offline. The AI caption helper is a small model: read every line before you post it.</div>
        <div id="capOut" style="margin-top:8px">${a.busy ? `<span class="hb-spin"></span> <span class="hb-muted">Thinking...</span>` : a.err ? `<span class="hb-pill bad">${esc(a.err)}</span>` : ui.tags ? `<div class="hb-row">${ui.tags.map((t) => `<span class="hb-pill" style="cursor:pointer" data-act="tagAdd" data-tag="${esc(t)}">${esc(t)}</span>`).join("") || `<span class="hb-muted">Type a few more words about the post.</span>`}</div><div class="hb-muted" style="margin-top:4px">Click a tag to add it to your caption.</div>` : ""}${(ui.caps || []).map((c) => `<div class="hb-item"><div class="grow" style="white-space:normal">${esc(c)}</div><button class="hb-btn ghost" data-act="capUse" data-text="${esc(c)}">Use</button></div>`).join("")}</div></div>`;
  }

  const SITES = [["Instagram", "https://www.instagram.com/"], ["TikTok", "https://www.tiktok.com/"], ["YouTube", "https://www.youtube.com/"], ["X", "https://x.com/"], ["Pinterest", "https://www.pinterest.com/"], ["Twitch", "https://www.twitch.tv/"]];
  function accountsView() {
    return `
      <div class="hb-card"><h4>Add an account</h4><div class="hb-row"><input id="acName" placeholder="Name (e.g. Personal, Brand, Client A)" style="flex:1;min-width:160px"><select id="acSite">${SITES.map(([n, u]) => `<option value="${esc(u)}">${n}</option>`).join("")}</select><button class="hb-btn" data-act="accAdd">Add</button></div><div class="hb-muted" style="margin-top:6px">Each account here gets its OWN browser session, so being logged in to one never logs you out of another. Jonah does not store your passwords.</div></div>
      ${C().accounts.map((a) => `<div class="hb-item"><div class="grow"><div class="t">${esc(a.name)}</div><div class="meta">${esc(a.siteName)} · separate login</div></div><button class="hb-btn" data-act="accOpen" data-id="${a.id}">Open</button><span class="hb-x" data-act="accDel" data-id="${a.id}" title="Remove from this list (the saved login stays until you clear it)">✕</span></div>`).join("") || `<div class="hb-empty">No accounts yet.</div>`}`;
  }

  // ================================================================== AESTHETIC LAB
  function aestheticView() { const t = ui.tab.aesthetic; return t === "looks" ? looksView() : t === "boards" ? boardsView() : t === "palette" ? paletteView() : referenceView(); }
  const sw = (hex, label, act, extra = "") => `<div class="hb-sw" data-act="${act}" data-hex="${esc(hex)}" ${extra} title="${esc(label)} ${esc(hex)}"><i style="background:${esc(hex)}"></i><b style="color:rgb(var(--p-235-232-245))">${esc(label)}</b><span class="hb-muted">${esc(hex.toUpperCase())}</span></div>`;
  function looksView() {
    const cur = (window.JonahTheme && JonahTheme.readStored()) || (window.JonahTheme && JonahTheme.DEFAULT_HEX) || "";
    return `
      <div class="hb-card"><h4>Pinterest's 2026 palette</h4><div class="hb-row" style="gap:12px;align-items:flex-start">${HC.PINTEREST_2026.map((c) => sw(c.hex, c.name, "useColour")).join("")}</div><div class="hb-muted" style="margin-top:8px">Click one to recolour all of Jonah. Hex codes as reported by B&amp;T and campaignme.com (Persimmon by House Digest only). Jonah keeps its dark layout, so a pale colour like Cool Blue becomes a soft glow, not a white page.</div></div>
      <div class="hb-card"><h4>Aesthetics</h4><div class="hb-row" style="gap:12px;align-items:flex-start">${HC.AESTHETICS.map((c) => sw(c.hex, c.name, "useColour")).join("")}</div><div class="hb-muted" style="margin-top:8px">Each look is one colour - my reading of the aesthetic, not an official palette.</div></div>
      <div class="hb-card"><div class="hb-row" style="justify-content:space-between"><span>Current theme colour: <b>${esc(cur.toUpperCase())}</b></span><span><button class="hb-btn ghost" data-act="useColour" data-hex="${esc(window.JonahTheme ? JonahTheme.DEFAULT_HEX : "")}">Back to Jonah purple</button></span></div><div class="hb-muted" style="margin-top:6px">Any other colour: use the rainbow button on the home page.</div></div>`;
  }

  const board = () => S.aesthetic.boards.find((b) => b.id === ui.boardId) || S.aesthetic.boards[0];
  function boardsView() {
    const b = board();
    return `
      <div class="hb-card"><div class="hb-row">${S.aesthetic.boards.map((x) => `<button class="hb-btn ${x.id === b.id ? "" : "ghost"}" data-act="boardPick" data-id="${x.id}">${esc(x.name)} (${x.images.length})</button>`).join("")}${ui.newBoard ? `<input id="bdNewName" placeholder="Board name" style="width:150px"><button class="hb-btn" data-act="boardCreate">Create</button><button class="hb-btn ghost" data-act="boardCancel">Cancel</button>` : `<button class="hb-btn ghost" data-act="boardNew">+ New board</button>`}${S.aesthetic.boards.length > 1 ? `<button class="hb-btn ghost" data-act="boardDel" data-id="${b.id}">Delete this board</button>` : ""}</div></div>
      <div class="hb-card"><h4>Add pictures to "${esc(b.name)}"</h4>
        <div class="hb-row"><label class="hb-btn" style="cursor:pointer">Choose files<input id="bdFiles" type="file" accept="image/*" multiple style="display:none"></label><input id="bdUrl" placeholder="https://... image link" style="flex:1;min-width:160px"><button class="hb-btn" data-act="boardUrl">Add link</button><button class="hb-btn ghost" data-act="boardPage" title="Find the pictures on the page you have open">From this page</button></div>
        <div id="bdMsg" class="hb-muted" style="margin-top:6px">You can also paste a copied picture (Ctrl+V) while this panel is open.</div>
        ${ui.pageImgs ? `<div style="margin-top:8px"><div class="hb-muted" style="margin-bottom:4px">${ui.pageImgs.length ? "Click the ones to add:" : "No big pictures found on this page."}</div><div class="hb-imgs">${ui.pageImgs.map((u, i) => `<div class="im" data-act="boardPageAdd" data-i="${i}"><img src="${esc(u)}" alt=""></div>`).join("")}</div></div>` : ""}</div>
      <div class="hb-card"><div class="hb-imgs" id="bdGrid">${b.images.map((id) => `<div class="im" data-act="imgPalette" data-id="${id}" title="Click to get its colours"><img data-img="${id}" alt=""><span class="hb-x" data-act="imgDel" data-id="${id}">✕</span></div>`).join("") || `<div class="hb-empty" style="grid-column:1/-1">Empty. Add pictures you love; click one to pull out its colours.</div>`}</div></div>`;
  }
  async function hydrateImages() {
    for (const el of document.querySelectorAll("#hbBody img[data-img]")) { try { const rec = await idb.get(el.dataset.img); if (rec && rec.blob) el.src = URL.createObjectURL(rec.blob); } catch (_) { /* unreadable */ } }
  }
  /** Decode any image blob/url into a downscaled canvas (max 1024px) - what is stored AND what the palette reads. */
  async function toScaledBlob(source) {
    const bmp = await createImageBitmap(source);
    const sc = Math.min(1, 1024 / Math.max(bmp.width, bmp.height)), w = Math.max(1, Math.round(bmp.width * sc)), h = Math.max(1, Math.round(bmp.height * sc));
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const ctx = cv.getContext("2d"); ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", 0.88));
    return { blob, w, h };
  }
  async function addImageBlob(source) {
    const { blob, w, h } = await toScaledBlob(source);
    const id = "i" + uid();
    await idb.put({ id, blob, w, h });
    board().images.unshift(id); save();
    return id;
  }
  async function addFromUrl(url) {
    if (!hubs()) throw new Error("This needs the Jonah app.");
    const r = await hubs().fetchImage(url);
    if (!r.ok) throw new Error(r.why || "Could not fetch that image.");
    const bin = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
    return addImageBlob(new Blob([bin], { type: r.mime }));
  }
  async function paletteFor(id, k) {
    const rec = await idb.get(id); if (!rec) return null;
    const bmp = await createImageBitmap(rec.blob); const sc = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * sc)), h = Math.max(1, Math.round(bmp.height * sc));
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const ctx = cv.getContext("2d", { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, w, h);
    return HC.extractPalette(ctx.getImageData(0, 0, w, h).data, w, h, k);
  }
  function paletteView() {
    const p = ui.palette;
    return `
      <div class="hb-card"><h4>Pull the colours out of a picture</h4><div class="hb-row"><label class="hb-btn" style="cursor:pointer">Choose a picture<input id="plFile" type="file" accept="image/*" style="display:none"></label><label class="hb-field" style="margin:0">Colours<select id="plK">${[4, 5, 6, 8].map((n) => `<option ${n === (ui.palK || 6) ? "selected" : ""}>${n}</option>`).join("")}</select></label><span class="hb-muted">or click a picture on a moodboard</span></div></div>
      ${p ? (p.busy ? `<div class="hb-card"><span class="hb-spin"></span> <span class="hb-muted">Reading the picture...</span></div>` : p.err ? `<div class="hb-card"><span class="hb-pill bad">${esc(p.err)}</span></div>` : `<div class="hb-card"><h4>Palette</h4><div class="hb-row" style="gap:12px;align-items:flex-start">${p.colours.map((c) => sw(c.hex, c.pct + "%", "copyColour")).join("")}</div><div class="hb-row" style="margin-top:10px"><button class="hb-btn ghost" data-act="palCopy">Copy all codes</button><button class="hb-btn ghost" data-act="palCard">Save palette card (PNG)</button></div><div class="hb-muted" style="margin-top:6px">Click a swatch to copy its code. To recolour Jonah with one: ${p.colours.map((c) => `<span class="hb-link" data-act="useColour" data-hex="${esc(c.hex)}">${esc(c.hex.toUpperCase())}</span>`).join(" ")}</div><div id="plMsg" class="hb-muted"></div></div>`) : `<div class="hb-empty">Pick a picture to see its main colours.</div>`}`;
  }
  function referenceView() {
    return `
      <div class="hb-card"><h4>Aesthetics reference</h4><div class="hb-muted" style="margin-bottom:8px">The Aesthetics Wiki catalogues hundreds of looks. These open its search in a new tab.</div>
        ${HC.AESTHETICS.map((a) => `<div class="hb-item"><i style="display:block;width:22px;height:22px;border-radius:50%;background:${esc(a.hex)};flex:none"></i><div class="grow t">${esc(a.name)}</div><button class="hb-btn ghost" data-act="open" data-url="${esc(HC.wikiSearch(a.name))}">Wiki</button><button class="hb-btn ghost" data-act="useColour" data-hex="${esc(a.hex)}">Use colour</button></div>`).join("")}
        <div class="hb-muted" style="margin-top:8px">Aesthetic descriptions belong to the Aesthetics Wiki community (CC-BY-SA licence). Jonah only links to them and copies nothing. I could not open that site from my tools, so the search links are not tested.</div></div>`;
  }
  function drawPaletteCard(colours) {
    const w = 900, h = 260, cv = document.createElement("canvas"); cv.width = w; cv.height = h; const ctx = cv.getContext("2d");
    ctx.fillStyle = "#151515"; ctx.fillRect(0, 0, w, h);
    const cw = (w - 40) / colours.length;
    colours.forEach((c, i) => { ctx.fillStyle = c.hex; ctx.fillRect(20 + i * cw, 20, cw - 6, 170); ctx.fillStyle = "#fff"; ctx.font = "bold 18px Arial"; ctx.fillText(c.hex.toUpperCase(), 24 + i * cw, 218); ctx.fillStyle = "#aaa"; ctx.font = "13px Arial"; ctx.fillText(c.pct + "%", 24 + i * cw, 240); });
    return cv;
  }

  // ================================================================== events
  function afterRender() {
    const hub = ui.hub, tab = ui.tab[hub];
    if (hub === "game" && tab === "free" && !cache.giveaways) loadFree();
    if (hub === "game" && tab === "deals") { if (!cache.deals) loadDeals(); loadWatch(); }
    if (hub === "game" && tab === "vitals") startVitals();
    if (hub === "aesthetic" && tab === "boards") hydrateImages();
  }
  const setPath = (path, v) => { const [a, b] = path.split("."); if (b) S.game[a][b] = v; else S.game[a] = v; save(); };
  async function flashMsg(id, text, bad) { const el = document.getElementById(id); if (el) { el.textContent = text; el.style.color = bad ? "#ffc0c8" : ""; } }
  const findIn = (arr, id) => arr.find((x) => x.id === id);

  async function onClick(e) {
    const t = e.target.closest("[data-act]");
    if (!t || (t.tagName === "INPUT" && t.type === "checkbox") || t.tagName === "SELECT") return;
    const act = t.dataset.act, id = t.dataset.id, $ = (x) => document.getElementById(x);
    switch (act) {
      case "tab": ui.tab[ui.hub] = t.dataset.v; rerender(); break;
      case "open": openLink(t.dataset.url); break;
      case "retry": cache.giveaways = cache.epic = cache.deals = cache.search = null; rerender(); break;
      case "reloadFree": cache.giveaways = cache.epic = null; loadFree(); break;
      case "reloadDeals": cache.deals = null; loadDeals(); break;
      case "dealSearch": { const q = $("dlTitle").value.trim(); if (q.length < 2) return; cache.search = { loading: true }; rerender(); const r = await feed("search", { title: q }); cache.search = r.ok ? { data: r.data } : { err: r.error }; rerender(); break; }
      case "watchFromGame": case "watchFromDeal": {
        const price = Number(t.dataset.price); const def = Number.isFinite(price) && price > 0 ? Math.max(0.99, Math.floor(price * 0.6 * 100) / 100) : 5;
        const gid = String(t.dataset.gid).replace(/\D/g, ""); if (!gid) return;
        ui.watchDraft = { gid, title: t.dataset.title.slice(0, 140), target: def }; rerender(); const i = $("wdTarget"); if (i) { i.focus(); i.select(); } break;
      }
      case "watchSave": {
        const d = ui.watchDraft; if (!d) return; const target = Number(String($("wdTarget").value).replace(/[^\d.]/g, ""));
        if (!Number.isFinite(target) || target <= 0) { flashMsg("wdMsg", "Type a price like 9.99", true); return; }
        S.game.watch = S.game.watch.filter((x) => x.gameID !== d.gid).concat({ gameID: d.gid, title: d.title, target }); save(); ui.watchDraft = null; loadWatch(); rerender(); break;
      }
      case "watchCancel": ui.watchDraft = null; rerender(); break;
      case "unwatch": S.game.watch = S.game.watch.filter((x) => x.gameID !== t.dataset.gid); save(); rerender(); break;
      case "sessStart": sessionStart(); rerender(); break;
      case "sessStop": sessionStop(); rerender(); break;
      case "sessBreak": sess.lastBreak = Date.now(); sess.nagged = false; rerender(); break;

      case "weekPrev": ui.week--; rerender(); break; case "weekNext": ui.week++; rerender(); break; case "weekNow": ui.week = 0; rerender(); break;
      case "planAdd": {
        const title = $("cpTitle").value.trim(), when = new Date($("cpWhen").value); if (!title || Number.isNaN(when.getTime())) { alert("Give it a name and a date."); return; }
        C().items.push({ id: "c" + uid(), title: title.slice(0, 120), platform: $("cpPlat").value, kind: $("cpKind").value, status: "idea", when: when.toISOString() }); save(); rerender(); break;
      }
      case "advance": { const it = findIn(C().items, id); if (it) { it.status = HC.nextStatus(it.status); save(); rerender(); } break; }
      case "ideaAdd": { const v = $("idText").value.trim(); if (!v) return; C().ideas.unshift({ id: "d" + uid(), text: v.slice(0, 600), at: Date.now() }); save(); rerender(); break; }
      case "ideaClip": {
        const wv = activeView(); if (!wv) return flashMsg("idMsg", "No page is open.", true);
        try { const d = await wv.executeJavaScript("({ title: document.title, url: location.href, sel: String(getSelection() || '').slice(0, 500) })"); if (!/^https?:/.test(d.url)) return flashMsg("idMsg", "Open a web page first.", true); C().ideas.unshift({ id: "d" + uid(), text: (d.sel ? d.sel + " - " : "") + String(d.title || d.url).slice(0, 200), url: /^https:/.test(d.url) ? d.url : "", at: Date.now() }); save(); rerender(); } catch (_) { flashMsg("idMsg", "Could not read that page.", true); }
        break;
      }
      case "ideaDel": C().ideas = C().ideas.filter((x) => x.id !== id); save(); rerender(); break;
      case "ideaToPlan": { const i = findIn(C().ideas, id); if (!i) break; const d = new Date(Date.now() + 86400000); d.setHours(12, 0, 0, 0); C().items.push({ id: "c" + uid(), title: i.text.slice(0, 120), platform: "Instagram", kind: "post", status: "idea", when: d.toISOString() }); C().ideas = C().ideas.filter((x) => x.id !== id); save(); ui.tab.creator = "plan"; rerender(); break; }
      case "incomeAdd": {
        const brand = $("inBrand").value.trim(), amt = Number($("inAmt").value); if (!brand || !(amt >= 0) || $("inAmt").value === "") { alert("Give it a brand and an amount."); return; }
        const due = $("inDue").value ? new Date($("inDue").value + "T12:00:00").toISOString() : ""; const status = $("inStatus").value;
        C().income.push({ id: "n" + uid(), brand: brand.slice(0, 80), what: $("inWhat").value.trim().slice(0, 120), amount: amt, status, due, paidOn: status === "paid" ? due || new Date().toISOString() : "" }); save(); rerender(); break;
      }
      case "incomeNext": { const e2 = findIn(C().income, id); if (e2) { e2.status = HC.INCOME_STATUSES[Math.min(HC.INCOME_STATUSES.length - 1, HC.INCOME_STATUSES.indexOf(e2.status) + 1)]; if (e2.status === "paid") e2.paidOn = new Date().toISOString(); save(); rerender(); } break; }
      case "incomeDel": C().income = C().income.filter((x) => x.id !== id); save(); rerender(); break;
      case "listStart": { const n = t.dataset.name; if (HC.CHECKLISTS[n]) { C().lists.unshift({ id: "l" + uid(), title: n, items: HC.CHECKLISTS[n].slice(), checked: [] }); save(); rerender(); } break; }
      case "listNamed": { const n = $("lsName").value.trim(); if (!n) return; C().lists.unshift({ id: "l" + uid(), title: n.slice(0, 80), items: HC.CHECKLISTS["Short video"].slice(), checked: [] }); save(); rerender(); break; }
      case "listDel": C().lists = C().lists.filter((x) => x.id !== id); save(); rerender(); break;
      case "capCopy": if (await copy(($("cpText") || {}).value || "")) flashMsg("cpNote", "Copied.", false); break;
      case "tagsRule": { syncCap(); ui.tags = HC.ruleHashtags(ui.cap.topic || ui.cap.text); ui.caps = null; rerender(); break; }
      case "tagAdd": { syncCap(); ui.cap.text = (ui.cap.text + " " + t.dataset.tag).trim(); rerender(); break; }
      case "capUse": { syncCap(); ui.cap.text = t.dataset.text; rerender(); break; }
      case "capAI": {
        syncCap(); if (!ui.cap.topic.trim()) { ui.ai = { busy: false, err: "Say what the post is about first.", text: "" }; rerender(); return; }
        const askFn = ui.askOverride || (window.study && window.study.ask); // askOverride: test seam (the preload bridge is read-only)
        if (!askFn) { ui.ai = { busy: false, err: "The assistant is not available in this window.", text: "" }; rerender(); return; }
        ui.ai = { busy: true, err: "", text: "" }; ui.tags = null; rerender();
        const r = await askFn(HC.captionPrompt({ topic: ui.cap.topic, tone: ui.cap.tone, platform: ui.cap.platform, count: 3 }));
        ui.ai = { busy: false, err: r && r.success ? "" : (r && r.error) || "The assistant did not answer.", text: r && r.success ? r.text : "" };
        ui.caps = r && r.success ? HC.parseCaptions(r.text) : null; if (r && r.success && !ui.caps.length) ui.ai.err = "The assistant's answer had no usable captions. Try again.";
        rerender(); break;
      }
      case "accAdd": { const n = $("acName").value.trim(); if (!n) { alert("Give the account a name."); return; } const sel = $("acSite"); C().accounts.push({ id: "a" + uid(), name: n.slice(0, 40), site: sel.value, siteName: sel.options[sel.selectedIndex].text }); save(); rerender(); break; }
      case "accOpen": { const a = findIn(C().accounts, id); if (a) { try { createNewTab(a.site, { partition: "persist:acct-" + a.id }); } catch (_) { /* no tab */ } } break; }
      case "accDel": C().accounts = C().accounts.filter((x) => x.id !== id); save(); rerender(); break;

      case "useColour": { const hex = t.dataset.hex; if (window.JonahThemeHost) JonahThemeHost.setAll(hex); rerender(); break; }
      case "copyColour": if (await copy(t.dataset.hex.toUpperCase())) { t.querySelector("span").textContent = "copied"; setTimeout(() => { const s = t.querySelector("span"); if (s) s.textContent = t.dataset.hex.toUpperCase(); }, 900); } break;
      case "boardPick": ui.boardId = id; ui.pageImgs = null; rerender(); break;
      case "boardNew": ui.newBoard = true; rerender(); { const i = $("bdNewName"); if (i) i.focus(); } break;
      case "boardCreate": { const n = $("bdNewName").value.trim(); if (!n) return; const b = { id: "b" + uid(), name: n.slice(0, 40), images: [] }; S.aesthetic.boards.push(b); ui.boardId = b.id; ui.newBoard = false; save(); rerender(); break; }
      case "boardCancel": ui.newBoard = false; rerender(); break;
      case "boardDel": { const b = findIn(S.aesthetic.boards, id); if (b && S.aesthetic.boards.length > 1 && confirm(`Delete the board "${b.name}" and its ${b.images.length} pictures?`)) { for (const im of b.images) idb.del(im).catch(() => {}); S.aesthetic.boards = S.aesthetic.boards.filter((x) => x.id !== id); ui.boardId = S.aesthetic.boards[0].id; save(); rerender(); } break; }
      case "boardUrl": { const u = $("bdUrl").value.trim(); if (!u) return; flashMsg("bdMsg", "Downloading..."); try { await addFromUrl(u); rerender(); } catch (err) { flashMsg("bdMsg", err.message, true); } break; }
      case "boardPage": {
        const wv = activeView(); if (!wv) return flashMsg("bdMsg", "No page is open.", true);
        try { ui.pageImgs = (await wv.executeJavaScript("[...document.images].filter(i => i.naturalWidth >= 200 && i.naturalHeight >= 150 && /^https:/.test(i.currentSrc || i.src)).map(i => i.currentSrc || i.src).filter((u, i, a) => a.indexOf(u) === i).slice(0, 24)")) || []; } catch (_) { ui.pageImgs = []; }
        rerender(); break;
      }
      case "boardPageAdd": { const u = ui.pageImgs && ui.pageImgs[Number(t.dataset.i)]; if (!u) return; t.style.opacity = ".4"; try { await addFromUrl(u); ui.pageImgs.splice(Number(t.dataset.i), 1); rerender(); } catch (err) { t.style.opacity = "1"; flashMsg("bdMsg", err.message, true); } break; }
      case "imgDel": { e.stopPropagation(); const b = board(); b.images = b.images.filter((x) => x !== id); idb.del(id).catch(() => {}); save(); rerender(); break; }
      case "imgPalette": { ui.tab.aesthetic = "palette"; ui.palette = { busy: true }; rerender(); try { ui.palette = { colours: (await paletteFor(id, ui.palK || 6)) || [], from: id }; } catch (_) { ui.palette = { err: "Could not read that picture." }; } rerender(); break; }
      case "palCopy": if (ui.palette && ui.palette.colours && await copy(HC.paletteText(ui.palette.colours))) flashMsg("plMsg", "Copied all codes.", false); break;
      case "palCard": if (ui.palette && ui.palette.colours) { const cv = drawPaletteCard(ui.palette.colours); cv.toBlob((blob) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "jonah-palette.png"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }); } break;
    }
  }
  function syncCap() { const g = (id) => { const e = document.getElementById(id); return e ? e.value : undefined; }; ui.cap = { platform: g("cpPlatform") ?? (ui.cap || {}).platform ?? "Instagram", text: g("cpText") ?? (ui.cap || {}).text ?? "", topic: g("cpTopic") ?? (ui.cap || {}).topic ?? "", tone: g("cpTone") ?? (ui.cap || {}).tone ?? "friendly" }; }

  function onChange(e) {
    const t = e.target;
    if (t.dataset.cfg) {
      const k = t.dataset.cfg;
      if (k === "rest") { const d = Number(t.dataset.d); const set = new Set(C().cfg.restDays); t.checked ? set.add(d) : set.delete(d); C().cfg.restDays = [...set]; save(); rerender(); return; }
      if (k === "capacity") { C().cfg.capacity = Math.min(100, Math.max(1, Number(t.value) || 25)); save(); rerender(); return; }
      if (k === "budgetMin" || k === "breakEvery") { S.game[k] = Math.min(1440, Math.max(0, Math.round(Number(t.value)) || 0)); save(); sess.overNag = false; rerender(); return; }
      if (k.startsWith("give.")) { setPath(k, t.value); cache.giveaways = null; loadFree(); return; }
      if (k.startsWith("deals.")) { setPath(k, k === "deals.upper" ? Number(t.value) : t.value); cache.deals = null; loadDeals(); return; }
    }
    if (t.dataset.act === "listCheck") { const l = findIn(C().lists, t.dataset.id); if (l) { const i = Number(t.dataset.i), at = l.checked.indexOf(i); if (t.checked && at < 0) l.checked.push(i); else if (!t.checked && at >= 0) l.checked.splice(at, 1); save(); rerender(); } return; }
    if (t.id === "cpPlatform") { syncCap(); rerender(); return; }
    if (t.id === "bdFiles") { const files = [...t.files].slice(0, 20); (async () => { let n = 0; for (const f of files) { try { await addImageBlob(f); n++; } catch (_) { /* not a readable picture */ } } rerender(); flashMsg("bdMsg", n ? `Added ${n} picture${n === 1 ? "" : "s"}.` : "None of those could be read as pictures.", !n); })(); return; }
    if (t.id === "plFile") { const f = t.files[0]; if (!f) return; ui.palette = { busy: true }; rerender(); (async () => { try { const id = await addImageBlob(f); ui.palette = { colours: (await paletteFor(id, ui.palK || 6)) || [], from: id }; } catch (_) { ui.palette = { err: "That file could not be read as a picture." }; } rerender(); })(); return; }
    if (t.id === "plK") { ui.palK = Number(t.value); if (ui.palette && ui.palette.from) { (async () => { ui.palette = { colours: (await paletteFor(ui.palette.from, ui.palK)) || [], from: ui.palette.from }; rerender(); })(); } }
  }
  function onInput(e) {
    const t = e.target;
    if (t.id === "cpText") { const chk = HC.captionCheck(t.value, (document.getElementById("cpPlatform") || {}).value || "Instagram"); const c = document.getElementById("cpCount"); if (c) { c.textContent = `${chk.count} / ${chk.limit}`; c.className = "hb-pill " + (chk.over ? "bad" : chk.near ? "warn" : "ok"); } const g = document.getElementById("cpTags"); if (g) g.textContent = `${chk.tags} hashtags`; }
    if (t.id === "idSearch") { ui.ideaQ = t.value; const pos = t.selectionStart; rerender(); const n = document.getElementById("idSearch"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
  }
  async function onPaste(e) {
    if (ui.hub !== "aesthetic" || ui.tab.aesthetic !== "boards") return;
    const item = [...(e.clipboardData && e.clipboardData.items || [])].find((i) => i.type.startsWith("image/")); if (!item) return;
    e.preventDefault(); try { await addImageBlob(item.getAsFile()); rerender(); flashMsg("bdMsg", "Added the pasted picture.", false); } catch (_) { flashMsg("bdMsg", "Could not read that picture.", true); }
  }
  document.addEventListener("keydown", (e) => {
    if (!panelEl()) return;
    if (e.key === "Enter" && e.target && e.target.id === "idText") { e.preventDefault(); const b = panelEl().querySelector('[data-act="ideaAdd"]'); if (b) b.click(); }
    if (e.key === "Enter" && e.target && e.target.id === "dlTitle") { e.preventDefault(); const b = panelEl().querySelector('[data-act="dealSearch"]'); if (b) b.click(); }
    if (e.key === "Enter" && e.target && e.target.id === "bdNewName") { e.preventDefault(); const b = panelEl().querySelector('[data-act="boardCreate"]'); if (b) b.click(); }
    if (e.key === "Enter" && e.target && e.target.id === "wdTarget") { e.preventDefault(); const b = panelEl().querySelector('[data-act="watchSave"]'); if (b) b.click(); }
    if (e.key === "Enter" && e.target && e.target.id === "bdUrl") { e.preventDefault(); const b = panelEl().querySelector('[data-act="boardUrl"]'); if (b) b.click(); }
  });
  // right-click a content chip = delete it
  document.addEventListener("contextmenu", (e) => { const c = e.target.closest && e.target.closest(".hb-chip[data-act='advance']"); if (!c || !panelEl()) return; e.preventDefault(); if (confirm("Delete this planned item?")) { C().items = C().items.filter((x) => x.id !== c.dataset.id); save(); rerender(); } });

  window.HubUI = { state: () => S, reset: () => { S = defaults(); save(); }, ui, cache, sess, HUBS, rerender, loadFree, loadDeals, sessionStart, sessionStop, pollVitals, vit, board, paletteFor, addImageBlob };
})();
