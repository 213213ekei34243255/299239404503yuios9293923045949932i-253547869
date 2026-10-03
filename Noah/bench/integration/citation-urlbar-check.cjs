// Noah/bench/integration/citation-urlbar-check.cjs
//
// End-to-end check with the REAL Jonah window: (1) Jonah's own pages never put a file name or path in the address bar, whichever way
// they are reached (start page, new tab, switching tabs, the drawing tool, Home), and (2) the citation button does nothing on those pages
// and works on a real website (a local http page standing in for one).
//
//   node Noah/bench/integration/citation-urlbar-check.cjs
//
// Needs ports 5588/5589 free (the app's own servers): it skips itself if the real Jonah is open.
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const IS_ELECTRON = Boolean(process.versions.electron);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 150) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.once("listening", () => s.close(() => resolve(true))); s.listen(port, "127.0.0.1"); });

async function runner() {
  const { app, BrowserWindow } = require("electron");
  let failures = 0;
  const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };

  if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "jonah-cu-")));
  // a stand-in "website": any http page that is not Jonah's own server
  const site = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>Whale facts</title><meta name='author' content='A. Writer'><h1>Whales</h1>"); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const siteUrl = `http://127.0.0.1:${site.address().port}/whales.html`;

  require(path.join(ROOT, "main.cjs"));
  const win = await until(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html")), 30000, 300);
  check("the real browser window opens", !!win);
  if (!win) { console.log("RESULT citation-urlbar FAILED (no window)"); return app.exit(1); }
  await sleep(3000);
  const call = (js) => win.webContents.executeJavaScript(js, true);
  const bar = () => call(`document.getElementById("urlBar").value`);
  const citeDisabled = () => call(`document.querySelector(".cite-btn").classList.contains("disabled")`);
  const panelOpen = () => call(`(async () => { const w = tabData[activeTabIndex].webview; return await w.executeJavaScript('!!document.getElementById("jonah-cite-panel")'); })()`);
  const spyReset = () => call(`(() => { const w = tabData[activeTabIndex].webview; window.__runs = 0; if (!w.__orig) { w.__orig = w.executeJavaScript.bind(w); } w.executeJavaScript = (...a) => { window.__runs++; return w.__orig(...a); }; })()`);
  const spyRuns = () => call(`window.__runs`);

  // ---- Jonah's own pages: no file name in the bar
  check("start page: the address bar is empty", (await bar()) === "", JSON.stringify(await bar()));
  check("start page: the citation button is shown disabled", (await citeDisabled()) === true);
  await spyReset();
  await call(`openCitationOverlay()`);
  await sleep(500);
  check("start page: clicking Cite does NOTHING (nothing is run inside the page)", (await spyRuns()) === 0, "runs=" + (await spyRuns()));

  await call(`createNewTab("home.html")`);
  await sleep(2500);
  check("new tab: the bar is empty (not 'home.html' or a path)", (await bar()) === "", JSON.stringify(await bar()));
  await call(`switchTab(0)`); await sleep(300);
  check("switching to tab 1: still empty", (await bar()) === "", JSON.stringify(await bar()));
  await call(`switchTab(1)`); await sleep(300);
  check("switching to tab 2: still empty", (await bar()) === "", JSON.stringify(await bar()));

  await call(`openDrawingTool()`);
  await sleep(2500);
  check("drawing tool (toy-paint.html): the bar is empty", (await bar()) === "", JSON.stringify(await bar()));
  check("drawing tool: Cite is disabled", (await citeDisabled()) === true);
  await call(`switchTab(0)`); await sleep(200); await call(`switchTab(1)`); await sleep(300);
  check("coming back to the drawing-tool tab: the bar is still empty", (await bar()) === "", JSON.stringify(await bar()));
  const barEverShowedAFile = await call(`/\\.html|file:|[A-Za-z]:\\\\\\\\/i.test(document.getElementById("urlBar").value)`);
  check("nothing in the bar looks like a file name or path", barEverShowedAFile === false);

  // ---- a real website: the bar shows it and Cite works
  await call(`tabData[activeTabIndex].webview.loadURL(${JSON.stringify(siteUrl)})`);
  await until(async () => (await bar()) === siteUrl, 15000, 300);
  await sleep(1200);
  check("website: the address bar shows its real address", (await bar()) === siteUrl, JSON.stringify(await bar()));
  check("website: the citation button is enabled", (await citeDisabled()) === false);
  await call(`openCitationOverlay()`);
  await sleep(1500);
  check("website: clicking Cite opens the citation panel", (await panelOpen()) === true);

  // ---- back home: blocked again
  await call(`goHome()`);
  await sleep(2500);
  check("back on the start page: the bar is empty again", (await bar()) === "", JSON.stringify(await bar()));
  check("back on the start page: Cite is disabled again", (await citeDisabled()) === true);

  console.log(`RESULT citation-urlbar ${failures === 0 ? "ok" : failures + " failure(s)"}`);
  site.close();
  app.exit(failures === 0 ? 0 : 1);
}

async function driver() {
  if (!(await portFree(5589)) || !(await portFree(5588))) { console.log("SKIP: ports 5588/5589 are in use (the real Jonah is open?)"); return process.exit(0); }
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-cu-run-"));
  const env = { ...process.env, JONAH_ENTITLEMENTS_ENABLED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [`--user-data-dir=${path.join(tmp, "data")}`, __filename], { env, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", () => {});
  const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 150000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  for (const line of out.split(/\r?\n/)) if (/^(PASS|FAIL|RESULT)/.test(line)) console.log(line);
  if (code !== 0) { console.log(`FAIL  exited with ${code}`); if (code === -99 || !/RESULT/.test(out)) console.log(out.split(/\r?\n/).slice(-25).join("\n")); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : 1);
}

if (IS_ELECTRON) require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e); require("electron").app.exit(2); }));
else driver().catch((e) => { console.error(e); process.exit(2); });
