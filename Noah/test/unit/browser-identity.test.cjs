// Noah/test/unit/browser-identity.test.cjs - Jonah introduces itself with the ENGINE'S OWN user agent (no Electron / app tokens) and never with a made-up Chrome version.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { cleanUserAgent, acceptLanguagesFor } = require("../../../browser-identity.cjs");
const ROOT = path.resolve(__dirname, "..", "..", "..");

const REAL = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.80 Electron/45.2.2 Safari/537.36";
const PACKAGED = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Jonah/1.5.5 Chrome/156.0.8078.80 Electron/45.2.2 Safari/537.36";
const CLEAN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

test("the Electron token and the app's own token are removed, and the engine's real Chrome version is kept in Chrome's reduced shape", () => {
  assert.equal(cleanUserAgent(REAL, "Jonah"), CLEAN);
  assert.equal(cleanUserAgent(PACKAGED, "Jonah"), CLEAN);
  assert.equal(cleanUserAgent(PACKAGED, ""), CLEAN, "the Jonah token goes even when the app name is not known");
  assert.equal(cleanUserAgent(CLEAN, "Jonah"), CLEAN, "an already clean agent is unchanged");
  assert.match(cleanUserAgent(REAL, "Jonah"), /Chrome\/156\.0\.0\.0 /, "the major version is the engine's own; Chrome itself sends the rest as 0.0.0");
});

test("the Accept-Language value is the person's own list with weights, the way Chrome sends it", () => {
  assert.equal(acceptLanguagesFor(["en-GB", "en-US", "hi"]), "en-GB,en-US;q=0.9,en;q=0.8,hi;q=0.7", "the exact value a real Chrome on this PC sends");
  assert.equal(acceptLanguagesFor(["en-US"]), "en-US,en;q=0.9");
  assert.equal(acceptLanguagesFor(["hi-IN", "en"]), "hi-IN,hi;q=0.9,en;q=0.8");
  assert.equal(acceptLanguagesFor([]), "en-US,en;q=0.9", "no list: the usual default");
  assert.equal(acceptLanguagesFor(undefined), "en-US,en;q=0.9");
  assert.equal(acceptLanguagesFor(["en-GB", "EN-gb", "en-GB"]), "en-GB,en;q=0.9", "duplicates are dropped");
  assert.equal(acceptLanguagesFor(["not a language", "<script>"]), "en-US,en;q=0.9", "junk is ignored");
  assert.ok(acceptLanguagesFor(Array.from({ length: 30 }, (_, i) => "aa-B" + i)).split(",").length <= 8, "never an endless header");
});

test("an app name with spaces or regex characters is handled, and nothing else is touched", () => {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Jonah_Browser/2.0 Chrome/150.0.0.0 Electron/40.0.0 Safari/537.36";
  assert.equal(cleanUserAgent(ua, "Jonah Browser"), "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36");
  assert.doesNotThrow(() => cleanUserAgent(REAL, "a.b(c)+"));
  assert.equal(cleanUserAgent(undefined), "");
});

test("main.cjs sends no made-up browser version and rewrites no request header", () => {
  const main = fs.readFileSync(path.join(ROOT, "main.cjs"), "utf8");
  assert.doesNotMatch(main, /Chrome\/12\d\.0\.0\.0 Safari/, "no hard-coded Chrome version string");
  assert.doesNotMatch(main, /requestHeaders\["User-Agent"\]/, "the User-Agent header is not overwritten");
  assert.doesNotMatch(main, /requestHeaders\["Accept-Language"\]/, "the language header is not overwritten");
  assert.match(main, /const BROWSER_UA = cleanUserAgent\(app\.userAgentFallback, app\.getName\(\)\)/);
  assert.match(main, /app\.userAgentFallback = BROWSER_UA/);
});

test("the engine is a current Electron (an old Chromium is refused by sites with bot protection), and the Mac minimum matches what it needs", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const major = Number(/(\d+)/.exec(pkg.devDependencies.electron)[1]);
  assert.ok(major >= 45, "Electron " + major + ": Chromium 120 (Electron 28) got Jonah an Access Denied from retail sites");
  const macMin = Number(String(pkg.build.mac.minimumSystemVersion).split(".")[0]);
  assert.ok(major < 44 || macMin >= 13, "Electron 44 and newer need macOS 13 (Ventura): an older Mac must get the system's own message, not a crash at start");
});

test("a website's background is not painted dark behind it: the tab area is white, like every browser", () => {
  const css = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");
  const rule = /#app webview \{[^}]*\}/.exec(css);
  assert.ok(rule, "the webview rule exists");
  assert.match(rule[0], /background:\s*#fff\s*;/);
});
