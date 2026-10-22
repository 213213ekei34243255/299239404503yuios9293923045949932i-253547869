// Noah/test/unit/license-config.test.cjs - license-config.cjs decides whether a launch of the Mac app must sign in.
// In the "login" build (version 2.0.5, Windows and Apple Silicon) EVERY launch of an installed copy must, Mac arm64 included (the old exception of commit e53cba2 is gone on purpose).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLicenseConfig } = require("../../../license-config.cjs");

const load = (over) => loadLicenseConfig({ isPackaged: true, env: {}, argv: ["/path/to/Jonah"], dir: "C:/does-not-exist", ...over });

test("Apple Silicon Mac (darwin/arm64): the sign-in is required", () => {
  assert.equal(load({ platform: "darwin", arch: "arm64" }).required, true);
});

test("Intel Mac (darwin/x64): the sign-in is required too", () => {
  assert.equal(load({ platform: "darwin", arch: "x64" }).required, true);
});

test("nothing turns the gate OFF for a Mac: no environment variable and no flag", () => {
  for (const arch of ["arm64", "x64"]) {
    assert.equal(load({ platform: "darwin", arch, env: { JONAH_REQUIRE_LICENSE: "0" } }).required, true, arch);
    assert.equal(load({ platform: "darwin", arch, env: { JONAH_LICENSE_DISABLE: "1" } }).required, true, arch);
    assert.equal(load({ platform: "darwin", arch, isPackaged: false, env: { JONAH_REQUIRE_LICENSE: "0" } }).required, true, arch);
  }
});

test("an INSTALLED Windows copy must sign in too, and nothing turns that off", () => {
  for (const arch of ["x64", "arm64"]) {
    assert.equal(load({ platform: "win32", arch }).required, true, arch);
    assert.equal(load({ platform: "win32", arch, env: { JONAH_REQUIRE_LICENSE: "0" } }).required, true, arch);
    assert.equal(load({ platform: "win32", arch, env: { JONAH_LICENSE_DISABLE: "1" } }).required, true, arch);
    assert.equal(load({ platform: "win32", arch, argv: ["C:/Jonah.exe", "--no-license"] }).required, true, arch);
  }
});

test("a development run of the source (not installed) is only gated when the harness forces it", () => {
  assert.equal(load({ platform: "win32", arch: "x64", isPackaged: false }).required, false);
  assert.equal(load({ platform: "win32", arch: "x64", isPackaged: false, env: { JONAH_REQUIRE_LICENSE: "1" } }).required, true);
  assert.equal(load({ platform: "win32", arch: "x64", isPackaged: false, argv: ["/path", "--require-license"] }).required, true);
});

test("the keys and the server come from the file the build writes into the app, and a packaged app ignores the environment", () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lic-cfg-"));
  fs.writeFileSync(path.join(dir, "license-config.generated.json"), JSON.stringify({ serverUrl: "https://www.jonahbrowser.store", publicKeys: [{ kid: "kf27542eb16", spki: "MCowBQYDK2VwAyEAH8TMF04SAvbpDFGXw_Mnr35rMV0vAy8uUfmpn5f1C4g" }, { nope: 1 }] }));
  try {
    const c = loadLicenseConfig({ isPackaged: true, platform: "darwin", arch: "arm64", env: { JONAH_LICENSE_URL: "https://evil.example", JONAH_LICENSE_KEYS: "[]" }, argv: [], dir });
    assert.equal(c.serverUrl, "https://www.jonahbrowser.store");
    assert.deepEqual(c.publicKeys.map((k) => k.kid), ["kf27542eb16"]);
    assert.equal(c.configured, true);
    assert.equal(c.allowInsecureLoopback, false);
    const none = loadLicenseConfig({ isPackaged: true, platform: "darwin", arch: "arm64", env: {}, argv: [], dir: path.join(dir, "nowhere") });
    assert.equal(none.configured, false, "without the file the build says it is not set up");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
