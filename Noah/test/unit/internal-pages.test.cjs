// Noah/test/unit/internal-pages.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { isInternalUrl, displayUrl, canCite } = require("../../../internal-pages.js");

const ROOT = path.join(__dirname, "../../..");

test("every way Jonah's own pages can be written is internal, and shows an EMPTY address bar (no file name ever)", () => {
  const internal = [
    "home.html", "toy-paint.html", "error.html", "search.html", "citation.html", "fifaworld.html", "focus-blocked.html", "world_cup_champion_predictor.html",
    "home.html?x=1", "home.html#top",
    "file:///C:/Users/SHARON&SHAUN/AppData/Local/Programs/Jonah/resources/app.asar/home.html",
    "file:///C:/Jonah2/home.html", "FILE:///c:/jonah2/Home.HTML", "file://localhost/c:/x.html",
    "http://127.0.0.1:5589/search.html", "http://localhost:5589/home.html", "https://127.0.0.1:5589/x",
    "about:blank", "data:text/html,<h1>x</h1>", "blob:null/abc", "javascript:alert(1)", "chrome-error://chromewebdata/", "jonah://something", "",
    "   ", null, undefined,
  ];
  for (const u of internal) {
    assert.equal(isInternalUrl(u), true, `isInternalUrl(${JSON.stringify(u)})`);
    if (!/google-blocked/.test(String(u))) assert.equal(displayUrl(u), "", `displayUrl(${JSON.stringify(u)}) must be empty`);
  }
});

test("the blocked page keeps its friendly name; it is still never a file name", () => {
  assert.equal(displayUrl("file:///C:/Jonah2/google-blocked.html"), "Jonah://blocked");
  assert.equal(displayUrl("google-blocked.html"), "Jonah://blocked");
});

test("real websites are shown unchanged, including ones that merely look like local things", () => {
  const web = ["https://www.google.com/search?q=a", "http://example.com/page.html", "https://example.com/home.html", "https://example.org:5589/", "http://localhost:3000/", "http://127.0.0.1:8080/x.html", "https://file.example.com/"];
  for (const u of web) { assert.equal(isInternalUrl(u), false, u); assert.equal(displayUrl(u), u, u); }
});

test("canCite: only real http(s) websites - never Jonah's own pages, files, or empty pages", () => {
  for (const u of ["https://en.wikipedia.org/wiki/Whale", "http://example.com/a?b=c#d", "http://localhost:3000/", "https://example.com/home.html"]) assert.equal(canCite(u), true, u);
  for (const u of ["home.html", "file:///C:/Jonah2/home.html", "http://127.0.0.1:5589/search.html", "about:blank", "data:text/html,x", "", null, undefined, "ftp://example.com/x", "toy-paint.html"]) assert.equal(canCite(u), false, String(u));
});

// ---- the places that use it (a regression net: each of these once wrote a raw address into the bar)
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("the shell loads internal-pages.js before any script that needs it", () => {
  const html = read("index.html");
  const i = html.indexOf('src="internal-pages.js"');
  assert.ok(i > 0, "index.html loads internal-pages.js");
  assert.ok(i < html.indexOf("<body>"), "it is loaded in <head>, before every other script");
});

test("no code path copies a raw page address into the address bar", () => {
  const r = read("renderer.js"), h = read("index.html");
  // switching tabs and every navigation event must go through displayUrl
  assert.match(r, /getElementById\("urlBar"\)\.value = JonahUrls\.displayUrl\(e\.url\)/, "did-navigate");
  assert.match(r, /bar\.value = JonahUrls\.displayUrl\(u\)/, "syncAddress");
  assert.match(r, /getElementById\("urlBar"\)\.value = JonahUrls\.displayUrl\(tab\.url \|\| ""\)/, "switchTab");
  assert.doesNotMatch(r, /getElementById\("urlBar"\)\.value = e\.url;/);
  assert.doesNotMatch(r, /getElementById\("urlBar"\)\.value = tab\.url \|\| ""/);
  assert.match(h, /urlbar\.value = JonahUrls\.displayUrl\(url\)/, "updateURLBar");
  assert.match(h, /return JonahUrls\.displayUrl\(url\)/, "formatURL");
});

test("the citation button is blocked off real websites: guarded when clicked, and shown disabled", () => {
  const h = read("index.html"), r = read("renderer.js");
  const fn = h.slice(h.indexOf("async function openCitationOverlay()"), h.indexOf("async function openCitationOverlay()") + 900);
  assert.match(fn, /JonahUrls\.canCite\(/, "openCitationOverlay checks the page first");
  assert.ok(fn.indexOf("canCite") < fn.indexOf("executeJavaScript"), "the check happens before anything is run in the page");
  assert.match(h, /function syncCiteButton\(\)/);
  assert.match(r, /syncCiteButton\(\)/, "pageChanged keeps the button state in step with the page");
});
