// Noah/autonomy/tools/test-paths.cjs
//
// Which files ARE a project's checks: tests, specs, snapshots, mocks. A mission is judged by running them, so changing one of them can make
// a check pass without the code being any better ("make the tests pass" met by editing the test to set a fake key). Changing an EXISTING
// one is therefore always put to the user, and the final message lists every test file that was changed or added.
//
// This is a path heuristic, not a proof: a command can still edit a file (the command policy reviews those separately), and a test kept
// under an unusual name is not recognised. It is meant to catch the common cases, not to be a boundary.

"use strict";

const DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "__snapshots__", "__fixtures__", "fixtures", "__mocks__"]);

// file names, matched case-insensitively unless noted
const NAMES = [
  /\.(test|spec)\.[a-z0-9]+$/i, // index.test.js, cart.spec.ts
  /(^|[._-])tests?\.[a-z0-9]+$/i, // test.js, my_test.go, cart-test.py   (NOT latest.js: the separator is required)
  /^test[_-]/i, // test_cart.py
  /^conftest\.py$/i,
  /\.snap$/i, // jest/pytest snapshots
  // how the tests are RUN is as much the project's evidence as the tests: pointing the runner somewhere else can make anything pass
  /^(jest|vitest|playwright|cypress|karma)\.config\./i, /^pytest\.ini$/i, /^tox\.ini$/i, /^\.mocharc/i, /^noxfile\.py$/i, /^\.nycrc/i,
];
// language conventions with a capital letter, matched case-SENSITIVELY: FooTest.java, BarTests.cs
const CAMEL = /[a-z0-9]Tests?\.(java|kt|cs|swift|scala)$/;

/** @param {string} rel a path as shown to the user (relative to the project folder, either slash) */
function isTestPath(rel) {
  const parts = String(rel || "").replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return false;
  const file = parts[parts.length - 1];
  if (parts.slice(0, -1).some((d) => DIRS.has(d.toLowerCase()))) return true;
  return NAMES.some((re) => re.test(file)) || CAMEL.test(file);
}

// package.json scripts that ARE the checks, and the runners' own settings blocks
const CHECK_SCRIPT = /^(pre|post)?(test|lint|check|typecheck|verify|ci)(:.*)?$/i;
const RUNNER_SETTINGS = ["jest", "mocha", "ava", "vitest", "nyc", "c8"];

/**
 * Does this change to a file change HOW THE CHECKS RUN (not the tests themselves)? Found by a live run: told it may not touch the test, the
 * model rewrote the "test" script in package.json instead. Returns a reason to show the user, or null. Only package.json is parsed; the
 * runner config files are matched by name in isTestPath.
 * @param {string} rel     the path as shown to the user
 * @param {string} before  the file's text before the change
 * @param {string} after   the file's text after it
 */
function changesTestRun(rel, before, after) {
  const file = String(rel || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
  if (file !== "package.json") return null;
  const parse = (t) => { try { const v = JSON.parse(String(t).replace(/^﻿/, "")); return v && typeof v === "object" ? v : {}; } catch (_) { return null; } };
  const b = parse(after);
  if (!b) return null; // not valid JSON afterwards: npm cannot run it, so there is nothing to gain
  const a = parse(before) || {};
  const sa = a.scripts && typeof a.scripts === "object" ? a.scripts : {};
  const sb = b.scripts && typeof b.scripts === "object" ? b.scripts : {};
  for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    if (CHECK_SCRIPT.test(k) && sa[k] !== sb[k]) return `changes how the tests are run (the "${k}" script in package.json)`;
  }
  for (const k of RUNNER_SETTINGS) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return `changes how the tests are run (the "${k}" settings in package.json)`;
  }
  return null;
}

module.exports = { isTestPath, changesTestRun };
