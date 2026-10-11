// Noah/test/unit/resolve.test.cjs - the resolve_run tool (Noah/creative/resolve.cjs).
// DaVinci Resolve is NOT installed on the development PC, so these tests prove the PLUMBING with a real Python and a STAND-IN DaVinciResolveScript module:
// the documented locations, the launcher, the environment it sets, the script getting `resolve`, and a distinct readable failure for "not installed" and "not running".
// They do not prove that Resolve's real API behaves as the stand-in does.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { findResolve, launcherSource, buildCommand, explain } = require("../../creative/resolve.cjs");
const { Workspace } = require("../../autonomy/tools/workspace.cjs");
const { ToolRegistry, DEFS } = require("../../autonomy/tools/registry.cjs");
const { MissionState } = require("../../autonomy/mission-state.cjs");

const HAS_PYTHON = (() => { try { return spawnSync("python", ["--version"], { encoding: "utf8" }).status === 0; } catch (_) { return false; } })();

test("the documented locations, per platform; the user's own environment variables win; 'installed' means the Modules folder exists", () => {
  const win = findResolve({ platform: "win32", env: { PROGRAMDATA: "C:\\ProgramData", ProgramFiles: "C:\\Program Files" }, exists: () => true });
  assert.equal(win.scriptApi, "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting");
  assert.equal(win.scriptModules, "C:\\ProgramData\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting\\Modules");
  assert.equal(win.scriptLib, "C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll");
  assert.equal(findResolve({ platform: "darwin", env: {}, exists: () => true }).scriptApi, "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting");
  assert.equal(findResolve({ platform: "darwin", env: {}, exists: () => true }).scriptLib, "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so");
  assert.equal(findResolve({ platform: "linux", env: {}, exists: () => true }).scriptLib, "/opt/resolve/libs/Fusion/fusionscript.so");
  assert.equal(findResolve({ platform: "win32", env: { RESOLVE_SCRIPT_API: "D:\\r", RESOLVE_SCRIPT_LIB: "D:\\r\\f.dll" }, exists: () => true }).scriptModules, "D:\\r\\Modules");
  assert.equal(findResolve({ platform: "win32", env: {}, exists: () => false }).installed, false);
});

test("the launcher carries paths as quoted data (a path with quotes or code in it cannot become code), and the command refuses shell syntax", () => {
  const src = launcherSource({ scriptApi: 'C:\\a"b', scriptModules: "C:\\x\\Modules", scriptLib: "C:\\l.dll" });
  assert.ok(src.includes('"C:\\\\a\\"b"'), "JSON-escaped");
  assert.equal(buildCommand({ script: "edit.py", launcher: ".noah/resolve_launch.py", options: ["--fps", "24"] }).cmd, 'python ".noah/resolve_launch.py" "edit.py" --fps 24');
  for (const bad of ['a"b.py', "a%x%.py"]) assert.match(buildCommand({ script: bad, launcher: "l.py" }).error, /not allowed/);
  assert.match(buildCommand({ script: "x.txt", launcher: "l.py" }).error, /Python file/);
  assert.equal(explain(3, "").code, "resolve_not_running");
  assert.equal(explain(4, "").code, "resolve_not_installed");
  assert.equal(explain(1, "Traceback"), null);
  assert.match(explain(3, "").message, /STUDIO/);
});

function fakeResolveInstall(root, { running = true } = {}) {
  const modules = path.join(root, "api", "Modules");
  fs.mkdirSync(modules, { recursive: true });
  fs.writeFileSync(path.join(modules, "DaVinciResolveScript.py"), `
import os
class _Project:
    def GetName(self): return "Demo project"
class _PM:
    def GetCurrentProject(self): return _Project()
class _Resolve:
    def GetVersionString(self): return "19.0.0.stand-in"
    def GetProjectManager(self): return _PM()
def scriptapp(name):
    assert name == "Resolve"
    assert os.environ.get("RESOLVE_SCRIPT_API") and os.environ.get("RESOLVE_SCRIPT_LIB")
    return ${running ? "_Resolve()" : "None"}
`);
  return { installed: true, scriptApi: path.join(root, "api"), scriptModules: modules, scriptLib: path.join(root, "lib.dll"), libExists: false };
}

function setup({ running = true, installed = true } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-rs-")));
  const info = installed ? fakeResolveInstall(path.join(dir, "fake"), { running }) : { installed: false, scriptModules: "C:\\nowhere\\Modules" };
  const ws = path.join(dir, "ws");
  fs.mkdirSync(ws);
  const reg = new ToolRegistry({ workspace: new Workspace({ roots: [ws] }), state: new MissionState({ objective: "x" }), resolveInfo: info, logDir: path.join(dir, "logs") });
  return { dir, ws, reg };
}

test("registered, mutating, schema is plain; without Resolve it says so and offers ffmpeg", async () => {
  assert.ok(DEFS.resolve_run);
  const { dir, ws, reg } = setup({ installed: false });
  try {
    fs.writeFileSync(path.join(ws, "e.py"), "print(1)\n");
    assert.equal(reg.isMutating("resolve_run", { script: "e.py" }), true);
    const r = await reg.execute("resolve_run", { script: "e.py" });
    assert.deepEqual([r.ok, r.code], [false, "resolve_not_installed"]);
    assert.match(r.message, /ffmpeg/);
    assert.equal((await reg.execute("resolve_run", { script: "missing.py" })).code, "resolve_not_installed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("with a stand-in Resolve: the script runs with `resolve` ready, in a REAL Python, and its output comes back", { skip: !HAS_PYTHON && "no python on PATH", timeout: 60000 }, async () => {
  const { dir, ws, reg } = setup();
  try {
    fs.writeFileSync(path.join(ws, "edit.py"), "import sys\nproject = resolve.GetProjectManager().GetCurrentProject()\nprint('PROJECT', project.GetName(), 'ARGS', sys.argv[1:])\n");
    const r = await reg.execute("resolve_run", { script: "edit.py", options: "--fps 24" });
    assert.equal(r.ok, true, JSON.stringify({ code: r.code, message: r.message, out: r.output }));
    assert.match(r.output, /PROJECT Demo project ARGS \['--fps', '24'\]/);
    assert.equal(r.resolveConnected, true);
    assert.equal(r.resolveVersion, "19.0.0.stand-in");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("with a stand-in where Resolve is not running: a distinct, readable failure (not a stack trace)", { skip: !HAS_PYTHON && "no python on PATH", timeout: 60000 }, async () => {
  const { dir, ws, reg } = setup({ running: false });
  try {
    fs.writeFileSync(path.join(ws, "edit.py"), "print('should never run')\n");
    const r = await reg.execute("resolve_run", { script: "edit.py" });
    assert.deepEqual([r.ok, r.code], [false, "resolve_not_running"]);
    assert.match(r.message, /External scripting using/);
    assert.doesNotMatch(r.output || "", /should never run/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a script error inside a connected Resolve is a failed run with the Python error, not 'not running'", { skip: !HAS_PYTHON && "no python on PATH", timeout: 60000 }, async () => {
  const { dir, ws, reg } = setup();
  try {
    fs.writeFileSync(path.join(ws, "bad.py"), "resolve.NoSuchCall()\n");
    const r = await reg.execute("resolve_run", { script: "bad.py" });
    assert.equal(r.ok, false);
    assert.notEqual(r.code, "resolve_not_running");
    assert.equal(r.resolveConnected, true);
    assert.match(r.output, /NoSuchCall|AttributeError/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
