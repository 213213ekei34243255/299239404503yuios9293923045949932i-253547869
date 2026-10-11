// Noah/test/unit/admin-access.test.cjs - optional administrator access (Windows): OFF by default, asked for with Windows' own prompt, never forced, never a loop.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const admin = require("../../desktop/admin.cjs");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "noah-admin-"));

test("off by default; the switch is a file that says exactly yes or no", () => {
  const d = dir();
  assert.equal(admin.readEnabled(d), false, "no file: off");
  assert.equal(admin.writeEnabled(d, true), true);
  assert.equal(admin.readEnabled(d), true);
  assert.equal(admin.writeEnabled(d, false), true);
  assert.equal(admin.readEnabled(d), false);
  fs.writeFileSync(path.join(d, admin.FILE), "{ not json");
  assert.equal(admin.readEnabled(d), false, "a damaged file is off, not an error");
  fs.writeFileSync(path.join(d, admin.FILE), JSON.stringify({ enabled: "yes" }));
  assert.equal(admin.readEnabled(d), false, "only a real true turns it on");
  assert.equal(admin.writeEnabled(path.join(d, "not-a-folder", "x"), true) || true, true);
});

test("only Windows offers it; elsewhere nothing is attempted", () => {
  assert.equal(admin.supported("win32"), true);
  assert.equal(admin.supported("darwin"), false);
  let ran = 0;
  const r = admin.relaunchElevated({ platform: "darwin", run: () => { ran++; return { status: 0 }; } });
  assert.deepEqual([r.ok, r.unsupported, ran], [false, true, 0]);
});

test("elevated means the Windows tool that only an administrator can run succeeded; a failure or a throw is 'not elevated'", () => {
  assert.equal(admin.isElevated({ platform: "win32", run: () => ({ status: 0 }) }), true);
  assert.equal(admin.isElevated({ platform: "win32", run: () => ({ status: 5 }) }), false);
  assert.equal(admin.isElevated({ platform: "win32", run: () => { throw new Error("no such tool"); } }), false);
  assert.equal(admin.isElevated({ platform: "win32", run: () => null }), false);
});

test("the relaunch asks Windows for permission (-Verb RunAs) for THIS program with the wait-for-me flag, and survives odd characters in the path", () => {
  const calls = [];
  const exe = "C:\\Users\\A&B 'quoted'\\AppData\\Local\\Programs\\Jonah\\Jonah.exe";
  const r = admin.relaunchElevated({ exe, pid: 4242, appArgs: ["C:\\dev\\jonah"], platform: "win32", run: (cmd, args) => { calls.push([cmd, args]); return { status: 0 }; } });
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.length, 1);
  const [cmd, args] = calls[0];
  assert.equal(cmd, "powershell.exe");
  const encoded = args[args.indexOf("-EncodedCommand") + 1];
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(script, /Start-Process/);
  assert.match(script, /-Verb RunAs/);
  assert.match(script, /-ErrorAction Stop/);
  assert.ok(script.includes("A&B ''quoted''"), "a quote inside the path is doubled, not left to break the command");
  assert.ok(script.includes("'--wait-for-pid=4242'") && script.includes("'C:\\dev\\jonah'"));
  assert.match(script, /catch \{ exit 1 \}/);
});

test("saying no to the Windows prompt (or any failure) is 'declined': the caller keeps running normally", () => {
  assert.deepEqual(admin.relaunchElevated({ platform: "win32", run: () => ({ status: 1 }) }), { ok: false, declined: true });
  assert.deepEqual(admin.relaunchElevated({ platform: "win32", run: () => { throw new Error("boom"); } }), { ok: false, declined: true });
  assert.deepEqual(admin.relaunchElevated({ platform: "win32", run: () => null }), { ok: false, declined: true });
});

test("a copy started with --wait-for-pid waits until the other copy is gone, and gives up after the limit; without the flag it does nothing", () => {
  let alive = true, sleeps = 0;
  const gone = admin.waitForParent(["Jonah.exe", "--wait-for-pid=999"], { alive: () => alive, sleep: () => { if (++sleeps === 4) alive = false; }, maxMs: 20000 });
  assert.equal(gone, true);
  assert.equal(sleeps, 4);
  let slept = 0;
  admin.waitForParent(["--wait-for-pid=999"], { alive: () => true, sleep: () => { slept++; }, maxMs: 1500 });
  assert.equal(slept, 10, "it stops waiting after maxMs");
  assert.equal(admin.waitForParent(["Jonah.exe"], { alive: () => { throw new Error("never asked"); } }), false);
  for (const bad of ["--wait-for-pid=abc", "--wait-for-pid=0", "--wait-for-pid=-5", `--wait-for-pid=${process.pid}`, "--wait-for-pid="]) {
    assert.equal(admin.waitForParent([bad], { alive: () => { throw new Error("never asked"); } }), false, bad);
  }
});

test("the pieces are connected: main.cjs asks once per launch and quits only after Windows said yes; the shell and the panel can ask and set; the hint points to the switch", () => {
  const main = read("main.cjs");
  assert.ok(main.includes("adminAccess.waitForParent(process.argv);"));
  assert.ok(main.includes("ipcMain.handle(\"admin:get\"") && main.includes("ipcMain.handle(\"admin:set\""));
  assert.ok(main.includes("event.sender === mainWindow.webContents"), "only the shell window may ask");
  assert.ok(/if \(relaunched\.ok\) \{ app\.quit\(\); return; \}\s*\n\s*adminDeclinedAtStart = true;/.test(main), "a refusal is remembered and the app carries on");
  assert.ok(main.includes("if (enabled !== true) { adminAccess.writeEnabled(dir, false);"), "turning it off only clears the flag (it takes effect at the next start)");
  assert.ok(main.includes("if (!r.ok) return { ok: false, declined: true"), "and a refused prompt does not turn the flag on");
  assert.ok(read("preload.cjs").includes("getAdmin:") && read("preload.cjs").includes("setAdmin: (enabled) => ipcRenderer.invoke('admin:set', enabled === true)"));
  const renderer = read("noah-renderer.js");
  assert.ok(renderer.includes("case \"admin-get\"") && renderer.includes("case \"admin-set\": return void window.noah.setAdmin(d.enabled === true)"));
  const html = read("ai-panel.html");
  assert.ok(html.includes("id=\"noahAdmin\"") && html.includes("id=\"noahAdminRow\" hidden") && html.includes("window.confirm(\"Turn on administrator access?"));
  assert.ok(html.includes("if (d.type === \"noah:admin-state\") return applyAdminState(d.payload);"));
  assert.match(read("Noah/desktop/tools.cjs"), /switch on \\"Administrator access\\" in the Noah bar/);
});
