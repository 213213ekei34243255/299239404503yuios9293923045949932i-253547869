"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateAction, validateEnvelope, toolSchema, ACTIONS, MAX_BATCH, redactAction } = require("../../protocol/actions.cjs");
const { resolveKey, parseCombo, modifierMask, editCommandFor } = require("../../computer/keymap.cjs");

test("click accepts ref, coordinate, text, and legacy x/y forms", () => {
  assert.deepEqual(validateAction({ action: "click", target: { ref: "e12" } }).action.target, { type: "ref", ref: "e12" });
  assert.deepEqual(validateAction({ action: "click", target: { type: "coordinate", x: 812, y: 641 } }).action.target, { type: "coordinate", x: 812, y: 641 });
  assert.deepEqual(validateAction({ action: "click", target: { text: "Search" } }).action.target, { type: "text", text: "Search" });
  assert.deepEqual(validateAction({ action: "click", x: 5, y: 6 }).action.target, { type: "coordinate", x: 5, y: 6 });
  assert.deepEqual(validateAction({ action: "click", target: "e7" }).action.target, { type: "ref", ref: "e7" });
});

// {space:"viewport", x, y}: an already-known CSS viewport pixel (models/draw-script.cjs), distinct from the
// ordinary numeric {x,y} form, which is always a SCREENSHOT pixel needing an existing frame to mean anything.
test("a {space:'viewport', x, y} target is its own type, never confused with a plain screenshot coordinate", () => {
  assert.deepEqual(validateAction({ action: "click", target: { space: "viewport", x: 100, y: 50 } }).action.target, { type: "viewport", x: 100, y: 50 });
  assert.deepEqual(validateAction({ action: "click", target: { x: 100, y: 50 } }).action.target, { type: "coordinate", x: 100, y: 50 });
  const d = validateAction({ action: "drag", from: { space: "viewport", x: 1, y: 2 }, to: { space: "viewport", x: 300, y: 400 } });
  assert.equal(d.ok, true);
  assert.deepEqual(d.action.from, { type: "viewport", x: 1, y: 2 });
  // the shared out-of-range guard covers viewport targets too
  assert.equal(validateAction({ action: "click", target: { space: "viewport", x: 999999, y: 1 } }).ok, false);
});

test("click without target is rejected with a helpful message", () => {
  const r = validateAction({ action: "click" });
  assert.equal(r.ok, false);
  assert.match(r.error, /requires a target/);
});

test("aliases normalise (goto, press_key, doubleClick)", () => {
  assert.equal(validateAction({ action: "goto", url: "https://a.com" }).action.action, "navigate");
  assert.equal(validateAction({ action: "press_key", key: "Enter" }).action.action, "key_press");
  assert.equal(validateAction({ action: "doubleClick", x: 1, y: 2 }).action.action, "double_click");
  assert.equal(validateAction({ type: "click", x: 1, y: 2 }).action.action, "click");
});

test("unknown action is rejected and lists valid ones", () => {
  const r = validateAction({ action: "format_disk" });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown action/);
  assert.match(r.error, /click/);
});

test("drag requires from/to; scroll needs direction or deltas", () => {
  assert.equal(validateAction({ action: "drag", from: { x: 1, y: 2 } }).ok, false);
  const d = validateAction({ action: "drag", from: { x: 1, y: 2 }, to: { x: 30, y: 40 }, steps: 500 });
  assert.equal(d.ok, true);
  assert.equal(d.action.steps, 60);
  assert.equal(validateAction({ action: "scroll" }).ok, false);
  const s = validateAction({ action: "scroll", direction: "down", amount: "400" });
  assert.equal(s.action.amount, 400);
  assert.equal(validateAction({ action: "scroll", direction: "sideways" }).ok, false);
});

test("type validates text and caps length", () => {
  assert.equal(validateAction({ action: "type" }).ok, false);
  assert.equal(validateAction({ action: "type", text: "x".repeat(6000) }).ok, false);
  const t = validateAction({ action: "type", text: "hello", target: { ref: "e3" }, submit: true, clear: true });
  assert.equal(t.ok, true);
  assert.equal(t.action.submit, true);
  assert.equal(t.action.clear, true);
});

test("hotkey accepts array or combo", () => {
  assert.equal(validateAction({ action: "hotkey", keys: ["ctrl", "a"] }).action.combo, "ctrl+a");
  assert.equal(validateAction({ action: "hotkey", combo: "ctrl+shift+t" }).action.combo, "ctrl+shift+t");
  assert.equal(validateAction({ action: "hotkey" }).ok, false);
});

test("wait clamps and parses conditions; screenshot region validated", () => {
  assert.equal(validateAction({ action: "wait", ms: 999999 }).action.ms, 30000);
  assert.deepEqual(validateAction({ action: "wait", until: { text: "Done" } }).action.until, { text: "Done" });
  assert.equal(validateAction({ action: "screenshot", region: [1, 2, 3] }).ok, false);
  assert.deepEqual(validateAction({ action: "screenshot", region: [1, 2, 30, 40] }).action.region, [1, 2, 30, 40]);
});

test("expect is sanitised", () => {
  const a = validateAction({ action: "click", target: { ref: "e1" }, expect: { url_contains: "/cart", evil: "x", no_effect_ok: true } }).action;
  assert.deepEqual(a.expect, { url_contains: "/cart", no_effect_ok: true });
});

test("envelope: done, continue with batch limit, ask_user", () => {
  assert.equal(validateEnvelope({ status: "done", summary: "ok", result: "42" }).envelope.result, "42");
  const many = Array.from({ length: 9 }, () => ({ action: "wait", ms: 10 }));
  const e = validateEnvelope({ status: "continue", summary: "x", actions: many });
  assert.equal(e.ok, true);
  assert.equal(e.envelope.actions.length, MAX_BATCH);
  assert.ok(e.envelope.errors.length >= 1);
  assert.equal(validateEnvelope({ status: "continue", summary: "x", actions: [] }).ok, false);
  assert.equal(validateEnvelope({ status: "ask_user", summary: "Which size?" }).ok, true);
  assert.equal(validateEnvelope("nope").ok, false);
  // bare single-action object is tolerated
  assert.equal(validateEnvelope({ action: "click", target: { ref: "e1" } }).ok, true);
});

test("envelope drops invalid actions but keeps valid ones", () => {
  const r = validateEnvelope({ status: "continue", summary: "s", actions: [{ action: "nope" }, { action: "wait", ms: 5 }] });
  assert.equal(r.ok, true);
  assert.equal(r.envelope.actions.length, 1);
  assert.equal(r.envelope.errors.length, 1);
});

test("tool schema is portable (no oneOf/anyOf/additionalProperties) and lists every action", () => {
  const schema = toolSchema();
  const json = JSON.stringify(schema);
  assert.ok(!/oneOf|anyOf|additionalProperties|\$ref/.test(json));
  const enumValues = schema.properties.actions.items.properties.action.enum;
  assert.deepEqual([...enumValues].sort(), Object.keys(ACTIONS).sort());
});

test("redactAction shortens long typed text", () => {
  const a = redactAction({ action: "type", text: "x".repeat(100) });
  assert.ok(a.text.length < 40);
});

// ---- keymap ----------------------------------------------------------------

test("keymap resolves letters, shifted symbols, named keys, aliases", () => {
  assert.deepEqual(resolveKey("a"), { key: "a", code: "KeyA", keyCode: 65, text: "a", shift: false });
  assert.equal(resolveKey("A").shift, true);
  assert.equal(resolveKey("!").code, "Digit1");
  assert.equal(resolveKey("!").shift, true);
  assert.equal(resolveKey("Return").key, "Enter");
  assert.equal(resolveKey("PgDn").key, "PageDown");
  assert.equal(resolveKey("esc").keyCode, 27);
  assert.equal(resolveKey("f5").key, "F5");
  assert.equal(resolveKey("é"), null);
});

test("parseCombo handles modifiers, mod, and the plus key", () => {
  assert.deepEqual(parseCombo("ctrl+shift+t", { platform: "win32" }), { modifiers: ["Control", "Shift"], key: "t" });
  assert.deepEqual(parseCombo("mod+a", { platform: "darwin" }), { modifiers: ["Meta"], key: "a" });
  assert.deepEqual(parseCombo("mod+a", { platform: "win32" }), { modifiers: ["Control"], key: "a" });
  assert.deepEqual(parseCombo("ctrl++", { platform: "win32" }), { modifiers: ["Control"], key: "+" });
  assert.deepEqual(parseCombo("Escape"), { modifiers: [], key: "Escape" });
});

test("modifier mask and edit commands", () => {
  assert.equal(modifierMask(["Control", "Shift"]), 2 | 8);
  assert.equal(modifierMask(["Alt", "Meta"]), 1 | 4);
  assert.equal(editCommandFor("a", ["Control"]), "selectAll");
  assert.equal(editCommandFor("z", ["Meta", "Shift"]), "redo");
  assert.equal(editCommandFor("a", []), null);
});
