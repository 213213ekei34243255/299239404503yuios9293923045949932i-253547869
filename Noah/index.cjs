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

function createNoah({ mainWindow, ipcMain, electron, dataDir, appRoot, log = () => {} }) {
  const config = new ConfigStore({ dir: dataDir, appRoot, env: process.env, safeStorage: electron.safeStorage });
  const core = createCore({ mainWindow, electron, config, dataDir, log });
  const router = new ModelRouter({ config, bus: core.bus, log });
  const agent = new NoahAgent({ core, router, config, dataDir, log });
  // THE door for instructions: voice, typed chat and UI all reach the one session through this router
  const commandRouter = new CommandRouter({ session: core.session, agent, log });
  const unregisterIpc = registerNoahIpc({ ipcMain, mainWindow, core, getAgent: () => agent, getRouter: () => commandRouter, config });

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
      default:
        break;
    }
  });

  const bridge = {
    isAvailable: () => agent.isAvailable(),
    submit: (goal, opts) => agent.submit(goal, opts),
    route: (text, opts) => commandRouter.route(text, opts),
    cancel: () => agent.stop("legacy_cancel"),
    session: () => core.session.snapshot(),
  };

  function dispose() {
    try {
      core.safety.stop("shutdown");
    } catch (_) {
      /* ignore */
    }
    off();
    unregisterIpc();
    core.dispose();
  }

  return { config, core, router, agent, commandRouter, bridge, lifecycle, dispose, dataDir: path.resolve(dataDir) };
}

module.exports = { createNoah };
