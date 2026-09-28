// Noah/test/unit/color.test.cjs
//
// perception/color.cjs is pure (no Electron), so it is tested directly. The jspaint RGB values below are the
// REAL values read live from https://jspaint.app's own 28-colour palette (data-color attributes), not invented.

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { nearestColorName, namesFor, swatchLabel, parseCssColor, matchesColorQuery } = require("../../perception/color.cjs");

test("nearestColorName: the everyday words a person would actually say", () => {
  const name = (rgb) => nearestColorName(rgb).name;
  assert.equal(name([255, 0, 0]), "red");
  assert.equal(name([0, 255, 0]), "lime"); // CSS's own convention: the "green" keyword is (0,128,0), pure (0,255,0) is "lime"
  assert.equal(name([0, 0, 255]), "blue");
  assert.equal(name([255, 255, 0]), "yellow");
  assert.equal(name([0, 0, 0]), "black");
  assert.equal(name([255, 255, 255]), "white");
  assert.equal(name([128, 128, 128]), "gray");
  assert.equal(name([255, 128, 0]), "orange");
  assert.equal(name([255, 0, 255]), "magenta");
  assert.equal(name([128, 0, 128]), "purple");
});

test("nearestColorName: jspaint's actual palette values (measured live) resolve to distinct, sensible names", () => {
  const name = (rgb) => nearestColorName(rgb).name;
  // top row (darker tones) vs bottom row (bright tones) of jspaint's default palette must not collapse to one name
  assert.equal(name([128, 0, 0]), "maroon");
  assert.notEqual(name([128, 0, 0]), name([255, 0, 0]));
  assert.equal(name([0, 128, 0]), "green");
  assert.notEqual(name([0, 128, 0]), name([0, 255, 0]));
  assert.equal(name([0, 128, 128]), "teal");
  assert.equal(name([0, 0, 128]), "navy");
  assert.equal(name([128, 128, 0]), "olive");
  assert.equal(name([192, 192, 192]), "silver");
});

// The bug bench/integration/toy-paint-check.cjs caught live: a bright/dark pair named e.g. "blue" and "dark blue"
// ties in ax.cjs's own scoreMatch for the query "blue" (both contain the token "blue"), a 50/50 chance of the
// WRONG colour being clicked. None of the primary names here may contain another primary name as a whole word.
// Mechanical guardrail, not a one-off assertion: NAMED_COLORS must keep this invariant forever, or a future edit
// (adding a colour, "helpfully" adding a synonym) can silently reopen the exact tie this project hit. Checks every
// name AND every synonym, against every OTHER entry's primary name - a synonym containing another entry's own word
// is just as much of a tie (that is literally how "dark blue" as a synonym of navy broke "blue"/"color blue").
test("no colour's name or synonym contains a DIFFERENT colour's primary name as a whole word (the exact tie this project hit)", () => {
  const { NAMED_COLORS } = require("../../perception/color.cjs");
  const primaries = NAMED_COLORS.map(([name]) => name);
  const words = (s) => s.toLowerCase().split(/\s+/);
  for (const [name, , ...synonyms] of NAMED_COLORS) {
    for (const label of [name, ...synonyms]) {
      for (const other of primaries) {
        if (other === name) continue;
        assert.ok(!words(label).includes(other), `"${label}" (of "${name}") must not contain the whole word "${other}" - they would tie for a query of "${other}"`);
      }
    }
  }
});

test("nearestColorName is total: every RGB in range gets some name and a distance", () => {
  for (const rgb of [[1, 2, 3], [254, 1, 90], [17, 200, 201], [90, 90, 91]]) {
    const best = nearestColorName(rgb);
    assert.equal(typeof best.name, "string");
    assert.ok(best.name.length > 0);
    assert.ok(Number.isFinite(best.distance) && best.distance >= 0);
  }
});

test("namesFor includes synonyms, so either wording matches", () => {
  assert.deepEqual(namesFor([0, 0, 128]), ["navy"]);
  assert.deepEqual(namesFor([128, 128, 128]), ["gray", "grey"]);
});

test("swatchLabel: a findable element name built from the colour alone", () => {
  assert.equal(swatchLabel([0, 0, 255]), "blue color swatch");
  assert.equal(swatchLabel([0, 0, 128]), "navy color swatch");
});

test("matchesColorQuery: matches the reported failure ('color blue') and plain wording, not unrelated words", () => {
  assert.ok(matchesColorQuery("color blue", [0, 0, 255]));
  assert.ok(matchesColorQuery("the blue one", [0, 0, 255]));
  assert.ok(matchesColorQuery("Blue", [0, 0, 255]));
  assert.ok(matchesColorQuery("navy", [0, 0, 128]));
  assert.ok(!matchesColorQuery("color red", [0, 0, 255]));
  assert.ok(!matchesColorQuery("bluetooth", [0, 0, 255]), "whole-word match only, not a substring hit inside another word");
});

test("a bright/dark pair (blue vs navy) scores UNAMBIGUOUSLY for a plain colour query - the exact tie this project hit", () => {
  const { findElements } = require("../../perception/ax.cjs");
  const elements = [
    { ref: "e1", role: "button", name: swatchLabel([0, 0, 255]), interactive: true, order: 1 }, // blue
    { ref: "e2", role: "button", name: swatchLabel([0, 0, 128]), interactive: true, order: 2 }, // navy
  ];
  for (const q of ["blue", "color blue", "the blue swatch", "click blue"]) {
    const found = findElements(elements, q, { limit: 5 });
    assert.equal(found[0].ref, "e1", `"${q}" must resolve to blue (e1), not navy - got ${JSON.stringify(found.map((f) => [f.ref, f.name, f.score]))}`);
    const contenders = found.filter((f) => f.score >= found[0].score - 8);
    assert.equal(contenders.length, 1, `"${q}" must be unambiguous (1 contender), got ${contenders.length}: ${JSON.stringify(contenders.map((f) => f.ref))}`);
  }
  const navyFound = findElements(elements, "navy", { limit: 5 });
  assert.equal(navyFound[0].ref, "e2");
});

test("parseCssColor: rgb()/rgba(), hex (3/6/8 digit), and named colours", () => {
  assert.deepEqual(parseCssColor("rgb(0, 0, 255)"), [0, 0, 255, 1]);
  assert.deepEqual(parseCssColor("rgb(0,128,128)"), [0, 128, 128, 1]); // jspaint's exact data-color format, no spaces
  assert.deepEqual(parseCssColor("rgba(255, 0, 0, 0.5)"), [255, 0, 0, 0.5]);
  assert.deepEqual(parseCssColor("#0000ff"), [0, 0, 255, 1]);
  assert.deepEqual(parseCssColor("#00f"), [0, 0, 255, 1]);
  assert.deepEqual(parseCssColor("#0000ff80"), [0, 0, 255, 128 / 255]);
  assert.deepEqual(parseCssColor("BLUE"), [0, 0, 255, 1]);
  assert.deepEqual(parseCssColor("navy"), [0, 0, 128, 1]);
  assert.deepEqual(parseCssColor("grey"), [128, 128, 128, 1]);
});

test("parseCssColor: not a solid colour -> null (never crashes, never invents a colour)", () => {
  for (const bad of ["transparent", "none", "", null, undefined, "url(#gradient)", "rgba(0,0,0,0)", "inherit"]) {
    assert.equal(parseCssColor(bad), null, JSON.stringify(bad));
  }
});

test("out-of-range and fractional channel values are clamped, not left invalid", () => {
  assert.deepEqual(parseCssColor("rgb(300, -10, 128.7)"), [255, 0, 129, 1]);
});
