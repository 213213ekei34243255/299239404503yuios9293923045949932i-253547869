// Noah/test/fixtures/web-fixture-app.cjs - a small Electron window that BEHAVES LIKE A CHAT WEB APP (the shape of WhatsApp Web), used ONLY by the computer-agent tests.
//
// It is Chromium, the same engine as Edge and Chrome, so what the Windows helper can and cannot see in it is what it can see in a web page there: a chat list of
// contacts (role=listitem rows), a message box (a contenteditable role=textbox), a Send button, and a log of what was sent. Clicking a contact opens its chat; Send appends
// what was typed to the log and clears the box. The page reports every real click and key to the file named by NOAH_FIXTURE_LOG (JSON lines), so a test can prove WHAT was
// clicked, independently of what Noah believes it did.
//
//   electron --user-data-dir=<tmp> Noah/test/fixtures/web-fixture-app.cjs --title="Noah Web Fixture X" [--left=100 --top=100 --width=1100 --height=700] [--maximize]
//
// Closes itself after --seconds (default 180).
"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const TITLE = arg("title", "Noah Web Fixture");
const LOG = process.env.NOAH_FIXTURE_LOG || "";

const NAMES = ["Aaron Pereira", "Ansuman Bhattacharjee", "Alwin Devasia", "Sancharie", "Sunil BSNL", "Jeevith K", "Sahil Verma", "Priya Nair", "Rahul Menon", "Meera Iyer", "Karthik S", "Divya Rao", "Farhan Ali", "Neha Gupta", "Omar Sheikh", "Lakshmi P", "Vikram Das", "Tara Joseph", "Yusuf Khan", "Zoya Mir", "Arjun Pillai", "Bina Thomas", "Chetan Rao", "Deepa Nair", "Esha Kapoor", "Faisal Khan", "Gita Menon", "Harsh Vora", "Ira Sen", "Jay Patel"];

const PAGE = `<!doctype html><meta charset="utf-8"><title>${TITLE}</title>
<style>
  html, body { margin: 0; height: 100%; font: 14px 'Segoe UI', sans-serif; background: #111b21; color: #e9edef; }
  #app { display: flex; height: 100%; }
  #side { width: 340px; border-right: 1px solid #2a3942; display: flex; flex-direction: column; }
  #side h1 { margin: 0; padding: 14px 16px; font-size: 18px; }
  #list { overflow: auto; flex: 1; }
  .chat { padding: 12px 16px; border-bottom: 1px solid #202c33; cursor: pointer; }
  .chat:hover { background: #202c33; }
  .chat.on { background: #2a3942; }
  .chat .n { font-weight: 600; }
  .chat .l { color: #8696a0; font-size: 12px; }
  #main { flex: 1; display: flex; flex-direction: column; }
  #head { padding: 14px 16px; border-bottom: 1px solid #2a3942; font-weight: 600; }
  #log { flex: 1; overflow: auto; padding: 12px 16px; }
  .msg { background: #005c4b; border-radius: 8px; padding: 6px 10px; margin: 4px 0; width: fit-content; max-width: 70%; }
  #bar { display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid #2a3942; align-items: center; }
  #box { flex: 1; min-height: 20px; max-height: 120px; overflow: auto; background: #2a3942; border-radius: 8px; padding: 9px 12px; outline: none; }
  #box:empty:before { content: attr(data-placeholder); color: #8696a0; }
  #send { background: #00a884; color: #fff; border: 0; border-radius: 50%; width: 42px; height: 42px; font-size: 18px; cursor: pointer; }
</style>
<div id="app">
  <div id="side"><h1>Chats</h1><div id="list" role="list" aria-label="Chat list"></div></div>
  <div id="main">
    <div id="head">Select a chat</div>
    <div id="log" aria-label="Messages"></div>
    <div id="bar">
      <div id="box" contenteditable="true" role="textbox" aria-label="Type a message" data-placeholder="Type a message"></div>
      <button id="send" type="button" aria-label="Send">&#10148;</button>
    </div>
  </div>
</div>
<script>
  const names = ${JSON.stringify(NAMES)};
  const list = document.getElementById("list"), head = document.getElementById("head"), log = document.getElementById("log"), box = document.getElementById("box");
  let current = null;
  const report = (o) => { try { window.__report(JSON.stringify(Object.assign({ t: Date.now() }, o))); } catch (e) {} };
  names.forEach((n, i) => {
    const row = document.createElement("div");
    row.className = "chat"; row.setAttribute("role", "listitem"); row.tabIndex = 0;
    row.setAttribute("aria-label", n + ", " + (i + 1) + ":" + String(10 + i).padStart(2, "0") + " pm");
    row.innerHTML = '<div class="n"></div><div class="l">last message...</div>';
    row.firstChild.textContent = n;
    row.addEventListener("click", (e) => { current = n; head.textContent = n; document.querySelectorAll(".chat").forEach((c) => c.classList.remove("on")); row.classList.add("on"); report({ ev: "open_chat", chat: n, x: e.screenX, y: e.screenY }); });
    list.appendChild(row);
  });
  document.getElementById("send").addEventListener("click", (e) => {
    const text = box.innerText.trim();
    report({ ev: "send_click", chat: current, text, x: e.screenX, y: e.screenY });
    if (!text) return;
    const m = document.createElement("div"); m.className = "msg"; m.textContent = text; log.appendChild(m); box.textContent = "";
    report({ ev: "sent", chat: current, text });
  });
  document.addEventListener("click", (e) => report({ ev: "click", x: e.screenX, y: e.screenY, target: (e.target.getAttribute && (e.target.getAttribute("aria-label") || e.target.id || e.target.className)) || "" }), true);
  // where everything is, in SCREEN pixels, so a test can aim exactly (and then check what was really hit)
  function layout() {
    const lb = (window.outerWidth - window.innerWidth) / 2;
    const top = window.outerHeight - window.innerHeight - lb;
    const sc = (r) => ({ x: Math.round(window.screenX + lb + r.left), y: Math.round(window.screenY + top + r.top), w: Math.round(r.width), h: Math.round(r.height) });
    const rows = {};
    document.querySelectorAll(".chat").forEach((c) => { rows[c.querySelector(".n").textContent] = sc(c.getBoundingClientRect()); });
    report({ ev: "layout", dpr: window.devicePixelRatio, send: sc(document.getElementById("send").getBoundingClientRect()), box: sc(box.getBoundingClientRect()), rows });
  }
  window.addEventListener("load", () => setTimeout(layout, 300));
  window.addEventListener("resize", () => setTimeout(layout, 300));
  window.__layout = layout;
  box.addEventListener("input", () => report({ ev: "typed", text: box.innerText }));
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); document.getElementById("send").click(); } });
</script>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    x: Number(arg("left", 100)), y: Number(arg("top", 100)), width: Number(arg("width", 1100)), height: Number(arg("height", 700)), title: TITLE, show: true,
    webPreferences: { contextIsolation: false, nodeIntegration: false, preload: path.join(__dirname, "web-fixture-preload.cjs") },
  });
  win.on("page-title-updated", (e) => e.preventDefault());
  win.setTitle(TITLE);
  if (process.argv.includes("--maximize")) win.maximize();
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PAGE));
  win.setTitle(TITLE);
  const { ipcMain } = require("electron");
  ipcMain.on("fixture-report", (_e, line) => { if (LOG) try { fs.appendFileSync(LOG, line + "\n"); } catch (_) { /* gone */ } });
  setTimeout(() => app.exit(0), Number(arg("seconds", 180)) * 1000);
});
