// Noah/bench/integration/panel-toast-check.cjs
//
// Does the REAL panel (ai-panel.html, in real Electron) show the notice a Computer-agent use on a Mac sends (`mission_toast`), and does it go away by itself?
// The window is HIDDEN (show: false) and is never put on the user's screen. Events are posted exactly the way the app posts them (`noah:event` messages) and
// the page's real DOM is read back. Nothing is sent anywhere.
//
//   node Noah/bench/integration/panel-toast-check.cjs
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const IS_ELECTRON = !!(process.versions && process.versions.electron);
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, what, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${extra ? `  -> ${extra}` : ""}`); if (!ok) failures++; };
const NOTICE = "Computer Agent does not work on Apple macOS yet. For now it can only open apps.";

async function runner() {
  const { app, BrowserWindow } = require("electron");
  const win = new BrowserWindow({ width: 470, height: 800, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const pageErrors = [];
  win.webContents.on("console-message", (_e, level, message) => { if (level >= 3) pageErrors.push(message); });
  await win.loadFile(path.join(ROOT, "ai-panel.html"));
  const js = (code) => win.webContents.executeJavaScript(code);
  const post = (evt) => js(`window.postMessage({ type: "noah:event", payload: ${JSON.stringify(evt)} }, "*")`);
  const toast = () => js(`(() => { const t = document.getElementById("noahToast"); return { hidden: t.hidden, shown: t.classList.contains("show"), text: t.querySelector(".noah-toast-text").textContent, html: t.querySelector(".noah-toast-text").innerHTML, chatMsgs: document.querySelectorAll("#chat .msg").length }; })()`);

  const before = await toast();
  check(before.hidden === true, "no notice until a Computer-agent use sends one");

  await post({ event: "mission_toast", text: NOTICE, ms: 3000 });
  await sleep(250);
  const shown = await toast();
  check(shown.hidden === false && shown.shown === true && shown.text === NOTICE, "the notice is visible with the exact words", JSON.stringify(shown));
  check(shown.chatMsgs === before.chatMsgs, "and it is not a chat message", `${before.chatMsgs} -> ${shown.chatMsgs}`);

  await sleep(3600); // 3 s + the fade
  const gone = await toast();
  check(gone.hidden === true && gone.shown === false, "after a few seconds it goes away by itself", JSON.stringify(gone));

  await post({ event: "mission_toast", text: NOTICE, ms: 3000 });
  await sleep(250);
  check((await toast()).hidden === false, "the next use shows it again (every use, not once)");
  await js(`document.getElementById("noahToast").click()`);
  await sleep(450);
  check((await toast()).hidden === true, "a click dismisses it at once");

  await post({ event: "mission_toast", text: "first", ms: 3000 });
  await sleep(100);
  await post({ event: "mission_toast", text: "second", ms: 3000 });
  await sleep(2000); // the first one's own timer would have fired by now if it were still running (it must not hide the second early)
  await post({ event: "mission_toast", text: "third", ms: 3000 });
  await sleep(1300);
  const third = await toast();
  check(third.hidden === false && third.text === "third", "a newer notice replaces the older one, and the older one's timer does not hide it", JSON.stringify(third));
  await sleep(3000);
  check((await toast()).hidden === true, "and it goes away too");

  await post({ event: "mission_toast", text: "<img src=x onerror=\"window.__pwned=1\"><b>bold</b>", ms: 3000 });
  await sleep(250);
  const html = await toast();
  check(html.text.includes("<img") && !html.html.includes("<img") && (await js(`window.__pwned`)) === undefined, "text is shown as text: markup in it does nothing", html.html);
  await post({ event: "mission_toast", text: "   ", ms: 3000 });
  await post({ event: "mission_toast" });
  await sleep(200);
  check((await toast()).text.startsWith("<img"), "an empty notice changes nothing");

  check(pageErrors.length === 0, "no page errors", pageErrors.slice(0, 3).join(" | "));
  console.log(`RESULT panel-toast ${failures ? "FAIL" : "ok"}`);
  app.exit(failures ? 1 : 0);
}

async function driver() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "noah-toast-ud-"));
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const child = spawn(electronPath, [`--user-data-dir=${tmp}`, __filename], { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let err = "";
  child.stdout.on("data", (x) => process.stdout.write(x));
  child.stderr.on("data", (x) => { err += x; });
  const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 90_000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (code === -99) console.log("FAIL  timed out");
  else if (code !== 0 && /Error/.test(err)) console.log(err.split(/\r?\n/).filter((l) => /Error|at /.test(l)).slice(0, 8).join("\n"));
  process.exit(code === 0 ? 0 : 1);
}

if (IS_ELECTRON) {
  const { app } = require("electron");
  app.on("window-all-closed", () => {}); // a probe must not quit before it has printed its result
  app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e && e.stack); app.exit(2); }));
} else driver().catch((e) => { console.error(e); process.exit(2); });
