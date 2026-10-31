// Noah/test/unit/windows-installer.test.cjs - Windows ships as ONE full installer (the whole app inside), never as the small web installer, and the release workflow publishes exactly the files the in-app updater needs.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const yaml = (() => { try { return require("js-yaml"); } catch (_) { return null; } })();
const ROOT = path.resolve(__dirname, "..", "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");

test("package.json builds the full NSIS installer: no web installer target or settings are left", () => {
  assert.deepEqual(pkg.build.win.target, ["nsis"]);
  assert.equal("nsisWeb" in pkg.build, false);
  assert.equal(pkg.build.win.artifactName, "${productName}-Setup-${version}.${ext}", "Jonah-Setup-<version>.exe");
  assert.equal(pkg.build.nsis.oneClick, false, "the assisted installer (choose the folder) is unchanged");
  assert.equal(pkg.build.publish.repo, "jonah-releases", "the in-app updater still reads the public releases repository");
});

test("the release workflow builds nsis (not nsis-web) and stages the installer, its blockmap and latest.yml", () => {
  assert.doesNotMatch(wf, /nsis-web|Web-Setup|nsis\.7z/, "no trace of the web installer");
  assert.match(wf, /npx electron-builder --win nsis --x64 --publish never/);
  if (!yaml) return;
  const win = yaml.load(wf).jobs.build.strategy.matrix.include.find((m) => m.id === "windows");
  assert.deepEqual(win.paths.split("\n").filter(Boolean), ["dist/*.exe", "dist/*.exe.blockmap", "dist/latest.yml"]);
});

test("the release notes tell Windows users to download the full installer", () => {
  assert.match(wf, /\*\*Windows\*\* - download `Jonah-Setup-\*\.exe`/);
  assert.match(wf, /about 600 MB/);
});

test("every build prints a signing report and a failing report never fails the build", () => {
  const i = wf.indexOf("- name: Signing report");
  assert.ok(i > 0, "the step exists");
  const step = wf.slice(i, wf.indexOf("- name:", i + 10));
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /Get-AuthenticodeSignature/);
  assert.match(step, /codesign -dv/);
});
