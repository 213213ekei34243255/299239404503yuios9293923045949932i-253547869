// Noah/bench/integration/run-code.cjs
//
// LIVE: the real Jonah app, the real hosted model and the REAL online-python.com (an Ace code editor). Gives the agent the
// request that used to fail ("write a whole big program of palindrome ... on the page code snippet": the editor stayed empty
// while the chat said "Typed the text once.") and then reads the code back out of the editor itself.
//
//   electron --user-data-dir=<tmp> Noah/bench/integration/run-code.cjs
//
// Override the request with NOAH_CODE_GOAL. Needs network. The takeover monitor is off so a person using the machine cannot
// pause the run; everything checked is read from the page's own editor.

"use strict";

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { app, BrowserWindow, webContents } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULTS = path.join(ROOT, "Noah", "bench", "results");
if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(require("os").tmpdir(), "noah-code-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[code]", ...a);
const GOAL = process.env.NOAH_CODE_GOAL || "do me a favour write a whole big program of palindrome accepting 30 different input numbers including fibonacci tribonacci on the page code snippet";
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: !!pass, detail: String(detail).slice(0, 300) });
  log(pass ? "PASS" : "FAIL", name, detail ? "| " + String(detail).slice(0, 260) : "");
};

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  const cfgDir = path.join(app.getPath("userData"), "browser-data", "noah");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "noah-config.json"), JSON.stringify({ takeover: { enabled: false }, policy: { mode: "autonomous" }, limits: { maxSteps: 30, maxModelCalls: 40, maxWallMs: 240000 } }));
  app.getAppPath = () => ROOT;
  require(path.join(ROOT, "main.cjs"));
  let win = null;
  for (let i = 0; i < 160 && !win; i++) {
    await sleep(500);
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html"));
  }
  if (!win) { log("shell window did not open"); return app.exit(2); }
  const ev = (js, ms = 20000) => Promise.race([win.webContents.executeJavaScript(js, true), new Promise((_, rej) => setTimeout(() => rej(new Error("renderer call timed out")), ms))]);
  for (let i = 0; i < 80; i++) { await sleep(500); if (await ev("!!(window.noah && window.rexy && document.getElementById('noahOverlay'))").catch(() => false)) break; }
  await ev("(() => { window.__ev = []; window.noah.onEvent((e) => { e.__t = Date.now(); window.__ev.push(e); }); })()");
  await ev(`document.querySelector('webview').loadURL('https://www.online-python.com/')`);
  await sleep(9000);

  const guest = () => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.hostWebContents === win.webContents && /online-python/.test(w.getURL()));
  const readEditor = async () => (guest() ? guest().executeJavaScript("(() => { try { const a = document.querySelector('.ace_editor'); return window.ace.edit(a).getValue(); } catch (e) { return null; } })()").catch(() => null) : null);
  const before = await readEditor();
  log("editor before:", JSON.stringify(String(before).slice(0, 80)), "| lines:", String(before).split("\n").length);

  const t0 = Date.now();
  const sub = await ev(`window.rexy.goal(${JSON.stringify(GOAL)})`);
  log("submitted ->", JSON.stringify(sub));
  let fin = null;
  while (Date.now() - t0 < 200000 && !fin) {
    await sleep(500);
    fin = await ev("window.__ev.find((e) => e.event === 'task_finished') || null").catch(() => null);
  }
  await sleep(1500);
  const steps = await ev("window.__ev.filter((e) => e.event === 'step').map((e) => (e.actions || []).map((a) => a.action + (a.mode ? '[' + a.mode + ']' : '')).join('+'))");
  log("steps:", JSON.stringify(steps), "| result:", fin ? fin.status + " - " + String(fin.result || fin.error).slice(0, 200) : "NO TERMINAL EVENT", "| " + Math.round((Date.now() - t0) / 1000) + "s");

  log("timeline:", JSON.stringify(await ev("window.__ev.filter((e) => ['session_state','safety','ask_user','confirm_request','task_finished'].includes(e.event)).map((e) => ((e.__t - window.__ev[0].__t) / 1000).toFixed(1) + 's ' + e.event + ' ' + (e.state || e.level || e.status || '') + ' ' + (e.reason || e.text || e.error || '')).slice(0, 40)")));
  const code = await readEditor();
  fs.writeFileSync(path.join(RESULTS, "code-editor-content.txt"), String(code));
  fs.writeFileSync(path.join(RESULTS, "code-final.png"), (await win.webContents.capturePage()).toPNG());
  check("the run finished as completed", !!fin && fin.status === "completed", fin && (fin.result || fin.error));
  check("the editor now holds a program (more than 8 lines, with def / for / print)", typeof code === "string" && code.split("\n").length > 8 && /\bdef\b/.test(code) && /\bprint\b/.test(code), `${String(code).split("\n").length} lines`);
  check("the site's starter code was replaced, not left in front of the program", typeof code === "string" && !/Online Python - IDE, Editor, Compiler, Interpreter/.test(code) && !/Enter 1st number/.test(code));
  check("the code is intact (no autocomplete/auto-indent corruption: every 'def' line is well-formed and indentation is 4-space multiples)", typeof code === "string" && code.split("\n").every((l) => !/^\s*def\s/.test(l) || /^\s*def\s+[A-Za-z_]\w*\s*\(.*\)\s*:/.test(l)) && code.split("\n").every((l) => !/^ +\S/.test(l) || (l.match(/^ */)[0].length % 4 === 0)), "");
  const py = spawnSync("python", ["-c", "import ast,sys; ast.parse(sys.stdin.read()); print('syntax ok')"], { input: String(code), encoding: "utf8" });
  if (py.error) log("(python is not installed on this machine: syntax not compiled)");
  else check("the code compiles as Python (ast.parse)", py.status === 0, (py.stdout + py.stderr).trim().split("\n").pop());
  check("no false success: the chat's final message is only 'done' because the code is really in the editor", !!fin && (fin.status !== "completed" || (typeof code === "string" && code.length > 100)));
  fs.writeFileSync(path.join(RESULTS, "code-run.json"), JSON.stringify({ when: new Date().toISOString(), goal: GOAL, results, steps, finished: fin && { status: fin.status, result: fin.result, error: fin.error } }, null, 2));
  const failed = results.filter((r) => !r.pass);
  log(`SUMMARY ${results.length - failed.length}/${results.length} passed`);
  setTimeout(() => app.exit(failed.length ? 1 : 0), 500);
}

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.whenReady().then(() => main().catch((e) => { console.error("CODE RUN ERROR", e); app.exit(2); }));
