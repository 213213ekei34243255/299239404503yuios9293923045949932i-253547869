// Noah/test/unit/desktop-pointing-real.test.cjs - the computer agent POINTS where it means to, with the REAL helper, a REAL window and a REAL mouse.
// A small test window (Noah/test/fixtures/pointing-fixture.ps1) has named buttons and an unnamed solid red square at known places. The picture the model would be shown is
// taken, the red square is found IN THAT PICTURE by its pixels, and a click is made at those picture coordinates through the real tool: it must press the square on the real screen.
// Skipped off Windows, or with NOAH_SKIP_DESKTOP_TESTS=1. Windows flash up for a few seconds and the mouse moves.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const zlib = require("zlib");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");
const { DesktopBridge } = require("../../desktop/bridge.cjs");
const { DesktopTools } = require("../../desktop/tools.cjs");

const skip = process.platform !== "win32" || process.env.NOAH_SKIP_DESKTOP_TESTS === "1";
const T = { skip, timeout: 120_000 };
const FIXTURE = path.join(__dirname, "..", "fixtures", "pointing-fixture.ps1");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A small PNG decoder (8-bit RGB or RGBA, not interlaced): enough to read the picture the model is shown. Returns { width, height, px(x, y) -> [r, g, b, a] }. */
function decodePng(buf) {
  assert.equal(buf.slice(1, 4).toString(), "PNG");
  let pos = 8, width = 0, height = 0, depth = 0, color = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.slice(pos + 4, pos + 8).toString(), data = buf.slice(pos + 8, pos + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; color = data[9]; }
    if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  assert.equal(depth, 8);
  const bpp = color === 6 ? 4 : color === 2 ? 3 : 0;
  assert.ok(bpp, "colour type " + color);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * bpp, out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, px: (x, y) => { const o = y * stride + x * bpp; return [out[o], out[o + 1], out[o + 2], bpp === 4 ? out[o + 3] : 255]; } };
}
/** Bounding box and centre of every pixel the test accepts. */
function findPixels(img, accept) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0, sx = 0, sy = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (accept(img.px(x, y))) { n++; sx += x; sy += y; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return n ? { n, x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, mx: sx / n, my: sy / n } : null;
}
const isRed = ([r, g, b]) => r > 245 && g < 12 && b < 12;
const isYellow = ([r, g, b]) => r > 245 && g > 215 && g < 245 && b < 20;

let bridge, tools, fixture, win, token, hostExe;
test.before(async () => {
  if (skip) return;
  token = "P" + Math.random().toString(36).slice(2, 8);
  bridge = new DesktopBridge();
  // The window is run by a RENAMED COPY of PowerShell: Noah's own rules refuse to click a terminal, and a window whose program is "powershell" counts as one.
  hostExe = path.join(os.tmpdir(), "noah-pointing-fixture-" + token + ".exe");
  fs.copyFileSync(path.join(process.env.SystemRoot || "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), hostExe);
  fixture = spawn(hostExe, ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", FIXTURE, "-Token", token, "-Seconds", "170", "-Left", "120", "-Top", "100"], { stdio: "ignore" });
  win = await bridge.waitWindow({ title: token, waitMs: 20_000 });
  tools = new DesktopTools({ bridge, getMode: () => "autonomous", ocr: async () => [], confirm: async () => true, notify: () => {}, takeOver: true, restoreAfterMs: 60_000 });
});
test.after(async () => {
  if (skip) return;
  try { spawnSync("taskkill", ["/pid", String(fixture.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch (_) { /* gone */ }
  if (bridge) bridge.dispose();
  try { fs.rmSync(hostExe, { force: true }); } catch (_) { /* still in use: the temp folder keeps it */ }
});
const said = async () => { const nodes = (await bridge.tree(win.window)).nodes; const n = nodes.find((x) => /clicked$/.test(x.name || "")); return n ? n.name : ""; };
const until = async (fn, ms = 4000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(120); } return v; };

test("a click at the red square's place IN THE PICTURE presses it on the real screen", T, async () => {
  const r = await tools.screenshot({ window: win.window });
  assert.equal(r.ok, true, JSON.stringify(r));
  const png = decodePng(Buffer.from(tools.pendingImages[0].base64, "base64"));
  assert.ok(png.width <= 1568 && png.width === r.width && png.height === r.height, `${png.width}x${png.height}`);
  assert.match(r.note, new RegExp(`The picture is ${r.width} x ${r.height} pixels`));
  const red = findPixels(png, isRed);
  assert.ok(red && red.n > 500, "the red square is in the picture");
  const click = await tools.click({ window: win.window, x: Math.round(red.cx), y: Math.round(red.cy) });
  assert.equal(click.ok, true, JSON.stringify(click));
  assert.equal(await until(async () => ((await said()) === "RED clicked" ? "RED clicked" : "")), "RED clicked", "what the window says it was clicked on: " + (await said()));
});

test("the same click, with the picture scaled down (a small maxWidth), still lands on the square", T, async () => {
  const shot = await bridge.screenshot({ window: win.window, maxWidth: 400 });
  assert.ok(shot.scale < 1 && shot.width <= 400);
  tools._shots.set(win.window, { x: shot.x, y: shot.y, scale: shot.scale, width: shot.width, height: shot.height, marks: [] });
  const png = decodePng(Buffer.from(shot.base64, "base64"));
  const red = findPixels(png, ([r, g, b]) => r > 235 && g < 40 && b < 40);
  assert.ok(red && red.n > 100);
  // first press something else, so the label changes again
  await bridge.click({ window: win.window, x: shot.x + 60, y: shot.y + 70, force: true });
  await sleep(300);
  const click = await tools.click({ window: win.window, x: Math.round(red.cx), y: Math.round(red.cy) });
  assert.equal(click.ok, true, JSON.stringify(click));
  assert.equal(await until(async () => ((await said()) === "RED clicked" ? "RED clicked" : "")), "RED clicked");
});

test("a numbered box is a click on that control: box 'Beta' presses Beta", T, async () => {
  const r = await tools.screenshot({ window: win.window });
  assert.ok(r.marks >= 3, `marks: ${r.marks}`);
  assert.match(r.note, /Beta/);
  const m = tools._shots.get(win.window).marks.find((x) => x.name === "Beta");
  assert.ok(m, "Beta has a numbered box");
  const click = await tools.click({ mark: m.n });
  assert.equal(click.ok, true, JSON.stringify(click));
  assert.equal(await until(async () => ((await said()) === "Beta clicked" ? "Beta clicked" : "")), "Beta clicked");
});

test("the next picture shows a ring exactly where the last click landed", T, async () => {
  await tools.screenshot({ window: win.window });
  const png0 = decodePng(Buffer.from(tools.pendingImages[0].base64, "base64"));
  const red = findPixels(png0, isRed);
  const target = { x: Math.round(red.cx), y: Math.round(red.cy) };
  const c = await tools.click({ window: win.window, x: target.x, y: target.y });
  assert.equal(c.ok, true, JSON.stringify(c));
  const r = await tools.screenshot({ window: win.window });
  assert.match(r.note, /yellow ring marked 'last click'/);
  const png = decodePng(Buffer.from(tools.pendingImages[0].base64, "base64"));
  const ring = findPixels(png, isYellow);
  assert.ok(ring && ring.n > 30, "a ring is drawn");
  // the ring is a circle of radius 11 with a cross whose arms reach 17 pixels from its centre; the yellow label sits to the right and above it, so the LEFT and BOTTOM edges of the yellow are the cross's own
  assert.ok(Math.abs(ring.x0 - (target.x - 17)) <= 4 && Math.abs(ring.y1 - (target.y + 17)) <= 4, `ring edges (left ${ring.x0}, bottom ${ring.y1}) vs the click (${target.x}, ${target.y}): the cross should reach (${target.x - 17}, ${target.y + 17})`);
});

test("a point outside the picture is refused, on the real window too", T, async () => {
  const r = await tools.screenshot({ window: win.window });
  const bad = await tools.click({ window: win.window, x: r.width + 40, y: 10 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "outside_picture");
});
