// Noah/bench/integration/ocr-check.cjs
//
// Real OCR through the real extraction path, in Electron's own Node (what the shipped app uses): draw known text into a
// canvas, capture it as a PNG (and re-encode as JPEG), run file-extract.cjs on the bytes, compare. Needs internet ONCE:
// tesseract.js downloads its English language data on first use (then it is cached in the folder passed to configureOcr).
//
//   npx electron Noah/bench/integration/ocr-check.cjs
"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const { extractFile, configureOcr, shutdownOcr } = require(path.join(ROOT, "file-extract.cjs"));

app.on("window-all-closed", () => {});
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function main() {
  configureOcr({ cachePath: path.join(os.tmpdir(), "jonah-ocr-cache") });
  const win = new BrowserWindow({ show: false, width: 900, height: 420, webPreferences: { sandbox: true } });
  await win.loadURL("data:text/html,<body style='margin:0;background:white'><canvas id=c width=900 height=420></canvas></body>");
  await win.webContents.executeJavaScript(`(() => {
    const c = document.getElementById('c'), x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 900, 420); x.fillStyle = '#111';
    x.font = 'bold 44px Arial'; x.fillText('Invoice 20417', 40, 80);
    x.font = '28px Arial'; x.fillText('Total due: 1,250 rupees by March 5', 40, 150);
    x.fillText('Customer: Priya Nair, Chennai', 40, 210);
    x.font = '20px Arial'; x.fillText('Payment terms are net thirty days from delivery.', 40, 280);
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  const png = img.toPNG();
  const jpg = img.toJPEG(90);
  fs.writeFileSync(path.join(os.tmpdir(), "jonah-ocr-sample.png"), png);

  const expected = ["invoice 20417", "total due 1 250 rupees by march 5", "customer priya nair chennai", "payment terms are net thirty days from delivery"];
  for (const [label, buf, name] of [["PNG", png, "scan.png"], ["JPEG", jpg, "photo.jpeg"]]) {
    const t0 = Date.now();
    const r = await extractFile(buf, name);
    const got = norm(r.text);
    const missing = expected.filter((e) => !got.includes(e));
    check(`${label}: every printed line was read back by OCR`, missing.length === 0, missing.length ? `missing: ${missing.join(" | ")}; got: ${JSON.stringify(r.text)}` : `${Date.now() - t0}ms, confidence ${r.meta.ocrConfidence}%`);
  }
  // a blank image is reported, not returned as a silent success
  await win.webContents.executeJavaScript(`(() => { const x = document.getElementById('c').getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 900, 420); })()`);
  await new Promise((r) => setTimeout(r, 200));
  const blank = await extractFile((await win.webContents.capturePage()).toPNG(), "blank.png");
  check("a blank image says so instead of returning empty text silently", blank.text === "" && /No text was found/.test(blank.warnings.join(" ")), JSON.stringify(blank.warnings));

  await shutdownOcr();
  win.destroy();
  app.exit(checks.every(Boolean) ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error("OCR CHECK FAILED:", e && e.stack);
    app.exit(1);
  })
);
