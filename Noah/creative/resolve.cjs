// Noah/creative/resolve.cjs - DaVinci Resolve, driven through Blackmagic's own scripting API (the "Resolve API Readme" that ships in
// <Resolve>/Developer/Scripting): a Python script imports DaVinciResolveScript, asks for scriptapp("Resolve") and talks to the RUNNING Resolve.
//
// What this module can and cannot promise (Resolve is not installed on the development PC, so none of it has run against the real program):
//   * the install locations and environment variables are the documented ones (RESOLVE_SCRIPT_API, RESOLVE_SCRIPT_LIB, PYTHONPATH += <api>/Modules)
//   * Resolve must be RUNNING, and external scripting must be allowed (Preferences > System > General > "External scripting using": Local)
//   * external scripting is a DaVinci Resolve STUDIO feature (the free edition only has the in-app console, and 21.1 removed even that)
// The launcher below turns every one of those conditions into a distinct, readable failure instead of a stack trace.
// The plumbing (launcher, environment, exit codes, error messages) IS tested here, with a stand-in DaVinciResolveScript module run by a real Python.
"use strict";

const fs = require("fs");
const path = require("path");

const SAFE_PATH = /^[^\0\r\n"%`$!;]+$/; // paths are always put inside double quotes, where & | < > ^ are plain characters (a Windows user name can contain "&"); a quote, %, $, !, ` or ; is still refused
const EXIT = { NOT_INSTALLED: 4, NOT_RUNNING: 3 };

/** Where the scripting API is, per the documentation. Environment variables set by the user win. */
function findResolve({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  let api, lib;
  if (platform === "win32") {
    api = path.win32.join(env.PROGRAMDATA || "C:\\ProgramData", "Blackmagic Design", "DaVinci Resolve", "Support", "Developer", "Scripting");
    lib = path.win32.join(env.ProgramFiles || "C:\\Program Files", "Blackmagic Design", "DaVinci Resolve", "fusionscript.dll");
  } else if (platform === "darwin") {
    api = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting";
    lib = "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so";
  } else {
    api = "/opt/resolve/Developer/Scripting";
    lib = "/opt/resolve/libs/Fusion/fusionscript.so";
  }
  if (env.RESOLVE_SCRIPT_API) api = env.RESOLVE_SCRIPT_API;
  if (env.RESOLVE_SCRIPT_LIB) lib = env.RESOLVE_SCRIPT_LIB;
  const modules = platform === "win32" ? path.win32.join(api, "Modules") : path.posix.join(api, "Modules");
  const hasApi = exists(modules);
  return { installed: hasApi, scriptApi: api, scriptModules: modules, scriptLib: lib, libExists: exists(lib) };
}

/** The Python file that runs a user's script with `resolve` ready. Paths are passed as JSON strings, so nothing is ever spliced into code. */
function launcherSource({ scriptModules, scriptApi, scriptLib }) {
  return `# written by Noah (Noah/creative/resolve.cjs): runs a script against the running DaVinci Resolve
import os, sys, runpy, traceback
os.environ["RESOLVE_SCRIPT_API"] = ${JSON.stringify(scriptApi)}
os.environ["RESOLVE_SCRIPT_LIB"] = ${JSON.stringify(scriptLib)}
sys.path.append(${JSON.stringify(scriptModules)})
try:
    import DaVinciResolveScript as dvr_script
except Exception as e:
    print("NOAH_RESOLVE_NOT_INSTALLED: could not import DaVinciResolveScript (" + str(e) + ")")
    sys.exit(${EXIT.NOT_INSTALLED})
resolve = dvr_script.scriptapp("Resolve")
if resolve is None:
    print("NOAH_RESOLVE_NOT_RUNNING: DaVinci Resolve did not answer")
    sys.exit(${EXIT.NOT_RUNNING})
print("NOAH_RESOLVE_CONNECTED", resolve.GetVersionString() if hasattr(resolve, "GetVersionString") else "")
target = sys.argv[1]
sys.argv = [target] + sys.argv[2:]
runpy.run_path(target, init_globals={"resolve": resolve, "dvr_script": dvr_script}, run_name="__main__")
`;
}

/** The command line, or { error }. */
function buildCommand({ python = "python", script, options = [], launcher }) {
  for (const [label, v] of [["script", script], ["launcher", launcher]]) if (!v || !SAFE_PATH.test(String(v))) return { error: `the ${label} path is missing or contains a character that is not allowed (quotes, & | < > ^ % $ ! ; or a line break)` };
  if (!/\.py$/i.test(script)) return { error: "script must be a Python file (.py) inside the workspace: write it first with fs_write" };
  for (const a of options) if (!/^[\w.:=,+@#\/\\ -]+$/.test(String(a))) return { error: `the option "${String(a).slice(0, 40)}" contains a character that is not allowed` };
  const q = (s) => `"${s}"`;
  return { cmd: [python, q(launcher), q(script), ...options.map((a) => (/ /.test(a) ? q(a) : a))].join(" ") };
}

/** Turn the launcher's exit code into the one thing the user has to do. */
function explain(exitCode, output = "") {
  const text = String(output);
  if (exitCode === EXIT.NOT_RUNNING || /NOAH_RESOLVE_NOT_RUNNING/.test(text)) {
    return { code: "resolve_not_running", message: "DaVinci Resolve did not answer. Open DaVinci Resolve (the STUDIO edition: the free edition has no external scripting) and switch on Preferences > System > General > \"External scripting using\" = Local, then try again. If it cannot be done, say so and offer an ffmpeg-based edit instead." };
  }
  if (exitCode === EXIT.NOT_INSTALLED || /NOAH_RESOLVE_NOT_INSTALLED/.test(text)) {
    return { code: "resolve_not_installed", message: "The DaVinci Resolve scripting module could not be loaded: Resolve is probably not installed on this computer (or Python could not find it). Tell the user, and offer an ffmpeg-based edit instead." };
  }
  return null;
}

/**
 * The resolve_run tool: run a Python script against the running DaVinci Resolve, through the mission's shell tool.
 * @param {{ shell: object, workspace: object, resolveInfo?: object, python?: string }} t  the tool registry
 */
async function runResolve(t, { script, options = "", cwd, timeoutMs, retry }, { signal } = {}) {
  const info = t.resolveInfo !== undefined ? t.resolveInfo : findResolve();
  if (!info || !info.installed) {
    return { ok: false, code: "resolve_not_installed", message: `DaVinci Resolve's scripting files were not found (looked in ${info ? info.scriptModules : "the usual places"}). Resolve (Studio edition) is not installed here. Tell the user, and offer an ffmpeg-based edit instead.` };
  }
  const real = t.workspace.resolve(cwd || ".");
  try { fs.accessSync(path.resolve(real, script)); } catch (_) { return { ok: false, code: "invalid_path", message: `the script ${script} does not exist: write it with fs_write first` }; }
  const dir = path.join(real, ".noah");
  const launcher = path.join(".noah", "resolve_launch.py");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(real, launcher), launcherSource(info));
  const built = buildCommand({ python: t.python || "python", script, options: String(options || "").split(/\s+/).filter(Boolean), launcher });
  if (built.error) return { ok: false, code: "invalid_arguments", message: built.error };
  const r = await t.shell.run({ cmd: built.cmd, cwd, timeoutMs: timeoutMs || 300_000, retry: !!retry }, { signal });
  const connected = /NOAH_RESOLVE_CONNECTED\s*(.*)/.exec(r.output || "");
  if (!r.ok) {
    const why = explain(r.exitCode, r.output);
    if (why) return { ...r, ...why };
    return { ...r, resolveConnected: !!connected };
  }
  return { ...r, resolveConnected: true, resolveVersion: connected && connected[1] ? connected[1].trim() : null };
}

module.exports = { findResolve, launcherSource, buildCommand, explain, runResolve, EXIT };
