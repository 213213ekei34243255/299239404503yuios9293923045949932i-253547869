// Noah/perception/color.cjs
//
// Naming a colour the way a person would ("blue", "dark green") and reading one out of CSS. This exists for one
// reason: a colour swatch (a paint program's palette, a colour picker) is normally a bare <div> or <canvas> with
// NO text at all - jspaint's swatches are literally `<div class="swatch color-button" data-color="rgb(0,0,255)">`
// - so an instruction like "click the blue swatch" or "color blue" has nothing to match against. This module turns
// a swatch's actual colour into a name; perception/observer.cjs (_addColorSwatches) uses it to give swatches a
// findable name, the same way _addCodeEditors gives a hidden textarea a findable one.
//
// Pure, dependency-free, no Electron: fully unit-tested on its own (see test/unit/color.test.cjs).
//
// Honest limitation: nearest-name-by-distance is not colour science. A colour roughly halfway between two named
// entries can be named either one; the table favours the common, everyday words (red, blue, green...) a person
// would actually type over precise CSS keyword names, and marks the half-intensity tone of a colour "dark X" so a
// palette that has both (as jspaint's does: red 255,0,0 and maroon-ish 128,0,0) still gets two different names.

"use strict";

// [name, [r,g,b], ...synonyms]. One entry per visually distinct colour a person would name on sight.
//
// Deliberate rule, learned the hard way (see bench/integration/toy-paint-check.cjs and the "dark blue" /
// "navy" bug it caught): a bright/dark PAIR of the same hue - exactly what a real palette offers, jspaint's
// included - must NEVER be named so that one's name contains the other's as a whole word ("blue" inside
// "dark blue"). ax.cjs's own scoreMatch (shared, not something this module controls) gives a query like "blue"
// the SAME score against "blue" and "dark blue" (both contain the token "blue"), so the two would be an
// unresolvable tie and a 50/50 chance of picking the wrong one. The fix is naming, not scoring: use the
// established, genuinely distinct English/CSS word for the darker tone (navy, maroon, olive, ...) as its
// PRIMARY name, never a "dark X" phrase that repeats the bright colour's own word.
const NAMED_COLORS = [
  ["black", [0, 0, 0]],
  ["white", [255, 255, 255]],
  ["gray", [128, 128, 128], "grey"],
  ["silver", [192, 192, 192]],
  ["red", [255, 0, 0]],
  ["maroon", [128, 0, 0]],
  ["pink", [255, 192, 203]],
  ["rose", [255, 20, 147]],
  ["orange", [255, 128, 0]],
  ["orange", [255, 128, 64]],
  ["brown", [128, 64, 0]],
  ["tan", [210, 180, 140], "beige"],
  ["yellow", [255, 255, 0]],
  ["gold", [255, 215, 0]],
  ["olive", [128, 128, 0]],
  ["lime", [0, 255, 0]],
  ["green", [0, 128, 0]],
  ["mint", [0, 255, 128]],
  ["teal", [0, 128, 128]],
  ["cyan", [0, 255, 255], "aqua", "turquoise"],
  ["azure", [0, 128, 255]],
  ["blue", [0, 0, 255]],
  ["navy", [0, 0, 128]],
  ["periwinkle", [128, 128, 255]],
  ["indigo", [64, 0, 255]],
  ["purple", [128, 0, 128]],
  ["violet", [238, 130, 238]],
  ["magenta", [255, 0, 255], "fuchsia"],
];

/** RGB Euclidean distance (cheap, close enough for "which colour is this closest to?"). */
function distance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/**
 * The closest named colour to an [r,g,b] triple (each 0-255).
 * @returns {{ name: string, synonyms: string[], rgb: number[], distance: number }}
 */
function nearestColorName(rgb) {
  let best = null;
  let bestDist = Infinity;
  for (const [name, ref, ...synonyms] of NAMED_COLORS) {
    const d = distance(rgb, ref);
    if (d < bestDist) {
      bestDist = d;
      best = { name, synonyms, rgb: ref, distance: Math.round(d) };
    }
  }
  return best;
}

/** All the words that identify a colour: its name plus its synonyms, each possibly more than one word. */
function namesFor(rgb) {
  const best = nearestColorName(rgb);
  return [best.name, ...best.synonyms];
}

/** "blue"/"blue swatch"/"the blue color" -> a findable element name, e.g. "blue / azure color swatch". */
function swatchLabel(rgb) {
  return `${namesFor(rgb).join(" / ")} color swatch`;
}

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i;
const RGB_FN = /^rgba?\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(?:,\s*(-?[\d.]+))?\s*\)$/i;

/**
 * Parse a CSS colour string ("rgb(0,0,255)", "#0000ff", "#00f", "blue", or a `getComputedStyle` value) into
 * [r, g, b, a] (a in 0-1), or null when it cannot be read as a solid colour (transparent, "none", gradients, ...).
 */
function parseCssColor(value) {
  const s = String(value || "").trim().toLowerCase();
  if (!s || s === "transparent" || s === "none" || s === "inherit" || s === "initial" || s === "unset") return null;
  let m = HEX6.exec(s);
  if (m) {
    const a = m[4] !== undefined ? parseInt(m[4], 16) / 255 : 1;
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), a];
  }
  m = HEX3.exec(s);
  if (m) return [parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16), 1];
  m = RGB_FN.exec(s);
  if (m) {
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
    if (a <= 0) return null;
    return [Math.max(0, Math.min(255, Math.round(parseFloat(m[1])))), Math.max(0, Math.min(255, Math.round(parseFloat(m[2])))), Math.max(0, Math.min(255, Math.round(parseFloat(m[3])))), a];
  }
  for (const [name, rgb, ...synonyms] of NAMED_COLORS) {
    if (s === name || synonyms.includes(s)) return [...rgb, 1];
  }
  if (s === "gray" || s === "grey") return [128, 128, 128, 1];
  return null;
}

/** Does `query` mention this colour (by its name or a synonym, as whole words)? */
function matchesColorQuery(query, rgb) {
  const q = ` ${String(query || "").toLowerCase()} `;
  return namesFor(rgb).some((n) => q.includes(` ${n} `));
}

module.exports = { NAMED_COLORS, nearestColorName, namesFor, swatchLabel, parseCssColor, matchesColorQuery, distance };
