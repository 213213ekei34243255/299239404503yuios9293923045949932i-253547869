// study-ui.js - the Study Hub panel (Today / Timetable / Deadlines / Focus / Cards / Routines / AI Tutor) behind the book icon.
// The logic lives in study-core.js (unit-tested, no DOM); this file is the screen, the saved data (localStorage "jonahStudy"), the timer and the AI calls.
// Needs from index.html: createToolPanel(), tabData / activeTabIndex (to read the page), and from preload: window.study.ask (one question to the chat model)
// and window.api.startPomodoro / stopPomodoro (Jonah's own Focus Mode, which blocks distracting sites while a focus block runs).
(function () {
  "use strict";
  const SC = window.StudyCore;
  if (!SC) return;
  const { esc } = SC;
  const KEY = "jonahStudy";
  const TABS = [["today", "Today"], ["timetable", "Timetable"], ["deadlines", "Deadlines"], ["focus", "Focus"], ["cards", "Cards"], ["routines", "Routines"], ["ai", "AI Tutor"]];

  // ------------------------------------------------------------------ saved data
  const defaults = () => ({ classes: [], deadlines: [], cards: [], routines: [], days: {}, timerCfg: { ...SC.DEFAULT_TIMER }, blockSites: true, level: "high-school", socratic: false });
  let state = load();
  function load() {
    try { return Object.assign(defaults(), JSON.parse(localStorage.getItem(KEY) || "null") || {}); } catch (_) { return defaults(); }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* storage unavailable: it just won't persist */ } }
  const uid = () => Math.random().toString(36).slice(2, 10);
  const todayKey = () => SC.dateKey(new Date());
  function bump(field, n) {
    const k = todayKey();
    const d = (state.days[k] = state.days[k] || { focusMin: 0, cards: 0, routines: 0, sessions: 0 });
    d[field] = (d[field] || 0) + n;
    save();
  }
  const dayStat = () => state.days[todayKey()] || { focusMin: 0, cards: 0, routines: 0, sessions: 0 };
  const hue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  const subjColor = (s) => `hsl(${hue(String(s).toLowerCase())} 70% 58%)`;

  // ------------------------------------------------------------------ styles (injected once)
  function injectStyles() {
    if (document.getElementById("studyHubStyles")) return;
    const st = document.createElement("style");
    st.id = "studyHubStyles";
    st.textContent = `
    .jonah-tool-panel.wide.xwide { width: 700px; max-width: calc(100vw - 40px); }
    .sh-tabs { display:flex; gap:4px; padding:10px 14px 0; flex-wrap:wrap; border-bottom:1px solid rgba(255,255,255,0.1); }
    .sh-tab { padding:7px 12px; border-radius:9px 9px 0 0; background:rgba(255,255,255,0.05); color:#cfcfe8; font-size:12px; cursor:pointer; user-select:none; transition:.15s; border:none; }
    .sh-tab:hover { background:rgba(255,255,255,0.12); color:#fff; }
    .sh-tab.active { background:linear-gradient(180deg, rgba(255,105,180,0.45), rgba(255,105,180,0.18)); color:#fff; font-weight:bold; box-shadow:inset 0 2px 0 #00eaff; }
    .sh-card { background:rgba(0,0,0,0.28); border:1px solid rgba(255,255,255,0.1); border-radius:12px; padding:12px 14px; margin-bottom:10px; }
    .sh-card h4 { margin:0 0 8px; font-size:11px; letter-spacing:1.2px; text-transform:uppercase; color:#ff9ad1; font-weight:bold; }
    .sh-hero { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px; flex-wrap:wrap; }
    .sh-hero .hi { font-size:20px; font-weight:bold; background:linear-gradient(90deg,#fff,#00eaff 60%,#ff69b4); -webkit-background-clip:text; background-clip:text; color:transparent; }
    .sh-hero .sub { font-size:12px; color:#b8b8d8; margin-top:2px; }
    .sh-pill { display:inline-block; padding:3px 10px; border-radius:999px; font-size:11px; background:rgba(255,255,255,0.1); color:#fff; white-space:nowrap; }
    .sh-pill.hot { background:linear-gradient(90deg,#ff6a3d,#ff69b4); font-weight:bold; }
    .sh-pill.good { background:rgba(80,220,140,0.28); color:#aaffd0; }
    .sh-pill.warn { background:rgba(255,190,60,0.28); color:#ffe2a0; }
    .sh-pill.bad { background:rgba(255,80,100,0.3); color:#ffc0c8; }
    .sh-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .sh-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    @media (max-width:640px) { .sh-grid2 { grid-template-columns:1fr; } }
    .sh-bar { height:8px; border-radius:6px; background:rgba(255,255,255,0.12); overflow:hidden; }
    .sh-bar > i { display:block; height:100%; background:linear-gradient(90deg,#00eaff,#ff69b4); border-radius:6px; transition:width .4s; }
    .sh-week { display:flex; gap:6px; align-items:flex-end; height:70px; }
    .sh-week .col { flex:1; text-align:center; font-size:10px; color:#b8b8d8; }
    .sh-week .col i { display:block; width:100%; background:linear-gradient(180deg,#00eaff,#ff69b4); border-radius:5px 5px 0 0; min-height:2px; transition:height .4s; }
    .sh-muted { color:#b8b8d8; font-size:12px; }
    .sh-empty { color:#b8b8d8; font-size:12px; padding:6px 0; }
    .sh-list-item { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:8px; background:rgba(255,255,255,0.05); margin-bottom:5px; font-size:13px; }
    .sh-list-item .grow { flex:1; min-width:0; }
    .sh-list-item .t { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .sh-list-item.done .t { text-decoration:line-through; opacity:.5; }
    .sh-dot { width:10px; height:10px; border-radius:50%; flex:none; }
    .sh-x { cursor:pointer; opacity:.55; padding:0 4px; } .sh-x:hover { opacity:1; color:#ff69b4; }
    .sh-field { display:flex; flex-direction:column; gap:3px; font-size:11px; color:#cfcfe8; }
    .sh-field input, .sh-field select { min-width:0; }
    .sh-days { display:flex; gap:4px; flex-wrap:wrap; }
    .sh-days label { padding:4px 8px; border-radius:7px; background:rgba(255,255,255,0.08); font-size:12px; cursor:pointer; user-select:none; }
    .sh-days input { display:none; } .sh-days input:checked + span { color:#00eaff; font-weight:bold; }
    .sh-days label:has(input:checked) { background:rgba(0,234,255,0.2); outline:1px solid rgba(0,234,255,0.5); }
    .sh-tt { display:grid; grid-template-columns:34px repeat(7,1fr); gap:2px; font-size:10px; }
    .sh-tt .dh { text-align:center; padding:4px 0; color:#cfcfe8; font-weight:bold; }
    .sh-tt .dh.today { color:#00eaff; }
    .sh-tt .hours { position:relative; } .sh-tt .hours span { position:absolute; right:3px; transform:translateY(-50%); color:#8d8db0; }
    .sh-tt .dcol { position:relative; background:repeating-linear-gradient(to bottom, rgba(255,255,255,0.06) 0, rgba(255,255,255,0.06) 1px, transparent 1px, transparent var(--hh)); border-radius:6px; }
    .sh-tt .dcol.today { background-color:rgba(0,234,255,0.07); }
    .sh-tt .blk { position:absolute; left:2px; right:2px; border-radius:6px; padding:2px 4px; overflow:hidden; color:#111; font-weight:bold; line-height:1.15; box-shadow:0 1px 4px rgba(0,0,0,.4); cursor:default; }
    .sh-tt .blk small { display:block; font-weight:normal; opacity:.8; }
    .sh-tt .nowline { position:absolute; left:0; right:0; height:2px; background:#ff4d6d; box-shadow:0 0 6px #ff4d6d; }
    .sh-ring { position:relative; width:190px; height:190px; margin:6px auto; }
    .sh-ring svg { transform:rotate(-90deg); }
    .sh-ring .mid { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; }
    .sh-ring .clock { font-size:38px; font-weight:bold; font-variant-numeric:tabular-nums; }
    .sh-ring .ph { font-size:12px; letter-spacing:2px; text-transform:uppercase; color:#ff9ad1; }
    .sh-flash { min-height:140px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; font-size:17px; padding:18px; border-radius:14px; background:linear-gradient(135deg, rgba(255,105,180,0.22), rgba(0,234,255,0.14)); border:1px solid rgba(255,255,255,0.18); cursor:pointer; white-space:pre-wrap; }
    .sh-flash .hint { font-size:11px; color:#b8b8d8; margin-top:10px; }
    .sh-grade { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin-top:8px; }
    .sh-grade button { display:flex; flex-direction:column; align-items:center; gap:2px; padding:8px 4px; }
    .sh-grade button small { opacity:.75; font-size:10px; }
    .sh-ai-out { white-space:normal; font-size:13px; line-height:1.55; background:rgba(0,0,0,0.3); border-radius:10px; padding:12px; margin-top:8px; max-height:340px; overflow-y:auto; }
    .sh-ai-out ul { margin:4px 0 4px 18px; padding:0; } .sh-ai-out p { margin:0 0 8px; }
    .sh-think { display:inline-flex; gap:4px; } .sh-think i { width:7px; height:7px; border-radius:50%; background:#00eaff; animation:shBounce 1s infinite ease-in-out; } .sh-think i:nth-child(2){animation-delay:.15s} .sh-think i:nth-child(3){animation-delay:.3s}
    @keyframes shBounce { 0%,80%,100% { transform:scale(.5); opacity:.4 } 40% { transform:scale(1); opacity:1 } }
    .sh-switch { display:flex; align-items:center; gap:8px; font-size:12px; cursor:pointer; user-select:none; }
    .jonah-tool-panel button.jtp-btn.ghost { background:rgba(255,255,255,0.1); }
    .jonah-tool-panel button.jtp-btn.big { padding:9px 16px; font-size:14px; font-weight:bold; }
    .jonah-tool-panel button.jtp-btn:disabled { opacity:.45; cursor:default; transform:none; box-shadow:none; }
    #studyTimerChip { position:fixed; left:18px; bottom:18px; z-index:999999; background:rgba(30,14,36,0.92); color:#fff; border:1px solid rgba(0,234,255,0.5); border-radius:999px; padding:8px 14px; font:bold 13px Arial,sans-serif; cursor:pointer; box-shadow:0 0 14px rgba(0,234,255,0.35); backdrop-filter:blur(8px); }
    #studyTimerChip b { font-variant-numeric:tabular-nums; color:#00eaff; }
    `;
    document.head.appendChild(st);
  }

  // ------------------------------------------------------------------ AI + page access
  async function getPage() {
    try {
      const tab = typeof tabData !== "undefined" && tabData[activeTabIndex];
      const wv = tab && tab.webview;
      if (!wv) return null;
      const d = await wv.executeJavaScript("({ title: document.title, url: location.href, text: (document.body && document.body.innerText) || '' })");
      return d && /^https?:/.test(d.url) && d.text && d.text.trim().length > 60 ? d : null;
    } catch (_) { return null; }
  }
  async function askAI(kind, ctx) {
    const ask = hub.askOverride || (window.study && window.study.ask);
    if (!ask) return { ok: false, error: "The assistant is not available in this window." };
    const req = SC.buildRequest(kind, ctx);
    const r = await ask(req.message, req.pageContent);
    return r && r.success ? { ok: true, text: r.text } : { ok: false, error: (r && r.error) || "The assistant did not answer." };
  }
  function md(text) {
    const lines = esc(text).split(/\r?\n/);
    let html = "", list = false;
    const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
    for (const raw of lines) {
      const b = /^\s*(?:[-*•])\s+(.*)$/.exec(raw);
      if (b) { if (!list) { html += "<ul>"; list = true; } html += `<li>${inline(b[1])}</li>`; continue; }
      if (list) { html += "</ul>"; list = false; }
      if (raw.trim()) html += `<p>${inline(raw.replace(/^#+\s*/, "<b>") + (/^#+\s*/.test(raw) ? "</b>" : ""))}</p>`;
    }
    return html + (list ? "</ul>" : "");
  }

  // ------------------------------------------------------------------ the focus timer (module level: it keeps running with the panel closed)
  const timer = { phase: "focus", running: false, endAt: 0, remaining: SC.phaseSeconds("focus", state.timerCfg), handle: null, task: "" };
  const block = (on, minutes) => { try { if (state.blockSites && window.api) Promise.resolve(on ? window.api.startPomodoro(minutes) : window.api.stopPomodoro()).catch(() => {}); } catch (_) { /* Focus Mode unavailable */ } };
  function timerStart() {
    if (timer.running) return;
    timer.endAt = Date.now() + timer.remaining * 1000;
    timer.running = true;
    if (timer.phase === "focus") block(true, Math.ceil(timer.remaining / 60));
    timer.handle = setInterval(timerTick, 500);
    timerTick();
  }
  function timerPause() {
    if (!timer.running) return;
    timer.remaining = Math.max(1, Math.ceil((timer.endAt - Date.now()) / 1000));
    timer.running = false;
    clearInterval(timer.handle);
    block(false);
    timerPaint();
  }
  function timerReset() {
    timerPause();
    timer.remaining = SC.phaseSeconds(timer.phase, state.timerCfg);
    timerPaint();
  }
  function timerSkip() { timerPause(); timerFinish(false); }
  function timerFinish(completed) {
    clearInterval(timer.handle);
    timer.running = false;
    block(false);
    if (timer.phase === "focus" && completed) { bump("focusMin", state.timerCfg.focus); bump("sessions", 1); }
    if (completed) { beep(); notify(timer.phase === "focus" ? "Focus block done - take a break" : "Break over - ready for the next focus block"); }
    timer.phase = SC.nextPhase(timer.phase, dayStat().sessions || 0, state.timerCfg);
    timer.remaining = SC.phaseSeconds(timer.phase, state.timerCfg);
    timerPaint();
    if (hub.open) paintHubIfTab("focus");
  }
  function timerTick() {
    if (!timer.running) return;
    const left = (timer.endAt - Date.now()) / 1000;
    if (left <= 0) { timerFinish(true); return; }
    timer.remaining = left;
    timerPaint();
  }
  function beep() { try { const ac = new (window.AudioContext || window.webkitAudioContext)(); [0, 0.25].forEach((t) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(ac.destination); o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.18); }); } catch (_) { /* no audio */ } }
  function notify(msg) { try { new Notification("Jonah Study", { body: msg }); } catch (_) { /* notifications unavailable */ } }
  const PHASE_LABEL = { focus: "Focus", short: "Short break", long: "Long break" };
  function timerPaint() {
    const total = SC.phaseSeconds(timer.phase, state.timerCfg);
    const secs = timer.running ? Math.max(0, (timer.endAt - Date.now()) / 1000) : timer.remaining;
    const clock = SC.fmtClock(secs);
    const el = document.getElementById("stClock"); if (el) el.textContent = clock;
    const ring = document.getElementById("stRing"); if (ring) ring.setAttribute("stroke-dashoffset", String(339.29 * (1 - Math.min(1, secs / total))));
    const ph = document.getElementById("stPhase"); if (ph) ph.textContent = PHASE_LABEL[timer.phase];
    let chip = document.getElementById("studyTimerChip");
    if (timer.running && !document.getElementById("jonah-tool-study")) {
      if (!chip) { chip = document.createElement("div"); chip.id = "studyTimerChip"; chip.title = "Open the focus timer"; chip.onclick = () => openStudyHub("focus"); document.body.appendChild(chip); }
      chip.innerHTML = `${esc(PHASE_LABEL[timer.phase])} <b>${clock}</b>`;
    } else if (chip) chip.remove();
  }

  // ------------------------------------------------------------------ the hub
  const hub = { askOverride: null, /* test seam: the preload bridge is read-only, so tests replace the model here */ open: false, tab: "today", review: null, pendingTT: [], ttUnread: [], sessions: null, ai: { busy: false, kind: "", text: "", err: "", lastQuiz: "" } };
  const panelEl = () => document.getElementById("jonah-tool-study");
  const bodyEl = () => panelEl() && panelEl().querySelector(".jtp-body");

  function openStudyHub(tab) {
    injectStyles();
    if (tab) hub.tab = tab;
    hub.open = true;
    const p = createToolPanel("study", "Study Hub", `<div id="shTabs"></div><div id="shBody"></div>`, { wide: true });
    p.classList.add("xwide");
    const body = p.querySelector(".jtp-body"); body.style.padding = "0";
    const close = p.querySelector(".jtp-close");
    if (close) close.addEventListener("click", () => { hub.open = false; setTimeout(timerPaint, 0); });
    p.addEventListener("click", onClick);
    p.addEventListener("change", onChange);
    p.addEventListener("input", onInput);
    paintHub();
    timerPaint();
  }
  function paintHubIfTab(t) { if (hub.open && panelEl() && hub.tab === t) paintHub(); }
  function paintHub() {
    const p = panelEl(); if (!p) { hub.open = false; return; }
    p.querySelector("#shTabs").innerHTML = `<div class="sh-tabs">${TABS.map(([id, label]) => `<button class="sh-tab${hub.tab === id ? " active" : ""}" data-act="tab" data-v="${id}">${label}</button>`).join("")}</div>`;
    const view = { today: viewToday, timetable: viewTimetable, deadlines: viewDeadlines, focus: viewFocus, cards: viewCards, routines: viewRoutines, ai: viewAI }[hub.tab];
    p.querySelector("#shBody").innerHTML = `<div style="padding:12px 14px">${view()}</div>`;
    timerPaint();
  }

  // ---- Today
  function viewToday() {
    const now = new Date();
    const hr = now.getHours();
    const greet = hr < 5 ? "Still up?" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
    const sk = SC.streak(state.days, now);
    const nn = SC.nowNext(state.classes, now);
    const st = dayStat();
    let classCard;
    if (!state.classes.length) classCard = `<div class="sh-empty">No timetable yet. <a href="#" data-act="tab" data-v="timetable" style="color:#00eaff">Add your classes</a> and this shows what is on now and next.</div>`;
    else if (nn.now) {
      const len = nn.now.end - nn.now.start, done = len - nn.minutesLeft;
      classCard = `<div class="sh-row"><span class="sh-dot" style="background:${subjColor(nn.now.subject)}"></span><b>${esc(nn.now.subject)}</b><span class="sh-muted">${SC.fmtTime(nn.now.start)}–${SC.fmtTime(nn.now.end)}${nn.now.room ? " · " + esc(nn.now.room) : ""}</span><span class="sh-pill good" style="margin-left:auto">${SC.fmtDuration(nn.minutesLeft)} left</span></div><div class="sh-bar" style="margin-top:8px"><i style="width:${Math.round(done / len * 100)}%"></i></div>${nn.next ? `<div class="sh-muted" style="margin-top:6px">Then ${esc(nn.next.subject)} at ${SC.fmtTime(nn.next.start)}</div>` : ""}`;
    } else if (nn.next) classCard = `<div class="sh-row"><span class="sh-dot" style="background:${subjColor(nn.next.subject)}"></span><span>Next: <b>${esc(nn.next.subject)}</b> at ${SC.fmtTime(nn.next.start)}${nn.next.room ? " · " + esc(nn.next.room) : ""}</span><span class="sh-pill" style="margin-left:auto">in ${SC.fmtDuration(nn.minutesToNext)}</span></div><div class="sh-muted" style="margin-top:6px">A free window - good time for a focus block.</div>`;
    else classCard = `<div class="sh-empty">${SC.classesOn(state.classes, SC.dayIndexOf(now)).length ? "That is all your classes for today." : "No classes today."}</div>`;

    const open = state.deadlines.filter((d) => !d.done).sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
    const due = open.slice(0, 4).map((d) => { const c = SC.countdown(d.due, now); return `<div class="sh-list-item"><span class="sh-dot" style="background:${subjColor(d.subject || d.title)}"></span><div class="grow t">${esc(d.title)}</div><span class="sh-pill ${c.level === "overdue" ? "bad" : c.level === "today" ? "warn" : ""}">${esc(c.label)}</span></div>`; }).join("") || `<div class="sh-empty">Nothing due. Enjoy it - or add upcoming work in Deadlines.</div>`;

    // is the week realistic? the same planner as the Deadlines tab, over the work due in the next 7 days
    const week = open.filter((d) => Date.parse(d.due) - now.getTime() < 7 * 86400000);
    const plan = SC.suggestSessions(week, state.classes, now);
    const unplacedMin = plan.unplaced.reduce((n, u) => n + u.minutes, 0);
    const feas = !week.length ? `<span class="sh-pill">No deadlines this week</span>` : unplacedMin ? `<span class="sh-pill bad">${SC.fmtDuration(unplacedMin)} will not fit before the deadlines</span>` : `<span class="sh-pill good">✓ This week fits around your classes</span>`;

    const bars = SC.weekBars(state.days, now);
    const maxF = Math.max(30, ...bars.map((b) => b.focusMin));
    const dueCards = SC.deckStats(state.cards, now).due;
    const rt = state.routines.map((r) => SC.routineToday(r, todayKey()));
    const rtDone = rt.filter((r) => r.complete).length;
    return `
      <div class="sh-hero"><div><div class="hi">${greet}</div><div class="sub">${now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</div></div>
        <div class="sh-row">${sk ? `<span class="sh-pill hot">${sk}-day streak</span>` : `<span class="sh-pill" title="A day counts with 10 focus minutes, 10 cards, or a finished routine">Start a streak today</span>`}<span class="sh-pill">${st.focusMin || 0} min focused</span></div></div>
      <div class="sh-card"><h4>Now &amp; next</h4>${classCard}</div>
      <div class="sh-grid2">
        <div class="sh-card"><h4>Due soon</h4>${due}<div style="margin-top:8px">${feas}</div></div>
        <div class="sh-card"><h4>This week · focus minutes</h4><div class="sh-week">${bars.map((b) => `<div class="col"><i style="height:${Math.round(b.focusMin / maxF * 56) + 2}px" title="${b.focusMin} min"></i>${b.label}</div>`).join("")}</div></div>
      </div>
      <div class="sh-grid2">
        <div class="sh-card"><h4>Flashcards</h4><div class="sh-row"><b style="font-size:22px">${dueCards}</b><span class="sh-muted">due now of ${state.cards.length}</span><button class="jtp-btn" style="margin-left:auto" data-act="tab" data-v="cards">${dueCards ? "Review" : "Open"}</button></div></div>
        <div class="sh-card"><h4>Routines</h4><div class="sh-row"><b style="font-size:22px">${rtDone}/${state.routines.length}</b><span class="sh-muted">done today</span><button class="jtp-btn" style="margin-left:auto" data-act="tab" data-v="routines">Open</button></div></div>
      </div>
      <div class="sh-row"><button class="jtp-btn big" data-act="tab" data-v="focus">Start a focus block</button><button class="jtp-btn ghost" data-act="aiPlan">Plan my week with AI</button></div>`;
  }

  // ---- Timetable
  function viewTimetable() {
    const now = new Date();
    const rangeStart = state.classes.length ? Math.floor(Math.min(...state.classes.map((c) => c.start)) / 60) * 60 : 8 * 60;
    const rangeEnd = state.classes.length ? Math.ceil(Math.max(...state.classes.map((c) => c.end)) / 60) * 60 : 16 * 60;
    const HH = 38, hours = (rangeEnd - rangeStart) / 60, today = SC.dayIndexOf(now), nowMin = now.getHours() * 60 + now.getMinutes();
    let grid = `<div class="sh-tt" style="--hh:${HH}px"><div></div>${SC.DAY_SHORT.map((d, i) => `<div class="dh${i === today ? " today" : ""}">${d}</div>`).join("")}<div class="hours" style="height:${hours * HH}px">${Array.from({ length: hours + 1 }, (_, i) => `<span style="top:${i * HH}px">${String(rangeStart / 60 + i).padStart(2, "0")}</span>`).join("")}</div>`;
    for (let d = 0; d < 7; d++) {
      grid += `<div class="dcol${d === today ? " today" : ""}" style="height:${hours * HH}px">${SC.classesOn(state.classes, d).map((c) => `<div class="blk" style="top:${(c.start - rangeStart) / 60 * HH}px;height:${Math.max(18, (c.end - c.start) / 60 * HH - 2)}px;background:${subjColor(c.subject)}" title="${esc(c.subject)} ${SC.fmtTime(c.start)}-${SC.fmtTime(c.end)}${c.room ? " @ " + esc(c.room) : ""}">${esc(c.subject)}<small>${SC.fmtTime(c.start)}${c.room ? " · " + esc(c.room) : ""}</small></div>`).join("")}${d === today && nowMin >= rangeStart && nowMin <= rangeEnd ? `<div class="nowline" style="top:${(nowMin - rangeStart) / 60 * HH}px"></div>` : ""}</div>`;
    }
    grid += "</div>";
    const list = state.classes.slice().sort((a, b) => a.day - b.day || a.start - b.start).map((c) => `<div class="sh-list-item"><span class="sh-dot" style="background:${subjColor(c.subject)}"></span><div class="grow t"><b>${esc(c.subject)}</b> <span class="sh-muted">${SC.DAY_NAMES[c.day]} ${SC.fmtTime(c.start)}–${SC.fmtTime(c.end)}${c.room ? " · " + esc(c.room) : ""}</span></div><span class="sh-x" data-act="delClass" data-id="${state.classes.indexOf(c)}" title="Remove">✕</span></div>`).join("");
    const rowHtml = (c) => `<div class="sh-list-item"><div class="grow t"><b>${esc(c.subject)}</b> <span class="sh-muted">${SC.DAY_NAMES[c.day]} ${SC.fmtTime(c.start)}–${SC.fmtTime(c.end)}${c.room ? " · " + esc(c.room) : ""}</span></div>${c.ai ? '<span class="sh-pill warn" title="Guessed by the AI - check it">AI guess</span>' : ""}</div>`;
    const pend = hub.pendingTT.length || hub.ttUnread.length ? `<div class="sh-card"><h4>${hub.pendingTT.length ? "Read " + hub.pendingTT.length + " classes - check them" : "Nothing could be read"}</h4>${hub.pendingTT.map(rowHtml).join("")}${hub.ttUnread.length ? `<div class="sh-muted" style="margin:8px 0 4px">Could not read ${hub.ttUnread.length} line${hub.ttUnread.length === 1 ? "" : "s"}:</div>${hub.ttUnread.slice(0, 6).map((l) => `<div class="sh-list-item"><div class="grow t">${esc(l)}</div></div>`).join("")}<div class="sh-row" style="margin-top:6px"><button class="jtp-btn ghost" data-act="ttAIUnread" ${hub.ai.busy ? "disabled" : ""}>Ask the AI to try those lines (it can be wrong)</button></div>` : ""}<div class="sh-row" style="margin-top:8px">${hub.pendingTT.length ? '<button class="jtp-btn" data-act="ttAcceptAI">Add these</button>' : ""}<button class="jtp-btn ghost" data-act="ttDiscardAI">Discard</button></div></div>` : "";
    return `
      <div class="sh-card"><h4>Quick add - type it like you would say it</h4>
        <div class="sh-row"><input id="ttQuick" placeholder="Mon/Wed 9:00-10:30 Maths @ Room 4" style="flex:1;min-width:200px"><button class="jtp-btn" data-act="ttQuickAdd">Add</button></div>
        <div id="ttQuickMsg" class="sh-muted" style="margin-top:6px">Days: Mon Tue Wed Thu Fri Sat Sun (several with / or ,). Times: 9, 9:30, 9am, 14:00.</div></div>
      <div class="sh-card"><h4>Or fill it in</h4>
        <div class="sh-days">${SC.DAY_SHORT.map((d, i) => `<label><input type="checkbox" class="ttDay" value="${i}"><span>${d}</span></label>`).join("")}</div>
        <div class="sh-row" style="margin-top:8px"><label class="sh-field">Start<input type="time" id="ttStart" value="09:00"></label><label class="sh-field">End<input type="time" id="ttEnd" value="10:00"></label><label class="sh-field" style="flex:1;min-width:120px">Subject<input id="ttSubj" placeholder="Maths"></label><label class="sh-field">Room<input id="ttRoom" placeholder="B2" style="width:80px"></label><button class="jtp-btn" style="align-self:flex-end" data-act="ttAdd">Add</button></div></div>
      <div class="sh-card"><h4>Paste a timetable</h4>
        <textarea id="ttPaste" rows="3" placeholder="Paste from your school portal, an email or a PDF...">${""}</textarea>
        <div class="sh-row" style="margin-top:6px"><button class="jtp-btn" data-act="ttRead">Read it</button><span id="ttAIMsg" class="sh-muted">Understands lines like "Monday: 9-10:30 Maths (Room 4), 11-12 English" or a day heading followed by times.</span></div></div>
      ${pend}
      <div class="sh-card"><h4>Your week</h4>${state.classes.length ? grid : `<div class="sh-empty">Add a class above and your week appears here.</div>`}</div>
      <div class="sh-card"><h4>All classes (${state.classes.length})</h4>${list || `<div class="sh-empty">None yet.</div>`}
        <div class="sh-row" style="margin-top:8px"><button class="jtp-btn ghost" data-act="exportICS">Export to calendar (.ics)</button>${state.classes.length ? `<button class="jtp-btn ghost" data-act="clearClasses">Clear timetable</button>` : ""}</div></div>`;
  }

  // ---- Deadlines
  const TYPE_ICON = { assignment: "", exam: "", quiz: "", project: "", reading: "" };
  function viewDeadlines() {
    const now = new Date();
    const g = SC.groupDeadlines(state.deadlines, now);
    const row = (d) => { const c = SC.countdown(d.due, now); return `<div class="sh-list-item${d.done ? " done" : ""}"><input type="checkbox" data-act="toggleDue" data-id="${d.id}" ${d.done ? "checked" : ""} style="width:auto"><span>${TYPE_ICON[d.type] || ""}</span><div class="grow"><div class="t">${esc(d.title)}</div><div class="sh-muted">${esc(d.subject || "")}${d.subject ? " · " : ""}${new Date(d.due).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · ~${d.hours || 1}h</div></div>${d.done ? "" : `<span class="sh-pill ${c.level === "overdue" ? "bad" : c.level === "today" ? "warn" : c.level === "soon" ? "" : ""}">${esc(c.label)}</span>`}<span class="sh-x" data-act="delDue" data-id="${d.id}">✕</span></div>`; };
    const sect = (title, arr) => arr.length ? `<div class="sh-card"><h4>${title} (${arr.length})</h4>${arr.map(row).join("")}</div>` : "";
    const defDue = new Date(Date.now() + 3 * 86400000); defDue.setHours(17, 0, 0, 0);
    const local = new Date(defDue.getTime() - defDue.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    let sessions = "";
    if (hub.sessions) {
      const by = {};
      hub.sessions.sessions.forEach((s) => (by[s.date] = by[s.date] || []).push(s));
      sessions = `<div class="sh-card"><h4>Suggested study sessions</h4>${Object.keys(by).sort().map((k) => `<div style="margin-bottom:8px"><b style="font-size:12px;color:#00eaff">${new Date(k + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}</b>${by[k].map((s) => `<div class="sh-list-item"><span class="sh-dot" style="background:${subjColor(s.subject || s.title)}"></span><div class="grow t">${SC.fmtTime(s.start)}–${SC.fmtTime(s.end)} · ${esc(s.title)}</div></div>`).join("")}</div>`).join("") || `<div class="sh-empty">Nothing to schedule.</div>`}${hub.sessions.unplaced.map((u) => `<div class="sh-pill bad" style="display:block;margin-top:6px;white-space:normal">"${esc(u.title)}": ${SC.fmtDuration(u.minutes)} will not fit in the free evening time before it is due - start earlier, shorten it, or ask for more time.</div>`).join("")}<div class="sh-muted" style="margin-top:6px">Evenings 17:00–21:00, around your classes, spread over the days left.</div></div>`;
    }
    return `
      <div class="sh-card"><h4>Add a deadline</h4>
        <div class="sh-row"><label class="sh-field" style="flex:2;min-width:160px">What<input id="ddTitle" placeholder="Chemistry lab report"></label><label class="sh-field">Subject<input id="ddSubj" placeholder="Chemistry" style="width:110px"></label><label class="sh-field">Type<select id="ddType">${Object.keys(TYPE_ICON).map((t) => `<option value="${t}">${t}</option>`).join("")}</select></label></div>
        <div class="sh-row" style="margin-top:8px"><label class="sh-field">Due<input type="datetime-local" id="ddDue" value="${local}"></label><label class="sh-field">Hours needed<input type="number" id="ddHours" value="2" min="0.5" max="40" step="0.5" style="width:80px"></label><button class="jtp-btn" style="align-self:flex-end" data-act="ddAdd">Add</button></div></div>
      ${state.deadlines.length ? `<div class="sh-row" style="margin-bottom:10px"><button class="jtp-btn big" data-act="suggest">Plan my study sessions</button><span class="sh-muted">fits the work around your classes</span></div>` : ""}
      ${sessions}
      ${sect("Overdue", g.overdue)}${sect("Today", g.today)}${sect("This week", g.week)}${sect("Later", g.later)}${sect("Done", g.done)}
      ${state.deadlines.length ? "" : `<div class="sh-empty">No deadlines yet. Add assignments, quizzes and exams - Jonah counts down and plans around them.</div>`}`;
  }

  // ---- Focus
  function viewFocus() {
    const cfg = state.timerCfg, st = dayStat();
    const total = SC.phaseSeconds(timer.phase, cfg), secs = timer.running ? Math.max(0, (timer.endAt - Date.now()) / 1000) : timer.remaining;
    return `
      <div class="sh-card" style="text-align:center">
        <div class="sh-ring"><svg width="190" height="190" viewBox="0 0 120 120"><circle cx="60" cy="60" r="54" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="8"/><circle id="stRing" cx="60" cy="60" r="54" fill="none" stroke="url(#shg)" stroke-width="8" stroke-linecap="round" stroke-dasharray="339.29" stroke-dashoffset="${339.29 * (1 - Math.min(1, secs / total))}"/><defs><linearGradient id="shg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00eaff"/><stop offset="1" stop-color="#ff69b4"/></linearGradient></defs></svg>
          <div class="mid"><div class="clock" id="stClock">${SC.fmtClock(secs)}</div><div class="ph" id="stPhase">${PHASE_LABEL[timer.phase]}</div></div></div>
        <div class="sh-row" style="justify-content:center;margin-top:4px">${timer.running ? `<button class="jtp-btn big" data-act="tPause">Pause</button>` : `<button class="jtp-btn big" data-act="tStart">${timer.phase === "focus" ? "Start focus" : "Start break"}</button>`}<button class="jtp-btn ghost" data-act="tReset">Reset</button><button class="jtp-btn ghost" data-act="tSkip">Skip</button></div>
        <div class="sh-muted" style="margin-top:8px">Today: <b>${st.sessions || 0}</b> focus block${(st.sessions || 0) === 1 ? "" : "s"} · <b>${st.focusMin || 0}</b> min. Every ${cfg.every}th block earns a long break.</div></div>
      <div class="sh-grid2">
        <div class="sh-card"><h4>Lengths (minutes)</h4><div class="sh-row">${[["focus", "Focus"], ["short", "Short"], ["long", "Long"]].map(([k, l]) => `<label class="sh-field">${l}<input type="number" min="1" max="120" data-cfg="${k}" value="${cfg[k]}" style="width:64px"></label>`).join("")}</div><div class="sh-muted" style="margin-top:6px">Changes apply to the next block.</div></div>
        <div class="sh-card"><h4>Stay on task</h4><label class="sh-switch"><input type="checkbox" data-act="blockSites" ${state.blockSites ? "checked" : ""} style="width:auto"> Block distracting sites during focus blocks</label><div class="sh-muted" style="margin-top:6px">Uses Jonah's Focus Mode list (Instagram, X, TikTok, YouTube by default - change it from the browser menu).</div></div>
      </div>`;
  }

  // ---- Cards
  function viewCards() {
    if (hub.review) return viewReview();
    const now = new Date(), s = SC.deckStats(state.cards, now);
    const list = state.cards.slice(0, 40).map((c) => `<div class="sh-list-item"><div class="grow"><div class="t"><b>${esc(c.front)}</b></div><div class="t sh-muted">${esc(c.back)}</div></div><span class="sh-pill">${c.reps ? SC.fmtInterval(c.interval) : "new"}</span><span class="sh-x" data-act="delCard" data-id="${c.id}">✕</span></div>`).join("");
    return `
      <div class="sh-card"><div class="sh-row"><div><div style="font-size:26px;font-weight:bold">${s.due}</div><div class="sh-muted">due now</div></div><div><div style="font-size:18px">${s.fresh}</div><div class="sh-muted">new</div></div><div><div style="font-size:18px">${s.learned}</div><div class="sh-muted">well known</div></div><div><div style="font-size:18px">${s.total}</div><div class="sh-muted">total</div></div><button class="jtp-btn big" style="margin-left:auto" data-act="reviewStart" ${s.due ? "" : "disabled"}>${s.due ? "Review " + s.due : "All caught up"}</button></div>
        <div class="sh-muted" style="margin-top:8px">Spaced repetition (SM-2, the Anki method): cards you know come back later and later; cards you miss come back soon.</div></div>
      <div class="sh-card"><h4>Make cards with AI</h4>
        <div class="sh-row"><input id="cdTopic" placeholder="Topic, e.g. photosynthesis" style="flex:1;min-width:160px"><select id="cdCount"><option>5</option><option selected>8</option><option>12</option></select><button class="jtp-btn" data-act="cardsAITopic" ${hub.ai.busy ? "disabled" : ""}>From topic</button><button class="jtp-btn" data-act="cardsAIPage" ${hub.ai.busy ? "disabled" : ""}>From this page</button></div><div id="cdMsg" class="sh-muted" style="margin-top:6px"></div></div>
      <div class="sh-card"><h4>Add one yourself</h4><div class="sh-row"><input id="cdFront" placeholder="Front (question)" style="flex:1;min-width:140px"><input id="cdBack" placeholder="Back (answer)" style="flex:1;min-width:140px"><button class="jtp-btn" data-act="cardAdd">Add</button></div></div>
      <div class="sh-card"><h4>Your cards${state.cards.length > 40 ? " (first 40)" : ""}</h4>${list || `<div class="sh-empty">No cards yet.</div>`}</div>`;
  }
  function startReview() {
    const now = Date.now();
    const q = state.cards.filter((c) => SC.isDue(c, now)).sort((a, b) => a.due - b.due).map((c) => c.id);
    hub.review = q.length ? { queue: q, revealed: false, done: 0, total: q.length, again: 0 } : null;
  }
  function viewReview() {
    const r = hub.review, card = state.cards.find((c) => c.id === r.queue[0]);
    if (!card) { hub.review = null; return `<div class="sh-card"><div class="sh-empty">Session finished.</div></div>`; }
    const prev = SC.previewIntervals(card, Date.now());
    return `
      <div class="sh-row" style="margin-bottom:8px"><button class="jtp-btn ghost" data-act="reviewStop">← Back</button><div class="sh-bar" style="flex:1"><i style="width:${Math.round(r.done / r.total * 100)}%"></i></div><span class="sh-muted">${r.done}/${r.total}</span></div>
      <div class="sh-flash" data-act="reveal"><div>${esc(card.front)}</div>${r.revealed ? `<hr style="width:60%;border:0;border-top:1px solid rgba(255,255,255,0.25);margin:14px 0"><div style="color:#9ff3ff">${esc(card.back)}</div>` : `<div class="hint">Think of the answer, then click (or press Space)</div>`}</div>
      ${r.revealed ? `<div class="sh-grade">${[["Again", 0], ["Hard", 1], ["Good", 2], ["Easy", 3]].map(([l, g]) => `<button class="jtp-btn" data-act="grade" data-g="${g}"><b>${l}</b><small>${prev[g]} · key ${g + 1}</small></button>`).join("")}</div>` : `<div class="sh-row" style="justify-content:center;margin-top:8px"><button class="jtp-btn big" data-act="reveal">Show answer</button></div>`}`;
  }
  function gradeCurrent(g) {
    const r = hub.review; if (!r) return;
    const i = state.cards.findIndex((c) => c.id === r.queue[0]); if (i < 0) return;
    state.cards[i] = SC.grade(state.cards[i], g, Date.now());
    bump("cards", 1);
    r.queue.shift();
    if (g === 0) { r.queue.push(state.cards[i].id); r.again++; } else r.done++; // a missed card comes round again this session
    r.revealed = false;
    save();
    if (!r.queue.length) hub.review = null;
    paintHub();
  }

  // ---- Routines
  function viewRoutines() {
    const tk = todayKey();
    const cards = state.routines.map((r) => {
      const t = SC.routineToday(r, tk);
      return `<div class="sh-card"><div class="sh-row"><b>${esc(r.name)}</b><span class="sh-pill ${t.complete ? "good" : ""}">${t.done}/${t.total}</span><span class="sh-x" style="margin-left:auto" data-act="delRoutine" data-id="${r.id}" title="Delete routine">✕</span></div>
        <div class="sh-bar" style="margin:8px 0"><i style="width:${t.total ? Math.round(t.done / t.total * 100) : 0}%"></i></div>
        ${r.items.map((it, i) => `<label class="sh-list-item${t.checked.includes(i) ? " done" : ""}" style="cursor:pointer"><input type="checkbox" data-act="rtCheck" data-id="${r.id}" data-i="${i}" ${t.checked.includes(i) ? "checked" : ""} style="width:auto"><span class="grow t">${esc(it)}</span></label>`).join("")}${t.complete ? `<div class="sh-muted" style="margin-top:4px">Done for today - that counts towards your streak.</div>` : ""}</div>`;
    }).join("");
    return `
      ${cards || `<div class="sh-card"><div class="sh-empty">No routines yet. Pick a starter below or build your own - they reset every morning.</div></div>`}
      <div class="sh-card"><h4>Starter routines</h4><div class="sh-row">${Object.keys(SC.ROUTINE_TEMPLATES).map((n) => `<button class="jtp-btn" data-act="rtTemplate" data-name="${esc(n)}">+ ${esc(n)}</button>`).join("")}</div></div>
      <div class="sh-card"><h4>Build your own</h4><input id="rtName" placeholder="Name, e.g. Sunday reset" style="width:100%;box-sizing:border-box;margin-bottom:6px"><textarea id="rtItems" rows="4" placeholder="One step per line"></textarea><div class="sh-row" style="margin-top:6px"><button class="jtp-btn" data-act="rtAdd">Create routine</button></div></div>`;
  }

  // ---- AI Tutor
  function viewAI() {
    const a = hub.ai;
    const out = a.busy ? `<div class="sh-ai-out"><span class="sh-think"><i></i><i></i><i></i></span> <span class="sh-muted">Thinking...</span></div>` : a.err ? `<div class="sh-ai-out" style="color:#ffc0c8">${esc(a.err)}</div>` : a.text ? `<div class="sh-ai-out">${md(a.text)}</div>` : "";
    return `
      <div class="sh-card"><div class="sh-row"><label class="sh-field">Explain at the level of<select id="aiLevel" data-act="level">${[["simple", "Simple (age 11-13)"], ["high-school", "High school"], ["university", "University"]].map(([v, l]) => `<option value="${v}" ${state.level === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label class="sh-switch" style="margin-left:auto" title="The tutor gives hints and questions instead of answers"><input type="checkbox" data-act="socratic" ${state.socratic ? "checked" : ""} style="width:auto"> <b>Study Mode</b> <span class="sh-muted">(hints, not answers)</span></label></div></div>
      <div class="sh-card"><h4>Work with the page you have open</h4>
        <div class="sh-row"><button class="jtp-btn" data-act="aiExplain" ${a.busy ? "disabled" : ""}>Explain it</button><button class="jtp-btn" data-act="aiNotes" ${a.busy ? "disabled" : ""}>Study notes</button><button class="jtp-btn" data-act="aiQuiz" ${a.busy ? "disabled" : ""}>Quiz me</button><button class="jtp-btn" data-act="aiPlan" ${a.busy ? "disabled" : ""}>Plan my week</button></div></div>
      <div class="sh-card"><h4>Ask anything</h4><textarea id="aiQuestion" rows="2" placeholder="${state.socratic ? "Study Mode is on: you will get a hint and a question back" : "Ask a question about what you are studying"}"></textarea><div class="sh-row" style="margin-top:6px"><label class="sh-switch"><input type="checkbox" id="aiUsePage" style="width:auto"> include the open page</label><button class="jtp-btn" style="margin-left:auto" data-act="aiAsk" ${a.busy ? "disabled" : ""}>Ask</button></div></div>
      ${out}
      ${a.text && !a.busy ? `<div class="sh-row" style="margin-top:8px"><button class="jtp-btn ghost" data-act="aiCopy">Copy</button><button class="jtp-btn ghost" data-act="aiToCards">Turn this into flashcards</button></div>` : ""}
      ${a.kind === "quiz" && a.text && !a.busy ? `<div class="sh-card" style="margin-top:10px"><h4>Your answers</h4><textarea id="aiAnswers" rows="4" placeholder="1. ...&#10;2. ..."></textarea><div class="sh-row" style="margin-top:6px"><button class="jtp-btn" data-act="aiMark">Mark my answers</button></div></div>` : ""}`;
  }
  async function runAI(kind, ctx, label) {
    const a = hub.ai;
    if (a.busy) return;
    a.busy = true; a.err = ""; a.kind = kind; paintHubIfTab("ai");
    if (hub.tab !== "ai") { hub.tab = "ai"; paintHub(); }
    const r = await askAI(kind, ctx);
    a.busy = false;
    if (r.ok) { a.text = kind === "ask" && ctx.socratic ? SC.firstQuestionOnly(r.text) : r.text; a.err = ""; if (kind === "quiz") a.lastQuiz = r.text; } else { a.err = r.error; a.text = ""; }
    paintHubIfTab("ai");
  }
  const needPage = async () => { const p = await getPage(); if (!p) { hub.ai.err = "Open a web page with some text on it first (the tutor reads the page in your current tab)."; hub.ai.text = ""; hub.tab = "ai"; paintHub(); } return p; };
  function planContext() {
    return { today: new Date().toDateString(), deadlines: state.deadlines.filter((d) => !d.done).map((d) => ({ title: d.title, subject: d.subject, due: d.due, hours: d.hours })), classes: state.classes };
  }

  // ------------------------------------------------------------------ events
  const $ = (id) => { const p = panelEl(); return p && p.querySelector("#" + id); };
  function flash(id, msg, bad) { const el = $(id); if (el) { el.textContent = msg; el.style.color = bad ? "#ffc0c8" : "#aaffd0"; } }

  async function onClick(e) {
    const t = e.target.closest("[data-act]");
    if (!t || t.tagName === "SELECT" || (t.tagName === "INPUT" && t.type === "checkbox")) return;
    if (t.tagName === "A") e.preventDefault();
    const act = t.dataset.act, id = t.dataset.id;
    switch (act) {
      case "tab": hub.tab = t.dataset.v; hub.review = null; paintHub(); break;
      case "ttQuickAdd": {
        const rows = SC.parseQuickLine($("ttQuick").value);
        if (!rows.length) return flash("ttQuickMsg", "Could not read that. Try: Mon/Wed 9:00-10:30 Maths @ Room 4", true);
        state.classes.push(...rows); save(); paintHub(); break;
      }
      case "ttAdd": {
        const days = [...panelEl().querySelectorAll(".ttDay:checked")].map((c) => Number(c.value));
        const s = SC.parseTime($("ttStart").value), en = SC.parseTime($("ttEnd").value), subj = $("ttSubj").value.trim();
        if (!days.length || s === null || en === null || en <= s || !subj) { alert("Pick at least one day, a start before the end, and a subject."); return; }
        days.forEach((d) => state.classes.push({ day: d, start: s, end: en, subject: subj.slice(0, 80), room: $("ttRoom").value.trim().slice(0, 40) }));
        save(); paintHub(); break;
      }
      case "delClass": state.classes.splice(Number(id), 1); save(); paintHub(); break;
      case "clearClasses": if (confirm("Remove every class from your timetable?")) { state.classes = []; save(); paintHub(); } break;
      case "exportICS": {
        const blob = new Blob([SC.toICS(state.classes, state.deadlines.filter((d) => !d.done), new Date())], { type: "text/calendar" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "jonah-study.ics"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        break;
      }
      case "ttRead": {
        const raw = $("ttPaste").value.trim(); if (!raw) return flash("ttAIMsg", "Paste your timetable text first.", true);
        const got = SC.parseTimetableText(raw);
        hub.pendingTT = got.rows; hub.ttUnread = got.unread;
        paintHub(); if (!got.rows.length && !got.unread.length) flash("ttAIMsg", "Nothing to read.", true);
        break;
      }
      case "ttAIUnread": {
        const raw = hub.ttUnread.join("\n"); if (!raw) return;
        hub.ai.busy = true; paintHub();
        const r = await askAI("timetable", { raw }); hub.ai.busy = false;
        if (!r.ok) { paintHub(); return flash("ttAIMsg", r.error, true); }
        const guessed = SC.parseTimetableReply(r.text).map((c) => ({ ...c, ai: true }));
        hub.pendingTT = hub.pendingTT.concat(guessed); if (guessed.length) hub.ttUnread = [];
        paintHub(); if (!guessed.length) flash("ttAIMsg", "The assistant could not find any classes in those lines.", true);
        break;
      }
      case "ttAcceptAI": state.classes.push(...hub.pendingTT.map(({ ai, ...c }) => c)); hub.pendingTT = []; hub.ttUnread = []; save(); paintHub(); break;
      case "ttDiscardAI": hub.pendingTT = []; hub.ttUnread = []; paintHub(); break;

      case "ddAdd": {
        const title = $("ddTitle").value.trim(), due = new Date($("ddDue").value);
        if (!title || Number.isNaN(due.getTime())) { alert("Give it a name and a due date."); return; }
        state.deadlines.push({ id: uid(), title: title.slice(0, 120), subject: $("ddSubj").value.trim().slice(0, 40), type: $("ddType").value, due: due.toISOString(), hours: Math.min(40, Math.max(0.5, Number($("ddHours").value) || 2)), done: false });
        hub.sessions = null; save(); paintHub(); break;
      }
      case "delDue": state.deadlines = state.deadlines.filter((d) => d.id !== id); hub.sessions = null; save(); paintHub(); break;
      case "suggest": hub.sessions = SC.suggestSessions(state.deadlines, state.classes, new Date()); paintHub(); break;

      case "tStart": timerStart(); paintHub(); break;
      case "tPause": timerPause(); paintHub(); break;
      case "tReset": timerReset(); paintHub(); break;
      case "tSkip": timerSkip(); paintHub(); break;

      case "reviewStart": startReview(); paintHub(); break;
      case "reviewStop": hub.review = null; paintHub(); break;
      case "reveal": if (hub.review && !hub.review.revealed) { hub.review.revealed = true; paintHub(); } break;
      case "grade": gradeCurrent(Number(t.dataset.g)); break;
      case "cardAdd": {
        const f = $("cdFront").value.trim(), b = $("cdBack").value.trim();
        if (!f || !b) { alert("A card needs a front and a back."); return; }
        state.cards.unshift(SC.newCard(f, b, Date.now())); save(); paintHub(); break;
      }
      case "delCard": state.cards = state.cards.filter((c) => c.id !== id); save(); paintHub(); break;
      case "cardsAITopic": {
        const topic = $("cdTopic").value.trim(); if (!topic) return flash("cdMsg", "Type a topic first.", true);
        hub.ai.busy = true; flash("cdMsg", "Writing cards...");
        const r = await askAI("flashcards", { topic, count: Number($("cdCount").value) }); hub.ai.busy = false;
        addCardsFromReply(r); break;
      }
      case "cardsAIPage": {
        const page = await getPage(); if (!page) return flash("cdMsg", "Open a web page with text on it first.", true);
        hub.ai.busy = true; flash("cdMsg", "Reading the page and writing cards...");
        const r = await askAI("flashcards", { page, count: Number($("cdCount").value) }); hub.ai.busy = false;
        addCardsFromReply(r); break;
      }

      case "rtTemplate": { const n = t.dataset.name; if (SC.ROUTINE_TEMPLATES[n]) { state.routines.push({ id: uid(), name: n, items: SC.ROUTINE_TEMPLATES[n].slice(), checked: [], day: todayKey(), credited: "" }); save(); paintHub(); } break; }
      case "rtAdd": {
        const name = $("rtName").value.trim(), items = $("rtItems").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
        if (!name || !items.length) { alert("Give the routine a name and at least one step."); return; }
        state.routines.push({ id: uid(), name: name.slice(0, 60), items: items.map((s) => s.slice(0, 120)), checked: [], day: todayKey(), credited: "" }); save(); paintHub(); break;
      }
      case "delRoutine": state.routines = state.routines.filter((r) => r.id !== id); save(); paintHub(); break;

      case "aiExplain": { const p = await needPage(); if (p) runAI("explain", { page: p, level: levelWords() }); break; }
      case "aiNotes": { const p = await needPage(); if (p) runAI("notes", { page: p }); break; }
      case "aiQuiz": { const p = await needPage(); if (p) runAI("quiz", { page: p, count: 5 }); break; }
      case "aiPlan": runAI("plan", planContext()); break;
      case "aiAsk": {
        const q = $("aiQuestion").value.trim(); if (!q) return;
        const page = $("aiUsePage").checked ? await getPage() : null;
        runAI("ask", { question: q, page, socratic: state.socratic, level: levelWords() }); break;
      }
      case "aiMark": { const ans = $("aiAnswers").value.trim(); if (!ans) return; runAI("mark", { questions: hub.ai.lastQuiz, answers: ans }); break; }
      case "aiCopy": try { await navigator.clipboard.writeText(hub.ai.text); } catch (_) { /* clipboard unavailable */ } break;
      case "aiToCards": {
        hub.ai.busy = true; paintHub();
        const r = await askAI("flashcards", { page: { title: "Study material", text: hub.ai.text }, count: 8 }); hub.ai.busy = false;
        hub.tab = "cards"; paintHub(); addCardsFromReply(r); break;
      }
    }
  }
  const levelWords = () => ({ simple: "middle-school (age 11-13)", "high-school": "high-school", university: "university" }[state.level] || "high-school");
  function addCardsFromReply(r) {
    if (!r.ok) { paintHub(); return flash("cdMsg", r.error, true); }
    const cards = SC.parseCards(r.text);
    if (!cards.length) { paintHub(); return flash("cdMsg", "The assistant did not return usable cards. Try again.", true); }
    const have = new Set(state.cards.map((c) => c.front.toLowerCase()));
    let added = 0;
    for (const c of cards) if (!have.has(c.front.toLowerCase())) { state.cards.unshift(SC.newCard(c.front, c.back, Date.now())); added++; }
    save(); paintHub(); flash("cdMsg", `Added ${added} card${added === 1 ? "" : "s"}${added < cards.length ? ` (${cards.length - added} were already in your deck)` : ""}.`);
  }
  function onChange(e) {
    const t = e.target;
    if (t.dataset.act === "toggleDue") { const d = state.deadlines.find((x) => x.id === t.dataset.id); if (d) { d.done = t.checked; hub.sessions = null; save(); paintHub(); } }
    else if (t.dataset.act === "rtCheck") {
      const r = state.routines.find((x) => x.id === t.dataset.id); if (!r) return;
      const tk = todayKey(); if (r.day !== tk) { r.day = tk; r.checked = []; }
      const i = Number(t.dataset.i), at = r.checked.indexOf(i);
      if (t.checked && at < 0) r.checked.push(i); else if (!t.checked && at >= 0) r.checked.splice(at, 1);
      if (SC.routineToday(r, tk).complete && r.credited !== tk) { r.credited = tk; bump("routines", 1); }
      save(); paintHub();
    } else if (t.dataset.act === "blockSites") { state.blockSites = t.checked; save(); if (!t.checked) block(false); }
    else if (t.dataset.act === "socratic") { state.socratic = t.checked; save(); paintHub(); }
    else if (t.dataset.act === "level") { state.level = t.value; save(); }
    else if (t.dataset.cfg) { const v = Math.min(120, Math.max(1, Math.round(Number(t.value)) || SC.DEFAULT_TIMER[t.dataset.cfg])); state.timerCfg[t.dataset.cfg] = v; t.value = v; save(); if (!timer.running) { timer.remaining = SC.phaseSeconds(timer.phase, state.timerCfg); timerPaint(); } }
  }
  function onInput(e) {
    if (e.target.id === "ttQuick") {
      const rows = SC.parseQuickLine(e.target.value);
      const el = $("ttQuickMsg"); if (!el) return;
      el.style.color = rows.length ? "#aaffd0" : "";
      el.textContent = rows.length ? `✓ ${rows.map((r) => `${SC.DAY_SHORT[r.day]} ${SC.fmtTime(r.start)}–${SC.fmtTime(r.end)}`).join(", ")} · ${rows[0].subject}${rows[0].room ? " @ " + rows[0].room : ""}` : e.target.value ? "Keep typing... e.g. Mon/Wed 9:00-10:30 Maths @ Room 4" : "";
    }
  }
  document.addEventListener("keydown", (e) => {
    if (!hub.open || hub.tab !== "cards" || !hub.review || !panelEl() || /INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || "")) return;
    if (e.key === " ") { e.preventDefault(); if (!hub.review.revealed) { hub.review.revealed = true; paintHub(); } }
    else if (hub.review.revealed && /^[1-4]$/.test(e.key)) gradeCurrent(Number(e.key) - 1);
  });
  // Enter in the quick-add line adds it
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target && e.target.id === "ttQuick" && panelEl()) { e.preventDefault(); const b = panelEl().querySelector('[data-act="ttQuickAdd"]'); if (b) b.click(); } });

  window.openStudyHub = openStudyHub;
  window.StudyHub = { state: () => state, reset: () => { state = defaults(); save(); }, timer, hub, timerStart, timerPause, timerFinish, paint: paintHub };
})();
