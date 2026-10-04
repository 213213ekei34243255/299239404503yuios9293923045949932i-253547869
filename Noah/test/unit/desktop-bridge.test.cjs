// Noah/test/unit/desktop-bridge.test.cjs - Noah's eyes and hands on the Windows desktop (Noah/desktop/bridge.cjs + NoahDesktop.cs + host.ps1).
// REAL Windows, REAL UI Automation, REAL mouse and keyboard input: but only ever against a small test window this file starts itself
// (Noah/test/fixtures/desktop-fixture.ps1), never a program the user owns. Windows flash up for a few seconds while this runs.
// Skipped off Windows, or with NOAH_SKIP_DESKTOP_TESTS=1.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { DesktopBridge, DesktopError, hostEnv, ascii } = require("../../desktop/bridge.cjs");

const skip = process.platform !== "win32" || process.env.NOAH_SKIP_DESKTOP_TESTS === "1";
const T = { skip, timeout: 90_000 }; // a hang must fail the test by name, not stall the whole run
const FIXTURE = path.join(__dirname, "..", "fixtures", "desktop-fixture.ps1");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ pure parts (run everywhere)
test("the helper gets a scrubbed environment: what Windows apps need, none of Jonah's keys", () => {
  const env = hostEnv({ PATH: "C:\\bin", SystemRoot: "C:\\Windows", APPDATA: "C:\\u\\AppData", GEMINI_API_KEY: "g-secret", OPENAI_API_KEY: "o-secret", NOAH_TOKEN: "t", JONAH_ENTITLEMENTS_URL: "x", GITHUB_TOKEN: "ghp_x", TEMP: "C:\\t", USERPROFILE: "C:\\u" });
  assert.deepEqual(Object.keys(env).sort(), ["APPDATA", "PATH", "SystemRoot", "TEMP", "USERPROFILE"]);
  assert.doesNotMatch(JSON.stringify(env), /secret|ghp_/);
});

test("requests are ASCII-only on the wire, so no console setting can garble a title or a typed word", () => {
  const line = ascii(JSON.stringify({ text: "héllo ✓ 日本 😀" }));
  assert.match(line, /^[\x20-\x7e]*$/);
  assert.equal(JSON.parse(line).text, "héllo ✓ 日本 😀");
  assert.equal(ascii("plain"), "plain");
});

test("errors carry a code the layer above can act on", () => {
  const e = new DesktopError("that window is not in front", "not_foreground");
  assert.deepEqual([e.name, e.code, e.message], ["DesktopError", "not_foreground", "that window is not in front"]);
});

// ------------------------------------------------------------------------------------------------ real windows
let bridge, fixture, fix, other, otherWin, token;
const procs = [];
function startFixture(tok, left, top) {
  const p = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", FIXTURE, "-Token", tok, "-Seconds", "170", "-Left", String(left), "-Top", String(top)], { stdio: "ignore" });
  procs.push(p);
  return p;
}
const kill = (p) => { try { spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch (_) { /* gone */ } };
const find = (nodes, pred) => nodes.find(pred);
/** A real mouse click at a screen position, made by a separate process: what a person clicking another window looks like to Windows. */
function userClicksAt(x, y) {
  const ps = "Add-Type -Name U -Namespace N -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.IntPtr e);'; [N.U]::SetProcessDPIAware() | Out-Null; [N.U]::SetCursorPos(" + x + "," + y + ") | Out-Null; Start-Sleep -Milliseconds 80; [N.U]::mouse_event(2,0,0,0,[System.IntPtr]::Zero); Start-Sleep -Milliseconds 60; [N.U]::mouse_event(4,0,0,0,[System.IntPtr]::Zero)";
  spawnSync("powershell.exe", ["-NoProfile", "-Command", ps], { windowsHide: true, stdio: "ignore" });
}
const byName = (nodes, name) => nodes.find((n) => n.name === name);
async function read() { return (await bridge.tree(fix.window)).nodes; }
async function until(fn, ms = 4000) { const t0 = Date.now(); let last; while (Date.now() - t0 < ms) { last = await fn(); if (last) return last; await sleep(120); } return last; }

test.before(async () => {
  if (skip) return;
  token = "T" + Math.random().toString(36).slice(2, 8);
  bridge = new DesktopBridge();
  fixture = startFixture(token, 120, 120);
  fix = await bridge.waitWindow({ title: token, waitMs: 20_000 });
  otherWin = null;
});
test.after(async () => {
  if (skip) return;
  for (const p of procs) kill(p);
  if (bridge) bridge.dispose();
});

test("it sees the window and says who it is and where", T, async () => {
  assert.ok(fix.title.includes(token));
  assert.equal(fix.process.toLowerCase(), "powershell");
  assert.equal(fix.pid, fixture.pid);
  assert.match(fix.path, /powershell\.exe$/i);
  assert.ok(fix.w >= 400 && fix.h >= 300, `${fix.w}x${fix.h}`);
  assert.ok(Number.isInteger(fix.x) && Number.isInteger(fix.y));
  assert.equal(fix.minimized, false);
  const all = await bridge.windows();
  assert.ok(all.some((w) => w.window === fix.window), "it is in the list of windows");
  assert.ok(all.every((w) => w.title.length > 0), "windows without a title (helpers, the desktop itself) are left out");
  assert.equal(all.filter((w) => w.foreground).length <= 1, true, "at most one window is in front");
});

test("it reads what is INSIDE the window: named controls with their kind, state and what can be done to them", T, async () => {
  const nodes = await read();
  const name = byName(nodes, "Name field");
  assert.equal(name.type, "Edit");
  assert.ok(name.actions.includes("value"), "a text field can be written to");
  assert.equal(name.enabled, true);
  const greet = byName(nodes, "Greet");
  assert.equal(greet.type, "Button");
  assert.ok(greet.actions.includes("invoke"));
  const agree = byName(nodes, "I agree");
  assert.equal(agree.type, "CheckBox");
  assert.ok(agree.actions.includes("toggle"));
  assert.equal(agree.toggle, "Off");
  assert.ok(byName(nodes, "(nothing yet)"), "a label is read by its text");
  assert.ok(nodes.every((n) => typeof n.element === "string" && n.element.startsWith("e")), "every control has an id to refer to it by");
  assert.ok(nodes.every((n, i) => n.parent < i), "the list is in tree order, parents first");
  assert.ok(greet.w > 0 && greet.h > 0 && greet.x >= fix.x, "and where it is on screen");
});

test("a password field is flagged, its value is never read, and the secret does not appear anywhere in what Noah is shown", T, async () => {
  const raw = await bridge.tree(fix.window);
  const pw = byName(raw.nodes, "Second entry");
  assert.equal(pw.password, true);
  assert.equal(pw.value, "(hidden)");
  assert.doesNotMatch(JSON.stringify(raw), /hunter2/);
  const shot = await bridge.screenshot({ window: fix.window });
  assert.ok(shot.base64.length > 1000); // (a picture shows the dots, never the text)
});

test("a field whose NAME says it is sensitive is hidden even when it is not a password box", T, async () => {
  const raw = await bridge.tree(fix.window);
  const tok = byName(raw.nodes, "API token");
  assert.equal(tok.type, "Edit");
  assert.equal(tok.value, "(hidden: looks sensitive)");
  assert.equal(tok.password, undefined, "it is a plain field: only its name gave it away");
  assert.doesNotMatch(JSON.stringify(raw), /tok-visible-test-value/);
  const normal = byName(raw.nodes, "Name field");
  assert.notEqual(normal.value, "(hidden: looks sensitive)", "an ordinary field is still read");
});

test("a picture of the window is a real picture, at the size asked for, and it changes when the window does", T, async () => {
  const a = await bridge.screenshot({ window: fix.window });
  assert.equal(a.mime, "image/png");
  assert.equal(Buffer.from(a.base64, "base64").subarray(1, 4).toString(), "PNG");
  assert.equal(a.sourceWidth, fix.w);
  assert.ok(a.base64.length > 3000, "not a blank rectangle");
  const small = await bridge.screenshot({ window: fix.window, maxWidth: 200 });
  assert.equal(small.width, 200);
  assert.ok(Math.abs(small.scale - 200 / fix.w) < 0.01);
  assert.ok(small.height > 100);
  // change what the window shows and take it again
  const nodes = await read();
  await bridge.setText(byName(nodes, "Name field").element, "Picture");
  await bridge.click({ element: byName(nodes, "Greet").element });
  await until(async () => byName(await read(), "Hello Picture"));
  const b = await bridge.screenshot({ window: fix.window });
  assert.notEqual(a.base64, b.base64, "the second picture shows the new text");
});

test("a normal field is written through UI Automation (no keyboard), read back, and a password field is refused", T, async () => {
  const nodes = await read();
  const r = await bridge.setText(byName(nodes, "Name field").element, "Ada Lovelace");
  assert.deepEqual([r.method, r.now], ["value", "Ada Lovelace"]);
  assert.equal(byName(await read(), "Name field").value, "Ada Lovelace");
  await assert.rejects(() => bridge.setText(byName(nodes, "Second entry").element, "x"), (e) => e.code === "password_field");
  await assert.rejects(() => bridge.setText(byName(nodes, "Greet").element, "x"), (e) => e.code === "not_settable");
});

test("a click uses the control's OWN action: a button is pressed, a checkbox is toggled", T, async () => {
  let nodes = await read();
  await bridge.setText(byName(nodes, "Name field").element, "Ada");
  const press = await bridge.click({ element: byName(nodes, "Greet").element });
  assert.deepEqual([press.method, press.name], ["invoke", "Greet"]);
  assert.ok(await until(async () => byName(await read(), "Hello Ada")), "the label now says Hello Ada");
  const tick = await bridge.click({ element: byName(nodes, "I agree").element });
  assert.equal(tick.method, "toggle");
  assert.equal(byName(await read(), "I agree").toggle, "On");
  await bridge.click({ element: byName(nodes, "I agree").element });
  assert.equal(byName(await read(), "I agree").toggle, "Off", "and back");
});

test("a REAL mouse click at a spot works when the window is in front: the cursor glides there and presses", T, async () => {
  let nodes = await read();
  await bridge.setText(byName(nodes, "Name field").element, "Mouse");
  await bridge.focus(fix.window);
  nodes = await read();
  const g = byName(nodes, "Greet");
  const before = await bridge.cursor();
  const r = await bridge.click({ window: fix.window, x: g.x + Math.floor(g.w / 2), y: g.y + Math.floor(g.h / 2) });
  assert.equal(r.method, "mouse");
  const after = await bridge.cursor();
  assert.ok(Math.abs(after.x - (g.x + Math.floor(g.w / 2))) <= 2 && Math.abs(after.y - (g.y + Math.floor(g.h / 2))) <= 2, `the cursor is on the button: ${JSON.stringify(after)} (was ${JSON.stringify(before)})`);
  assert.ok(await until(async () => byName(await read(), "Hello Mouse")), "the click pressed the button");
  // a spot outside the window is refused
  await assert.rejects(() => bridge.click({ window: fix.window, x: fix.x - 50, y: fix.y - 50 }), (e) => e.code === "outside_window");
  await assert.rejects(() => bridge.scroll({ window: fix.window, x: fix.x - 50, y: fix.y - 50 }), (e) => e.code === "outside_window");
  assert.equal((await bridge.scroll({ window: fix.window, clicks: -1 })).scrolled, -1, "and a scroll inside the window in front goes through");
  // a click on a control forced to the mouse path also works
  await bridge.setText(byName(await read(), "Name field").element, "Forced");
  const forced = await bridge.click({ element: byName(await read(), "Greet").element, mouse: true });
  assert.equal(forced.method, "mouse");
  assert.ok(await until(async () => byName(await read(), "Hello Forced")));
});

test("input is refused when the window is NOT in front: it never lands in whatever else has focus", T, async () => {
  token = token;
  const tok2 = "O" + Math.random().toString(36).slice(2, 7);
  other = startFixture(tok2, 640, 160);
  otherWin = await bridge.waitWindow({ title: tok2, waitMs: 20_000 });
  await bridge.focus(otherWin.window); // something else now has the keyboard
  const nodes = await read();
  const g = byName(nodes, "Greet");
  const t = await bridge.type(fix.window, "should never be typed", { element: byName(nodes, "Name field").element }).then(() => null, (e) => e);
  assert.equal(t && t.code, "not_foreground", "typing is refused");
  await assert.rejects(() => bridge.type(fix.window, "no element given either"), (e) => e.code === "not_foreground", "typing at whatever is focused is refused too");
  await assert.rejects(() => bridge.key(fix.window, "ctrl+a"), (e) => e.code === "not_foreground");
  await assert.rejects(() => bridge.scroll({ window: fix.window, clicks: -3 }), (e) => e.code === "not_foreground", "scrolling is guarded like every other input");
  await assert.rejects(() => bridge.click({ window: fix.window, x: g.x + 5, y: g.y + 5 }), (e) => e.code === "not_foreground");
  await assert.rejects(() => bridge.click({ element: g.element, mouse: true }), (e) => e.code === "not_foreground", "a mouse click on a control of a program that is not in front is refused too");
  const other2 = (await bridge.tree(otherWin.window)).nodes;
  assert.equal(byName(other2, "Name field").value, "", "and nothing reached the window that WAS in front");
  assert.notEqual(byName(await read(), "Name field").value, "should never be typed");
  await bridge.focus(fix.window);
});

test("typing goes into the focused field, with any characters, and stops at a password field", T, async () => {
  await bridge.focus(fix.window);
  let nodes = await read();
  await bridge.setText(byName(nodes, "Name field").element, "");
  const r = await bridge.type(fix.window, "héllo wörld ✓", { element: byName(nodes, "Name field").element });
  assert.equal(r.typed, "héllo wörld ✓".length);
  assert.equal(byName(await read(), "Name field").value, "héllo wörld ✓");
  // the password box by id: refused before any key is sent
  await assert.rejects(() => bridge.type(fix.window, "x", { element: byName(nodes, "Second entry").element }), (e) => e.code === "password_field");
  // focus moves into the password box with Tab (as a user could do): typing with no target is still refused, because the focused control is a password field
  await bridge.key(fix.window, "tab");
  await assert.rejects(() => bridge.type(fix.window, "leak", {}), (e) => e.code === "password_field");
  // and the secret box was not changed by any of this (its picture and its flag are unchanged; the value is never readable)
  assert.equal(byName(await read(), "Second entry").password, true);
  await assert.rejects(() => bridge.type(fix.window, ""), (e) => e.code === "no_text");
});

test("if the focus moves while Noah is TYPING, it stops at once and nothing lands in the window that took the focus", T, async () => {
  await bridge.focus(fix.window);
  const nodes = await read();
  const nameId = byName(nodes, "Name field").element;
  await bridge.setText(nameId, "");
  const tok2 = "F" + Math.random().toString(36).slice(2, 7);
  const third = startFixture(tok2, 420, 460);
  const thirdWin = await bridge.waitWindow({ title: tok2, waitMs: 20_000 });
  await bridge.focus(fix.window);
  const long = "abcdefghij".repeat(150); // 1500 characters: many seconds of typing
  const typing = bridge.type(fix.window, long, { element: nameId }).then((r) => ({ r }), (e) => ({ e }));
  await sleep(800); // it is typing now
  userClicksAt(thirdWin.x + 120, thirdWin.y + 10); // somebody clicks the title bar of ANOTHER window
  const done = await typing;
  const fg = (await bridge.windows()).find((w) => w.foreground);
  assert.ok(fg && fg.window === thirdWin.window, "the other window really did take the focus");
  assert.equal(done.e && done.e.code, "not_foreground", "it stopped, and said why");
  const typed = byName(await read(), "Name field").value;
  assert.ok(typed.length > 0 && typed.length < long.length, "some of it was typed before the focus moved, not all: " + typed.length);
  assert.ok(typed.length <= 300 || typed.endsWith("..."), "(the field shows at most its first 300 characters)");
  const third2 = byName((await bridge.tree(thirdWin.window)).nodes, "Name field").value;
  assert.equal(third2, "", "and not ONE character reached the window that took the focus (the front window is checked before every character)");
  await bridge.focus(fix.window);
  await bridge.setText(nameId, "");
});

test("key combinations work, with modifiers: select all then backspace empties a field", T, async () => {
  await bridge.focus(fix.window);
  let nodes = await read();
  await bridge.setText(byName(nodes, "Name field").element, "");
  await bridge.type(fix.window, "to be deleted", { element: byName(nodes, "Name field").element });
  assert.equal(byName(await read(), "Name field").value.includes("to be deleted"), true);
  await bridge.key(fix.window, "ctrl+a");
  await bridge.key(fix.window, "backspace");
  assert.equal(byName(await read(), "Name field").value, "");
  await assert.rejects(() => bridge.key(fix.window, "ctrl+nonsense"), (e) => e.code === "bad_key");
  await assert.rejects(() => bridge.key(fix.window, "shift+ctrl"), (e) => e.code === "bad_key");
});

test("a program is launched, found by the process it started, and closed: Notepad, closed without saving", T, async (t) => {
  const started = await bridge.launch({ file: "notepad.exe" });
  assert.equal(started.started, true);
  const mine = await until(async () => (await bridge.windows()).find((w) => w.pid === started.pid), 10_000);
  if (!mine) { t.skip("this Windows opens Notepad through another process, so its window cannot be tied to the one started here"); return; }
  try {
    assert.equal(mine.process.toLowerCase(), "notepad");
    const tree = await bridge.tree(mine.window);
    assert.ok(tree.nodes.some((n) => n.type === "Edit" || n.type === "Document"), "its text area is visible to Noah");
    const closed = await bridge.closeWindow(mine.window);
    assert.equal(closed.closed, true);
  } finally {
    try { spawnSync("taskkill", ["/pid", String(started.pid), "/F"], { stdio: "ignore", windowsHide: true }); } catch (_) { /* gone */ }
  }
});

test("bad requests are errors with a code, never a crash", T, async () => {
  await assert.rejects(() => bridge.call("nope"), (e) => e.code === "unknown_op");
  await assert.rejects(() => bridge.focus(12345), (e) => e.code === "no_window");
  await assert.rejects(() => bridge.tree(0), (e) => e.code === "no_window");
  await assert.rejects(() => bridge.click({ element: "e99999999" }), (e) => e.code === "stale");
  await assert.rejects(() => bridge.type(fix.window, "x".repeat(4001)), (e) => e.code === "too_long");
  await assert.rejects(() => bridge.click({}), (e) => e.code === "no_window");
  await assert.rejects(() => bridge.waitWindow({ title: "no such window ever", waitMs: 600 }), (e) => e.code === "not_found");
  assert.equal(await bridge.ping(), "pong", "and the helper is still fine afterwards");
});

test("a control that has gone is reported as gone, not clicked blindly", T, async () => {
  const tok3 = "G" + Math.random().toString(36).slice(2, 7);
  const p = startFixture(tok3, 200, 400);
  const w = await bridge.waitWindow({ title: tok3, waitMs: 20_000 });
  const nodes = (await bridge.tree(w.window)).nodes;
  const greet = byName(nodes, "Greet").element;
  kill(p);
  await sleep(600);
  await assert.rejects(() => bridge.click({ element: greet }), (e) => ["stale", "disabled", "error"].includes(e.code));
});

test("the emergency stop kills the helper at once: a call in flight is cut off, and the next call starts a fresh helper", T, async () => {
  const slow = bridge.waitWindow({ title: "never going to appear", waitMs: 8000 });
  await sleep(300);
  const t0 = Date.now();
  bridge.stop();
  await assert.rejects(slow, (e) => e.code === "aborted");
  assert.ok(Date.now() - t0 < 1500, "immediately, not after the wait ran out");
  assert.equal(bridge.running, false);
  assert.equal(await bridge.ping(), "pong", "the next call starts it again");
  assert.equal(bridge.running, true);
  const again = await bridge.windows();
  assert.ok(again.some((w) => w.window === fix.window), "and it sees the same windows");
});

test("an AbortSignal cuts a call off the same way", T, async () => {
  const ctl = new AbortController();
  const slow = bridge.waitWindow({ title: "never going to appear", waitMs: 8000 }, { signal: ctl.signal });
  await sleep(300);
  ctl.abort();
  await assert.rejects(slow, (e) => e.code === "aborted");
  await assert.rejects(() => bridge.ping({ signal: ctl.signal }), (e) => e.code === "aborted", "an already-aborted signal never even sends");
  assert.equal(await bridge.ping(), "pong");
});
