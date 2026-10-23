// Noah/test/unit/app-hardening.test.cjs - what keeps the installed app from being opened up: Electron fuses, no debugger switches, no developer tools, no stray Node mode.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("the installer turns off Node mode, NODE_OPTIONS and the --inspect switches, and only loads the app from app.asar", () => {
  const f = JSON.parse(read("package.json")).build.electronFuses;
  assert.ok(f, "electronFuses is set in the build config");
  assert.equal(f.runAsNode, false);
  assert.equal(f.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(f.enableNodeCliInspectArguments, false);
  assert.equal(f.onlyLoadAppFromAsar, true);
});

test("nothing in the app needs Node mode (the fuse would break it): no ELECTRON_RUN_AS_NODE, no fork of the app's own executable", () => {
  const skip = new Set(["node_modules", ".git", "dist", "dist-win", "Kokoro-82M", "jonah-search", "jonah-backend", "bench", "test", "website", "npm"]);
  const bad = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name) || e.name.startsWith("jonah-new-features")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(cjs|js)$/.test(e.name) || e.name === "server2.js") continue; // server2.js is the hosted speech server, not part of the app
      const t = fs.readFileSync(p, "utf8");
      if (/ELECTRON_RUN_AS_NODE|utilityProcess|child_process["']\)\.fork\(|\bfork\(process\.execPath/.test(t)) bad.push(path.relative(ROOT, p));
    }
  })(ROOT);
  assert.deepEqual(bad, []);
});

test("an installed copy exits at once when started with a debugger or remote-debugging switch", () => {
  const main = read("main.cjs");
  const line = main.split(/\r?\n/).find((l) => l.includes("app.isPackaged && process.argv.some"));
  assert.ok(line, "the guard exists");
  const re = new RegExp(/\/(\^--\(.*\))\/i/.exec(line)[1].replace(/^\//, ""), "i");
  for (const a of ["--remote-debugging-port=9222", "--remote-debugging-pipe", "--inspect", "--inspect-brk=9229", "--inspect-port=1", "--js-flags=--expose-gc"]) assert.ok(re.test(a), a);
  for (const a of ["--user-data-dir=C:/x", "--wait-for-pid=12", "--admin-declined"]) assert.ok(!re.test(a), a);
  assert.ok(main.indexOf("app.isPackaged && process.argv.some") < main.indexOf("app.whenReady()"), "it runs before the app starts anything");
});

test("developer tools stay off in every window and webview of the app", () => {
  const main = read("main.cjs");
  assert.ok(!/devTools:\s*true/.test(main));
  assert.ok(!/openDevTools\(/.test(main));
  assert.ok((main.match(/devTools:\s*false/g) || []).length >= 2);
});
