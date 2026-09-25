// Noah/bench/harness/harness.cjs
//
// Electron entry point for the deterministic (no-model) test/benchmark tiers.
// It boots the fixture site, a Jonah-compatible shell window (real preload, real
// overlay, real noah-renderer bridge) and the REAL Noah core (CDP, observer,
// input driver, safety, executor), then runs scenario modules against them and
// writes measured results. Nothing here is mocked below the model boundary:
// every click is a real CDP mouse event in a real <webview> guest.
//
//   electron Noah/bench/harness/harness.cjs [--filter=text] [--zoom=1.5] [--out=file.json] [--keep-open]
//   env: NOAH_DPR=2 forces a device scale factor of 2 (Chromium switch)

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("=");
  return [k, v === undefined ? true : v];
}));

const { app, BrowserWindow, webContents, screen, ipcMain, nativeImage } = require("electron");
if (process.env.NOAH_DPR) app.commandLine.appendSwitch("force-device-scale-factor", process.env.NOAH_DPR);
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.disableHardwareAcceleration();

const { createServer } = require("../fixtures.cjs");
const { ConfigStore } = require("../../config.cjs");
const { createCore } = require("../../core.cjs");
const { registerNoahIpc } = require("../../ipc.cjs");
const { validateAction } = require("../../protocol/actions.cjs");
const { CdpSession } = require("../../browser/cdp.cjs");
const { estimateTokens } = require("../../perception/ax.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- instrumentation: count CDP calls (a proxy for latency/CPU cost)
const cdpStats = { calls: 0, byMethod: {} };
const origSend = CdpSession.prototype.send;
CdpSession.prototype.send = function (method, ...rest) {
  cdpStats.calls++;
  cdpStats.byMethod[method] = (cdpStats.byMethod[method] || 0) + 1;
  return origSend.call(this, method, ...rest);
};

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "noah-bench-"));
  const server = await createServer();
  const win = new BrowserWindow({
    width: 1200, height: 860, x: 30, y: 30, show: true, backgroundColor: "#111",
    webPreferences: { preload: path.join(ROOT, "preload.cjs"), contextIsolation: true, nodeIntegration: false, webviewTag: true, backgroundThrottling: false, sandbox: false },
  });
  const config = new ConfigStore({ dir: path.join(tmp, "noah"), appRoot: null, env: {} });
  config.get().policy.allowLocalhost = true; // fixtures live on loopback
  config.get().policy.confirmTimeoutMs = 4000;
  config.get().takeover.enabled = true;
  // the real app's <webview preload="./webview-preload.js"> reports the user's clicks/scrolls; give the harness guest the same one
  win.webContents.on("will-attach-webview", (_e, webPreferences) => { webPreferences.preload = path.join(ROOT, "webview-preload.js"); });
  const core = createCore({ mainWindow: win, electron: { webContents, screen }, config, dataDir: path.join(tmp, "noah"), log: (...a) => args.verbose && console.log("[noah]", ...a) });
  // IPC handlers must exist BEFORE the shell page loads (its bridge asks for theme/config on startup)
  registerNoahIpc({ ipcMain, mainWindow: win, core, getAgent: () => null, config });
  await win.loadFile(path.join(__dirname, "shell.html"));
  await sleep(600);

  // downloads go to a temp dir
  const dlDir = path.join(tmp, "downloads");
  fs.mkdirSync(dlDir, { recursive: true });
  const ses = require("electron").session.fromPartition("persist:harness");
  ses.on("will-download", (_e, item) => item.setSavePath(path.join(dlDir, item.getFilename())));
  core.browser.watchSession(ses);

  // ---- auto-confirm responder for tests
  const ctx = { autoConfirm: "deny", confirmations: [], events: [], keepEvents: false };
  core.bus.subscribe((evt) => {
    if (ctx.keepEvents) ctx.events.push(evt);
    if (evt.event === "confirm_request") {
      ctx.confirmations.push(evt);
      setTimeout(() => core.safety.resolveConfirmation(evt.id, ctx.autoConfirm === "allow"), 30);
    }
  });

  Object.assign(ctx, {
    root: ROOT, tmp, dlDir, server, win, core, config, nativeImage, args, sleep, cdpStats,
    // executes one protocol action through the real executor
    async act(raw) {
      const v = validateAction(raw);
      if (!v.ok) throw new Error(`invalid action in scenario: ${v.error}`);
      return core.executor.execute(v.action);
    },
    async open(p) {
      const r = await ctx.act({ action: "navigate", url: p.startsWith("http") ? p : server.url(p) });
      if (!r.ok) throw new Error(`open ${p} failed: ${r.message}`);
      // Chromium keeps page zoom per origin, so apply it AFTER navigating (resetting on about:blank does not stick)
      if (args.zoom) {
        const wc = await ctx.guest();
        const before = await wc.executeJavaScript("window.devicePixelRatio").catch(() => 1);
        const already = wc.getZoomFactor();
        wc.setZoomFactor(Number(args.zoom));
        // the renderer applies the zoom asynchronously: measuring geometry before the page reports the new
        // devicePixelRatio mixes an old viewport with the new zoom (a full run under load hit this once)
        const want = (before / already) * Number(args.zoom);
        for (let i = 0; i < 40; i++) {
          const dpr = await wc.executeJavaScript("window.devicePixelRatio").catch(() => 0);
          if (Math.abs(dpr - want) < 0.02) break;
          await sleep(50);
        }
        await sleep(100);
      }
      core.browser.frame = null;
      return r;
    },
    observe: (o = {}) => core.browser.observe(o),
    // Test ORACLE only: read state from the page main world (the agent never does this)
    async page(js) {
      const t = (await core.tabs.list(0)).find((x) => x.id === core.browser.targetTabId);
      const wc = core.tabs.guest(t.id);
      return wc.executeJavaScript(js, true);
    },
    async guest() {
      const t = (await core.tabs.list(0)).find((x) => x.id === core.browser.targetTabId);
      return core.tabs.guest(t.id);
    },
    // convert a CSS-viewport point to the coordinates a vision model would emit from the latest screenshot
    toShot(x, y) {
      const g = core.browser.frame?.geometry;
      if (!g) throw new Error("no frame: take a screenshot first");
      return g.viewportToModel(x, y);
    },
    async shellShot() {
      const img = await win.webContents.capturePage();
      return img;
    },
    est: estimateTokens,
    /**
     * Run a REAL NoahAgent task with a scripted reference policy standing in for the model (NOT an LLM).
     * @param {string} goal
     * @param {(c:{request:any, meta:any, step:number}) => object} policy  returns a Noah envelope (or a plan when meta.kind==='plan')
     * @param {{ models?: object, sensitive?: boolean, timeoutMs?: number, onStep?: Function, providers?: object, roles?: object, routing?: object }} [opts]
     */
    async runTask(goal, policy, opts = {}) {
      const { ScriptedProvider } = require("../../models/scripted.cjs");
      const { ModelRouter } = require("../../models/router.cjs");
      const { NoahAgent } = require("../../agent/noah-agent.cjs");
      const scripted = new ScriptedProvider(policy, { latencyMs: opts.latencyMs || 0 });
      const m = opts.models || {};
      const cand = (model) => [{ provider: "scripted", model: model || "scripted-policy", trusted: true }];
      config.get().roles = { planner: cand(m.planner), browser: cand(m.browser), vision: cand(m.vision || m.browser), fast: cand(m.fast), local: [] };
      Object.assign(config.get().routing, opts.routing || {});
      const router = new ModelRouter({ config, bus: core.bus, providers: { scripted, ...(opts.providers || {}) } });
      if (opts.roles) config.get().roles = { ...config.get().roles, ...opts.roles };
      const agent = new NoahAgent({ core, router, config, dataDir: path.join(tmp, "noah-agent-" + Date.now()) });
      const events = [];
      const unsub = core.bus.subscribe((e) => {
        if (e.event !== "mouse_action" && e.event !== "keyboard_action") events.push(e);
        if (args.trace && !["mouse_action", "keyboard_action", "cursor_state"].includes(e.event)) {
          const { event, seq, ts, taskId, ...rest } = e;
          console.log("  EV +" + (Date.now() % 100000) + " " + event + " " + JSON.stringify(rest).slice(0, 230));
        }
      });
      // Scripted-agent runs must not be paused by stray physical mouse/keyboard input on the machine running the
      // benchmark (takeover is a designed behaviour with its own tests: X5/X6).
      const takeoverWas = config.get().takeover.enabled;
      config.get().takeover.enabled = false;
      const done = new Promise((resolve) => agent.once("finished", resolve));
      const taskId = agent.submit(goal);
      const timer = setTimeout(() => {
        console.log("  !! HARNESS TIMEOUT. paused=" + core.safety.paused + " last events: " + events.slice(-6).map((e) => e.event + (e.level ? ":" + e.level : "") + (e.reason ? "(" + e.reason + ")" : "")).join(" > "));
        core.safety.stop("harness-timeout");
      }, opts.timeoutMs || 60000);
      if (opts.during) opts.during({ agent, core, events, scripted });
      const { task, metrics } = await done;
      clearTimeout(timer);
      config.get().takeover.enabled = takeoverWas;
      unsub();
      agent.dispose();
      return { task, metrics, events, scripted, agent, taskId };
    },
    newTask(id = "bench") {
      core.safety.beginTask(id);
      core.bus.setTask(id);
    },
    endTask() {
      core.safety.endTask();
    },
  });

  const scenarioFiles = (["tierA.cjs", "tierA_hard.cjs", "tierA_safety.cjs", "tierB.cjs"]).map((f) => path.join(__dirname, "..", "scenarios", f)).filter((f) => fs.existsSync(f));
  const all = [];
  for (const f of scenarioFiles) all.push(...require(f));
  const filter = typeof args.filter === "string" ? args.filter.toLowerCase() : null;
  const selected = all.filter((s) => !filter || `${s.id} ${s.category} ${s.name}`.toLowerCase().includes(filter));

  const results = [];
  console.log(`\nNoah harness: ${selected.length} scenarios (DPR=${process.env.NOAH_DPR || "system"}, zoom=${args.zoom || 1}, electron ${process.versions.electron}, chromium ${process.versions.chrome})\n`);
  for (const s of selected) {
    const t0 = Date.now();
    const calls0 = cdpStats.calls;
    ctx.confirmations.length = 0;
    ctx.autoConfirm = "deny";
    ctx.metrics = { actions: 0 };
    core.bus.setTask(null);
    let rec;
    try {
      // fresh state per scenario
      await resetBrowser(ctx);
      if (s.tier === "B") ctx.endTask(); else ctx.newTask(s.id);
      const out = await s.run(ctx);
      rec = { pass: !!out.pass, details: out.details || "", metrics: out.metrics || {} };
    } catch (err) {
      rec = { pass: false, details: `EXCEPTION: ${err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err.message}`, metrics: {} };
    } finally {
      try { ctx.endTask(); await core.browser.releaseAll(); } catch (_) { /* ignore */ }
    }
    rec = { id: s.id, tier: s.tier || "A", category: s.category, name: s.name, ...rec, durationMs: Date.now() - t0, cdpCalls: cdpStats.calls - calls0 };
    results.push(rec);
    console.log(`${rec.pass ? "PASS" : "FAIL"}  [${s.category}] ${s.id} ${s.name}  (${rec.durationMs}ms, ${rec.cdpCalls} cdp)${rec.pass ? "" : "\n      -> " + rec.details}`);
  }

  const summary = summarize(results);
  console.log("\n" + JSON.stringify(summary, null, 2));
  const outFile = typeof args.out === "string" ? args.out : path.join(ROOT, "Noah", "bench", "results", `tierA-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ meta: { when: new Date().toISOString(), electron: process.versions.electron, chromium: process.versions.chrome, dpr: process.env.NOAH_DPR || "system", zoom: args.zoom || 1, platform: process.platform, tier: "A (deterministic, no LLM) + B (real agent loop with a scripted reference policy, NOT an LLM)" }, summary, results, cdpMethods: cdpStats.byMethod }, null, 2));
  console.log(`\nresults -> ${outFile}`);
  if (!args["keep-open"]) {
    await server.close();
    app.exit(summary.failed ? 1 : 0);
  }
}

/** Reset to a single blank tab in the default partition between scenarios. */
async function resetBrowser(ctx) {
  const { core, win } = ctx;
  core.safety.stop("reset");
  await core.browser.releaseAll();
  core.safety.beginTask("reset");
  // close extra tabs
  for (let i = 0; i < 8; i++) {
    const tabs = await core.tabs.list(0);
    if (tabs.length <= 1) break;
    await win.webContents.executeJavaScript(`window.NoahRenderer.closeTab(${tabs.length - 1})`);
    await sleep(80);
  }
  await core.tabs.refresh();
  const first = (await core.tabs.list(0))[0];
  if (first && !first.active) await win.webContents.executeJavaScript("window.NoahRenderer.switchTab(0)");
  core.browser.targetTabId = null;
  core.browser.frame = null;
  const t = await core.tabs.active();
  const wc = core.tabs.guest(t.id);
  wc.setZoomFactor(1);
  core.safety.endTask();
  await wc.loadURL("about:blank").catch(() => {});
  await core.browser.releaseAll();
  // no state may leak between scenarios (cookies from a login test, isolated-partition data, downloads)
  const { session } = require("electron");
  for (const part of ["persist:harness", "noah-isolated"]) await session.fromPartition(part).clearStorageData().catch(() => {});
  await sleep(50);
}

function summarize(results) {
  const byCat = {};
  for (const r of results) {
    byCat[r.category] ||= { total: 0, passed: 0 };
    byCat[r.category].total++;
    if (r.pass) byCat[r.category].passed++;
  }
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const dur = results.map((r) => r.durationMs);
  return {
    total, passed, failed: total - passed, successRate: total ? Math.round((passed / total) * 1000) / 10 : 0,
    avgScenarioMs: total ? Math.round(dur.reduce((a, b) => a + b, 0) / total) : 0,
    totalCdpCalls: results.reduce((a, r) => a + r.cdpCalls, 0),
    byCategory: byCat,
    failedIds: results.filter((r) => !r.pass).map((r) => r.id),
  };
}

app.whenReady().then(main).catch((err) => {
  console.error("HARNESS ERROR", err);
  app.exit(2);
});
