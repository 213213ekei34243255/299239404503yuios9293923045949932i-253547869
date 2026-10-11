// Noah/test/unit/creative-pipeline.test.cjs - the creative tools together: finding programs, FFmpeg/ffprobe with output verification, Blender inline code and
// export re-import checks, and the guard against `blender --python -c`. The REAL FFmpeg and REAL Blender installed on this computer are used (headless, no window);
// those tests are skipped when the program is not installed.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { findTool, forget } = require("../../creative/locate.cjs");
const { tokenize, buildFfmpegCommand } = require("../../creative/media.cjs");
const { findBlender, detectPythonFlagMisuse } = require("../../creative/blender.cjs");
const { Workspace } = require("../../autonomy/tools/workspace.cjs");
const { ToolRegistry, DEFS } = require("../../autonomy/tools/registry.cjs");
const { MissionState } = require("../../autonomy/mission-state.cjs");
const { inventory, notes } = require("../../creative/runtimes.cjs");

const FFMPEG = findTool("ffmpeg");
const FFPROBE = findTool("ffprobe");
const BLENDER = findBlender();

function workspace() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-cr-")));
  const reg = new ToolRegistry({ workspace: new Workspace({ roots: [dir] }), state: new MissionState({ objective: "x" }), logDir: path.join(dir, "logs") });
  return { dir, reg, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------- locating programs

test("locating: an explicit setting wins, PATH next, install places after; a candidate that does not answer its version command is skipped", () => {
  const files = new Set(["D:\\tools\\ffmpeg.exe", "C:\\bin\\ffmpeg.exe", "C:\\ffmpeg-2026-10-08-essentials_build\\bin\\ffmpeg.exe"]);
  const exists = (p) => files.has(p);
  const spawn = (exe) => (exe === "C:\\bin\\ffmpeg.exe" ? { status: 1, stdout: "", stderr: "" } : { status: 0, stdout: `ffmpeg version 8.1 from ${exe}\n`, stderr: "" });
  const base = { platform: "win32", exists, spawn, useCache: false };
  assert.equal(findTool("ffmpeg", { ...base, env: { FFMPEG_PATH: "D:\\tools\\ffmpeg.exe", PATH: "C:\\bin" } }).path, "D:\\tools\\ffmpeg.exe");
  const viaPath = findTool("ffmpeg", { ...base, env: { PATH: "C:\\bin;D:\\tools" } });
  assert.equal(viaPath.path, "D:\\tools\\ffmpeg.exe", "C:\\bin\\ffmpeg.exe exists but does not answer: it is skipped");
  assert.equal(viaPath.source, "PATH");
  assert.match(viaPath.tried.join("\n"), /C:\\bin\\ffmpeg\.exe: did not answer/);
  assert.equal(findTool("ffmpeg", { ...base, exists: () => false, env: { PATH: "" } }), null);
});

test("locating: the answer is cached, and forget() makes the next call look again", () => {
  forget();
  let calls = 0;
  const spawn = () => { calls++; return { status: 0, stdout: "tool 1\n", stderr: "" }; };
  const o = { platform: "linux", env: { PATH: "/x" }, exists: () => true, spawn };
  findTool("sometool", o); findTool("sometool", o);
  assert.equal(calls, 1, "second call came from the cache");
  forget("sometool");
  findTool("sometool", o);
  assert.equal(calls, 2);
  forget();
});

// ---------------------------------------------------------------- command building

test("ffmpeg command: arguments are tokenised and checked; a frame pattern is fine, shell syntax is refused, a missing FFmpeg says how to install it", () => {
  assert.deepEqual(tokenize(`-y -i "my clip.mp4" -vf 'scale=1280:720' out.mp4`), ["-y", "-i", "my clip.mp4", "-vf", "scale=1280:720", "out.mp4"]);
  const ok = buildFfmpegCommand({ exe: "C:\\f\\ffmpeg.exe", args: `-y -i "my clip.mp4" frames\\f_%04d.png` });
  assert.equal(ok.cmd, `"C:\\f\\ffmpeg.exe" -hide_banner -nostdin -y -i "my clip.mp4" frames\\f_%04d.png`);
  for (const bad of ["-i %PATH%", "-i $(x)", "-i a`b", "-i a!b"]) assert.match(buildFfmpegCommand({ exe: "ffmpeg", args: bad }).error, /not allowed/, bad);
  // & and | are not syntax inside quotes (a Windows user name can contain "&"): such a token is quoted and reaches ffmpeg as a plain argument
  assert.equal(buildFfmpegCommand({ exe: "ffmpeg", args: "-i a.mp4 & calc" }).cmd, 'ffmpeg -hide_banner -nostdin -i a.mp4 "&" calc'.replace("ffmpeg ", '"ffmpeg" '));
  assert.match(buildFfmpegCommand({ exe: "ffmpeg", args: ["-i", "C:\\Users\\A&B\\x.mp4"] }).cmd, /"C:\\Users\\A&B\\x\.mp4"/);
  assert.match(buildFfmpegCommand({ exe: null, args: "-version" }).error, /winget install/);
  assert.match(buildFfmpegCommand({ exe: "ffmpeg", args: "" }).error, /args is empty/);
});

test("blender --python -c is recognised and refused with the way out; --python-expr and a script file are fine", () => {
  const exe = '"C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe"';
  assert.match(detectPythonFlagMisuse(`${exe} --background --factory-startup --python -c "import bpy; print(1)"`), /takes a FILE/);
  assert.match(detectPythonFlagMisuse(`${exe} -b -P -c "x"`), /blender_run/);
  assert.equal(detectPythonFlagMisuse(`${exe} --background --python-expr "import bpy"`), null);
  assert.equal(detectPythonFlagMisuse(`${exe} --background --python "make.py"`), null);
  assert.equal(detectPythonFlagMisuse(`python -c "print(1)"`), null, "plain Python -c is not Blender's business");
});

test("the shell tool refuses `blender --python -c` before running anything", async () => {
  const w = workspace();
  try {
    const r = await w.reg.execute("shell_run", { cmd: `"C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" --background --python -c "import bpy"` });
    assert.deepEqual([r.ok, r.code], [false, "blender_python_flag"]);
    assert.match(r.message, /blender_run/);
  } finally { w.done(); }
});

// ---------------------------------------------------------------- the inventory

test("inventory notes follow from the facts: OpenCV is missing in Blender's Python, so it must run outside it; differing Pythons are called out", () => {
  const n = notes({ blender: "b", bl: { version: "3.13.13", numpy: "2.3.4", cv2: null }, sys: { version: "3.11.0", numpy: "2.2.6", cv2: "4.12.0" }, ffmpeg: { path: "f" }, ffprobe: null });
  assert.match(n.join("\n"), /OpenCV \(cv2\) is not importable in Blender's own Python. Do not replace Blender's NumPy/);
  assert.match(n.join("\n"), /system Python 3\.11\.0 has cv2 4\.12\.0/);
  assert.match(n.join("\n"), /Python versions differ/);
  assert.match(n.join("\n"), /ffprobe was not found/);
});

test("REAL: the inventory of this computer is internally consistent (every path it reports exists and answers)", { timeout: 120000 }, () => {
  const inv = inventory();
  assert.ok(inv.computer.memoryGB > 0);
  if (inv.blender) { assert.ok(fs.existsSync(inv.blender.path)); if (inv.blender.python) assert.ok(inv.blender.python.numpy, "Blender's own NumPy is reported"); }
  if (inv.ffmpeg) { assert.ok(fs.existsSync(inv.ffmpeg.path)); assert.match(inv.ffmpeg.version, /ffmpeg version/); }
  if (inv.systemPython) assert.match(inv.systemPython.version, /^\d+\.\d+/);
});

test("the inventory tool is registered, read-only, with a plain schema", () => {
  assert.ok(DEFS.creative_inventory && DEFS.media_probe && DEFS.ffmpeg_run && DEFS.blender_verify_export);
  const w = workspace();
  try {
    assert.equal(w.reg.isMutating("creative_inventory", {}), false);
    assert.equal(w.reg.isMutating("media_probe", { path: "a.mp4" }), false);
    assert.equal(w.reg.isMutating("ffmpeg_run", { args: "-i a b" }), true);
  } finally { w.done(); }
});

// ---------------------------------------------------------------- REAL FFmpeg

const SKIP_FF = !(FFMPEG && FFPROBE) && "FFmpeg/ffprobe not installed";

test("REAL FFmpeg: an encode is verified by reading the file back (codec, size, rate, duration, audio) and by a full decode", { skip: SKIP_FF, timeout: 120000 }, async () => {
  const w = workspace();
  try {
    const r = await w.reg.execute("ffmpeg_run", { args: "-y -f lavfi -i testsrc=size=320x240:rate=25 -f lavfi -i sine=frequency=440:duration=2 -t 2 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest clip.mp4", output: "clip.mp4", width: 320, height: 240, minDurationSec: 1, audio: true });
    assert.equal(r.ok, true, JSON.stringify({ code: r.code, message: r.message, out: String(r.output).slice(-400) }));
    assert.equal(r.media.video.codec, "h264");
    assert.deepEqual([r.media.video.width, r.media.video.height, r.media.video.fps], [320, 240, 25]);
    assert.ok(r.media.durationSec >= 1.9 && r.media.durationSec <= 2.3, `duration ${r.media.durationSec}`);
    assert.equal(r.media.audio.codec, "aac");
    assert.ok(r.media.bytes > 1000);
    const p = await w.reg.execute("media_probe", { path: "clip.mp4" });
    assert.equal(p.ok, true);
    assert.equal(p.video.codec, "h264");
    // the check really checks: the same file against the wrong expectation fails with the reason
    const wrong = await w.reg.execute("ffmpeg_run", { args: "-y -i clip.mp4 -c copy again.mp4", output: "again.mp4", width: 640 });
    assert.deepEqual([wrong.ok, wrong.code], [false, "output_invalid"]);
    assert.match(wrong.message, /width is 320, expected 640/);
  } finally { w.done(); }
});

test("REAL FFmpeg: a command that exits 0 but writes nothing is NOT a success; a truncated or empty file is reported, not trusted", { skip: SKIP_FF, timeout: 120000 }, async () => {
  const w = workspace();
  try {
    const none = await w.reg.execute("ffmpeg_run", { args: "-y -f lavfi -i testsrc=size=64x64:rate=5 -t 1 real.mp4", output: "expected-but-not-made.mp4" });
    assert.deepEqual([none.ok, none.code], [false, "output_missing"]);
    await w.reg.execute("ffmpeg_run", { args: "-y -f lavfi -i testsrc=size=160x120:rate=25 -t 3 -c:v libx264 -pix_fmt yuv420p good.mp4", output: "good.mp4" });
    const bytes = fs.readFileSync(path.join(w.dir, "good.mp4"));
    fs.writeFileSync(path.join(w.dir, "cut.mp4"), bytes.subarray(0, Math.floor(bytes.length / 3)));
    fs.writeFileSync(path.join(w.dir, "empty.mp4"), "");
    const cut = await w.reg.execute("media_probe", { path: "cut.mp4" });
    assert.equal(cut.ok, false, "a file cut to a third is not a clean video");
    // damaged in the middle of the picture data: the header (moov) is intact so ffprobe reads it fine, only a full DECODE shows the damage
    const damaged = Buffer.from(bytes);
    const mid = Math.floor(damaged.length / 2);
    for (let i = 0; i < 400; i++) damaged[mid + i] = (i * 37 + 11) & 0xff;
    fs.writeFileSync(path.join(w.dir, "damaged.mp4"), damaged);
    const dmg = await w.reg.execute("media_probe", { path: "damaged.mp4" });
    assert.equal(dmg.ok, false, "a file with damaged picture data is not reported as fine");
    assert.match(String(dmg.message), /decod|error|invalid|corrupt/i);
    assert.equal((await w.reg.execute("media_probe", { path: "good.mp4" })).ok, true, "the undamaged original passes");
    const empty = await w.reg.execute("media_probe", { path: "empty.mp4" });
    assert.deepEqual([empty.ok, empty.code], [false, "empty"]);
    assert.equal((await w.reg.execute("media_probe", { path: "nope.mp4" })).code, "missing");
  } finally { w.done(); }
});

test("REAL FFmpeg: an image sequence pattern (%04d) goes through, and the frames are really there", { skip: SKIP_FF, timeout: 120000 }, async () => {
  const w = workspace();
  try {
    fs.mkdirSync(path.join(w.dir, "frames"));
    const r = await w.reg.execute("ffmpeg_run", { args: "-y -f lavfi -i testsrc=size=64x48:rate=10 -t 1 frames\\f_%04d.png", cwd: "." });
    assert.equal(r.ok, true, JSON.stringify({ code: r.code, message: r.message, out: String(r.output).slice(-300) }));
    const made = fs.readdirSync(path.join(w.dir, "frames")).filter((f) => /^f_\d{4}\.png$/.test(f));
    assert.equal(made.length, 10);
  } finally { w.done(); }
});

// ---------------------------------------------------------------- REAL Blender: inline code, exports, re-import

const SKIP_BL = !BLENDER && "Blender not installed";

test("REAL Blender: inline code runs from a file of its own (never --python -c), prints, and its temporary file is cleaned up", { skip: SKIP_BL, timeout: 120000 }, async () => {
  const w = workspace();
  try {
    const r = await w.reg.execute("blender_run", { code: "import bpy\nprint('INLINE_OK', bpy.app.version_string)\n" });
    assert.equal(r.ok, true, JSON.stringify({ code: r.code, message: r.message, out: String(r.output).slice(-300) }));
    assert.match(r.output, /INLINE_OK \d+\.\d+/);
    assert.equal(fs.readdirSync(path.join(w.dir, ".noah")).filter((f) => f.startsWith("inline_")).length, 0, "temporary script removed after success");
    assert.equal((await w.reg.execute("blender_run", { code: "x", script: "a.py" })).code, "invalid_arguments", "code and script together are refused");
  } finally { w.done(); }
});

test("REAL Blender: inline code that raises is a failed run (exit 1) with the Python error, and its script is KEPT for diagnosis", { skip: SKIP_BL, timeout: 120000 }, async () => {
  const w = workspace();
  try {
    const r = await w.reg.execute("blender_run", { code: "import bpy\nbpy.data.objects['Nope']\n" });
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 1);
    assert.match(r.output, /KeyError/);
    assert.ok(r.inlineScript && fs.existsSync(path.join(w.dir, r.inlineScript)), "the script that failed is still there");
  } finally { w.done(); }
});

const BUILD_AND_EXPORT = `
import bpy, os
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1)); cube = bpy.context.object; cube.name = "Crate"
mat = bpy.data.materials.new("Wood"); mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.5, 0.3, 0.1, 1)
cube.data.materials.append(mat)
cube.location = (0, 0, 1); cube.keyframe_insert("location", frame=1)
cube.location = (3, 0, 1); cube.keyframe_insert("location", frame=24)
d = os.getcwd()
bpy.ops.export_scene.gltf(filepath=os.path.join(d, "crate.glb"), export_format='GLB')
bpy.ops.export_scene.fbx(filepath=os.path.join(d, "crate.fbx"))
bpy.ops.wm.obj_export(filepath=os.path.join(d, "crate.obj"))
bpy.ops.wm.stl_export(filepath=os.path.join(d, "crate.stl"))
bpy.ops.wm.usd_export(filepath=os.path.join(d, "crate.usd"))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(d, "crate.blend"))
print("EXPORTED")
`;

test("REAL Blender: exports are checked by importing them again into a clean scene: geometry, size, materials and animation are reported per format", { skip: SKIP_BL, timeout: 400000 }, async () => {
  const w = workspace();
  try {
    const made = await w.reg.execute("blender_run", { code: BUILD_AND_EXPORT });
    assert.equal(made.ok, true, JSON.stringify({ code: made.code, out: String(made.output).slice(-500) }));
    const rep = {};
    for (const f of ["crate.glb", "crate.fbx", "crate.obj", "crate.stl", "crate.usd", "crate.blend"]) {
      const v = await w.reg.execute("blender_verify_export", { path: f });
      assert.equal(v.ok, true, `${f}: ${JSON.stringify({ code: v.code, message: v.message })}`);
      rep[f] = v.report;
    }
    console.log("re-import report:", JSON.stringify(Object.fromEntries(Object.entries(rep).map(([k, r]) => [k, { meshes: r.meshObjects, verts: r.vertices, faces: r.faces, size: r.size, materials: r.materials, actions: r.actions.length }]))));
    for (const [f, r] of Object.entries(rep)) {
      assert.equal(r.meshObjects, 1, `${f}: one mesh object`);
      assert.ok(r.faces >= 6, `${f}: at least the 6 faces of a cube (STL is triangulated: 12)`);
      assert.ok(r.size.every((s) => Math.abs(s - 2) < 0.01), `${f}: the crate is 2 units wide, not ${JSON.stringify(r.size)}`);
    }
    assert.equal(rep["crate.stl"].faces, 12, "STL stores triangles");
    assert.deepEqual(rep["crate.glb"].materials, ["Wood"], "glTF keeps the material");
    assert.ok(rep["crate.glb"].actions.length >= 1, "glTF keeps the animation");
    assert.ok(rep["crate.fbx"].actions.length >= 1, "FBX keeps the animation");
    assert.deepEqual(rep["crate.stl"].materials, [], "STL has no materials: reported, not hidden");
    assert.ok(rep["crate.blend"].actions.length >= 1);
    // a file that is not what it says is reported as a failed import, not as an empty success
    fs.writeFileSync(path.join(w.dir, "broken.glb"), "this is not a glb file");
    const bad = await w.reg.execute("blender_verify_export", { path: "broken.glb" });
    assert.deepEqual([bad.ok, bad.code], [false, "import_failed"]);
    assert.equal((await w.reg.execute("blender_verify_export", { path: "ghost.glb" })).code, "missing");
  } finally { w.done(); }
});

// ---------------------------------------------------------------- Blender render -> FFmpeg video

test("REAL Blender + FFmpeg: render a short animation to frames, encode them to an MP4, and verify the video", { skip: (SKIP_BL || SKIP_FF), timeout: 600000 }, async () => {
  const w = workspace();
  try {
    const code = `
import bpy, os
bpy.ops.wm.read_factory_settings(use_empty=True)
s = bpy.context.scene
bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(-2, 0, 1)); ball = bpy.context.object
ball.keyframe_insert("location", frame=1); ball.location = (2, 0, 1); ball.keyframe_insert("location", frame=12)
bpy.ops.object.light_add(type='SUN', location=(3, -3, 5)); bpy.context.object.data.energy = 3
bpy.ops.object.camera_add(location=(0, -8, 2), rotation=(1.4, 0, 0)); s.camera = bpy.context.object
s.render.engine = 'CYCLES'; s.cycles.device = 'CPU'; s.cycles.samples = 4
s.render.resolution_x = 160; s.render.resolution_y = 120
s.frame_start = 1; s.frame_end = 12
os.makedirs("frames", exist_ok=True)
s.render.filepath = os.path.join(os.getcwd(), "frames", "f_")
bpy.ops.render.render(animation=True)
print("RENDERED")
`;
    const r = await w.reg.execute("blender_run", { code, timeoutMs: 400000 });
    assert.equal(r.ok, true, JSON.stringify({ code: r.code, out: String(r.output).slice(-500) }));
    assert.equal(fs.readdirSync(path.join(w.dir, "frames")).filter((f) => /\.png$/.test(f)).length, 12, "12 frames rendered");
    const v = await w.reg.execute("ffmpeg_run", { args: "-y -framerate 12 -i frames\\f_%04d.png -c:v libx264 -pix_fmt yuv420p out.mp4", output: "out.mp4", width: 160, height: 120, audio: false });
    assert.equal(v.ok, true, JSON.stringify({ code: v.code, message: v.message, out: String(v.output).slice(-300) }));
    assert.equal(v.media.video.codec, "h264");
    assert.equal(v.media.video.frames, 12);
    assert.ok(Math.abs(v.media.durationSec - 1) < 0.15, `duration ${v.media.durationSec}`);
  } finally { w.done(); }
});

// ---------------------------------------------------------------- OpenCV: a functional test in the process that should run it

test("REAL OpenCV in a separate Python process: read, process, save and decode an image (not just `import cv2`)", { timeout: 120000 }, (t) => {
  const { systemPython } = require("../../creative/runtimes.cjs");
  const sys = systemPython();
  if (!sys || !sys.cv2) return t.skip("no system Python with OpenCV");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-cv-"));
  try {
    const script = path.join(dir, "cv.py");
    fs.writeFileSync(script, [
      "import cv2, numpy as np, sys, json",
      "img = np.zeros((40, 60, 3), np.uint8); img[:, :30] = (0, 0, 255)  # left half red (BGR)",
      "cv2.imwrite(sys.argv[1], img)",
      "back = cv2.imread(sys.argv[1])",
      "assert back is not None and back.shape == (40, 60, 3), back",
      "gray = cv2.cvtColor(back, cv2.COLOR_BGR2GRAY)",
      "blur = cv2.GaussianBlur(gray, (5, 5), 0)",
      "cv2.imwrite(sys.argv[2], blur)",
      "out = cv2.imread(sys.argv[2], cv2.IMREAD_GRAYSCALE)",
      "print(json.dumps({'cv2': cv2.__version__, 'shape': list(out.shape), 'leftMean': float(out[:, :20].mean()), 'rightMean': float(out[:, 40:].mean())}))",
    ].join("\n"));
    const { spawnSync } = require("child_process");
    const r = spawnSync("python", [script, path.join(dir, "in.png"), path.join(dir, "out.png")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
    assert.deepEqual(j.shape, [40, 60]);
    assert.ok(j.leftMean > 50 && j.rightMean < 5, `the red half became grey, the black half stayed black: ${JSON.stringify(j)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
