// Noah/bench/integration/desktop-web-check.cjs
//
// Does the computer agent click what it MEANS to, in a web page, with the real helper, the real OCR and real mouse clicks? The page is a chat web app (the shape of WhatsApp Web)
// in Chromium: the same engine as Edge. It reports every click and key it REALLY receives, so each step is judged by what the page says happened, never by what Noah believes.
//
//   1. a contact is opened BY NAME (the words are read from the picture and clicked): the page must say that contact opened
//   2. the message box is clicked by ITS words, the message is typed (keyboard), and the text must be in the box
//   3. Send is clicked by PIXEL COORDINATES in the picture, as a model does for an icon: the page must say Send was pressed and the message went
//   4. the same click on a spot that is covered (a window on top of it) is REFUSED and nothing reaches the page
//   5. Noah waits while the user is using the mouse, then goes ahead; and puts the user's own window back afterwards
//   6. a click at a bare spot in a messaging window asks the user first (so a message cannot be sent without a question)
//   7. if the user starts typing while Noah is typing, Noah stops at once
//
//   node Noah/bench/integration/desktop-web-check.cjs        (Windows; opens test windows for about a minute)
//
"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

if (process.platform !== "win32") { console.log("SKIP  this check needs Windows"); process.exit(0); }

const ROOT = path.resolve(__dirname, "..", "..", "..");
const { DesktopBridge } = require(path.join(ROOT, "Noah", "desktop", "bridge.cjs"));
const { DesktopTools } = require(path.join(ROOT, "Noah", "desktop", "tools.cjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${extra ? `  -> ${extra}` : ""}`); if (!ok) failures++; };
const until = async (fn, ms = 6000) => { const t0 = Date.now(); let last; while (Date.now() - t0 < ms) { last = await fn(); if (last) return last; await sleep(100); } return last; };

const token = "W" + Math.random().toString(36).slice(2, 6);
const log = path.join(os.tmpdir(), `noah-webcheck-${token}.log`);
const udir = path.join(os.tmpdir(), `noah-webcheck-ud-${token}`);
const children = [];
const events = () => { try { return fs.readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
const last = (ev) => events().filter((e) => e.ev === ev).pop();

function startPage(title, extra = []) {
  const c = spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [`--user-data-dir=${udir}-${children.length}`, path.join(ROOT, "Noah", "test", "fixtures", "web-fixture-app.cjs"), `--title=${title}`, "--seconds=150", ...extra], { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NOAH_FIXTURE_LOG: log }, stdio: "ignore" });
  children.push(c);
  return c;
}
function realInput(...args) { return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "Noah", "test", "fixtures", "real-input.ps1"), ...args], { windowsHide: true, encoding: "utf8" }); }

(async () => {
  const bridge = new DesktopBridge();
  const asked = [];
  const notes = [];
  const tools = new DesktopTools({ bridge, getMode: () => "autonomous", confirm: async (r) => { asked.push(r); return true; }, restoreAfterMs: 1500, notify: (e) => notes.push(e) });
  try {
    // ---- set-up: the chat page, fully on the screen (left/top chosen so that it ends above the taskbar), with "WhatsApp" in its title like the real one
    startPage(`Noah Web Fixture WhatsApp ${token}`, ["--left=10", "--top=10", "--width=1000", "--height=640"]);
    const page = await bridge.waitWindow({ title: token, waitMs: 25000 });
    const layout = await until(() => last("layout"), 12000);
    check(page.class === "Chrome_WidgetWin_1" && !!layout, "set-up: a Chromium chat page is open and has reported where its parts are", `${page.class}; screen is ${layout ? "ok" : "no layout"}`);
    if (!layout) throw new Error("no layout reported");
    const row = layout.rows["Ansuman Bhattacharjee"];
    const wb = await bridge.windows();
    const w = wb.find((x) => x.window === page.window);
    check(w.y + w.h < 728, "set-up: the page's window ends above the taskbar (nothing covers it)", `bottom edge ${w.y + w.h}`);

    // ---- 1. open a contact BY NAME
    const r1 = await tools.click({ text: "Ansuman", window: page.window });
    const opened = await until(() => last("open_chat"), 5000);
    check(r1.ok === true && r1.via === "text", "1. clicking the words 'Ansuman' found them in the picture and clicked", JSON.stringify({ ok: r1.ok, via: r1.via, name: r1.name, at: r1.at, code: r1.code, message: r1.message && r1.message.slice(0, 120) }));
    check(!!opened && opened.chat === "Ansuman Bhattacharjee", "1. the PAGE says Ansuman Bhattacharjee's chat opened (and not another contact's)", opened ? opened.chat : "no chat opened");
    check(!!opened && opened.y >= row.y && opened.y <= row.y + row.h && opened.x >= row.x && opened.x <= row.x + row.w, "1. the click landed inside that contact's row on the screen", opened ? `click at ${opened.x},${opened.y}; row is x ${row.x}-${row.x + row.w}, y ${row.y}-${row.y + row.h}` : "");

    // ---- 2. click the box by ITS words, type
    const r2 = await tools.click({ text: "Type a message", window: page.window });
    check(r2.ok === true, "2. clicking the box by its placeholder words worked", JSON.stringify({ ok: r2.ok, name: r2.name, code: r2.code, message: r2.message && r2.message.slice(0, 120) }));
    const MESSAGE = "Hello from Noah, test message";
    const r3 = await tools.type({ text: MESSAGE, window: page.window });
    const typedEv = await until(() => { const t = last("typed"); return t && t.text.trim() === MESSAGE ? t : null; }, 6000);
    check(r3.ok === true && !!typedEv, "2. the typed message is in the page's message box, exactly", typedEv ? typedEv.text : JSON.stringify(r3).slice(0, 160));

    // ---- 3. Send, by pixel coordinates in the picture (what a model does for an icon)
    const shot = await tools.screenshot({ window: page.window });
    const sh = tools._shots.get(page.window);
    check(shot.ok === true && /grid/.test(shot.note), "3. the picture of a web page has the coordinate grid", shot.note && shot.note.slice(0, 90));
    const cx = layout.send.x + layout.send.w / 2, cy = layout.send.y + layout.send.h / 2;
    const px = Math.round((cx - sh.x) * sh.scale), py = Math.round((cy - sh.y) * sh.scale);
    const askedBefore = asked.length;
    const r4 = await tools.click({ x: px, y: py, window: page.window });
    const sent = await until(() => last("sent"), 5000);
    check(r4.ok === true && !!sent && sent.text === MESSAGE, "3. a click at the Send icon's pixel position pressed Send: the page says the message was SENT", sent ? sent.text : JSON.stringify(r4).slice(0, 200));
    const sc = last("send_click");
    check(!!sc && Math.abs(sc.x - cx) <= layout.send.w / 2 && Math.abs(sc.y - cy) <= layout.send.h / 2, "3. and it landed on the button, not beside it", sc ? `landed ${sc.x},${sc.y}; button centre ${cx},${cy}` : "no send click");
    check(asked.length > askedBefore && /Send|spot/i.test(String(asked[asked.length - 1].why || asked[asked.length - 1].summary)), "6. pressing Send at a bare spot in a chat window ASKED the user first (it cannot send a message unasked)", asked.length ? asked[asked.length - 1].summary : "never asked");
    check(asked.every((a) => a.timeoutMs >= 600000), "6. and the card is allowed to wait a long time (the task runs in the background)", asked.map((a) => a.timeoutMs).join(","));

    // ---- 4. a covered spot is refused
    startPage(`Noah Web Fixture Covered ${token}`, ["--left=10", "--top=300", "--width=1000", "--height=640"]); // runs off the bottom of the screen: the taskbar is on top of its lower part
    const covered = await bridge.waitWindow({ title: `Covered ${token}`, waitMs: 25000 });
    const cl = await until(() => events().filter((e) => e.ev === "layout").pop() && events().filter((e) => e.ev === "layout").length >= 2 ? events().filter((e) => e.ev === "layout").pop() : null, 12000);
    await bridge.focus(covered.window);
    const clicksBefore = events().filter((e) => e.ev === "click").length;
    const under = { x: Math.round(cl.send.x + cl.send.w / 2), y: Math.round(cl.send.y + cl.send.h / 2) };
    const hidden = under.y > 728;
    // aim at a point of the page that IS under the taskbar (the lower strip of the window): refused, and the page gets nothing
    const wc = (await bridge.windows()).find((x) => x.window === covered.window);
    const aim = { x: wc.x + 400, y: 735 };
    let refusal = null;
    try { await bridge.click({ window: covered.window, x: aim.x, y: aim.y }); } catch (e) { refusal = e; }
    await sleep(400);
    check(!!refusal && refusal.code === "covered", "4. a click at a spot with the taskbar over it is REFUSED ('covered')", refusal ? `${refusal.code}: ${refusal.message.slice(0, 100)}` : `it was not refused (the page's Send was at y=${under.y}, hidden=${hidden})`);
    check(events().filter((e) => e.ev === "click").length === clicksBefore, "4. and nothing reached the page", `${events().filter((e) => e.ev === "click").length - clicksBefore} extra clicks`);

    // ---- 5. the user's activity: Noah waits, then goes ahead; the user's own window is put back
    const userWin = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "Noah", "test", "fixtures", "desktop-fixture.ps1"), "-Token", `User${token}`, "-Seconds", "120", "-Left", "700", "-Top", "60"], { stdio: "ignore" });
    children.push(userWin);
    const mine = await bridge.waitWindow({ title: `User${token}`, waitMs: 25000 });
    await bridge.focus(mine.window); // the window the user is working in
    await sleep(3200);
    const slow = new DesktopTools({ bridge, getMode: () => "autonomous", confirm: async () => true, idleNeededMs: 2500, restoreAfterMs: 1500, notify: (e) => notes.push(e) });
    notes.length = 0;
    const tap = () => realInput("-Op", "chord", "-Keys", "shift"); // the USER touches the keyboard (a tap of Shift: it changes nothing on the screen)
    tap();
    const t1 = Date.now();
    const rf = await slow.focus({ window: page.window }); // taking another window to the front is a takeover: it waits for the user to be still
    const waited = Date.now() - t1;
    check(rf.ok === true && waited >= 2000, "5. right after the USER touched the keyboard, Noah WAITED (about the idle time) before taking the page to the front", `waited ${waited} ms; ${rf.ok ? "took it forward" : rf.code}`);
    check(notes.some((n) => n.state === "waiting") && notes.some((n) => n.state === "active"), "5. and it said so: 'waiting for you' and then 'taking over'", notes.map((n) => n.state).join(" > "));
    const rc = await slow.click({ text: "Alwin", window: page.window });
    const alwin = await until(() => events().filter((e) => e.ev === "open_chat" && e.chat === "Alwin Devasia").pop(), 4000);
    check(rc.ok === true && !!alwin, "5. and then it clicked (the user was still): the page says Alwin Devasia's chat opened", alwin ? alwin.chat : JSON.stringify(rc).slice(0, 140));
    await sleep(2800); // Noah has not needed the screen for a moment: the user's own window comes back
    const frontNow = (await bridge.windows()).find((x) => x.foreground);
    check(!!frontNow && frontNow.window === mine.window, "5. afterwards the USER's own window is back in front", frontNow ? `front is "${frontNow.title.slice(0, 40)}"` : "nothing in front");
    check(notes.some((n) => n.state === "idle"), "5. and Noah said it had let go of the screen", notes.map((n) => n.state).join(" > "));

    // ---- 7. the user starts typing while Noah is typing: Noah stops at once and never mixes its letters into the user's
    await sleep(3000); // the user is still again
    const noisy = new DesktopTools({ bridge, getMode: () => "autonomous", confirm: async () => true, idleNeededMs: 1000, restoreAfterMs: 60000, notify: () => {} });
    const typedBefore = (last("typed") || { text: "" }).text.length;
    const LONG = "abcdefghij".repeat(60);
    const typing = noisy.type({ text: LONG, window: page.window });
    // a user who keeps at the keyboard: an ASYNCHRONOUS presser (a blocking one would freeze this check itself), starting about a second in, in the middle of the typing
    const keeps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "Noah", "test", "fixtures", "real-input.ps1"), "-Op", "chord", "-Keys", "shift", "-Repeat", "20", "-EveryMs", "150"], { stdio: "ignore" });
    children.push(keeps);
    const rTyped = await typing;
    await sleep(500);
    const shown = (last("typed") || { text: "" }).text.trim();
    check(rTyped.ok === false && rTyped.code === "user_busy", "7. when the user touched the keyboard in the middle of typing, Noah STOPPED ('user_busy')", JSON.stringify(rTyped).slice(0, 160));
    const said = /\((\d+) of (\d+) characters had already been typed\)/.exec(rTyped.message || "");
    check(!!said && Number(said[1]) > 0 && Number(said[1]) < LONG.length, "7. and only part of the text had been typed, and Noah SAYS how much (so the model knows what is there)", said ? `${said[1]} of ${said[2]} characters` : String(rTyped.message).slice(0, 140));
    void typedBefore;
  } catch (e) {
    console.log("CHECK ERROR", e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e);
    failures++;
  } finally {
    bridge.dispose();
    for (const c of children) { try { spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch (_) { /* gone */ } }
    await sleep(500);
    try { fs.rmSync(log, { force: true }); } catch (_) { /* gone */ }
    for (let i = 0; i < 6; i++) { try { fs.rmSync(`${udir}-${i}`, { recursive: true, force: true }); } catch (_) { /* gone */ } }
    console.log(`RESULT desktop-web ${failures ? "FAIL" : "ok"}`);
    process.exit(failures ? 1 : 0);
  }
})();
