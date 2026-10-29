// Noah/test/unit/store-build.test.cjs - the Microsoft Store (MSIX) version: its identity handling, the "right product only" check, its tile images, and that it never checks GitHub for updates.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveIdentity, checkProduct, builderArgs, PLACEHOLDER_PUBLISHER } = require("../../../build/build-store.cjs");
const ROOT = path.resolve(__dirname, "..", "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const REAL = { STORE_IDENTITY_NAME: "12345CogniAIStudios.Jonah", STORE_PUBLISHER: "CN=ABCDEF12-3456-7890-ABCD-EF1234567890", STORE_PUBLISHER_DISPLAY_NAME: "CogniAI Studios" };

test("with no Partner Center values the package is a local test with the placeholders, and is marked as one", () => {
  const r = resolveIdentity({ env: {}, argv: [], pkg });
  assert.equal(r.real, false);
  assert.deepEqual(r.problems, []);
  assert.equal(r.identity.publisher, PLACEHOLDER_PUBLISHER);
  assert.match(builderArgs({ ...r, out: "x", version: "1.5.3" }).join(" "), /LOCAL-TEST-ONLY/);
});

test("all three Partner Center values (environment or arguments) make a real, upload-ready identity", () => {
  const a = resolveIdentity({ env: REAL, argv: [], pkg });
  assert.equal(a.real, true);
  assert.deepEqual(a.identity, { identityName: REAL.STORE_IDENTITY_NAME, publisher: REAL.STORE_PUBLISHER, publisherDisplayName: REAL.STORE_PUBLISHER_DISPLAY_NAME });
  const b = resolveIdentity({ env: {}, argv: [`--identity-name=${REAL.STORE_IDENTITY_NAME}`, `--publisher=${REAL.STORE_PUBLISHER}`, "--publisher-display-name=CogniAI Studios"], pkg });
  assert.equal(b.real, true);
  const args = builderArgs({ ...a, out: "dist-store", version: "1.5.3" }).join(" ");
  assert.match(args, /-c\.appx\.identityName=12345CogniAIStudios\.Jonah/);
  assert.match(args, /-c\.appx\.artifactName=Jonah-1\.5\.3-store\.\$\{ext\}/);
  assert.doesNotMatch(args, /LOCAL-TEST-ONLY/);
});

test("a half-filled or malformed identity is refused with the reason, never built", () => {
  assert.ok(resolveIdentity({ env: { STORE_IDENTITY_NAME: "Only.Name" }, argv: [], pkg }).problems.some((p) => /all three/.test(p)));
  assert.ok(resolveIdentity({ env: { ...REAL, STORE_IDENTITY_NAME: "no spaces allowed" }, argv: [], pkg }).problems.some((p) => /3 to 50 letters/.test(p)));
  assert.ok(resolveIdentity({ env: { ...REAL, STORE_IDENTITY_NAME: "ab" }, argv: [], pkg }).problems.length > 0, "too short");
  assert.ok(resolveIdentity({ env: { ...REAL, STORE_PUBLISHER: "ABCDEF" }, argv: [], pkg }).problems.some((p) => /CN=/.test(p)));
  assert.ok(resolveIdentity({ env: { ...REAL, STORE_PUBLISHER: PLACEHOLDER_PUBLISHER }, argv: [], pkg }).problems.some((p) => /placeholder/.test(p)));
});

test("--for-submission without the three values exits with an error before building anything", () => {
  const { spawnSync } = require("child_process");
  const env = { ...process.env }; for (const k of Object.keys(REAL)) delete env[k];
  const r = spawnSync(process.execPath, [path.join(ROOT, "build", "build-store.cjs"), "--for-submission"], { env, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs the three Partner Center values/);
});

test("the product check passes for this tree (billing ON, no login files, no key file, tile images present) and fails for an unlimited or sign-in build", () => {
  assert.deepEqual(checkProduct(ROOT), []);
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "store-chk-"));
  fs.mkdirSync(path.join(t, "build", "appx"), { recursive: true });
  for (const n of ["StoreLogo.png", "Square44x44Logo.png", "Square150x150Logo.png", "Wide310x150Logo.png"]) fs.writeFileSync(path.join(t, "build", "appx", n), "x");
  fs.writeFileSync(path.join(t, "entitlements.config.json"), '{"enabled": false}');
  fs.writeFileSync(path.join(t, "license-gate.cjs"), "//");
  fs.writeFileSync(path.join(t, "key.json"), "x");
  const bad = checkProduct(t).join(" | ");
  assert.match(bad, /billing is OFF/);
  assert.match(bad, /license-gate\.cjs is present/);
  assert.match(bad, /key\.json is present/);
  fs.rmSync(t, { recursive: true, force: true });
  assert.match(checkProduct(path.join(t, "nowhere")).join(" "), /missing or unreadable/);
});

test("the Store tile images exist at the sizes the manifest names", () => {
  const sizes = { "StoreLogo.png": [50, 50], "Square44x44Logo.png": [44, 44], "Square150x150Logo.png": [150, 150], "Wide310x150Logo.png": [310, 150] };
  for (const [name, [w, h]] of Object.entries(sizes)) {
    const b = fs.readFileSync(path.join(ROOT, "build", "appx", name));
    assert.equal(b.slice(1, 4).toString(), "PNG", name);
    assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [w, h], name);
  }
});

test("package.json carries the Store identity placeholders in a valid shape, and the build command", () => {
  const a = pkg.build.appx;
  assert.match(a.identityName, /^[A-Za-z0-9.-]{3,50}$/);
  assert.match(a.publisher, /^CN=/);
  assert.equal(a.displayName, "Jonah");
  assert.equal(pkg.scripts["build:store"], "node build/build-store.cjs");
  assert.ok(pkg.build.win.target.includes("nsis-web"), "the normal installer is unchanged");
});

test("inside the Store package the app never checks GitHub for updates (the Store updates it); everywhere else it does", () => {
  const main = fs.readFileSync(path.join(ROOT, "main.cjs"), "utf8");
  const guard = main.indexOf("if (process.windowsStore)");
  const start = main.indexOf("createUpdater({");
  assert.ok(guard > 0 && start > guard, "the Store check comes before the updater is created");
  assert.match(main.slice(guard, start), /Microsoft Store version: updates come from the Store/);
  assert.match(main.slice(guard, start), /} else try {/, "and the updater still starts normally when it is not the Store version");
});

test("electron-builder is started without a shell, so a publisher name with a space stays one argument", () => {
  const src = fs.readFileSync(path.join(ROOT, "build", "build-store.cjs"), "utf8");
  assert.match(src, /spawnSync\(process\.execPath, \[cli, \.\.\.builderArgs/);
  assert.doesNotMatch(src, /shell:\s*process\.platform/);
  const args = builderArgs({ identity: { identityName: "A.Jonah", publisher: "CN=X", publisherDisplayName: "CogniAI Studios" }, real: true, out: "o", version: "1.5.3" });
  assert.ok(args.includes("-c.appx.publisherDisplayName=CogniAI Studios"), "one array element, spaces and all");
});
