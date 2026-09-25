// Probe: what kind of editor does online-python.com use, how does it look to the accessibility tree, and which way of
// entering multi-line code (key by key vs one insert) leaves the code intact?
const { app, BrowserWindow } = require("electron");
const os = require("os");
const path = require("path");
app.setPath("userData", require("fs").mkdtempSync(path.join(os.tmpdir(), "ed-probe-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODE = "def is_palindrome(n):\n    s = str(n)\n    return s == s[::-1]\n\nfor i in range(3):\n    print(i, is_palindrome(i))\n";

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, x: -1800, y: 0, width: 1300, height: 900, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents;
  const ev = (js) => wc.executeJavaScript(js, true);
  await wc.loadURL("https://www.online-python.com/").catch((e) => console.log("load error", e.message));
  await sleep(7000);
  console.log("URL", wc.getURL(), "TITLE", wc.getTitle());
  const survey = await ev(`(() => {
    const out = [];
    const sel = 'textarea, [contenteditable], .cm-content, .CodeMirror, .ace_editor, .monaco-editor, [role=textbox]';
    for (const e of document.querySelectorAll(sel)) {
      const r = e.getBoundingClientRect();
      out.push({ tag: e.tagName, cls: String(e.className).slice(0, 60), id: e.id, role: e.getAttribute('role'), label: e.getAttribute('aria-label'), ce: e.getAttribute('contenteditable'), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), vis: getComputedStyle(e).visibility });
    }
    return { out, libs: { CodeMirror: typeof CodeMirror, ace: typeof ace, monaco: typeof monaco } };
  })()`);
  console.log("SURVEY", JSON.stringify(survey, null, 1).slice(0, 3500));

  // AX view: textbox-ish nodes
  wc.debugger.attach("1.3");
  await wc.debugger.sendCommand("Accessibility.enable");
  const ax = await wc.debugger.sendCommand("Accessibility.getFullAXTree");
  const boxes = ax.nodes.filter((n) => n.role && /textbox|document|textarea|code|editor/i.test(n.role.value)).map((n) => ({ role: n.role.value, name: n.name && n.name.value, backend: n.backendDOMNodeId }));
  console.log("AX textbox-like nodes", JSON.stringify(boxes).slice(0, 800));

  // find the visible editor surface and click into it
  const target = await ev(`(() => {
    const c = document.querySelector('.cm-content, .CodeMirror-scroll, .ace_content, .monaco-editor .view-lines, .CodeMirror, .ace_editor');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.x + Math.min(r.width / 2, 300)), y: Math.round(r.y + Math.min(r.height / 2, 60)), tag: c.className };
  })()`);
  console.log("CLICK TARGET", JSON.stringify(target));
  if (target) {
    for (const t of ["mousePressed", "mouseReleased"]) await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: t, x: target.x, y: target.y, button: "left", clickCount: 1 });
    await sleep(500);
    const focus = await ev(`(() => { const a = document.activeElement; return { tag: a.tagName, cls: String(a.className).slice(0,50), role: a.getAttribute('role'), label: a.getAttribute('aria-label') }; })()`);
    console.log("ACTIVE ELEMENT AFTER CLICK", JSON.stringify(focus));

    const read = () => ev(`(() => {
      try { if (window.monaco) return monaco.editor.getEditors()[0].getValue(); } catch (e) {}
      try { const cm = document.querySelector('.CodeMirror'); if (cm && cm.CodeMirror) return cm.CodeMirror.getValue(); } catch (e) {}
      try { const a = document.querySelector('.ace_editor'); if (a && window.ace) return ace.edit(a).getValue(); } catch (e) {}
      const c = document.querySelector('.cm-content'); if (c) return c.innerText;
      return null;
    })()`);
    // A: key by key, exactly like Noah's human typing
    for (const ch of CODE) {
      if (ch === "\n") { await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "char", text: "\r", key: "Enter" }); await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); }
      else { await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch }); await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: ch }); }
    }
    await sleep(500);
    const a = await read();
    console.log("A key-by-key ->", JSON.stringify(a), "\n   identical:", a === CODE);
    // B: select all, one insert
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await sleep(300);
    await wc.debugger.sendCommand("Input.insertText", { text: CODE });
    await sleep(500);
    const b = await read();
    console.log("B insertText ->", JSON.stringify(b), "\n   identical:", b === CODE);
  }
  console.log("DONE");
  app.exit(0);
});
