// Noah/test/unit/window-guard.test.cjs - the rules for the app's windows and the pages inside them (window-guard.cjs), and their wiring in main.cjs.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { guestPreferences, guestSourceAllowed, hostNavigationAllowed, certificateDecision } = require("../../../window-guard.cjs");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const APP = path.join(ROOT, "fake-app");

test("a <webview> is forced to the safe settings whatever its page asked for", () => {
  const p = guestPreferences({ nodeIntegration: true, nodeIntegrationInSubFrames: true, contextIsolation: false, webSecurity: false, allowRunningInsecureContent: true, sandbox: false, devTools: true, experimentalFeatures: true, preload: "C:/evil/preload.js", preloadURL: "file:///evil.js" }, APP);
  assert.equal(p.nodeIntegration, false);
  assert.equal(p.nodeIntegrationInSubFrames, false);
  assert.equal(p.contextIsolation, true);
  assert.equal(p.webSecurity, true);
  assert.equal(p.allowRunningInsecureContent, false);
  assert.equal(p.sandbox, true);
  assert.equal(p.devTools, false);
  assert.equal(p.experimentalFeatures, false);
  assert.equal(p.preload, undefined);
  assert.equal(p.preloadURL, undefined);
});

test("Jonah's own preload is the one thing a <webview> keeps", () => {
  const own = path.join(APP, "webview-preload.js");
  assert.equal(guestPreferences({ preload: own }, APP).preload, own);
  const asUrl = "file:///" + own.replace(/\\/g, "/");
  assert.equal(guestPreferences({ preloadURL: asUrl }, APP).preloadURL, asUrl, "a <webview> hands it over as a file address");
  assert.equal(guestPreferences({ preloadURL: "file:///C:/evil/preload.js" }, APP).preloadURL, undefined);
  assert.equal(guestPreferences({}, APP).preload, undefined);
});

test("a <webview> cannot start on a javascript: address", () => {
  assert.equal(guestSourceAllowed("javascript:alert(1)"), false);
  assert.equal(guestSourceAllowed("  JavaScript:alert(1)"), false);
  assert.equal(guestSourceAllowed("vbscript:x"), false);
  for (const ok of ["https://example.com/", "file:///C:/app/home.html", "about:blank", ""]) assert.equal(guestSourceAllowed(ok), true, ok);
});

test("the app's own windows may only show files that ship with the app", () => {
  const f = (rel) => "file:///" + path.join(APP, rel).replace(/\\/g, "/");
  assert.equal(hostNavigationAllowed(f("index.html"), APP), true);
  assert.equal(hostNavigationAllowed(f("Noah/overlay.html"), APP), true);
  assert.equal(hostNavigationAllowed("about:blank", APP), true);
  for (const bad of ["https://evil.example/", "http://127.0.0.1:5589/search.html", "javascript:alert(1)", "data:text/html,hi", "file:///C:/Windows/System32/drivers/etc/hosts", "file:///" + path.join(ROOT, "other", "x.html").replace(/\\/g, "/"), f("../outside.html"), "", "not a url"]) assert.equal(hostNavigationAllowed(bad, APP), false, bad);
  // a sibling folder whose name merely starts with the app folder's name is NOT inside it
  assert.equal(hostNavigationAllowed("file:///" + (APP + "-evil").replace(/\\/g, "/") + "/x.html", APP), false);
});

test("an invalid certificate is refused", () => {
  assert.equal(certificateDecision(), false);
});

test("main.cjs uses all four, and no longer accepts every certificate or insecure content", () => {
  const main = fs.readFileSync(path.join(ROOT, "main.cjs"), "utf8");
  assert.match(main, /require\(['"]\.\/window-guard\.cjs['"]\)/);
  assert.match(main, /guestPreferences\(/);
  assert.match(main, /guestSourceAllowed\(/);
  assert.match(main, /hostNavigationAllowed\(/);
  assert.match(main, /certificateDecision\(/);
  assert.doesNotMatch(main, /callback\(true\)/, "no blanket certificate approval");
  assert.doesNotMatch(main, /allowRunningInsecureContent:\s*true/);
});
