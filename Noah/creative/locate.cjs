// Noah/creative/locate.cjs - find an external program reliably, and PROVE it is the program (it must answer its version command).
//
// Order: an explicit setting (environment variable such as FFMPEG_PATH) -> the process PATH -> the usual install places (including WinGet and
// "C:\ffmpeg*\bin" style unzip folders) -> a copy bundled with Jonah (ffmpeg-static). A candidate that does not answer is skipped, never trusted.
// The answer is cached; `forget()` makes the next call look again (a program installed or moved while Jonah was running).
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const cache = new Map();

/** Where Noah keeps what it installed itself (portable programs, its Python environment). The app sets NOAH_DEPS_DIR; otherwise a folder in the user's profile. */
function depsRoot(env = process.env) {
  return env.NOAH_DEPS_DIR || path.join(require("os").homedir(), ".jonah-noah", "deps");
}

/** Look for `<name>.exe` (or `<name>`) in the programs Noah installed itself, at most 4 folders deep. */
function portableFind(name, { root = depsRoot(), platform = process.platform } = {}) {
  const base = path.join(root, "programs");
  const want = platform === "win32" ? [`${name}.exe`] : [name, `${name}.AppImage`];
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of names) {
      const p = path.join(dir, e.name);
      if (e.isFile() && want.includes(e.name)) out.push(p);
      else if (e.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(base, 0);
  return out;
}

/** Run `<exe> <versionArg>` and return the first line of output, or null. */
function versionOf(exe, versionArg = "-version", { spawn = spawnSync } = {}) {
  try {
    const r = spawn(exe, [versionArg], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    const line = String(r.stdout || r.stderr || "").split(/\r?\n/).find((l) => l.trim());
    return line ? line.trim() : null;
  } catch (_) {
    return null;
  }
}

function listDir(dir) {
  try { return fs.readdirSync(dir); } catch (_) { return []; }
}

/** Places a program of this name is usually found on Windows, as ordered candidates (nothing is checked here). */
function windowsCandidates(name, env) {
  const exe = `${name}.exe`;
  const out = [];
  const local = env.LOCALAPPDATA;
  const roots = ["C:\\", env.SystemDrive ? `${env.SystemDrive}\\` : null].filter(Boolean);
  for (const root of new Set(roots)) {
    for (const d of listDir(root)) if (/^ffmpeg/i.test(d)) out.push(path.win32.join(root, d, "bin", exe), path.win32.join(root, d, exe)); // an unzipped release
    out.push(path.win32.join(root, name, "bin", exe));
  }
  for (const pf of [env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files"].filter(Boolean)) {
    out.push(path.win32.join(pf, name, "bin", exe), path.win32.join(pf, "FFmpeg", "bin", exe));
  }
  if (local) {
    const winget = path.win32.join(local, "Microsoft", "WinGet", "Packages");
    for (const pkg of listDir(winget)) {
      if (!/ffmpeg/i.test(pkg)) continue;
      out.push(path.win32.join(winget, pkg, exe));
      for (const sub of listDir(path.win32.join(winget, pkg))) out.push(path.win32.join(winget, pkg, sub, "bin", exe));
    }
    out.push(path.win32.join(local, "Microsoft", "WinGet", "Links", exe));
  }
  out.push(path.win32.join("C:\\ProgramData", "chocolatey", "bin", exe));
  return out;
}

/** The Jonah-bundled ffmpeg (the ffmpeg-static package), when the tool asked for is ffmpeg. */
function bundled(name) {
  if (name !== "ffmpeg") return [];
  try { return [require("ffmpeg-static")].filter(Boolean).map((p) => String(p).replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep)); } catch (_) { return []; }
}

/**
 * @param {string} name  "ffmpeg" | "ffprobe" | ...
 * @param {object} [o]
 * @returns {{ path: string, version: string, source: string, tried: string[] } | null}
 */
function findTool(name, { platform = process.platform, env = process.env, exists = fs.existsSync, versionArg = "-version", useCache = true, spawn = spawnSync, extra = [] } = {}) {
  const key = `${platform}:${name}`;
  if (useCache && cache.has(key)) {
    const hit = cache.get(key);
    if (hit && exists(hit.path)) return hit;
    cache.delete(key);
  }
  const candidates = [];
  const setting = env[`${name.toUpperCase()}_PATH`];
  if (setting) candidates.push({ p: setting, source: `${name.toUpperCase()}_PATH setting` });
  for (const p of extra) candidates.push({ p, source: "configured" });
  const onPath = String(env.PATH || env.Path || "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  for (const d of onPath) candidates.push({ p: path.join(d, platform === "win32" ? `${name}.exe` : name), source: "PATH" });
  if (platform === "win32") for (const p of windowsCandidates(name, env)) candidates.push({ p, source: "install location" });
  else for (const d of ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/snap/bin"]) candidates.push({ p: path.join(d, name), source: "install location" });
  for (const p of portableFind(name, { platform })) candidates.push({ p, source: "installed by Noah" });
  for (const p of bundled(name)) candidates.push({ p, source: "bundled with Jonah" });

  const tried = [];
  const seen = new Set();
  for (const c of candidates) {
    const k = c.p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if (!exists(c.p)) continue;
    const version = versionOf(c.p, versionArg, { spawn });
    tried.push(`${c.p}: ${version ? "ok" : "did not answer"}`);
    if (version) {
      const found = { path: c.p, version, source: c.source, tried };
      if (useCache) cache.set(key, found);
      return found;
    }
  }
  return null;
}

function forget(name) {
  if (!name) cache.clear();
  else for (const k of [...cache.keys()]) if (k.endsWith(`:${name}`)) cache.delete(k);
}

module.exports = { findTool, versionOf, forget, depsRoot, portableFind };
