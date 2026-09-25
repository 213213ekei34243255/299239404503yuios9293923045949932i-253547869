// Noah/bench/integration/run-live.cjs
//
// LIVE run: the real Jonah app + the REAL model provider configured in the project's .env / Noah settings.
// Unlike run-app.cjs there is no scripted model here, so this is the only script that says anything about
// real-LLM behaviour. It is deliberately tiny and bounded (model-call, step and wall-clock caps) and it only
// ever browses the local fixture shop, so nothing about the user's accounts or browsing is sent to a provider.
//
//   electron --user-data-dir=<tmp> Noah/bench/integration/run-live.cjs
//
// Prints which model answered, latency, tokens and the purple-cursor evidence. Never prints keys.

"use strict";

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULTS = path.join(ROOT, "Noah", "bench", "results");
// Never touch the real Jonah profile: unless --user-data-dir was given, use a throwaway one (the test writes Noah settings into it).
if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(require("os").tmpdir(), "noah-it-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[live]", ...a);
const { createServer } = require("../fixtures.cjs");

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  const fx = await createServer();
  const cfgDir = path.join(app.getPath("userData"), "browser-data", "noah");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, "noah-config.json"),
    JSON.stringify({ takeover: { enabled: false }, policy: { mode: "autonomous", allowLocalhost: true }, limits: { maxSteps: 24, maxModelCalls: 30, maxWallMs: 240000 } })
  );
  app.getAppPath = () => ROOT;
  { let last = Date.now(); setInterval(() => { const n = Date.now(); if (n - last > 2500) log("main loop stalled", n - last, "ms"); last = n; }, 500).unref(); setInterval(() => log("hb"), 5000).unref(); }
  log("loading main.cjs");
  require(path.join(ROOT, "main.cjs"));
  log("main.cjs loaded; waiting for the shell window");

  let win = null;
  for (let i = 0; i < 120 && !win; i++) {
    await sleep(500);
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html"));
  }
  if (!win) { log("shell window did not open"); return done(fx, 2); }
  log("shell window found");
  win.webContents.closeDevTools();
  let stallShot = false;
  const ev = (js, ms = 20000) => (log("ev>", js.slice(0, 50).replace(/\n/g, " ")), Promise.race([win.webContents.executeJavaScript(js, true), new Promise((_, rej) => setTimeout(() => rej(new Error("renderer call timed out")), ms))]).then((r) => (log("ev<"), r), async (e) => {
    log("ev! " + e.message);
    if (!stallShot && !win.isDestroyed()) {
      // a frozen shell: a picture and the process state say more than the timeout does (JS dialog? blank? crashed?)
      stallShot = true;
      try {
        log("STALL state:", JSON.stringify({ loading: win.webContents.isLoading(), crashed: win.webContents.isCrashed(), url: win.webContents.getURL(), frames: win.webContents.mainFrame.framesInSubtree.map((f) => f.url) }));
        fs.writeFileSync(path.join(RESULTS, "stall.png"), (await win.webContents.capturePage()).toPNG());
        log("STALL screenshot saved to Noah/bench/results/stall.png");
      } catch (err) { log("STALL capture failed:", err.message); }
    }
    return Promise.reject(e);
  }));
  for (let i = 0; i < 60; i++) { await sleep(500); if (await ev("!!(window.noah && window.NoahOverlay && document.getElementById('noahOverlay'))").catch(() => false)) break; }

  log("shell ready");
  const cfg = await ev("window.noah.getConfig()", 8000).catch(() => { log("getConfig() did not answer: asking again"); return ev("window.noah.getConfig()", 8000); });
  log("providers with a usable key/endpoint:", Object.entries(cfg.providerStatus).filter(([, v]) => v.hasKey || v.keyless).map(([k]) => k).join(", ") || "(none)");
  const st0 = await ev("window.noah.getState()");
  log("agent state:", JSON.stringify(st0));
  await ev("(() => { window.__ev = []; window.noah.onEvent((e) => { e.__t = Date.now(); window.__ev.push(e); }); })()");
  await sleep(1500);

  // NOAH_LIVE_GOAL lets the same script drive a real site (a public page; the goal text goes to the configured model).
  const goal = process.env.NOAH_LIVE_GOAL || `Noah, open ${fx.url("/")} , search for laptops, and tell me the cheapest laptop with 16GB of RAM and its price.`;
  log("goal:", goal);
  // NOAH_LIVE_START: a page that is already open when the goal is given (like a user with a notepad in front of them)
  if (process.env.NOAH_LIVE_START) {
    await ev("document.querySelector('webview').loadURL(" + JSON.stringify(process.env.NOAH_LIVE_START) + ")");
    await sleep(9000);
    log("start page:", await ev("window.NoahRenderer.tabs().find((x) => x.active).url"));
  }
  const t0 = Date.now();
  const sub = await ev(`window.rexy.goal(${JSON.stringify(goal)})`);
  log("legacy rexy.goal() ->", JSON.stringify(sub));

  let shot = false;
  let typingShot = false;
  let scrollShot = false;
  let finished = null;
  let sawCursor = false;
  for (let i = 0; i < 1500 && !finished; i++) {
    await sleep(100);
    const snap = await ev(`(() => { const o = document.getElementById('noahOverlay'); const c = o && o.querySelector('.noah-cursor'); const r = c && c.getBoundingClientRect();
      return { vis: !!(c && c.classList.contains('noah-visible')) && !o.hidden, pos: r ? [r.left, r.top] : null, op: c && getComputedStyle(c).opacity, clicks: window.__ev.filter((e) => e.event === 'mouse_action').length, keys: window.__ev.filter((e) => e.event === 'keyboard_action').length, scrolls: window.__ev.filter((e) => e.event === 'scroll_action').length, fin: window.__ev.find((e) => e.event === 'task_finished') || null }; })()`).catch(() => null);
    if (!snap) continue;
    if (snap.vis) sawCursor = true;
    if (snap.clicks >= 1 && snap.op === "1" && snap.pos && !shot) {
      await sleep(200);
      const img = await win.webContents.capturePage();
      const sz = img.getSize();
      const k = sz.width / win.getContentBounds().width;
      const x = Math.max(0, Math.round((snap.pos[0] - 30) * k)), y = Math.max(0, Math.round((snap.pos[1] - 30) * k));
      const crop = img.crop({ x, y, width: Math.min(220, sz.width - x), height: Math.min(120, sz.height - y) });
      const bmp = crop.toBitmap();
      let purple = 0;
      for (let j = 0; j < bmp.length; j += 4) if (Math.abs(bmp[j + 2] - 124) < 24 && Math.abs(bmp[j + 1] - 58) < 24 && Math.abs(bmp[j] - 237) < 24) purple++;
      fs.writeFileSync(path.join(RESULTS, "live-purple-cursor.png"), img.toPNG());
      log("cursor evidence: solid purple pixels near cursor =", purple);
      shot = true;
    }
    if (snap.keys >= 3 && !typingShot) {
      // a frame while Noah is typing: the text should be partly in the box, key by key
      typingShot = true;
      await sleep(120);
      fs.writeFileSync(path.join(RESULTS, "live-typing.png"), (await win.webContents.capturePage()).toPNG());
      log("captured a frame mid-typing (keyboard events so far: " + snap.keys + ")");
    }
    if (snap.scrolls >= 1 && !scrollShot) {
      scrollShot = true;
      await sleep(250);
      fs.writeFileSync(path.join(RESULTS, "live-scroll.png"), (await win.webContents.capturePage()).toPNG());
      log("captured a frame while scrolling");
    }
    finished = snap.fin;
  }

  const tail = await ev("(() => { const t0 = Date.now(); return window.__ev.filter((e) => !['agent_status','cursor_state'].includes(e.event)).map((e) => ((e.__t - " + t0 + ") / 1000).toFixed(1) + 's ' + e.event + (e.action && e.action.action ? ' ' + e.action.action : '') + (e.method ? ' [' + e.method + ']' : '') + (e.summary ? ' - ' + String(e.summary).slice(0, 90) : '') + (e.level ? ' ' + e.level : '') + (e.role ? ' role=' + e.role : '') + (e.model ? ' model=' + e.model : '') + (e.error ? ' ERR ' + String(e.error).slice(0, 140) : '')); })()").catch(() => []);
  log("event timeline:\n  " + tail.join("\n  "));
  if (finished) log("RESULT:", finished.status, "|", String(finished.result || finished.error || "").slice(0, 300), "|", JSON.stringify({ steps: finished.steps, elapsedMs: Date.now() - t0, m: finished.metrics && { modelCalls: finished.metrics.modelCalls, in: finished.metrics.inputTokens, out: finished.metrics.outputTokens, screenshots: finished.metrics.screenshots, failures: finished.metrics.actionFailures, failovers: finished.metrics.failovers, models: finished.metrics.models } }));
  else log("task did not finish inside the wait window");
  log("cursor overlay was visible during the live task:", sawCursor);
  fs.writeFileSync(path.join(RESULTS, "live-final.png"), (await win.webContents.capturePage()).toPNG());
  log("final page:", await ev("(() => { const t = window.NoahRenderer.tabs().find((x) => x.active) || {}; return t.url + ' | ' + t.title; })()").catch(() => "(unknown)"));
  fs.writeFileSync(path.join(RESULTS, "live-run.json"), JSON.stringify({ when: new Date().toISOString(), note: "REAL provider from .env; local fixture shop only", finished, sawCursor, timeline: tail }, null, 2));
  return done(fx, finished && finished.status === "completed" ? 0 : 1);
}

async function done(fx, code) {
  try { await fx.close(); } catch (_) { /* ignore */ }
  app.exit(code);
}

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.whenReady().then(() => main().catch((e) => { console.error("LIVE ERROR", e); app.exit(2); }));
