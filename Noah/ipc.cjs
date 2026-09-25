// Noah/ipc.cjs
//
// The only door between the shell renderer and Noah's main-process brain:
//
//   Renderer -> preload (contextBridge `noah`) -> ipcMain (this file) -> Agent / Core
//
// Hardening:
//   * every handler verifies the sender is the Jonah shell window's own
//     webContents (never a <webview> guest, never another window)
//   * inputs are type-checked and length-limited; config goes through sanitizePatch
//   * secrets never travel to the renderer: config is returned via publicView()
//   * webpages cannot reach these channels at all (they have no preload bridge)

"use strict";

const { cssVariables, resolveTheme } = require("./theme.cjs");
const { slog } = require("./agent/lifecycle-log.cjs");

const CHANNELS = [
  "noah:submit", "noah:command", "noah:stop", "noah:pause", "noah:resume", "noah:confirm", "noah:get-config", "noah:set-config",
  "noah:set-key", "noah:get-theme", "noah:list-tasks", "noah:resume-task", "noah:get-state", "noah:get-audit",
];

function registerNoahIpc({ ipcMain, mainWindow, core, getAgent, getRouter = () => null, config }) {
  const trusted = (event) => !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
  const guard = (fn) => async (event, ...args) => {
    if (!trusted(event)) throw new Error("noah: untrusted sender");
    return fn(...args);
  };

  ipcMain.handle("noah:submit", guard(async (goal) => {
    if (typeof goal !== "string" || !goal.trim() || goal.length > 4000) return { ok: false, error: "invalid goal" };
    const agent = getAgent();
    if (!agent) return { ok: false, error: "Noah agent is not available" };
    try {
      const taskId = agent.submit(goal.trim(), { source: "ui" });
      return { ok: true, taskId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }));

  // Text and voice both come through the command router (see agent/command-router.cjs)
  ipcMain.handle("noah:command", guard(async (text, source) => {
    if (typeof text !== "string" || !text.trim() || text.length > 4000) return { ok: false, error: "invalid command" };
    const router = getRouter();
    if (!router) return { ok: false, error: "Noah is not available" };
    try {
      return { ok: true, ...router.route(text.trim(), { source: source === "voice" ? "voice" : "text" }) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }));

  ipcMain.handle("noah:stop", guard(async () => (getAgent() ? getAgent().stop("user_button") : { ok: false })));
  ipcMain.handle("noah:pause", guard(async () => (getAgent() ? getAgent().pause() : { ok: false })));
  ipcMain.handle("noah:resume", guard(async () => (getAgent() ? getAgent().resume() : { ok: false })));
  ipcMain.handle("noah:confirm", guard(async (id, allow) => {
    if (typeof id !== "string") return false;
    return core.safety.resolveConfirmation(id, allow === true);
  }));

  ipcMain.handle("noah:get-config", guard(async () => config.publicView()));
  ipcMain.handle("noah:set-config", guard(async (patch) => {
    config.update(patch);
    return config.publicView();
  }));
  ipcMain.handle("noah:set-key", guard(async (provider, key) => ({ ok: config.setKey(String(provider), String(key)) })));
  ipcMain.handle("noah:get-theme", guard(async () => {
    const theme = resolveTheme(config.get().theme);
    return { theme, variables: cssVariables(theme) };
  }));
  ipcMain.handle("noah:list-tasks", guard(async () => (getAgent() ? getAgent().listTasks() : [])));
  ipcMain.handle("noah:resume-task", guard(async (taskId) => {
    const agent = getAgent();
    if (!agent || typeof taskId !== "string") return { ok: false };
    return { ok: true, taskId: await agent.resumeTask(taskId) };
  }));
  ipcMain.handle("noah:get-state", guard(async () => (getAgent() ? getAgent().state() : { status: "idle" })));
  ipcMain.handle("noah:get-audit", guard(async () => core.audit.tail(50)));

  // main -> renderer event stream
  const unsubscribe = core.bus.subscribe((evt) => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("noah:event", evt);
  });
  for (const ch of CHANNELS) slog("IPC_LISTENER_REGISTERED", { channel: ch });
  slog("IPC_LISTENER_REGISTERED", { channel: "noah:event (bus -> renderer)" });

  return function unregister() {
    unsubscribe();
    for (const ch of CHANNELS) {
      ipcMain.removeHandler(ch);
      slog("IPC_LISTENER_REMOVED", { channel: ch });
    }
    slog("IPC_LISTENER_REMOVED", { channel: "noah:event (bus -> renderer)" });
  };
}

module.exports = { registerNoahIpc, CHANNELS };
