// Noah/bench/integration/desktop-mac-check.cjs
//
// RUN THIS ON A MAC (Intel or Apple silicon). It is the only thing that can show that the computer agent really works on macOS: the Mac helper (Noah/desktop/host-mac.js) was
// written on Windows and its macOS layer has never been run by its author. This drives the REAL helper through the same bridge Jonah uses, against TextEdit, and says for
// every step whether it worked. If a step fails, send the line that starts with FAIL (and the lines under it) to whoever maintains Jonah.
//
//   node Noah/bench/integration/desktop-mac-check.cjs
//
// Before the first run: System Settings > Privacy & Security > Accessibility: switch ON the app you run this from (Terminal, iTerm, VS Code ...). For the screenshot step also
// switch it on under Screen Recording; for typing, macOS will ask once to let that app control "System Events": allow it. A step that needs a permission you have not given
// says so and is reported as SKIP, not FAIL.
//
// DO NOT TOUCH THE KEYBOARD OR MOUSE WHILE IT RUNS (about 30 seconds): Noah is built to stop the moment you do, and the check would then report that, correctly, as a failure.
//
// It opens ONE TextEdit window, writes in it, and closes it again (the text is removed first, so TextEdit does not ask to save). It does not touch any other app.
"use strict";

const path = require("path");
const { DesktopBridge } = require("../../desktop/bridge.cjs");

if (process.platform !== "darwin") {
  console.log("This check is for macOS. (On Windows use Noah/bench/integration/desktop-mission-check.cjs.)");
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { pass: 0, fail: 0, skip: 0 };
const say = (kind, what, extra = "") => { results[kind.toLowerCase()]++; console.log(`${kind}  ${what}${extra ? `\n      -> ${extra}` : ""}`); };
const pass = (what, extra) => say("PASS", what, extra);
const fail = (what, extra) => say("FAIL", what, extra);
const skip = (what, extra) => say("SKIP", what, extra);
const needs = (err) => err && /accessibility_denied|screen_recording_denied|automation_denied/.test(String(err.code));

async function step(name, fn) {
  try { await fn(); } catch (err) {
    if (needs(err)) skip(name, `${err.code}: ${err.message}`);
    else fail(name, `${err && err.code ? `[${err.code}] ` : ""}${err && err.message}`);
  }
}

(async () => {
  const bridge = new DesktopBridge({ log: (m) => console.log(`   (log) ${m}`) });
  let editor = null, area = null;
  console.log(`Mac check - ${process.arch === "arm64" ? "Apple silicon" : process.arch === "x64" ? "Intel" : process.arch}, macOS ${require("os").release()} (Darwin), Node ${process.version}\n`);

  await step("the helper starts and answers", async () => {
    const r = await bridge.ping();
    if (r !== "pong") throw new Error(`answered ${JSON.stringify(r)} instead of "pong"`);
    pass("the helper starts and answers (osascript running host-mac.js)");
  });

  await step("the user's idle time can be read (this is how Noah waits until you stop using the computer)", async () => {
    const r = await bridge.userIdle();
    if (!Number.isFinite(r.idleMs) || r.idleMs < 0) throw new Error(`idleMs was ${JSON.stringify(r)}`);
    pass("user idle time is readable", `${Math.round(r.idleMs)} ms since you last touched the keyboard or mouse`);
  });

  await step("windows can be listed (needs Accessibility)", async () => {
    const list = await bridge.windows();
    if (!Array.isArray(list)) throw new Error("not a list");
    pass("windows can be listed", `${list.length} windows; in front: ${(list.find((w) => w.foreground) || {}).title || "(none)"} - ${(list.find((w) => w.foreground) || {}).process || ""}`);
    const bad = list.filter((w) => !Number.isSafeInteger(w.window) || !w.process);
    if (bad.length) fail("every window has a number and a program", JSON.stringify(bad[0]));
    else pass("every window has a number and a program");
  });

  await step("the list of installed apps includes TextEdit", async () => {
    const apps = await bridge.apps();
    const te = apps.find((a) => /^TextEdit$/i.test(a.name));
    if (!te) throw new Error(`TextEdit not found among ${apps.length} apps`);
    pass("the list of installed apps includes TextEdit", `${apps.length} apps; TextEdit is at ${te.id}`);
    editor = te.id;
  });

  let win = null;
  await step("TextEdit opens and its window is found", async () => {
    if (!editor) throw new Error("no TextEdit path from the previous step");
    await bridge.launch({ appId: editor });
    // a new TextEdit window may need a moment; "Open" panels also count as windows, so wait for a document window
    win = await bridge.waitWindow({ process: "TextEdit", waitMs: 15000 });
    pass("TextEdit opens and its window is found", `[${win.window}] "${win.title}"`);
  });

  if (win) {
    await step("the window can be brought to the front, and the window the user had is reported", async () => {
      const r = await bridge.focus(win.window);
      const front = (await bridge.windows()).find((w) => w.foreground);
      if (!front || front.window !== win.window) throw new Error(`front window is ${front ? `[${front.window}] ${front.title}` : "none"}`);
      pass("the window can be brought to the front", `previous window reported as: ${r.previous === null || r.previous === undefined ? "none" : r.previous}`);
    });

    await step("the window's controls can be read, and the text area found", async () => {
      const t = await bridge.tree(win.window, { maxDepth: 10, maxNodes: 300 });
      area = t.nodes.find((n) => n.type === "Edit" && n.actions.includes("value")) || t.nodes.find((n) => n.type === "Edit");
      if (!area) throw new Error(`no text area among ${t.nodes.length} controls: ${t.nodes.slice(0, 12).map((n) => `${n.type}:${n.name}`).join(", ")}`);
      pass("the window's controls can be read, and the text area found", `${t.nodes.length} controls; text area = ${area.element}`);
    });

    await step("the fast list of pressable controls works", async () => {
      const r = await bridge.interactive(win.window, { maxNodes: 80, budgetMs: 4000 });
      pass("the fast list of pressable controls works", `${r.nodes.length} controls${r.truncated ? " (cut at the limit)" : ""}: ${r.nodes.slice(0, 6).map((n) => `${n.type} "${n.name}"`).join(", ")}`);
    });

    await step("text can be put into the field directly (no keyboard)", async () => {
      if (!area) throw new Error("no text area");
      await bridge.setText(area.element, "Hello from Noah (direct)");
      const t = await bridge.tree(win.window, { maxDepth: 10, maxNodes: 300 });
      const now = t.nodes.find((n) => n.type === "Edit" && /Hello from Noah/.test(String(n.value || "")));
      if (!now) throw new Error(`the text area does not hold the text; it holds: ${JSON.stringify((t.nodes.find((n) => n.type === "Edit") || {}).value)}`);
      pass("text can be put into the field directly", JSON.stringify(now.value));
    });

    await step("typing works (needs the Automation permission for System Events)", async () => {
      await bridge.focus(win.window);
      await bridge.key(win.window, "cmd+a");
      const r = await bridge.type(win.window, "Typed by Noah, with a line break\nand a second line.");
      const t = await bridge.tree(win.window, { maxDepth: 10, maxNodes: 300 });
      const v = String((t.nodes.find((n) => n.type === "Edit" && /Typed by Noah/.test(String(n.value || ""))) || {}).value || "");
      if (!/Typed by Noah, with a line break\s*and a second line\./.test(v)) throw new Error(`typed ${r.typed} characters but the text area holds ${JSON.stringify(v.slice(0, 120))}`);
      pass("typing works", `${r.typed} characters typed; the area holds ${JSON.stringify(v.slice(0, 70))}`);
    });

    await step("a screenshot can be taken (needs Screen Recording)", async () => {
      const s = await bridge.screenshot({ window: win.window, maxWidth: 1000 });
      if (!(s.width > 0 && s.height > 0 && s.base64.length > 1000)) throw new Error(`odd picture: ${s.width}x${s.height}, ${s.base64.length} bytes`);
      if (!(s.scale > 0)) throw new Error(`scale ${s.scale}`);
      pass("a screenshot can be taken", `${s.width}x${s.height} px of a ${s.sourceWidth}x${s.sourceHeight} capture; scale ${s.scale.toFixed(2)} picture-px per point; window at (${s.x}, ${s.y})`);
    });

    await step("what is under a point is reported", async () => {
      const w = (await bridge.windows()).find((x) => x.window === win.window);
      const h = await bridge.elementAt(Math.round(w.x + w.w / 2), Math.round(w.y + w.h / 2));
      if (!h.found) throw new Error("nothing found in the middle of the TextEdit window");
      pass("what is under a point is reported", `${h.type} "${String(h.name).slice(0, 40)}"`);
    });

    await step("a click at a spot lands where it was sent (the pointer is checked)", async () => {
      await bridge.focus(win.window);
      const w = (await bridge.windows()).find((x) => x.window === win.window);
      const x = Math.round(w.x + w.w / 2), y = Math.round(w.y + w.h / 2);
      await bridge.click({ window: win.window, x, y });
      const c = await bridge.cursor();
      if (Math.abs(c.x - x) > 4 || Math.abs(c.y - y) > 4) throw new Error(`clicked at (${x}, ${y}) but the pointer is at (${c.x}, ${c.y})`);
      pass("a click at a spot lands where it was sent", `pointer is at (${c.x}, ${c.y}), asked for (${x}, ${y})`);
    });

    await step("a click on a spot covered by another window is refused", async () => {
      // the Finder's desktop is not a window of another program, so use the one sure case: a spot outside the window
      let refused = null;
      try { await bridge.click({ window: win.window, x: -50, y: -50 }); } catch (err) { refused = err; }
      if (!refused || refused.code !== "outside_window") throw new Error(`a click outside the window was not refused with outside_window (got ${refused ? refused.code : "no error"})`);
      pass("a click outside the window is refused", refused.message);
    });

    await step("what Noah itself did is not mistaken for you (idle time after Noah's own click)", async () => {
      const r = await bridge.userIdle();
      if (!(r.own === true && r.idleMs >= 3_000_000)) throw new Error(`after Noah's own click userIdle said ${JSON.stringify(r)}; expected own:true. If this FAILS, Noah would wait for you forever after each of its own actions.`);
      pass("Noah's own input is not counted as yours", JSON.stringify(r));
    });

    await step("the TextEdit window can be cleaned up and closed", async () => {
      await bridge.focus(win.window);
      await bridge.key(win.window, "cmd+a");
      await bridge.key(win.window, "backspace");
      const r = await bridge.closeWindow(win.window);
      await sleep(500);
      const still = (await bridge.windows()).some((w) => w.window === win.window);
      if (still) throw new Error(`the window is still open (close answered ${JSON.stringify(r)}); TextEdit may be asking whether to save: close it by hand`);
      pass("the TextEdit window was cleaned up and closed");
    });
  }

  bridge.dispose();
  console.log(`\n${results.pass} passed, ${results.fail} FAILED, ${results.skip} skipped.`);
  if (results.skip) console.log("Skipped steps need a permission (see the top of this file): grant it and run again.");
  console.log(results.fail ? "RESULT mac-check FAIL" : results.skip ? "RESULT mac-check ok (with skipped steps)" : "RESULT mac-check ok");
  process.exit(results.fail ? 1 : 0);
})().catch((e) => { console.error("The check itself crashed:", e && e.stack); process.exit(2); });
