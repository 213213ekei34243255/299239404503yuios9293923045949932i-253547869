// Noah/bench/integration/run-form-goal-generic.cjs
//
// Proves models/form-fill.cjs is NOT Google-specific: runs the real app + the real hosted model against the LOCAL
// fixture form (Noah/bench/fixtures.cjs `/form`) - a plain hand-written HTML form with a <fieldset><legend> radio
// group, a <select> dropdown, a lone checkbox, NO "required" markers at all, a password field, and a button labelled
// "Register" (not "Submit"). Deliberately as different from Google's own markup as a second real form is likely to
// be, and entirely local - no external site involved.
//
//   electron --user-data-dir=<tmp> Noah/bench/integration/run-form-goal-generic.cjs

"use strict";

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, webContents } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULTS = path.join(ROOT, "Noah", "bench", "results");
if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(require("os").tmpdir(), "noah-formgen-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[formgen]", ...a);
const { createServer } = require("../fixtures.cjs");

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  const fx = await createServer();
  const cfgDir = path.join(app.getPath("userData"), "browser-data", "noah");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "noah-config.json"), JSON.stringify({ takeover: { enabled: false }, policy: { mode: "autonomous", allowLocalhost: true }, limits: { maxSteps: 30, maxModelCalls: 40, maxWallMs: 200000 } }));
  app.getAppPath = () => ROOT;
  require(path.join(ROOT, "main.cjs"));
  let win = null;
  for (let i = 0; i < 160 && !win; i++) {
    await sleep(500);
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html"));
  }
  if (!win) { log("shell window did not open"); return app.exit(2); }
  const ev = (js, ms = 20000) => Promise.race([win.webContents.executeJavaScript(js, true), new Promise((_, rej) => setTimeout(() => rej(new Error("renderer call timed out")), ms))]);
  for (let i = 0; i < 80; i++) { await sleep(500); if (await ev("!!(window.noah && window.rexy)").catch(() => false)) break; }
  await ev("(() => { window.__ev = []; window.__confirmed = 0; window.noah.onEvent((e) => { e.__t = Date.now(); window.__ev.push(e); if (e.event === 'confirm_request') { window.__confirmed++; window.noah.confirm(e.id, true); } }); })()");
  await sleep(1000);

  const formUrl = fx.url("/form");
  const GOAL = process.env.NOAH_FORM_GOAL || `Go to ${formUrl} and fill this form up for me email id - abrahamshaunsunil@gmail.com name - Shaun Sunil`;
  log("goal:", GOAL);
  const t0 = Date.now();
  const sub = await ev(`window.rexy.goal(${JSON.stringify(GOAL)})`);
  log("submitted ->", JSON.stringify(sub));

  let fin = null;
  let lastPrinted = 0;
  while (Date.now() - t0 < 190000 && !fin) {
    await sleep(700);
    const events = await ev(`window.__ev.slice(${lastPrinted}).map((e) => ({ event: e.event, state: e.state, text: e.text, summary: e.summary, action: e.actions && e.actions[0], status: e.status, result: e.result, error: e.error }))`).catch(() => []);
    lastPrinted += events.length;
    for (const e of events) {
      if (e.event === "step") log("STEP", JSON.stringify({ summary: e.summary, action: e.action && { action: e.action.action, target: e.action.target, text: e.action.text && e.action.text.slice(0, 30) } }));
      else if (e.event === "task_finished") { fin = e; log("FINISHED", e.status, JSON.stringify(e.result || e.error || "").slice(0, 300)); }
    }
  }
  if (!fin) log("DID NOT FINISH within the wait window");

  // Read the fixture page's OWN result element directly (from the main process, on the guest's own webContents) -
  // independent, ground-truth proof of what actually happened, not just what Noah reported.
  const guest = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.hostWebContents === win.webContents && /\/form/.test(w.getURL()));
  log("final guest url:", guest ? guest.getURL() : "(no guest found)");
  if (guest) {
    const groundTruth = await guest.executeJavaScript(`({ resultText: (document.getElementById('result')||{}).textContent || '', submitted: window.__submitted || null, name: (document.getElementById('name')||{}).value, email: (document.getElementById('email')||{}).value, country: (document.getElementById('country')||{}).value, agree: (document.getElementById('agree')||{}).checked, plan: (document.querySelector('input[name=plan]:checked')||{}).value, password: (document.getElementById('pw')||{}).value })`).catch((e) => ({ error: e.message }));
    log("GROUND TRUTH from the page itself:", JSON.stringify(groundTruth));
  }
  fs.writeFileSync(path.join(RESULTS, "form-generic-final.png"), (await win.webContents.capturePage()).toPNG());
  await fx.close().catch(() => {});
  setTimeout(() => app.exit(fin && fin.status === "completed" ? 0 : 1), 500);
}

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.whenReady().then(() => main().catch((e) => { console.error("FORMGEN RUN ERROR", e); app.exit(2); }));
