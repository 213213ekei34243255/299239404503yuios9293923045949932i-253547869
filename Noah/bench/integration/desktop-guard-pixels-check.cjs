// Noah/bench/integration/desktop-guard-pixels-check.cjs
//
// Does the Stop bar really SHOW? This looks at the actual pixels on the screen under the bar (never the rest of the screen), because reading the bar's text from JavaScript
// (what desktop-guard-check.cjs does) says nothing about whether anything is visible: on the development machine the bar was a blank dark strip, or a white box through which the
// page showed, whenever it was made click-through before its first paint, and every older check still passed. This one failed on that bug and passes on the fix.
//
//   node_modules/electron/dist/electron.exe --user-data-dir=<fresh temp folder> Noah/bench/integration/desktop-guard-pixels-check.cjs
//
// It flashes the bar at the bottom right of the screen for about four seconds. Do not run it while someone is working in front of the screen: it is a visible window.
"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const { app, BrowserWindow, screen, globalShortcut, ipcMain, nativeImage } = require("electron");
const { createDesktopGuard } = require("../../desktop/guard.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${extra ? `  -> ${extra}` : ""}`); if (!ok) failures++; };
setTimeout(() => { console.log("FAIL  timed out"); app.exit(3); }, 60_000); // never leave a window on the user's screen
app.on("window-all-closed", () => {}); // the check closes the bar itself: do not quit between steps

function grab(rect, file) {
  return new Promise((resolve) => {
    const ps = `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap(${rect.width},${rect.height}); $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${rect.x},${rect.y},0,0,$b.Size); $b.Save('${file.replace(/\\/g, "/")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
    spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, stdio: "ignore" }).on("exit", () => resolve());
  });
}

/** What share of the strip is the bar's own dark colour, white, the purple border/accent, and bright text-like pixels (the words and the red Stop button). */
function stats(file) {
  const img = nativeImage.createFromPath(file);
  const bmp = img.toBitmap();
  let dark = 0, white = 0, accent = 0, bright = 0, red = 0, n = 0;
  for (let i = 0; i < bmp.length; i += 4) {
    const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2]; n++;
    if (r > 235 && g > 235 && b > 235) white++;
    if (r < 60 && g < 40 && b < 80) dark++;
    else if (r > 100 && b > 150 && g < 90) accent++;
    if (r > 200 && g < 110 && b < 110) red++; // the Stop button
    if (r > 150 && g > 150 && b > 150) bright++; // text
  }
  const pct = (x) => (100 * x) / n;
  return { dark: pct(dark), white: pct(white), accent: pct(accent), red: pct(red), bright: pct(bright) };
}

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "noah-px-"));
  try {
    const guard = createDesktopGuard({ electron: { BrowserWindow, screen, globalShortcut }, ipcMain, onStop: () => {}, log: (m) => console.log("log:", m) });
    guard.show("Brought WhatsApp to the front");
    await sleep(1500);
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Noah is working");
    check(!!win && win.isVisible(), "the Stop bar is on screen");
    if (win) {
      const rect = screen.dipToScreenRect(win, win.getBounds());
      const shoot = async (label) => {
        const file = path.join(tmp, `${label}.png`);
        await grab(rect, file);
        return stats(file);
      };
      const painted = (s) => s.white < 15 && s.dark > 55 && s.dark < 92 && s.red > 1.5 && s.bright > 2;
      let s = await shoot("fresh");
      check(painted(s), "the bar is really painted: its own dark colour, the red Stop button and the words (not a blank strip, not a white box)", JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, +v.toFixed(1)]))));
      // the pointer entering and leaving the Stop button switches click-through off and on: the bar must stay painted through it
      for (const v of [false, true, false, true, false, true]) { win.setIgnoreMouseEvents(v); await sleep(80); }
      await sleep(300);
      s = await shoot("toggled");
      check(painted(s), "...and it stays painted after the pointer has gone on and off the Stop button", JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, +v.toFixed(1)]))));
      guard.setText("Clicked \"Ansuman\"");
      await sleep(500);
      s = await shoot("text");
      check(painted(s), "...and after the words change", JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, +v.toFixed(1)]))));
    }
    guard.hide();
    await sleep(300);
    check(!BrowserWindow.getAllWindows().some((w) => w.getTitle() === "Noah is working"), "the bar is gone when the task ends");
  } catch (e) {
    check(false, "the check itself ran", e && e.message);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* a leftover temp folder is harmless */ }
  }
  console.log(`RESULT desktop-guard-pixels ${failures ? "FAIL" : "ok"}`);
  app.exit(failures ? 1 : 0);
});
