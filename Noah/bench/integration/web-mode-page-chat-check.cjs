// Noah/bench/integration/web-mode-page-chat-check.cjs
//
// REAL app + REAL services (needs internet):
//  A. chat summarizes the page that is open in the active tab (the real chat server answers; the page is sent as page_content)
//  B. in Web agent mode "turn on the radio on the screen play it. click once" is NOT refused as a computer job, the homepage radio button now has a name the agent can see,
//     and the real Web agent (real model) is run on it: whether the radio actually starts playing is REPORTED, not assumed.
//
//   node Noah/bench/integration/web-mode-page-chat-check.cjs
//
// Needs ports 5588/5589 free: it skips itself if the real Jonah is open.
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
async function until(fn, ms, step = 250) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.once("listening", () => s.close(() => resolve(true))); s.listen(port, "127.0.0.1"); });

async function runner() {
  const { app, BrowserWindow, webContents } = require("electron");
  let failures = 0;
  const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + String(detail).replace(/\s+/g, " ").slice(0, 300) : ""}`); };
  const info = (text) => console.log("INFO  " + String(text).replace(/\s+/g, " ").slice(0, 400));

  if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "jonah-wm-")));
  app.setAppPath(ROOT);

  const ARTICLE = "<!doctype html><title>Zorblax Expedition News</title><body><h1>Zorblax Expedition reaches the northern ridge</h1>"
    + "<p>The Zorblax Expedition reached the northern ridge on Tuesday after eleven days of climbing. Team leader Mara Quill said the group found three new glacier lakes and mapped forty kilometres of unexplored valley.</p>"
    + "<p>The expedition doctor, Pavel Dunn, reported that everyone was healthy. The team plans to descend through the eastern pass next week and publish its maps in spring.</p>"
    + "<p>Local guides described the weather as unusually calm for the season, which allowed the team to carry out extra survey work with drones.</p></body>";
  const server = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(q.url.startsWith("/empty") ? "<!doctype html><title>Empty</title><body></body>" : ARTICLE); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  require(path.join(ROOT, "main.cjs"));
  const win = await until(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html")), 30000, 300);
  check("the real browser window opens", !!win);
  if (!win) { console.log("RESULT web-mode-page-chat FAILED (no window)"); return app.exit(1); }
  await sleep(4000);
  const call = (js) => win.webContents.executeJavaScript(js, true);
  const guests = () => webContents.getAllWebContents().filter((w) => w.getType() === "webview");

  // collect every goal event the panel would see
  await call(`window.__ev = []; rexy.onGoalCompleted((d) => __ev.push({ t: "completed", d })); rexy.onGoalError((d) => __ev.push({ t: "error", d: String((d && (d.error || d.message)) || d) })); rexy.onGoalBlocked((d) => __ev.push({ t: "blocked", d })); if (window.noah && noah.onEvent) noah.onEvent((e) => __ev.push({ t: "noah", d: e })); 0`);
  const ask = async (goal, mode, waitMs = 90000) => {
    const before = await call(`__ev.length`);
    const r = await call(`rexy.goal(${JSON.stringify(goal)}, { mode: ${JSON.stringify(mode)} })`);
    const ev = await until(async () => { const l = await call(`__ev.slice(${before})`); return l.find((e) => e.t === "completed" || e.t === "error" || e.t === "blocked") || null; }, waitMs, 400);
    return { r, ev };
  };
  const replyOf = (ev) => (ev && ev.t === "completed" ? String((ev.d && (ev.d.reason || ev.d.result || ev.d.text)) || "") : "");

  // ================================================================ A. summarize the open page with chat
  await call(`tabData[activeTabIndex].webview.loadURL(${JSON.stringify(base + "/")}); 0`);
  await until(async () => /Zorblax/.test(String(await call(`tabData[activeTabIndex].webview.getTitle()`))), 15000, 300);
  await sleep(800);
  const a1 = await ask("summarize this page", "chat");
  check("Chat: 'summarize this page' is answered as chat (not an agent run)", a1.r && a1.r.success && a1.r.kind === "chat", JSON.stringify(a1.r));
  const s1 = replyOf(a1.ev);
  check("Chat: the REAL model's summary is about the page that is open", /zorblax|mara quill|glacier|ridge|expedition/i.test(s1), s1);
  check("Chat: it did not say it cannot see the page", !/(cannot|can't|unable to) (see|access|read|browse)|don't have access|no page/i.test(s1), s1.slice(0, 120));
  const a2 = await ask("what is this page about?", "auto");
  check("Auto: 'what is this page about?' also goes to chat and answers from the page", a2.r && a2.r.kind === "chat" && /zorblax|expedition|glacier|ridge/i.test(replyOf(a2.ev)), `${a2.r && a2.r.kind}: ${replyOf(a2.ev)}`);
  const a3 = await ask("who is the team leader? answer in one short sentence", "chat");
  info("a question with no 'page' word is a normal chat message; reply: " + replyOf(a3.ev));
  check("a normal chat question is NOT treated as a page question (still no page attached: it need not know the leader)", a3.r && a3.r.success && a3.r.kind === "chat");
  await call(`tabData[activeTabIndex].webview.loadURL(${JSON.stringify(base + "/empty")}); 0`); await sleep(2500);
  const a4 = await ask("summarize this page", "chat", 30000);
  check("an empty page gets an honest answer, not an invented summary", /could not find readable text/i.test(replyOf(a4.ev)), replyOf(a4.ev));

  // ================================================================ B. the homepage radio in Web agent mode
  await call(`createNewTab("home.html"); 0`); await sleep(5000);
  const home = await until(() => guests().find((g) => /home\.html$/.test(g.getURL().split("?")[0])), 15000, 300);
  check("the home page is open", !!home);
  const hv = (js) => home.executeJavaScript(js, true);
  check("the radio's play button has a name the agent can read ('Play radio')", (await hv(`document.getElementById("playBtn").getAttribute("aria-label")`)) === "Play radio");
  // what the AGENT's accessibility view contains
  let axNames = [];
  try {
    home.debugger.attach("1.3"); await home.debugger.sendCommand("Accessibility.enable");
    const tree = await home.debugger.sendCommand("Accessibility.getFullAXTree");
    axNames = tree.nodes.filter((n) => n.role && n.role.value === "button" && n.name && n.name.value).map((n) => n.name.value);
    home.debugger.detach();
  } catch (e) { info("could not read the accessibility tree: " + e.message); try { home.debugger.detach(); } catch (_) { /* not attached */ } }
  check("in the accessibility tree the radio is a named button (it was an unnamed icon before)", axNames.includes("Play radio"), axNames.slice(0, 8).join(" | "));
  const unnamed = await hv(`[...document.querySelectorAll("button, select, input[type=range]")].filter(e => e.offsetParent !== null && !(e.getAttribute("aria-label") || e.title || e.textContent.trim() || e.getAttribute("placeholder"))).map(e => e.id || e.className).slice(0, 8)`);
  info("home page controls still without any name: " + JSON.stringify(unnamed));

  // diagnostic only (STRIP_LABEL=1): put the button back to its OLD unnamed state, to see whether the missing name was part of why the agent could not find the radio
  if (process.env.STRIP_LABEL === "1") { await hv(`(() => { const b = document.getElementById("playBtn"); b.removeAttribute("aria-label"); b.removeAttribute("title"); })()`); info("DIAGNOSTIC: the play button was stripped of its name"); }
  const RADIO = "turn on the radio on the screen play it. click once";
  const b1 = await call(`rexy.goal(${JSON.stringify(RADIO)}, { mode: "web" })`);
  check("Web mode: the radio request is ACCEPTED as a browser job (before: refused as a computer job)", b1 && b1.success === true && b1.kind === "agent", JSON.stringify(b1));
  const bad = await call(`__ev.filter(e => e.t === "noah" && /computer|Switch to Computer agent/i.test(JSON.stringify(e.d))).length`);
  check("no 'Switch to Computer agent' refusal was shown", bad === 0);
  // wait for the real agent to act: the page's own state tells the truth
  const playing = await until(async () => { try { return await hv(`(() => { const a = document.getElementById("radioStream"); return !!a && !a.paused && !a.ended && document.getElementById("playBtn").getAttribute("aria-label") === "Pause radio"; })()`); } catch (_) { return false; } }, 150000, 1500);
  const evs = await call(`__ev.filter(e => e.t === "noah").map(e => (e.d && (e.d.event || e.d.type || "")) + (e.d && e.d.status ? ":" + e.d.status : "")).slice(-14)`);
  info("agent events: " + JSON.stringify(evs));
  const state = await hv(`(() => { const a = document.getElementById("radioStream"); return JSON.stringify({ paused: a.paused, src: (a.currentSrc || a.src || "").slice(0, 60), label: document.getElementById("playBtn").getAttribute("aria-label"), station: document.getElementById("stationNameEl").textContent, err: a.error && a.error.code }); })()`);
  info("radio state after the agent ran: " + state);
  check("the REAL Web agent found the radio and started it (the page's own audio element is playing)", !!playing, state);
  await call(`noah.stop(); 0`).catch(() => {});

  console.log(failures ? `RESULT web-mode-page-chat FAILED (${failures} failing)` : "RESULT web-mode-page-chat ok");
  server.close();
  app.exit(failures ? 1 : 0);
}

async function driver() {
  if (!(await portFree(5589)) || !(await portFree(5588))) { console.log("SKIP: ports 5588/5589 are in use (the real Jonah is open?)"); return process.exit(0); }
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-wm-run-"));
  const env = { ...process.env, JONAH_ENTITLEMENTS_ENABLED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [`--user-data-dir=${path.join(tmp, "data")}`, __filename], { env, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", () => {});
  const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 480000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  for (const line of out.split(/\r?\n/)) if (/^(PASS|FAIL|RESULT|INFO)/.test(line)) console.log(line);
  if (code !== 0) { console.log(`FAIL  exited with ${code}`); if (code === -99 || !/RESULT/.test(out)) console.log(out.split(/\r?\n/).slice(-30).join("\n")); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : 1);
}

if (IS_ELECTRON) require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e); require("electron").app.exit(2); }));
else driver().catch((e) => { console.error(e); process.exit(2); });
