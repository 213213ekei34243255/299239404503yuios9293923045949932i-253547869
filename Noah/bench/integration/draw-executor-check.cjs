// Noah/bench/integration/draw-executor-check.cjs
//
// draw-scene-check.cjs proved a drag can paint real pixels on toy-paint.html, but it executed actions with its
// own hand-rolled click/drag function - never through the REAL Noah/agent/action-executor.cjs +
// Noah/agent/verifier.cjs that decide, in the live app, whether a drag actually "worked". That gap hid a real
// bug: a canvas draw changes no DOM/text/URL/focus signal, so verifier.cjs's success check fell through entirely
// to a screenshot-hash diff - which can silently come back empty on an occluded/backgrounded render surface,
// making every drag report "no effect" even though the pixels were really painted (reported live: "I could not
// draw the sky/hills - the last attempt to drag it on the canvas did not seem to work").
//
// This test closes that gap without needing the full multi-tab shell (see draw-real-app-check.cjs for that,
// heavier, version): it builds the REAL BrowserController + ComputerController + ActionVerifier + ActionExecutor
// + SafetyController from Noah/core.cjs's own classes, wired to ONE bare BrowserWindow through a minimal
// single-tab stand-in for TabRegistry (the only piece not worth booting the whole shell for). Every action -
// click the colour, click the tool, drag the shape - runs through ActionExecutor.execute() exactly as
// agent/noah-agent.cjs calls it, so this proves the actual decision logic that was broken, not a stand-in for it.
//
// It also proves the toy-paint.html fix directly: with the DOM stroke-count signal in place, verifier.cjs sees
// a text_changed signal, wholly independent of whether screenshot capture works at all - proven here by forcing
// the visual screenshot hash to fail (see FORCE_SCREENSHOT_FAILURE) and confirming the drag STILL succeeds.
//
//   npx electron Noah/bench/integration/draw-executor-check.cjs

"use strict";

const path = require("path");
const assert = require("node:assert/strict");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const { EventBus } = require(path.join(ROOT, "Noah", "events.cjs"));
const { SafetyController } = require(path.join(ROOT, "Noah", "safety", "safety-controller.cjs"));
const { BrowserController } = require(path.join(ROOT, "Noah", "browser", "browser-controller.cjs"));
const { ComputerController } = require(path.join(ROOT, "Noah", "computer", "controller.cjs"));
const { ActionVerifier } = require(path.join(ROOT, "Noah", "agent", "verifier.cjs"));
const { ActionExecutor } = require(path.join(ROOT, "Noah", "agent", "action-executor.cjs"));
const { checkNavigation } = require(path.join(ROOT, "Noah", "safety", "url-guard.cjs"));
const { DRAWING_TOOL_URL } = require(path.join(ROOT, "Noah", "models", "draw-goal.cjs"));
const { validateAction } = require(path.join(ROOT, "Noah", "protocol", "actions.cjs"));

app.on("window-all-closed", () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

/** A single-tab stand-in for browser/tabs.cjs's TabRegistry - the only piece not worth booting the whole
 * multi-tab shell (window.NoahRenderer.tabs()) for. Everything downstream of this (resolveTarget, the
 * verifier, the executor, the real InputDriver) is the genuine production class. */
function oneTabRegistry(win) {
  const tab = { id: "t1", wcId: win.webContents.id, index: 0, title: "", url: "", active: true, ownedByNoah: false };
  return {
    list: async () => [{ ...tab, url: win.webContents.getURL(), title: win.webContents.getTitle() }],
    guest: (id) => (id === tab.id ? win.webContents : null),
    get: (id) => (id === tab.id ? tab : null),
    switchTo: async () => {},
    active: async () => tab,
    find: () => [],
    findClosed: () => [],
  };
}

async function main() {
  const win = new BrowserWindow({ show: true, width: 1100, height: 800, webPreferences: { sandbox: true, partition: "draw-executor-check" } });
  await win.loadURL("about:blank");

  const bus = new EventBus();

  const safety = new SafetyController({ bus, getPolicy: () => ({ mode: "autonomous", allowLocalhost: true }) });
  const getConfig = () => ({ policy: { mode: "autonomous" } });
  const browser = new BrowserController({ tabs: oneTabRegistry(win), mainWindow: win, bus, safety, getConfig, scanner: null, screen: null, log: () => {} });

  const computer = new ComputerController({
    getDriver: () => browser.currentSync().driver,
    getGeometry: () => browser.frame?.geometry || null,
    getViewport: () => browser.currentSync()?.observer.last?.viewport || null,
    getZoom: () => 1,
    bus,
    getConfig,
    capture: (opts) => browser.observe({ screenshot: true, ...opts }).then((o) => o.screenshot),
  });
  const verifier = new ActionVerifier({ browser });
  const executor = new ActionExecutor({ browser, computer, safety, verifier, bus, getConfig, log: () => {} });

  // ---- 1) sanity: navigate to the real drawing tool through the real safety gate + real executor
  const navCheck = checkNavigation(DRAWING_TOOL_URL);
  assert.ok(navCheck.allowed, "the drawing tool URL must be allowed by the real safety gate");
  const navResult = await executor.execute({ action: "navigate", url: navCheck.url });
  check("real ActionExecutor.execute(navigate) opened the drawing tool", navResult.ok, navResult.message);
  await sleep(200);

  // ---- 2) force EVERY screenshot capture to fail, simulating the occluded/backgrounded-window failure mode
  //         this bug actually hit in the live app ("Current display surface not available for capture").
  //         If the fix works, a completed drag must still be verified successful WITHOUT any screenshot at all.
  const screenshotModule = require(path.join(ROOT, "Noah", "perception", "screenshot.cjs"));
  const realCaptureFrame = screenshotModule.captureFrame;
  screenshotModule.captureFrame = async () => { throw new Error("simulated: display surface not available for capture"); };

  // Exactly what agent/noah-agent.cjs does: raw model-shaped actions go through validateAction()/normalizeTarget()
  // before ever reaching the executor. Skipping that step (as an earlier draft of this test did) exercises a
  // target shape the executor never actually sees in production.
  function toValidatedAction(raw) {
    const v = validateAction(raw);
    assert.ok(v.ok, `action must validate: ${v.error}`);
    return v.action;
  }
  async function click(target) {
    return executor.execute(toValidatedAction({ action: "click", target }));
  }
  async function drag(from, to) {
    return executor.execute(toValidatedAction({ action: "drag", from: { space: "viewport", ...from }, to: { space: "viewport", ...to }, expect: { no_effect_ok: false } }));
  }

  // Read the canvas rect through the real observer, exactly as draw-script.cjs does.
  const obs = await browser.observe({});
  const canvasEl = obs.elements.find((e) => e.role === "canvas");
  check("the real Observer found the named drawing canvas (NAMED_CANVAS_SCAN)", !!canvasEl, canvasEl ? JSON.stringify(canvasEl.rect) : "not found");
  const rect = canvasEl.rect;
  const from = { x: rect.x + rect.width * 0.1, y: rect.y + rect.height * 0.1 };
  const to = { x: rect.x + rect.width * 0.4, y: rect.y + rect.height * 0.4 };

  const colorClick = await click({ text: "color blue" });
  check("real click on 'color blue' succeeded via ActionExecutor + ActionVerifier", colorClick.ok, colorClick.message);
  const toolClick = await click({ text: "Rectangle" });
  check("real click on 'Rectangle' tool succeeded via ActionExecutor + ActionVerifier", toolClick.ok, toolClick.message);
  const dragResult = await drag(from, to);
  check(
    "real drag succeeded via ActionExecutor + ActionVerifier EVEN WITH SCREENSHOT CAPTURE FORCED TO FAIL (proves the fix does not depend on visual diffing)",
    dragResult.ok,
    dragResult.message
  );
  check("the drag's own verification signals include text_changed (the DOM fix), not visual_changed (which was forced to fail)", (dragResult.verification?.signals || []).includes("text_changed") && !(dragResult.verification?.signals || []).includes("visual_changed"), JSON.stringify(dragResult.verification?.signals));

  screenshotModule.captureFrame = realCaptureFrame;

  // ---- 3) read the actual pixels back, and the status line, from the real guest WebContents
  const pixels = await win.webContents.executeJavaScript(`(() => {
    const c = document.querySelector('canvas.main-canvas');
    const ctx = c.getContext('2d');
    const at = (fx, fy) => Array.from(ctx.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data);
    return { spot: at(0.25, 0.25), status: document.getElementById('status').textContent };
  })()`);
  const isBlue = pixels.spot[2] > 180 && pixels.spot[0] < 60 && pixels.spot[1] < 60;
  check("the rectangle really is blue on the real canvas", isBlue, JSON.stringify(pixels.spot));
  check("toy-paint.html's own status line announced the completed stroke", /stroke \d/.test(pixels.status || ""), pixels.status);

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} checks passed`);
  win.destroy();
  app.exit(checks.every((c) => c.ok) ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error("CHECK FAILED:", err && err.stack);
    app.exit(1);
  })
);
