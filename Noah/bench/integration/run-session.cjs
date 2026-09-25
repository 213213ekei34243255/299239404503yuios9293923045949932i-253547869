// Noah/bench/integration/run-session.cjs
//
// LIVE SESSION run: the real Jonah app, the REAL hosted model (https://www.noahai.live/predict) and the real JustNotepad
// site, ONE app session, several instructions in a row. It exists to answer one question honestly: after the agent has
// done something (opened a notepad and written on it), does it stay the same available agent for the next instruction,
// whether typed or spoken, and does it survive the user taking control, a navigation and a long task?
//
//   electron --user-data-dir=<tmp> Noah/bench/integration/run-session.cjs        (NOAH_SESSION_SCENARIO=main | error)
//
// Scenarios (main):  A initial task  B follow-up (typed in the real chat panel)  C explicit page reference  D voice-source
// follow-up  E user takes control -> Paused -> "continue" resumes the SAME run  F navigation away and back  G long task
// T unreachable page.  (error): the model is unreachable: every run must still end in a terminal state, with a readable
// message, and the next instruction must still be accepted.
//
// What "voice" means here: the transcript goes through window.rexy.goal(text, { source: "voice" }) - the exact call the voice
// orb makes once speech-to-text has produced a transcript. The microphone and speech-to-text themselves are NOT exercised.
//
// Nothing here is faked: every check reads state the app itself produced (events, the page's own editor text, the panel DOM).

"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const { app, BrowserWindow, webContents, screen } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULTS = path.join(ROOT, "Noah", "bench", "results");
if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(require("os").tmpdir(), "noah-session-")));
const SCENARIO = process.env.NOAH_SESSION_SCENARIO || "main";
const ONLY = (process.env.NOAH_SESSION_ONLY || "").split(",").filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[session]", ...a);

// The lifecycle log lives in this same process: read it instead of guessing.
const lifecycle = require(path.join(ROOT, "Noah", "agent", "lifecycle-log.cjs"));
const lifeLines = [];
lifecycle.setEnabled(true);
lifecycle.setSink((l) => { try { lifeLines.push(JSON.parse(l)); } catch (_) { /* ignore */ } });

let disturbedNow = false; // the physical mouse moved during the current run (this script never moves it)
const results = [];
const runSummaries = []; // one entry per submitted instruction: outcome, duration, the status updates the user saw, and the run's metrics
const check = (id, name, pass, detail = "") => {
  results.push({ id, name, pass: !!pass, detail: String(detail).slice(0, 400), machineInputDuringRun: disturbedNow });
  log(pass ? "PASS" : "FAIL", id, "-", name, detail ? "| " + String(detail).slice(0, 300) : "");
};

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  const cfgDir = path.join(app.getPath("userData"), "browser-data", "noah");
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfg = { takeover: { enabled: true }, policy: { mode: "autonomous", allowLocalhost: true }, limits: { maxSteps: 40, maxModelCalls: 60, maxWallMs: SCENARIO === "error" ? 90000 : 240000 } };
  if (SCENARIO === "error") cfg.providers = { rexy: { baseURL: "http://127.0.0.1:1/predict" } };
  fs.writeFileSync(path.join(cfgDir, "noah-config.json"), JSON.stringify(cfg));
  app.getAppPath = () => ROOT;
  { let last = Date.now(); setInterval(() => { const n = Date.now(); if (n - last > 3000) log("main loop stalled", n - last, "ms"); last = n; }, 500).unref(); }
  log("loading main.cjs, scenario =", SCENARIO);
  require(path.join(ROOT, "main.cjs"));

  let win = null;
  for (let i = 0; i < 160 && !win; i++) {
    await sleep(500);
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html"));
  }
  if (!win) { log("shell window did not open"); return finish(2); }
  win.webContents.closeDevTools();
  const ev = (js, ms = 20000) => Promise.race([win.webContents.executeJavaScript(js, true), new Promise((_, rej) => setTimeout(() => rej(new Error("renderer call timed out: " + js.slice(0, 60))), ms))]);
  for (let i = 0; i < 80; i++) { await sleep(500); if (await ev("!!(window.noah && window.NoahOverlay && window.rexy && document.getElementById('noahOverlay'))").catch(() => false)) break; }
  await ev("(() => { window.__ev = []; window.noah.onEvent((e) => { e.__t = Date.now(); window.__ev.push(e); }); })()");
  await sleep(1500);
  log("shell ready; providers:", JSON.stringify(Object.entries((await ev("window.noah.getConfig()")).providerStatus).filter(([, v]) => v.hasKey || v.keyless).map(([k]) => k)));

  // ------------------------------------------------------------------ helpers
  const KEEP = "e.event === 'session_state' || e.event === 'safety' || e.event === 'ask_user' || e.event === 'task_started' || e.event === 'task_finished' || e.event === 'confirm_request' || e.event === 'step' || e.event === 'keyboard_action'";
  const eventsFrom = (from) => ev(`window.__ev.slice(${from}).filter((e) => ${KEEP}).map((e) => ({ event: e.event, state: e.state, label: e.label, text: e.text, level: e.level, reason: e.reason, runId: e.runId, taskId: e.taskId, status: e.status, result: e.result, error: e.error, superseded: e.superseded, question: e.question, action: e.actions && e.actions[0] && e.actions[0].action, metrics: e.metrics, t: e.__t }))`);
  const session = async () => (await ev("window.noah.getState()")).session;
  const notepadWc = () => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.hostWebContents === win.webContents && /justnotepad\.com/.test(w.getURL()));
  const editorText = async () => {
    const wc = notepadWc();
    if (!wc) return null;
    return wc.executeJavaScript("(() => { const els = [...document.querySelectorAll('textarea, [contenteditable=true], [contenteditable=\"\"]')].sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight); const e = els[0]; return e ? (typeof e.value === 'string' ? e.value : e.innerText) : null; })()").catch(() => null);
  };
  const hasPlaceholder = (t) => /\[\d+ chars\]/.test(String(t || ""));

  /** Submit through the same door the chat panel / voice orb use and wait for the run to end. */
  async function runGoal(id, text, { source, timeoutMs = 240000, during } = {}) {
    const from = await ev("window.__ev.length");
    const t0 = Date.now();
    const sub = await ev(`window.rexy.goal(${JSON.stringify(text)}, ${source ? JSON.stringify({ source }) : "undefined"})`);
    log(id, "submitted:", JSON.stringify(text), source || "text", "->", JSON.stringify(sub));
    let fin = null;
    let lastCursor = screen.getCursorScreenPoint();
    let osMoves = 0;
    disturbedNow = false;
    while (Date.now() - t0 < timeoutMs && !fin) {
      await sleep(400);
      const c = screen.getCursorScreenPoint();
      if (Math.hypot(c.x - lastCursor.x, c.y - lastCursor.y) > 3) { osMoves++; disturbedNow = true; }
      lastCursor = c;
      if (during && (await during(from, t0).catch((e) => (log(id, "hook error:", e.message), false)))) break; // a hook may end the wait early
      fin = (await ev(`window.__ev.slice(${from}).find((e) => e.event === 'task_finished') || null`).catch(() => null));
    }
    await sleep(600);
    const events = await eventsFrom(from);
    const states = events.filter((e) => e.event === "session_state");
    if (osMoves) log(id, "NOTE: the PHYSICAL mouse moved", osMoves, "times during this run: a person or a remote session is using this machine, which can legitimately pause or stop the run");
    log(id, "ended:", fin ? fin.status : "NO TERMINAL EVENT", "in", Math.round((Date.now() - t0) / 1000) + "s", "| states:", states.map((s) => s.state + (s.text ? `(${s.text})` : "")).join(" > ").slice(0, 300));
    const m = fin && fin.metrics;
    runSummaries.push({ id, text, source: source || "text", kind: sub && sub.kind, status: fin ? fin.status : "no terminal event", seconds: Math.round((Date.now() - t0) / 1000), statusUpdates: states.length, states: states.map((x) => x.state + (x.text ? "(" + x.text + ")" : "")), pauses: events.filter((e) => e.event === "safety" && e.level === "pause").map((e) => e.reason), physicalMouseMoves: osMoves, steps: fin && fin.steps, modelCalls: m && m.modelCalls, localSteps: m && m.localSteps, timeouts: m && m.timeouts, inputTokensEst: m && m.inputTokens });
    if (m) log(id, "metrics:", JSON.stringify({ steps: fin.steps, modelCalls: m.modelCalls, localSteps: m.localSteps, actions: m.actions, failures: m.actionFailures, timeouts: m.timeouts, seconds: Math.round((m.elapsedMs || 0) / 1000) }));
    return { sub, fin, events, states, ms: Date.now() - t0 };
  }
  const outage = (fin) => !!fin && fin.status === "failed" && /AI model|typed nothing|reach the model/i.test(String(fin.error || ""));
  /** Like runGoal, but a writing task that failed only because the hosted model was unreachable is retried (up to 3 tries, 20 s apart) and says so. */
  async function runWriting(id, text, opts = {}) {
    let r = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      r = await runGoal(attempt === 1 ? id : `${id}#${attempt}`, text, opts);
      r.attempts = attempt;
      if (!outage(r.fin)) return r;
      log(id, "attempt", attempt, "failed only because the hosted AI model was unreachable; waiting 20s and asking again (this is a network/model outage, not an agent fault)");
      await sleep(20000);
    }
    return r;
  }
  const noNav = (r) => !r.events.some((e) => e.event === "step" && e.action === "navigate");
  const noPause = (r) => !r.events.some((e) => e.event === "safety" && e.level === "pause");

  if (SCENARIO === "error") return scenarioError();

  // ------------------------------------------------------------------ A: initial task
  const S0 = await session();
  check("A0", "the session exists before any task and is idle", S0 && S0.state === "idle" && S0.enabled === true, JSON.stringify({ state: S0 && S0.state, id: S0 && S0.sessionId }));
  const A = await runGoal("A", "Open JustNotepad and write a short dinosaur story");
  const textA = (await editorText()) || "";
  const SA = await session();
  check("A1", "initial task completed", A.fin && A.fin.status === "completed", A.fin && (A.fin.result || A.fin.error));
  check("A2", "a story was written into the notepad, once, with no redacted placeholder", textA.length > 200 && !hasPlaceholder(textA), `${textA.length} chars: ${textA.slice(0, 90)}`);
  check("A3", "the run ended in the terminal state 'completed' and the session stayed", SA.state === "completed" && SA.sessionId === S0.sessionId && SA.runs === 1, JSON.stringify({ state: SA.state, runs: SA.runs }));
  check("A4", "the session knows the page it is on", /justnotepad/.test(SA.browser.url || ""), SA.browser.url);
  const statesA = A.states.map((s) => s.state);
  check("A5", "status went through Working... to Done with a small, bounded number of updates (no status spam)", statesA[0] === "planning" && statesA.at(-1) === "completed" && A.states.length <= 30, `${A.states.length} updates`);
  check("A6", "no user question and no pause during the task", noPause(A) && !A.events.some((e) => e.event === "ask_user"));

  // ------------------------------------------------------------------ B: follow-up typed into the REAL chat panel
  let B;
  const panel = await ev(`(() => { const p = document.getElementById('aiPanel'); if (!p) return 'no panel'; p.classList.remove('ai-hidden'); const f = p.querySelector('iframe'); try { return f && f.contentDocument && f.contentDocument.getElementById('input') ? 'ok' : 'iframe not readable'; } catch (e) { return 'blocked: ' + e.message; } })()`).catch((e) => "error: " + e.message);
  log("chat panel access:", panel);
  // B is sent through the panel's own input and send button, so the whole UI path is real
  {
    const from = await ev("window.__ev.length");
    const t0 = Date.now();
    const before = panel === "ok" ? await ev(`document.querySelector('#aiPanel iframe').contentDocument.querySelectorAll('.msg').length`) : 0;
    if (panel === "ok") await ev(`(() => { const d = document.querySelector('#aiPanel iframe').contentDocument; d.getElementById('input').value = 'Continue writing the story'; d.defaultView.sendMessage(); })()`);
    else await ev(`window.rexy.goal('Continue writing the story')`);
    const seenStatus = new Set();
    let typingBubbleTicks = 0;
    let fin = null;
    while (Date.now() - t0 < 240000 && !fin) {
      await sleep(400);
      if (panel === "ok") {
        const s = await ev(`(() => { const d = document.querySelector('#aiPanel iframe').contentDocument; return { status: d.getElementById('noahStatus').textContent, typing: !!d.getElementById('typing') }; })()`).catch(() => null);
        if (s) { seenStatus.add(s.status); if (s.typing) typingBubbleTicks++; }
      }
      fin = await ev(`window.__ev.slice(${from}).find((e) => e.event === 'task_finished') || null`).catch(() => null);
    }
    await sleep(1200);
    const events = await eventsFrom(from);
    B = { fin, events, states: events.filter((e) => e.event === "session_state"), ms: Date.now() - t0 };
    const textB = (await editorText()) || "";
    const SB = await session();
    let panelInfo = { after: null, thinking: null, status: null, msgs: [] };
    if (panel === "ok") {
      panelInfo = await ev(`(() => { const d = document.querySelector('#aiPanel iframe').contentDocument; return { count: d.querySelectorAll('.msg').length, thinking: [...d.querySelectorAll('.msg')].some((m) => /thinking\\.\\.\\./i.test(m.textContent)), typing: !!d.getElementById('typing'), status: d.getElementById('noahStatus').textContent, msgs: [...d.querySelectorAll('.msg')].map((m) => m.className.replace('msg ', '') + ': ' + m.textContent.slice(0, 80)) }; })()`);
    }
    check("B1", "follow-up 'Continue writing the story' (typed in the chat panel, no page named) completed", fin && fin.status === "completed", fin && (fin.result || fin.error));
    check("B2", "it continued on the SAME page: no navigation, and the earlier text is still there", noNav(B) && textB.startsWith(textA.slice(0, 80)), `navigates=${B.events.filter((e) => e.action === "navigate").length}`);
    check("B3", "a new paragraph was appended (text grew by 100+ chars) and nothing was typed twice", textB.length > textA.length + 100 && !hasPlaceholder(textB) && textB.split(textA.slice(0, 60)).length === 2, `${textA.length} -> ${textB.length}`);
    check("B4", "same session, second run; no re-activation needed", SB.sessionId === S0.sessionId && SB.runs >= 2, JSON.stringify({ runs: SB.runs, state: SB.state }));
    check("B5", "no pause and no question", noPause(B) && !B.events.some((e) => e.event === "ask_user"));
    if (panel === "ok") {
      log("panel messages:", JSON.stringify(panelInfo.msgs));
      check("B6", "chat panel: no 'thinking...' text anywhere and no lingering waiting bubble at the end", !panelInfo.thinking && !panelInfo.typing, JSON.stringify({ thinking: panelInfo.thinking, typing: panelInfo.typing }));
      check("B7", "chat panel: status line shows only Ready / Working / an action / Done (no internal statuses)", [...seenStatus].every((s) => /^(Ready|Working…|Done|Typing…|Clicking…|Scrolling…|Pressing a key…|Opening .*|Reading the page…|Waiting for the page…|Looking on the page…|Moving the pointer…)$/.test(s)), [...seenStatus].join(" | "));
      check("B8", "chat panel: one message for the user, one for the result (no per-step message stream)", panelInfo.count - before <= 3, `${panelInfo.count - before} new messages: ${panelInfo.msgs.slice(before).join(" || ")}`);
      check("B9", "chat panel ends on 'Ready' or 'Done'", /^(Ready|Done)$/.test(panelInfo.status), panelInfo.status);
    }
    globalThis.__textB = textB;
  }

  // ------------------------------------------------------------------ C: explicit page reference
  const textBefC = (await editorText()) || "";
  const C = await runWriting("C", "Write the next paragraph on the notepad");
  const textC = (await editorText()) || "";
  const SC = await session();
  check("C1", "'Write the next paragraph on the notepad' completed and appended text", C.fin && C.fin.status === "completed" && textC.length > textBefC.length + 100, `${textBefC.length} -> ${textC.length}`);
  check("C2", "still the same session and page (no navigation, no re-activation)", noNav(C) && SC.sessionId === S0.sessionId && SC.runs >= 3, JSON.stringify({ runs: SC.runs }));
  check("C3", "earlier text preserved, no placeholder", textC.startsWith(textBefC.slice(0, 80)) && !hasPlaceholder(textC));

  // ------------------------------------------------------------------ D: the same thing spoken (transcript -> rexy.goal with source voice)
  const textBefD = (await editorText()) || "";
  const D = await runWriting("D", "Continue the story", { source: "voice" });
  const textD = (await editorText()) || "";
  const SD = await session();
  check("D1", "the spoken follow-up was taken as an AGENT task (not chat), by the same router", D.sub && D.sub.success === true && D.sub.kind === "agent", JSON.stringify(D.sub));
  check("D2", "it completed and appended text on the same page", D.fin && D.fin.status === "completed" && textD.length > textBefD.length + 100 && noNav(D), `${textBefD.length} -> ${textD.length}`);
  check("D3", "same session, 4th run or later", SD.sessionId === S0.sessionId && SD.runs >= 4, JSON.stringify({ runs: SD.runs }));
  check("D4", "the lifecycle log recorded it as a VOICE command on this session", lifeLines.some((l) => l.event === "VOICE_COMMAND_RECEIVED" && l.sessionId === S0.sessionId && /continue the story/i.test(l.text || "")));

  // ------------------------------------------------------------------ E: user takes control -> Paused -> "continue" resumes the same run
  let E = null;
  let SE = null;
  let fromE = 0;
  let textBefE = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    fromE = await ev("window.__ev.length");
    textBefE = (await editorText()) || "";
    let clicked = false;
    let pausedAt = 0;
    E = await runGoal(attempt === 1 ? "E" : `E#${attempt}`, "Write the next paragraph on the notepad", {
      timeoutMs: 60000, // ends when the user-control part is done (the run itself is finished below)
      during: async (from, t0) => {
        if (clicked) return (await session()).state === "paused" || Date.now() - pausedAt > 8000; // the click landed: stop waiting once paused
        const evs = await eventsFrom(from);
        const lastKey = evs.filter((e) => e.event === "keyboard_action").at(-1);
        const idleForKeys = !lastKey || Date.now() - lastKey.t > 900;
        const running = evs.some((e) => e.event === "session_state" && e.state === "executing");
        if (running && idleForKeys && Date.now() - t0 > 1500) {
          const wc = notepadWc();
          if (!wc) return false;
          clicked = true;
          wc.sendInputEvent({ type: "mouseMove", x: 320, y: 300 });
          wc.sendInputEvent({ type: "mouseDown", x: 320, y: 300, button: "left", clickCount: 1 });
          wc.sendInputEvent({ type: "mouseUp", x: 320, y: 300, button: "left", clickCount: 1 });
          pausedAt = Date.now();
          log("E: a real click was sent into the page (user takes control)");
        }
        return false;
      },
    });
    SE = await session();
    if (SE.state === "paused") break;
    if (outage(E.fin)) { log("E: attempt", attempt, "ended before the click could pause it, only because the hosted AI model was unreachable; waiting 20s and trying again"); await sleep(20000); continue; }
    break;
  }
  // runGoal returns at task_finished or 60 s; if the click paused the run, the run is still open here
  check("E1", "the user's real click paused the run (state 'paused'), once", SE.state === "paused", JSON.stringify({ state: SE.state }));
  const runIdBefore = SE.runId;
  const keysWhilePaused0 = await ev("window.__ev.filter((e) => e.event === 'keyboard_action').length");
  await sleep(3500);
  const SE2 = await session();
  const keysWhilePaused1 = await ev("window.__ev.filter((e) => e.event === 'keyboard_action').length");
  check("E2", "while paused nothing else happens: still paused, same run, same task, no typing", SE2.state === "paused" && SE2.runId === runIdBefore && keysWhilePaused1 === keysWhilePaused0 && SE2.task && SE2.task.goal === "Write the next paragraph on the notepad", JSON.stringify({ state: SE2.state, keys: [keysWhilePaused0, keysWhilePaused1] }));
  check("E3", "the session did not forget the page while paused", /justnotepad/.test(SE2.browser.url || ""), SE2.browser.url);
  const beforeContinue = await ev("window.__ev.length");
  const cont = await ev(`window.rexy.goal('Continue', { source: 'voice' })`);
  check("E4", "a spoken 'Continue' is a CONTROL on the paused run (not a new task)", cont.success === true && cont.kind === "control", JSON.stringify(cont));
  let finE = null;
  for (let i = 0; i < 400 && !finE; i++) { await sleep(500); finE = await ev(`window.__ev.slice(${beforeContinue}).find((e) => e.event === 'task_finished') || null`); }
  const afterEvents = await eventsFrom(beforeContinue);
  const textE = (await editorText()) || "";
  check("E5", "it RESUMED the same run and completed it (same task id, no second run started)", !!finE && finE.status === "completed" && finE.taskId === SE.task.id && !afterEvents.some((e) => e.event === "task_started"), JSON.stringify({ status: finE && finE.status, sameTask: finE && finE.taskId === SE.task.id, error: finE && finE.error }));
  check("E6", "the paragraph was written after resuming", textE.length > textBefE.length + 100, `${textBefE.length} -> ${textE.length}`);
  const SE3 = await session();
  check("E7", "still the same session and 'Done'", SE3.sessionId === S0.sessionId && SE3.runs >= 5 && SE3.state === "completed", JSON.stringify({ runs: SE3.runs, state: SE3.state }));
  check("E8", "the paused status was reported once and the resume once (no repeated 'Paused' spam)", (await eventsFrom(fromE)).filter((e) => e.event === "session_state" && e.state === "paused").length === 1);

  // ------------------------------------------------------------------ F: navigation Page A -> JustNotepad keeps the session
  const tabsBefore = await session();
  const startedBeforeF = await ev("window.__ev.filter((e) => e.event === 'task_started').length");
  await ev(`document.querySelector('webview').loadURL('https://example.com/')`);
  await sleep(6000);
  const SF1 = await session();
  check("F1", "the user navigated to another page: the session followed it (url updated) and stayed the same session in a non-error state", /example\.com/.test(SF1.browser.url || "") && SF1.sessionId === S0.sessionId && SF1.state !== "error" && SF1.enabled, JSON.stringify({ url: SF1.browser.url, state: SF1.state }));
  check("F2", "navigating did not start, pause or cancel any run", (await ev("window.__ev.filter((e) => e.event === 'task_started').length")) === startedBeforeF && !(await ev("window.__ev.some((e) => e.event === 'safety' && e.level === 'pause' && e.__t > " + (Date.now() - 6500) + ")")));
  await ev(`document.querySelector('webview').loadURL('https://justnotepad.com/')`);
  await sleep(9000);
  const SF2 = await session();
  check("F3", "navigating back to JustNotepad updated the session's page again", /justnotepad/.test(SF2.browser.url || "") && SF2.browser.pageReady === true, JSON.stringify({ url: SF2.browser.url, ready: SF2.browser.pageReady }));
  const textBefF = (await editorText()) || "";
  const F = await runWriting("F", "Continue writing the story");
  const textF = (await editorText()) || "";
  check("F4", "after the navigation 'Continue writing the story' still knows the task and writes on the notepad", F.fin && F.fin.status === "completed" && textF.length > 100 && textF.length > textBefF.length, `${textBefF.length} -> ${textF.length} (the site itself ${textBefF.length ? "kept" : "did NOT keep"} the earlier text across the reload)`);

  // ------------------------------------------------------------------ G: long task
  const G = await runGoal("G", "Open youtube.com and search for lo-fi music, scroll down and play the best one", { timeoutMs: 270000 });
  const SG = await session();
  const gUpdates = G.states.length;
  check("G1", "the long task reached a terminal state (never left 'Working…' forever)", !!G.fin, G.fin ? G.fin.status + " | " + String(G.fin.result || G.fin.error || "").slice(0, 120) : "NO TERMINAL EVENT within the wait window");
  check("G2", "status updates stayed bounded during the long task (no status stream)", gUpdates <= 60, `${gUpdates} updates, ${G.events.filter((e) => e.event === "step").length} steps`);
  check("G3", "no user takeover pause and no question during the long task (idle mouse/keyboard)", noPause(G) && !G.events.some((e) => e.event === "ask_user"));
  check("G4", "same session afterwards", SG.sessionId === S0.sessionId && SG.runs >= 7, JSON.stringify({ runs: SG.runs, state: SG.state }));
  if (G.fin && G.fin.metrics) log("G metrics:", JSON.stringify({ steps: G.fin.steps, modelCalls: G.fin.metrics.modelCalls, localSteps: G.fin.metrics.localSteps, elapsedMs: G.fin.metrics.elapsedMs, timeouts: G.fin.metrics.timeouts }));

  // ------------------------------------------------------------------ T: a page that never answers (bounded, terminal)
  const hang = http.createServer(() => { /* accepts the connection and never answers */ });
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  const hangUrl = `http://127.0.0.1:${hang.address().port}/`;
  const T = await runGoal("T", `Open ${hangUrl} and tell me what the page says`, { timeoutMs: 200000 });
  hang.close();
  const ST = await session();
  check("T1", "a page that never loads ends the run in a terminal state with a readable message (not an endless 'Working…')", !!T.fin && ["completed", "failed"].includes(T.fin.status) && ["completed", "error"].includes(ST.state), T.fin ? `${T.fin.status}: ${String(T.fin.result || T.fin.error).slice(0, 200)} (after ${Math.round(T.ms / 1000)}s)` : "NO TERMINAL EVENT");
  check("T2", "the session is still there and ready for the next instruction", ST.sessionId === S0.sessionId && ST.enabled, JSON.stringify({ state: ST.state }));
  const after = await runGoal("T3", "Open example.com", { timeoutMs: 120000 });
  check("T3", "the next instruction after that failure is accepted and run", !!after.fin && after.sub && after.sub.success, after.fin ? after.fin.status : "no terminal");

  return report(S0.sessionId);

  // ------------------------------------------------------------------ the error scenario (separate boot: the model is unreachable)
  async function scenarioError() {
    const S0 = await session();
    const H1 = await runGoal("H1", "Open JustNotepad and write a short dinosaur story", { timeoutMs: 100000 });
    const SH1 = await session();
    check("H1", "with the model unreachable the run still ENDS (terminal state 'error'), it does not spin", !!H1.fin && H1.fin.status === "failed" && SH1.state === "error", H1.fin ? `${H1.fin.status} in ${Math.round(H1.ms / 1000)}s` : "NO TERMINAL EVENT");
    check("H2", "the message is readable (a sentence, no stack trace / internal code)", !!H1.fin && typeof H1.fin.error === "string" && H1.fin.error.length > 10 && !/\bat .*\.cjs|ECONNREFUSED|undefined|\[object/.test(H1.fin.error), H1.fin && H1.fin.error);
    const H2 = await runGoal("H3", "Continue writing the story", { timeoutMs: 100000 });
    check("H3", "the next instruction is still accepted and started (availability is not lost after a failure)", H2.sub && H2.sub.success === true && H2.events.some((e) => e.event === "task_started"), JSON.stringify(H2.sub));
    check("H4", "same session throughout", (await session()).sessionId === S0.sessionId);
    return report(S0.sessionId);
  }

  async function report(sessionId) {
    const counts = {};
    for (const l of lifeLines) counts[l.event] = (counts[l.event] || 0) + 1;
    const ipc = {};
    for (const l of lifeLines) if (l.event === "IPC_LISTENER_REGISTERED") ipc[l.channel] = (ipc[l.channel] || 0) + 1;
    check("L1", "exactly one session was created and none destroyed while the app ran", counts.AGENT_SESSION_CREATED === 1 && !counts.AGENT_SESSION_DESTROYED, JSON.stringify({ created: counts.AGENT_SESSION_CREATED, destroyed: counts.AGENT_SESSION_DESTROYED }));
    check("L2", "no IPC listener was registered twice", Object.values(ipc).every((n) => n === 1), JSON.stringify(ipc));
    const started = counts.AGENT_RUN_STARTED || 0;
    const ended = (counts.AGENT_RUN_COMPLETED || 0) + (counts.AGENT_RUN_FAILED || 0) + (counts.AGENT_RUN_CANCELLED || 0);
    check("L3", "every started run ended (started == completed + failed + cancelled)", started === ended, JSON.stringify({ started, ended }));
    log("lifecycle event counts:", JSON.stringify(counts));
    fs.writeFileSync(path.join(RESULTS, `session-run-${SCENARIO}.json`), JSON.stringify({ when: new Date().toISOString(), scenario: SCENARIO, note: "REAL hosted model + real JustNotepad/YouTube; voice = the transcript path only (no microphone / speech-to-text)", results, runs: runSummaries, lifecycleCounts: counts, lifecycle: lifeLines }, null, 2));
    const failed = results.filter((r) => !r.pass);
    log(`SUMMARY ${results.length - failed.length}/${results.length} passed`);
    for (const r of failed) log("  FAILED", r.id, "-", r.name, "|", r.detail, r.machineInputDuringRun ? "| (physical mouse movement was detected during this run)" : "");
    return finish(failed.length ? 1 : 0);
  }
}

function finish(code) {
  setTimeout(() => app.exit(code), 500);
}

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.whenReady().then(() => main().catch((e) => { console.error("SESSION ERROR", e); app.exit(2); }));
