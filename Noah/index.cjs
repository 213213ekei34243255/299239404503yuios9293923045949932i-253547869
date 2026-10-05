// Noah/index.cjs
//
// Bootstrap: builds Noah (core + model router + agent + IPC) for a Jonah main window and exposes a
// tiny bridge the legacy Rexy runtime uses to hand browser goals to Noah when a model is available.
//
//   const noah = createNoah({ mainWindow, ipcMain, electron, dataDir, appRoot });
//   rexyRuntime.noah = noah.bridge;         // browser goals -> Noah when isAvailable()
//   noah.dispose();                          // on window close
//
// Everything degrades gracefully: with no API key and no local model, `bridge.isAvailable()` is false and
// Jonah keeps using the previous Rexy loop exactly as before.

"use strict";

const path = require("path");
const { ConfigStore } = require("./config.cjs");
const { createCore } = require("./core.cjs");
const { ModelRouter } = require("./models/router.cjs");
const { NoahAgent } = require("./agent/noah-agent.cjs");
const { CommandRouter } = require("./agent/command-router.cjs");
const lifecycle = require("./agent/lifecycle-log.cjs");
const { registerNoahIpc } = require("./ipc.cjs");
const { NoahaiProvider } = require("./models/noahai.cjs");
const { MissionService } = require("./autonomy/service.cjs");
const { looksLikeMissionTask, looksLikeDesktopTask } = require("./agent/intent.cjs");
const { createDesktopGuard, attachDesktopGuard } = require("./desktop/guard.cjs");
const { createPermissionCheck } = require("./desktop/permissions.cjs");
const { attachWebActivity } = require("./agent/web-activity.cjs");

/**
 * @param {object} o
 * @param {{ baseURL?: string, isSignedIn: () => boolean, getAuthHeaders: Function }} [o.hosted]  the hosted brain (noahai.live): how to tell the user is signed in and
 *   how to sign a request. Absent = missions have no model unless the user configured one of their own keys.
 * @param {(info: { goal: string }) => Promise<string|null>} [o.pickFolder]  asks the user for the folder a project task may work in (null = declined). Absent = no missions.
 */
function createNoah({ mainWindow, ipcMain, electron, dataDir, appRoot, log = () => {}, hosted = null, pickFolder = null }) {
  const config = new ConfigStore({ dir: dataDir, appRoot, env: process.env, safeStorage: electron.safeStorage });
  const core = createCore({ mainWindow, electron, config, dataDir, log });
  const providers = {};
  if (hosted) providers.noahai = new NoahaiProvider({ name: "noahai", baseURL: hosted.baseURL || config.getBaseURL("noahai"), getKey: () => null, isSignedIn: hosted.isSignedIn, getAuthHeaders: hosted.getAuthHeaders, options: config.get().providers.noahai });
  const router = new ModelRouter({ config, bus: core.bus, providers, log });
  const agent = new NoahAgent({ core, router, config, dataDir, log });
  // THE door for instructions: voice, typed chat and UI all reach the one session through this router
  // Long jobs on the user's own project (files, commands, tests): one mission at a time, in a folder the user picks each time.
  // (on a Mac a computer task first needs the user's permission for Jonah to control the computer; on Windows the check always says yes)
  // (trying to capture the screen once is what makes macOS ask for Screen Recording and list Jonah there)
  const requestScreen = electron.desktopCapturer ? () => electron.desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }) : null;
  const checkPermissions = createPermissionCheck({ systemPreferences: electron.systemPreferences, log, requestScreen });
  // the hosted model is served only to a signed-in Jonah account: when a task is asked for and nobody is signed in, the service opens the one-time Google sign-in (see autonomy/no-model.cjs)
  const modelAccess = hosted && typeof hosted.signIn === "function" ? { isSignedIn: hosted.isSignedIn, signIn: hosted.signIn } : null;
  const missions = pickFolder ? new MissionService({ router, core, dataDir, pickFolder, getMode: () => config.get().policy.mode, log, checkPermissions, modelAccess }) : null;
  const commandRouter = new CommandRouter({ session: core.session, agent, missions, log });
  // While Noah operates the user's desktop, Jonah's own window is usually hidden behind the app Noah is working in: so a small Stop bar stays on top of everything,
  // and Ctrl+Alt+X stops the task from any program. Both exist only while a desktop task runs, and both do what the panel's Stop button does.
  const desktopGuard = missions && missions.desktop && electron.BrowserWindow && electron.globalShortcut
    ? createDesktopGuard({ electron, ipcMain, log, onStop: () => { try { if (missions.isRunning()) missions.stop(); } finally { desktopGuard.hide(); } } })
    : null;
  // the web agent's steps (looking at the page, screenshots, waiting for it to settle, each action) in the same Activity view the computer agent uses
  const detachWebActivity = attachWebActivity({ bus: core.bus, log });
  // a finished task, or a card waiting for the user's OK, is a system notification (clicking it opens Jonah): nothing jumps in front of what the user is doing
  const shown = new Set();
  const notify = ({ title, body, onClick }) => {
    if (!electron.Notification || !electron.Notification.isSupported || !electron.Notification.isSupported()) return;
    const n = new electron.Notification({ title, body, silent: false });
    shown.add(n); // kept until it is gone, or it can be collected before the user sees it
    n.on("close", () => shown.delete(n));
    n.on("click", () => { shown.delete(n); if (onClick) onClick(); });
    n.show();
  };
  const detachDesktopGuard = desktopGuard ? attachDesktopGuard({ guard: desktopGuard, bus: core.bus, mainWindow, log, notify, focusWindow: (hwnd) => missions.desktopBridge().focus(hwnd) }) : null;
  const unregisterIpc = registerNoahIpc({ ipcMain, mainWindow, core, getAgent: () => agent, getRouter: () => commandRouter, getMissions: () => missions, config });

  // Downloads started by tabs in any session get tracked (and executable downloads blocked during tasks).
  try {
    core.browser.watchSession(electron.session.fromPartition("persist:main"));
  } catch (_) {
    /* ignore */
  }

  // ---- panel compatibility: the AI panel still listens for these runtime:* channels for the parts of a run it prints as
  // chat messages (a question from the agent, the final result). Progress is NOT relayed: it is one status line driven
  // by the session_state event, so a run no longer produces a stream of messages.
  const send = (channel, payload) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  // Whether the run being reported was typed or spoken: the voice orb reads an outcome aloud only for a SPOKEN request.
  const sourceOfRun = () => (core.session.task && core.session.task.source === "voice" ? "voice" : "text");
  const off = core.bus.subscribe((e) => {
    switch (e.event) {
      case "ask_user":
        send("runtime:goal-paused", { result: { message: e.question, paused: true }, agent: true, source: sourceOfRun() });
        break;
      case "task_finished":
        if (e.superseded) break; // replaced by the user's next instruction: nothing to report
        if (e.status === "completed") send("runtime:goal-completed", { reason: e.result || "Done.", agent: true, source: sourceOfRun() });
        else if (e.status === "failed") send("runtime:goal-error", { error: e.error || "The task failed.", agent: true, source: sourceOfRun() });
        break; // cancelled = the user pressed stop: the status line already says Ready
      case "mission_activity":
        // the same plain lines the panel's Activity view shows, for whoever is watching the terminal Jonah was started from
        if (e.pending === false) console.log(`[mission] ${e.text}${e.detail ? `  | ${String(e.detail).split("\n")[0]}` : ""}`);
        break;
      case "mission_result":
        // a project task ended or stopped: the answer says what was checked; a question or a pause waits for the user; "Stopped." needs no message
        if (e.status === "cancelled" && e.text === "Stopped.") break;
        if (e.resumable) send("runtime:goal-paused", { result: { message: e.text, paused: true }, agent: true, source: e.source });
        else if (e.status === "impossible" || e.status === "unsafe") send("runtime:goal-error", { error: e.text, agent: true, source: e.source });
        else send("runtime:goal-completed", { reason: e.text, agent: true, source: e.source });
        break;
      default:
        break;
    }
  });

  const bridge = {
    isAvailable: () => agent.isAvailable() || !!(missions && missions.isAvailable()),
    // is this message the answer to a question a project task asked? (the billing gate must not count that as a new chat message)
    isMissionAnswer: (text, mode) => mode !== "chat" && !!(missions && missions.awaitingAnswer()) && !looksLikeMissionTask(String(text || "")) && !looksLikeDesktopTask(String(text || "")),
    submit: (goal, opts) => agent.submit(goal, opts),
    route: (text, opts) => commandRouter.route(text, opts),
    cancel: () => agent.stop("legacy_cancel"),
    session: () => core.session.snapshot(),
  };

  function dispose() {
    try {
      if (detachDesktopGuard) detachDesktopGuard();
      if (detachWebActivity) detachWebActivity();
      if (desktopGuard) desktopGuard.dispose();
    } catch (_) {
      /* ignore */
    }
    try {
      if (missions) missions.dispose();
    } catch (_) {
      /* ignore */
    }
    try {
      core.safety.stop("shutdown");
    } catch (_) {
      /* ignore */
    }
    off();
    unregisterIpc();
    core.dispose();
  }

  return { config, core, router, agent, missions, commandRouter, bridge, lifecycle, dispose, dataDir: path.resolve(dataDir) };
}

module.exports = { createNoah };
