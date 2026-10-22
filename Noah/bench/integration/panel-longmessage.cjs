// Noah/bench/integration/panel-longmessage.cjs - the assistant panel's message box keeps a long, multi-line message WHOLE (it used to be a one-line <input>, which silently turned every
// line break into nothing). Runs the real ai-panel.html in a HIDDEN window (nothing appears on screen):   npx electron Noah/bench/integration/panel-longmessage.cjs
"use strict";
const { app, BrowserWindow } = require("electron");
const path = require("path");

const fail = (m) => { console.error("FAIL:", m); app.exit(1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 520, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, "..", "..", "..", "ai-panel.html"));
  const js = (code) => win.webContents.executeJavaScript(code);

  const lines = Array.from({ length: 1500 }, (_, i) => `Question ${i + 1}: what is ${i + 1} plus 100?`);
  const big = lines.join("\n"); // ~50k characters, 1500 lines
  const kind = await js(`document.getElementById("input").tagName`);
  if (kind !== "TEXTAREA") return fail("the message box is a " + kind);

  // 1) a paste: the browser inserts the text into the field (insertText is what a paste does); every character and line break must stay
  await js(`document.getElementById("input").focus()`);
  win.webContents.insertText(big);
  await wait(300);
  const state = await js(`(() => { const i = document.getElementById("input"); return { len: i.value.length, lines: i.value.split("\\n").length, h: i.getBoundingClientRect().height, same: i.value === ${JSON.stringify(big)} }; })()`);
  console.log("pasted", big.length, "chars /", lines.length, "lines ->", JSON.stringify(state));
  if (!state.same) return fail("the pasted text changed (" + state.len + " characters kept of " + big.length + ")");
  if (state.h > 175) return fail("the box grew past its maximum height: " + state.h);

  // 2) Shift+Enter is a new line and sends nothing; plain Enter sends the whole message once and empties + shrinks the box
  await js(`window.__sent = []; window.addEventListener("message", (e) => { if (e.data && e.data.type === "rexy:submit-goal") window.__sent.push(e.data.goal); }); true`);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return", modifiers: ["shift"] });
  win.webContents.sendInputEvent({ type: "char", keyCode: "Return", modifiers: ["shift"] });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return", modifiers: ["shift"] });
  await wait(200);
  const afterShift = await js(`({ sent: window.__sent.length, endsWithNewline: document.getElementById("input").value.endsWith("\\n") })`);
  console.log("after Shift+Enter:", JSON.stringify(afterShift));
  if (afterShift.sent !== 0 || !afterShift.endsWithNewline) return fail("Shift+Enter must add a line break and send nothing");

  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  await wait(400);
  const sent = await js(`({ n: window.__sent.length, len: window.__sent[0] ? window.__sent[0].length : 0, same: window.__sent[0] === ${JSON.stringify(big)}, left: document.getElementById("input").value.length, h: document.getElementById("input").getBoundingClientRect().height })`);
  console.log("after Enter:", JSON.stringify(sent));
  if (sent.n !== 1) return fail("expected exactly one submit, got " + sent.n);
  if (!sent.same) return fail("the message that was sent differs from what was typed (" + sent.len + " of " + big.length + " characters)");
  if (sent.left !== 0 || sent.h > 60) return fail("the box was not emptied and shrunk after sending");

  console.log("PASS: a 50k-character, 1500-line message is kept whole in the box and sent whole, once.");
  app.exit(0);
}).catch((e) => fail(String(e && e.stack || e)));
