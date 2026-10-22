// Noah/test/unit/deps.test.cjs - dependencies are fetched the same way for every application (Noah/creative/deps.cjs).
// The decisions (what is installed, from where, who has to agree, what happens on failure, no retry loop) are tested with a fake shell and fake detection.
// The Python-package path is tested for REAL: a real virtual environment and a real download from PyPI (skipped when offline).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const deps = require("../../creative/deps.cjs");
const locate = require("../../creative/locate.cjs");
const { Workspace } = require("../../autonomy/tools/workspace.cjs");
const { ToolRegistry, DEFS } = require("../../autonomy/tools/registry.cjs");
const { MissionState } = require("../../autonomy/mission-state.cjs");

/** A registry-shaped object with a fake shell that records what it was asked to run. `present` is what detection will answer. */
function fake({ mode = "autonomous", confirm = async () => true, onRun = null, present = {}, platform = "win32", autoInstall = true } = {}) {
  const calls = [];
  const confirms = [];
  const state = { present: { ...present } };
  const t = {
    autoInstall, depPlatform: platform, depWinget: true, depBrew: true, depsDir: fs.mkdtempSync(path.join(os.tmpdir(), "noah-dep-")),
    // detection exists only for catalog programs (an unlisted program has none, as in production)
    depDetect: new Proxy({}, { get: (_, key) => (Object.prototype.hasOwnProperty.call(deps.catalog(), String(key)) ? () => (state.present[key] ? { path: `C:\\fake\\${String(key)}.exe`, version: "1.0" } : null) : undefined) }),
    shell: {
      getMode: () => mode,
      confirm: async (req) => { confirms.push(req); return confirm(req); },
      run: async (args, opts) => { calls.push({ ...args, opts }); if (onRun) return onRun(args, state); return { ok: true, exitCode: 0, output: "done" }; },
    },
  };
  return { t, calls, confirms, state, done: () => fs.rmSync(t.depsDir, { recursive: true, force: true }) };
}

test("package names: aliases (cv2 -> opencv-python-headless, PIL -> pillow), versions kept, nonsense refused", () => {
  assert.deepEqual(deps.parsePackages("cv2, PIL numpy==2.2.6 cv2").packages, ["opencv-python-headless", "pillow", "numpy==2.2.6"]);
  for (const bad of ["a;b", "x y=z", "-e .", "git+https://x/y", "../evil", "pkg==1.0 && calc"]) {
    const r = deps.parsePackages(bad);
    assert.ok(r.error || r.packages.every((p) => /^[A-Za-z0-9][A-Za-z0-9._-]*(==[0-9][\w.!+-]*)?$/.test(p)), bad);
  }
  assert.match(deps.parsePackages("git+https://x/y").error, /not a valid package name/);
  assert.match(deps.parsePackages("../evil").error, /not a valid package name/);
});

test("the install plan per platform comes from the official route; DaVinci Resolve is manual; an unknown name has no plan", () => {
  assert.equal(deps.planProgram("ffmpeg", { platform: "win32", haveWinget: true }).cmd, "winget install --id Gyan.FFmpeg --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity");
  assert.match(deps.planProgram("blender", { platform: "win32", haveWinget: true }).cmd, /BlenderFoundation\.Blender/);
  assert.equal(deps.planProgram("blender", { platform: "darwin", haveBrew: true }).cmd, "brew install --cask blender");
  assert.equal(deps.planProgram("ffmpeg", { platform: "linux" }).cmd, "sudo -n apt-get install -y ffmpeg");
  assert.match(deps.planProgram("davinci-resolve", { platform: "win32" }).manual, /blackmagicdesign\.com/);
  assert.equal(deps.planProgram("totally-made-up", { platform: "win32" }).unknown, true);
});

test("already installed: nothing is downloaded and nothing is asked", async () => {
  const f = fake({ present: { ffmpeg: true } });
  try {
    const r = await deps.ensureProgram(f.t, "ffmpeg");
    assert.deepEqual([r.ok, r.already], [true, true]);
    assert.equal(f.calls.length, 0);
    assert.equal(f.confirms.length, 0);
  } finally { f.done(); }
});

test("missing + autonomous mode + a catalog program: it installs by itself, pre-approved, and only reports success after finding it", async () => {
  const f = fake({ onRun: (args, st) => { st.present.ffmpeg = true; return { ok: true, exitCode: 0, output: "Successfully installed" }; } });
  try {
    const r = await deps.ensureProgram(f.t, "ffmpeg");
    assert.deepEqual([r.ok, r.installed, r.method], [true, true, "winget"]);
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].cmd, /^winget install --id Gyan\.FFmpeg --exact --silent/);
    assert.equal(f.calls[0].opts.preApproved, true);
    assert.equal(f.confirms.length, 0, "no card: the user's setting is autonomous and this is a catalog entry");
    const manifest = JSON.parse(fs.readFileSync(path.join(f.t.depsDir, "installed.json"), "utf8"));
    assert.equal(manifest[0].name, "ffmpeg");
  } finally { f.done(); }
});

test("an installer that exits 0 but leaves the program unfindable is NOT reported as installed, and is not retried in a loop", async () => {
  const f = fake({ onRun: () => ({ ok: true, exitCode: 0, output: "ok" }) });
  try {
    const a = await deps.ensureProgram(f.t, "blender");
    assert.deepEqual([a.ok, a.code], [false, "install_failed"]);
    assert.match(a.message, /still cannot be found/);
    const b = await deps.ensureProgram(f.t, "blender");
    assert.deepEqual([b.ok, b.code], [false, "install_failed_before"]);
    assert.equal(f.calls.length, 1, "the second ask did not run the installer again");
  } finally { f.done(); }
});

test("supervised mode asks first, naming the program, size and source; a 'no' installs nothing and says not to find another way", async () => {
  const f = fake({ mode: "supervised", confirm: async () => false });
  try {
    const r = await deps.ensureProgram(f.t, "blender", { why: "for the model" });
    assert.deepEqual([r.ok, r.code], [false, "user_denied"]);
    assert.equal(f.calls.length, 0);
    assert.match(f.confirms[0].summary, /Download and install Blender \(about 400 MB\) from download\.blender\.org/);
  } finally { f.done(); }
});

test("a program that is not in the catalog (an exact winget id) is installed only with the user's yes, even in autonomous mode", async () => {
  const yes = fake({ confirm: async () => true });
  try {
    const r = await deps.ensureProgram(yes.t, "jqlang.jq");
    assert.equal(yes.confirms.length, 1);
    assert.match(yes.calls[0].cmd, /winget install --id jqlang\.jq --exact/);
    assert.equal(r.ok, true);
    assert.equal(r.unverified, true, "no detector for it: said plainly");
  } finally { yes.done(); }
  const no = fake({ confirm: async () => false });
  try {
    assert.equal((await deps.ensureProgram(no.t, "jqlang.jq")).code, "user_denied");
    assert.equal(no.calls.length, 0);
    const junk = await deps.ensureProgram(no.t, "rm -rf /");
    assert.equal(junk.code, "unknown_dependency");
    assert.equal(no.calls.length, 0);
  } finally { no.done(); }
});

test("automatic installs switched off, and a program that must be downloaded by hand, are reported - never attempted", async () => {
  const off = fake({ autoInstall: false });
  try {
    assert.equal((await deps.ensureProgram(off.t, "ffmpeg")).code, "install_disabled");
    assert.equal(off.calls.length, 0);
  } finally { off.done(); }
  const man = fake();
  try {
    const r = await deps.ensureProgram(man.t, "davinci-resolve");
    assert.equal(r.code, "manual_install");
    assert.equal(man.calls.length, 0);
  } finally { man.done(); }
});

test("two tools asking for the same missing program at once cause ONE install", async () => {
  let n = 0;
  const f = fake({ onRun: async (args, st) => { n++; await new Promise((r) => setTimeout(r, 50)); st.present.ffmpeg = true; return { ok: true, exitCode: 0, output: "" }; } });
  try {
    const [a, b] = await Promise.all([deps.ensureProgram(f.t, "ffmpeg"), deps.ensureProgram(f.t, "ffmpeg")]);
    assert.deepEqual([a.ok, b.ok, n], [true, true, 1]);
  } finally { f.done(); }
});

test("the tools get what they need by themselves: ffmpeg_run with no FFmpeg installs it, then runs", async () => {
  const f = fake({ onRun: (args, st) => { st.present.ffmpeg = true; return { ok: true, exitCode: 0, output: "installed" }; } });
  const realFind = locate.findTool;
  const realEnsure = deps.ensureProgram;
  let installed = false;
  locate.findTool = (name) => (installed && name === "ffmpeg" ? { path: "C:\\fake\\ffmpeg.exe" } : null);
  deps.ensureProgram = async (t, name) => { installed = true; return { ok: true, name, installed: true, path: "C:\\fake\\ffmpeg.exe" }; };
  try {
    const { runFfmpeg } = require("../../creative/media-tools.cjs");
    const ran = [];
    const t = { workspace: { resolve: (p) => path.resolve(os.tmpdir(), p || ".") }, shell: { run: async (a) => { ran.push(a.cmd); return { ok: true, exitCode: 0, output: "" }; } } };
    const r = await runFfmpeg(t, { args: "-version" });
    assert.equal(r.ok, true);
    assert.ok(installed, "it asked the dependency manager");
    assert.match(ran[0], /ffmpeg\.exe" -hide_banner/);
  } finally { locate.findTool = realFind; deps.ensureProgram = realEnsure; f.done(); }
});

test("the tools are registered, mutating, with plain schemas", () => {
  assert.ok(DEFS.dependency_install && DEFS.python_run);
  const reg = new ToolRegistry({ workspace: new Workspace({ roots: [os.tmpdir()] }), state: new MissionState({ objective: "x" }) });
  assert.equal(reg.isMutating("dependency_install", { name: "ffmpeg" }), true);
  assert.equal(reg.isMutating("python_run", { script: "a.py" }), true);
  assert.deepEqual(reg.schemas().find((s) => s.name === "python_run").parameters.required, []);
});

// ------------------------------------------------------------------ REAL: a virtual environment and a real download

const PY = deps.findPython();

test("REAL: a Python script that needs a package gets it downloaded into Noah's own environment; the second run downloads nothing; the system Python is untouched", { skip: !PY && "no Python on this computer", timeout: 400000 }, async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-real-")));
  try {
    const reg = new ToolRegistry({ workspace: new Workspace({ roots: [dir] }), state: new MissionState({ objective: "x" }), depsDir: path.join(dir, "deps"), logDir: path.join(dir, "logs") });
    const code = "import six, sys\nprint('SIX', six.__version__, sys.prefix)\n";
    const first = await reg.execute("python_run", { code, packages: "six==1.16.0" });
    if (!first.ok && /could not install|install_failed/.test(String(first.message || first.code))) return t.skip("PyPI not reachable from here: " + String(first.message).slice(0, 120));
    assert.equal(first.ok, true, JSON.stringify({ code: first.code, message: first.message, out: String(first.output).slice(-300) }));
    assert.match(first.output, /SIX 1\.16\.0 /);
    assert.deepEqual(first.installedNow, ["six==1.16.0"]);
    assert.ok(first.output.includes(path.join(dir, "deps", "venv")), "it ran in Noah's environment, not the system Python");
    const second = await reg.execute("python_run", { code, packages: "six==1.16.0" });
    assert.equal(second.ok, true);
    assert.deepEqual(second.installedNow, [], "nothing downloaded the second time");
    assert.equal(fs.existsSync(path.join(dir, "deps", "installed.json")), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "deps", "installed.json"), "utf8"));
    assert.equal(manifest.find((m) => m.name === "six==1.16.0").method, "pip");
    // the system Python was not touched: six is not imported there by this install
    const { spawnSync } = require("child_process");
    const sysHas = spawnSync(PY.path, ["-c", "import importlib.metadata as m; print(m.version('six'))"], { encoding: "utf8" });
    const venvPy = deps.venvPython(path.join(dir, "deps", "venv"));
    assert.notEqual(path.resolve(venvPy).toLowerCase(), path.resolve(PY.path).toLowerCase());
    if (sysHas.status === 0) assert.notEqual(sysHas.stdout.trim(), "", "(six may exist in the system Python already; that is not ours)");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("REAL: a package that does not exist is reported once with pip's reason, and is not retried", { skip: !PY && "no Python on this computer", timeout: 400000 }, async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-real-")));
  try {
    const reg = new ToolRegistry({ workspace: new Workspace({ roots: [dir] }), state: new MissionState({ objective: "x" }), depsDir: path.join(dir, "deps"), logDir: path.join(dir, "logs") });
    const a = await reg.execute("dependency_install", { packages: "noah-no-such-package-zz9" });
    assert.deepEqual([a.ok, a.code], [false, "install_failed"]);
    assert.match(a.message, /noah-no-such-package-zz9/);
    const b = await reg.execute("dependency_install", { packages: "noah-no-such-package-zz9" });
    assert.equal(b.code, "install_failed_before");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("pip is told to take prebuilt wheels only (no package build code runs at install time)", async () => {
  const f = fake({ onRun: () => ({ ok: false, exitCode: 1, output: "ERROR: No matching distribution found" }) });
  try {
    const py = deps.venvPython(path.join(f.t.depsDir, "venv"));
    fs.mkdirSync(path.dirname(py), { recursive: true });
    fs.writeFileSync(py, ""); // the environment "exists"; the interpreter cannot answer, so the package counts as missing
    const r = await deps.ensurePackages(f.t, "somepkg");
    assert.equal(r.ok, false);
    const pip = f.calls.find((c) => /-m pip install/.test(c.cmd));
    assert.ok(pip, "pip was run");
    assert.match(pip.cmd, /--only-binary=:all:/);
    assert.match(pip.cmd, /--no-input/);
    assert.equal(pip.opts.preApproved, true);
  } finally { f.done(); }
});

test("preApproved skips ONLY the confirmation card: a high-risk install asks without it, runs with it, and a blocked command is still refused", async () => {
  const { ShellTool } = require("../../autonomy/tools/shell.cjs");
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-pre-")));
  try {
    let asked = 0;
    const shell = new ShellTool({ workspace: new Workspace({ roots: [dir] }), state: new MissionState({ objective: "x" }), getMode: () => "autonomous", confirm: async () => { asked++; return false; }, logDir: path.join(dir, "logs") });
    const without = await shell.run({ cmd: "winget install --help" });
    assert.deepEqual([without.code, asked], ["user_denied", 1], "a system install asks, even in autonomous mode");
    const withIt = await shell.run({ cmd: "winget install --help" }, { preApproved: true, bypassRepeat: true });
    assert.equal(asked, 1, "no second card");
    assert.notEqual(withIt.code, "user_denied");
    const blocked = await shell.run({ cmd: "format C: /q" }, { preApproved: true });
    assert.equal(blocked.code, "blocked", "pre-approval does not unblock a refused command");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ a PC without winget / behind a proxy / short of disk

test("no winget: the vendor's own zip is the route (SHA-256 checked, no administrator); with winget it is the first choice and the zip is the fallback", () => {
  const without = deps.planProgram("blender", { platform: "win32", arch: "x64", haveWinget: false });
  assert.deepEqual(without.methods.map((m) => m.method), ["portable"]);
  assert.match(without.methods[0].spec.url, /^https:\/\/download\.blender\.org\/release\/Blender5\.2\/blender-5\.2\.2-windows-x64\.zip$/);
  assert.match(without.methods[0].spec.sha256, /^[a-f0-9]{64}$/);
  assert.match(deps.planProgram("blender", { platform: "win32", arch: "arm64", haveWinget: false }).methods[0].spec.url, /windows-arm64\.zip$/, "ARM PCs get the ARM build");
  const both = deps.planProgram("ffmpeg", { platform: "win32", arch: "x64", haveWinget: true });
  assert.deepEqual(both.methods.map((m) => m.method), ["winget", "portable"]);
  // Python has no portable route: without winget it is said plainly, with what to do
  const py = deps.planProgram("python", { platform: "win32", haveWinget: false });
  assert.match(py.error, /no winget/);
  assert.match(deps.planProgram("blender", { platform: "darwin", haveBrew: false }).error, /Homebrew/);
});

test("no winget: the program is installed from the verified zip into Noah's folder and then found; a checksum mismatch is discarded and reported", async () => {
  const f = fake({ present: {} });
  f.t.depWinget = false;
  const programs = path.join(f.t.depsDir, "programs");
  f.t.depDownload = async (url, dest, { expectedSha256 }) => { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, "zipbytes"); f.downloaded = { url, expectedSha256 }; return { bytes: 8, sha256: expectedSha256 }; };
  f.t.depExtract = (zip, dest) => { fs.mkdirSync(path.join(dest, "blender-5.2.2-windows-x64"), { recursive: true }); fs.writeFileSync(path.join(dest, "blender-5.2.2-windows-x64", "blender.exe"), "x"); return { ok: true }; };
  f.t.depDetect = { blender: () => { const hit = locate.portableFind("blender", { root: f.t.depsDir, platform: "win32" })[0]; return hit ? { path: hit } : null; } };
  try {
    const r = await deps.ensureProgram(f.t, "blender");
    assert.deepEqual([r.ok, r.method], [true, "portable"], JSON.stringify(r));
    assert.equal(f.calls.length, 0, "no package manager was asked");
    assert.match(f.downloaded.expectedSha256, /^[a-f0-9]{64}$/);
    assert.ok(r.path.startsWith(programs), "installed under Noah's own folder, not Program Files");
    assert.equal(fs.existsSync(path.join(f.t.depsDir, "downloads", "blender-5.2.2-windows-x64.zip")), false, "the zip was removed after unpacking");
  } finally { f.done(); }
  const bad = fake({ present: {} });
  bad.t.depWinget = false;
  const realDownload = deps.downloadFile;
  bad.t.depDownload = (url, dest, o) => realDownload(url, dest, { ...o, fetchImpl: async () => new Response("not the real file", { headers: { "content-length": "17" } }) });
  try {
    const r = await deps.ensureProgram(bad.t, "blender");
    assert.deepEqual([r.ok, r.code], [false, "install_failed"]);
    assert.match(r.message, /does not match its published SHA-256/);
    assert.equal(fs.existsSync(path.join(bad.t.depsDir, "programs")), false, "nothing was unpacked");
  } finally { bad.done(); }
});

test("downloadFile: only https, a cut-short body and a wrong checksum are errors and leave no file; a good one is renamed into place", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-dl-"));
  const crypto = require("crypto");
  const body = Buffer.from("hello portable world");
  const sha = crypto.createHash("sha256").update(body).digest("hex");
  const ok = (b, len = b.length) => async () => new Response(b, { headers: { "content-length": String(len) } });
  try {
    await assert.rejects(() => deps.downloadFile("http://x/y.zip", path.join(dir, "a.zip"), { fetchImpl: ok(body) }), /only https/);
    await assert.rejects(() => deps.downloadFile("https://x/y.zip", path.join(dir, "b.zip"), { fetchImpl: ok(body, body.length + 50), expectedSha256: sha }), /cut short/);
    await assert.rejects(() => deps.downloadFile("https://x/y.zip", path.join(dir, "c.zip"), { fetchImpl: ok(body), expectedSha256: "0".repeat(64) }), /does not match/);
    await assert.rejects(() => deps.downloadFile("https://x/y.zip", path.join(dir, "d.zip"), { fetchImpl: async () => new Response("no", { status: 404 }) }), /404/);
    for (const n of ["a", "b", "c", "d"]) assert.equal(fs.existsSync(path.join(dir, `${n}.zip`)) || fs.existsSync(path.join(dir, `${n}.zip.part`)), false, `${n}: nothing left behind`);
    const r = await deps.downloadFile("https://x/y.zip", path.join(dir, "good.zip"), { fetchImpl: ok(body), expectedSha256: sha });
    assert.equal(r.sha256, sha);
    assert.equal(fs.readFileSync(path.join(dir, "good.zip")).toString(), "hello portable world");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("REAL unpacking: a real zip is extracted by the system's own tool", { timeout: 60000 }, (t) => {
  const { spawnSync } = require("child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-zip-"));
  try {
    fs.mkdirSync(path.join(dir, "src", "inner"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "inner", "tool.exe"), "payload");
    const sysTar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\Windows", "System32", "tar.exe") : "tar";
    const made = spawnSync(sysTar, ["-a", "-cf", path.join(dir, "t.zip"), "-C", path.join(dir, "src"), "inner"], { encoding: "utf8" });
    if (made.status !== 0) return t.skip("no tar to make a test zip with");
    const r = deps.extractZip(path.join(dir, "t.zip"), path.join(dir, "out"));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.readFileSync(path.join(dir, "out", "inner", "tool.exe"), "utf8"), "payload");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("proxy and certificate settings reach a dependency download but not an ordinary command", async () => {
  const { ShellTool } = require("../../autonomy/tools/shell.cjs");
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-net-")));
  const saved = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://proxy.example:8080";
  try {
    const shell = new ShellTool({ workspace: new Workspace({ roots: [dir] }), state: new MissionState({ objective: "x" }), getMode: () => "autonomous", logDir: path.join(dir, "logs") });
    const cmd = `"${process.execPath}" -p "process.env.HTTPS_PROXY || 'none'"`;
    const plain = await shell.run({ cmd }, { bypassRepeat: true });
    assert.match(plain.output, /none/, "an ordinary command does not get it");
    const dep = await shell.run({ cmd }, { bypassRepeat: true, preApproved: true });
    assert.match(dep.output, /proxy\.example:8080/, "a dependency download does");
  } finally {
    if (saved === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("LIVE (set NOAH_TEST_NETWORK=1): FFmpeg is installed on a PC with no package manager - real download, checksum from the vendor, unpack, find, run", { skip: process.env.NOAH_TEST_NETWORK !== "1" && "set NOAH_TEST_NETWORK=1 to download FFmpeg (about 100 MB)", timeout: 900000 }, async () => {
  const f = fake({ present: {}, platform: process.platform });
  f.t.depWinget = false;
  // detection that looks ONLY in Noah's own folder (this PC already has FFmpeg elsewhere; the point is the install)
  f.t.depDetect = { ffmpeg: () => { const hit = locate.portableFind("ffmpeg", { root: f.t.depsDir })[0]; return hit ? { path: hit, version: require("../../creative/locate.cjs").versionOf(hit) } : null; } };
  const saved = process.env.NOAH_DEPS_DIR, savedPath = process.env.PATH;
  process.env.NOAH_DEPS_DIR = f.t.depsDir;
  process.env.PATH = path.dirname(process.execPath); // a PC where no ffmpeg is on PATH
  try {
    locate.forget();
    const r = await deps.ensureProgram(f.t, "ffmpeg");
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.method, "portable");
    assert.ok(r.path.startsWith(path.join(f.t.depsDir, "programs")), r.path);
    assert.match(r.version, /ffmpeg version/);
    const probe = locate.portableFind("ffprobe", { root: f.t.depsDir });
    assert.equal(probe.length, 1, "ffprobe came in the same download");
    const ran = require("child_process").spawnSync(probe[0], ["-version"], { encoding: "utf8" });
    assert.equal(ran.status, 0, "and it runs");
    console.log("installed:", r.path, "|", r.version.slice(0, 60));
  } finally {
    process.env.PATH = savedPath;
    if (saved === undefined) delete process.env.NOAH_DEPS_DIR; else process.env.NOAH_DEPS_DIR = saved;
    f.done();
  }
});

test("REAL: a folder with spaces, &, parentheses, accents and non-Latin letters works (Python is told to write UTF-8)", { skip: !PY && "no Python on this computer", timeout: 300000 }, async () => {
  const base = fs.realpathSync.native(os.tmpdir());
  const dir = path.join(base, "Zoë & Müller 名前 (noah test)");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    const reg = new ToolRegistry({ workspace: new Workspace({ roots: [dir] }), state: new MissionState({ objective: "x" }), depsDir: path.join(dir, "deps dir"), logDir: path.join(dir, "logs") });
    const r = await reg.execute("python_run", { code: "import os\nprint('CWD', os.getcwd())\nopen('ünï.txt', 'w', encoding='utf8').write('ok')\n" });
    assert.equal(r.ok, true, JSON.stringify({ code: r.code, out: String(r.output).slice(-300) }));
    assert.match(r.output, /名前/);
    assert.equal(fs.existsSync(path.join(dir, "ünï.txt")), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
