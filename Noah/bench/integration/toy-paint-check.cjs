// Full end-to-end proof, against the REAL deliverable (toy-paint.html), not just a test fixture:
//   real accessibility tree -> observer.observe() (with the fix) -> ax.findElements("blue"/"Ellipse")
//   -> real CDP mouse events at the resolved points (the exact mechanism Noah's ComputerController uses)
//   -> read the canvas pixels back to confirm a blue ellipse was actually drawn.
//
//   npx electron Noah/bench/integration/toy-paint-check.cjs
"use strict";

const path = require("path");
const assert = require("node:assert/strict");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const { CdpSession } = require(path.join(ROOT, "Noah", "browser", "cdp.cjs"));
const { Observer } = require(path.join(ROOT, "Noah", "perception", "observer.cjs"));
const ax = require(path.join(ROOT, "Noah", "perception", "ax.cjs"));

app.on("window-all-closed", () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function click(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

async function drag(cdp, from, to, steps = 12) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, button: "none", buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, button: "left", buttons: 1 });
    await sleep(8);
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
}

async function main() {
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true, partition: "toy-paint-check" } });
  await win.loadFile(path.join(ROOT, "toy-paint.html"));
  const cdp = new CdpSession(win.webContents, { log: () => {} });
  await cdp.attach();
  await sleep(200);

  const observer = new Observer({ cdp, refs: new ax.RefTable() });
  const obs = await observer.observe({});

  // ---- 1) exactly what Noah's own findElements would be asked to resolve for the prompt
  // "select the blue color, choose the Ellipse tool, and draw a filled blue circle"
  const blue = ax.findElements(obs.elements, "color blue", { limit: 5 });
  assert.ok(blue.length && blue[0].score >= 45, `"color blue" should resolve; got ${JSON.stringify(blue.map((e) => [e.name, e.score]))}`);
  const ellipseTool = ax.findElements(obs.elements, "Ellipse", { limit: 5 });
  assert.ok(ellipseTool.length && ellipseTool[0].score >= 45, `"Ellipse" should resolve; got ${JSON.stringify(ellipseTool.map((e) => [e.name, e.score]))}`);
  console.log("resolved 'color blue' ->", blue[0].name, "at", JSON.stringify(blue[0].rect));
  console.log("resolved 'Ellipse' ->", ellipseTool[0].name, "at", JSON.stringify(ellipseTool[0].rect));

  // ---- 2) act on those exact points with REAL CDP mouse events (what ComputerController.click/drag do)
  const centerOf = (r) => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  await click(cdp, centerOf(blue[0].rect).x, centerOf(blue[0].rect).y);
  await click(cdp, centerOf(ellipseTool[0].rect).x, centerOf(ellipseTool[0].rect).y);

  const canvasEls = ax.findElements(obs.elements, "canvas", { limit: 5 }); // fallback if not matched by name
  const mainCanvasRect = await win.webContents.executeJavaScript(`(() => { const r = document.querySelector('canvas.main-canvas').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const start = { x: mainCanvasRect.x + 150, y: mainCanvasRect.y + 120 };
  const end = { x: mainCanvasRect.x + 320, y: mainCanvasRect.y + 260 };
  await drag(cdp, start, end);
  await sleep(150);

  // ---- 3) prove it actually drew: sample the ellipse's outline for blue pixels
  const found = await win.webContents.executeJavaScript(`(() => {
    const c = document.querySelector('canvas.main-canvas');
    const ctx = c.getContext('2d');
    const r = c.getBoundingClientRect();
    const sx = ${start.x} - r.x, sy = ${start.y} - r.y, ex = ${end.x} - r.x, ey = ${end.y} - r.y;
    const cx = (sx + ex) / 2, cy = (sy + ey) / 2, rx = Math.abs(ex - sx) / 2, ry = Math.abs(ey - sy) / 2;
    const isBlue = (x, y) => { const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data; return d[2] > 180 && d[0] < 80 && d[1] < 80; };
    const points = [[cx - rx, cy], [cx + rx, cy], [cx, cy - ry], [cx, cy + ry]];
    return points.map((p) => isBlue(p[0], p[1])).filter(Boolean).length;
  })()`);
  assert.ok(found >= 2, `expected the ellipse's outline to be blue at at least 2 of 4 sample points, got ${found}`);

  console.log("TOY PAINT CHECK PASSED - a blue ellipse was selected, drawn, and confirmed on the canvas");
  win.destroy();
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error("CHECK FAILED:", err && err.stack);
    app.exit(1);
  })
);
