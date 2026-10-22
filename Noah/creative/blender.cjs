// Noah/creative/blender.cjs - Blender, driven the way Blender's own manual recommends for automation: headless (`--background`), from a Python script (`--python`),
// with `--python-exit-code` so a script error is a failed run and not a silent success, and `--factory-startup` so the user's add-ons and settings cannot change the result.
// (https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html)
//
// This module only finds Blender, builds the command line and checks what the run produced; the command itself is run by the mission's ShellTool, so the same
// environment scrubbing, timeout, process-tree kill, logging and command policy apply as for any other command.
"use strict";

const fs = require("fs");
const path = require("path");

const SAFE_PATH = /^[^\0\r\n"%`$!;]+$/; // paths are always put inside double quotes, where & | < > ^ are plain characters (a Windows user name can contain "&"); a quote, %, $, !, ` or ; is still refused

/** Where Blender is, or null. BLENDER_PATH (a file) wins, then the usual install places, newest version first. */
function findBlender({ platform = process.platform, env = process.env, exists = fs.existsSync, readdir = (d) => fs.readdirSync(d) } = {}) {
  if (env.BLENDER_PATH && exists(env.BLENDER_PATH)) return env.BLENDER_PATH;
  const versions = (dir) => { try { return readdir(dir).filter((n) => /^Blender\b/i.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); } catch (_) { return []; } };
  const found = [];
  if (platform === "win32") {
    for (const root of [env.ProgramFiles || "C:\\Program Files", env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs")].filter(Boolean)) {
      const base = path.join(root, "Blender Foundation");
      for (const v of versions(base)) found.push(path.join(base, v, "blender.exe"));
    }
    // a Steam install
    found.push(path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Steam", "steamapps", "common", "Blender", "blender.exe"));
  } else if (platform === "darwin") {
    found.push("/Applications/Blender.app/Contents/MacOS/Blender", path.join(env.HOME || "", "Applications/Blender.app/Contents/MacOS/Blender"));
  } else {
    found.push("/usr/bin/blender", "/usr/local/bin/blender", "/snap/bin/blender", "/opt/blender/blender");
  }
  for (const p of found) if (exists(p)) return p;
  try { for (const p of require("./locate.cjs").portableFind("blender", { platform })) if (exists(p)) return p; } catch (_) { /* none */ }
  const onPath = (env.PATH || env.Path || "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  for (const d of onPath) {
    const p = path.join(d, platform === "win32" ? "blender.exe" : "blender");
    if (exists(p)) return p;
  }
  return null;
}

/** The command line, or { error }. `script` and `blend` are paths inside the workspace; `args` are extra Blender options after the script (a script reads them after "--"). */
function buildCommand({ exe, script, blend, args = [], platform = process.platform }) {
  if (!exe) return { error: "Blender is not installed (or not found). Install it from blender.org, or set BLENDER_PATH to its executable." };
  for (const [label, v] of [["script", script], ["blend", blend], ["exe", exe]]) {
    if (v !== undefined && v !== null && v !== "" && !SAFE_PATH.test(String(v))) return { error: `the ${label} path contains a character that is not allowed (quotes, & | < > ^ % $ ! ; or a line break)` };
  }
  for (const a of args) if (!/^[\w.:=,+@#\/\\ -]+$/.test(String(a))) return { error: `the extra argument "${String(a).slice(0, 40)}" contains a character that is not allowed` };
  if (!script || !/\.py$/i.test(script)) return { error: "script must be a Python file (.py) inside the workspace: write it first with fs_write" };
  const q = (s) => `"${s}"`;
  const parts = [q(exe), "--background", "--factory-startup", "--python-exit-code", "1"];
  if (blend) parts.push(q(blend));
  parts.push("--python", q(script));
  if (args.length) parts.push("--", ...args.map((a) => (/[ ]/.test(a) ? q(a) : a)));
  return { cmd: parts.join(" ") };
}

/** Files Blender says it saved ("Saved: 'C:\\x\\frame.png'") and the version line, from its output. */
function parseOutput(text) {
  const out = String(text || "");
  const saved = [...out.matchAll(/Saved:\s*['"](.+?)['"]\s*$/gm)].map((m) => m[1]);
  const version = (/^Blender\s+(\d+\.\d+(?:\.\d+)?)/m.exec(out) || [])[1] || null;
  const scriptError = /Traceback \(most recent call last\)|Error: Python:|^Error: /m.test(out);
  return { saved: [...new Set(saved)], version, scriptError };
}

/** What a produced file really is: size, and for PNG/JPEG the pixel size. A zero-byte or unreadable file is reported as such, never as a success. */
function inspectFile(file, { stat = fs.statSync, read = (f, n) => { const fd = fs.openSync(f, "r"); try { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, got); } finally { fs.closeSync(fd); } } } = {}) {
  try {
    const st = stat(file);
    const info = { path: file, bytes: st.size };
    const head = st.size ? read(file, 32) : Buffer.alloc(0);
    if (head.length >= 24 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) { info.kind = "png"; info.width = head.readUInt32BE(16); info.height = head.readUInt32BE(20); }
    else if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8) info.kind = "jpeg";
    else if (/\.blend$/i.test(file) && head.subarray(0, 7).toString("latin1") === "BLENDER") info.kind = "blend";
    info.valid = st.size > 0;
    return info;
  } catch (err) {
    return { path: file, bytes: 0, valid: false, error: err.code || String(err.message || err).slice(0, 80) };
  }
}

module.exports = { findBlender, buildCommand, parseOutput, inspectFile };

/**
 * The blender_run tool: run a Python script in headless Blender through the mission's shell tool, then CHECK what came out.
 * @param {{ shell: object, workspace: object, blenderPath?: string|null }} t  the tool registry
 */
async function runBlender(t, { script, code, blend, options = "", cwd, timeoutMs, retry }, { signal } = {}) {
  const args = String(options || "").split(/\s+/).filter(Boolean);
  let exe = t.blenderPath !== undefined ? t.blenderPath : findBlender();
  if (!exe && t.blenderPath === undefined) { // not installed: get it (Noah/creative/deps.cjs), then carry on
    const got = await require("./deps.cjs").ensureProgram(t, "blender", { signal, why: "Noah needs Blender for this 3D task and it is not installed." });
    if (!got.ok) return { ok: false, code: got.code === "user_denied" ? "user_denied" : "blender_not_found", message: got.message };
    exe = got.path;
  }
  const real = t.workspace.resolve(cwd || ".");
  // Inline code is NEVER given to Blender as `--python -c ...` (Blender's --python takes a FILE): it is written to a file of its own and that file is run.
  let inlineFile = null;
  if (code !== undefined && code !== null && String(code).trim()) {
    if (script) return { ok: false, code: "invalid_arguments", message: "give either script (a .py file) or code (Python text), not both" };
    const dir = path.join(real, ".noah");
    fs.mkdirSync(dir, { recursive: true });
    script = path.join(".noah", `inline_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}.py`);
    inlineFile = path.join(real, script);
    fs.writeFileSync(inlineFile, String(code).endsWith("\n") ? String(code) : `${code}\n`);
    if (!fs.existsSync(inlineFile) || fs.statSync(inlineFile).size === 0) return { ok: false, code: "tool_error", message: "the inline script could not be written" };
  }
  const built = buildCommand({ exe, script, blend, args });
  if (built.error) return { ok: false, code: exe ? "invalid_arguments" : "blender_not_found", message: built.error };
  try { fs.accessSync(path.resolve(real, script)); } catch (_) { return { ok: false, code: "invalid_path", message: `the script ${script} does not exist: write it with fs_write first` }; }
  const r = await t.shell.run({ cmd: built.cmd, cwd, timeoutMs: timeoutMs || 300_000, retry: !!retry }, { signal });
  if (inlineFile && r.ok) { try { fs.unlinkSync(inlineFile); } catch (_) { /* a leftover temp file is harmless */ } }
  else if (inlineFile) r.inlineScript = path.relative(real, inlineFile); // kept for diagnosis when it failed
  const seen = parseOutput(r.output);
  const renders = seen.saved.map((p) => inspectFile(path.resolve(real, p)));
  const result = { ...r, blenderVersion: seen.version, renders };
  if (r.ok) {
    const bad = renders.filter((x) => !x.valid);
    if (bad.length) return { ...result, ok: false, code: "empty_output", message: `Blender finished but ${bad.length} file${bad.length > 1 ? "s it reported saving are" : " it reported saving is"} missing or empty: ${bad.map((b) => b.path).join(", ")}` };
    if (seen.scriptError) result.warning = "Blender's output contains an error message even though it exited normally: read the output before trusting the result.";
  }
  return result;
}

module.exports.runBlender = runBlender;

/**
 * A command line that hands Blender `--python -c ...` (the plain-Python habit): Blender's --python option opens a FILE called "-c" and fails with
 * 'Python file "...\-c" could not be opened'. Returns the explanation, or null. (`--python-expr "code"` IS valid and is not flagged.)
 */
function detectPythonFlagMisuse(cmd) {
  const s = String(cmd || "");
  if (!/blender(?:-launcher)?(?:\.exe)?["']?\s/i.test(s)) return null;
  if (/(?:--python|-P)\s+["']?-c(?:["'\s]|$)/i.test(s)) {
    return "Blender's --python option takes a FILE, not code, so `--python -c \"...\"` fails (it tries to open a file named -c). Use the blender_run tool with `code` (inline Python) or `script` (a .py file), or write the code to a .py file and run `blender --background --python file.py`. For a one-line expression the valid option is `--python-expr \"...\"`.";
  }
  return null;
}

/** The Python that imports ONE file into an empty scene and prints what is really in it as a single JSON line. Reads the file path from sys.argv after "--". */
const EXPORT_REPORT_SCRIPT = [
  "import bpy, sys, json, os",
  "from mathutils import Vector",
  "path = sys.argv[sys.argv.index('--') + 1]",
  "ext = os.path.splitext(path)[1].lower()",
  "report = {'file': path, 'ext': ext, 'bytes': os.path.getsize(path) if os.path.exists(path) else 0}",
  "IMPORTERS = {",
  "  '.glb': ('import_scene', 'gltf'), '.gltf': ('import_scene', 'gltf'), '.fbx': ('import_scene', 'fbx'),",
  "  '.obj': ('wm', 'obj_import'), '.stl': ('wm', 'stl_import'), '.ply': ('wm', 'ply_import'),",
  "  '.usd': ('wm', 'usd_import'), '.usda': ('wm', 'usd_import'), '.usdc': ('wm', 'usd_import'), '.usdz': ('wm', 'usd_import'),",
  "  '.abc': ('wm', 'alembic_import'),",
  "}",
  "try:",
  "    if ext == '.blend':",
  "        bpy.ops.wm.open_mainfile(filepath=path)",
  "    else:",
  "        bpy.ops.wm.read_factory_settings(use_empty=True)",
  "        if ext not in IMPORTERS:",
  "            raise RuntimeError('no importer for ' + ext)",
  "        grp, name = IMPORTERS[ext]",
  "        op = getattr(getattr(bpy.ops, grp), name)",
  "        op(filepath=path)",
  "    objs = list(bpy.context.scene.objects) if ext != '.blend' else list(bpy.data.objects)",
  "    meshes = [o for o in objs if o.type == 'MESH']",
  "    lo = Vector((1e18, 1e18, 1e18)); hi = Vector((-1e18, -1e18, -1e18))",
  "    for o in meshes:",
  "        for c in o.bound_box:",
  "            w = o.matrix_world @ Vector(c)",
  "            lo = Vector((min(lo[i], w[i]) for i in range(3))); hi = Vector((max(hi[i], w[i]) for i in range(3)))",
  "    report.update({",
  "        'ok': True,",
  "        'blender': bpy.app.version_string,",
  "        'objects': len(objs),",
  "        'types': {t: sum(1 for o in objs if o.type == t) for t in sorted(set(o.type for o in objs))},",
  "        'meshObjects': len(meshes),",
  "        'vertices': sum(len(o.data.vertices) for o in meshes),",
  "        'faces': sum(len(o.data.polygons) for o in meshes),",
  "        'materials': sorted(set(m.name for o in meshes for m in (s.material for s in o.material_slots) if m)),",
  "        'images': sorted(set(i.name for i in bpy.data.images if i.name != 'Render Result')),",
  "        'uvMaps': sum(1 for o in meshes if len(o.data.uv_layers) > 0),",
  "        'actions': [{'name': a.name, 'frames': [round(a.frame_range[0], 2), round(a.frame_range[1], 2)]} for a in bpy.data.actions],",
  "        'size': [round(hi[i] - lo[i], 4) for i in range(3)] if meshes else None,",
  "    })",
  "except Exception as e:",
  "    report.update({'ok': False, 'error': type(e).__name__ + ': ' + str(e)[:300]})",
  "print('NOAH_EXPORT_REPORT ' + json.dumps(report))",
  "",
].join("\n");

/**
 * The blender_verify_export tool: open an exported file again in a CLEAN Blender and report what survived (objects, geometry, materials, UVs, animation, size).
 * An exporter that said "success" is not evidence: this is.
 */
async function verifyExport(t, { path: file, cwd }, { signal } = {}) {
  let exe = t.blenderPath !== undefined ? t.blenderPath : findBlender();
  if (!exe && t.blenderPath === undefined) {
    const got = await require("./deps.cjs").ensureProgram(t, "blender", { signal, why: "Noah needs Blender to check the exported file and it is not installed." });
    if (got.ok) exe = got.path; else return { ok: false, code: got.code === "user_denied" ? "user_denied" : "blender_not_found", message: got.message };
  }
  if (!exe) return { ok: false, code: "blender_not_found", message: "Blender is not installed (or not found), so the export cannot be checked by re-importing it" };
  const real = t.workspace.resolve(cwd || ".");
  const abs = path.resolve(real, file);
  if (!fs.existsSync(abs)) return { ok: false, code: "missing", message: `${file} does not exist, so it was not exported` };
  if (fs.statSync(abs).size === 0) return { ok: false, code: "empty", message: `${file} is empty (0 bytes)` };
  const dir = path.join(real, ".noah");
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(".noah", "verify_export.py");
  fs.writeFileSync(path.join(real, script), EXPORT_REPORT_SCRIPT);
  const built = buildCommand({ exe, script, args: [], platform: process.platform });
  if (built.error) return { ok: false, code: "invalid_arguments", message: built.error };
  // the file to check goes after "--"; it is validated like every other path that reaches a command line
  if (!SAFE_PATH.test(abs)) return { ok: false, code: "invalid_arguments", message: "the file path contains a character that is not allowed (quotes, & | < > ^ % $ ! ; or a line break)" };
  const r = await t.shell.run({ cmd: `${built.cmd} -- "${abs}"`, cwd, timeoutMs: 180_000, retry: true }, { signal });
  const m = /NOAH_EXPORT_REPORT (\{.*\})/.exec(String(r.output || ""));
  if (!m) return { ...r, ok: false, code: r.code || "no_report", message: r.message || "Blender did not report on the file" };
  let report;
  try { report = JSON.parse(m[1]); } catch (_) { return { ok: false, code: "no_report", message: "the report from Blender was unreadable" }; }
  if (!report.ok) return { ok: false, code: "import_failed", message: `Blender could not import ${file}: ${report.error}`, report };
  const problems = [];
  if (report.ext !== ".blend" && report.meshObjects === 0 && !(report.types && (report.types.EMPTY || report.types.ARMATURE))) problems.push("the file imported but contains no mesh");
  return { ok: problems.length === 0, report, problems, ...(problems.length ? { code: "export_problem", message: problems.join("; ") } : {}) };
}

module.exports.detectPythonFlagMisuse = detectPythonFlagMisuse;
module.exports.verifyExport = verifyExport;
module.exports.EXPORT_REPORT_SCRIPT = EXPORT_REPORT_SCRIPT;
