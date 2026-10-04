// Noah/bench/integration/desktop-mission-check.cjs
//
// A desktop task through the REAL app wiring, with REAL windows: the real createNoah (built the way main.cjs builds it), the real command router, mission
// service, runner, desktop tools, policy and helper, operating a real test window (Noah/test/fixtures/desktop-fixture.ps1). Only the model is a stand-in: a small
// rule-based "model" behind a local /api/llm/step server that reads the briefing it is sent (the way a model would) and answers with tool calls. This checks the
// WIRING and the SAFETY behaviour, NOT any model (run-desktop-live.cjs does that). It also covers working QUIETLY (a task that only reads and presses through the accessibility
// tree shows no bar and does not bring Jonah forward; finishing and asking for an OK are notifications), the Stop bar while Noah takes over the keyboard, and a REAL
// Ctrl+Alt+X keystroke stopping typing in the middle of a line.
//
//   node Noah/bench/integration/desktop-mission-check.cjs
//
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const IS_ELECTRON = !!(process.versions && process.versions.electron);
let failures = 0;
const check = (ok, what, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${extra ? `  -> ${extra}` : ""}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15_000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(40); } };

async function runner() {
  const { app, BrowserWindow, webContents, screen, safeStorage, session, globalShortcut, ipcMain: realIpc } = require("electron");
  const { createNoah } = require(path.join(ROOT, "Noah", "index.cjs"));
  const { DesktopBridge } = require(path.join(ROOT, "Noah", "desktop", "bridge.cjs"));

  const token = "W" + Math.random().toString(36).slice(2, 7);
  const probe = new DesktopBridge(); // the check's own eyes: it reads the window independently of Noah
  const FIXTURE = path.join(ROOT, "Noah", "test", "fixtures", "desktop-fixture.ps1");
  const hostExe = path.join(os.tmpdir(), `noah-fixture-host-${token}.exe`);
  fs.copyFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), hostExe); // a window of a program called "powershell" is a terminal to the policy; this one is an ordinary application
  const fixture = spawn(hostExe, ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", FIXTURE, "-Token", token, "-Seconds", "170"], { stdio: "ignore" });
  const fixWin = await probe.waitWindow({ title: token, waitMs: 25_000 });
  check(/noah-fixture-host/i.test(fixWin.process), "set-up: the stand-in application is an ordinary program, not a shell", fixWin.process);
  const token2 = "S" + Math.random().toString(36).slice(2, 7); // unrelated to `token`: a title that contained it would make "the window titled <token>" ambiguous (Noah rightly refuses to guess)
  const shellFixture = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", FIXTURE, "-Token", token2, "-Seconds", "170", "-Left", "600", "-Top", "300"], { stdio: "ignore" }); // a REAL powershell.exe: a terminal to the policy
  const shellWin = await probe.waitWindow({ title: token2, waitMs: 25_000 });
  const shellLabel = async () => { const n = (await probe.tree(shellWin.window)).nodes; return (n.find((x) => x.type === "Text" && /^(\(nothing yet\)|Hello |DELETED)/.test(x.name)) || {}).name; };
  const label = async () => { const n = (await probe.tree(fixWin.window)).nodes; return (n.find((x) => x.type === "Text" && /^(\(nothing yet\)|Hello |DELETED)/.test(x.name)) || {}).name; };
  const nameValue = async () => ((await probe.tree(fixWin.window)).nodes.find((x) => x.name === "Name field") || {}).value;

  // ---- a stand-in model: a function of the briefing it is sent
  const brain = { scenario: "greet", n: 0, seen: {} };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body);
      const text = b.messages[b.messages.length - 1].content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      // like a real model, it REMEMBERS the control ids it read earlier in the task (a later message, such as the result of filling a field, does not repeat the list)
      const id = (re) => { const m = text.match(re); if (m) brain.seen[re.source] = m[1]; return brain.seen[re.source] || null; };
      const n = ++brain.n;
      if (n === 1) brain.seen = {};
      let calls;
      if (brain.scenario === "greet") {
        const nameId = id(/\[(e\d+)\] Edit "Name field"/), greetId = id(/\[(e\d+)\] Button "Greet"/);
        calls = n === 1 ? [["criteria_add", { criteria: [{ kind: "element_text", title: token, text: "Hello Ada" }] }], ["plan_set", { steps: ["read the window", "fill the name", "press Greet"] }]]
          : n === 2 ? [["desktop_windows", {}]]
          : n === 3 ? [["desktop_read", { title: token }]]
          : n === 4 ? [["desktop_set_text", { element: nameId, text: "Ada" }]]
          : n === 5 ? [["desktop_click", { element: greetId }]]
          : n === 6 ? [["desktop_read", { title: token }]]
          : [["finish", { summary: "Put Ada in the Name field and pressed Greet; the window says Hello Ada." }]];
      } else if (brain.scenario === "trap") {
        const deleteId = id(/\[(e\d+)\] Button "Delete everything"/);
        calls = n === 1 ? [["criteria_add", { criteria: [{ kind: "claim", description: "report what each button did" }] }], ["plan_set", { steps: ["read", "press buttons"] }]]
          : n === 2 ? [["desktop_read", { title: token }]]
          : n === 3 ? [["desktop_click", { element: deleteId }]]
          : [["give_up", { reason: "The user declined pressing Delete everything, so I stopped there and reported it." }]];
      } else if (brain.scenario === "terminal") {
        const greetId = id(/\[(e\d+)\] Button "Greet"/);
        calls = n === 1 ? [["criteria_add", { criteria: [{ kind: "claim", description: "press Greet in the window" }] }], ["plan_set", { steps: ["read", "press Greet"] }]]
          : n === 2 ? [["desktop_read", { title: token2 }]]
          : n === 3 ? [["desktop_click", { element: greetId }]]
          : [["give_up", { reason: "That window belongs to a terminal program, which I am not allowed to operate." }]];
      } else { // "typing": a long line of typing that the Stop button will interrupt
        const nameId = id(/\[(e\d+)\] Edit "Name field"/);
        calls = n === 1 ? [["criteria_add", { criteria: [{ kind: "claim", description: "typed" }] }], ["plan_set", { steps: ["read", "type"] }]]
          : n === 2 ? [["desktop_read", { title: token }]]
          : n === 3 ? [["desktop_type", { title: token, element: nameId, text: "abcdefghij".repeat(120) }]]
          : [["give_up", { reason: "Stopped while typing, so I did not finish." }]];
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: "", toolCalls: calls.map(([name, args], k) => ({ id: `c${n}_${k}`, name, args })), usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, stopReason: "STOP", model: "stand-in" }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseURL = `http://127.0.0.1:${server.address().port}`;

  // ---- the real app's wiring
  const mainWindow = new BrowserWindow({ width: 600, height: 400, show: false, webPreferences: { contextIsolation: true } });
  await mainWindow.loadURL("about:blank");
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), removeHandler: (ch) => handlers.delete(ch), on: (...a) => realIpc.on(...a), removeListener: (...a) => realIpc.removeListener(...a), removeAllListeners: (...a) => realIpc.removeAllListeners(...a) };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-dm-data-"));
  const folderAsked = [];
  const toasts = [];
  class FakeNotification { // records what the user would be shown; nothing real pops up during the check
    static isSupported() { return true; }
    constructor(o) { this.o = o; }
    on() { return this; }
    show() { toasts.push({ title: this.o.title, body: this.o.body }); }
  }
  const noah = createNoah({
    mainWindow, ipcMain, electron: { webContents, screen, safeStorage, session, BrowserWindow, globalShortcut, Notification: FakeNotification }, dataDir, appRoot: ROOT,
    hosted: { baseURL, isSignedIn: () => true, getAuthHeaders: async () => ({ "X-Jonah-Device": "stand-in", "X-Jonah-Timestamp": String(Date.now()), "X-Jonah-Signature": "stand-in" }) },
    pickFolder: async (i) => { folderAsked.push(i); return null; },
  });
  const click = (channel, ...args) => handlers.get(channel)({ sender: mainWindow.webContents }, ...args);
  const events = [];
  noah.core.bus.subscribe((e) => events.push(e));
  const activity = () => events.filter((e) => e.event === "mission_activity" && e.pending === false).map((e) => e.text);
  const ended = () => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("the task did not end within 90 s")), 90_000); noah.missions.once("ended", (o) => { clearTimeout(t); resolve(o); }); });
  const cards = [];
  const answerCards = (allow) => noah.core.bus.subscribe((e) => { if (e.event === "confirm_request") { cards.push(e); setTimeout(async () => { cards[cards.length - 1].barSaid = await pillText(); noah.core.safety.resolveConfirmation(e.id, allow); }, 500); } });

  check(noah.missions.isDesktopAvailable(), "the real app's mission service can operate the desktop");
  const pill = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle() === "Noah is working");
  const pillText = async () => { const p = pill(); return p ? p.webContents.executeJavaScript(`document.getElementById("m").textContent`).catch(() => "") : ""; };
  check(!pill() && !globalShortcut.isRegistered("Control+Alt+X"), "before any task there is no Stop bar and Ctrl+Alt+X is free");
  let barSeen = 0, barTexts = new Set();
  const watcher = setInterval(async () => { if (pill()) { barSeen++; const t = await pillText(); if (t) barTexts.add(t); } }, 60);

  // ---- 1. a typed request becomes a desktop task, and the window really changes
  let done = ended();
  const routed = noah.commandRouter.route(`in the window titled Noah Fixture ${token}, fill in the name field with Ada, then press Greet`, { source: "text" });
  check(routed.handled && routed.kind === "mission", "a typed desktop request is routed to a task (not the browser agent, not chat)", JSON.stringify(routed));
  const out1 = await done;
  check(out1.status === "succeeded", "the task ended as succeeded, checked on the screen", `${out1.status}: ${String(out1.reason).slice(0, 100)}`);
  check(folderAsked.length === 0, "no folder was asked for");
  check((await label()) === "Hello Ada", "the real window says 'Hello Ada' (read independently of Noah)", String(await label()));
  const lines = activity();
  check(lines.includes("Filled in a field") && lines.includes('Clicked "Greet"'), "the Activity view said what Noah did", lines.join(" | ").slice(0, 200));
  check(/PASS .*shows "Hello Ada"/.test(out1.text), "and the final message reports the check on the screen", out1.text.split("\n").find((l) => /PASS/.test(l)) || "");
  check(!/Heads-up/.test(out1.text), "with nothing to warn about");
  check(barSeen > 0, "the Stop bar was on screen while the computer task ran", `seen ${barSeen} times; it said: ${[...barTexts].slice(0, 5).join(" | ")}`);
  check([...barTexts].some((t) => /Clicked|Filled|Read|Looked|Using|Noah is working/i.test(t)), "and it said what Noah was doing", [...barTexts].join(" | ").slice(0, 150));
  check(!mainWindow.isVisible() && !mainWindow.isFocused(), "and it did not bring Jonah's window forward");
  check(toasts.some((t) => /finished/i.test(t.title) && /Put Ada/.test(t.body)), "the user was told it finished with a notification carrying the answer", JSON.stringify(toasts.at(-1)));
  await sleep(300);
  check(!pill() && !globalShortcut.isRegistered("Control+Alt+X"), "and when the task ended the shortcut was released");

  // ---- 2. a risky button asks first; declined, the window is untouched
  events.length = 0; brain.scenario = "trap"; brain.n = 0;
  const unsub = answerCards(false);
  done = ended();
  noah.commandRouter.route(`in the window titled Noah Fixture ${token}, press every button`, { source: "text" });
  const out2 = await done;
  unsub();
  check(cards.length === 1 && /Delete everything/.test(cards[0].summary) && cards[0].risk && cards[0].risk.level === "high", "pressing 'Delete everything' put a confirmation card to the user", cards[0] && cards[0].summary);
  check((await label()) !== "DELETED", "declined: the window does not say DELETED", String(await label()));
  check(toasts.some((t) => /needs your OK/i.test(t.title) && /Delete everything/.test(t.body)), "while the card waited, a notification asked for the user's OK (instead of a window jumping up)", JSON.stringify(toasts.map((t) => t.title)));
  check(!mainWindow.isVisible(), "and Jonah's own window was not put in front of the user");
  check(activity().includes("Could not click"), "and the Activity view shows it as a refusal", activity().join(" | ").slice(0, 160));
  check(out2.status !== "succeeded", "and the task did not claim success", out2.status);

  // ---- 3. the Stop button kills typing in the middle of a line
  events.length = 0; brain.scenario = "typing"; brain.n = 0;
  await probe.setText(((await probe.tree(fixWin.window)).nodes.find((x) => x.name === "Name field")).element, "");
  done = ended();
  noah.commandRouter.route(`in the window titled Noah Fixture ${token}, type a long line into the name field`, { source: "text" });
  await sleep(4500); // the helper starts, the window is read, typing begins (it takes about 20 seconds to type 1200 characters)
  const t0 = Date.now();
  const stop = await click("noah:stop");
  check(stop.ok === true && stop.mission === true, "the Stop button reports that it stopped a desktop task", JSON.stringify(stop));
  const out3 = await done;
  const stoppedIn = Date.now() - t0;
  check(out3.status === "cancelled", "the task ended as cancelled", out3.status);
  await sleep(500);
  const typed = (await nameValue()) || "";
  check(typed.length > 0 && typed.length < 1200, "typing stopped part-way, at once (not after the whole line)", `${typed.length} of 1200 characters in ${stoppedIn} ms`);
  const typedAfter = typed;
  await sleep(1500);
  check(((await nameValue()) || "").length === typedAfter.length, "and nothing more was typed afterwards", `${typedAfter.length} then ${((await nameValue()) || "").length}`);
  check(/Stopped\./.test(out3.text), "the message says it stopped", out3.text.slice(0, 60));

  // ---- 4. after a stop the helper starts fresh and a new task works
  events.length = 0; brain.scenario = "greet"; brain.n = 0;
  done = ended();
  noah.commandRouter.route(`in the window titled Noah Fixture ${token}, fill in the name field with Ada, then press Greet`, { source: "text" });
  const out4 = await done;
  check(out4.status === "succeeded" && (await label()) === "Hello Ada", "a new desktop task works after a Stop (the helper started fresh)", `${out4.status} / ${await label()}`);

  // ---- 5. the user's own brake: a REAL Ctrl+Alt+X, pressed while Noah is typing into the application, stops it at once
  events.length = 0; brain.scenario = "typing"; brain.n = 0;
  await probe.setText(((await probe.tree(fixWin.window)).nodes.find((x) => x.name === "Name field")).element, "");
  done = ended();
  noah.commandRouter.route(`in the window titled Noah Fixture ${token}, type a long line into the name field`, { source: "text" });
  await until(() => (barSeen > 0 && pill()), 20_000).catch(() => {});
  await sleep(4500);
  const typingStarted = ((await nameValue()) || "").length > 0;
  check(typingStarted && !!pill() && globalShortcut.isRegistered("Control+Alt+X"), "set-up: Noah is typing, the bar is up and the shortcut is armed", `${((await nameValue()) || "").length} characters so far`);
  const t1 = Date.now();
  const chord = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "Noah", "test", "fixtures", "real-input.ps1"), "-Op", "chord", "-Keys", "ctrl,alt,x"], { windowsHide: true, encoding: "utf8" });
  check(chord.status === 0 && /pressed/.test(chord.stdout || ""), "a real Ctrl+Alt+X was pressed through Windows");
  const out5 = await Promise.race([done, sleep(8000).then(() => null)]);
  const stoppedIn2 = Date.now() - t1;
  check(!!out5 && out5.status === "cancelled", "the shortcut stopped the desktop task", out5 ? out5.status : "it did not stop within 8 s");
  if (!out5) { noah.missions.stop(); await done; }
  await sleep(500);
  const typed2 = ((await nameValue()) || "").length;
  check(typed2 > 0 && typed2 < 1200, "typing stopped part-way", `${typed2} of 1200 characters in ${stoppedIn2} ms`);
  await sleep(1500);
  check(((await nameValue()) || "").length === typed2, "and nothing more was typed afterwards", `${typed2} then ${((await nameValue()) || "").length}`);
  check(!pill() && !globalShortcut.isRegistered("Control+Alt+X"), "the bar went and the shortcut was released");

  // ---- 6. a window of a terminal program is off-limits to act on: nothing is clicked, and the user is not even asked
  events.length = 0; brain.scenario = "terminal"; brain.n = 0; cards.length = 0;
  const unsub2 = answerCards(true);
  done = ended();
  noah.commandRouter.route(`in the window titled Noah Fixture ${token2}, press Greet`, { source: "text" });
  const out6 = await done;
  unsub2();
  check((await shellLabel()) === "(nothing yet)", "nothing was pressed in the terminal program's window", String(await shellLabel()));
  check(cards.length === 0, "it was refused outright: the user was not asked to approve it", `${cards.length} cards`);
  check(activity().includes("Could not click"), "and the Activity view shows the refusal", activity().join(" | ").slice(0, 160));
  check(out6.status !== "succeeded", "and the task did not claim success", out6.status);

  clearInterval(watcher);
  const bridge = noah.missions.desktopBridge();
  noah.missions.dispose();
  check(!bridge.running, "closing the app leaves no helper running", String(bridge.running));

  noah.dispose();
  probe.dispose();
  server.close();
  for (const p of [fixture, shellFixture]) { try { spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch (_) { /* gone */ } }
  await sleep(300);
  try { fs.rmSync(hostExe, { force: true }); } catch (_) { /* a leftover temp file is harmless */ }
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`RESULT desktop-mission ${failures ? "FAIL" : "ok"}`);
  app.exit(failures ? 1 : 0);
}

async function driver() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "noah-dmc-ud-"));
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const child = spawn(electronPath, [`--user-data-dir=${tmp}`, __filename, ...process.argv.slice(2)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let err = "";
  child.stdout.on("data", (x) => process.stdout.write(x));
  child.stderr.on("data", (x) => { err += x; });
  const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 240_000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* a leftover temp folder is harmless */ }
  if (code === -99) console.log("FAIL  timed out");
  else if (code !== 0 && err.trim()) console.log(err.split(/\r?\n/).filter((l) => l.trim() && !/ERROR:(gpu|network)/.test(l)).slice(0, 12).join("\n"));
  process.exit(code === 0 ? 0 : 1);
}

if (IS_ELECTRON) require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e && e.stack); require("electron").app.exit(2); }));
else driver().catch((e) => { console.error(e); process.exit(2); });
