// Noah/bench/integration/mission-buttons-check.cjs
//
// Do the Stop button, Esc and the Continue button reach a running PROJECT TASK in the REAL app wiring? The real createNoah is built exactly the way
// main.cjs builds it (a real window, the real ipc registration, the real command router, the real mission service, real tools on a real project);
// the "model" is a local stand-in server speaking /api/llm/step with a SCRIPT of tool calls (this checks the buttons, NOT any model), and the
// buttons are pressed by calling the very handlers the shell's preload bridge invokes.
//
//   node Noah/bench/integration/mission-buttons-check.cjs
//
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const IS_ELECTRON = !!(process.versions && process.versions.electron);

let failures = 0;
const check = (ok, what, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${extra ? `  -> ${extra}` : ""}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(25); } };

async function runner() {
  const { app, BrowserWindow, webContents, screen, safeStorage, session } = require("electron");
  const { createNoah } = require(path.join(ROOT, "Noah", "index.cjs"));

  // ---- a stand-in /api/llm/step that plays a script, with an optional delay per call (so a button can be pressed while the model "thinks")
  const script = { rounds: [], delays: {}, calls: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const i = script.calls++;
      if (script.delays[i]) await sleep(script.delays[i]);
      const r = script.rounds[i];
      res.setHeader("content-type", "application/json");
      if (!r) { res.statusCode = 503; return res.end(JSON.stringify({ error: { code: "overloaded", message: "the script ran out" } })); }
      res.end(JSON.stringify({ text: "", toolCalls: r.map(([name, args], k) => ({ id: `c${i}_${k}`, name, args })), usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, stopReason: "STOP", model: "stand-in" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseURL = `http://127.0.0.1:${server.address().port}`;

  // ---- the real app's wiring
  const mainWindow = new BrowserWindow({ width: 600, height: 400, show: false, webPreferences: { contextIsolation: true } });
  await mainWindow.loadURL("about:blank");
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), removeHandler: (ch) => handlers.delete(ch) };
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "noah-btn-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-btn-data-"));
  const root = fs.realpathSync.native(project);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.js"), "module.exports = 1;\n");
  const noah = createNoah({
    mainWindow, ipcMain, electron: { webContents, screen, safeStorage, session }, dataDir, appRoot: ROOT,
    hosted: { baseURL, isSignedIn: () => true, getAuthHeaders: async () => ({ "X-Jonah-Device": "stand-in", "X-Jonah-Timestamp": String(Date.now()), "X-Jonah-Signature": "stand-in" }) },
    pickFolder: async () => root,
  });
  const click = (channel, ...args) => handlers.get(channel)({ sender: mainWindow.webContents }, ...args);
  const ended = () => new Promise((resolve) => noah.missions.once("ended", resolve));
  const CRITERIA = ["criteria_add", { criteria: [{ kind: "file_exists", path: "src/a.js", description: "a.js exists" }] }];
  const PLAN = ["plan_set", { steps: ["do it"] }];

  check(noah.missions.isAvailable(), "the real app's mission service has a model (the stand-in) and is available");
  check(["noah:stop", "noah:pause", "noah:resume"].every((c) => handlers.has(c)), "the real ipc registration exposes the three buttons");

  // ---- 1. STOP while the model is thinking about a file write
  Object.assign(script, { calls: 0, rounds: [[CRITERIA, PLAN], [["fs_write", { path: "src/should-not-exist.js", content: "x" }]]], delays: { 1: 1200 } });
  let done = ended();
  const started = noah.commandRouter.route("Run the tests in this project and fix whatever fails.", { source: "text" });
  check(started.handled && started.kind === "mission", "a project job typed in the panel starts a mission", JSON.stringify(started));
  await until(() => script.calls >= 2);
  const stop = await click("noah:stop");
  check(stop.ok === true && stop.mission === true, "the Stop button reports that it stopped a project task", JSON.stringify(stop));
  const out1 = await done;
  check(out1.status === "cancelled" && out1.resumable === false, "the task ended as cancelled and cannot be resumed", `${out1.status} resumable=${out1.resumable}`);
  await sleep(1500); // the model's slow answer arrives after the stop: it must not be acted on
  check(!fs.existsSync(path.join(root, "src", "should-not-exist.js")), "the file write the model was about to ask for never happened");
  check(!noah.missions.isRunning(), "nothing is running afterwards");

  // ---- 2. PAUSE, then CONTINUE
  Object.assign(script, { calls: 0, rounds: [[CRITERIA, PLAN], [["fs_list", { path: "." }]], [["fs_write", { path: "src/b.js", content: "module.exports = 2;\n" }]], [["finish", { summary: "Added b.js." }]]], delays: { 1: 1200 } });
  done = ended();
  noah.commandRouter.route("Add a file b.js to this project and verify it exists.", { source: "text" });
  await until(() => script.calls >= 2);
  const pause = await click("noah:pause");
  check(pause.ok === true && pause.mission === true, "the Pause button pauses the project task", JSON.stringify(pause));
  const out2 = await done;
  check(out2.status === "budget_paused" && out2.resumable === true, "it ended as a resumable PAUSE", `${out2.status} resumable=${out2.resumable}`);
  await sleep(1500);
  check(!fs.existsSync(path.join(root, "src", "b.js")), "nothing was written while paused");
  done = ended();
  const resume = await click("noah:resume");
  check(resume.ok === true && resume.mission === true, "the Continue button resumes the PROJECT task", JSON.stringify(resume));
  const out3 = await done;
  check(out3.status === "succeeded", "the resumed task finished", out3.status);
  check(fs.existsSync(path.join(root, "src", "b.js")), "and did the work that was left");

  // ---- 3. a stray Continue with nothing to continue does nothing
  const stray = await click("noah:resume");
  check(stray.ok === false || stray.mission !== true, "Continue with nothing to continue does not invent a task", JSON.stringify(stray));

  // ---- 4. the shell window is the only sender allowed
  let rejected = false;
  try { await handlers.get("noah:stop")({ sender: {} }); } catch (e) { rejected = /untrusted sender/.test(e.message); }
  check(rejected, "a sender that is not the Jonah shell window is refused");

  noah.dispose();
  server.close();
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`RESULT mission-buttons ${failures ? "FAIL" : "ok"}`);
  app.exit(failures ? 1 : 0);
}

async function driver() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "noah-btn-ud-"));
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const child = spawn(electronPath, [`--user-data-dir=${tmp}`, __filename, ...process.argv.slice(2)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let err = "";
  child.stdout.on("data", (x) => process.stdout.write(x));
  child.stderr.on("data", (x) => { err += x; });
  const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 120_000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (code === -99) console.log("FAIL  timed out");
  else if (code !== 0 && /Error/.test(err)) console.log(err.split(/\r?\n/).filter((l) => /Error|at /.test(l)).slice(0, 8).join("\n"));
  process.exit(code === 0 ? 0 : 1);
}

if (IS_ELECTRON) require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e && e.stack); require("electron").app.exit(2); }));
else driver().catch((e) => { console.error(e); process.exit(2); });
