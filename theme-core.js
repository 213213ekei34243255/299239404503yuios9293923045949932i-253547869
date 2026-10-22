// theme-core.js - Jonah's colour theme: the user picks ONE colour and every purple in the app (home page, browser chrome, assistant panel, voice orb, the logo) follows it.
//
// How it works: every purple-family colour in the pages is written rgb(var(--p-R-G-B)) where R-G-B is the ORIGINAL purple (the list is in theme-tokens.js, the
// defaults in theme-defaults.css, so with no theme chosen nothing changes). Picking a colour recolours each of those originals: its hue is moved by the same
// amount as the base purple's hue moves to the picked hue, and its saturation is scaled by how saturated the pick is (softened, so a vivid pick stays vivid, while grey stays grey). Lightness is kept - the pages are dark,
// so a chosen yellow becomes a readable light yellow, not a glaring one. A grey/white/black pick gives a monochrome theme.
// No DOM is needed for the maths (unit-tested in Node); apply()/applyStored() are the only parts that touch a document.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JonahTheme = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_HEX = "#8b5cf6";
  const KEY = "jonahTheme";
  const BASE_HUE = 258; // hue of #8b5cf6, the page's base purple
  const BASE_SAT = 0.9; // its HSL saturation
  const LOGO_HUE = 277; // measured average hue of assets/IO.png's coloured pixels; it sits 19 degrees above the base, like the page's lighter purples

  /** Named colours offered as swatches (the picker also takes ANY colour). */
  const PRESETS = [
    ["Jonah violet", "#8b5cf6"], ["Indigo", "#6366f1"], ["Blue", "#3b82f6"], ["Sky", "#0ea5e9"], ["Cyan", "#06b6d4"], ["Teal", "#14b8a6"],
    ["Emerald", "#10b981"], ["Green", "#22c55e"], ["Lime", "#84cc16"], ["Yellow", "#eab308"], ["Amber", "#f59e0b"], ["Orange", "#f97316"],
    ["Red", "#ef4444"], ["Crimson", "#dc143c"], ["Rose", "#f43f5e"], ["Pink", "#ec4899"], ["Hot pink", "#ff2d95"], ["Fuchsia", "#d946ef"],
    ["Orchid", "#a855f7"], ["Lavender", "#b69cff"], ["Mint", "#5eead4"], ["Coral", "#ff7f6e"], ["Peach", "#ffb089"], ["Gold", "#d4af37"],
    ["Persimmon", "#ff5c34"], ["Brown", "#a0522d"], ["Navy", "#1e40af"], ["Slate", "#94a3b8"], ["Silver (mono)", "#e0e0e0"],
  ].map(([name, hex]) => ({ name, hex }));

  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  /** "#rgb", "#rrggbb" or "rrggbb" -> [r,g,b], or null. */
  function parseHex(text) {
    let h = String(text == null ? "" : text).trim().replace(/^#/, "");
    if (/^[0-9a-f]{3}$/i.test(h)) h = h.split("").map((c) => c + c).join("");
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const toHex = (rgb) => "#" + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
  const isDefault = (hex) => { const a = parseHex(hex); return !a || toHex(a) === DEFAULT_HEX; };

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, s, l];
  }
  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [r + m, g + m, b + m].map((v) => Math.round(v * 255));
  }

  /** How far to turn hues, and how much colour to keep, for a picked colour. */
  function params(hex) {
    const rgb = parseHex(hex);
    if (!rgb || isDefault(hex)) return { hueShift: 0, satFactor: 1, identity: true };
    const [h, s] = rgbToHsl(...rgb);
    return { hueShift: h - BASE_HUE, satFactor: clamp(Math.pow(s / BASE_SAT, 0.55), 0, 1.15), identity: false };
  }

  /** The recoloured version of one original colour [r,g,b] for the picked colour. */
  function recolor(rgb, hex) {
    const p = params(hex);
    if (p.identity) return rgb.slice();
    const [h, s, l] = rgbToHsl(...rgb);
    return hslToRgb((h + p.hueShift + 360) % 360, clamp(s * p.satFactor, 0, 1), l);
  }

  /** { "p-139-92-246": "34,197,94", ... } for every original colour in `tokens` ([[r,g,b], ...]). */
  function deriveVars(hex, tokens) {
    const out = {};
    for (const t of tokens || []) out[`--p-${t[0]}-${t[1]}-${t[2]}`] = recolor(t, hex).join(",");
    return out;
  }

  /** CSS filter that turns the (purple) logo image to the picked colour. */
  function logoFilter(hex) {
    const p = params(hex);
    if (p.identity) return "none";
    return `hue-rotate(${Math.round(p.hueShift)}deg) saturate(${p.satFactor.toFixed(2)})`;
  }

  // ---------------------------------------------------------------- document side (browser only)
  function readStored() { try { const v = localStorage.getItem(KEY); return v && parseHex(v) ? toHex(parseHex(v)) : DEFAULT_HEX; } catch (_) { return DEFAULT_HEX; } }
  function writeStored(hex) { try { localStorage.setItem(KEY, hex); } catch (_) { /* storage unavailable: the colour just won't persist */ } }

  /** Recolour a document NOW. Returns the hex actually applied. Does not store it. */
  function apply(hex, doc) {
    doc = doc || (typeof document !== "undefined" ? document : null);
    const rgb = parseHex(hex);
    const clean = rgb ? toHex(rgb) : DEFAULT_HEX;
    if (!doc) return clean;
    const el = doc.documentElement, tokens = (typeof window !== "undefined" && window.JONAH_THEME_TOKENS) || [];
    if (isDefault(clean)) {
      for (const t of tokens) el.style.removeProperty(`--p-${t[0]}-${t[1]}-${t[2]}`);
      el.style.removeProperty("--theme-logo-filter");
      el.removeAttribute("data-theme-color");
    } else {
      const vars = deriveVars(clean, tokens);
      for (const k of Object.keys(vars)) el.style.setProperty(k, vars[k]);
      el.style.setProperty("--theme-logo-filter", logoFilter(clean));
      el.setAttribute("data-theme-color", clean);
    }
    el.style.setProperty("--theme-accent", `rgb(${recolor([139, 92, 246], clean).join(",")})`);
    return clean;
  }
  /** Apply what this page last saved (call it early, in <head>, so nothing flashes purple). */
  const applyStored = (doc) => apply(readStored(), doc);
  /** Apply AND save. */
  function set(hex, doc) { const clean = apply(hex, doc); writeStored(clean); return clean; }

  return { DEFAULT_HEX, KEY, BASE_HUE, LOGO_HUE, PRESETS, parseHex, toHex, isDefault, rgbToHsl, hslToRgb, params, recolor, deriveVars, logoFilter, apply, applyStored, set, readStored };
});
