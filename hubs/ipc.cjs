// hubs/ipc.cjs - the main-process side of the Game Hub / Creator Studio / Aesthetic Lab. Only the browser window's own page may call these (never a website, never
// an incognito window), and every argument is validated here, whatever the page sent.
"use strict";

const feeds = require("./feeds.cjs");
const system = require("./system.cjs");
const images = require("./images.cjs");

const FEEDS = new Set(["giveaways", "epic", "deals", "search", "cheapestFor"]);

function registerHubIpc({ ipcMain, getMainWindow, app, client = feeds.createClient(), monitor = system.createMonitor({ run: system.spawnRun, statfs: require("fs").statfsSync }), fetchImage = images.fetchImage }) {
  const fromBrowserWindow = (event) => { const w = getMainWindow(); return !!w && !w.isDestroyed() && event.sender === w.webContents; };

  ipcMain.handle("hub:feed", async (event, name, params) => {
    if (!fromBrowserWindow(event)) return { ok: false, error: "not allowed" };
    if (!FEEDS.has(name)) return { ok: false, error: "unknown feed" };
    try {
      const p = params && typeof params === "object" ? params : {};
      const data = name === "search" ? await client.search(String(p.title || "")) : name === "cheapestFor" ? await client.cheapestFor(Array.isArray(p.ids) ? p.ids : []) : await client[name](p);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err && err.status === 400 ? "The deals service refused the request (400)." : "Could not reach the service right now (" + String(err && err.message || err).slice(0, 80) + ")." };
    }
  });

  ipcMain.handle("hub:system", async (event) => {
    if (!fromBrowserWindow(event)) return { ok: false, error: "not allowed" };
    try {
      const snap = await monitor.read();
      // Jonah's own footprint: what the browser itself is using (so people can see it is not the thing slowing their game)
      let jonah = null;
      try {
        const m = app.getAppMetrics();
        jonah = { cpuPct: Math.round(m.reduce((s, p) => s + ((p.cpu && p.cpu.percentCPUUsage) || 0), 0) * 10) / 10, memMB: Math.round(m.reduce((s, p) => s + ((p.memory && (p.memory.workingSetSize || 0)) || 0), 0) / 1024), processes: m.length };
      } catch (_) { /* metrics unavailable */ }
      return { ok: true, data: { ...snap, jonah } };
    } catch (err) { return { ok: false, error: "Could not read the system (" + String(err && err.message || err).slice(0, 80) + ")." }; }
  });

  ipcMain.handle("hub:fetchImage", async (event, url) => {
    if (!fromBrowserWindow(event)) return { ok: false, why: "not allowed" };
    return fetchImage(String(url == null ? "" : url).slice(0, 2000));
  });
}

module.exports = { registerHubIpc, FEEDS };
