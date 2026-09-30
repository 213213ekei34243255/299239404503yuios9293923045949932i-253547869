// Preload for the login window only: three narrow calls, nothing else is exposed to the page.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jonahLicense", {
  init: () => ipcRenderer.invoke("license:init"),
  login: (username, password) => ipcRenderer.invoke("license:login", { username: String(username || ""), password: String(password || "") }),
  quit: () => ipcRenderer.send("license:quit"),
});
