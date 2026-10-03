// Noah/test/unit/merge-latest-mac.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeLatestMac } = require("../../../build/merge-latest-mac.cjs");

// the exact shape electron-builder writes (taken from a real Mac build's latest-mac.yml)
const INTEL = `version: 1.4.2
files:
  - url: Jonah-1.4.2-x64.zip
    sha512: INTELZIPSHA==
    size: 360000001
  - url: Jonah-1.4.2-x64.dmg
    sha512: INTELDMGSHA==
    size: 370000002
    blockMapSize: 376214
path: Jonah-1.4.2-x64.zip
sha512: INTELZIPSHA==
releaseDate: '2026-10-03T07:24:00.000Z'
`;
const ARM = `version: 1.4.2
files:
  - url: Jonah-1.4.2-arm64.zip
    sha512: ARMZIPSHA==
    size: 349037751
  - url: Jonah-1.4.2-arm64.dmg
    sha512: ARMDMGSHA==
    size: 360622159
path: Jonah-1.4.2-arm64.zip
sha512: ARMZIPSHA==
releaseDate: '2026-10-03T07:25:00.000Z'
`;

test("merged file lists the files of BOTH Mac builds, each with its own checksum and size", () => {
  const m = mergeLatestMac(INTEL, ARM);
  for (const u of ["Jonah-1.4.2-x64.zip", "Jonah-1.4.2-x64.dmg", "Jonah-1.4.2-arm64.zip", "Jonah-1.4.2-arm64.dmg"]) assert.match(m, new RegExp(`- url: ${u.replace(/\./g, "\\.")}\\n`));
  assert.match(m, /url: Jonah-1\.4\.2-arm64\.zip\n    sha512: ARMZIPSHA==\n    size: 349037751/);
  assert.match(m, /url: Jonah-1\.4\.2-x64\.zip\n    sha512: INTELZIPSHA==\n    size: 360000001/);
  assert.match(m, /blockMapSize: 376214/, "extra per-file fields are kept");
});

test("the merged file is valid for electron-updater: it can pick the right Mac's zip from it", () => {
  const yaml = require("js-yaml"); // electron-updater's own YAML reader
  const doc = yaml.load(mergeLatestMac(INTEL, ARM));
  assert.equal(doc.version, "1.4.2");
  assert.equal(doc.files.length, 4);
  const zips = doc.files.filter((f) => f.url.endsWith(".zip"));
  assert.deepEqual(zips.map((f) => f.url).sort(), ["Jonah-1.4.2-arm64.zip", "Jonah-1.4.2-x64.zip"]);
  // the same rule electron-updater's MacUpdater uses: an arm64 Mac takes the arm64 file, an Intel Mac never takes it
  const forArm = zips.find((f) => f.url.includes("arm64"));
  const forIntel = zips.find((f) => !f.url.includes("arm64") && f.url.includes("x64"));
  assert.equal(forArm.sha512, "ARMZIPSHA==");
  assert.equal(forIntel.sha512, "INTELZIPSHA==");
  assert.equal(doc.path, "Jonah-1.4.2-x64.zip", "the old default download stays the Intel zip");
});

test("the order of the inputs does not lose either build", () => {
  const m = mergeLatestMac(ARM, INTEL);
  assert.match(m, /arm64\.zip/); assert.match(m, /x64\.zip/);
});

test("different versions are refused (never publish a feed that mixes releases)", () => {
  assert.throws(() => mergeLatestMac(INTEL, ARM.replace("1.4.2", "1.4.3")), /different versions/);
});

test("a file with no checksum, no files, or no version is refused", () => {
  assert.throws(() => mergeLatestMac(INTEL.replace("    sha512: INTELDMGSHA==\n", ""), ARM), /no sha512/);
  assert.throws(() => mergeLatestMac("version: 1.4.2\n", ARM), /no files listed/);
  assert.throws(() => mergeLatestMac(INTEL, "files:\n  - url: x\n    sha512: y\n"), /no "version:" line/);
});

test("duplicate entries are listed once", () => {
  const m = mergeLatestMac(INTEL, INTEL);
  assert.equal((m.match(/- url: Jonah-1\.4\.2-x64\.zip/g) || []).length, 1);
});
