// Noah/test/unit/license-config.test.cjs
//
// license-config.cjs decides whether a launch of the Mac app must sign in. Since 95cb85a it is required on every Mac; this test covers
// the later change: the Apple Silicon (arm64) build is the unlimited version and skips the sign-in entirely, while an Intel build (even
// one running translated under Rosetta on Apple Silicon hardware - which still reports arch "x64") keeps requiring it.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLicenseConfig } = require("../../../license-config.cjs");

const load = (over) => loadLicenseConfig({ isPackaged: true, env: {}, argv: ["/path/to/Jonah"], dir: "C:/does-not-exist", ...over });

test("Intel Mac (darwin/x64): the sign-in is required", () => {
  assert.equal(load({ platform: "darwin", arch: "x64" }).required, true);
});

test("Apple Silicon build (darwin/arm64): the unlimited version - no sign-in required", () => {
  assert.equal(load({ platform: "darwin", arch: "arm64" }).required, false);
});

test("an Intel build stays gated even when it happens to run under Rosetta on an Apple Silicon Mac (it still reports arch x64)", () => {
  // Rosetta translation is transparent to the process: an x64 binary's own process.arch is "x64" wherever it runs, never "arm64".
  assert.equal(load({ platform: "darwin", arch: "x64" }).required, true);
});

test("JONAH_REQUIRE_LICENSE=1 can still force the gate on for an Apple Silicon build (used to test the gate itself)", () => {
  assert.equal(load({ platform: "darwin", arch: "arm64", env: { JONAH_REQUIRE_LICENSE: "1" } }).required, true);
});

test("--require-license can still force the gate on for an Apple Silicon build", () => {
  assert.equal(load({ platform: "darwin", arch: "arm64", argv: ["/path/to/Jonah", "--require-license"] }).required, true);
});

test("nothing turns the gate OFF for an Intel build - there is no env var or flag for that", () => {
  assert.equal(load({ platform: "darwin", arch: "x64", env: { JONAH_REQUIRE_LICENSE: "0" } }).required, true);
  assert.equal(load({ platform: "darwin", arch: "x64", env: { JONAH_LICENSE_DISABLE: "1" } }).required, true);
});

test("off Mac (development/other OS), unforced: not required, same as before this change", () => {
  assert.equal(load({ platform: "win32", arch: "x64" }).required, false);
  assert.equal(load({ platform: "win32", arch: "arm64" }).required, false, "the arm64 exception only applies to platform darwin");
});

test("off Mac, forced by the test harness's env var or flag: still required (unaffected by this change)", () => {
  assert.equal(load({ platform: "win32", arch: "x64", env: { JONAH_REQUIRE_LICENSE: "1" } }).required, true);
  assert.equal(load({ platform: "win32", arch: "x64", argv: ["/path", "--require-license"] }).required, true);
});

test("arch defaults to process.arch when not supplied (real call shape main.cjs uses)", () => {
  const r = loadLicenseConfig({ isPackaged: true, platform: "darwin", env: {}, argv: [], dir: "C:/does-not-exist" });
  assert.equal(r.required, process.arch !== "arm64");
});

test("the arch check does not disturb serverUrl/publicKeys/configured (unrelated fields)", () => {
  const armed = load({ platform: "darwin", arch: "arm64" });
  const intel = load({ platform: "darwin", arch: "x64" });
  assert.equal(armed.serverUrl, intel.serverUrl);
  assert.deepEqual(armed.publicKeys, intel.publicKeys);
  assert.equal(armed.configured, intel.configured);
});
