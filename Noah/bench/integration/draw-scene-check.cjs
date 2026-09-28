// The full pipeline, for real: RexyLegacyProvider.complete() (the deterministic navigate + DrawScript path) driven
// turn by turn, EXECUTING each returned action with real CDP mouse events against the real toy-paint.html, then
// reading the finished canvas's actual pixels back - the same rigor as paint-swatch-check.cjs / toy-paint-check.cjs,
// this time for the exact reported prompt end to end: navigate -> select colour -> select tool -> drag -> repeat.
//
// HONEST LIMIT (found the hard way): the execute() below is this file's OWN click/drag function, not the real
// Noah/agent/action-executor.cjs + Noah/agent/verifier.cjs that decide, in the live app, whether an action
// "worked". This test proves a drag CAN paint the right pixels; it says nothing about whether the real executor
// would consider that drag successful. It didn't: a canvas draw touches no DOM/text/URL/focus signal, so the
// real verifier fell through to a screenshot-hash diff that can silently come back empty on an occluded or
// backgrounded window - reported live as "I could not draw the sky - the last attempt to drag it on the canvas
// did not seem to work" even though the pixels were right. See draw-executor-check.cjs, which drives the REAL
// ActionExecutor/ActionVerifier (and forces screenshot capture to fail, to prove the fix does not depend on it).
//
//   npx electron Noah/bench/integration/draw-scene-check.cjs
"use strict";

const path = require("path");
const assert = require("node:assert/strict");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const { CdpSession } = require(path.join(ROOT, "Noah", "browser", "cdp.cjs"));
const { Observer } = require(path.join(ROOT, "Noah", "perception", "observer.cjs"));
const ax = require(path.join(ROOT, "Noah", "perception", "ax.cjs"));
const { RexyLegacyProvider } = require(path.join(ROOT, "Noah", "models", "rexy-legacy.cjs"));
const { checkNavigation } = require(path.join(ROOT, "Noah", "safety", "url-guard.cjs"));

app.on("window-all-closed", () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function click(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

async function drag(cdp, from, to, steps = 10) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, button: "none", buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, button: "left", buttons: 1 });
    await sleep(6);
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
}

/** Resolve+execute ONE validated-shape action for real, mirroring what action-executor.cjs actually does for click/drag/navigate/wait. */
async function execute(win, cdp, observer, refs, action) {
  if (action.action === "navigate") {
    const check = checkNavigation(action.url);
    assert.ok(check.allowed, `navigate must be allowed by the real safety gate: ${JSON.stringify(check)}`);
    await win.webContents.loadURL(check.url);
    await sleep(150);
    return { ok: true, text: `navigate ${check.url}` };
  }
  if (action.action === "wait") {
    await sleep(action.ms || 300);
    return { ok: true, text: "wait" };
  }
  if (action.action === "click" || action.action === "drag") {
    const obs = await observer.observe({});
    const resolvePoint = async (target) => {
      if (target.type === "viewport" || (target.space === "viewport")) return { x: target.x, y: target.y };
      if (target.type === "text" || typeof target.text === "string") {
        const found = ax.findElements(obs.elements, target.text, { limit: 5 });
        const usable = found.filter((e) => e.score >= 45);
        assert.ok(usable.length, `"${target.text}" should resolve; got ${JSON.stringify(found.map((f) => [f.name, f.score]))}`);
        const contenders = usable.filter((e) => e.score >= usable[0].score - 8);
        assert.equal(contenders.length, 1, `"${target.text}" must be unambiguous, got ${JSON.stringify(contenders.map((f) => f.name))}`);
        const r = usable[0].rect;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      throw new Error("unsupported target in this harness: " + JSON.stringify(target));
    };
    if (action.action === "click") {
      const p = await resolvePoint(action.target);
      await click(cdp, p.x, p.y);
      return { ok: true, text: `click ${JSON.stringify(action.target)}` };
    }
    const from = await resolvePoint(action.from);
    const to = await resolvePoint(action.to);
    await drag(cdp, from, to);
    return { ok: true, text: `drag (${from.x},${from.y})->(${to.x},${to.y}) -> changed` };
  }
  throw new Error("unhandled action in this harness: " + action.action);
}

async function main() {
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { sandbox: true, partition: "draw-scene-check" } });
  await win.loadURL("about:blank");
  const cdp = new CdpSession(win.webContents, { log: () => {} });
  await cdp.attach();
  const refs = new ax.RefTable();
  const observer = new Observer({ cdp, refs });

  const provider = new RexyLegacyProvider({ name: "rexy", baseURL: "https://example.invalid", getKey: () => null });
  provider.postJson = async () => { throw new Error("must not reach the network: this whole prompt should be handled deterministically"); };

  const goal = "draw a rocket colour and also the surroundings with blue skies and great green hills and a sun";
  const taskId = "draw-scene-check";
  const recentActions = [];

  for (let turn = 1; turn <= 12; turn++) {
    const obs = await observer.observe({});
    const els = obs.elements;
    const res = await provider.complete({ meta: { taskId, goal, observation: obs, recentActions } });
    const args = res.toolCalls[0].args;
    console.log(`turn ${turn}: ${args.status} - ${args.summary || args.result || ""}`);
    if (args.status === "give_up") throw new Error("DrawScript gave up: " + args.summary);
    if (args.status === "done") {
      console.log("  result:", args.result);
      break;
    }
    assert.equal(args.status, "continue");
    for (const action of args.actions) {
      const outcome = await execute(win, cdp, observer, refs, action);
      recentActions.push(outcome);
    }
    if (turn === 12) throw new Error("did not finish within 12 turns");
  }

  // ---- read the finished canvas back: is each region actually the right colour?
  const pixels = await win.webContents.executeJavaScript(`(() => {
    const c = document.querySelector('canvas.main-canvas');
    const ctx = c.getContext('2d');
    const at = (fx, fy) => Array.from(ctx.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data);
    return { sky: at(0.5, 0.15), hills: at(0.5, 0.9), sun: at(0.82, 0.16), rocket: at(0.5, 0.5) };
  })()`);
  console.log("final pixels:", JSON.stringify(pixels));
  const isColor = (rgba, r, g, b) => Math.abs(rgba[0] - r) < 40 && Math.abs(rgba[1] - g) < 40 && Math.abs(rgba[2] - b) < 40;
  assert.ok(isColor(pixels.sky, 0, 0, 255), "sky region should be blue: " + pixels.sky);
  assert.ok(isColor(pixels.hills, 0, 128, 0), "hills region should be green: " + pixels.hills);
  assert.ok(isColor(pixels.sun, 255, 255, 0), "sun region should be yellow: " + pixels.sun);
  assert.ok(isColor(pixels.rocket, 128, 128, 128), "rocket region should be gray: " + pixels.rocket);

  console.log("DRAW SCENE CHECK PASSED - a real blue sky, green hills, yellow sun and gray rocket were drawn, end to end, with zero network calls");
  win.destroy();
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    console.error("CHECK FAILED:", err && err.stack);
    app.exit(1);
  })
);
