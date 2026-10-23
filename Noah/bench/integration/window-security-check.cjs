// Noah/bench/integration/window-security-check.cjs
//
// End-to-end check with the REAL Jonah that the browser and its windows hold up when a website (or a page that asks for too much) tries things:
//   1. a <webview> created with dangerous settings (Node on, no sandbox, a foreign preload) comes out sandboxed, isolated, without Node and without that preload
//   2. a website cannot move the app's own window to a web address (script-driven navigation is stopped; the shell stays on index.html)
//   3. a site with an invalid HTTPS certificate is refused (it used to load)
//   4. an ordinary page, and the sandboxed preload (user input reaches the agent), still work
//
//   node Noah/bench/integration/window-security-check.cjs
// Needs ports 5588/5589 free (it skips itself if the real Jonah is open). Step 3 needs `openssl` (skipped, and said so, if it is missing).
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const http = require("http");
const https = require("https");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const IS_ELECTRON = Boolean(process.versions.electron);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 200) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.once("listening", () => s.close(() => resolve(true))); s.listen(port, "127.0.0.1"); });

async function runner() {
  const { app, BrowserWindow, webContents } = require("electron");
  let failures = 0;
  const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + String(detail).slice(0, 240) : ""}`); };
  if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "jonah-ws-")));
  app.setAppPath(ROOT);

  // an ordinary http page, and an https page with a certificate nobody trusts (a self-signed one made right now)
  const plain = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>plain page</title><body>hello from a plain page</body>"); });
  await new Promise((r) => plain.listen(0, "127.0.0.1", r));
  const plainUrl = `http://127.0.0.1:${plain.address().port}/`;
  let secure = null, secureUrl = "";
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-cert-"));
  const ssl = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(certDir, "k.pem"), "-out", path.join(certDir, "c.pem"), "-days", "2", "-subj", "/CN=127.0.0.1"], { encoding: "utf8", windowsHide: true });
  if (ssl.status === 0) {
    secure = https.createServer({ key: fs.readFileSync(path.join(certDir, "k.pem")), cert: fs.readFileSync(path.join(certDir, "c.pem")) }, (req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>secret page</title><body>served over an untrusted certificate</body>"); });
    await new Promise((r) => secure.listen(0, "127.0.0.1", r));
    secureUrl = `https://127.0.0.1:${secure.address().port}/`;
  }

  require(path.join(ROOT, "main.cjs"));
  const win = await until(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html")), 30000, 300);
  check("the real browser window opens", !!win);
  if (!win) { console.log("RESULT window-security FAILED (no window)"); return app.exit(1); }
  await sleep(4500);
  const call = (js) => win.webContents.executeJavaScript(js, true);
  const guests = () => webContents.getAllWebContents().filter((w) => w.getType() === "webview");

  // ---- 1. a <webview> that asks for too much
  const evilPreload = path.join(os.tmpdir(), "evil-preload.js"); fs.writeFileSync(evilPreload, "window.__evil = true;");
  await call(`(() => { const w = document.createElement("webview"); w.id = "probe"; w.setAttribute("partition", "persist:probe"); w.setAttribute("nodeintegration", ""); w.setAttribute("webpreferences", "nodeIntegration=yes, sandbox=no, contextIsolation=no, webSecurity=no, allowRunningInsecureContent=yes"); w.setAttribute("preload", ${JSON.stringify("file:///" + evilPreload.replace(/\\/g, "/"))}); w.src = ${JSON.stringify(plainUrl)}; w.style.cssText = "position:fixed;left:0;top:0;width:300px;height:200px;z-index:99999"; document.body.appendChild(w); return 0; })()`);
  const probe = await until(() => guests().find((g) => g.getURL().startsWith(plainUrl) && g.session !== undefined && g.getLastWebPreferences && g.getLastWebPreferences().nodeIntegration !== undefined), 20000, 300);
  check("the probe <webview> is created", !!probe);
  if (probe) {
    const p = probe.getLastWebPreferences();
    check("Node is off for it though it asked for Node", p.nodeIntegration === false && !p.nodeIntegrationInSubFrames, JSON.stringify({ n: p.nodeIntegration, sub: p.nodeIntegrationInSubFrames }));
    check("its renderer is sandboxed though it asked for no sandbox", p.sandbox === true);
    check("it is isolated from the page's world though it asked not to be", p.contextIsolation === true);
    check("web security is on though it asked for it off", p.webSecurity !== false);
    check("insecure content is blocked though it was allowed", p.allowRunningInsecureContent === false);
    check("the foreign preload it asked for was dropped", !/evil-preload/.test(String(p.preload || "") + String(p.preloadURL || "")), String(p.preload || p.preloadURL || ""));
    const probe2 = await probe.executeJavaScript(`JSON.stringify({ evil: typeof window.__evil, proc: typeof process, req: typeof require })`);
    check("the page itself sees no Node and none of the foreign preload", probe2 === JSON.stringify({ evil: "undefined", proc: "undefined", req: "undefined" }), probe2);
  }
  // a <webview> started on a javascript: address is refused
  const before = guests().length;
  await call(`(() => { const w = document.createElement("webview"); w.id = "probe2"; w.src = "javascript:alert(1)"; document.body.appendChild(w); return 0; })()`);
  await sleep(1500);
  check("a <webview> on a javascript: address is not attached", guests().filter((g) => g.getURL().startsWith("javascript:")).length === 0 && guests().length <= before + 1);

  // ---- 2. a website's script cannot move the app's own window
  const shellUrl = win.webContents.getURL();
  await call(`setTimeout(() => { location.href = "https://example.com/"; }, 50); 0`);
  await sleep(2500);
  check("script-driven navigation of the shell window to a website is stopped", win.webContents.getURL() === shellUrl, win.webContents.getURL());
  await call(`setTimeout(() => { window.location.assign("http://127.0.0.1:${plain.address().port}/"); }, 50); 0`);
  await sleep(2500);
  check("...also to a local web address", win.webContents.getURL() === shellUrl, win.webContents.getURL());
  check("the shell still works afterwards", (await call(`typeof createNewTab`)) === "function");

  // ---- 3. an untrusted certificate
  if (secure) {
    await call(`createNewTab(${JSON.stringify(secureUrl)}); 0`);
    await sleep(6000);
    const loaded = guests().find((g) => g.getURL().startsWith(secureUrl));
    let text = ""; try { text = loaded ? await loaded.executeJavaScript(`document.body ? document.body.innerText : ""`) : ""; } catch (_) { /* not readable */ }
    check("a page behind an untrusted certificate does NOT load its content", !/served over an untrusted certificate/.test(text), text.slice(0, 80));
  } else check("(openssl is not available here: the certificate step was skipped)", true);

  // ---- 4. normal browsing and the sandboxed preload still work
  await call(`createNewTab(${JSON.stringify(plainUrl)}); 0`);
  const normal = await until(async () => { const g = guests().filter((x) => x.getURL().startsWith(plainUrl)).pop(); if (!g) return null; try { return /hello from a plain page/.test(await g.executeJavaScript(`document.body.innerText`)) ? g : null; } catch (_) { return null; } }, 20000, 400);
  check("an ordinary page still loads and reads", !!normal);
  if (normal) check("ordinary tabs are sandboxed too", normal.getLastWebPreferences().sandbox === true && normal.getLastWebPreferences().nodeIntegration === false);

  // Jonah's own small preload still works inside the sandbox: the home page (a local file) tells the browser around it to open a hub, through the preload, and a website cannot
  await call("createNewTab('home.html'); 0");
  await sleep(5000);
  await call("window.__got = []; (() => { const wv = tabData[activeTabIndex].webview; wv.addEventListener('ipc-message', (e) => window.__got.push(e.channel)); })(); 0");
  const hp = guests().find((g) => /home[.]html/.test(g.getURL()));
  check("the home page is open in a sandboxed tab", !!hp && hp.getLastWebPreferences().sandbox === true);
  if (hp) {
    await hp.executeJavaScript("window.dispatchEvent(new CustomEvent('jonah-open-hub', { detail: 'game' })); 0");
    await sleep(800);
    const got = await call("JSON.stringify(window.__got)");
    check("the sandboxed preload still passes the home page's request to the browser", /jonah-open-hub/.test(got), got);
    // the same event from a website's page does nothing (the preload only listens on Jonah's own home.html)
    const web = guests().find((g) => g.getURL().startsWith(plainUrl));
    if (web) {
      await call("window.__got = []; 0");
      await web.executeJavaScript("window.dispatchEvent(new CustomEvent('jonah-open-hub', { detail: 'game' })); 0");
      await sleep(600);
      check("a website cannot use that channel", (await call("JSON.stringify(window.__got)")) === "[]");
    }
  }

  console.log(failures ? `RESULT window-security FAILED (${failures} failing)` : "RESULT window-security ok");
  plain.close(); if (secure) secure.close(); fs.rmSync(certDir, { recursive: true, force: true });
  app.exit(failures ? 1 : 0);
}

async function driver() {
  if (!(await portFree(5589)) || !(await portFree(5588))) { console.log("SKIP: ports 5588/5589 are in use (the real Jonah is open?)"); return process.exit(0); }
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-ws-run-"));
  const env = { ...process.env, JONAH_ENTITLEMENTS_ENABLED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [`--user-data-dir=${path.join(tmp, "data")}`, __filename], { env, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", () => {});
  const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 240000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  for (const line of out.split(/\r?\n/)) if (/^(PASS|FAIL|RESULT)/.test(line)) console.log(line);
  if (code !== 0) { console.log(`FAIL  exited with ${code}`); if (code === -99 || !/RESULT/.test(out)) console.log(out.split(/\r?\n/).slice(-30).join("\n")); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : 1);
}

if (IS_ELECTRON) require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e); require("electron").app.exit(2); }));
else driver().catch((e) => { console.error(e); process.exit(2); });
