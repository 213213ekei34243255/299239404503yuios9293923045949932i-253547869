// Noah/bench/integration/desktop-guard-check.cjs
//
// Does the user's brake really work in REAL Electron on REAL Windows while another application is in front?
//   * the Stop bar appears at the bottom of the screen, above everything, WITHOUT taking the keyboard focus from the application in front
//   * a real Ctrl+Alt+X keystroke (injected through Windows by a separate process, like a hand on the keyboard) stops the task
//   * a real mouse click on the bar's Stop button stops it, again without changing which window is in front
//   * when the task ends the shortcut is released and the bar is gone
//   * if another program already holds the shortcut, the bar still works
//   * the bar is small (bottom right) and the mouse goes THROUGH it everywhere except over its Stop button (proved by clicking through it onto a window underneath)
//   * a task runs in the BACKGROUND: starting one shows no bar, only Noah's takeovers do; and NOTHING comes to the front by itself (a card waiting for the user's OK is a
//     notification; clicking the notification is what opens Jonah)
//
// "The application in front" is the purpose-built Noah Fixture window (never a program the user owns). Nothing is sent anywhere.
//
//   node Noah/bench/integration/desktop-guard-check.cjs
//
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const IS_ELECTRON = !!(process.versions && process.versions.electron);
const FIXTURE = path.join(ROOT, "Noah", "test", "fixtures", "desktop-fixture.ps1");
const REAL_INPUT = path.join(ROOT, "Noah", "test", "fixtures", "real-input.ps1");

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, what, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${extra ? `  -> ${extra}` : ""}`); if (!ok) failures++; };
const until = async (fn, ms = 4000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < ms) { last = await fn(); if (last) return last; await sleep(100); } return last; };
// async on purpose: a blocking call would freeze this (Electron main) process while the input is made, and the bar watches the pointer from this very process
const realInputAsync = (...args) => new Promise((resolve) => { const c = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", REAL_INPUT, ...args], { windowsHide: true }); let out = "", err = ""; c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { err += d; }); c.on("exit", (status) => resolve({ status, stdout: out, stderr: err })); });

async function runner() {
  const { app, BrowserWindow, screen, globalShortcut, ipcMain } = require("electron");
  const { createDesktopGuard, attachDesktopGuard, SHORTCUT } = require(path.join(ROOT, "Noah", "desktop", "guard.cjs"));
  const { DesktopBridge } = require(path.join(ROOT, "Noah", "desktop", "bridge.cjs"));
  const { EventBus } = require(path.join(ROOT, "Noah", "events.cjs"));

  const token = "G" + Math.random().toString(36).slice(2, 8);
  const bridge = new DesktopBridge();
  const fixture = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", FIXTURE, "-Token", token, "-Seconds", "120", "-Left", "120", "-Top", "120"], { stdio: "ignore" });
  const cleanup = () => { try { spawnSync("taskkill", ["/pid", String(fixture.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch (_) { /* gone */ } try { bridge.dispose(); } catch (_) { /* gone */ } };
  process.on("exit", cleanup);

  // Jonah's own window: it must be BEHIND the fixture, as it is when Noah brings another program forward
  const main = new BrowserWindow({ width: 420, height: 300, x: 700, y: 120, show: true, title: `Jonah ${token}`, webPreferences: { contextIsolation: true, sandbox: true } });
  main.on("page-title-updated", (e) => e.preventDefault());
  await main.loadURL("data:text/html,<title>x</title><body>Jonah stand-in</body>");

  const fix = await bridge.waitWindow({ title: token, waitMs: 20_000 });
  const frontTitle = async () => { const w = (await bridge.windows()).find((x) => x.foreground); return w ? w.title : ""; };
  await bridge.focus(fix.window);
  const fixtureInFront = await until(async () => (await frontTitle()).includes(token), 5000);
  check(!!fixtureInFront, "set-up: the stand-in application is in front", await frontTitle());
  if (!fixtureInFront) { console.log("RESULT desktop-guard FAIL (cannot continue: no application in front, so no key or click will be injected)"); app.exit(1); return; }

  let stops = 0;
  const logs = [];
  const guard = createDesktopGuard({ electron: { BrowserWindow, screen, globalShortcut }, ipcMain, onStop: () => { stops++; }, log: (m) => logs.push(m) });
  const pill = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle() === "Noah is working");
  const pillText = () => pill().webContents.executeJavaScript(`document.getElementById("m").textContent`);

  // ---- 1. the bar
  guard.show("Opening Notepad");
  const diag = [];
  { const q = pill(); if (q) { const wc = q.webContents; wc.on("did-finish-load", () => diag.push("did-finish-load")); wc.on("did-fail-load", (_e, c, d) => diag.push(`did-fail-load ${c} ${d}`)); wc.on("preload-error", (_e, pth, err) => diag.push(`preload-error ${err && err.message}`)); wc.on("render-process-gone", (_e, d) => diag.push(`render-process-gone ${JSON.stringify(d)}`)); wc.on("console-message", (_e, lvl, msg) => { if (lvl >= 2 && !/Security Warning/.test(msg)) diag.push(`console ${msg}`); }); } }
  await until(() => pill() && pill().isVisible(), 5000);
  const p = pill();
  if (!(p && p.isVisible())) console.log(`DIAG  the bar did not become visible: ${diag.join(" | ") || "no events at all"}; guard log: ${logs.join(" | ")}`);
  check(!!p && p.isVisible(), "the Stop bar is on screen");
  check(!!p && p.isAlwaysOnTop(), "it is always on top");
  const wa = screen.getPrimaryDisplay().workArea;
  const b = p.getBounds();
  check(Math.abs(b.x + b.width - (wa.x + wa.width - 16)) <= 2 && b.y + b.height <= wa.y + wa.height && b.y > wa.y + wa.height / 2 && b.width <= 400 && b.height <= 40, "it is small and sits at the bottom right of the screen, above the taskbar", JSON.stringify(b));
  check(p.isFocusable() === false, "it cannot take the keyboard focus");
  check((await pillText()) === "Opening Notepad", "it shows what Noah is doing", await pillText());
  check((await frontTitle()).includes(token), "showing the bar did not take the front from the application", await frontTitle());
  check(globalShortcut.isRegistered(SHORTCUT) && guard.shortcutActive(), `${SHORTCUT} is registered`);
  guard.setText("<b>bold</b> & <img src=x onerror=alert(1)>");
  check((await pillText()) === "<b>bold</b> & <img src=x onerror=alert(1)>", "words are shown as plain text, never as markup", await pillText());
  const pageHasNode = await p.webContents.executeJavaScript(`typeof require !== "undefined" || typeof process !== "undefined"`);
  check(pageHasNode === false, "the bar's page has no Node.js in it");
  const exposed = await p.webContents.executeJavaScript(`Object.keys(window.noahPill).sort().join(",")`);
  check(exposed === "onText,stop", "the page can only say Stop and hear what Noah is doing", exposed);

  // ---- 2. the real keyboard shortcut, with the other application in front
  const before = stops;
  const chord = await realInputAsync("-Op", "chord", "-Keys", "ctrl,alt,x");
  check(chord.status === 0 && /pressed/.test(chord.stdout || ""), "a real Ctrl+Alt+X was pressed through Windows", (chord.stderr || chord.stdout || "").trim().slice(0, 120));
  const gotKey = await until(() => stops > before, 3000);
  check(!!gotKey, "...and it stopped the task from inside the other application", `stops=${stops}`);
  check((await frontTitle()).includes(token), "...without changing which window is in front", await frontTitle());

  // ---- 3. the real mouse click on Stop
  const btn = await p.webContents.executeJavaScript(`(() => { const r = document.getElementById("s").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const cb = p.getContentBounds();
  const phys = screen.dipToScreenPoint({ x: Math.round(cb.x + btn.x), y: Math.round(cb.y + btn.y) });
  const inside = (() => { const pb = screen.dipToScreenRect(p, p.getBounds()); return phys.x >= pb.x && phys.x <= pb.x + pb.width && phys.y >= pb.y && phys.y <= pb.y + pb.height; })();
  check(inside, "the Stop button's position on screen was worked out and lies inside the bar", JSON.stringify(phys));
  const before2 = stops;
  if (inside) {
    const click = await realInputAsync("-Op", "click", "-X", String(phys.x), "-Y", String(phys.y));
    check(click.status === 0 && /clicked/.test(click.stdout || ""), "a real mouse click was made on the Stop button", (click.stderr || click.stdout || "").trim().slice(0, 120));
    check(!!(await until(() => stops > before2, 3000)), "...and it stopped the task", `stops=${stops}`);
    check((await frontTitle()).includes(token), "...and clicking the bar did not take the front from the application either", await frontTitle());
  }

  // ---- 3b. the mouse goes THROUGH the bar everywhere except over its Stop button: a window underneath the bar's left part gets a real click, and Stop does not fire
  {
    const bb = p.getBounds();
    const under = new BrowserWindow({ x: bb.x + 8, y: bb.y + 4, width: 90, height: 24, frame: false, focusable: false, skipTaskbar: true, show: false, webPreferences: { contextIsolation: true } });
    await under.loadURL("data:text/html,<body style='margin:0;background:%2300aa00'><script>window.n=0;document.addEventListener('mousedown',()=>window.n++)</script>");
    under.setAlwaysOnTop(true, "floating");
    under.showInactive();
    p.setAlwaysOnTop(true, "screen-saver"); // the bar stays above it
    await sleep(500);
    const spot = screen.dipToScreenPoint({ x: bb.x + 40, y: bb.y + 16 });
    const stopsBefore = stops;
    await realInputAsync("-Op", "click", "-X", String(spot.x), "-Y", String(spot.y));
    await sleep(700);
    const reached = await under.webContents.executeJavaScript("window.n");
    check(reached === 1 && stops === stopsBefore, "the bar lets a real click through where it is not the Stop button: the window underneath got it, and Stop did not fire", `underneath got ${reached} click(s); stops ${stops - stopsBefore}`);
    under.destroy();
  }

  // ---- 4. the task ends: everything is released
  guard.hide();
  await sleep(300);
  check(!pill(), "when the task ends the bar is gone");
  check(!globalShortcut.isRegistered(SHORTCUT), `${SHORTCUT} is released for other programs`);
  const before3 = stops;
  await realInputAsync("-Op", "chord", "-Keys", "ctrl,alt,x");
  await sleep(900);
  check(stops === before3, "pressing it now does nothing", `stops=${stops}`);

  // ---- 5. another program already holds the shortcut
  check(globalShortcut.register(SHORTCUT, () => {}), "set-up: another 'program' takes Ctrl+Alt+X");
  guard.show("Waiting");
  await until(() => pill() && pill().isVisible(), 5000);
  check(!!pill() && pill().isVisible() && guard.shortcutActive() === false, "the bar still shows, and says the shortcut is not active");
  check(logs.some((l) => /could not be registered/.test(l)), "the reason is logged", logs.at(-1) || "");
  guard.hide();
  globalShortcut.unregister(SHORTCUT);

  // ---- 6. the task runs in the BACKGROUND, and nothing comes to the front by itself
  const toasts = [];
  const bus = new EventBus();
  const detach = attachDesktopGuard({ guard, bus, mainWindow: main, log: (m) => logs.push(m), notify: (n) => toasts.push(n), focusWindow: (hwnd) => bridge.focus(hwnd), bar: "takeover" }); // the QUIET mode (the default shows the bar for the whole task: section 7)
  await bridge.focus(fix.window);
  await until(async () => (await frontTitle()).includes(token), 4000);
  check((await frontTitle()).includes(token), "set-up: the application is in front, as when the user is working in it", await frontTitle());
  bus.publish("mission_started", { desktop: true });
  await sleep(700);
  check(!pill() && globalShortcut.isRegistered(SHORTCUT), "a computer task starting arms Ctrl+Alt+X and shows NO bar: it works quietly in the background");
  bus.publish("desktop_takeover", { state: "active", text: "Using Notepad" });
  await until(() => pill() && pill().isVisible(), 5000);
  check(!!pill() && pill().isVisible() && (await pillText()) === "Using Notepad", "when Noah takes over the mouse or keyboard the bar shows, and says what it is doing", pill() ? await pillText() : "no bar");
  check((await frontTitle()).includes(token), "...and it did not take the front from the application", await frontTitle());
  bus.publish("desktop_takeover", { state: "idle" });
  await sleep(400);
  check(!pill() && globalShortcut.isRegistered(SHORTCUT), "when Noah lets go the bar goes and the shortcut stays armed");
  bus.publish("confirm_request", { id: "c1", summary: "Press Delete everything" });
  await sleep(1200);
  check((await frontTitle()).includes(token), "a card waiting for the user's OK did NOT bring Jonah to the front", await frontTitle());
  check(toasts.length === 1 && toasts[0].title === "Noah needs your OK" && /Delete everything/.test(toasts[0].body), "a notification was raised instead", JSON.stringify(toasts[0] || null));
  toasts[0].onClick(); // the USER clicks the notification
  await sleep(1500);
  const nowFront = await frontTitle();
  check(nowFront.includes(`Jonah ${token}`), "clicking the notification (the user's own act) opened Jonah's window, and it really is in front (what WINDOWS says)", `front is now "${nowFront}"`);
  bus.publish("mission_finished", { status: "succeeded", summary: "Done: two files were renamed." });
  await sleep(400);
  check(toasts.length === 2 && toasts[1].title === "Noah finished" && /two files/.test(toasts[1].body), "a task that finishes on its own is announced by a notification with the first words of the answer", JSON.stringify(toasts[1] || null));
  check(!pill() && !globalShortcut.isRegistered(SHORTCUT), "and the end of the task removes the bar and releases the shortcut");
  detach();

  // ---- 7. the default: the Stop bar shows for the WHOLE computer task, says what Noah is doing, and goes when the task ends
  {
    const bus2 = new EventBus();
    const detach2 = attachDesktopGuard({ guard, bus: bus2, mainWindow: main, log: (m) => logs.push(m), notify: () => {}, focusWindow: (hwnd) => bridge.focus(hwnd) });
    bus2.publish("mission_started", { desktop: true });
    await until(() => pill() && pill().isVisible(), 5000);
    check(!!pill() && pill().isVisible(), "by default the Stop bar is on screen as soon as a computer task starts (before any step)");
    bus2.publish("mission_activity", { text: "Looked at the open windows (4 windows)" });
    await sleep(300);
    check((await pillText()) === "Looked at the open windows (4 windows)", "and it says what Noah just did", await pillText());
    bus2.publish("desktop_takeover", { state: "idle" });
    await sleep(300);
    check(!!pill() && pill().isVisible(), "Noah letting go of the mouse between steps does not hide it");
    bus2.publish("mission_finished", { status: "cancelled" });
    await sleep(400);
    check(!pill() && !globalShortcut.isRegistered(SHORTCUT), "when the task ends the bar goes and the shortcut is released");
    detach2();
  }

  guard.dispose();
  check(globalShortcut.isRegistered(SHORTCUT) === false, "nothing is left registered at the end");
  cleanup();
  console.log(`RESULT desktop-guard ${failures ? "FAIL" : "ok"}`);
  app.exit(failures ? 1 : 0);
}

async function driver() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "noah-guard-ud-"));
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const child = spawn(electronPath, [`--user-data-dir=${tmp}`, __filename, ...process.argv.slice(2)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let err = "";
  child.stdout.on("data", (x) => process.stdout.write(x));
  child.stderr.on("data", (x) => { err += x; });
  const code = await new Promise((resolve) => { const t = setTimeout(() => { spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); resolve(-99); }, 120_000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  await sleep(800); // Electron lets go of its profile folder a moment after it exits
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* a leftover temp folder is harmless */ }
  if (code === -99) console.log("FAIL  timed out");
  else if (code !== 0 && err.trim()) console.log(err.split(/\r?\n/).filter((l) => l.trim()).slice(0, 12).join("\n"));
  process.exit(code === 0 ? 0 : 1);
}

if (process.platform !== "win32") { console.log("SKIP  this check needs Windows"); process.exit(0); }
if (IS_ELECTRON) require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e && e.stack); require("electron").app.exit(2); }));
else driver().catch((e) => { console.error(e); process.exit(2); });
