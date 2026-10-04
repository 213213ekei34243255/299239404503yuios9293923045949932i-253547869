// Noah/desktop/guard.cjs
//
// The user's hand on the brake while Noah operates their computer, WITHOUT getting in their way. Noah works in the background: most of what it does (reading, pressing a
// control, filling a field) needs neither the mouse nor the keyboard. Only when it must take them over, and only after the user has stopped using them, does it show itself:
//
//   * a GLOBAL shortcut, Ctrl+Alt+X (Control+Option+X on a Mac), armed for the whole task, stops it from any program. (Not Esc: Noah itself presses Esc to close dialogs.
//     Noah is also forbidden to press any Ctrl+Alt combination, so it can never trigger its own kill switch.)
//   * a small bar, only WHILE Noah is taking over the mouse or keyboard, or waiting for the user to stop using them. It never takes the keyboard focus, the mouse passes
//     through it except over its Stop button (the main process watches where the pointer is: Electron's own "forward mouse moves" delivered nothing on the test machine),
//     and it goes again as soon as Noah has let go.
//   * nothing else comes to the front by itself: a finished task, or a question that needs the user's OK, is a system notification (clicking it opens Jonah) and a flash
//     of Jonah's taskbar button. Jonah never jumps in front of what the user is doing.
//
// All of it exists only while a computer task runs, and everything calls the same stop as the panel's Stop button. The Electron pieces are injected, so this is tested with a
// stand-in and again in real Electron.

"use strict";

const path = require("path");

const SHORTCUT = "Control+Alt+X";
const WIDTH = 360;
const HEIGHT = 36;

// what the bar tells the user to press: the Mac's Alt key is called Option
const keyName = (platform) => (platform === "darwin" ? "Control+Option+X" : "Ctrl+Alt+X");

const pillHtml = (platform = process.platform) => `<!doctype html><meta charset="utf-8"><title>Noah is working</title>
<style>
  html, body { margin: 0; height: 100%; background: #140c28; font: 12.5px 'Segoe UI', system-ui, sans-serif; color: #fff; overflow: hidden; user-select: none; }
  .pill { display: flex; align-items: center; gap: 8px; height: 100%; box-sizing: border-box; padding: 0 6px 0 12px; background: #140c28; border: 1px solid #7C3AED; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #a855f7; animation: p 1.2s ease-in-out infinite; }
  @keyframes p { 50% { opacity: .3; } }
  .msg { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hint { flex: none; opacity: .6; font-size: 10.5px; }
  button { all: unset; flex: none; cursor: pointer; background: #ef4444; color: #fff; font-weight: 700; padding: 4px 12px; border-radius: 6px; }
  button:hover { background: #dc2626; }
</style>
<div class="pill"><span class="dot"></span><span class="msg" id="m">Noah is using your computer</span><span class="hint">${keyName(platform)}</span><button id="s" type="button">Stop</button></div>
<script>
  document.getElementById("s").addEventListener("click", () => window.noahPill.stop());
  window.noahPill.onText((t) => { document.getElementById("m").textContent = t; });
</script>`;
const PILL_HTML = pillHtml("win32");

/**
 * @param {object} o
 * @param {{ BrowserWindow: any, screen: any, globalShortcut: any }} o.electron
 * @param {{ on: Function, removeListener?: Function, removeAllListeners?: Function }} o.ipcMain
 * @param {() => void} o.onStop     what Stop does (the same as the panel's Stop button)
 * @param {(m: string) => void} [o.log]
 * @param {string} [o.platform]
 */
function createDesktopGuard({ electron, ipcMain, onStop, log = () => {}, platform = process.platform, every = (fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); return t; }, stopEvery = clearInterval }) {
  const { BrowserWindow, screen, globalShortcut } = electron;
  let win = null;
  let shortcut = false;
  let armed = false;
  const fromBar = (event) => !!(win && !win.isDestroyed() && event.sender === win.webContents); // only the bar's own page counts
  const onStopMsg = (event) => { if (fromBar(event)) onStop(); };
  ipcMain.on("noah:pill-stop", onStopMsg);
  let pollTimer = null;
  let latest = ""; // the newest words for the bar: a step that happens while the page is still loading is not lost
  const stopPolling = () => { if (pollTimer) { stopEvery(pollTimer); pollTimer = null; } };

  /**
   * The bar lets the mouse through everywhere except over its Stop button, so it can never sit between Noah (or the user) and what is underneath. The page cannot tell when the
   * pointer arrives while it is click-through, so the main process watches the pointer: click-through on, except while the pointer is over the button.
   */
  function watchPointer(rect) {
    stopPolling();
    let over = null;
    pollTimer = every(() => {
      if (!win || win.isDestroyed()) { stopPolling(); return; }
      try {
        const b = win.getBounds(), c = screen.getCursorScreenPoint();
        const now = c.x >= b.x + rect.x - 4 && c.x <= b.x + rect.x + rect.w + 4 && c.y >= b.y + rect.y - 4 && c.y <= b.y + rect.y + rect.h + 4;
        if (now !== over) { over = now; win.setIgnoreMouseEvents(!now); }
      } catch (_) { /* the window is going away */ }
    }, 25);
  }

  function position() {
    try {
      const wa = screen.getPrimaryDisplay().workArea;
      return { x: Math.round(wa.x + wa.width - WIDTH - 16), y: Math.round(wa.y + wa.height - HEIGHT - 12) }; // bottom right, above the taskbar
    } catch (_) {
      return { x: 100, y: 100 };
    }
  }

  function registerShortcut() {
    if (shortcut) return;
    try {
      shortcut = !!globalShortcut.register(SHORTCUT, () => onStop());
      if (!shortcut) log(`${SHORTCUT} could not be registered (another program may hold it): the Stop bar still works`);
    } catch (e) {
      shortcut = false;
      log(`${SHORTCUT} could not be registered: ${e && e.message}`);
    }
  }

  return {
    SHORTCUT,
    isShowing: () => !!(win && !win.isDestroyed()),
    isArmed: () => armed,
    shortcutActive: () => shortcut,

    /** A computer task has started: the shortcut is armed (nothing is shown). */
    arm() {
      armed = true;
      registerShortcut();
    },

    /** Show the bar (Noah is taking over the mouse or keyboard, or waiting for the user to stop using them). Safe to call again: it just updates the words. */
    show(text = "Noah is using your computer") {
      if (!armed) this.arm();
      if (win && !win.isDestroyed()) { this.setText(text); return; }
      const { x, y } = position();
      win = new BrowserWindow({
        // NOT transparent: a transparent + always-on-top + frameless window created a few seconds after start-up never finished loading and stalled the whole main
        // process for ~20 s on the test machine (found with the real-Electron check). An opaque bar loads in ~300 ms at any time.
        width: WIDTH, height: HEIGHT, x, y, frame: false, transparent: false, backgroundColor: "#140c28", resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
        skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false, hasShadow: false, title: "Noah is working",
        webPreferences: { preload: path.join(__dirname, "pill-preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
      });
      try { win.setAlwaysOnTop(true, "screen-saver"); } catch (_) { /* older Electron */ }
      // (click-through is switched on only AFTER the bar has been shown: see below)
      try { if (platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) { /* older Electron */ }
      latest = String(text || "").replace(/\s+/g, " ").trim().slice(0, 60);
      const mine = win;
      win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pillHtml(platform))}`)
        .then(async () => {
          if (win !== mine || mine.isDestroyed()) return;
          this.setText(latest || text);
          mine.showInactive();
          // The mouse passes through the bar except over Stop. This is switched on AFTER the first paint, never at creation: on the test machine a window made click-through before it
          // had painted showed NO content at all (a blank dark strip, or a white box: the user saw an invisible bar), while the same window made click-through a moment after it was
          // shown painted normally. Opacity 0.99 (invisible to the eye) is a second safeguard that also painted correctly. Found by looking at the real screen pixels
          // (Noah/bench/integration/desktop-guard-pixels-check.cjs): reading the page's text from JavaScript, which the older checks did, says nothing about whether it is visible.
          try { mine.setOpacity(0.99); } catch (_) { /* older Electron */ }
          try { mine.setIgnoreMouseEvents(true); } catch (_) { /* older Electron */ }
          const rect = await mine.webContents.executeJavaScript(`(() => { const r = document.getElementById("s").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
          if (win === mine && !mine.isDestroyed()) watchPointer(rect);
        })
        .catch((e) => log(`stop bar failed to load: ${e && e.message}`));
    },

    /** What Noah is doing now, in a few words. */
    setText(text) {
      const t = String(text || "").replace(/\s+/g, " ").trim().slice(0, 60);
      latest = t;
      if (!win || win.isDestroyed()) return;
      try { win.webContents.send("noah:pill-text", t); } catch (_) { /* the page is still loading */ }
    },

    /** Noah has let go of the mouse and keyboard: the bar goes (the shortcut stays armed until the task ends). */
    hideBar() {
      stopPolling();
      if (win && !win.isDestroyed()) { try { win.close(); } catch (_) { /* gone */ } }
      win = null;
    },

    /** The task is over: the bar goes and the shortcut is released. */
    hide() {
      this.hideBar();
      if (shortcut) { try { globalShortcut.unregister(SHORTCUT); } catch (_) { /* gone */ } shortcut = false; }
      armed = false;
    },

    dispose() {
      this.hide();
      const off = (ch, fn) => { try { ipcMain.removeListener ? ipcMain.removeListener(ch, fn) : ipcMain.removeAllListeners(ch); } catch (_) { /* gone */ } };
      off("noah:pill-stop", onStopMsg);
    },
  };
}

const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + String.fromCharCode(0x2026) : t; };

/**
 * Keep the guard in step with the task, WITHOUT ever bringing a window in front by itself:
 *   task starts (computer task)  -> the shortcut is armed, and (bar: "task", the default) the Stop bar shows for the WHOLE task, saying what Noah is doing step by step
 *   (bar: "takeover" is the quiet mode: the bar shows only while Noah takes over the mouse or keyboard, or waits for the user, and goes when Noah lets go)
 *   a card needs the user's OK   -> a notification and a taskbar flash (clicking the notification opens Jonah)
 *   the task ends on its own     -> a notification with the answer's first line (not when the user pressed Stop themselves)
 * @param {{ guard: ReturnType<typeof createDesktopGuard>, bus: { subscribe: (fn: (e: any) => void) => () => void }, mainWindow: any, log?: (m: string) => void, focusWindow?: (hwnd: number) => Promise<any>, notify?: (n: { title: string, body: string, onClick?: () => void }) => void }} o
 * @returns {() => void} unsubscribe
 */
function attachDesktopGuard({ guard, bus, mainWindow, log = () => {}, focusWindow = null, notify = () => {}, bar = "task" }) {
  // Opening Jonah: ONLY when the user asks for it by clicking a notification. Electron's own focus() mostly just flashes the taskbar from the background on Windows, so the
  // desktop helper (which knows the tricks that work) is asked too, with Jonah's own window handle.
  const raise = () => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.moveTop();
      mainWindow.focus();
      if (focusWindow) {
        const h = mainWindow.getNativeWindowHandle();
        const hwnd = h.length >= 8 ? Number(h.readBigUInt64LE(0)) : h.readUInt32LE(0);
        Promise.resolve(focusWindow(hwnd)).catch((e) => log(`the helper could not bring Jonah to the front: ${e && e.message}`));
      }
    } catch (e) {
      log(`could not bring Jonah to the front: ${e && e.message}`);
    }
  };
  const flash = () => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(true); } catch (_) { /* gone */ } };
  const tell = (n) => { try { notify({ ...n, onClick: raise }); } catch (e) { log(`could not show a notification: ${e && e.message}`); } };
  return bus.subscribe((e) => {
    switch (e && e.event) {
      case "mission_started":
        if (e.desktop) { guard.arm(); if (bar === "task") guard.show("Noah is working on your computer"); }
        break;
      case "desktop_takeover":
        if (!guard.isArmed()) break; // not a computer task
        if (e.state === "waiting" || e.state === "active") guard.show(e.text || (e.state === "waiting" ? "Waiting for you to stop using the computer" : "Noah is using your computer"));
        else if (bar !== "task") guard.hideBar(); // (in "task" mode the bar stays until the task ends)
        break;
      case "mission_activity":
        if (bar === "task" && guard.isArmed() && e.text) guard.setText(e.text); // what Noah is doing, step by step
        break;
      case "confirm_request":
        if (guard.isArmed()) { flash(); tell({ title: "Noah needs your OK", body: clip(e.summary || "A computer task is waiting for your answer in Jonah.", 140) }); }
        break;
      case "mission_finished": {
        const wasOperating = guard.isArmed();
        guard.hide();
        if (wasOperating && e.status !== "cancelled") {
          flash();
          tell({ title: e.status === "succeeded" ? "Noah finished" : "Noah stopped and needs you", body: clip(e.summary || e.reason || "Open Jonah to see the result.", 140) });
        }
        break;
      }
      case "mission_result":
        guard.hide();
        break;
      default:
        break;
    }
  });
}

module.exports = { createDesktopGuard, attachDesktopGuard, SHORTCUT, PILL_HTML, pillHtml, keyName };
