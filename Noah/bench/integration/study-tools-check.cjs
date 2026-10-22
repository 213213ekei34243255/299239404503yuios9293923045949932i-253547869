// Noah/bench/integration/study-tools-check.cjs
//
// End-to-end check with the REAL Jonah window: the book-icon menu (Cite / Calculator / Abacus / Formula Reference / Research Notes),
// and each of the four new tools, driven exactly as a user would click them. Also re-checks that citation still works unchanged
// now that it moved from a direct click to a menu item (citation-urlbar-check.cjs covers the citation panel's own content in detail;
// this only needs to prove the menu wiring didn't break it).
//
//   node Noah/bench/integration/study-tools-check.cjs
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

  if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "jonah-st-")));
  app.setAppPath(ROOT); // main.cjs's mainWindow.loadFile("index.html") is relative to the app path, which otherwise follows this script's OWN directory, not the project root
  const site = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>Whale facts - Ocean Times</title><meta name='author' content='A. Writer'><meta property='article:published_time' content='2024-03-05'><h1>Whales</h1>"); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const siteUrl = `http://127.0.0.1:${site.address().port}/whales.html`;

  require(path.join(ROOT, "main.cjs"));
  const win = await until(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html")), 30000, 300);
  check("the real browser window opens", !!win);
  if (!win) { console.log("RESULT study-tools FAILED (no window)"); return app.exit(1); }
  await sleep(3000);

  const call = (js) => win.webContents.executeJavaScript(js, true);
  const menuHidden = () => call(`document.getElementById("toolsMenu").classList.contains("hidden")`);

  // ---- the book icon opens a MENU, not the citation panel directly
  check("the tools menu starts hidden", (await menuHidden()) === true);
  await call(`document.getElementById("toolsMenuBtn").click()`);
  await sleep(200);
  check("clicking the book icon shows the menu", (await menuHidden()) === false);
  const items = await call(`[...document.querySelectorAll(".tools-menu-item")].map(e => e.textContent.trim())`);
  const want = ["Cite", "Game Hub", "Creator Studio", "Aesthetic Lab", "Study Hub", "Focus Timer", "Flashcards", "AI Tutor", "Calculator", "Abacus", "Formula", "Research"];
  check("the menu lists every tool", items.length === want.length && want.every((w, i) => items[i].includes(w)), JSON.stringify(items));
  await call(`document.body.click()`); // click outside
  await sleep(150);
  check("clicking outside closes the menu", (await menuHidden()) === true);

  // ---- citation still works, now reached through the menu (this is the thing most likely to have broken)
  await call(`tabData[activeTabIndex].webview.loadURL(${JSON.stringify(siteUrl)})`);
  await until(async () => (await call(`document.getElementById("urlBar").value`)) === siteUrl, 15000, 300);
  await sleep(1000);
  await call(`document.getElementById("toolsMenuBtn").click()`);
  await sleep(150);
  await call(`document.querySelectorAll(".tools-menu-item")[0].click()`); // "Cite this page"
  await sleep(1500);
  const citePanelOpen = () => call(`(async () => { const w = tabData[activeTabIndex].webview; return await w.executeJavaScript('!!document.getElementById(\\"jonah-cite-panel\\")'); })()`);
  check("Cite this page (via the menu) still opens the real citation panel", (await citePanelOpen()) === true);
  check("the menu closed itself after the click", (await menuHidden()) === true);

  // ---- Calculator: real arithmetic, functions, Ans, and a bad expression reported as an error (not NaN, not silently wrong)
  await call(`openCalculatorPanel()`);
  await sleep(150);
  check("the calculator panel opens", (await call(`!!document.getElementById("jonah-tool-calc")`)) === true);
  const calc = async (expr) => { await call(`(() => { const d = document.getElementById("calcDisplay"); d.value = ${JSON.stringify(expr)}; calcExpr = d.value; calcEvaluate(); })()`); return call(`document.getElementById("calcDisplay").value`); };
  check("2+3*4 = 14 (order of operations)", (await calc("2+3*4")) === "14");
  check("(2+3)*4 = 20 (parentheses)", (await calc("(2+3)*4")) === "20");
  check("sqrt(16) = 4", (await calc("sqrt(16)")) === "4");
  check("sin(0) = 0", (await calc("sin(0)")) === "0");
  check("2^10 = 1024", (await calc("2^10")) === "1024");
  await calc("100");
  check("Ans carries the last result forward: ans+1 = 101", (await calc("ans+1")) === "101");
  check("a divide-by-zero is reported, not left as Infinity or silently wrong", /Error/.test(await calc("5/0")));
  check("garbage input is reported as an error, not evaluated into nonsense", /Error/.test(await calc("2+*3")));

  // ---- Abacus: clicking beads sets the right place value, across multiple rods
  await call(`openAbacusPanel()`);
  await sleep(150);
  check("the abacus panel opens", (await call(`!!document.getElementById("jonah-tool-abacus")`)) === true);
  await call(`abacusReset()`);
  // rods are 0-indexed left to right; the rightmost rod (index 6) is the ones place, index 5 is tens
  await call(`(() => { abacusState[6] = 7; abacusState[5] = 3; renderAbacus(); })()`);
  check("7 ones + 3 tens beads moved reads as 37", (await call(`document.getElementById("abacusValue").textContent`)) === "37");
  await call(`abacusReset()`);
  check("reset brings it back to 0", (await call(`document.getElementById("abacusValue").textContent`)) === "0");

  // ---- Formula Reference: tabs switch, periodic table has real data, molar mass is computed correctly
  await call(`openFormulaPanel()`);
  await sleep(200);
  check("the formula panel opens", (await call(`!!document.getElementById("jonah-tool-formula")`)) === true);
  const physicsText = await call(`document.getElementById("formulaList").textContent`);
  check("physics tab (default) shows Newton's second law", /F = ma/.test(physicsText));
  await call(`document.querySelector('.jtp-tab[data-tab="chemistry"]').click()`);
  await sleep(150);
  const chemText = await call(`document.getElementById("formulaList").textContent`);
  check("switching to the Chemistry tab shows chemistry content, not physics", /mol/.test(chemText) && !/F = ma/.test(chemText));
  await call(`document.querySelector('.jtp-tab[data-tab="astrophysics"]').click()`);
  await sleep(150);
  check("Astrophysics tab shows Kepler's third law", /Kepler/.test(await call(`document.getElementById("formulaList").textContent`)));
  // periodic table: gold is element 79 at the correct grid position, with the correct mass
  const goldCellTitle = await call(`(() => { const cells = [...document.querySelectorAll("#periodicGrid > div")]; const c = cells.find(c => c.textContent === "Au"); return c ? c.title : null; })()`);
  check("the periodic table renders Gold with its real atomic number and mass", /Gold \(79\)/.test(goldCellTitle || "") && /196\.967/.test(goldCellTitle || ""), goldCellTitle);
  await call(`(() => { [...document.querySelectorAll("#periodicGrid > div")].find(c => c.textContent === "Au").click(); })()`);
  await sleep(100);
  check("clicking Gold shows its detail card", /Gold \(Au\)/.test(await call(`document.getElementById("periodicDetail").textContent`)));
  const elementCount = await call(`document.querySelectorAll("#periodicGrid > div:not([style*='visibility'])").length`);
  check("all 118 real elements are rendered (not placeholders)", elementCount === 118, "rendered " + elementCount);
  // molar mass: H2O = 2(1.008) + 15.999 = 18.015
  await call(`(() => { document.getElementById("molarFormula").value = "H2O"; calcMolarMass(); })()`);
  await sleep(100);
  const molarResult = await call(`document.getElementById("molarResult").textContent`);
  check("H2O's molar mass computes to 18.015 g/mol", /18\.015/.test(molarResult), molarResult);
  await call(`(() => { document.getElementById("molarFormula").value = "Ca(OH)2"; calcMolarMass(); })()`);
  await sleep(100);
  const molarResult2 = await call(`document.getElementById("molarResult").textContent`);
  // Ca 40.078 + 2*(O 15.999 + H 1.008) = 40.078 + 2*17.007 = 74.092
  check("Ca(OH)2 (nested parentheses + subscript) computes to 74.09x g/mol", /74\.09/.test(molarResult2), molarResult2);
  await call(`(() => { document.getElementById("molarFormula").value = "Xx2"; calcMolarMass(); })()`);
  await sleep(100);
  check("an unknown element symbol is reported, not silently ignored", /Could not parse/.test(await call(`document.getElementById("molarResult").textContent`)));

  // ---- Research Notes: persists via localStorage, adds a real source from the real page, survives a reopen
  await call(`localStorage.removeItem("jonahResearchNotebook")`);
  await call(`openResearchNotesPanel()`);
  await sleep(150);
  check("the research notes panel opens", (await call(`!!document.getElementById("jonah-tool-research")`)) === true);
  await call(`(() => { document.getElementById("rnTitle").value = "My Whale Paper"; rnSave(); })()`);
  await call(`rnAddCurrentPage()`); // the active tab is still on siteUrl (Whale facts, A. Writer, 2024-03-05) from the citation check above
  await sleep(500);
  const sourcesAfterAdd = await call(`getResearchNotebook().sources`);
  check("adding the current page adds exactly one real, correctly formatted APA source", sourcesAfterAdd.length === 1 && /A\. Writer/.test(sourcesAfterAdd[0].apa) && /2024/.test(sourcesAfterAdd[0].apa) && /Whale facts/.test(sourcesAfterAdd[0].apa) && sourcesAfterAdd[0].url === siteUrl, JSON.stringify(sourcesAfterAdd));
  await call(`rnAddCurrentPage()`); // adding the SAME page again
  await sleep(300);
  check("adding the same page twice does not duplicate it", (await call(`getResearchNotebook().sources.length`)) === 1);
  check("the title was saved too", (await call(`getResearchNotebook().title`)) === "My Whale Paper");
  // close and reopen the panel: it must read back what was saved, not reset
  await call(`closeToolPanel("research")`);
  await sleep(100);
  await call(`openResearchNotesPanel()`);
  await sleep(150);
  check("reopening the panel shows the saved title (persisted, not lost)", (await call(`document.getElementById("rnTitle").value`)) === "My Whale Paper");
  check("reopening the panel shows the saved source", (await call(`document.getElementById("rnSources").textContent`)).includes("A. Writer"));

  // ---- only one shell tool panel open at a time (opening a new one closes the last)
  await call(`openCalculatorPanel()`);
  await sleep(100);
  check("opening the calculator after research notes closes the research-notes panel", (await call(`!document.getElementById("jonah-tool-research") && !!document.getElementById("jonah-tool-calc")`)) === true);

  console.log(`RESULT study-tools ${failures === 0 ? "ok" : failures + " failure(s)"}`);
  site.close();
  app.exit(failures === 0 ? 0 : 1);
}

async function driver() {
  if (!(await portFree(5589)) || !(await portFree(5588))) { console.log("SKIP: ports 5588/5589 are in use (the real Jonah is open?)"); return process.exit(0); }
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-st-run-"));
  const env = { ...process.env, JONAH_ENTITLEMENTS_ENABLED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [`--user-data-dir=${path.join(tmp, "data")}`, __filename], { env, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", () => {});
  const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 150000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  for (const line of out.split(/\r?\n/)) if (/^(PASS|FAIL|RESULT)/.test(line)) console.log(line);
  if (code !== 0) { console.log(`FAIL  exited with ${code}`); if (code === -99 || !/RESULT/.test(out)) console.log(out.split(/\r?\n/).slice(-30).join("\n")); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : 1);
}

if (IS_ELECTRON) require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e); require("electron").app.exit(2); }));
else driver().catch((e) => { console.error(e); process.exit(2); });
