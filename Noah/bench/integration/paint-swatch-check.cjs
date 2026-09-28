// Real-CDP check of the reported bug: on a paint-style page, Noah answered "No element matches 'color blue'" for a
// colour swatch, and could not click toolbar tools ("Ellipse", "Fill With Color") either. Both are <div>s with no
// ARIA role at all (Chromium's accessibility tree gives a bare, non-semantic <div> the role "generic", which
// ax.cjs's own NOISE_ROLES treats as non-interactive - true for jspaint.app and for the local /paint fixture this
// check uses, which copies its exact markup so the check has no external network dependency).
//
// Drives the SAME CdpSession + Observer + ax.findElements pipeline Noah's agent uses, directly (no full app boot):
//   real accessibility tree -> observer.observe() (now runs _addTitledButtons/_addColorSwatches) -> ax.findElements
//
//   npx electron Noah/bench/integration/paint-swatch-check.cjs
"use strict";

const path = require("path");
const assert = require("node:assert/strict");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const { createServer } = require("../fixtures.cjs");
const { CdpSession } = require(path.join(ROOT, "Noah", "browser", "cdp.cjs"));
const { Observer } = require(path.join(ROOT, "Noah", "perception", "observer.cjs"));
const ax = require(path.join(ROOT, "Noah", "perception", "ax.cjs"));

app.on("window-all-closed", () => {});

async function main() {
  const fx = await createServer();
  const win = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true, partition: "paint-swatch-check" } });
  await win.loadURL(fx.url("/paint"));
  const cdp = new CdpSession(win.webContents, { log: () => {} });
  await cdp.attach();
  await new Promise((r) => setTimeout(r, 300));

  const observer = new Observer({ cdp, refs: new ax.RefTable() });
  const obs = await observer.observe({});

  // ---- 1) BEFORE this fix's kind of promotion existed, none of these had a usable AX role at all: prove they are
  // real, ordinary role="generic" elements in the raw tree (the actual mechanism of the bug), not something the
  // fixture made up.
  const rawNodes = await cdp.send("Accessibility.getFullAXTree");
  const rawEllipse = rawNodes.nodes.find((n) => (n.name && n.name.value) === "Ellipse");
  assert.ok(rawEllipse, "the fixture's Ellipse tool exists in the raw accessibility tree");
  assert.equal(rawEllipse.role && rawEllipse.role.value, "generic", "Chromium gives a bare <div title=\"Ellipse\"> the role 'generic' - confirms this is a real gap, not a hypothetical one");

  // ---- 2) the fix: both kinds of element are now in Noah's OWN element list, findable and clickable by name
  const byName = (q) => ax.findElements(obs.elements, q, { limit: 5 });

  const ellipse = byName("Ellipse");
  assert.ok(ellipse.length && ellipse[0].score >= 45, `"Ellipse" should resolve (>=45); got ${JSON.stringify(ellipse.map((e) => [e.name, e.score]))}`);
  assert.equal(ellipse[0].role, "button");
  assert.ok(ellipse[0].rect && ellipse[0].rect.width > 0, "has a real, clickable rect");

  const fill = byName("Fill With Color");
  assert.ok(fill.length && fill[0].score >= 45, `"Fill With Color" should resolve; got ${JSON.stringify(fill.map((e) => [e.name, e.score]))}`);

  // the exact reported query
  const blueByPhrase = byName("color blue");
  assert.ok(blueByPhrase.length && blueByPhrase[0].score >= 45, `"color blue" (the reported failing query) should now resolve; got ${JSON.stringify(blueByPhrase.map((e) => [e.name, e.score]))}`);
  assert.match(blueByPhrase[0].name, /blue/i);

  const blueByWord = byName("blue");
  assert.ok(blueByWord.length && blueByWord[0].score >= 45);

  const green = byName("green");
  assert.match(green[0].name, /green/i);
  // the red and green swatches must resolve to DIFFERENT elements, at different points
  const red = byName("red");
  assert.notEqual(red[0].ref, green[0].ref);
  assert.notEqual(Math.round(red[0].rect.x), Math.round(green[0].rect.x));

  // ---- 3) resolveTarget-shape guarantee: "blue" must not be ambiguous (several equally-good matches), which is
  // what the real resolveTarget() in browser-controller.cjs requires before it will click anything by text.
  const contenders = blueByWord.filter((e) => e.score >= blueByWord[0].score - 8);
  assert.equal(contenders.length, 1, `"blue" must identify exactly one element, not ${contenders.length}`);

  // ---- 4) the actual drawing canvas must NOT be swept up as a "white colour swatch" (it is 400x300, far past the
  // swatch size cap) - if it were, "white"/a screenshot-based click could land on the canvas instead of a real swatch.
  const bigWhite = obs.elements.filter((e) => e.swatchColor && e.rect && e.rect.width > 90);
  assert.equal(bigWhite.length, 0, "the main canvas must not be treated as a colour swatch");

  console.log("PAINT SWATCH CHECK PASSED");
  console.log("  Ellipse ->", JSON.stringify(ellipse[0].rect), "score", ellipse[0].score);
  console.log("  color blue ->", blueByPhrase[0].name, JSON.stringify(blueByPhrase[0].rect), "score", blueByPhrase[0].score);
  win.destroy();
  await fx.close();
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error("CHECK FAILED:", err && err.stack);
    app.exit(1);
  })
);
