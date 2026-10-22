// downloads/ipc.cjs - the Downloads page's connection to the download list. Only the browser window's own page may use it (never a website, never another window),
// and the actions are an allow-list: the page names a download by id, never by file path.
"use strict";

const ACTIONS = new Set(["pause", "resume", "cancel", "open", "show", "remove", "retry", "clear"]);

function registerDownloadsIpc({ ipcMain, getMainWindow, manager }) {
  const ok = (event) => { const w = getMainWindow(); return !!w && !w.isDestroyed() && event.sender === w.webContents; };
  ipcMain.handle("downloads:list", (event) => (ok(event) ? manager.list() : []));
  ipcMain.handle("downloads:act", async (event, id, action, opts) => {
    if (!ok(event)) return { ok: false, error: "not allowed" };
    if (!ACTIONS.has(String(action))) return { ok: false, error: "Unknown action." };
    try { return await manager.act(String(id), String(action), { confirmed: !!(opts && opts.confirmed === true) }); } catch (err) { return { ok: false, error: String(err && err.message || err).slice(0, 120) }; }
  });
  manager.on("changed", (list) => { const w = getMainWindow(); if (w && !w.isDestroyed()) w.webContents.send("downloads:changed", list); });
}

module.exports = { registerDownloadsIpc, ACTIONS };
