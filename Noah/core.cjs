// Noah/core.cjs
//
// Assembles the model-independent core of Noah: event bus, safety, tabs,
// browser controller, computer controller, verifier and action executor, plus
// the takeover monitor. The agent (models + planning loop) sits on top of this;
// the benchmark harness exercises this layer directly with no model at all.

"use strict";

const path = require("path");
const { EventBus } = require("./events.cjs");
const injection = require("./safety/injection.cjs");
const { AuditLog } = require("./safety/audit.cjs");
const { SafetyController } = require("./safety/safety-controller.cjs");
const { TakeoverMonitor } = require("./safety/takeover.cjs");
const { TabRegistry } = require("./browser/tabs.cjs");
const { BrowserController } = require("./browser/browser-controller.cjs");
const { ComputerController } = require("./computer/controller.cjs");
const { ActionVerifier } = require("./agent/verifier.cjs");
const { ActionExecutor } = require("./agent/action-executor.cjs");
const { AgentSession } = require("./agent/session.cjs");

/**
 * @param {object} o
 * @param {import('electron').BrowserWindow} o.mainWindow
 * @param {{ webContents: any, screen: any }} o.electron
 * @param {import('./config.cjs').ConfigStore} o.config
 * @param {string} o.dataDir           where audit logs / tasks live (userData/noah)
 */
function createCore({ mainWindow, electron, config, dataDir, log = () => {} }) {
  const getConfig = () => config.get();
  const bus = new EventBus();
  const session = new AgentSession({ bus });
  const audit = new AuditLog({ dir: path.join(dataDir, "audit"), enabled: getConfig().auditEnabled !== false });

  const tabs = new TabRegistry({ mainWindow, webContents: electron.webContents, log });

  let browser; // forward reference for getCookieValues
  const safety = new SafetyController({
    bus,
    getPolicy: () => getConfig().policy,
    audit,
    getCookieValues: async () => {
      const active = await tabs.active();
      const wc = active && tabs.guest(active.id);
      if (!wc) return [];
      const cookies = await wc.session.cookies.get({});
      return cookies.map((c) => c.value).filter((v) => v && v.length >= 16);
    },
  });

  browser = new BrowserController({ tabs, mainWindow, bus, safety, getConfig, scanner: injection, screen: electron.screen, log });

  const computer = new ComputerController({
    getDriver: () => {
      const ctx = browser.currentSync();
      if (!ctx) throw new Error("no active browser context");
      return ctx.driver;
    },
    getGeometry: () => browser.frame?.geometry || null,
    getViewport: () => browser.currentSync()?.observer.last?.viewport || null,
    getZoom: () => {
      const wc = browser.currentSync()?.cdp.wc;
      return wc && !wc.isDestroyed() && wc.getZoomFactor ? wc.getZoomFactor() : 1;
    },
    bus,
    getConfig,
    capture: (opts) => browser.observe({ screenshot: true, ...opts }).then((o) => o.screenshot),
  });

  const verifier = new ActionVerifier({ browser });
  const executor = new ActionExecutor({ browser, computer, safety, verifier, bus, getConfig, log });

  const monitor = new TakeoverMonitor({
    safety,
    tabs,
    mainWindow,
    screen: electron.screen,
    getConfig,
    isSynthetic: () => {
      const ctx = browser.currentSync();
      return !!ctx && ctx.driver.isDispatching();
    },
    log,
  });
  monitor.watch(mainWindow.webContents, { isGuest: false });
  browser.on("guest_attached", (wc) => monitor.watch(wc, { isGuest: true }));
  // ---- the session's picture of the page in front of the user: updated by browser events, never reset by them
  tabs.on("active_changed", ({ to }) => session.updateBrowser({ tabId: to }, "tab_switch"));
  const followed = new WeakSet(); // guest_attached fires on every (re)attach: listen to each guest exactly once
  browser.on("guest_attached", (wc) => {
    if (followed.has(wc)) return;
    followed.add(wc);
    const tabId = `t${wc.id}`;
    const isActive = () => session.browser.tabId === tabId || !session.browser.tabId;
    const push = (partial, why) => { if (!wc.isDestroyed() && isActive()) session.updateBrowser({ tabId, ...partial }, why); };
    wc.on("did-start-navigation", (_e, url, _inPlace, isMainFrame) => { if (isMainFrame) push({ url, pageReady: false }, "navigation_start"); });
    wc.on("did-navigate", (_e, url) => push({ url, pageReady: false }, "navigation"));
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => { if (isMainFrame) push({ url }, "navigation_in_page"); });
    wc.on("page-title-updated", (_e, title) => push({ title }, "title"));
    wc.on("did-stop-loading", () => push({ url: wc.getURL(), title: wc.getTitle(), pageReady: true }, "navigation_complete"));
    wc.once("destroyed", () => { if (session.browser.tabId === tabId) session.updateBrowser({ tabId: null, pageReady: false }, "tab_closed"); });
  });
  browser.on("synthetic_start", (kind) => monitor.markSyntheticStart(kind));
  browser.on("synthetic_end", (kind) => monitor.markSyntheticEnd(kind));

  // Real clicks / scrolls in the page are reported by the guest preload (webview-preload.js). Only guests embedded in
  // THIS window are believed, and a page can only ever use this channel to pause the agent (the safe direction).
  let ipcMain = null;
  try {
    ({ ipcMain } = require("electron"));
  } catch (_) {
    /* not running inside Electron (unit tests) */
  }
  const onPageInput = (event, msg) => {
    const wc = event && event.sender;
    if (!wc || wc.hostWebContents !== mainWindow.webContents) return;
    monitor.pageInput(msg);
  };
  if (ipcMain) ipcMain.on("noah:page-input", onPageInput);

  function dispose() {
    session.destroy();
    if (ipcMain) ipcMain.removeListener("noah:page-input", onPageInput);
    monitor.dispose();
  }

  return { bus, session, audit, safety, tabs, browser, computer, verifier, executor, monitor, config, dispose };
}

module.exports = { createCore };
