// Noah/computer/keymap.cjs
//
// US-layout key definitions for CDP Input.dispatchKeyEvent, plus parsing of
// human/model key names ("ctrl+shift+t", "Return", "PgDn"). Pure data +
// functions, no Electron dependency.

"use strict";

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const NAMED = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, modifier: "Shift" },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17, modifier: "Control" },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18, modifier: "Alt" },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91, modifier: "Meta" },
  CapsLock: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
};
for (let i = 1; i <= 12; i++) NAMED["F" + i] = { key: "F" + i, code: "F" + i, keyCode: 111 + i };

const ALIASES = {
  return: "Enter", enter: "Enter", tab: "Tab", esc: "Escape", escape: "Escape",
  backspace: "Backspace", bksp: "Backspace", delete: "Delete", del: "Delete", insert: "Insert", ins: "Insert",
  space: "Space", spacebar: "Space", " ": "Space",
  left: "ArrowLeft", arrowleft: "ArrowLeft", up: "ArrowUp", arrowup: "ArrowUp",
  right: "ArrowRight", arrowright: "ArrowRight", down: "ArrowDown", arrowdown: "ArrowDown",
  home: "Home", end: "End", pageup: "PageUp", pgup: "PageUp", page_up: "PageUp",
  pagedown: "PageDown", pgdn: "PageDown", pgdown: "PageDown", page_down: "PageDown",
  shift: "Shift", ctrl: "Control", control: "Control", alt: "Alt", option: "Alt", opt: "Alt",
  meta: "Meta", cmd: "Meta", command: "Meta", win: "Meta", windows: "Meta", super: "Meta",
  capslock: "CapsLock",
};

// Printable characters on a US keyboard: char -> { code, keyCode, shift }
const PRINTABLE = {};
(function build() {
  for (let i = 0; i < 26; i++) {
    const lower = String.fromCharCode(97 + i);
    const upper = lower.toUpperCase();
    PRINTABLE[lower] = { code: "Key" + upper, keyCode: 65 + i, shift: false };
    PRINTABLE[upper] = { code: "Key" + upper, keyCode: 65 + i, shift: true };
  }
  const digits = ")!@#$%^&*(";
  for (let i = 0; i <= 9; i++) {
    PRINTABLE[String(i)] = { code: "Digit" + i, keyCode: 48 + i, shift: false };
    PRINTABLE[digits[i]] = { code: "Digit" + i, keyCode: 48 + i, shift: true };
  }
  const pairs = [
    ["`", "~", "Backquote", 192], ["-", "_", "Minus", 189], ["=", "+", "Equal", 187],
    ["[", "{", "BracketLeft", 219], ["]", "}", "BracketRight", 221], ["\\", "|", "Backslash", 220],
    [";", ":", "Semicolon", 186], ["'", '"', "Quote", 222], [",", "<", "Comma", 188],
    [".", ">", "Period", 190], ["/", "?", "Slash", 191],
  ];
  for (const [a, b, code, keyCode] of pairs) {
    PRINTABLE[a] = { code, keyCode, shift: false };
    PRINTABLE[b] = { code, keyCode, shift: true };
  }
  PRINTABLE[" "] = { code: "Space", keyCode: 32, shift: false };
})();

function normalizeName(name) {
  const raw = String(name);
  if (raw.length === 1) return raw;
  const lower = raw.trim().toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  // F-keys, case-insensitive
  const f = /^f(\d{1,2})$/i.exec(raw.trim());
  if (f && +f[1] >= 1 && +f[1] <= 12) return "F" + +f[1];
  // Already canonical?
  const canon = Object.keys(NAMED).find((k) => k.toLowerCase() === lower);
  return canon || raw;
}

/**
 * Resolve a single key name/character into a CDP key descriptor:
 * { key, code, keyCode, text?, shift?, modifier? }
 * Returns null for characters that have no US-layout key (caller should use
 * Input.insertText for those).
 */
function resolveKey(name) {
  const n = normalizeName(name);
  if (NAMED[n]) return { ...NAMED[n] };
  if (n.length === 1 && PRINTABLE[n]) {
    const p = PRINTABLE[n];
    return { key: n, code: p.code, keyCode: p.keyCode, text: n, shift: p.shift };
  }
  return null;
}

/** "ctrl+shift+t" -> { modifiers: ["Control","Shift"], key: "t" } ; "+" alone is the plus key. */
function parseCombo(combo, { platform = process.platform } = {}) {
  const raw = String(combo).trim();
  if (raw === "+" ) return { modifiers: [], key: "+" };
  const parts = raw.split("+").map((p) => p.trim()).filter((p) => p.length);
  if (raw.endsWith("++")) parts.push("+");
  const primary = platform === "darwin" ? "Meta" : "Control";
  const modifiers = [];
  let key = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "mod" || lower === "cmdorctrl" || lower === "commandorcontrol") {
      modifiers.push(primary);
      continue;
    }
    const n = normalizeName(part);
    if (n in MODIFIER_BITS) modifiers.push(n);
    else key = part;
  }
  // "ctrl" alone (all modifiers, no key): treat last modifier as the key.
  if (key === null && modifiers.length) key = modifiers.pop();
  return { modifiers: [...new Set(modifiers)], key };
}

function modifierMask(modifiers) {
  let m = 0;
  for (const mod of modifiers) m |= MODIFIER_BITS[normalizeName(mod)] || 0;
  return m;
}

// Editing commands Blink understands via Input.dispatchKeyEvent `commands`
// (needed on macOS where Cmd+A/C/V do not reach the editor from synthetic events).
const EDIT_COMMANDS = {
  a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo", y: "redo",
};

function editCommandFor(key, modifiers) {
  if (!modifiers.includes("Meta") && !modifiers.includes("Control")) return null;
  if (modifiers.includes("Alt")) return null;
  const k = String(key).toLowerCase();
  if (k === "z" && modifiers.includes("Shift")) return "redo";
  return EDIT_COMMANDS[k] || null;
}

module.exports = {
  MODIFIER_BITS,
  NAMED,
  PRINTABLE,
  normalizeName,
  resolveKey,
  parseCombo,
  modifierMask,
  editCommandFor,
};
