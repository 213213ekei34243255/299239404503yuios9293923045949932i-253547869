// Noah/bench/integration/cursor-alignment-check.cjs
//
// Is the purple pointer the user watches where the REAL click happens? The real Jonah (real shell, real <webview>, real overlay) is given a goal on a page with three buttons labelled
// the same. When the agent clicks, a picture of the shell is taken and the arrow's tip is located in it by its pixels, then compared with (a) where the click was made, in shell pixels,
// and (b) the button that was really pressed (the page records the press).
//
// LIVE: the agent is the real hosted model (noahai.live/predict), so it needs the internet; it skips itself if the model cannot be reached.
//   node Noah/bench/integration/cursor-alignment-check.cjs
// Needs ports 5588/5589 free (it skips itself if the real Jonah is open).
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
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.once("listening", () => s.close(() => resolve(true))); s.listen(port, "127.0.0.1"); });

const PAGE = `<!doctype html><meta charset="utf-8"><title>Mug shop</title><body style="font:16px sans-serif;margin:24px">
<h1>Mugs</h1><style>.card{display:inline-block;width:220px;margin:12px;padding:12px;border:1px solid #ccc;vertical-align:top}</style>
${["Red Mug", "Blue Mug", "Green Mug"].map((n, i) => `<div class="card"><h2>${n}</h2><p>Ceramic, 350 ml. Price ${299 + i * 50}.</p><button id="b-${n.split(" ")[0].toLowerCase()}" onclick="fetch('/hit?item=${n.split(" ")[0].toLowerCase()}')">Add to cart</button></div>`).join("\n")}
</body>`;

async function runner() {
  const { app, BrowserWindow } = require("electron");
  let failures = 0;
  const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + String(detail).slice(0, 240) : ""}`); };
  if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "jonah-ca-")));
  app.setAppPath(ROOT);

  const hits = [];
  const srv = http.createServer((req, res) => { if (req.url.startsWith("/hit")) { hits.push(new URL(req.url, "http://x").searchParams.get("item")); res.end("ok"); return; } res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const pageUrl = `http://127.0.0.1:${srv.address().port}/`;

  const cfgDir = path.join(app.getPath("userData"), "browser-data", "noah");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "noah-config.json"), JSON.stringify({ takeover: { enabled: false }, policy: { mode: "autonomous", allowLocalhost: true }, limits: { maxSteps: 12, maxModelCalls: 14, maxWallMs: 120000 } }));
  require(path.join(ROOT, "main.cjs"));
  const win = await (async () => { for (let i = 0; i < 120; i++) { const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().includes("index.html")); if (w) return w; await sleep(500); } return null; })();
  check("the real browser window opens", !!win);
  if (!win) { console.log("RESULT cursor-alignment FAILED (no window)"); return app.exit(1); }
  const ev = (js) => win.webContents.executeJavaScript(js, true);
  for (let i = 0; i < 60; i++) { await sleep(500); if (await ev("!!(window.noah && window.NoahOverlay && document.getElementById('noahOverlay'))").catch(() => false)) break; }
  await ev("(() => { window.__ev = []; window.noah.onEvent((e) => { window.__ev.push(e); }); })()");
  await ev(`document.querySelector('webview').loadURL(${JSON.stringify(pageUrl)})`);
  await sleep(6000);

  const sub = await ev(`window.rexy.goal("Noah, click the Add to cart button for the Blue Mug.")`);
  if (!sub || sub.success === false) { console.log("SKIP: the agent could not start:", JSON.stringify(sub).slice(0, 160)); return app.exit(0); }

  // wait for the first click, then until the pointer is fully visible and has stopped
  let click = null;
  for (let i = 0; i < 600 && !click; i++) { await sleep(100); click = await ev(`(window.__ev.find((e) => e.event === 'mouse_action' && /click/i.test(String(e.action))) || null)`).catch(() => null); }
  if (!click) { console.log("SKIP: the agent never clicked (model unreachable?)"); return app.exit(0); }
  let tip = null, img = null, k = 1;
  for (let tries = 0; tries < 15 && !tip; tries++) {
    await sleep(250);
    const op = await ev(`(() => { const c = document.querySelector('#noahOverlay .noah-cursor'); return c ? getComputedStyle(c).opacity : '0'; })()`).catch(() => "0");
    if (op !== "1") continue;
    // everything the overlay draws in the same purple (the box round the target, the trail, the ripple, the NOAH tag) is hidden, so the only purple left is the arrow itself
    await ev(`(() => { for (const el of document.querySelectorAll('#noahOverlay > *:not(.noah-cursor), #noahOverlay .noah-cursor .noah-tag, #noahOverlay .noah-cursor .noah-halo')) el.style.visibility = 'hidden'; return 0; })()`);
    await sleep(150);
    img = await win.webContents.capturePage();
    const size = img.getSize();
    k = size.width / (await ev("window.innerWidth"));
    const bmp = img.toBitmap();
    let best = null;
    for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
      const o = (y * size.width + x) * 4;
      if (Math.abs(bmp[o + 2] - 124) < 20 && Math.abs(bmp[o + 1] - 58) < 20 && Math.abs(bmp[o] - 237) < 20) { const d = x + y; if (!best || d < best.d) best = { x, y, d }; }
    }
    if (best) tip = { x: best.x / k, y: best.y / k };
  }
  check("the pointer's arrow is on screen when the click happens", !!tip);

  // where the click was made, in shell pixels: the <webview>'s rectangle + the viewport point x the page zoom
  const place = await ev(`(() => { const w = document.querySelector('webview'); const r = w.getBoundingClientRect(); return { x: r.x, y: r.y, zoom: w.getZoomFactor ? w.getZoomFactor() : 1 }; })()`);
  const want = { x: place.x + click.x * (click.zoomFactor || place.zoom || 1), y: place.y + click.y * (click.zoomFactor || place.zoom || 1) };
  // the button the page says was pressed, and where it sits in shell pixels
  await sleep(500);
  const pressed = hits[0];
  const wvId = await ev(`(async () => { const w = document.querySelector('webview'); const r = await w.executeJavaScript("(() => { const b = document.getElementById('b-blue').getBoundingClientRect(); return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height }); })()"); return r; })()`);
  const blue = JSON.parse(wvId);
  const z = click.zoomFactor || place.zoom || 1;
  const blueShell = { x: place.x + blue.x * z, y: place.y + blue.y * z, w: blue.w * z, h: blue.h * z };
  check("the page recorded a press on the Blue Mug's button", pressed === "blue", JSON.stringify(hits));
  check("the click point (shell pixels) is inside the Blue Mug button as drawn", want.x >= blueShell.x && want.x <= blueShell.x + blueShell.w && want.y >= blueShell.y && want.y <= blueShell.y + blueShell.h, `click ${Math.round(want.x)},${Math.round(want.y)} vs button ${JSON.stringify({ x: Math.round(blueShell.x), y: Math.round(blueShell.y), w: Math.round(blueShell.w), h: Math.round(blueShell.h) })}`);
  if (tip) {
    const dx = tip.x - want.x, dy = tip.y - want.y;
    check("the visible arrow's tip is on the click point (within 8 px)", Math.hypot(dx, dy) <= 8, `tip ${tip.x.toFixed(1)},${tip.y.toFixed(1)} vs click ${want.x.toFixed(1)},${want.y.toFixed(1)} (off by ${dx.toFixed(1)}, ${dy.toFixed(1)})`);
    check("...and the tip is inside the button the user sees", tip.x >= blueShell.x - 3 && tip.x <= blueShell.x + blueShell.w + 3 && tip.y >= blueShell.y - 3 && tip.y <= blueShell.y + blueShell.h + 3);
  }
  console.log(failures ? `RESULT cursor-alignment FAILED (${failures} failing)` : "RESULT cursor-alignment ok");
  srv.close();
  app.exit(failures ? 1 : 0);
}

async function driver() {
  if (!(await portFree(5589)) || !(await portFree(5588))) { console.log("SKIP: ports 5588/5589 are in use (the real Jonah is open?)"); return process.exit(0); }
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-ca-run-"));
  const env = { ...process.env, JONAH_ENTITLEMENTS_ENABLED: "0" }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [`--user-data-dir=${path.join(tmp, "data")}`, __filename], { env, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", () => {});
  const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 200000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  for (const line of out.split(/\r?\n/)) if (/^(PASS|FAIL|RESULT|SKIP)/.test(line)) console.log(line);
  if (code !== 0) { console.log(`FAIL  exited with ${code}`); if (!/RESULT|SKIP/.test(out)) console.log(out.split(/\r?\n/).slice(-20).join("\n")); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : 1);
}

if (IS_ELECTRON) require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e); require("electron").app.exit(2); }));
else driver().catch((e) => { console.error(e); process.exit(2); });
