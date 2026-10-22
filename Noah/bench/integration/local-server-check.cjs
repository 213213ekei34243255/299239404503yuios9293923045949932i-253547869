// Noah/bench/integration/local-server-check.cjs
//
// End-to-end check with the REAL Jonah (its real local servers on 5588/5589): the project folder is no longer served, a hostile web page open in a Jonah tab cannot steal
// market-keys.js (or anything else) by loading it as a script / image, a spoofed Host is refused, the model server is loopback-only, and Jonah's own uses still work.
// A CONTROL server that behaves like the old code (static folder) proves the attack is real: the same hostile page succeeds against it.
//
//   node Noah/bench/integration/local-server-check.cjs
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
async function until(fn, ms, step = 200) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.once("listening", () => s.close(() => resolve(true))); s.listen(port, "127.0.0.1"); });
const get = (port, p, headers = {}, method = "GET") => new Promise((resolve, reject) => { const r = http.request({ host: "127.0.0.1", port, path: p, method, headers, agent: false }, (res) => { let b = ""; res.on("data", (d) => { b += d; }); res.on("end", () => resolve({ status: res.statusCode, body: b, headers: res.headers })); }); r.on("error", reject); r.end(); });
const tryConnect = (host, port) => new Promise((resolve) => { const s = net.connect({ host, port, timeout: 2500 }); s.once("connect", () => { s.destroy(); resolve(true); }); s.once("timeout", () => { s.destroy(); resolve(false); }); s.once("error", () => resolve(false)); });

async function runner() {
  const { app, BrowserWindow, webContents } = require("electron");
  const express = require("express");
  let failures = 0;
  const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + String(detail).slice(0, 220) : ""}`); };

  if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "jonah-ls-")));
  app.setAppPath(ROOT);

  // control: the OLD behaviour (a folder served as static files) holding a canary "keys" file
  const canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-canary-"));
  fs.writeFileSync(path.join(canaryDir, "market-keys.js"), "window.CANARY_KEYS = 'stolen';");
  const control = express(); control.use(express.static(canaryDir, { dotfiles: "deny" }));
  const controlServer = await new Promise((r) => { const s = control.listen(0, "127.0.0.1", () => r(s)); });
  const controlPort = controlServer.address().port;

  // the hostile page: an ordinary website that tries to read Jonah's local files by loading them as scripts and images
  const evil = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><title>hostile</title><body>
      <script src="http://127.0.0.1:${controlPort}/market-keys.js"></script>
      <script src="http://127.0.0.1:5589/market-keys.js"></script>
      <script src="http://127.0.0.1:5589/entitlements.config.json"></script>
      <img id="logo" src="http://127.0.0.1:5589/assets/IO.png">
      <script>
        window.__r = { control: typeof window.CANARY_KEYS, realKeys: typeof window.JONAH_MARKET_KEYS };
        fetch("http://127.0.0.1:5589/package.json").then((r) => r.text()).then((t) => { window.__r.fetchText = t.slice(0, 40); }).catch((e) => { window.__r.fetchError = String(e); });
        fetch("http://127.0.0.1:5589/search.html", { headers: { "X-Probe": "1" } }).then((r) => r.text()).then((t) => { window.__r.pageText = t.slice(0, 40); }).catch((e) => { window.__r.pageError = String(e); });
        window.addEventListener("load", () => { window.__r.logoWidth = document.getElementById("logo").naturalWidth; window.__r.done = true; });
      </script></body>`);
  });
  await new Promise((r) => evil.listen(0, "127.0.0.1", r));
  const evilUrl = `http://127.0.0.1:${evil.address().port}/`;

  require(path.join(ROOT, "main.cjs"));
  const win = await until(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html")), 30000, 300);
  check("the real browser window opens", !!win);
  if (!win) { console.log("RESULT local-server FAILED (no window)"); return app.exit(1); }
  await sleep(4500);
  const call = (js) => win.webContents.executeJavaScript(js, true);
  const guests = () => webContents.getAllWebContents().filter((w) => w.getType() === "webview");

  // ================================================================ from outside (any program on the computer)
  for (const p of ["/market-keys.js", "/key.json", "/entitlements.config.json", "/billing-links.config.json", "/package.json", "/package-lock.json", "/main.cjs", "/preload.cjs", "/.env", "/home.html", "/index.html", "/Noah/docs/AUTONOMY.md", "/node_modules/express/package.json", "/Rexy/runtime.cjs", "/", "/assets/../key.json", "/assets/%2e%2e/key.json", "/assets/..%2fkey.json"]) {
    const r = await get(5589, p);
    check(`GET ${p} is refused (404)`, r.status === 404 && !/JONAH_|github_pat|"version"|enabled/.test(r.body), r.status);
  }
  check("the real files DO exist on disk (so the 404s are the guard, not absence)", ["market-keys.js", "key.json", "entitlements.config.json", "package.json", "main.cjs"].every((f) => fs.existsSync(path.join(ROOT, f))));
  const s = await get(5589, "/search.html");
  check("search.html is still served", s.status === 200 && /<html/i.test(s.body));
  check("images under assets/ are still served", (await get(5589, "/assets/IO.png")).status === 200);
  for (const host of ["evil.example", "evil.example:5589", "127.0.0.1.evil.example:5589", "192.168.0.10:5589"]) check(`a spoofed Host (${host}) is refused`, (await get(5589, "/search.html", { Host: host })).status === 400);
  check("the API relay answers too (not blocked by the file rules)", (await get(5589, "/api/search/web?q=jonah")).status !== 404);
  check("the API relay refuses a spoofed Host", (await get(5589, "/api/search/web?q=jonah", { Host: "evil.example" })).status === 400);

  // ================================================================ the model server on 5588
  check("the model server answers on loopback", await tryConnect("127.0.0.1", 5588));
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  if (lan.length) { for (const ip of lan) check(`...and NOT on this computer's network address ${ip} (before: every interface)`, !(await tryConnect(ip, 5588))); check("the UI server is not on the network address either", !(await tryConnect(lan[0], 5589))); }
  else check("(no network address on this computer to test against)", true);
  check("the model server refuses a spoofed Host", (await get(5588, "/anything", { Host: "evil.example" })).status === 400);

  // ================================================================ a hostile website in a Jonah tab
  await call(`createNewTab(${JSON.stringify(evilUrl)}); 0`);
  const evilWc = await until(() => guests().find((g) => g.getURL().startsWith(evilUrl)), 15000, 300);
  check("the hostile page is open in a tab", !!evilWc);
  const rr = await until(async () => { const v = await evilWc.executeJavaScript(`window.__r && window.__r.done ? JSON.stringify(window.__r) : ""`); return v ? JSON.parse(v) : null; }, 20000, 400);
  await sleep(1500);
  const r2 = JSON.parse(await evilWc.executeJavaScript(`JSON.stringify(window.__r)`));
  check("CONTROL: the same page DOES steal a key file from a server that serves a folder (the attack is real)", r2.control === "string" || (await evilWc.executeJavaScript(`typeof window.CANARY_KEYS`)) === "string", JSON.stringify(r2));
  check("Jonah's market-keys.js could NOT be loaded as a script by that page", r2.realKeys === "undefined", JSON.stringify(r2));
  check("Jonah's images could NOT be embedded by that page (blocked, width 0)", r2.logoWidth === 0, JSON.stringify(r2));
  check("the page could not read package.json by fetch", !r2.fetchText, JSON.stringify(r2));
  check("the page could not read search.html by fetch either (cross-origin, no CORS)", !r2.pageText, JSON.stringify(r2));

  // ================================================================ Jonah's own uses still work
  await call(`tabData[activeTabIndex].webview.loadURL("http://127.0.0.1:5589/search.html"); 0`);
  const searchWc = await until(() => guests().find((g) => g.getURL().startsWith("http://127.0.0.1:5589/search.html")), 15000, 300);
  await sleep(2500);
  check("typing the search page's address still opens it, with its own logo image", !!searchWc && (await searchWc.executeJavaScript(`(() => { const i = document.querySelector(".brand-logo"); return !!i && i.complete && i.naturalWidth > 0; })()`)));
  await call(`createNewTab("home.html"); 0`); await sleep(4500);
  const home = await until(() => guests().find((g) => /home\.html$/.test(g.getURL().split("?")[0])), 15000, 300);
  const rel = home ? await home.executeJavaScript(`fetch("http://127.0.0.1:5589/api/search/web?q=jonah").then((r) => r.status).catch((e) => "network-error: " + e)`) : "no home";
  check("the home page (a local file) can still call the search relay", typeof rel === "number" && rel !== 400 && rel !== 403 && rel !== 404, String(rel));

  console.log(failures ? `RESULT local-server FAILED (${failures} failing)` : "RESULT local-server ok");
  controlServer.close(); evil.close(); fs.rmSync(canaryDir, { recursive: true, force: true });
  app.exit(failures ? 1 : 0);
}

async function driver() {
  if (!(await portFree(5589)) || !(await portFree(5588))) { console.log("SKIP: ports 5588/5589 are in use (the real Jonah is open?)"); return process.exit(0); }
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-ls-run-"));
  const env = { ...process.env, JONAH_ENTITLEMENTS_ENABLED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [`--user-data-dir=${path.join(tmp, "data")}`, __filename], { env, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", () => {});
  const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 240000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  for (const line of out.split(/\r?\n/)) if (/^(PASS|FAIL|RESULT)/.test(line)) console.log(line);
  if (code !== 0) { console.log(`FAIL  exited with ${code}`); if (code === -99 || !/RESULT/.test(out)) console.log(out.split(/\r?\n/).slice(-30).join("\n")); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : 1);
}

if (IS_ELECTRON) require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e); require("electron").app.exit(2); }));
else driver().catch((e) => { console.error(e); process.exit(2); });
