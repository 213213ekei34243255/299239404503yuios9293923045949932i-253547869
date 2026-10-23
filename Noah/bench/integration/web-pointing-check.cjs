// Noah/bench/integration/web-pointing-check.cjs
//
// Real-browser proof that the web agent's coordinate clicks land where the model means, with the REAL stack: a real page, the real accessibility tree and screenshot
// (observer.observe), the real coordinate geometry (FrameGeometry: image -> viewport) and the real near-miss step (pointing.landPoint), then a REAL CDP mouse click at the
// result. The page records which button was pressed. Repeated at page zoom 100%, 125% and 150%, in pixels of the picture and on a 0-999 grid.
//
//   node Noah/bench/integration/web-pointing-check.cjs
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const IS_ELECTRON = Boolean(process.versions.electron);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><meta charset="utf-8"><title>pointing</title><body style="margin:0;font:16px sans-serif;background:#fff">
<button id="save" style="position:absolute;left:200px;top:150px;width:120px;height:44px">Save</button>
<button id="cancel" style="position:absolute;left:344px;top:150px;width:120px;height:44px">Cancel</button>
<canvas id="c" width="300" height="160" style="position:absolute;left:200px;top:300px;border:1px solid #888"></canvas>
<script>window.__log = []; for (const id of ["save", "cancel", "c"]) document.getElementById(id).addEventListener("click", () => window.__log.push(id));</script></body>`;

async function runner() {
  const { app, BrowserWindow } = require("electron");
  const { CdpSession } = require(path.join(ROOT, "Noah", "browser", "cdp.cjs"));
  const { Observer } = require(path.join(ROOT, "Noah", "perception", "observer.cjs"));
  const ax = require(path.join(ROOT, "Noah", "perception", "ax.cjs"));
  const pointing = require(path.join(ROOT, "Noah", "browser", "pointing.cjs"));
  let failures = 0;
  const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + String(detail).slice(0, 220) : ""}`); };

  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "jonah-wp-")));
  const html = path.join(os.tmpdir(), "web-pointing.html"); fs.writeFileSync(html, PAGE);
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true } });
  await win.loadFile(html);
  const wc = win.webContents;
  const cdp = new CdpSession(wc, { log: () => {} });
  await cdp.attach();
  const observer = new Observer({ cdp, refs: new ax.RefTable() });
  const click = async (x, y) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(120);
  };
  const log = async () => JSON.parse(await wc.executeJavaScript("JSON.stringify(window.__log)"));
  const reset = () => wc.executeJavaScript("window.__log = []; 0");

  for (const zoom of [1, 1.25, 1.5]) {
    wc.setZoomFactor(zoom); await sleep(500);
    for (const space of ["image_px", "normalized_1000"]) {
      const obs = await observer.observe({ screenshot: true, screenshotOptions: { maxLongEdge: 1280, coordinateSpace: space } });
      const geo = obs.screenshot.geometry;
      const save = obs.elements.find((e) => e.role === "button" && e.name === "Save");
      const cancel = obs.elements.find((e) => e.role === "button" && e.name === "Cancel");
      const tag = `zoom ${zoom * 100}% / ${space}`;
      check(`${tag}: the page's buttons are found`, !!save && !!cancel && save.rect && cancel.rect, JSON.stringify(save && save.rect));
      if (!save || !cancel) continue;
      // what a model would answer: the position IN THE PICTURE (in the chosen coordinate system) of a point given in viewport CSS px
      const asModel = (vx, vy) => { const m = geo.viewportToModel(vx, vy, space); return { x: m.x, y: m.y }; };
      const land = async (vx, vy, allowSnap = true) => { const m = asModel(vx, vy); const vp = geo.modelToViewport(m.x, m.y, space); return pointing.landPoint(observer, vp, geo.viewport, { allowSnap }); };
      const c = { x: save.rect.x + save.rect.width / 2, y: save.rect.y + save.rect.height / 2 };

      // 1. the middle of Save
      await reset();
      let r = await land(c.x, c.y);
      await click(r.vx, r.vy);
      check(`${tag}: a point on Save presses Save`, (await log()).join() === "save" && !r.snapped, `${(await log()).join()} ${r.landing}`);

      // 2. a near miss, 9 px left of Save's edge (on nothing): moved onto Save
      await reset();
      r = await land(save.rect.x - 9, c.y);
      await click(r.vx, r.vy);
      check(`${tag}: a point 9 px off Save's edge is moved onto Save and presses it`, (await log()).join() === "save" && !!r.snapped && r.snapped.name === "Save", `${(await log()).join()} ${r.landing}`);

      // 3. the same near miss for a hover/move/drag: left exactly where it was (and nothing pressed)
      await reset();
      r = await land(save.rect.x - 9, c.y, false);
      await click(r.vx, r.vy);
      check(`${tag}: with snapping off (hover/drag) the point is not moved`, (await log()).length === 0 && !r.snapped, `${(await log()).join()}`);

      // 4. exactly between two buttons (12 px from each): no guess
      await reset();
      const mid = (save.rect.x + save.rect.width + cancel.rect.x) / 2;
      r = await land(mid, c.y);
      await click(r.vx, r.vy);
      check(`${tag}: a point halfway between two buttons is not guessed`, (await log()).length === 0 && !r.snapped, `${(await log()).join()} ${r.landing}`);
      check(`${tag}: ...and the model is told what it hit and what is near`, /not a control/.test(r.landing) && /nearest clickable/.test(r.landing), r.landing);

      // 5. a point well away from anything: untouched
      await reset();
      r = await land(save.rect.x - 90, c.y);
      check(`${tag}: a point far from every button is left alone`, !r.snapped);

      // 6. drawing: a point just outside a canvas is not pulled to its middle
      const canvasBox = await wc.executeJavaScript("(() => { const r = document.getElementById('c').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()");
      r = await land(canvasBox.x - 6, canvasBox.y + 50);
      check(`${tag}: a point just outside a canvas is not moved onto it`, !r.snapped);
    }
  }

  console.log(failures ? `RESULT web-pointing FAILED (${failures} failing)` : "RESULT web-pointing ok");
  app.exit(failures ? 1 : 0);
}

async function driver() {
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-wp-run-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [`--user-data-dir=${path.join(tmp, "data")}`, __filename], { env, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", () => {});
  const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 120000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  for (const line of out.split(/\r?\n/)) if (/^(PASS|FAIL|RESULT)/.test(line)) console.log(line);
  if (code !== 0) { console.log(`FAIL  exited with ${code}`); if (!/RESULT/.test(out)) console.log(out.split(/\r?\n/).slice(-20).join("\n")); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : 1);
}

if (IS_ELECTRON) require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e); require("electron").app.exit(2); }));
else driver().catch((e) => { console.error(e); process.exit(2); });
