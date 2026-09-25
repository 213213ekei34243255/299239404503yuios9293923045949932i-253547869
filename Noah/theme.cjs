// Noah/theme.cjs
//
// Single source of truth for Noah's visual identity. The renderer never
// hard-codes these values: main sends them once (`noah:get-theme`) and the
// overlay sets them as CSS custom properties. Change them here (or override
// via config `theme`) and every consumer follows.

"use strict";

const NOAH_CURSOR_PRIMARY = "#7C3AED";
const NOAH_CURSOR_ACCENT = "#A855F7";
const NOAH_CURSOR_GLOW = "rgba(124, 58, 237, 0.35)";

// Semantic state colours (kept separate so the purple identity stays purple).
const NOAH_CURSOR_SUCCESS = "#22C55E";
const NOAH_CURSOR_ERROR = "#EF4444";
const NOAH_CURSOR_WARN = "#F59E0B";

const DEFAULT_THEME = Object.freeze({
  NOAH_CURSOR_PRIMARY,
  NOAH_CURSOR_ACCENT,
  NOAH_CURSOR_GLOW,
  NOAH_CURSOR_SUCCESS,
  NOAH_CURSOR_ERROR,
  NOAH_CURSOR_WARN,
});

function resolveTheme(overrides = {}) {
  const theme = { ...DEFAULT_THEME };
  for (const key of Object.keys(DEFAULT_THEME)) {
    if (typeof overrides[key] === "string" && overrides[key].length < 64) theme[key] = overrides[key];
  }
  return theme;
}

/** CSS custom-property map, e.g. { "--noah-cursor-primary": "#7C3AED" }. */
function cssVariables(theme = DEFAULT_THEME) {
  const out = {};
  for (const [k, v] of Object.entries(theme)) out["--" + k.toLowerCase().replace(/_/g, "-")] = v;
  return out;
}

module.exports = {
  NOAH_CURSOR_PRIMARY,
  NOAH_CURSOR_ACCENT,
  NOAH_CURSOR_GLOW,
  NOAH_CURSOR_SUCCESS,
  NOAH_CURSOR_ERROR,
  NOAH_CURSOR_WARN,
  DEFAULT_THEME,
  resolveTheme,
  cssVariables,
};
