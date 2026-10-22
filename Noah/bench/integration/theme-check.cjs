// Noah/bench/integration/theme-check.cjs
//
// End-to-end check with the REAL Jonah window: the theme colour picker on the home page recolours the home page itself, the logo, the browser chrome around it
// and the assistant panel; it survives a reload and applies to a new tab; a website cannot recolour the browser; reset puts the purple back.
//
//   node Noah/bench/integration/theme-check.cjs
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
async function until(fn, ms, step = 150) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.once("listening", () => s.close(() => resolve(true))); s.listen(port, "127.0.0.1"); });

async function runner() {
  const { app, BrowserWindow, webContents } = require("electron");
  let failures = 0;
  const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };

  if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "jonah-th-")));
  app.setAppPath(ROOT);
  // a hostile website that tries to recolour the browser
  const site = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end("<!doctype html><title>evil</title><script>setInterval(() => window.dispatchEvent(new CustomEvent('jonah-theme', { detail: '#ff0000' })), 200)</script>hi"); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const siteUrl = `http://127.0.0.1:${site.address().port}/`;

  require(path.join(ROOT, "main.cjs"));
  const win = await until(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html")), 30000, 300);
  check("the real browser window opens", !!win);
  if (!win) { console.log("RESULT theme FAILED (no window)"); return app.exit(1); }
  await sleep(3500);

  const call = (js) => win.webContents.executeJavaScript(js, true);
  const guests = () => webContents.getAllWebContents().filter((w) => w.getType() === "webview");
  const homeGuest = async () => until(() => guests().find((g) => /home\.html$/.test(g.getURL().split("?")[0])), 15000, 300);
  const hostVar = (name) => call(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
  const panelAttr = () => call(`(() => { const f = document.querySelector("#aiPanel iframe"); try { return f.contentDocument.documentElement.getAttribute("data-theme-color") || ""; } catch (e) { return "ERR " + e.message; } })()`);
  const hostStored = () => call(`localStorage.getItem("jonahTheme") || ""`);

  let g = await homeGuest();
  check("the home page is open in the first tab", !!g);
  const gv = (js) => g.executeJavaScript(js);
  const root = (name) => gv(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
  await gv(`localStorage.removeItem("jonahTheme"); 0`);
  await call(`localStorage.removeItem("jonahTheme"); JonahTheme.apply("#8b5cf6"); 0`);

  // ---- default
  check("default: no theme is applied and the logo has no filter", (await gv(`document.documentElement.hasAttribute("data-theme-color")`)) === false && (await gv(`getComputedStyle(document.querySelector(".wc-logo")).filter`)) === "none");
  check("default: the page's purple is the original #8b5cf6 family", (await root("--p-139-92-246")) === "139,92,246");
  check("the theme button is there and the panel starts closed", (await gv(`!!document.getElementById("themeBtn") && !document.getElementById("themePanel").classList.contains("open")`)));
  await gv(`document.getElementById("themeBtn").click()`); await sleep(250);
  check("clicking the button opens the colour panel", await gv(`document.getElementById("themePanel").classList.contains("open") && getComputedStyle(document.getElementById("themePanel")).display !== "none"`));
  const nSw = await gv(`document.querySelectorAll("#themeGrid .sw").length`);
  check("it offers many colour swatches plus a hue slider, a picker and a hex field", nSw >= 24 && (await gv(`!!document.getElementById("themeHue") && !!document.getElementById("themePick") && !!document.getElementById("themeHex")`)), `${nSw} swatches`);

  // ---- pick green by clicking its swatch
  await gv(`document.querySelector('#themeGrid .sw[title="Green"]').click()`); await sleep(900);
  check("green: the page's base purple variable became green", (await root("--p-139-92-246")).split(",").map(Number)[1] > (await root("--p-139-92-246")).split(",").map(Number)[0], await root("--p-139-92-246"));
  check("green: the logo gets a hue-rotate filter", /hue-rotate\(-?\d+deg\)/.test(await gv(`getComputedStyle(document.querySelector(".wc-logo")).filter`)), await gv(`getComputedStyle(document.querySelector(".wc-logo")).filter`));
  check("green: the page remembers it (this page's storage)", (await gv(`localStorage.getItem("jonahTheme")`)) === "#22c55e");
  check("green: the BROWSER around the page followed (toolbar variables + saved)", (await hostVar("--p-139-92-246")).split(",").map(Number)[1] > 150 && (await hostStored()) === "#22c55e", await hostVar("--p-139-92-246"));
  check("green: the assistant panel followed", (await panelAttr()) === "#22c55e", await panelAttr());
  check("green: the chrome's own purple (style.css glow) really reads the variable", await call(`(() => { const probe = document.createElement("div"); probe.style.cssText = "background: rgba(var(--p-139-92-246), 1)"; document.body.appendChild(probe); const c = getComputedStyle(probe).backgroundColor; probe.remove(); const m = c.match(/\\d+/g).map(Number); return m[1] > m[0] && m[1] > m[2]; })()`));
  const selected = await gv(`document.querySelector("#themeGrid .sw.on") && document.querySelector("#themeGrid .sw.on").title`);
  check("the chosen swatch is marked and named", selected === "Green" && /Green/.test(await gv(`document.getElementById("themeName").textContent`)));

  // ---- a custom colour by hex, and a bad hex changes nothing
  await gv(`(() => { const i = document.getElementById("themeHex"); i.value = "#ff8800"; i.dispatchEvent(new Event("input", { bubbles: true })); 0; })()`); await sleep(500);
  check("typing a hex applies that colour (orange)", (await gv(`localStorage.getItem("jonahTheme")`)) === "#ff8800" && (await hostStored()) === "#ff8800");
  await gv(`(() => { const i = document.getElementById("themeHex"); i.value = "#12zz"; i.dispatchEvent(new Event("input", { bubbles: true })); 0; })()`); await sleep(300);
  check("a bad hex is flagged and changes nothing", (await gv(`document.getElementById("themeHex").classList.contains("bad")`)) && (await gv(`localStorage.getItem("jonahTheme")`)) === "#ff8800");
  await gv(`(() => { const h = document.getElementById("themeHue"); h.value = "200"; h.dispatchEvent(new Event("input", { bubbles: true })); 0; })()`); await sleep(500);
  const hueHex = await gv(`localStorage.getItem("jonahTheme")`);
  check("the hue slider picks a blue-ish colour at 200 degrees", /^#[0-9a-f]{6}$/.test(hueHex) && (await call(`JonahTheme.rgbToHsl(...JonahTheme.parseHex(${JSON.stringify(hueHex)}))[0]`)) > 190 && (await call(`JonahTheme.rgbToHsl(...JonahTheme.parseHex(${JSON.stringify(hueHex)}))[0]`)) < 210, hueHex);

  // ---- a website cannot recolour the browser
  await gv(`document.querySelector('#themeGrid .sw[title="Teal"]').click()`); await sleep(600);
  const before = await hostStored();
  await call(`createNewTab(${JSON.stringify(siteUrl)})`); await sleep(4500);
  check("a hostile website dispatching the theme event does NOT change the browser's colour", (await hostStored()) === before && before === "#14b8a6", `stored ${await hostStored()}`);
  check("...nor the browser's variables", (await hostVar("--p-139-92-246")) === (await call(`JonahTheme.recolor([139,92,246], "#14b8a6").join(",")`)));

  // ---- a NEW tab's home page is themed; reload keeps it
  await call(`createNewTab("home.html")`); await sleep(5000);
  const g2 = guests().find((x) => /home\.html$/.test(x.getURL().split("?")[0]) && x.id !== g.id);
  check("a new home-page tab opens already themed (teal)", !!g2 && (await g2.executeJavaScript(`document.documentElement.getAttribute("data-theme-color")`)) === "#14b8a6" && /hue-rotate/.test(await g2.executeJavaScript(`getComputedStyle(document.querySelector(".wc-logo")).filter`)));
  await g.executeJavaScript(`location.reload()`); await sleep(3500);
  check("after reloading the home page the colour is still applied before anything shows", (await g.executeJavaScript(`document.documentElement.getAttribute("data-theme-color")`)) === "#14b8a6");

  // ---- reset
  await g.executeJavaScript(`document.getElementById("themeBtn").click()`); await sleep(200);
  await g.executeJavaScript(`document.getElementById("themeReset").click()`); await sleep(800);
  const resetInfo = await g.executeJavaScript(`JSON.stringify({ attr: document.documentElement.hasAttribute("data-theme-color"), filter: getComputedStyle(document.documentElement).getPropertyValue("--theme-logo-filter").trim(), style: document.documentElement.getAttribute("style") })`);
  const ri = JSON.parse(resetInfo);
  check("reset: the page is purple again, the logo filter variable is gone, no theme variable left inline (read from the variable: this tab is in the background, where CSS transitions do not run)", !ri.attr && ri.filter === "" && !String(ri.style || "").includes("--p-"), resetInfo.slice(0, 160));
  check("reset: the browser and the assistant panel are purple again too", (await hostVar("--p-139-92-246")) === "139,92,246" && (await hostStored()) === "#8b5cf6" && (await panelAttr()) === "");

  console.log(failures ? `RESULT theme FAILED (${failures} failing)` : "RESULT theme ok");
  app.exit(failures ? 1 : 0);
}

async function driver() {
  if (!(await portFree(5589)) || !(await portFree(5588))) { console.log("SKIP: ports 5588/5589 are in use (the real Jonah is open?)"); return process.exit(0); }
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-th-run-"));
  const env = { ...process.env, JONAH_ENTITLEMENTS_ENABLED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [`--user-data-dir=${path.join(tmp, "data")}`, __filename], { env, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", () => {});
  const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 180000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  for (const line of out.split(/\r?\n/)) if (/^(PASS|FAIL|RESULT)/.test(line)) console.log(line);
  if (code !== 0) { console.log(`FAIL  exited with ${code}`); if (code === -99 || !/RESULT/.test(out)) console.log(out.split(/\r?\n/).slice(-30).join("\n")); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : 1);
}

if (IS_ELECTRON) require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e); require("electron").app.exit(2); }));
else driver().catch((e) => { console.error(e); process.exit(2); });
