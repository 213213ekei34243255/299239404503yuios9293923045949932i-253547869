// Noah/bench/integration/draw-real-app-check.cjs
//
// The gap draw-scene-check.cjs left: THAT test executes actions with a hand-rolled click/drag function, never
// going through the real Noah/agent/action-executor.cjs + Noah/agent/verifier.cjs. It proved the concept (a drag
// really does paint pixels) but said nothing about whether the REAL app would consider that drag successful - and
// it turns out it didn't: a canvas draw changes no DOM/text/URL/focus signal at all, so verifier.cjs's success
// check fell through entirely to a screenshot-hash diff, which can silently come back empty (occluded/backgrounded
// window - the exact "Current display surface not available for capture" failure hit elsewhere in this project),
// making every drag report "no effect" in the live app even though draw-scene-check.cjs's own bypassed pixel
// readback showed it worked.
//
// This test closes that gap: it boots the REAL Jonah app (real main.cjs, index.html, renderer.js, the real
// <webview> tab, the real ActionExecutor/ActionVerifier/BrowserController), submits the exact reported prompt
// through the same window.rexy.goal(...) entry point the voice orb / AI panel use, and reads the finished
// scene's pixels back from the REAL guest WebContents - not a bypass.
//
//   electron --user-data-dir=<tmp> Noah/bench/integration/draw-real-app-check.cjs
//
// Requires ports 5588/5589 free (skips itself otherwise, like run-app.cjs).

"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULTS = path.join(ROOT, "Noah", "bench", "results");
if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(require("os").tmpdir(), "noah-draw-it-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[draw-real-app]", ...a);
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

// A model endpoint the draw goal must NEVER call (isDrawTask short-circuits rexy-legacy.cjs before any network
// call). Kept only so the app boots exactly like the known-working run-app.cjs harness; `seen` proves it unused.
function startTripwireModel(seen) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push(req.url);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "the draw goal must never reach the network" }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  if (!(await portFree(5588)) || !(await portFree(5589))) {
    console.log("SKIP: ports 5588/5589 (Jonah's own local servers) are in use; close any running Jonah and retry.");
    return app.exit(0);
  }
  const seen = [];
  const tripwire = await startTripwireModel(seen);

  const cfgDir = path.join(app.getPath("userData"), "browser-data", "noah");
  fs.mkdirSync(cfgDir, { recursive: true });
  const cand = (m) => [{ provider: "local", model: m, trusted: true }];
  fs.writeFileSync(
    path.join(cfgDir, "noah-config.json"),
    JSON.stringify({ takeover: { enabled: false }, policy: { mode: "autonomous", allowLocalhost: true }, roles: { planner: cand("fake-planner"), browser: cand("fake-vl"), vision: cand("fake-vl"), fast: cand("fake-vl"), local: cand("fake-vl") } })
  );
  process.env.NOAH_LOCAL_BASE_URL = `http://127.0.0.1:${tripwire.port}/v1`;

  log("starting the real Jonah app (main.cjs) with an isolated profile at", app.getPath("userData"));
  app.getAppPath = () => ROOT;
  require(path.join(ROOT, "main.cjs"));

  let win = null;
  for (let i = 0; i < 120 && !win; i++) {
    await sleep(500);
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html"));
  }
  if (!win) { check("Jonah shell window opened", false); return finish(tripwire, seen); }
  check("Jonah shell window opened (real main.cjs + index.html)", true);
  win.webContents.closeDevTools();
  const ev = (js, ms = 15000) => Promise.race([win.webContents.executeJavaScript(js, true), new Promise((_, rej) => setTimeout(() => rej(new Error("renderer call timed out: " + String(js).slice(0, 60))), ms))]);

  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(500);
    ready = await ev("!!(window.noah && window.NoahRenderer && window.rexy)").catch(() => false);
  }
  check("preload exposes window.noah / window.rexy in the real shell", ready);
  if (!ready) return finish(tripwire, seen);

  await ev(`(() => { window.__ev = []; window.noah.onEvent((e) => { e.__t = Date.now(); window.__ev.push(e); }); })()`);
  let agentAvailable = false;
  for (let i = 0; i < 20 && !agentAvailable; i++) { await sleep(500); agentAvailable = (await ev("window.noah.getState()")).status === "idle"; }
  await sleep(1000);

  const goal = "draw a rocket colour and also the surroundings with blue skies and great green hills and a sun";
  log("submitting through window.rexy.goal(...) (the same entry point the voice orb / AI panel use):", goal);
  const submit = await ev(`window.rexy.goal(${JSON.stringify(goal)})`);
  check("legacy rexy.goal() accepted the draw goal", submit && submit.success);

  let finished = null;
  for (let i = 0; i < 400 && !finished; i++) {
    await sleep(150);
    finished = await ev("window.__ev.find((e) => e.event === 'task_finished') || null").catch(() => null);
  }
  if (!finished) {
    const tail = await ev("window.__ev.slice(-14).map((e) => e.event + (e.status ? ' ' + e.status : '') + (e.summary ? ' - ' + e.summary : ''))").catch(() => []);
    log("TASK DID NOT FINISH - last events:\n    " + tail.join("\n    "));
  }
  check("Noah drew the scene end-to-end through the REAL executor/verifier and the task completed", finished && finished.status === "completed", finished ? `${finished.status}: ${finished.result || finished.error}` : "timed out");
  check("the draw goal never touched the network model (fully deterministic, as designed)", seen.length === 0, `${seen.length} unexpected call(s): ${seen.join(", ")}`);

  // ---- read the finished canvas back from the REAL guest <webview> WebContents (not a bypass window)
  const guest = require("electron").webContents.getAllWebContents().find((c) => !c.isDestroyed() && c.getType() === "webview" && /toy-paint\.html/i.test(c.getURL()));
  check("the active tab is really the drawing tool (toy-paint.html) in a real <webview>", !!guest, guest ? guest.getURL() : "(no matching webview found)");
  if (guest) {
    const pixels = await guest.executeJavaScript(`(() => {
      const c = document.querySelector('canvas.main-canvas');
      const ctx = c.getContext('2d');
      const at = (fx, fy) => Array.from(ctx.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data);
      return { sky: at(0.5, 0.15), hills: at(0.5, 0.9), sun: at(0.82, 0.16), rocket: at(0.5, 0.5), status: document.getElementById('status').textContent };
    })()`);
    log("final pixels:", JSON.stringify(pixels));
    const isColor = (rgba, r, g, b) => rgba && Math.abs(rgba[0] - r) < 40 && Math.abs(rgba[1] - g) < 40 && Math.abs(rgba[2] - b) < 40;
    check("sky region is really blue on the real webview canvas", isColor(pixels.sky, 0, 0, 255), JSON.stringify(pixels.sky));
    check("hills region is really green on the real webview canvas", isColor(pixels.hills, 0, 128, 0), JSON.stringify(pixels.hills));
    check("sun region is really yellow on the real webview canvas", isColor(pixels.sun, 255, 255, 0), JSON.stringify(pixels.sun));
    check("rocket region is really gray on the real webview canvas", isColor(pixels.rocket, 128, 128, 128), JSON.stringify(pixels.rocket));
    check("the page's own status line reflects a completed stroke (the DOM signal the fix relies on)", /stroke \d/.test(pixels.status || ""), pixels.status);
  }

  return finish(tripwire, seen);
}

async function finish(tripwire, seen) {
  const passed = checks.filter((c) => c.ok).length;
  const summary = { passed, total: checks.length, failed: checks.filter((c) => !c.ok).map((c) => c.name) };
  console.log("\n" + JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(RESULTS, "draw-real-app-check.json"), JSON.stringify({ when: new Date().toISOString(), electron: process.versions.electron, summary, checks }, null, 2));
  try { tripwire.server.close(); } catch (_) { /* ignore */ }
  app.exit(summary.failed.length ? 1 : 0);
}

app.whenReady().then(() => main().catch((e) => { console.error("INTEGRATION ERROR", e); app.exit(2); }));
