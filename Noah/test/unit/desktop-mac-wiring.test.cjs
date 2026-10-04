// Noah/test/unit/desktop-mac-wiring.test.cjs - the pieces that make the Mac computer agent reachable and allowed: the permission check is in the task's way (and only in
// a computer task's way), the app is built with the entitlements and usage text macOS needs, and the main process hands Electron's systemPreferences to Noah.
// The Mac helper's logic is in desktop-mac-host.test.cjs. NONE of this has run on a real Mac: see desktop-mac-check.cjs.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MissionService } = require("../../autonomy/service.cjs");
const { AgentSession } = require("../../agent/session.cjs");
const { EventBus } = require("../../events.cjs");
const { createPermissionCheck, ACCESSIBILITY_REPLY } = require("../../desktop/permissions.cjs");
const { realPath } = require("../../desktop/bridge.cjs");
const { systemPrompt } = require("../../autonomy/mission-context.cjs");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-mw-")));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

function service({ checkPermissions, desktop = true } = {}) {
  const bus = new EventBus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const core = { bus, session: new AgentSession({ bus }), safety: { confirm: async () => false, denyAllPending: () => {} } };
  const router = { usable: () => [{ provider: "scripted" }], call: async () => ({ text: "", toolCalls: [{ name: "give_up", args: { reason: "test" } }], usage: { inputTokens: 1, outputTokens: 1 } }) };
  const made = [];
  const picked = [];
  const svc = new MissionService({ router, core, dataDir: path.join(base, `d${Math.random().toString(36).slice(2, 8)}`), pickFolder: async (i) => { picked.push(i); return null; }, desktop, makeBridge: () => { made.push(1); return { stop() {}, dispose() {}, windows: async () => [], userIdle: async () => ({ idleMs: 9999 }) }; }, ...(checkPermissions ? { checkPermissions } : {}) });
  return { svc, events, made, picked };
}

test("a computer task on a Mac without the Accessibility permission does not start: the user is told exactly where to switch it on, and nothing is created", () => {
  const prompts = [];
  const check = createPermissionCheck({ platform: "darwin", systemPreferences: { isTrustedAccessibilityClient: (p) => { prompts.push(p); return false; } } });
  const w = service({ checkPermissions: check });
  const r = w.svc.start("open notes and write hello", { kind: "desktop" });
  assert.deepEqual([r.ok, r.reply], [false, ACCESSIBILITY_REPLY]);
  assert.equal(w.svc.isRunning(), false, "no task is running");
  assert.equal(w.made.length, 0, "no helper was started");
  assert.equal(w.events.length, 0, "and nothing was announced");
  assert.deepEqual(prompts, [false, true], "macOS's own prompt was asked for once");
});

test("with the permission granted the task starts; a project task never asks for it; a check that breaks does not stop the task", async () => {
  const granted = service({ checkPermissions: createPermissionCheck({ platform: "darwin", systemPreferences: { isTrustedAccessibilityClient: () => true } }) });
  assert.equal(granted.svc.start("open notes", { kind: "desktop" }).ok, true);
  await new Promise((r) => granted.svc.once("ended", r));
  assert.equal(granted.made.length, 1, "the helper was started");

  let asked = 0;
  const project = service({ checkPermissions: () => { asked++; return { ok: false, reply: "no" }; } });
  project.svc.start("fix the tests", { kind: "project" });
  assert.equal(asked, 0, "a project task is about files: the Mac permission has nothing to do with it");
  await new Promise((r) => project.svc.once("ended", r));

  const broken = service({ checkPermissions: () => { throw new Error("boom"); } });
  assert.equal(broken.svc.start("open notes", { kind: "desktop" }).ok, true, "the helper will say what is missing");
  await new Promise((r) => broken.svc.once("ended", r));
});

test("a task on a system where the desktop is not available is refused before the permission is even asked", () => {
  let asked = 0;
  const w = service({ desktop: false, checkPermissions: () => { asked++; return { ok: true }; } });
  const r = w.svc.start("open notes", { kind: "desktop" });
  assert.equal(r.ok, false);
  assert.match(r.reply, /Windows and macOS/);
  assert.equal(asked, 0);
});

test("the Mac computer agent is told it is on a Mac, with the Mac's own names for things", () => {
  const mac = systemPrompt({ desktop: true, platform: "darwin" });
  assert.match(mac, /Mac/);
  assert.doesNotMatch(mac, /# The Windows desktop/);
  assert.match(systemPrompt({ desktop: true, platform: "win32" }), /# The Windows desktop/);
});

test("the app is built with what macOS needs for the computer agent: Apple events entitlement and usage text", () => {
  const plist = read("build/entitlements.mac.plist");
  const keys = [...plist.matchAll(/<key>(.*?)<\/key>\s*<(true|false)\/>/g)].map((m) => [m[1], m[2]]);
  assert.equal((plist.match(/<key>/g) || []).length, keys.length, "every key has a value");
  assert.ok(keys.some(([k, v]) => k === "com.apple.security.automation.apple-events" && v === "true"), "without it the hardened runtime blocks System Events and macOS never asks the user");
  for (const k of ["com.apple.security.cs.allow-jit", "com.apple.security.device.audio-input", "com.apple.security.network.client"]) assert.ok(keys.some(([name]) => name === k), `${k} is still there`);
  const pkg = JSON.parse(read("package.json"));
  const info = pkg.build.mac.extendInfo;
  assert.match(info.NSAppleEventsUsageDescription, /System Events/, "the text macOS shows in the Automation prompt");
  assert.ok(info.NSMicrophoneUsageDescription && info.NSCameraUsageDescription, "the existing usage texts are kept");
  assert.equal(pkg.build.mac.hardenedRuntime, true);
  assert.equal(pkg.build.mac.entitlements, "build/entitlements.mac.plist");
  assert.equal(pkg.build.mac.entitlementsInherit, "build/entitlements.mac.plist");
  assert.deepEqual(pkg.build.mac.target.find((t) => t.target === "dmg").arch.sort(), ["arm64", "x64"], "both Intel and Apple silicon");
  assert.equal(pkg.build.files.some((f) => /^!.*host-mac/.test(f)), false, "host-mac.js is not excluded from the app");
  assert.equal(pkg.build.files.some((f) => /^!.*Noah/.test(f) && !/bench\/results/.test(f)), false, "nor is anything else of Noah");
});

test("main.cjs gives Noah Electron's systemPreferences, and Noah hands the permission check to the mission service", () => {
  const main = read("main.cjs");
  assert.match(main, /require\('electron'\)/);
  assert.match(main.split("\n")[0], /\bsystemPreferences\b/, "imported from Electron");
  assert.match(main, /electron: \{[^}]*\bsystemPreferences\b[^}]*\}/, "and passed to createNoah");
  const index = read("Noah/index.cjs");
  assert.match(index, /createPermissionCheck\(\{ systemPreferences: electron\.systemPreferences/);
  assert.match(index, /new MissionService\(\{[^}]*\bcheckPermissions\b/);
});

test("the helper's files are unpacked from the app archive, and the bridge looks for them there: PowerShell and osascript cannot read inside app.asar", () => {
  const pkg = JSON.parse(read("package.json"));
  const unpack = pkg.build.asarUnpack || [];
  for (const f of ["Noah/desktop/host.ps1", "Noah/desktop/NoahDesktop.cs", "Noah/desktop/host-mac.js"]) {
    assert.ok(unpack.includes(f), `${f} must be unpacked (it is opened by another program)`);
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, "Noah/desktop/host.ps1")) && fs.readFileSync(path.join(ROOT, "Noah/desktop/host.ps1"), "utf8").includes("NoahDesktop.cs"), "host.ps1 reads the C# file that sits next to it, so the two must be unpacked together");
  assert.ok(!(pkg.build.files || []).some((f) => /^!.*(host\.ps1|NoahDesktop|host-mac)/.test(f)), "and none of them is excluded from the build");
});

test("realPath turns a path inside app.asar into the unpacked one, and leaves every other path alone", () => {
  const BS = String.fromCharCode(92);
  const win = (...parts) => parts.join(BS);
  assert.equal(realPath(win("C:", "Program Files", "Jonah", "resources", "app.asar", "Noah", "desktop", "host.ps1")), win("C:", "Program Files", "Jonah", "resources", "app.asar.unpacked", "Noah", "desktop", "host.ps1"));
  assert.equal(realPath("/Applications/Jonah.app/Contents/Resources/app.asar/Noah/desktop/host-mac.js"), "/Applications/Jonah.app/Contents/Resources/app.asar.unpacked/Noah/desktop/host-mac.js");
  assert.equal(realPath(win("C:", "Jonah2", "Noah", "desktop", "host.ps1")), win("C:", "Jonah2", "Noah", "desktop", "host.ps1"), "run from source: unchanged");
  assert.equal(realPath("/x/myapp.asar/Noah/host.ps1"), "/x/myapp.asar/Noah/host.ps1", "only a folder called exactly app.asar");
  assert.equal(realPath("/x/app.asar.unpacked/Noah/host.ps1"), "/x/app.asar.unpacked/Noah/host.ps1", "already unpacked: not changed twice");
  assert.equal(realPath("/a/app.asar/b/app.asar/c.js"), "/a/app.asar.unpacked/b/app.asar/c.js", "only the first");
});

test("the bridge's default helper path goes through realPath on both systems", () => {
  // the default is computed from __dirname: simulate a packaged __dirname by loading the module from a copy placed under an app.asar-named folder
  const dir = path.join(base, "app.asar", "Noah", "desktop");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "Noah/desktop/bridge.cjs"), path.join(dir, "bridge.cjs"));
  const copy = require(path.join(dir, "bridge.cjs"));
  assert.equal(path.basename(path.dirname(path.dirname(path.dirname(new copy.DesktopBridge({ platform: "win32" }).hostPath)))), "app.asar.unpacked", "Windows");
  assert.equal(path.basename(path.dirname(path.dirname(path.dirname(new copy.DesktopBridge({ platform: "darwin" }).hostPath)))), "app.asar.unpacked", "macOS");
  assert.equal(new copy.DesktopBridge({ platform: "win32", hostPath: "C:/custom/host.ps1" }).hostPath, "C:/custom/host.ps1", "an explicit path is used as given");
});
