// Noah/creative/runtimes.cjs - which program and which Python is which, with the facts that decide whether a package can work there.
//
// The lesson behind it: `pip install opencv-python` into the system Python says nothing about Blender, which has its OWN Python (and its own NumPy).
// A package is usable by a program only if THAT program's interpreter can import it. So the inventory records, per runtime, the interpreter,
// its version and architecture, where it looks for packages and whether NumPy / OpenCV import there. It only READS: nothing is installed or replaced.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { findTool } = require("./locate.cjs");
const { findBlender } = require("./blender.cjs");
const { findResolve } = require("./resolve.cjs");

const PROBE = [
  "import sys, json, struct, site",
  "out = {'version': sys.version.split()[0], 'executable': sys.executable, 'bits': struct.calcsize('P') * 8, 'userSite': getattr(site, 'ENABLE_USER_SITE', None)}",
  "for name in ('numpy', 'cv2', 'PIL'):",
  "    try:",
  "        m = __import__(name)",
  "        out[name] = getattr(m, '__version__', 'unknown')",
  "    except Exception as e:",
  "        out[name] = None",
  "        out[name + 'Error'] = type(e).__name__ + ': ' + str(e)[:120]",
  "print(json.dumps(out))",
].join("\n");

/** Ask an interpreter about itself. Returns null when it cannot run. Arguments go as a list (no shell), the code as a string. */
function probePython(exe, { spawn = spawnSync } = {}) {
  if (!exe) return null;
  try {
    const r = spawn(exe, ["-c", PROBE], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    const line = String(r.stdout || "").trim().split(/\r?\n/).pop();
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

/** Blender's own interpreter: <install>/<major.minor>/python/bin/python(.exe). */
function blenderPython(blenderExe, { exists = fs.existsSync, readdir = (d) => fs.readdirSync(d), platform = process.platform } = {}) {
  if (!blenderExe) return null;
  const root = path.dirname(blenderExe);
  const bin = platform === "win32" ? "python.exe" : "python3.11";
  let versions = [];
  try { versions = readdir(root).filter((n) => /^\d+\.\d+$/.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); } catch (_) { /* not an install folder */ }
  for (const v of versions) {
    for (const rel of [path.join(v, "python", "bin", bin), path.join(v, "python", "bin", "python3"), path.join(v, "python", "bin", "python")]) {
      const p = path.join(root, rel);
      if (exists(p)) return p;
    }
  }
  return null;
}

function systemPython({ platform = process.platform, spawn = spawnSync } = {}) {
  for (const exe of platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const args = exe === "py" ? ["-3", "-c", PROBE] : ["-c", PROBE];
    try {
      const r = spawn(exe, args, { encoding: "utf8", timeout: 30_000, windowsHide: true });
      if (!r.error && r.status === 0) return JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop());
    } catch (_) { /* try the next */ }
  }
  return null;
}

function gpuNames({ platform = process.platform, spawn = spawnSync } = {}) {
  if (platform !== "win32") return null;
  try {
    const r = spawn("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join '|'"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
    return r.status === 0 ? String(r.stdout).trim().split("|").filter(Boolean) : null;
  } catch (_) { return null; }
}

/** Everything the creative tools need to know about this computer, as plain data. */
function inventory(opts = {}) {
  const blender = findBlender();
  const bpy = blenderPython(blender);
  const ffmpeg = findTool("ffmpeg", { useCache: false });
  const ffprobe = findTool("ffprobe", { useCache: false });
  const resolve = findResolve();
  const sys = systemPython(opts);
  const bl = bpy ? probePython(bpy, opts) : null;
  return {
    at: new Date().toISOString(),
    computer: { platform: process.platform, release: os.release(), arch: os.arch(), memoryGB: Math.round((os.totalmem() / 1073741824) * 10) / 10, gpus: gpuNames(opts) },
    blender: blender ? { path: blender, python: bpy ? { path: bpy, ...bl } : null } : null,
    ffmpeg: ffmpeg ? { path: ffmpeg.path, version: ffmpeg.version, source: ffmpeg.source } : null,
    ffprobe: ffprobe ? { path: ffprobe.path, version: ffprobe.version } : null,
    systemPython: sys,
    resolve: { scriptingFilesFound: resolve.installed, scriptModules: resolve.scriptModules },
    notes: notes({ blender, bl, sys, ffmpeg, ffprobe }),
  };
}

/** What follows from the facts, so nobody has to re-derive it (and nobody force-installs into the wrong place). */
function notes({ blender, bl, sys, ffmpeg, ffprobe }) {
  const n = [];
  if (blender && bl && !bl.cv2) {
    n.push("OpenCV (cv2) is not importable in Blender's own Python. Do not replace Blender's NumPy. Run OpenCV work in a separate Python process" +
      (sys && sys.cv2 ? ` (the system Python ${sys.version} has cv2 ${sys.cv2}; python_run with packages=opencv uses Noah's own environment and downloads it if it is missing) and exchange images or data as files.` : " (python_run with packages=opencv downloads it into Noah's own environment, not into Blender) and exchange images or data as files."));
  }
  if (blender && bl && sys && bl.numpy && sys.numpy && bl.numpy.split(".")[0] !== sys.numpy.split(".")[0]) n.push(`NumPy major versions differ (Blender ${bl.numpy}, system ${sys.numpy}): compiled packages are not interchangeable between the two.`);
  if (bl && sys && bl.version.split(".").slice(0, 2).join(".") !== sys.version.split(".").slice(0, 2).join(".")) n.push(`Python versions differ (Blender ${bl.version}, system ${sys.version}): a compiled package for one does not load in the other.`);
  if (ffmpeg && !ffprobe) n.push("ffprobe was not found next to FFmpeg: media can be encoded but not inspected.");
  if (!ffmpeg) n.push("FFmpeg was not found: video encoding and checking are unavailable.");
  return n;
}

module.exports = { inventory, probePython, blenderPython, systemPython, gpuNames, notes };
