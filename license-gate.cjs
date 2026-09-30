// The launch gate. Until the licence server has said yes, the only window that exists is the sign-in window: the browser window, Noah
// and everything else are not even created. After sign-in a check runs every minute; when it ends (banned, deactivated, expired, device
// revoked, signed out by the admin, or the server unreachable for longer than a token lives) the app restarts into the sign-in window
// with the reason shown. There is no stored "authorized" flag to edit: the only thing held is a token the server signed.
"use strict";
const path = require("path");
const { messageFor } = require("./license-client.cjs");

const NOTICE_CODES = new Set(["access_expired", "device_conflict", "session_ended", "server_unreachable", "device_error", "bad_response", "insecure", "bad_device_proof"]);
const NOTICE_ARG = "--license-notice=";

// The reason for the last lock-out travels across the restart as a whitelisted word; it can only SHOW a message, never grant anything.
function noticeFromArgv(argv) {
  const a = (argv || []).find((x) => String(x).startsWith(NOTICE_ARG));
  const code = a ? String(a).slice(NOTICE_ARG.length) : "";
  return NOTICE_CODES.has(code) ? code : null;
}

function createLicenseGate({ app, BrowserWindow, ipcMain, powerMonitor, config, client, argv = process.argv, log = () => {}, iconPath }) {
  let win = null;
  let authorized = false;
  let resolveAuth = null;
  let handlersOn = false;
  let quitting = false;
  const notice = noticeFromArgv(argv);

  const fromLoginWindow = (e) => Boolean(win && !win.isDestroyed() && e.sender === win.webContents);

  // The licence check ended. Restart into the sign-in window with the reason.
  function onLost(code) {
    log("licence ended:", code);
    client.stop();
    const keep = process.argv.slice(1).filter((a) => !String(a).startsWith(NOTICE_ARG));
    app.relaunch({ args: keep.concat([NOTICE_ARG + code]) });
    app.exit(0);
  }

  function installHandlers() {
    if (handlersOn) return;
    handlersOn = true;
    ipcMain.handle("license:init", (e) => {
      if (!fromLoginWindow(e)) return null;
      return { configured: client.configured, setupMessage: messageFor("not_configured"), notice: notice ? { code: notice, message: messageFor(notice) } : null };
    });
    ipcMain.handle("license:login", async (e, payload) => {
      if (!fromLoginWindow(e) || authorized) return { ok: false, code: "bad_request", message: messageFor("bad_request") };
      const r = await client.login(payload && payload.username, payload && payload.password);
      if (r.ok) {
        authorized = true;
        client.start(config.heartbeatMs, onLost);
        if (powerMonitor) powerMonitor.on("resume", () => client.tickNow()); // check straight away after the Mac wakes
        setImmediate(() => { if (win && !win.isDestroyed()) win.close(); if (resolveAuth) resolveAuth(); });
      }
      return r;
    });
    ipcMain.on("license:quit", (e) => { if (fromLoginWindow(e)) app.quit(); });

    // Tell the server when the app quits, so the console shows the user as offline (a short cap: quitting must never hang).
    app.on("before-quit", (e) => {
      if (quitting || !client.session) return;
      e.preventDefault(); quitting = true;
      Promise.race([client.logout(), new Promise((r) => setTimeout(r, 1500))]).finally(() => app.quit());
    });
  }

  function showLoginWindow() {
    win = new BrowserWindow({
      width: 440, height: 620, resizable: false, maximizable: false, fullscreenable: false, show: false, autoHideMenuBar: true,
      backgroundColor: "#0f0f14", title: "Jonah", icon: iconPath,
      webPreferences: { preload: path.join(__dirname, "license-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false, webSecurity: true, spellcheck: false },
    });
    win.removeMenu();
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => { if (!authorized) app.quit(); }); // closing the sign-in window = quitting
    win.loadFile(path.join(__dirname, "license-login.html"));
    return win;
  }

  // Resolves once the server has accepted a sign-in. Never resolves otherwise: the app simply does not start.
  function authorize() {
    installHandlers();
    return new Promise((resolve) => { resolveAuth = resolve; showLoginWindow(); });
  }

  return { required: config.required, client, authorize, get window() { return win; }, noticeFromArgv };
}

module.exports = { createLicenseGate, noticeFromArgv, NOTICE_ARG };
