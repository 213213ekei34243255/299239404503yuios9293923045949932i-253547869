// Noah/bench/integration/panel-activity-check.cjs
//
// Does the REAL panel (ai-panel.html, in real Electron) show what a project task is doing? Real events from a real mission (real tools and
// real processes on a throwaway project) are posted to the panel exactly the way the app posts them (`noah:event` messages), then the page's
// actual DOM is read back.
//
// The model here is a SCRIPTED sequence of tool calls: this checks the panel and the event stream, NOT that any model can drive a mission
// (run-mission-live.cjs does that). No network, no sign-in, nothing is sent anywhere.
//
//   node Noah/bench/integration/panel-activity-check.cjs [--shot=<png path>]
//
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const IS_ELECTRON = !!(process.versions && process.versions.electron);
const arg = (name, dflt) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, what, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${extra ? `  -> ${extra}` : ""}`); if (!ok) failures++; };

async function runner() {
  const { app, BrowserWindow } = require("electron");
  const { createMission } = require(path.join(ROOT, "Noah", "autonomy", "mission-runner.cjs"));

  const win = new BrowserWindow({ width: 470, height: 800, show: true, webPreferences: { contextIsolation: true, sandbox: true } });
  const pageErrors = [];
  win.webContents.on("console-message", (_e, level, message) => { if (level >= 3) pageErrors.push(message); });
  await win.loadFile(path.join(ROOT, "ai-panel.html"));
  const js = (code) => win.webContents.executeJavaScript(code);
  const post = (evt) => js(`window.postMessage({ type: "noah:event", payload: ${JSON.stringify(evt)} }, "*")`);
  const settle = () => new Promise((r) => setTimeout(r, 120));
  const dom = () => js(`(() => ({
    hidden: document.getElementById("noahActivity").hidden,
    open: document.getElementById("noahActivity").open,
    title: document.getElementById("noahActivityTitle").textContent,
    heads: [...document.querySelectorAll("#noahActivityLog .act-head")].map((h) => h.textContent),
    rows: [...document.querySelectorAll("#noahActivityLog .act-row")].map((r) => ({ text: r.querySelector(".act-text").textContent, detail: r.querySelector(".act-detail").textContent, level: r.dataset.level, pending: r.classList.contains("pending"), icon: r.querySelector(".act-icon").textContent })),
    chat: document.querySelectorAll("#chat .msg").length,
    imgs: document.querySelectorAll("#noahActivityLog img, #noahActivityLog script").length,
    pwned: typeof window.__pwned,
  }))()`);

  // ---- 1. a real mission on a real broken project; its real events go to the real panel, in order
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "noah-panel-"));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true }); fs.writeFileSync(path.join(project, rel), text); };
  put("package.json", JSON.stringify({ name: "demo", version: "1.0.0", scripts: { test: "node --test" } }));
  put("src/index.js", "const { add } = require('./util');\nmodule.exports = { add };\n");
  put("src/utils.js", "exports.add = (a, b) => a + b;\n");
  put("test/index.test.js", 'const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../src/index.js");\ntest("adds", () => assert.equal(add(2, 3), 5));\n');
  const root = fs.realpathSync.native(project);

  const before = await dom();
  check(before.hidden === true, "the Activity view is hidden until a project task starts");
  const chatBefore = before.chat;

  const script = [
    [["criteria_add", { criteria: [{ kind: "command", cmd: "node --test", description: "the project's tests pass" }] }], ["plan_set", { steps: ["run the tests", "find the cause", "fix it", "run the tests again"] }]],
    [["shell_run", { cmd: "node --test" }]],
    [["fs_edit", { path: "src/index.js", find: "'./util'", replace: "'./utils'" }]], // refused: never read
    [["fs_read", { path: "src/index.js" }]],
    [["fs_edit", { path: "src/index.js", find: "'./util'", replace: "'./utils'" }]],
    [["shell_run", { cmd: "node --test" }]],
    [["finish", { summary: "Fixed the import." }]],
  ];
  let i = 0;
  const callModel = async () => { const r = script[i++]; if (!r) throw new Error("script ran out"); return { text: "", toolCalls: r.map(([name, args]) => ({ name, args })), usage: { inputTokens: 1, outputTokens: 1 } }; };
  let queue = Promise.resolve();
  const bus = { publish: (event, payload) => { queue = queue.then(() => post({ event, ...payload })); } };
  const mission = createMission({ objective: "fix the failing test", roots: [root], callModel, bus, mode: "autonomous", confirm: async () => false, limits: { maxIterations: 12 } });
  const outcome = await mission.run();
  await queue;
  await settle();
  check(outcome.status === "succeeded", "the scripted mission itself succeeded on the real project", outcome.status);

  const d = await dom();
  const texts = d.rows.map((r) => r.text);
  check(!d.hidden && d.open, "the Activity view appeared and is open");
  check(/^Activity · \d+ actions$/.test(d.title), "its title counts the actions", d.title);
  check(texts.includes("Decided how success will be checked"), "shows how success will be checked");
  check(texts.includes("Made a plan (4 steps)"), "shows the plan");
  check(texts.some((t) => /^Ran node --test: failed \(exit 1\)/.test(t)), "shows the failing test run with its exit code");
  const fail = d.rows.find((r) => /failed \(exit 1\)/.test(r.text));
  check(fail && /cannot find the file "\.\/util" \(required from src\/index\.js\)$/.test(fail.detail) && fail.level === "fail" && fail.icon === "x", "and WHY it failed (the real diagnosis, naming the file once), in the failure style", fail && fail.detail);
  const refused = d.rows.find((r) => r.text === "Could not edit src/index.js");
  check(refused && refused.level === "refused" && refused.icon === "!" && /Read src\/index\.js in full/.test(refused.detail), "shows the refused blind edit and the rule behind it", refused && refused.detail);
  check(texts.includes("Read src/index.js (2 lines)"), "shows the file it read");
  const edit = d.rows.find((r) => /^Edited src\/index\.js/.test(r.text));
  check(edit && edit.detail === "− './util'\n+ './utils'", "shows the edit, before and after", edit && JSON.stringify(edit.detail));
  check(texts.some((t) => /^Ran node --test: passed/.test(t)), "shows the passing run");
  check(texts.includes("Finished: every check passed"), "shows the finish");
  check(d.rows.filter((r) => r.pending).length === 0, "no 'Running…' line is left behind: each was replaced by its outcome");
  check(d.rows.filter((r) => /^Running /.test(r.text)).length === 0, "no stale 'Running…' text");
  check(d.heads.length >= 6 && d.heads[0] === "Step 1" && d.heads[1] === "Step 2", "steps are numbered, with no misleading phase label", d.heads.slice(0, 3).join(" | "));
  check(d.rows[d.rows.length - 1].text === "Finished: every check passed", "the last line says how it ended", d.rows[d.rows.length - 1].text);
  check(d.rows.filter((r) => /^Finished/.test(r.text)).length === 1, "and it is said once, not twice", d.rows.filter((r) => /^Finished/.test(r.text)).map((r) => r.text).join(" | "));
  check(d.chat === chatBefore, "the chat got NO messages from the activity (no spam)", `${chatBefore} -> ${d.chat}`);
  check(fs.readFileSync(path.join(root, "src", "index.js"), "utf8").includes("'./utils'"), "and the real file really was fixed");

  const shot = arg("shot", "");
  if (shot) { await settle(); fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG()); console.log("screenshot:", shot); }

  // ---- 2. a pending line is replaced in place, and counted once
  await post({ event: "mission_started", missionId: "x", objective: "o", resumed: false });
  await settle();
  const fresh = await dom();
  check(fresh.rows.length === 0 && fresh.title === "Activity", "a NEW task starts a clean list");
  await post({ event: "mission_activity", id: "1.0", iteration: 1, phase: "act", phaseText: "Making changes", kind: "run", level: "info", ok: true, text: "Running npm install…", detail: "", pending: true });
  await settle();
  let p = await dom();
  check(p.rows.length === 1 && p.rows[0].pending && p.title === "Activity", "a command shows as running, and is not yet counted", JSON.stringify(p.rows[0]));
  await post({ event: "mission_activity", id: "1.0", iteration: 1, phase: "act", phaseText: "Making changes", kind: "run", level: "ok", ok: true, text: "Ran npm install: passed in 4.1s", detail: "", pending: false });
  await settle();
  p = await dom();
  check(p.rows.length === 1 && !p.rows[0].pending && p.rows[0].text === "Ran npm install: passed in 4.1s" && p.title === "Activity · 1 action", "the same line becomes its outcome in place and is counted once", JSON.stringify(p.rows[0]) + " " + p.title);

  // ---- 3. continuing a paused task keeps what is already there
  await post({ event: "mission_started", missionId: "x", objective: "o", resumed: true });
  await settle();
  p = await dom();
  check(p.rows.length === 1 && p.heads.includes("Continuing"), "continuing a task keeps the earlier lines and marks where it carried on", p.heads.join(" | "));
  check(p.heads[0] === "Step 1", "(the step header)", p.heads.join(" | "));

  // an ending that is NOT a success is always shown, even right after another line
  await post({ event: "mission_finished", missionId: "x", status: "budget_paused" });
  await settle();
  p = await dom();
  check(p.rows[p.rows.length - 1].text === "Paused: say “continue” to carry on", "a pause is shown as the last line", p.rows[p.rows.length - 1].text);
  // ... even when the line before it is a finish line (only a SUCCESS right after "Finished: every check passed" is a duplicate)
  await post({ event: "mission_activity", id: "5.0", iteration: 5, phase: "verify", phaseText: "x", kind: "finish", level: "ok", ok: true, text: "Finished: every check passed", detail: "", pending: false });
  await post({ event: "mission_finished", missionId: "x", status: "budget_paused" });
  await settle();
  p = await dom();
  check(p.rows[p.rows.length - 1].text === "Paused: say “continue” to carry on", "a pause right after a finish line is still shown", p.rows[p.rows.length - 1].text);
  // ... and an unfinished 'finish' (refused) followed by a success is not mistaken for the duplicate
  await post({ event: "mission_activity", id: "6.0", iteration: 6, phase: "verify", phaseText: "x", kind: "finish", level: "refused", ok: false, text: "Not finished yet: the checks do not all pass", detail: "", pending: false });
  await post({ event: "mission_finished", missionId: "x", status: "succeeded" });
  await settle();
  p = await dom();
  check(p.rows[p.rows.length - 1].text === "Finished and checked", "a success after a REFUSED finish is still announced", p.rows[p.rows.length - 1].text);

  // ---- 4. hostile text from a project can never become markup or run
  await post({ event: "mission_activity", id: "2.0", iteration: 2, phase: "act", phaseText: "x", kind: "read", level: "ok", ok: true, text: '<img src=x onerror="window.__pwned=1">Read <b>evil</b>.js', detail: '<script>window.__pwned=1</script>', pending: false });
  await settle();
  p = await dom();
  const evil = p.rows.find((r) => /evil/.test(r.text));
  check(p.imgs === 0 && p.pwned === "undefined", "hostile text creates no element and runs nothing", `elements=${p.imgs} pwned=${p.pwned}`);
  check(evil && evil.text.includes("<img src=x") && evil.detail.includes("<script>"), "it is shown as plain text");

  // ---- 5. a very long task does not grow the page without bound
  for (let n = 0; n < 450; n++) await post({ event: "mission_activity", id: `9.${n}`, iteration: 9, phase: "act", phaseText: "Making changes", kind: "read", level: "ok", ok: true, text: `Read file${n}.js`, detail: "", pending: false });
  await settle();
  const count = await js(`document.getElementById("noahActivityLog").children.length`);
  check(count <= 400, "the list is capped (the oldest lines are dropped)", String(count));

  // ---- 5b. the control buttons: Pause only while a task runs, Continue only when paused, Stop while running or paused; each sends its command
  await js(`window.__cmds = []; window.addEventListener("message", (e) => { if (e.data && e.data.type === "noah:cmd") window.__cmds.push(e.data.cmd); });`);
  const shown = async () => js(`({ pause: getComputedStyle(document.getElementById("noahPause")).display !== "none", stop: getComputedStyle(document.getElementById("noahStop")).display !== "none", resume: getComputedStyle(document.getElementById("noahResume")).display !== "none" })`);
  const state = async (s) => { await post({ event: "session_state", state: s, label: s, text: "Working on your project" }); await settle(); return shown(); };
  const same = (a, b) => a.pause === b.pause && a.stop === b.stop && a.resume === b.resume;
  const idle = await state("idle");
  check(same(idle, { pause: false, stop: false, resume: false }), "idle: no Pause, Stop or Continue button", JSON.stringify(idle));
  const running = await state("executing");
  check(same(running, { pause: true, stop: true, resume: false }), "while a task runs: Pause and Stop, no Continue", JSON.stringify(running));
  const shot2 = arg("shot2", "");
  if (shot2) {
    // a window that has not painted since its last change captures as empty: show it, wait for a frame, and try a few times
    win.show();
    for (let tries = 0; tries < 6; tries++) {
      await sleep(400);
      const png = (await win.webContents.capturePage()).toPNG();
      if (png.length > 2000) { fs.writeFileSync(shot2, png); console.log("screenshot:", shot2); break; }
    }
  }
  const planning = await state("planning");
  check(planning.pause === true && planning.stop === true, "while it is planning: Pause and Stop too", JSON.stringify(planning));
  await js(`document.getElementById("noahPause").click()`);
  const paused = await state("paused");
  check(same(paused, { pause: false, stop: true, resume: true }), "once paused: Continue and Stop replace Pause", JSON.stringify(paused));
  const waiting = await state("waiting_for_user");
  check(same(waiting, { pause: false, stop: true, resume: true }), "waiting for the user's answer: Continue and Stop", JSON.stringify(waiting));
  await js(`document.getElementById("noahResume").click(); document.getElementById("noahStop").click();`);
  const cmds = await js(`window.__cmds`);
  check(JSON.stringify(cmds) === JSON.stringify(["pause", "resume", "stop"]), "each button sends its own command to the app, once", JSON.stringify(cmds));
  const done = await state("completed");
  check(same(done, { pause: false, stop: false, resume: false }), "when the task is done the buttons go away", JSON.stringify(done));
  const err = await state("error");
  check(same(err, { pause: false, stop: false, resume: false }), "after an error too", JSON.stringify(err));
  const title = await js(`document.getElementById("noahPause").title`);
  check(/Pauses Noah and keeps its progress/.test(title), "the Pause button explains itself", title);

  // ---- 5c. THE ANSWER: a finished task's final message is in the chat. (It used to appear only as "Finished" in the Activity log: a real "check WhatsApp for
  // unseen messages" did the work and the answer itself was nowhere to be read.)
  const chatMsgs = () => js(`[...document.querySelectorAll("#chat .msg.ai")].map((m) => m.textContent)`);
  const n0 = (await chatMsgs()).length;
  await post({ event: "mission_result", missionId: "x", status: "succeeded", resumable: false, text: "You have 1 unseen message.\n\n- From: Sunil\n- Text: Hey\n\nWhat Noah checked itself:\nPASS      the page loaded" });
  await settle();
  let msgs = await chatMsgs();
  check(msgs.length === n0 + 1 && /1 unseen message/.test(msgs[msgs.length - 1]) && /From: Sunil/.test(msgs[msgs.length - 1]) && /What Noah checked itself/.test(msgs[msgs.length - 1]), "a finished task's final message (the answer, then what was checked) appears in the chat", JSON.stringify(msgs.slice(-1)).slice(0, 160));
  await post({ event: "mission_result", missionId: "x", status: "cancelled", resumable: false, text: "Stopped." });
  await settle();
  check((await chatMsgs()).length === n0 + 1, "a plain Stop adds no message (the status line already says it)");
  await post({ event: "mission_result", missionId: "x", status: "cancelled", resumable: false, text: "No folder was chosen, so I did not start." });
  await settle();
  msgs = await chatMsgs();
  check(msgs.length === n0 + 2 && /No folder was chosen/.test(msgs[msgs.length - 1]), "a cancelled task that has something to say still says it");
  await post({ event: "mission_result", missionId: "x", status: "blocked", resumable: true, text: "Which folder should I use?" });
  await settle();
  msgs = await chatMsgs();
  check(/^Which folder/.test(msgs[msgs.length - 1]), "a question from the task is shown as waiting for the user", msgs[msgs.length - 1]);
  await post({ event: "mission_result", missionId: "x", status: "impossible", resumable: false, text: "I could not do this: the file is missing." });
  await settle();
  msgs = await chatMsgs();
  check(/^I could not do this/.test(msgs[msgs.length - 1]), "a task that could not be done says so plainly", msgs[msgs.length - 1]);
  const n1 = (await chatMsgs()).length;
  await post({ event: "mission_result", missionId: "x", status: "succeeded", resumable: false, text: "" });
  await settle();
  check((await chatMsgs()).length === n1, "an empty result adds no empty bubble");
  await post({ event: "mission_result", missionId: "x", status: "succeeded", resumable: false, text: '<img src=x onerror="window.__pwned2=1"><script>window.__pwned2=1</script> sent you a link' });
  await settle();
  const hostile = await js(`(() => ({ imgs: document.querySelectorAll("#chat img, #chat script").length, pwned: typeof window.__pwned2, last: [...document.querySelectorAll("#chat .msg.ai")].pop().textContent }))()`);
  check(hostile.imgs === 0 && hostile.pwned === "undefined" && /sent you a link/.test(hostile.last), "text from a page or file in the answer can never become markup or run", JSON.stringify(hostile).slice(0, 160));

  // ---- 5d. the four modes: Auto, Chat, Web agent, Computer agent (two separate agents, so they are never mixed up)
  const MODE_BUTTONS = `[...document.querySelectorAll("#modeSwitch button")].map((b) => [b.dataset.mode, b.textContent.trim(), b.getAttribute("aria-checked")])`;
  const sameJson = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  let modes = await js(MODE_BUTTONS);
  check(sameJson(modes.map((m) => m.slice(0, 2)), [["auto", "Auto"], ["chat", "Chat"], ["web", "Web agent"], ["computer", "Computer agent"]]), "the switch offers Auto, Chat, Web agent and Computer agent (no plain 'Agent')", JSON.stringify(modes.map((m) => m[1])));
  check(modes[0][2] === "true" && modes.slice(1).every((m) => m[2] === "false"), "Auto is selected to begin with");
  await js(`window.__sent = []; window.addEventListener("message", (e) => { if (e.data && e.data.type === "rexy:submit-goal") window.__sent.push({ goal: e.data.goal, mode: e.data.mode }); });`);
  for (const [mode, hint, placeholder] of [["web", "Browser tasks", /on the web/], ["computer", "Computer tasks", /on your computer/], ["chat", "Talk only", /Chat with Noah/], ["auto", "Noah decides", /Type your message/]]) {
    await js(`document.querySelector('#modeSwitch button[data-mode="${mode}"]').click()`);
    const now = await js(`({ checked: ${MODE_BUTTONS}.filter((m) => m[2] === "true").map((m) => m[0]), hint: document.getElementById("modeHint").textContent, placeholder: document.getElementById("input").placeholder, saved: localStorage.getItem("noah_chat_mode") })`);
    check(sameJson(now.checked, [mode]) && now.hint === hint && placeholder.test(now.placeholder) && now.saved === mode, `choosing ${mode}: only it is selected, the hint says "${hint}", the box says what to type, and the choice is remembered`, JSON.stringify(now).slice(0, 170));
  }
  for (const mode of ["web", "computer", "chat", "auto"]) {
    await js(`document.querySelector('#modeSwitch button[data-mode="${mode}"]').click(); document.getElementById("input").value = "hello from ${mode}"; sendMessage();`);
    await settle();
  }
  const sent = await js("window.__sent");
  check(sameJson(sent.map((m) => m.mode), ["web", "computer", "chat", "auto"]) && sent.every((m) => m.goal === `hello from ${m.mode}`), "each message is sent to the app with the mode that was selected when it was sent", JSON.stringify(sent));
  await js(`localStorage.setItem("noah_chat_mode", "agent")`);
  await win.webContents.reload();
  await new Promise((r) => setTimeout(r, 800));
  modes = await js(MODE_BUTTONS);
  check(modes.find((m) => m[0] === "web")[2] === "true" && modes.filter((m) => m[2] === "true").length === 1, "an old saved 'agent' choice comes back as Web agent (it was the browser agent)", JSON.stringify(modes.map((m) => m[2])));
  await js(`localStorage.setItem("noah_chat_mode", "nonsense")`);
  await win.webContents.reload();
  await new Promise((r) => setTimeout(r, 800));
  modes = await js(MODE_BUTTONS);
  check(modes[0][2] === "true" && modes.filter((m) => m[2] === "true").length === 1, "an unknown saved choice falls back to Auto");
  const wide = await js(`(() => { const sw = document.getElementById("modeSwitch"); return { overflowX: sw.scrollWidth > sw.clientWidth + 1, buttons: [...sw.querySelectorAll("button")].every((b) => b.getBoundingClientRect().right <= sw.getBoundingClientRect().right + 1) }; })()`);
  check(wide.buttons, "all four buttons fit inside the panel (they wrap rather than run off the edge)", JSON.stringify(wide));

  // ---- 6. nothing in the page broke
  check(pageErrors.length === 0, "no errors in the page console", pageErrors.slice(0, 3).join(" | "));

  fs.rmSync(project, { recursive: true, force: true });
  console.log(`RESULT panel-activity ${failures ? "FAIL" : "ok"}`);
  app.exit(failures ? 1 : 0);
}

async function driver() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "noah-panel-ud-"));
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
