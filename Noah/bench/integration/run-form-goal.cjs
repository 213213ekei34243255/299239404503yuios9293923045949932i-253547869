// Noah/bench/integration/run-form-goal.cjs
//
// LIVE DIAGNOSTIC: the real Jonah app, the real hosted model, the real public Google Form from the bug report. Submits
// the user's exact instruction and prints every action taken step by step, so a navigation loop (or any other failure
// to progress) is visible directly rather than guessed at.
//
//   electron --user-data-dir=<tmp> Noah/bench/integration/run-form-goal.cjs

"use strict";

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULTS = path.join(ROOT, "Noah", "bench", "results");
if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(require("os").tmpdir(), "noah-form-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[form]", ...a);
const GOAL =
  process.env.NOAH_FORM_GOAL ||
  "Go to this website and then answer all the questions on the google form scroll and check and then submit it as well my name is Shaun Sunil and email id is abrahamshaunsunil@gmail.com https://docs.google.com/forms/d/e/1FAIpQLSc9MrvjWOr-iNrVmoiwfVvpuxDL9qj4n2LuCwt4jZaeBrbH5w/viewform";

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  const cfgDir = path.join(app.getPath("userData"), "browser-data", "noah");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "noah-config.json"), JSON.stringify({ takeover: { enabled: false }, policy: { mode: "autonomous" }, limits: { maxSteps: 40, maxModelCalls: 50, maxWallMs: 280000 } }));
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
  // Auto-approve every confirmation, exactly the way a person clicking "Allow" on the confirm card would - so this
  // diagnostic actually reaches what happens AFTER the user approves entering their own name/email, instead of only
  // ever exercising an unattended confirmation timing out.
  await ev("(() => { window.__ev = []; window.__confirmed = 0; window.noah.onEvent((e) => { e.__t = Date.now(); window.__ev.push(e); if (e.event === 'confirm_request') { window.__confirmed++; window.noah.confirm(e.id, true); } }); })()");
  await sleep(1000);

  log("goal:", GOAL);
  const t0 = Date.now();
  const sub = await ev(`window.rexy.goal(${JSON.stringify(GOAL)})`);
  log("submitted ->", JSON.stringify(sub));

  let fin = null;
  let lastPrinted = 0;
  while (Date.now() - t0 < 270000 && !fin) {
    await sleep(800);
    const events = await ev(`window.__ev.slice(${lastPrinted}).map((e) => ({ event: e.event, state: e.state, text: e.text, summary: e.summary, action: e.actions && e.actions[0], status: e.status, result: e.result, error: e.error, question: e.question, level: e.level, reason: e.reason }))`).catch(() => []);
    lastPrinted += events.length;
    for (const e of events) {
      if (e.event === "step") log("STEP", JSON.stringify({ summary: e.summary, action: e.action && { action: e.action.action, url: e.action.url, target: e.action.target, text: e.action.text && e.action.text.slice(0, 40) } }));
      else if (e.event === "session_state") log("STATE", e.state, e.text || "");
      else if (e.event === "ask_user") log("ASK_USER", e.question);
      else if (e.event === "confirm_request") log("CONFIRM", e.summary);
      else if (e.event === "safety") log("SAFETY", e.level, e.reason || "");
      else if (e.event === "task_finished") { fin = e; log("FINISHED", e.status, JSON.stringify(e.result || e.error || "").slice(0, 300)); }
    }
  }
  if (!fin) log("DID NOT FINISH within the wait window");

  const url = await ev("document.querySelector('webview') ? document.querySelector('webview').getURL() : ''").catch(() => "");
  log("final url:", url);
  fs.writeFileSync(path.join(RESULTS, "form-final.png"), (await win.webContents.capturePage()).toPNG());
  setTimeout(() => app.exit(fin && fin.status === "completed" ? 0 : 1), 500);
}

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.whenReady().then(() => main().catch((e) => { console.error("FORM RUN ERROR", e); app.exit(2); }));
