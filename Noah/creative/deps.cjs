// Noah/creative/deps.cjs - ONE way for every tool to get what it needs, whatever the application.
//
// When a tool finds that a program is missing (Blender, FFmpeg, Python, ImageMagick, ...) or that a Python package is missing (OpenCV, Pillow, ...), it
// does not stop with "not installed": it asks this module, which
//   1. checks that the thing really is absent (the same locators the tools use),
//   2. plans the install from the OFFICIAL route for this computer: winget (Windows), Homebrew (macOS), apt (Linux) for programs; pip into Noah's own
//      virtual environment for Python packages (never into the system Python, never into another program's bundled Python, so nothing is replaced),
//   3. decides consent: a known catalog entry installs by itself in autonomous mode; an unknown program, a supervised/strict mode, or a source
//      distribution (which runs build code) puts a confirmation card to the user first,
//   4. runs it through the mission's shell tool (scrubbed environment, timeout, process-tree kill, logged),
//   5. looks again and only then says it is installed, and records it in a manifest.
// A failed install is reported once with its reason and is not retried in a loop.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { findTool, forget } = require("./locate.cjs");

const SAFE = /^[^\0\r\n"%`$!;]+$/; // always double-quoted on the command line
const PKG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const PKG_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}(==[0-9][A-Za-z0-9.!+_-]{0,30})?$/;
const ALIASES = { cv2: "opencv-python-headless", opencv: "opencv-python-headless", "opencv-python": "opencv-python-headless", pil: "pillow", yaml: "pyyaml", sklearn: "scikit-learn", skimage: "scikit-image", bs4: "beautifulsoup4" };

// ---------------------------------------------------------------- programs

/**
 * What can be installed by name, and how. `portable` is the route that needs NO package manager and NO administrator: a vendor's own zip, downloaded over HTTPS,
 * checked against a SHA-256 (pinned here, or published by the vendor next to the file), unpacked into Noah's own folder. It is what makes this work on a PC without winget.
 * @type {Record<string, object>}
 */
function catalog(deps = {}) {
  const { findBlender } = deps.blender || require("./blender.cjs");
  const detectTool = (name, arg) => () => { const f = findTool(name, { useCache: false, ...(arg ? { versionArg: arg } : {}) }); return f ? { path: f.path, version: f.version } : null; };
  const GYAN = { url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip", sha256Url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256", version: "release", host: "gyan.dev" };
  const BL = "https://download.blender.org/release/Blender5.2/blender-5.2.2-windows";
  return {
    ffmpeg: { label: "FFmpeg", detect: detectTool("ffmpeg"), winget: "Gyan.FFmpeg", brew: "ffmpeg", apt: "ffmpeg", sizeMB: 200, source: "the winget community repository (Gyan's official Windows builds)", portable: { win32: { x64: GYAN, arm64: GYAN } } },
    ffprobe: { label: "FFmpeg (ffprobe)", detect: detectTool("ffprobe"), winget: "Gyan.FFmpeg", brew: "ffmpeg", apt: "ffmpeg", sizeMB: 200, source: "the winget community repository (Gyan's official Windows builds)", portable: { win32: { x64: GYAN, arm64: GYAN } } },
    blender: { label: "Blender", detect: () => { const p = findBlender(); return p ? { path: p } : null; }, winget: "BlenderFoundation.Blender", brew: "blender", brewCask: true, apt: "blender", sizeMB: 400, source: "download.blender.org (the Blender Foundation's installer, through winget)",
      portable: { win32: {
        x64: { url: `${BL}-x64.zip`, sha256: "3849d17a682cba006075aaa3f3597ecb5c9c30ec31035b2e092c53e40679b535", version: "5.2.2", host: "download.blender.org" },
        arm64: { url: `${BL}-arm64.zip`, sha256: "2e90b53c9443cc56d2be75a61550a38e4aba942c8cded046ceff98ed58ebc67b", version: "5.2.2", host: "download.blender.org" },
      } } },
    python: { label: "Python 3", detect: () => { const p = findPython(); return p ? { path: p.path, version: p.version } : null; }, winget: "Python.Python.3.12", brew: "python@3.12", apt: "python3", sizeMB: 30, source: "python.org (through winget)" },
    imagemagick: { label: "ImageMagick", detect: detectTool("magick", "-version"), winget: "ImageMagick.ImageMagick", brew: "imagemagick", apt: "imagemagick", sizeMB: 40, source: "imagemagick.org releases (through winget)" },
    "davinci-resolve": { label: "DaVinci Resolve", detect: () => { const r = require("./resolve.cjs").findResolve(); return r.installed ? { path: r.scriptModules } : null; }, sizeMB: 3000, source: "blackmagicdesign.com", manual: "DaVinci Resolve has to be downloaded by you from blackmagicdesign.com/support (it asks for a registration form), and only the Studio edition can be scripted from outside." },
  };
}

/** A usable Python 3 and its version, looking past a stale PATH (a Python installed a moment ago is not on this process's PATH yet). */
function findPython({ platform = process.platform, env = process.env, exists = fs.existsSync, spawn = spawnSync } = {}) {
  const tryExe = (exe, pre = []) => {
    try {
      const r = spawn(exe, [...pre, "-c", "import sys;print(sys.version.split()[0]);print(sys.executable)"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
      if (r.error || r.status !== 0) return null; // the Microsoft Store "python" stub answers with an error code: not a Python
      const [version, executable] = String(r.stdout).trim().split(/\r?\n/);
      return /^3\./.test(version || "") ? { path: executable || exe, version } : null;
    } catch (_) { return null; }
  };
  const cands = platform === "win32" ? [["python", []], ["py", ["-3"]]] : [["python3", []], ["python", []]];
  for (const [exe, pre] of cands) { const r = tryExe(exe, pre); if (r) return r; }
  if (platform === "win32") {
    const roots = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Python"), env.ProgramFiles, env.SystemDrive && `${env.SystemDrive}\\Program Files`].filter(Boolean);
    for (const root of roots) {
      let names = [];
      try { names = fs.readdirSync(root).filter((n) => /^Python3\d+/i.test(n)).sort().reverse(); } catch (_) { /* absent */ }
      for (const n of names) { const p = path.join(root, n, "python.exe"); if (exists(p)) { const r = tryExe(p); if (r) return r; } }
    }
  } else for (const p of ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"]) if (exists(p)) { const r = tryExe(p); if (r) return r; }
  return null;
}

/** Is a command line program there? (`winget --version`, `brew --version`.) */
function haveCommand(cmd, { spawn = spawnSync } = {}) {
  try {
    const r = spawn(cmd, ["--version"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
    return !r.error && r.status === 0;
  } catch (_) { return false; }
}

/**
 * The ways to install a program on this computer, in the order they will be tried: the package manager when it is there, then the portable download.
 * Returns { entry, methods: [{ method, cmd?, spec?, source }], method, cmd, source } (the first method repeated at top level), or { manual } / { error } / { unknown }.
 */
function planProgram(name, { platform = process.platform, arch = process.arch, haveWinget = null, haveBrew = null } = {}) {
  const entry = catalog()[String(name).toLowerCase()];
  if (!entry) return { unknown: true };
  if (entry.manual) return { entry, manual: entry.manual };
  const methods = [];
  const portable = entry.portable && entry.portable[platform] && (entry.portable[platform][arch] || entry.portable[platform].x64);
  if (platform === "win32") {
    const wingetThere = haveWinget === null ? haveCommand("winget") : haveWinget;
    if (entry.winget && wingetThere) methods.push({ method: "winget", cmd: `winget install --id ${entry.winget} --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity`, source: entry.source });
    if (portable) methods.push({ method: "portable", spec: portable, source: `${portable.host} (the vendor's own download, SHA-256 checked, no administrator needed)` });
    if (!methods.length) {
      return { entry, error: entry.winget
        ? `${entry.label} cannot be installed automatically here: this PC has no winget (it comes with "App Installer" in the Microsoft Store) and ${entry.label} has no direct-download route. Install it yourself (winget id ${entry.winget}), then try again.`
        : `${entry.label} has no automatic Windows install route` };
    }
  } else if (platform === "darwin") {
    const brewThere = haveBrew === null ? haveCommand("brew") : haveBrew;
    if (entry.brew && brewThere) methods.push({ method: "brew", cmd: `brew install ${entry.brewCask ? "--cask " : ""}${entry.brew}`, source: "Homebrew" });
    if (!methods.length) return { entry, error: entry.brew ? `${entry.label} cannot be installed automatically here: Homebrew (brew.sh) is not installed. Install ${entry.label} yourself, then try again.` : `${entry.label} has no automatic macOS install route` };
  } else {
    if (entry.apt) methods.push({ method: "apt", cmd: `sudo -n apt-get install -y ${entry.apt}`, source: "the distribution's package repository (needs sudo without a password prompt)" });
    else return { entry, error: `${entry.label} has no automatic install route here` };
  }
  return { entry, methods, method: methods[0].method, cmd: methods[0].cmd, source: methods[0].source };
}

// ---- the portable download

/** fetch that follows the system proxy inside the app (Electron's network stack), plain fetch otherwise. */
function netFetch() {
  try {
    if (process.versions.electron) { const { net } = require("electron"); if (net && net.fetch) return net.fetch.bind(net); }
  } catch (_) { /* not in Electron */ }
  return globalThis.fetch;
}

function freeBytes(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch (_) { return null; }
}

/** Download `url` to `dest`, hashing as it arrives. Throws a readable Error. */
async function downloadFile(url, dest, { fetchImpl = netFetch(), signal, expectedSha256 = null, minFree = true } = {}) {
  const crypto = require("crypto");
  const { Readable } = require("stream");
  const { pipeline } = require("stream/promises");
  if (!/^https:\/\//i.test(url)) throw new Error("only https downloads are allowed");
  const res = await fetchImpl(url, { signal, redirect: "follow" });
  if (!res.ok) throw new Error(`the download failed: ${res.status} ${res.statusText || ""} from ${new URL(url).host}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (minFree && total) {
    const free = freeBytes(path.dirname(dest));
    if (free !== null && free < total * 2.5) throw new Error(`not enough free disk space: ${Math.round(total / 1048576)} MB to download and unpack, ${Math.round(free / 1048576)} MB free`);
  }
  const hash = crypto.createHash("sha256");
  let got = 0;
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const stages = [
      Readable.fromWeb(res.body),
      async function* (src) { for await (const chunk of src) { hash.update(chunk); got += chunk.length; yield chunk; } },
      fs.createWriteStream(part),
    ];
    if (signal) stages.push({ signal }); // (an options object only when there is one: undefined would be taken for a stream)
    await pipeline(...stages);
  } catch (err) {
    try { fs.rmSync(part, { force: true }); } catch (_) { /* gone */ }
    throw err;
  }
  const digest = hash.digest("hex");
  if (total && got !== total) { fs.rmSync(part, { force: true }); throw new Error(`the download was cut short (${got} of ${total} bytes)`); }
  if (expectedSha256 && digest.toLowerCase() !== String(expectedSha256).toLowerCase()) {
    fs.rmSync(part, { force: true });
    throw new Error(`the downloaded file does not match its published SHA-256 (got ${digest.slice(0, 16)}..., expected ${String(expectedSha256).slice(0, 16)}...): it was discarded`);
  }
  fs.renameSync(part, dest);
  return { bytes: got, sha256: digest };
}

/** Unpack a zip with the system's own tools (tar on Windows 10+/macOS/Linux, PowerShell as the fallback). */
function extractZip(zip, dest, { spawn = spawnSync, platform = process.platform } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  // On Windows the system's own bsdtar reads zip files; a "tar" earlier on PATH (Git for Windows ships GNU tar) does not, so the system one is named in full.
  const tarExe = platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  const tar = spawn(fs.existsSync(tarExe) || platform !== "win32" ? tarExe : "tar", ["-xf", zip, "-C", dest], { encoding: "utf8", timeout: 15 * 60_000, windowsHide: true });
  if (!tar.error && tar.status === 0) return { ok: true, with: "tar" };
  if (platform === "win32") {
    const ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force", zip, dest], { encoding: "utf8", timeout: 15 * 60_000, windowsHide: true });
    if (!ps.error && ps.status === 0) return { ok: true, with: "Expand-Archive" };
    return { ok: false, message: String(ps.stderr || ps.error || tar.stderr || "").trim().slice(0, 300) };
  }
  return { ok: false, message: String(tar.stderr || tar.error || "").trim().slice(0, 300) };
}

/** The portable route: download, verify, unpack into <deps>/programs/<name>-<version>. Returns { ok, dir } or { ok:false, message }. */
async function installPortable(t, key, spec, { signal } = {}) {
  const dl = t.depDownload || downloadFile;
  const dir = path.join(depsDirOf(t), "programs", `${key === "ffprobe" ? "ffmpeg" : key}-${spec.version || "latest"}`);
  if (!SAFE.test(dir)) return { ok: false, message: "the install folder path contains a character that is not allowed" };
  const zip = path.join(depsDirOf(t), "downloads", path.basename(new URL(spec.url).pathname));
  try {
    let sha = spec.sha256 || null;
    if (!sha && spec.sha256Url) { // the vendor publishes the checksum next to the file
      const fetchImpl = t.depFetch || netFetch();
      const r = await fetchImpl(spec.sha256Url, { signal, redirect: "follow" });
      if (!r.ok) throw new Error(`the checksum could not be fetched (${r.status})`);
      const m = /\b([a-f0-9]{64})\b/i.exec(await r.text());
      if (!m) throw new Error("the published checksum was not readable");
      sha = m[1];
    }
    if (!sha) throw new Error("no checksum is known for this download, so it is not trusted");
    await dl(spec.url, zip, { signal, expectedSha256: sha });
    const x = (t.depExtract || extractZip)(zip, dir);
    if (!x.ok) throw new Error(`could not unpack it: ${x.message}`);
    try { fs.rmSync(zip, { force: true }); } catch (_) { /* leave it */ }
    return { ok: true, dir };
  } catch (err) {
    try { fs.rmSync(`${zip}.part`, { force: true }); } catch (_) { /* gone */ }
    return { ok: false, message: String((err && err.message) || err).slice(0, 400) };
  }
}

const inflight = new Map();

/**
 * Make sure a program is present, installing it when it is not.
 * @param {{ shell: object, workspace: object, autoInstall?: boolean, depsDir?: string, depFailures?: Map }} t  the tool registry
 * @returns {Promise<{ ok: boolean, name: string, path?: string, version?: string, installed?: boolean, already?: boolean, code?: string, message?: string }>}
 */
async function ensureProgram(t, name, { signal, why = "" } = {}) {
  const key = String(name || "").toLowerCase();
  if (inflight.has(key)) return inflight.get(key);
  const p = ensureProgramNow(t, key, { signal, why }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function ensureProgramNow(t, key, { signal, why }) {
  const entries = catalog();
  const entry = entries[key];
  const detect = (t.depDetect && t.depDetect[key]) || (entry && entry.detect) || null; // (t.depDetect: tests)
  const platform = t.depPlatform || process.platform;
  const have = detect ? detect() : null;
  if (have) return { ok: true, name: key, already: true, path: have.path, version: have.version };

  if (t.autoInstall === false) return { ok: false, name: key, code: "install_disabled", message: `${entry ? entry.label : key} is not installed, and automatic installs are switched off. Install it yourself, or switch them on.` };
  t.depFailures = t.depFailures || new Map();
  if (t.depFailures.has(key)) return { ok: false, name: key, code: "install_failed_before", message: `${t.depFailures.get(key)} It was not tried again: change something first (a different source, the user's help).` };

  const wingetKnown = typeof t.depWinget === "boolean" ? t.depWinget : null;
  let plan = planProgram(key, { platform, arch: t.depArch || process.arch, haveWinget: wingetKnown, haveBrew: typeof t.depBrew === "boolean" ? t.depBrew : null });
  if (plan.unknown) {
    // not in the catalog: only an exact winget id (Publisher.Package), and ALWAYS with the user's yes
    if (platform === "win32" && /^[A-Za-z0-9]+(\.[A-Za-z0-9-]+)+$/.test(key)) {
      const cmd = `winget install --id ${key} --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity`;
      plan = { entry: { label: key, sizeMB: null }, methods: [{ method: "winget", cmd, source: "the winget community repository" }], method: "winget", cmd, source: "the winget community repository", unlisted: true };
    } else return { ok: false, name: key, code: "unknown_dependency", message: `"${key}" is not a dependency Noah knows how to install by name. Known: ${Object.keys(entries).join(", ")}. For another Windows program give its exact winget id (Publisher.Package); for a Python package use python_run with packages.` };
  }
  if (plan.manual) return { ok: false, name: key, code: "manual_install", message: plan.manual };
  if (plan.error) return { ok: false, name: key, code: "no_install_route", message: plan.error };

  const mode = typeof t.shell.getMode === "function" ? t.shell.getMode() : "autonomous";
  const automatic = mode === "autonomous" && !plan.unlisted;
  if (!automatic) {
    let yes = false;
    try {
      yes = await t.shell.confirm({ summary: `Download and install ${plan.entry.label}${plan.entry.sizeMB ? ` (about ${plan.entry.sizeMB} MB)` : ""} from ${plan.source}`, why: why || `Noah needs ${plan.entry.label} for this task and it is not installed.`, risk: { level: "high", categories: ["system_install"], reasons: ["installs software on this computer"] } });
    } catch (_) { yes = false; }
    if (!yes) return { ok: false, name: key, code: "user_denied", message: `The user declined installing ${plan.entry.label}. Do not install it another way: explain, or stop.` };
  }

  // try each way in turn; the first that leaves the program findable wins
  const failures = [];
  for (const m of plan.methods) {
    if (signal && signal.aborted) return { ok: false, name: key, code: "aborted", message: "stopped before the install finished" };
    let lastOk = false;
    if (m.method === "portable") {
      const r = await installPortable(t, key, m.spec, { signal });
      lastOk = r.ok;
      if (!r.ok) { failures.push(`${m.method}: ${r.message}`); continue; }
    } else {
      const r = await t.shell.run({ cmd: m.cmd, timeoutMs: 600_000, retry: true }, { signal, bypassRepeat: true, preApproved: true });
      lastOk = r.ok;
      if (!r.ok) failures.push(`${m.method}: ${r.code || `exit ${r.exitCode}`}${r.output ? ` (${String(r.output).trim().split(/\r?\n/).slice(-2).join(" | ").slice(0, 200)})` : ""}`);
    }
    forget(); // look again from scratch: the program may be somewhere the earlier lookup could not see
    const now = detect ? detect() : null;
    if (now) {
      record(t, { name: key, label: plan.entry.label, method: m.method, source: m.source, path: now.path, version: now.version });
      return { ok: true, name: key, installed: true, path: now.path, version: now.version, source: m.source, method: m.method };
    }
    if (!detect && lastOk) return { ok: true, name: key, installed: true, unverified: true, source: m.source, method: m.method, message: "the installer reported success; Noah has no check for this program, so look for it before relying on it" };
    if (lastOk) failures.push(`${m.method}: finished, but ${plan.entry.label} still cannot be found (it may need an administrator's confirmation, or a new session)`);
  }
  const reason = `${plan.entry.label} could not be installed automatically. ${failures.join("; ")}`;
  t.depFailures.set(key, reason);
  return { ok: false, name: key, code: "install_failed", message: reason };
}

// ---------------------------------------------------------------- Python packages, in Noah's own environment

function depsDirOf(t) {
  return t.depsDir || process.env.NOAH_DEPS_DIR || path.join(os.homedir(), ".jonah-noah", "deps");
}

/** "cv2, Pillow numpy==2.2.6" -> validated, de-aliased package specs, or { error }. */
function parsePackages(text) {
  const out = [];
  for (const raw of String(text || "").split(/[\s,]+/).filter(Boolean)) {
    const [n, v] = raw.split("==");
    const alias = ALIASES[n.toLowerCase()];
    const spec = `${alias || n}${v ? `==${v}` : ""}`;
    if (!PKG_SPEC.test(spec) || !PKG_NAME.test(alias || n)) return { error: `"${raw}" is not a valid package name (letters, digits . _ - and an optional ==version)` };
    if (!out.includes(spec)) out.push(spec);
  }
  return { packages: out };
}

function venvPython(dir, platform = process.platform) {
  return platform === "win32" ? path.join(dir, "Scripts", "python.exe") : path.join(dir, "bin", "python");
}

/** Create Noah's virtual environment when it does not exist yet. Returns { ok, python } or a failed result. */
async function ensureVenv(t, { signal } = {}) {
  const dir = path.join(depsDirOf(t), "venv");
  const py = venvPython(dir);
  if (fs.existsSync(py)) return { ok: true, python: py, dir };
  if (!SAFE.test(dir)) return { ok: false, code: "invalid_path", message: "the environment folder path contains a character that is not allowed" };
  const base = await ensureProgram(t, "python", { signal, why: "Noah needs Python to run scripts that use Python packages." });
  if (!base.ok) return base;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = await t.shell.run({ cmd: `"${base.path}" -m venv "${dir}"`, timeoutMs: 300_000, retry: true }, { signal, bypassRepeat: true, preApproved: true });
  if (!fs.existsSync(py)) return { ok: false, code: "venv_failed", message: `could not create Noah's Python environment in ${dir}: ${String(r.output || r.message || "").trim().slice(-300)}` };
  return { ok: true, python: py, dir, created: true };
}

/**
 * Make sure Python packages are importable in Noah's environment (installing wheels only: no build code runs).
 * @returns {Promise<{ ok: boolean, python?: string, packages?: string[], installed?: string[], code?: string, message?: string }>}
 */
async function ensurePackages(t, packagesText, { signal } = {}) {
  const parsed = parsePackages(packagesText);
  if (parsed.error) return { ok: false, code: "invalid_arguments", message: parsed.error };
  const env = await ensureVenv(t, { signal });
  if (!env.ok) return env;
  if (!parsed.packages.length) return { ok: true, python: env.python, packages: [], installed: [] };
  if (t.autoInstall === false) return { ok: false, code: "install_disabled", message: "automatic installs are switched off" };

  const missing = parsed.packages.filter((spec) => !isInstalled(env.python, spec));
  if (!missing.length) return { ok: true, python: env.python, packages: parsed.packages, installed: [] };
  const mode = typeof t.shell.getMode === "function" ? t.shell.getMode() : "autonomous";
  if (mode !== "autonomous") {
    let yes = false;
    try { yes = await t.shell.confirm({ summary: `Download and install the Python package${missing.length > 1 ? "s" : ""} ${missing.join(", ")} from PyPI into Noah's own environment`, why: "A script needs it and it is not installed.", risk: { level: "medium", categories: ["install"], reasons: ["downloads packages (prebuilt wheels only)"] } }); } catch (_) { yes = false; }
    if (!yes) return { ok: false, code: "user_denied", message: "The user declined installing the packages." };
  }
  t.depFailures = t.depFailures || new Map();
  const failKey = `pip:${missing.slice().sort().join(",")}`;
  if (t.depFailures.has(failKey)) return { ok: false, code: "install_failed_before", message: `${t.depFailures.get(failKey)} It was not tried again.` };
  const cmd = `"${env.python}" -m pip install --disable-pip-version-check --no-input --only-binary=:all: ${missing.map((s) => `"${s}"`).join(" ")}`;
  const r = await t.shell.run({ cmd, timeoutMs: 600_000, retry: true }, { signal, bypassRepeat: true, preApproved: true });
  const stillMissing = missing.filter((spec) => !isInstalled(env.python, spec));
  if (stillMissing.length) {
    const reason = `pip could not install ${stillMissing.join(", ")}: ${String(r.output || r.message || "").trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ").slice(0, 400)}`;
    t.depFailures.set(failKey, reason);
    return { ok: false, code: "install_failed", message: reason };
  }
  for (const spec of missing) record(t, { name: spec, label: spec, method: "pip", source: "PyPI (wheels only)", path: env.python });
  return { ok: true, python: env.python, packages: parsed.packages, installed: missing };
}

/** Is `name[==version]` importable-installed in this interpreter? (pip metadata, not an import, so a package with a different import name is found.) */
function isInstalled(python, spec, { spawn = spawnSync } = {}) {
  const [n, v] = spec.split("==");
  const code = `import importlib.metadata as m,sys\ntry:\n    ver=m.version(sys.argv[1])\nexcept Exception:\n    sys.exit(1)\nsys.exit(0 if not sys.argv[2] or ver==sys.argv[2] else 2)`;
  try {
    const r = spawn(python, ["-c", code, n, v || ""], { timeout: 30_000, windowsHide: true });
    return r.status === 0;
  } catch (_) { return false; }
}

function record(t, entry) {
  try {
    const dir = depsDirOf(t);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "installed.json");
    let list = [];
    try { list = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { /* first one */ }
    list = list.filter((e) => e.name !== entry.name);
    list.push({ ...entry, at: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(list, null, 2));
  } catch (_) { /* a manifest write must never break an install */ }
}

// ---------------------------------------------------------------- the tools

/** dependency_install: one program by name, or Python packages into Noah's environment. */
async function dependencyInstall(t, { name, packages }, { signal } = {}) {
  if (packages) return ensurePackages(t, packages, { signal });
  if (!name) return { ok: false, code: "invalid_arguments", message: "give name (a program: ffmpeg, blender, python, imagemagick, ...) or packages (Python packages)" };
  return ensureProgram(t, name, { signal, why: "Requested by the task." });
}

/** python_run: run a Python script (file or inline code) in Noah's environment, with the packages it needs installed first. */
async function pythonRun(t, { script, code, packages = "", options = "", cwd, timeoutMs, retry }, { signal } = {}) {
  const got = await ensurePackages(t, packages, { signal });
  if (!got.ok) return got;
  const real = t.workspace.resolve(cwd || ".");
  let file = script, inline = null;
  if (code !== undefined && code !== null && String(code).trim()) {
    if (script) return { ok: false, code: "invalid_arguments", message: "give either script (a .py file) or code (Python text), not both" };
    fs.mkdirSync(path.join(real, ".noah"), { recursive: true });
    file = path.join(".noah", `py_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}.py`);
    inline = path.join(real, file);
    fs.writeFileSync(inline, String(code).endsWith("\n") ? String(code) : `${code}\n`);
  }
  if (!file || !/\.py$/i.test(file) || !SAFE.test(file)) return { ok: false, code: "invalid_arguments", message: "script must be a Python file (.py) inside the workspace, without quotes, % $ ! or ;" };
  try { fs.accessSync(path.resolve(real, file)); } catch (_) { return { ok: false, code: "invalid_path", message: `the script ${file} does not exist: write it with fs_write first` }; }
  const opts = String(options || "").split(/\s+/).filter(Boolean);
  for (const o of opts) if (!/^[\w.:=,+@#\/\\ -]+$/.test(o)) return { ok: false, code: "invalid_arguments", message: `the option "${o.slice(0, 40)}" contains a character that is not allowed` };
  const cmd = [`"${got.python}"`, `"${file}"`, ...opts.map((o) => (/ /.test(o) ? `"${o}"` : o))].join(" ");
  const r = await t.shell.run({ cmd, cwd, timeoutMs: timeoutMs || 300_000, retry: !!retry }, { signal });
  if (inline && r.ok) { try { fs.unlinkSync(inline); } catch (_) { /* harmless */ } }
  else if (inline) r.inlineScript = path.relative(real, inline);
  return { ...r, python: got.python, packages: got.packages, installedNow: got.installed };
}

module.exports = { catalog, findPython, planProgram, downloadFile, extractZip, installPortable, haveCommand, ensureProgram, ensurePackages, ensureVenv, parsePackages, isInstalled, dependencyInstall, pythonRun, venvPython, ALIASES };
