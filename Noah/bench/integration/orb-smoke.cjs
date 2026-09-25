// Noah/bench/integration/orb-smoke.cjs
//
// Smoke test for the voice orb's agent wiring, in a real Electron renderer, with stand-in bridges (orb-smoke-preload.cjs).
// It checks what does NOT need a microphone: the orb loads, registers its IPC listeners exactly once (it used to add five
// per utterance), mirrors the agent session state, and starts speaking an agent run's outcome when it is free.
// It does NOT exercise the microphone, speech-to-text or the text-to-speech voice.
//
//   electron Noah/bench/integration/orb-smoke.cjs

"use strict";

const path = require("path");
const { app, BrowserWindow } = require("electron");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass });
  console.log(pass ? "PASS" : "FAIL", name, detail ? "| " + detail : "");
};

app.whenReady().then(async () => {
  app.setPath("userData", require("fs").mkdtempSync(path.join(require("os").tmpdir(), "noah-orb-")));
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { preload: path.join(__dirname, "orb-smoke-preload.cjs"), contextIsolation: false, nodeIntegration: false, sandbox: false } });
  const errors = [];
  win.webContents.on("console-message", (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(__dirname, "orb-smoke.html"));
  for (let i = 0; i < 40; i++) {
    if (await win.webContents.executeJavaScript("!!document.getElementById('jonah-voice-orb')").catch(() => false)) break;
    await sleep(250);
  }
  const ev = (js) => win.webContents.executeJavaScript(js);
  const orbState = () => ev("(() => { const o = document.getElementById('jonah-voice-orb'); return { thinking: o.classList.contains('state-thinking'), speaking: o.classList.contains('state-speaking'), listening: o.classList.contains('state-listening'), badge: o._badge ? o._badge.textContent : null }; })()");

  check("the orb loaded", await ev("!!document.getElementById('jonah-voice-orb')"), errors.join(" / ").slice(0, 200));
  const c0 = await ev("({ completed: __counts.completed, paused: __counts.paused, error: __counts.error, blocked: __counts.blocked, step: __counts.step, event: __counts.event })");
  check("agent-outcome listeners are registered exactly ONCE each at start-up", c0.completed === 1 && c0.paused === 1 && c0.error === 1 && c0.blocked === 1 && c0.event === 1, JSON.stringify(c0));
  check("it no longer listens to the per-step channel (steps are not read out any more)", c0.step === 0, JSON.stringify(c0));

  await ev("__fire('event', { event: 'session_state', state: 'executing', label: 'Working…', text: 'Typing…' })");
  let s = await orbState();
  check("while the agent works the orb shows 'Working…'", s.thinking && s.badge === "Working…", JSON.stringify(s));
  await ev("__fire('event', { event: 'session_state', state: 'paused', label: 'Paused' })");
  s = await orbState();
  check("while paused it shows 'Paused'", s.thinking && s.badge === "Paused", JSON.stringify(s));
  await ev("__fire('event', { event: 'session_state', state: 'waiting_for_user' })");
  s = await orbState();
  check("while waiting for the user it shows 'Waiting for you'", s.thinking && s.badge === "Waiting for you", JSON.stringify(s));
  await ev("__fire('event', { event: 'session_state', state: 'completed' })");
  s = await orbState();
  check("when the run is done the orb goes back to idle", !s.thinking && !s.speaking && !s.listening, JSON.stringify(s));

  // an agent run's outcome (tagged agent:true by the main process) is spoken by the persistent listener when the orb is free
  await ev("__fire('completed', { reason: 'Typed about 120 words into the page.', agent: true })");
  let spoke = false;
  for (let i = 0; i < 30 && !spoke; i++) {
    await sleep(100);
    const st = await orbState();
    spoke = st.speaking || /Speaking|Generating voice/.test(st.badge || ""); // it entered speak(): synthesising the voice comes first
  }
  check("an agent run's outcome makes the orb start speaking it (the orb is free to: it was not held by the run)", spoke, JSON.stringify(await orbState()));
  const c1 = await ev("({ completed: __counts.completed, event: __counts.event })");
  check("events did not add listeners", c1.completed === 1 && c1.event === 1, JSON.stringify(c1));

  const failed = results.filter((r) => !r.pass);
  console.log(`SUMMARY ${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
});
