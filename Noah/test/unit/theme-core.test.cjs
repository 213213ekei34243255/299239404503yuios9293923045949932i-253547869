// Noah/test/unit/theme-core.test.cjs - the colour theme (theme-core.js) and the guarantee that every purple in the pages is a theme variable.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const T = require("../../../theme-core.js");
const ROOT = path.resolve(__dirname, "..", "..", "..");
global.window = { JONAH_THEME_TOKENS: null };
const TOKENS = (() => { const src = fs.readFileSync(path.join(ROOT, "theme-tokens.js"), "utf8"); const w = {}; new Function("window", src)(w); return w.JONAH_THEME_TOKENS; })();

test("parseHex takes #rgb, #rrggbb and bare hex, and refuses everything else", () => {
  assert.deepEqual(T.parseHex("#8b5cf6"), [139, 92, 246]);
  assert.deepEqual(T.parseHex("8B5CF6"), [139, 92, 246]);
  assert.deepEqual(T.parseHex("#f0a"), [255, 0, 170]);
  for (const bad of ["", "#12345", "#gggggg", "red", null, undefined, "#8b5cf6ff", "rgb(1,2,3)"]) assert.equal(T.parseHex(bad), null, String(bad));
  assert.equal(T.toHex([139, 92, 246]), "#8b5cf6");
  assert.equal(T.toHex([300, -4, 7.6]), "#ff0008");
});

test("the default purple changes NOTHING: every original colour comes back exactly", () => {
  for (const t of TOKENS) assert.deepEqual(T.recolor(t, T.DEFAULT_HEX), t);
  assert.deepEqual(T.recolor([10, 20, 30], "not a colour"), [10, 20, 30], "an invalid colour falls back to the default, never to garbage");
  assert.equal(T.logoFilter(T.DEFAULT_HEX), "none");
  assert.equal(T.isDefault("#8B5CF6"), true);
});

test("rgb <-> hsl round-trips", () => {
  for (const c of [[139, 92, 246], [0, 0, 0], [255, 255, 255], [34, 197, 94], [250, 204, 21], [12, 200, 230]]) {
    const [h, s, l] = T.rgbToHsl(...c);
    const back = T.hslToRgb(h, s, l);
    assert.ok(back.every((v, i) => Math.abs(v - c[i]) <= 1), `${c} -> ${back}`);
  }
});

test("picking a colour moves EVERY original to that hue family, keeping lightness (dark stays dark, light stays light)", () => {
  for (const [hex, hue] of [["#22c55e", 142], ["#ef4444", 0], ["#0ea5e9", 199], ["#f97316", 25], ["#ec4899", 330]]) {
    const picked = T.rgbToHsl(...T.parseHex(hex))[0];
    for (const t of TOKENS) {
      const [h0, s0, l0] = T.rgbToHsl(...t);
      const out = T.recolor(t, hex);
      const [h1, s1, l1] = T.rgbToHsl(...out);
      assert.ok(Math.abs(l1 - l0) < 0.03, `${hex} ${t}: lightness ${l0.toFixed(2)} -> ${l1.toFixed(2)}`);
      if (s0 > 0.4 && l0 > 0.15 && l0 < 0.9) {
        const expect = (h0 + picked - T.BASE_HUE + 360) % 360, diff = Math.min(Math.abs(h1 - expect), 360 - Math.abs(h1 - expect));
        assert.ok(diff < 6, `${hex} ${t}: hue ${h1.toFixed(0)} expected about ${expect.toFixed(0)}`);
      }
    }
    // the base purple lands on the picked hue itself
    const base = T.rgbToHsl(...T.recolor([139, 92, 246], hex))[0];
    assert.ok(Math.min(Math.abs(base - picked), 360 - Math.abs(base - picked)) < 4, `${hex}: base ${base} vs picked ${picked}`);
    void hue;
  }
});

test("a grey / white / black pick gives a monochrome theme, and a faint colour a faint theme", () => {
  for (const hex of ["#808080", "#ffffff", "#000000", "#e0e0e0"]) {
    for (const t of TOKENS) assert.ok(T.rgbToHsl(...T.recolor(t, hex))[1] < 0.12, `${hex} ${t} should be near grey`);
    assert.match(T.logoFilter(hex), /saturate\(0\.0|saturate\(0\.[01]/);
  }
  const pale = T.rgbToHsl(...T.recolor([139, 92, 246], "#f0b8c8"));
  const vivid = T.rgbToHsl(...T.recolor([139, 92, 246], "#ff2d95"));
  assert.ok(pale[1] < vivid[1], "a paler pick keeps less saturation than a vivid one");
});

test("the logo filter turns the logo hue to the picked hue", () => {
  for (const hex of ["#22c55e", "#ef4444", "#0ea5e9", "#f97316"]) {
    const f = T.logoFilter(hex), deg = Number(/hue-rotate\((-?\d+)deg\)/.exec(f)[1]);
    const picked = T.rgbToHsl(...T.parseHex(hex))[0];
    const logoNow = (T.LOGO_HUE + deg + 720) % 360, want = (picked + (T.LOGO_HUE - T.BASE_HUE) + 360) % 360;
    assert.ok(Math.min(Math.abs(logoNow - want), 360 - Math.abs(logoNow - want)) < 2, `${hex}: logo hue ${logoNow} want ${want}`);
  }
});

test("deriveVars names every token --p-R-G-B and values are valid triples", () => {
  const v = T.deriveVars("#22c55e", TOKENS);
  assert.equal(Object.keys(v).length, TOKENS.length);
  for (const [k, val] of Object.entries(v)) { assert.match(k, /^--p-\d+-\d+-\d+$/); assert.match(val, /^\d{1,3},\d{1,3},\d{1,3}$/); assert.ok(val.split(",").every((n) => Number(n) <= 255)); }
});

test("presets are valid, named, unique, and include the default", () => {
  assert.ok(T.PRESETS.length >= 24);
  assert.equal(new Set(T.PRESETS.map((p) => p.hex)).size, T.PRESETS.length);
  assert.equal(new Set(T.PRESETS.map((p) => p.name)).size, T.PRESETS.length);
  for (const p of T.PRESETS) assert.ok(T.parseHex(p.hex), p.name);
  assert.ok(T.PRESETS.some((p) => p.hex === T.DEFAULT_HEX));
});

test("apply sets and clears variables on a document-like object", () => {
  global.window.JONAH_THEME_TOKENS = TOKENS;
  const props = {}, attrs = {};
  const doc = { documentElement: { style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } }, setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; } } };
  assert.equal(T.apply("#22c55e", doc), "#22c55e");
  assert.equal(Object.keys(props).filter((k) => k.startsWith("--p-")).length, TOKENS.length);
  assert.match(props["--theme-logo-filter"], /hue-rotate/); assert.equal(attrs["data-theme-color"], "#22c55e");
  assert.equal(T.apply("zzz", doc), T.DEFAULT_HEX, "garbage resets to the default");
  assert.equal(Object.keys(props).filter((k) => k.startsWith("--p-")).length, 0);
  assert.equal(props["--theme-logo-filter"], undefined); assert.equal(attrs["data-theme-color"], undefined);
});

// ---- the pages really use the variables

const PAGES = ["home.html", "style.css", "index.html", "voice-orb.js", "ai-panel.html", "hub-ui.js", "downloads-ui.js"];
test("every --p-R-G-B a page uses is defined in theme-defaults.css with its original value, and is in theme-tokens.js", () => {
  const defaults = fs.readFileSync(path.join(ROOT, "theme-defaults.css"), "utf8");
  const defined = new Map([...defaults.matchAll(/--p-(\d+)-(\d+)-(\d+):\s*(\d+),(\d+),(\d+);/g)].map((m) => [`${m[1]},${m[2]},${m[3]}`, `${m[4]},${m[5]},${m[6]}`]));
  for (const [k, v] of defined) assert.equal(k, v, "the default of --p-R-G-B is R,G,B");
  const tokenKeys = new Set(TOKENS.map((t) => t.join(",")));
  for (const k of defined.keys()) assert.ok(tokenKeys.has(k), `${k} missing from theme-tokens.js`);
  assert.equal(defined.size, tokenKeys.size);
  for (const f of PAGES) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const m of src.matchAll(/var\(--p-(\d+)-(\d+)-(\d+)\)/g)) assert.ok(defined.has(`${m[1]},${m[2]},${m[3]}`), `${f} uses an undefined --p-${m[1]}-${m[2]}-${m[3]}`);
  }
});

test("the pages load the theme: defaults CSS, tokens and core, and apply the saved colour before painting", () => {
  for (const f of ["home.html", "index.html", "ai-panel.html"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.match(src, /href="theme-defaults\.css"/, f);
    assert.match(src, /src="theme-tokens\.js"/, f);
    assert.match(src, /src="theme-core\.js"/, f);
    assert.match(src, /JonahTheme\.applyStored\(\)/, f);
    assert.ok(src.indexOf("theme-core.js") < src.indexOf("applyStored"), f);
  }
});

test("no NEW purple-family colour literal sneaks into the themed pages (it would stay purple whatever the user picks)", () => {
  const inFamily = (r, g, b) => { const [h, s] = T.rgbToHsl(r, g, b); return h >= 225 && h <= 300 && s >= 0.15; };
  for (const f of PAGES) {
    let src = fs.readFileSync(path.join(ROOT, f), "utf8");
    // places that cannot hold a variable: canvas charts / SVG attributes / element-category colours in JS data (home.html and index.html scripts), svg attributes
    src = src.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (s) => (f === "home.html" || f === "index.html" ? "" : s));
    const bad = [];
    for (const m of src.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[0-9.]+\s*)?\)/g)) if (inFamily(+m[1], +m[2], +m[3])) bad.push(m[0]);
    for (const m of src.matchAll(/(.{0,14})#([0-9a-f]{6})\b/gi)) { const [r, g, b] = T.parseHex(m[2]); if (inFamily(r, g, b) && !/(stroke|fill|stop-color)=/.test(m[1])) bad.push(m[0]); }
    assert.deepEqual(bad, [], `${f} still has fixed purple colours`);
  }
});
