// Noah/test/unit/mac-installer-script.test.cjs
// The Mac installer is a bash script. Its asset selection and refusal rules can be exercised here without a Mac or a network, via
// JONAH_RELEASE_JSON (a fake release description) and JONAH_INSTALL_DRY_RUN. What can NOT be tested here: the real download, ditto/xattr/open.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "../../../build/install-jonah-mac.command");
const bash = (() => { const r = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }); return r.status === 0 ? "bash" : null; })();
const skip = bash ? false : "bash is not available on this machine";

function release(assets) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jonah-inst-")), "release.json");
  fs.writeFileSync(f, JSON.stringify({ tag_name: "v1.4.2", assets: assets.map((n) => ({ name: n, browser_download_url: `https://github.com/o/r/releases/download/v1.4.2/${n}` })) }, null, 2));
  return f;
}
const ALL = ["Jonah-1.4.2-x64.dmg", "Jonah-1.4.2-x64.zip", "Jonah-1.4.2-arm64.dmg", "Jonah-1.4.2-arm64.zip", "Jonah-Web-Setup-1.4.2.exe", "SHA256SUMS.txt", "latest.yml"];
const run = (assets, arch) => spawnSync(bash, [SCRIPT], { encoding: "utf8", env: { ...process.env, JONAH_RELEASE_JSON: release(assets), JONAH_FORCE_ARCH: arch, JONAH_INSTALL_DRY_RUN: "1" } });

test("the script is valid bash", { skip }, () => {
  const r = spawnSync(bash, ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("an Intel Mac is offered the x64 zip, never the arm64 one", { skip }, () => {
  const r = run(ALL, "x64");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Jonah-1\.4\.2-x64\.zip/);
  assert.doesNotMatch(r.stdout, /arm64/);
  assert.match(r.stdout, /DRY RUN: would download https:\/\/github\.com\/o\/r\/releases\/download\/v1\.4\.2\/Jonah-1\.4\.2-x64\.zip/);
});

test("an Apple Silicon Mac is offered the arm64 zip, never the Intel one", { skip }, () => {
  const r = run(ALL, "arm64");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Jonah-1\.4\.2-arm64\.zip/);
  assert.doesNotMatch(r.stdout, /x64/);
});

test("it never picks the .dmg, the Windows installer or an update-feed file", { skip }, () => {
  const r = run(["Jonah-1.4.2-x64.dmg", "Jonah-Web-Setup-1.4.2.exe", "latest-mac.yml", "SHA256SUMS.txt", "Jonah-1.4.2-x64.zip.blockmap", "Jonah-1.4.2-x64.zip"], "x64");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would download \S+Jonah-1\.4\.2-x64\.zip$/m);
});

test("a release with no build for this kind of Mac is refused with a clear message", { skip }, () => {
  const r = run(["Jonah-1.4.2-x64.zip", "SHA256SUMS.txt"], "arm64");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no download for arm64 Macs/);
});

test("a release with no checksum file is refused - it will not install an unchecked download", { skip }, () => {
  const r = run(["Jonah-1.4.2-x64.zip"], "x64");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no checksum file/);
});

test("an unknown architecture value is refused", { skip }, () => {
  const r = run(ALL, "ppc");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown architecture/);
});

test("the script points at this project's repository and downloads only over https", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const pub = require("../../../package.json").build.publish;
  assert.ok(src.includes(`OWNER="${pub.owner}"`) && src.includes(`REPO="${pub.repo}"`), "owner/repo match package.json build.publish");
  assert.doesNotMatch(src, /http:\/\/(?!127)/, "no plain-http downloads");
  assert.match(src, /shasum -a 256/, "checks the download before installing");
  assert.match(src, /checksum mismatch\)\. Nothing was installed/, "a bad checksum stops the install");
});
