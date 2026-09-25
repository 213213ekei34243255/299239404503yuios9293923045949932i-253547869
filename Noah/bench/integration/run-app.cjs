// Noah/bench/integration/run-app.cjs
//
// End-to-end integration test against the REAL Jonah application: the real main.cjs, index.html,
// preload.cjs, renderer.js, purple-cursor overlay, AI panel bridge, the legacy Rexy runtime's routing
// into Noah, and Noah's real OpenAIProvider talking HTTP.
//
// The "model" is a small scripted OpenAI-compatible HTTP server started by this file (NOT an LLM). It
// parses the same text prompt a real model would receive and answers with tool calls. So this test proves
// the app wiring and the wire protocol; it says nothing about LLM quality.
//
//   electron --user-data-dir=<tmp> Noah/bench/integration/run-app.cjs
//
// Uses an isolated userData dir (never touches the real Jonah profile). Requires ports 5588/5589 free
// (the app's own local servers) and skips itself otherwise.

"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const { app, BrowserWindow, nativeImage } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULTS = path.join(ROOT, "Noah", "bench", "results");
// Never touch the real Jonah profile: unless --user-data-dir was given, use a throwaway one (the test writes Noah settings into it).
if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(require("os").tmpdir(), "noah-it-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[integration]", ...a);
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

// ------------------------------------------------------------------ fixture site + fake model
const { createServer } = require("../fixtures.cjs");

function textOf(body) {
  const m = body.messages.find((x) => x.role === "user");
  if (!m) return "";
  return typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

function startFakeModel(fx, seen) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body;
      try { body = JSON.parse(raw); } catch (_) { res.writeHead(400); return res.end("{}"); }
      calls++;
      const text = textOf(body);
      const toolName = body.tool_choice?.function?.name || body.tools?.[0]?.function?.name;
      seen.push({ tool: toolName, hasImage: JSON.stringify(body.messages).includes("image_url"), url: req.url, auth: req.headers.authorization || null, chars: text.length });
      let args;
      if (toolName === "noah_plan") {
        args = { objective: "Find the cheapest 16GB laptop on the fixture shop", complexity: "complex", steps: ["Open the shop", "Search laptops", "Read the results", "Report the cheapest 16GB one"], success_criteria: ["price reported"], sensitive: false, needs_visual: false, sites: ["127.0.0.1"] };
      } else {
        const url = (/URL: (\S+)/.exec(text) || [])[1] || "";
        const pathname = (() => { try { return new URL(url).pathname; } catch (_) { return ""; } })();
        const ref = (role, name) => (new RegExp(`^(f?\\d*e\\d+) ${role}\\d* "${name}"`, "m").exec(text) || [])[1];
        const readOut = /## Output of read_page[\s\S]*?<untrusted_page_content[^>]*>([\s\S]*?)<\/untrusted_page_content/.exec(text);
        if (pathname !== "/" && pathname !== "/search") {
          args = { status: "continue", summary: "Opening the shop", method: "browser", actions: [{ action: "navigate", url: fx.url("/") }] };
        } else if (pathname === "/") {
          const box = ref("textbox", "Search products");
          args = box ? { status: "continue", summary: "Searching for laptops", method: "ax", actions: [{ action: "type", target: { ref: box }, text: "laptop", submit: true, expect: { url_contains: "/search" } }] } : { status: "give_up", summary: "search box not found in the element list" };
        } else if (!readOut) {
          args = { status: "continue", summary: "Reading all the results", method: "browser", actions: [{ action: "read_page", filter: "text" }] };
        } else {
          const rows = [...readOut[1].matchAll(/₹([\d,]+)\s*·\s*(\d+)GB/g)].map((m) => ({ p: +m[1].replace(/,/g, ""), ram: +m[2] }));
          const best = rows.filter((r) => r.ram === 16).sort((a, b) => a.p - b.p)[0];
          args = best ? { status: "done", summary: "Compared every result", result: `The cheapest 16GB laptop is ₹${best.p.toLocaleString("en-IN")}.` } : { status: "give_up", summary: "could not parse prices" };
        }
      }
      const payload = { id: "fake-" + calls, model: body.model, choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_" + calls, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: Math.ceil(text.length / 3.6), completion_tokens: 60 } };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, calls: () => calls })));
}

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  if (!(await portFree(5588)) || !(await portFree(5589))) {
    console.log("SKIP: ports 5588/5589 (Jonah's own local servers) are in use; close any running Jonah and retry.");
    return app.exit(0);
  }
  const fx = await createServer();
  const seen = [];
  const fake = await startFakeModel(fx, seen);

  // configuration the real app will read: roles -> the fake OpenAI-compatible endpoint, localhost allowed (fixtures)
  const cfgDir = path.join(app.getPath("userData"), "browser-data", "noah");
  fs.mkdirSync(cfgDir, { recursive: true });
  const cand = (m) => [{ provider: "local", model: m, trusted: true }];
  fs.writeFileSync(path.join(cfgDir, "noah-config.json"), JSON.stringify({ takeover: { enabled: false }, policy: { mode: "autonomous", allowLocalhost: true }, roles: { planner: cand("fake-planner"), browser: cand("fake-vl"), vision: cand("fake-vl"), fast: cand("fake-vl"), local: cand("fake-vl") } }));
  process.env.NOAH_LOCAL_BASE_URL = `http://127.0.0.1:${fake.port}/v1`;

  if (process.env.NOAH_TRACE) { let last = Date.now(); setInterval(() => { const now = Date.now(); if (now - last > 1500) log("main-process event loop stalled for", now - last, "ms"); last = now; }, 500).unref(); }
  log("starting the real Jonah app (main.cjs) with an isolated profile at", app.getPath("userData"));
  // main.cjs does loadFile("index.html"), which resolves against the app path. Launched as a script that would be
  // this folder, so point it at the project root (as `electron .` does) instead of adding a test hook to production code.
  app.getAppPath = () => ROOT;
  require(path.join(ROOT, "main.cjs"));

  // ---- wait for the shell window + Noah bridge
  let win = null;
  for (let i = 0; i < 120 && !win; i++) {
    await sleep(500);
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html"));
  }
  if (!win) { check("Jonah shell window opened", false); return finish(fx, fake); }
  check("Jonah shell window opened (real main.cjs + index.html)", true);
  const shellErrors = [];
  win.webContents.on("console-message", (_e, level, message, _line, source) => { if (level >= 3 && /noah|overlay/i.test(message + " " + source)) shellErrors.push(String(message).slice(0, 160)); });
  win.webContents.on("render-process-gone", (_e, d) => shellErrors.push("render-process-gone: " + d.reason));
  win.webContents.closeDevTools();
  // every renderer call is bounded: a wedged shell must fail the test, not hang it
  const ev = (js, ms = 15000) => Promise.race([(process.env.NOAH_TRACE ? (log("ev:", String(js).slice(0, 70)), win.webContents.executeJavaScript(js, true)) : win.webContents.executeJavaScript(js, true)), new Promise((_, rej) => setTimeout(() => rej(new Error("renderer call timed out: " + String(js).slice(0, 60))), ms))]);
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(500);
    ready = await ev("!!(window.noah && window.NoahRenderer && window.NoahOverlay && document.getElementById('noahOverlay'))").catch(() => false);
  }
  check("preload exposes window.noah; noah-renderer bridge + overlay mounted in the shell", ready);
  if (!ready) return finish(fx, fake);

  const cfg = await ev("window.noah.getConfig()");
  check("renderer config view has NO secrets and reports provider status", !JSON.stringify(cfg).match(/api[_-]?key["']?\s*:\s*["'][A-Za-z0-9]/i) && cfg.providerStatus && cfg.providerStatus.local.hasKey === true && cfg.policy.allowLocalhost === true);
  const theme = await ev("window.noah.getTheme()");
  const primary = await ev("getComputedStyle(document.getElementById('noahOverlay')).getPropertyValue('--noah-cursor-primary').trim()");
  check("purple cursor theme arrives via IPC and drives CSS variables (single source of truth)", theme.theme.NOAH_CURSOR_PRIMARY === "#7C3AED" && primary.toLowerCase() === "#7c3aed", `--noah-cursor-primary=${primary}`);

  // record what the shell sees
  await ev(`(() => { window.__ev = []; window.__legacy = []; window.noah.onEvent((e) => { e.__t = Date.now(); window.__ev.push(e); }); window.rexy.onGoalCompleted((d) => window.__legacy.push(['completed', d])); window.rexy.onGoalStep((d) => window.__legacy.push(['step', d])); })()`);
  const tabs0 = await ev("window.NoahRenderer.tabs()");
  check("tab bridge reports the real <webview> with its webContents id", tabs0.length >= 1 && tabs0[0].wcId > 0, JSON.stringify(tabs0[0]));

  // ---- goal via the LEGACY entry point the AI panel/voice orb use (Rexy runtime -> Noah routing)
  let agentAvailable = false;
  for (let i = 0; i < 20 && !agentAvailable; i++) { await sleep(500); agentAvailable = (await ev("window.noah.getState()")).status === "idle"; }
  // (the app starts the Rexy runtime itself on load; calling rexy.start() again only makes it console.log its whole state)
  await sleep(1500);
  const goal = "Noah, go to the shop and find the cheapest 16GB laptop";
  log("submitting through window.rexy.goal(...) (legacy path):", goal);
  const submit = await ev(`window.rexy.goal(${JSON.stringify(goal)})`);
  check("legacy rexy.goal() accepted the goal", submit && submit.success);

  // ---- sample the overlay while the task runs, and capture an image of the purple cursor over the page
  let shotSaved = false;
  let cursorPurplePixels = 0;
  let sawCursor = false;
  let sawCursorBeforeClick = null;
  let sawStatus = "";
  let finished = null;
  for (let i = 0; i < 500 && !finished; i++) {
    await sleep(100);
    const snap = await ev(`(() => { const o = document.getElementById('noahOverlay'); const c = o && o.querySelector('.noah-cursor'); const st = o && o.querySelector('.noah-status .noah-text');
      const nums = c && c.style.transform ? c.style.transform.slice(c.style.transform.indexOf('(') + 1).replace(/[^0-9.,-]/g, '').split(',') : []; const cs = c && getComputedStyle(c); const ar = c && getComputedStyle(c.querySelector('.noah-arrow')); const tg = c && getComputedStyle(c.querySelector('.noah-tag')); return { css: c ? { opacity: cs.opacity, arrowFill: ar.fill, tagBg: tg.backgroundColor, tagOpacity: tg.opacity, w: cs.width } : null, pos: nums.length >= 2 ? [+nums[0], +nums[1]] : null, clicks: window.__ev.filter((e) => e.event === 'mouse_action' && e.action === 'click').length, hidden: o && o.hidden, cursor: c && c.classList.contains('noah-visible'), state: o && o.getAttribute('data-state'), status: st && st.textContent, fin: window.__ev.find((e) => e.event === 'task_finished') || null }; })()`).catch(() => null);
    if (!snap) continue;
    if (snap.cursor && !snap.hidden) sawCursor = true;
    if (snap.cursor && !snap.hidden && snap.clicks === 0 && snap.pos) sawCursorBeforeClick = snap.pos;
    if (snap.status) sawStatus = snap.status;
    if (snap.clicks >= 1 && !shotSaved) {
      // The overlay fades in over ~160ms and the compositor can lag the DOM, so take the picture only once the cursor's
      // own pixels (arrow fill = NOAH_CURSOR_PRIMARY) are actually in the frame - retry instead of trusting a sleep.
      let img = null, crop = null, purple = 0;
      for (let k = 0; k < 12; k++) {
        await sleep(k === 0 ? 250 : 150);
        const cur = await ev("(() => { const c = document.querySelector('#noahOverlay .noah-cursor'); const r = c.getBoundingClientRect(); return { opacity: getComputedStyle(c).opacity, pos: [r.left, r.top] }; })()").catch(() => null);
        if (!cur || !cur.pos) continue;
        img = await win.webContents.capturePage();
        const sz = img.getSize();
        const kk = sz.width / win.getContentBounds().width;
        const x = Math.max(0, Math.round((cur.pos[0] - 30) * kk)), y = Math.max(0, Math.round((cur.pos[1] - 30) * kk));
        crop = img.crop({ x, y, width: Math.min(220, sz.width - x), height: Math.min(120, sz.height - y) });
        const cs = crop.getSize();
        const bmp = crop.toBitmap(); // BGRA
        purple = 0;
        for (let i = 0; i < bmp.length; i += 4) if (Math.abs(bmp[i + 2] - 124) < 24 && Math.abs(bmp[i + 1] - 58) < 24 && Math.abs(bmp[i] - 237) < 24) purple++;
        log("cursor capture try", k + 1, JSON.stringify({ opacity: cur.opacity, pos: cur.pos, crop: cs, solidPurplePixels: purple }));
        if (cur.opacity === "1" && purple >= 40) break;
      }
      fs.writeFileSync(path.join(RESULTS, "integration-purple-cursor.png"), img.toPNG());
      if (crop) { const cs = crop.getSize(); fs.writeFileSync(path.join(RESULTS, "integration-purple-cursor-zoom.png"), crop.resize({ width: cs.width * 4, height: cs.height * 4, quality: "best" }).toPNG()); }
      cursorPurplePixels = purple;
      shotSaved = true;
    }
    finished = snap.fin;
  }
  if (!finished) {
    const tail = await ev("(() => { const t0 = Date.now(); return window.__ev.slice(-14).map((e) => (t0 - e.__t) + 'ms ago ' + e.event + (e.action ? ' ' + (e.action.action || e.action) : '') + (e.level ? ' ' + e.level : '') + (e.status ? ' ' + e.status : '') + (e.reason ? ' (' + String(e.reason).slice(0, 60) + ')' : '')); })()").catch((err) => ["(could not read events: " + err.message + "]"]);
    log("TASK DID NOT FINISH - last events:\n    " + tail.join("\n    "));
  }
  check("Noah handled the legacy goal end-to-end and the task completed", finished && finished.status === "completed", finished ? `${finished.status}: ${finished.result || finished.error}` : "timed out");
  check("answer is correct (cheapest 16GB laptop = ₹61,999)", finished && /61,999/.test(finished.result || ""), finished && finished.result);
  check("purple cursor overlay became visible during the task and status text was shown", sawCursor && !!sawStatus, `status seen: "${sawStatus}"`);
  check("the cursor is on screen from the start of the task (before any click), not only at the first click", !!sawCursorBeforeClick, JSON.stringify(sawCursorBeforeClick));
  check("the real shell frame contains the cursor's solid purple arrow pixels (not just the DOM state)", cursorPurplePixels >= 40, `${cursorPurplePixels} pixels within tolerance of #7C3AED near the cursor`);
  if (shotSaved) log("saved evidence screenshot: Noah/bench/results/integration-purple-cursor.png");

  const evs = await ev("window.__ev.map((e) => e.event)");
  check("event stream reached the renderer (task_started, plan, step, action_result, task_finished, mouse_action)", ["task_started", "plan", "step", "action_result", "task_finished", "mouse_action"].every((n) => evs.includes(n)), [...new Set(evs)].join(","));
  const legacy = await ev("window.__legacy.map((x) => x[0])");
  check("legacy runtime:goal-* events still fire (voice orb / old panel keep working)", legacy.includes("completed"), legacy.join(","));
  const url = await ev("window.NoahRenderer.tabs().find((t) => t.active).url");
  check("the real webview ended on the shop's results page", /\/search\?q=laptop/.test(url), url);
  check("HTTP wire protocol: real OpenAIProvider called the endpoint (keyless local, tool_choice honoured), planner + 3 steps", seen.length >= 4 && seen.every((s) => s.url === "/v1/chat/completions" && s.auth === null) && seen.some((s) => s.tool === "noah_plan") && seen.filter((s) => s.tool === "noah_step").length >= 3, `${seen.length} calls: ${seen.map((s) => s.tool + (s.hasImage ? "+img" : "")).join(", ")}`);
  const audit = await ev("window.noah.getAudit()");
  check("audit log recorded the actions (with typed text redacted)", audit.length >= 3 && !JSON.stringify(audit).includes('"text":"laptop"'), `${audit.length} entries`);
  const st = await ev("window.noah.getState()");
  check("agent returned to idle and released the page (no debugger left attached)", st.status === "idle" && !(await win.webContents.executeJavaScript("false")), JSON.stringify(st));
  const guestAttached = require("electron").webContents.getAllWebContents().filter((c) => c.getType() === "webview").some((c) => c.debugger.isAttached());
  check("no CDP debugger remains attached to any tab after the task", !guestAttached);

  // the panel's "Purple cursor" switch: config cursor.mode "off" hides the pointer (status pill + STOP stay), "decoupled" restores it
  const cursorDisplay = () => ev("(() => { const o = document.getElementById('noahOverlay'); return { off: o.classList.contains('noah-cursor-off'), display: getComputedStyle(o.querySelector('.noah-cursor')).display, pill: getComputedStyle(o.querySelector('.noah-status')).display }; })()");
  const before = await cursorDisplay();
  // drive the REAL panel checkbox (the AI panel is an iframe: reach it through its WebFrameMain), as a user clicking it would
  const panel = win.webContents.mainFrame.framesInSubtree.find((fr) => /ai-panel.html/.test(fr.url));
  const panelBox = () => panel.executeJavaScript("document.getElementById('noahCursor').checked");
  const startedOn = panel ? await panelBox() : null;
  if (panel) await panel.executeJavaScript("document.getElementById('noahCursor').click()");
  await sleep(500);
  const offState = await cursorDisplay();
  const boxOff = panel ? await panelBox() : null;
  if (panel) await panel.executeJavaScript("document.getElementById('noahCursor').click()");
  await sleep(500);
  const onState = await cursorDisplay();
  const boxOn = panel ? await panelBox() : null;
  check("purple cursor switch: on by default, 'off' hides the cursor, switching back on restores it", !!panel && startedOn === true && boxOff === false && boxOn === true && !before.off && before.display !== "none" && offState.off && offState.display === "none" && !onState.off && onState.display !== "none", JSON.stringify({ before, offState, onState }));
  check("no console errors or renderer crashes from Noah/overlay code in the real shell", shellErrors.length === 0, shellErrors.join(" | "));

  // `npm run noah:demo`: leave the real Jonah window open and replay the task so the purple cursor can be watched
  // (and the app used) instead of the process exiting. Close the window to end it. The scripted server only knows
  // this one goal; a real model is needed for anything else (see docs/ARCHITECTURE.md, "Model configuration").
  if (process.env.NOAH_KEEP_OPEN) {
    const summary = { passed: checks.filter((c) => c.ok).length, total: checks.length };
    log(`checks ${summary.passed}/${summary.total}. Demo mode: replaying the shop task in the real Jonah window; close the window to stop.`);
    let closed = false;
    win.on("closed", () => { closed = true; app.exit(0); });
    while (!closed) {
      await sleep(4000);
      if (win.isDestroyed()) break;
      await ev(`window.NoahRenderer.navigate ? window.NoahRenderer.navigate(${JSON.stringify(fx.url("/"))}) : (document.querySelector('webview') && document.querySelector('webview').loadURL(${JSON.stringify(fx.url("/"))}))`).catch(() => {});
      await sleep(1500);
      await ev(`window.rexy.goal(${JSON.stringify(goal)})`).catch(() => {});
      for (let i = 0; i < 300 && !closed; i++) {
        await sleep(200);
        const s = await ev("window.noah.getState()").catch(() => null);
        if (s && s.status === "idle") break;
      }
    }
    return;
  }

  return finish(fx, fake);
}

async function finish(fx, fake) {
  const passed = checks.filter((c) => c.ok).length;
  const summary = { passed, total: checks.length, failed: checks.filter((c) => !c.ok).map((c) => c.name) };
  console.log("\n" + JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(RESULTS, "integration-app.json"), JSON.stringify({ when: new Date().toISOString(), electron: process.versions.electron, note: "Real Jonah app + scripted OpenAI-compatible HTTP server (NOT an LLM)", summary, checks }, null, 2));
  try { await fx.close(); fake.server.close(); } catch (_) { /* ignore */ }
  app.exit(summary.failed.length ? 1 : 0);
}

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.whenReady().then(() => main().catch((e) => { console.error("INTEGRATION ERROR", e); app.exit(2); }));
