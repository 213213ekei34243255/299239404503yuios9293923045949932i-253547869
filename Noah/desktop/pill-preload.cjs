// Noah/desktop/pill-preload.cjs - the only two things the Stop bar's page can do: say "stop", and hear what Noah is doing now.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("noahPill", {
  stop: () => ipcRenderer.send("noah:pill-stop"),
  onText: (cb) => ipcRenderer.on("noah:pill-text", (_e, t) => cb(String(t))),
});
