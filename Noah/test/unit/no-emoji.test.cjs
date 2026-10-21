// Noah/test/unit/no-emoji.test.cjs - Jonah's screens use plain text, no emoji (the side dock's icons are drawn pictures, not emoji).
// Typographic symbols stay on purpose: the close cross, check mark, arrows, middle dot, dashes.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..", "..");

// the same rule the clean-up used: emoji presentation, the whole pictograph blocks, text-style emoji people use as icons, regional-indicator flags, and VS16 sequences
const EXTRA = "⚠▶◀⏸⏹⏱✏⬇⬆✖✔☑✈♻⚙✂✉☎⌨✍⚔";
const EMOJI = new RegExp("\\p{Regional_Indicator}|\\p{Emoji_Presentation}|[\\u{1F000}-\\u{1FAFF}]|[" + EXTRA + "]|\\p{Extended_Pictographic}(?=\\uFE0F)|\\uFE0F", "u");

const FILES = [
  "home.html", "search.html", "fifaworld.html", "index.html", "ai-panel.html", "Rexy/ai-panel.html", "chat-render.js", "citation.html", "error.html", "features.js",
  "focus-blocked.html", "google-blocked.html", "hub-ui.js", "hub-core.js", "downloads-ui.js", "downloads-core.js", "downloads/manager.cjs", "downloads/ipc.cjs", "study-ui.js", "study-core.js", "theme-core.js", "theme-host.js", "trust-panel.js", "voice-orb.js",
  "toy-paint.html", "renderer.js", "preload.cjs", "main.cjs", "server2.js", "vpn.cjs", "Rexy/executor.cjs", "Rexy/observer.cjs", "Rexy/runtime.cjs", "style.css", "noah-overlay.css",
  "hubs/feeds.cjs", "hubs/system.cjs", "hubs/images.cjs", "hubs/ipc.cjs",
];

test("no emoji in the screens, panels, menus, pages or their messages", () => {
  const found = [];
  for (const f of FILES) {
    const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split(/\r?\n/);
    lines.forEach((l, i) => { const m = EMOJI.exec(l); if (m) found.push(`${f}:${i + 1} ${JSON.stringify(m[0])} in ${l.trim().slice(0, 90)}`); });
  }
  assert.deepEqual(found, []);
});

test("icon-only buttons got a text label instead of going blank", () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
  assert.match(read("features.js"), /id="notifClearBtn">Clear</);
  assert.match(read("hub-ui.js"), /data-act="weekPrev">Prev</);
  assert.match(read("hub-ui.js"), /data-act="weekNext">Next</);
  assert.match(read("hub-ui.js"), /Watch this game's price">Watch</);
  assert.match(read("toy-paint.html"), /data-tool="pencil">Pencil</);
  assert.match(read("chat-render.js"), /"\[x\] " : "\[ \] "/, "task-list boxes are text");
  assert.doesNotMatch(read("index.html"), /<span class="tools-menu-icon">/, "menu entries are just their names");
});

test("the stock watchlist shows country codes where it showed flags", () => {
  const home = fs.readFileSync(path.join(ROOT, "home.html"), "utf8");
  assert.match(home, /\{s:"AAPL",n:"Apple Inc\.",e:"NASDAQ",f:"US"\}/);
  assert.match(home, /\{s:"TSM",n:"Taiwan Semiconductor",e:"NYSE",f:"TW"\}/);
  assert.match(home, /\{s:"SPY",n:"S&P 500 ETF",e:"NYSEARCA",f:"ETF"\}/);
});
