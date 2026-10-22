// Noah/test/unit/blender.test.cjs - the blender_run tool (Noah/creative/blender.cjs). The command building, discovery and file checks are tested with fakes;
// the last tests run the REAL Blender installed on this computer (headless, no window) and are skipped when there is none.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { findBlender, buildCommand, parseOutput, inspectFile } = require("../../creative/blender.cjs");
const { Workspace } = require("../../autonomy/tools/workspace.cjs");
const { ToolRegistry, DEFS } = require("../../autonomy/tools/registry.cjs");
const { MissionState } = require("../../autonomy/mission-state.cjs");

const REAL = findBlender();

test("discovery: BLENDER_PATH wins, then the newest version under Program Files, then PATH; nothing found is null", () => {
  const files = new Set(["C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe", "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe", "D:\\tools\\blender.exe"]);
  const exists = (p) => files.has(p);
  const readdir = () => ["Blender 4.2", "Blender 5.2", "Blender 4.10", "readme.txt"];
  const base = { platform: "win32", exists, readdir, env: { ProgramFiles: "C:\\Program Files", PATH: "" } };
  assert.equal(findBlender(base), "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe", "numeric order: 5.2 is newer than 4.10");
  assert.equal(findBlender({ ...base, env: { ...base.env, BLENDER_PATH: "D:\\tools\\blender.exe" } }), "D:\\tools\\blender.exe");
  assert.equal(findBlender({ ...base, readdir: () => [], env: { PATH: "D:\\tools" } }), path.join("D:\\tools", "blender.exe"));
  assert.equal(findBlender({ ...base, exists: () => false, env: { PATH: "" } }), null);
  assert.equal(findBlender({ platform: "darwin", exists: (p) => p === "/Applications/Blender.app/Contents/MacOS/Blender", env: {} }), "/Applications/Blender.app/Contents/MacOS/Blender");
});

test("the command line: headless, factory settings, a script error fails the run, script options after --; anything a shell could read as syntax is refused", () => {
  const exe = "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe";
  assert.equal(buildCommand({ exe, script: "make.py" }).cmd, `"${exe}" --background --factory-startup --python-exit-code 1 --python "make.py"`);
  assert.equal(buildCommand({ exe, script: "make.py", blend: "scene.blend", args: ["--width", "640", "out dir"] }).cmd, `"${exe}" --background --factory-startup --python-exit-code 1 "scene.blend" --python "make.py" -- --width 640 "out dir"`);
  for (const bad of ['a"b.py', "a%PATH%.py", "a$(x).py", "a;b.py", "a\nb.py"]) assert.match(buildCommand({ exe, script: bad }).error, /not allowed/, bad);
  assert.match(buildCommand({ exe, script: "x.py", args: ["& calc"] }).error, /not allowed/);
  assert.match(buildCommand({ exe, script: "x.txt" }).error, /Python file/);
  assert.match(buildCommand({ exe: null, script: "x.py" }).error, /not installed/);
});

test("output parsing and file inspection: saved files, version, errors; a real PNG's size is read, an empty file is not valid", () => {
  const out = "Blender 5.2.2 LTS (hash d13f)\nFra:1 Mem:12M\n00:08.250  render           | Saved: 'C:\\w\\a.png'\nSaved: 'C:\\w\\a.png'\n Time: 00:01.2\n";
  assert.deepEqual(parseOutput(out), { saved: ["C:\\w\\a.png"], version: "5.2.2", scriptError: false });
  assert.equal(parseOutput("Traceback (most recent call last):\n  File x").scriptError, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-bl-"));
  try {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]), Buffer.from([0, 0, 2, 128, 0, 0, 1, 224]), Buffer.alloc(8)]);
    fs.writeFileSync(path.join(dir, "r.png"), png);
    fs.writeFileSync(path.join(dir, "empty.png"), "");
    assert.deepEqual(inspectFile(path.join(dir, "r.png")), { path: path.join(dir, "r.png"), bytes: png.length, kind: "png", width: 640, height: 480, valid: true });
    assert.equal(inspectFile(path.join(dir, "empty.png")).valid, false);
    assert.equal(inspectFile(path.join(dir, "missing.png")).valid, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("blender_run is a registered, mutating tool whose schema a provider accepts; without Blender it says so", async () => {
  assert.ok(DEFS.blender_run);
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-bl-")));
  try {
    fs.writeFileSync(path.join(dir, "s.py"), "print('hi')\n");
    const reg = new ToolRegistry({ workspace: new Workspace({ roots: [dir] }), state: new MissionState({ objective: "x" }), blenderPath: null });
    assert.equal(reg.isMutating("blender_run", { script: "s.py" }), true);
    const schema = reg.schemas().find((s) => s.name === "blender_run");
    assert.deepEqual(schema.parameters.required, [], "script or code: one of them, checked when called");
    const r = await reg.execute("blender_run", { script: "s.py" });
    assert.deepEqual([r.ok, r.code], [false, "blender_not_found"]);
    assert.equal((await new ToolRegistry({ workspace: new Workspace({ roots: [dir] }), state: new MissionState({ objective: "x" }), blenderPath: "C:\\x\\blender.exe" }).execute("blender_run", { script: "nope.py" })).code, "invalid_path");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const SCENE = `
import bpy, sys, os
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
# a table-top scene: floor, a glossy red sphere, a cube, a sun and a camera looking at them
bpy.ops.mesh.primitive_plane_add(size=10, location=(0, 0, 0)); floor = bpy.context.object
bpy.ops.mesh.primitive_uv_sphere_add(radius=1, location=(-1.2, 0, 1)); ball = bpy.context.object
bpy.ops.mesh.primitive_cube_add(size=1.4, location=(1.4, 0, 0.7)); box = bpy.context.object
red = bpy.data.materials.new("Red"); red.use_nodes = True
red.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.9, 0.05, 0.05, 1)
red.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.2
ball.data.materials.append(red)
bpy.ops.object.light_add(type='SUN', location=(4, -4, 6)); bpy.context.object.data.energy = 4
bpy.ops.object.camera_add(location=(0, -7, 3.2), rotation=(1.2, 0, 0)); scene.camera = bpy.context.object
scene.render.engine = 'CYCLES'; scene.cycles.device = 'CPU'; scene.cycles.samples = 16  # (headless EEVEE needs a GPU context: on this computer it crashes, Cycles on the CPU renders)
scene.render.resolution_x = 320; scene.render.resolution_y = 240; scene.render.resolution_percentage = 100
scene.render.filepath = os.path.join(os.getcwd(), "render.png")
bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(os.getcwd(), "scene.blend"))
print("OBJECTS", sorted(o.name for o in scene.objects))
`;

test("REAL Blender: a script builds a scene and renders it; the tool reports the real PNG (size in pixels, not just 'ok') and the saved .blend", { skip: !REAL && "Blender is not installed here", timeout: 240000 }, async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-bl-")));
  try {
    fs.writeFileSync(path.join(dir, "scene.py"), SCENE);
    const reg = new ToolRegistry({ workspace: new Workspace({ roots: [dir] }), state: new MissionState({ objective: "render a scene" }), logDir: path.join(dir, "logs") });
    const r = await reg.execute("blender_run", { script: "scene.py" });
    assert.equal(r.ok, true, JSON.stringify({ code: r.code, message: r.message, tail: String(r.output || "").slice(-600) }));
    assert.match(r.blenderVersion, /^\d+\.\d+/);
    assert.match(r.output, /OBJECTS \['Camera', 'Cube', 'Plane', 'Sphere', 'Sun'\]|OBJECTS \[.*'Camera'.*\]/);
    const png = r.renders.find((x) => x.kind === "png");
    assert.ok(png, "the render was reported: " + JSON.stringify(r.renders));
    assert.deepEqual([png.width, png.height, png.valid], [320, 240, true]);
    assert.ok(png.bytes > 2000, `a real image has content: ${png.bytes} bytes`);
    assert.ok(fs.existsSync(path.join(dir, "scene.blend")) && fs.statSync(path.join(dir, "scene.blend")).size > 1000);
    // the picture is not blank: it has more than a handful of different pixel values (read back with Blender itself)
    fs.writeFileSync(path.join(dir, "check.py"), `import bpy\nim = bpy.data.images.load(r"${path.join(dir, "render.png").replace(/\\/g, "\\\\")}")\npx = list(im.pixels)\nvals = set(round(v, 2) for v in px[0::4])\nred = sum(1 for i in range(0, len(px), 4) if px[i] > 0.5 and px[i+1] < 0.25 and px[i+2] < 0.25)\nprint("DISTINCT_RED_LEVELS", len(vals), "RED_PIXELS", red)\n`);
    const c = await reg.execute("blender_run", { script: "check.py" });
    assert.equal(c.ok, true, c.message);
    const m = /DISTINCT_RED_LEVELS (\d+) RED_PIXELS (\d+)/.exec(c.output);
    assert.ok(m && Number(m[1]) > 20, "not a flat picture: " + (m && m[0]));
    assert.ok(Number(m[2]) > 100, "the red ball is really in the picture: " + (m && m[0]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("REAL Blender: a script that raises fails the run (nothing is reported as made), with the Python error in the output", { skip: !REAL && "Blender is not installed here", timeout: 120000 }, async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-bl-")));
  try {
    fs.writeFileSync(path.join(dir, "bad.py"), "import bpy\nbpy.data.objects['NoSuchObject'].location.x = 1\n");
    const reg = new ToolRegistry({ workspace: new Workspace({ roots: [dir] }), state: new MissionState({ objective: "x" }), logDir: path.join(dir, "logs") });
    const r = await reg.execute("blender_run", { script: "bad.py" });
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 1);
    assert.match(r.output, /KeyError|NoSuchObject/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
