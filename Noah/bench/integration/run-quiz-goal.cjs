// Noah/bench/integration/run-quiz-goal.cjs
//
// Live end-to-end check of the "answers every question with option 1" bug: boots the real app, gives the real agent (and the real
// hosted model) the goal "solve this quiz" against a LOCAL fixture quiz whose correct option is never the first, then reads the
// page's OWN state - which option is selected in each question and the score - as ground truth. Not a self-report.
//
//   electron --user-data-dir=<tmp> Noah/bench/integration/run-quiz-goal.cjs
//   env: NOAH_QUIZ_PATH=/quiz | /quiz-flat | /quiz-fieldset | /quiz-aria | /quiz-gk    NOAH_QUIZ_GOAL="..."

"use strict";

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, webContents } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULTS = path.join(ROOT, "Noah", "bench", "results");
if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(require("os").tmpdir(), "noah-quiz-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[quiz]", ...a);
const { createServer } = require("../fixtures.cjs");

// NOAH_DEBUG_FRAMES=1: report the frame tree whenever the page's measured viewport looks like a small embedded frame, not the page
if (process.env.NOAH_DEBUG_FRAMES) {
  const { CdpSession } = require(path.join(ROOT, "Noah", "browser", "cdp.cjs"));
  const orig = CdpSession.prototype.layoutMetrics;
  let reported = 0;
  CdpSession.prototype.layoutMetrics = async function (...a) {
    const m = await orig.apply(this, a);
    if (m.width < 400 && reported++ < 3) {
      const tree = await this.send("Page.getFrameTree").catch((e) => ({ error: e.message }));
      const flat = (t, d = 0) => (t.frame ? [`${"  ".repeat(d)}${t.frame.id.slice(0, 8)} parent=${t.frame.parentId ? t.frame.parentId.slice(0, 8) : "-"} ${String(t.frame.url).slice(0, 70)}`, ...(t.childFrames || []).flatMap((c) => flat(c, d + 1))] : [JSON.stringify(t).slice(0, 100)]);
      console.log(`[frames] measured viewport ${m.width}x${m.height}; noah mainFrameId=${String(this.mainFrameId).slice(0, 8)}; oopif sessions=${this.children.size}; wc url=${this.wc.getURL()}`);
      console.log("[frames] tree:\n" + flat(tree.frameTree || tree).join("\n"));
      const probe = "({ href: location.href, isTop: window === window.top, w: innerWidth, h: innerHeight, textLen: (document.body ? document.body.innerText : '').length, frames: frames.length })";
      const inWorld = await this.evaluate(probe).catch((e) => ({ error: e.message }));
      const inMain = await this.send("Runtime.evaluate", { expression: probe, returnByValue: true }).then((r) => r.result.value).catch((e) => ({ error: e.message }));
      console.log("[frames] noah isolated world says:", JSON.stringify(inWorld));
      console.log("[frames] the page's own world says:", JSON.stringify(inMain));
      console.log("[frames] cached worlds:", JSON.stringify([...this._worlds.entries()]), "navigationCount:", this.navigationCount);
    }
    return m;
  };
}

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  const fx = await createServer();
  const cfgDir = path.join(app.getPath("userData"), "browser-data", "noah");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "noah-config.json"), JSON.stringify({ takeover: { enabled: false }, policy: { mode: "autonomous", allowLocalhost: true }, limits: { maxSteps: Number(process.env.NOAH_QUIZ_MAXSTEPS) || 80, maxModelCalls: 120, maxWallMs: process.env.NOAH_QUIZ_URL || process.env.NOAH_QUIZ_PATH === "/real-quiz" ? 1500000 : process.env.NOAH_QUIZ_PATH === "/written" ? 480000 : 240000 } }));
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
  await ev("(() => { window.__ev = []; window.noah.onEvent((e) => { e.__t = Date.now(); window.__ev.push(e); if (e.event === 'confirm_request') window.noah.confirm(e.id, true); }); })()");
  await sleep(1000);

  const quizPath = process.env.NOAH_QUIZ_PATH || "/quiz";
  const external = process.env.NOAH_QUIZ_URL; // a real, public page instead of a local fixture
  const url = external || fx.url(quizPath);
  // NOAH_QUIZ_GOAL may contain {url}, replaced with the fixture page's address (its port is random)
  const GOAL = (process.env.NOAH_QUIZ_GOAL || `Go to {url} and solve this quiz, then submit it`).replace("{url}", url);
  log("goal:", GOAL);
  const t0 = Date.now();
  const sub = await ev(`window.rexy.goal(${JSON.stringify(GOAL)})`);
  log("submitted ->", JSON.stringify(sub));

  let fin = null;
  let printed = 0;
  const written = quizPath === "/written" || quizPath === "/real-quiz" || !!external;
  const waitMs = external || quizPath === "/real-quiz" ? 1400000 : written ? 470000 : 230000; // written solutions: each answer is a long generation from the hosted model
  while (Date.now() - t0 < waitMs && !fin) {
    await sleep(700);
    const events = await ev(`window.__ev.slice(${printed}).map((e) => ({ event: e.event, summary: e.summary, action: e.actions && e.actions[0], n: e.actions && e.actions.length, status: e.status, result: e.result, error: e.error }))`).catch(() => []);
    printed += events.length;
    for (const e of events) {
      if (e.event === "step") log("STEP", JSON.stringify({ summary: e.summary, actions: e.n, first: e.action && { action: e.action.action, target: e.action.target } }));
      else if (e.event === "task_finished") { fin = e; log("FINISHED", e.status, JSON.stringify(e.result || e.error || "").slice(0, 300)); }
    }
  }
  if (!fin) log("DID NOT FINISH within the wait window");

  const guest = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.hostWebContents === win.webContents && w.getURL().includes(external ? new URL(external).host : quizPath));
  let truth = null;
  if (guest) {
    truth = await guest.executeJavaScript(`({ answers: window.__answers ? window.__answers() : Array.from(document.querySelectorAll('textarea')).map((t) => t.value), score: window.__score === undefined ? null : window.__score, result: (document.getElementById('result')||{}).textContent || '' })`).catch((e) => ({ error: e.message }));
    log("GROUND TRUTH from the page itself:", JSON.stringify(truth));
  } else log("no guest page found for", quizPath);
  fs.writeFileSync(path.join(RESULTS, "quiz-final.png"), (await win.webContents.capturePage()).toPNG());
  const total = truth && truth.answers ? truth.answers.length : 0;
  let pass = truth && truth.score === total && total > 0;
  if (written) {
    // Written solutions have no score: every box must hold a REAL answer (not empty, not "please provide the questions"), each different.
    const { looksLikeNonAnswer } = require(path.join(ROOT, "Noah", "models", "completion-guard.cjs"));
    const a = (truth && truth.answers) || [];
    a.filter(Boolean).forEach((v, i) => log(`ANSWER ${i + 1} (${v.length} chars, ${looksLikeNonAnswer(v) ? "NOT AN ANSWER" : "ok"}): ${JSON.stringify(v.replace(/\s+/g, " ").slice(0, 110))}`));
    const filled = a.filter(Boolean);
    const real = filled.filter((v) => !looksLikeNonAnswer(v));
    const latex = filled.filter((v) => /\\(?:frac|int|sum|sqrt|cdot|left|right|begin)|\$/.test(v)).length;
    log(`FORMAT: ${filled.length} boxes filled, ${real.length} real answers, ${latex} still contain LaTeX; page says: ${JSON.stringify((truth.result || "").slice(0, 60))}`);
    pass = process.env.NOAH_QUIZ_MAXSTEPS ? filled.length >= 8 && real.length === filled.length && latex === 0 && !truth.result : a.length > 0 && a.every((v) => v && !looksLikeNonAnswer(v)) && new Set(a).size === a.length;
    log(`RESULT: ${a.filter((v) => v && !looksLikeNonAnswer(v)).length}/${a.filter(Boolean).length} filled boxes hold a real answer; agent ${fin ? fin.status : "unfinished"}`);
  } else {
    log(`RESULT: score ${truth && truth.score !== null ? truth.score : "not submitted"}/${total}; agent ${fin ? fin.status : "unfinished"}`);
  }
  await fx.close().catch(() => {});
  setTimeout(() => app.exit(pass ? 0 : 1), 500);
}

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.whenReady().then(() => main().catch((e) => { console.error("QUIZ RUN ERROR", e); app.exit(2); }));
