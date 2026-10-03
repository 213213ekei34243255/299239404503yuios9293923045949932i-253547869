// Noah/test/unit/updater.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("events");
const { createUpdater } = require("../../../updater.cjs");

function rig({ platform = "win32", packaged = true, installOnMac = false, answer = 0, checkImpl } = {}) {
  const autoUpdater = new EventEmitter();
  autoUpdater.checks = 0; autoUpdater.installed = 0;
  autoUpdater.checkForUpdates = async () => { autoUpdater.checks++; if (checkImpl) return checkImpl(); return {}; };
  autoUpdater.quitAndInstall = () => { autoUpdater.installed++; };
  const dialogs = [], opened = [], logs = [], timers = [];
  const dialog = { showMessageBox: async (a, b) => { dialogs.push(b || a); return { response: answer }; } };
  const shell = { openExternal: async (u) => { opened.push(u); } };
  const app = { isPackaged: packaged, getVersion: () => "1.4.2" };
  const u = createUpdater({ autoUpdater, dialog, shell, app, platform, owner: "own", repo: "rep", installOnMac, setIntervalFn: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, log: (...a) => logs.push(a.join(" ")) });
  return { u, autoUpdater, dialogs, opened, logs, timers };
}
const tick = () => new Promise((r) => setImmediate(r));

test("an unpackaged / development run never checks for updates", () => {
  const r = rig({ packaged: false });
  assert.equal(r.u.start(), false);
  assert.equal(r.autoUpdater.checks, 0);
  assert.equal(r.timers.length, 0);
});

test("Windows: downloads in the background, installs on quit, never offers pre-releases or downgrades", async () => {
  const r = rig({ platform: "win32" });
  assert.equal(r.u.start(), true);
  await tick();
  assert.equal(r.autoUpdater.autoDownload, true);
  assert.equal(r.autoUpdater.autoInstallOnAppQuit, true);
  assert.equal(r.autoUpdater.allowPrerelease, false);
  assert.equal(r.autoUpdater.allowDowngrade, false);
  assert.equal(r.autoUpdater.checks, 1, "checks once at start");
});

test("Windows: finding an update asks nothing (it is already downloading); once downloaded the user may restart now or later", async () => {
  const r = rig({ platform: "win32", answer: 0 });
  r.u.start();
  r.autoUpdater.emit("update-available", { version: "1.5.0" });
  await tick();
  assert.equal(r.dialogs.length, 0);
  r.autoUpdater.emit("update-downloaded", { version: "1.5.0" });
  await tick();
  assert.equal(r.dialogs.length, 1);
  assert.match(r.dialogs[0].message, /1\.5\.0 is ready/);
  assert.equal(r.autoUpdater.installed, 1, "'Restart now' installs");
});

test("Windows: choosing 'Later' does not restart (it installs on the next quit)", async () => {
  const r = rig({ platform: "win32", answer: 1 });
  r.u.start();
  r.autoUpdater.emit("update-downloaded", { version: "1.5.0" });
  await tick();
  assert.equal(r.autoUpdater.installed, 0);
});

test("macOS (unsigned): never downloads or installs - it only tells the user and opens the release page", async () => {
  const r = rig({ platform: "darwin", answer: 0 });
  r.u.start();
  assert.equal(r.autoUpdater.autoDownload, false);
  assert.equal(r.autoUpdater.autoInstallOnAppQuit, false);
  r.autoUpdater.emit("update-available", { version: "1.5.0" });
  await tick(); await tick();
  assert.equal(r.dialogs.length, 1);
  assert.match(r.dialogs[0].message, /Jonah 1\.5\.0 is available/);
  assert.deepEqual(r.opened, ["https://github.com/own/rep/releases/latest"]);
  assert.equal(r.autoUpdater.installed, 0);
});

test("macOS: 'Later' opens nothing", async () => {
  const r = rig({ platform: "darwin", answer: 1 });
  r.u.start();
  r.autoUpdater.emit("update-available", { version: "1.5.0" });
  await tick(); await tick();
  assert.deepEqual(r.opened, []);
});

test("macOS: the same version is only announced once per run, even across repeated checks", async () => {
  const r = rig({ platform: "darwin", answer: 1 });
  r.u.start();
  for (let i = 0; i < 3; i++) { r.autoUpdater.emit("update-available", { version: "1.5.0" }); await tick(); await tick(); }
  assert.equal(r.dialogs.length, 1);
  r.autoUpdater.emit("update-available", { version: "1.6.0" });
  await tick(); await tick();
  assert.equal(r.dialogs.length, 2, "a newer version is announced");
});

test("macOS with installOnMac switched on (once signed) behaves like Windows", () => {
  const r = rig({ platform: "darwin", installOnMac: true });
  r.u.start();
  assert.equal(r.autoUpdater.autoDownload, true);
  assert.equal(r.u.willAutoInstall, true);
});

test("a failed check (offline, rate limit, no release yet) is only logged - never thrown, never a dialog", async () => {
  const r = rig({ checkImpl: async () => { throw new Error("net::ERR_INTERNET_DISCONNECTED"); } });
  assert.equal(r.u.start(), true);
  await tick(); await tick();
  assert.equal(r.dialogs.length, 0);
  assert.ok(r.logs.some((l) => /update check failed.*DISCONNECTED/.test(l)));
  r.autoUpdater.emit("error", new Error("boom")); // the 'error' event must not crash the process either
  assert.ok(r.logs.some((l) => /updater error: boom/.test(l)));
});

test("checks again on a timer (every 6 hours), and overlapping checks do not pile up", async () => {
  let release;
  const r = rig({ checkImpl: () => new Promise((res) => { release = res; }) });
  r.u.start();
  assert.equal(r.timers.length, 1);
  assert.equal(r.timers[0].ms, 6 * 60 * 60 * 1000);
  assert.equal(await r.u.checkNow(), false, "a check is already running");
  assert.equal(r.autoUpdater.checks, 1);
  release({});
  await tick(); await tick();
  const second = r.u.checkNow(); // starts a fresh check now that the first has finished
  release({});
  assert.equal(await second, true);
  assert.equal(r.autoUpdater.checks, 2);
});

test("start() twice does not register listeners or timers twice", () => {
  const r = rig();
  assert.equal(r.u.start(), true);
  assert.equal(r.u.start(), false);
  assert.equal(r.autoUpdater.listenerCount("update-available"), 1);
  assert.equal(r.timers.length, 1);
});

test("the release page opened on macOS is built from the package.json publish settings, on github.com over https", () => {
  const { build } = require("../../../package.json");
  assert.equal(build.publish.provider, "github");
  assert.equal(build.publish.releaseType, "draft", "releases are created as drafts: nothing is public until published by hand");
  const u = createUpdater({ autoUpdater: new EventEmitter(), dialog: {}, shell: {}, app: { isPackaged: true, getVersion: () => "1" }, owner: build.publish.owner, repo: build.publish.repo });
  assert.match(u.releasesUrl, /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest$/);
});

test("package.json is version 1.4.2 and the Mac build also makes the zip electron-updater needs", () => {
  const p = require("../../../package.json");
  assert.equal(p.version, "1.4.2");
  assert.deepEqual(p.build.mac.target.map((t) => t.target).sort(), ["dmg", "zip"]);
  assert.deepEqual(p.build.win.target, ["nsis-web"], "Windows ships as a small web installer that downloads the full package from the release");
  assert.ok(p.dependencies["electron-updater"], "electron-updater is a runtime dependency (the packaged app needs it)");
});
