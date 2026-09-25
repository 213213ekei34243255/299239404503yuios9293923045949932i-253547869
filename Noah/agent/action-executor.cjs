// Noah/agent/action-executor.cjs
//
// Executes ONE validated protocol action end-to-end:
//
//   resolve target -> safety gate -> verifier.before -> perform -> settle
//     -> verifier.after -> (deterministic method ladder if a click did nothing)
//     -> ActionResult { ok, code?, message, method, verification, diagnostics }
//
// The method ladder (cheap, model-free recovery) for a ref-targeted click that
// produced NO observable effect:
//     pointer click  ->  element.click() via CDP  ->  keyboard activate
// It never re-fires anything that could double-trigger: toggles, consequential
// (risk >= medium) actions and coordinate clicks are handed back to the model
// (which can re-ground visually) instead of being retried blindly.

"use strict";

const { ACTIONS } = require("../protocol/actions.cjs");
const { StoppedError } = require("../computer/input.cjs");
const ax = require("../perception/ax.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOGGLE_ROLES = /^(checkbox|radio|switch|tab|menuitemcheckbox|menuitemradio|ToggleButton|DisclosureTriangle|PopUpButton|combobox)$/;

const METHOD_LABEL = {
  ax: "AX-ref pointer click (DOM target → real mouse)",
  vision: "Visual coordinate click",
  dom: "DOM click (element.click via CDP)",
  keyboard: "Keyboard activation",
  browser: "Browser API",
  cdp: "CDP input",
};

class ActionExecutor {
  /**
   * @param {object} deps
   * @param {import('../browser/browser-controller.cjs').BrowserController} deps.browser
   * @param {import('../computer/controller.cjs').ComputerController} deps.computer
   * @param {import('../safety/safety-controller.cjs').SafetyController} deps.safety
   * @param {import('./verifier.cjs').ActionVerifier} deps.verifier
   * @param {import('../events.cjs').EventBus} deps.bus
   */
  constructor({ browser, computer, safety, verifier, bus, getConfig, log = () => {} }) {
    this.browser = browser;
    this.computer = computer;
    this.safety = safety;
    this.verifier = verifier;
    this.bus = bus;
    this.getConfig = getConfig || (() => ({}));
    this.log = log;
    this.wantVisual = false; // set by `screenshot` actions; consumed by the agent
    this.pendingImage = null; // zoom image to attach to the next observation
    this.goalLine = "";
  }

  setGoalLine(text) {
    this.goalLine = text || "";
  }

  // ------------------------------------------------------------------ helpers

  async _pageCtx() {
    try {
      const ctx = await this.browser.current();
      const o = ctx.observer.last;
      const url = o?.url || ctx.cdp.wc.getURL();
      let origin = "";
      try {
        origin = new URL(url).origin;
      } catch (_) {
        /* ignore */
      }
      return { url, origin, hasPassword: !!o?.hints?.hasPassword, hasPayment: !!o?.hints?.hasPayment };
    } catch (_) {
      return {};
    }
  }

  _fail(action, code, message, extra = {}) {
    return { ok: false, action: action.action, code, message, ...extra };
  }

  _diag(action, r) {
    const t = action.target || action.from;
    const obs = r.resolved
      ? r.resolved.element?.role
        ? `${r.resolved.element.role} "${(r.resolved.element.name || r.resolved.element.text || "").slice(0, 60)}"${r.resolved.rect ? ` at (${Math.round(r.resolved.rect.x + r.resolved.rect.width / 2)}, ${Math.round(r.resolved.rect.y + r.resolved.rect.height / 2)})` : ""}`
        : `point (${Math.round(r.resolved.vx)}, ${Math.round(r.resolved.vy)})${r.resolved.element?.text ? ` on "${r.resolved.element.text.slice(0, 50)}"` : ""}`
      : t
      ? `target ${t.type}`
      : "—";
    return {
      Goal: this.goalLine || action.reason || "",
      Observation: obs,
      Method: METHOD_LABEL[r.method] || r.method || "",
      Action: `${action.action}${action.text ? ` (${action.text.length} chars)` : ""}${action.url ? ` ${action.url}` : ""}`,
      "DOM target": r.resolved?.ref ? `${r.resolved.ref}` : "none (coordinate)",
      Result: r.ok ? r.message || "ok" : `FAILED: ${r.message}`,
      Verification: r.verification ? r.verification.summary : "n/a",
    };
  }

  _emitResult(action, result) {
    const diagnostics = this._diag(action, result);
    this.bus.publish("action_result", {
      action: action.action,
      ok: result.ok,
      code: result.code,
      message: result.message,
      method: result.method,
      verdict: result.verification?.verdict,
      signals: result.verification?.signals,
      durationMs: result.durationMs,
      diagnostics,
    });
  }

  _label(resolved) {
    const el = resolved?.element || {};
    return el.name || el.text || "";
  }

  // ----------------------------------------------------------------- execute

  /**
   * @returns {Promise<object>} ActionResult
   */
  async execute(action) {
    const t0 = Date.now();
    let result;
    try {
      this.safety.guard();
      const handler = this[`_do_${action.action}`];
      if (!handler) result = this._fail(action, "unsupported", `Action "${action.action}" is not implemented`);
      else result = await handler.call(this, action);
    } catch (err) {
      if (err instanceof StoppedError || err.code === "STOPPED") throw err;
      result = this._fail(action, err.code || "error", err.message || String(err));
    }
    result.durationMs = Date.now() - t0;
    result.action = action.action;
    this._emitResult(action, result);
    return result;
  }

  // ------------------------------------------------------------ safety helper

  /** Runs the gate; returns null when allowed, or an ActionResult failure. */
  async _gate(action, { resolved, method, focusInSecret, tabOwned } = {}) {
    const page = await this._pageCtx();
    const verdict = await this.safety.checkAction(action, {
      element: resolved?.element,
      page,
      focusInSecret,
      tabOwned,
      method,
    });
    if (verdict.allowed) return null;
    return this._fail(action, verdict.code || "blocked", verdict.reason || "Blocked by policy", { blocked: true, risk: verdict.risk, method });
  }

  // ------------------------------------------------------------------ pointer

  async _pointer(action, kind) {
    const resolved = await this.browser.resolveTarget(action.target, { forAction: action.action });
    if (!resolved.ok) return this._fail(action, resolved.code, resolved.message, { candidates: resolved.candidates, resolved: null });
    const method = resolved.source === "ax" ? "ax" : "vision";
    const blocked = await this._gate(action, { resolved, method });
    if (blocked) return { ...blocked, resolved };

    const visual = this._visual(action, resolved);
    const before = await this.verifier.before({ visual });
    const tabBefore = this.browser.targetTabId;
    const opts = {
      space: "viewport",
      source: method === "ax" ? "ax" : "vision",
      target: { type: action.target.type, ref: resolved.ref, rect: resolved.rect, label: this._label(resolved), confidence: undefined },
      modifiers: action.modifiers,
      modelX: resolved.modelX,
      modelY: resolved.modelY,
    };
    const fn = { click: "click", double_click: "doubleClick", right_click: "rightClick", hover: "hover", move: "move" }[kind];
    let usedMethod = method;
    if (resolved.pointerBlocked && kind === "click" && resolved.ref) {
      // pointer-events:none: a real mouse click would fall through to whatever is underneath. Show the cursor
      // arriving at the element (hover), then activate it at element level.
      await this.computer.hover(resolved.vx, resolved.vy, opts);
      await this.browser.jsClick(resolved.ref);
      usedMethod = "dom";
    } else {
      await this.computer[fn](resolved.vx, resolved.vy, opts);
    }
    const spec = ACTIONS[action.action];
    if (spec.mutates) await this.browser.waitForSettle({ timeoutMs: 1600 });
    else await sleep(60);
    let verification = await this.verifier.after(action, before, { visual });

    // ---- deterministic ladder for a ref-targeted click that had no effect
    if (verification.verdict === "no_effect" && action.action === "click" && resolved.ref && !action.expect?.no_effect_ok) {
      const rec = this.browser.currentSync()?.refs.get(resolved.ref);
      const risky = this._mediumOrWorse(action, resolved);
      const toggle = TOGGLE_ROLES.test(rec?.role || "");
      if (!risky && !toggle) {
        this.bus.publish("recovery", { failure: "click_no_effect", strategy: "dom_click", ref: resolved.ref });
        await this.browser.jsClick(resolved.ref).catch((e) => this.log("jsClick failed:", e.message));
        await this.browser.waitForSettle({ timeoutMs: 1200 });
        verification = await this.verifier.after(action, before, { visual });
        usedMethod = "dom";
        if (verification.verdict === "no_effect") {
          this.bus.publish("recovery", { failure: "click_no_effect", strategy: "keyboard_activate", ref: resolved.ref });
          await this.browser.keyboardActivate(resolved.ref).catch((e) => this.log("keyboardActivate failed:", e.message));
          await this.browser.waitForSettle({ timeoutMs: 1200 });
          verification = await this.verifier.after(action, before, { visual });
          usedMethod = "keyboard";
        }
        this.bus.publish("recovery", { failure: "click_no_effect", strategy: usedMethod, outcome: verification.verdict === "no_effect" ? "failed" : "recovered" });
      }
    }

    if (verification.changed && spec.mutates) this.browser.invalidateFrame(`page changed after ${action.action}`);
    if (kind === "hover" && verification.changed) this.browser.invalidateFrame("hover changed the page");
    const tabChanged = this.browser.targetTabId !== tabBefore;
    const failed = verification.verdict === "no_effect" || verification.verdict === "failed_expectation";
    return {
      ok: !failed,
      code: failed ? verification.verdict : undefined,
      message: failed ? `${action.action} did not have the expected effect: ${verification.notes.join("; ")}` : `${kind.replace("_", "-")} on ${this._label(resolved) || `(${Math.round(resolved.vx)},${Math.round(resolved.vy)})`}`,
      method: usedMethod,
      resolved,
      verification,
      hint: failed && usedMethod !== "vision" ? "If this control is drawn on a canvas or has no accessible name, take a screenshot and click by coordinates." : undefined,
      tabChanged,
    };
  }

  /** Pixel-level verification: on for coordinate (vision) actions and canvas-like pages, where DOM/AX cannot change. */
  _visual(action, resolved) {
    if (this.getConfig().visualVerification) return true;
    if (resolved && resolved.source === "vision") return true;
    const last = this.browser.currentSync()?.observer.last;
    return !!last?.hints?.preferVision;
  }

  _mediumOrWorse(action, resolved) {
    const { classifyRisk, rank } = require("../safety/risk.cjs");
    const r = classifyRisk({ action, element: resolved?.element, page: { url: "" }, tainted: this.safety.tainted, clipboardOwned: this.safety.clipboardOwned });
    return rank(r.level) >= rank("medium") || !!action.intent;
  }

  async _do_click(a) { return this._pointer(a, "click"); }
  async _do_double_click(a) { return this._pointer(a, "double_click"); }
  async _do_right_click(a) { return this._pointer(a, "right_click"); }
  async _do_hover(a) { return this._pointer(a, "hover"); }
  async _do_move(a) { return this._pointer(a, "move"); }

  async _do_mouse_down(a) {
    let resolved = null;
    if (a.target) {
      resolved = await this.browser.resolveTarget(a.target);
      if (!resolved.ok) return this._fail(a, resolved.code, resolved.message);
    }
    const blocked = await this._gate(a, { resolved, method: "vision" });
    if (blocked) return blocked;
    if (resolved) await this.computer.mouseDown(resolved.vx, resolved.vy, { space: "viewport", source: resolved.source, target: { type: a.target.type, ref: resolved.ref, rect: resolved.rect }, button: a.button });
    else await this.computer.mouseDown(undefined, undefined, { space: "viewport", button: a.button });
    return { ok: true, message: "mouse button pressed (release it with mouse_up)", method: "vision", resolved };
  }

  async _do_mouse_up(a) {
    let resolved = null;
    if (a.target) {
      resolved = await this.browser.resolveTarget(a.target);
      if (!resolved.ok) return this._fail(a, resolved.code, resolved.message);
    }
    const before = await this.verifier.before({});
    if (resolved) await this.computer.mouseUp(resolved.vx, resolved.vy, { space: "viewport", source: resolved.source, target: { type: a.target.type, ref: resolved.ref, rect: resolved.rect }, button: a.button });
    else await this.computer.mouseUp(undefined, undefined, { space: "viewport", button: a.button });
    await this.browser.waitForSettle({ timeoutMs: 1200 });
    const verification = await this.verifier.after({ ...a, action: "mouse_up", expect: { no_effect_ok: true, ...(a.expect || {}) } }, before, {});
    if (verification.changed) this.browser.invalidateFrame("page changed after mouse_up");
    return { ok: true, message: "mouse button released", method: "vision", resolved, verification };
  }

  async _do_drag(a) {
    const from = await this.browser.resolveTarget(a.from);
    if (!from.ok) return this._fail(a, from.code, `drag start: ${from.message}`);
    // The end point may legitimately be a coordinate from the same screenshot: resolve it directly.
    const to = await this.browser.resolveTarget(a.to);
    if (!to.ok) return this._fail(a, to.code, `drag end: ${to.message}`);
    const method = from.source === "ax" && to.source === "ax" ? "ax" : "vision";
    const blocked = await this._gate(a, { resolved: from, method });
    if (blocked) return { ...blocked, resolved: from };
    const before = await this.verifier.before({ visual: true });
    await this.computer.drag(from.vx, from.vy, to.vx, to.vy, {
      space: "viewport",
      source: method,
      target: { type: a.from.type, ref: from.ref, rect: from.rect, label: this._label(from) },
      steps: a.steps,
    });
    await this.browser.waitForSettle({ timeoutMs: 1500 });
    const verification = await this.verifier.after({ ...a, action: "drag", expect: { no_effect_ok: false, ...(a.expect || {}) } }, before, { visual: true });
    if (verification.changed) this.browser.invalidateFrame("page changed after drag");
    const failed = !verification.changed && !a.expect?.no_effect_ok;
    return {
      ok: !failed,
      code: failed ? "no_effect" : undefined,
      message: failed ? "the drag produced no observable change. Check the start point is on a draggable element and the drop target accepts it (take a screenshot to re-locate)." : `dragged from (${Math.round(from.vx)},${Math.round(from.vy)}) to (${Math.round(to.vx)},${Math.round(to.vy)})`,
      method,
      resolved: from,
      verification,
    };
  }

  // ------------------------------------------------------------------- scroll

  async _do_scroll(a) {
    const ctx = await this.browser.current({ activate: true });
    const vp = ctx.observer.last?.viewport || (await ctx.cdp.layoutMetrics());
    let anchor = null;
    let resolved = null;
    if (a.target) {
      resolved = await this.browser.resolveTarget(a.target);
      if (!resolved.ok) return this._fail(a, resolved.code, resolved.message);
      anchor = { x: resolved.vx, y: resolved.vy };
    }
    let dx = a.delta_x || 0;
    let dy = a.delta_y || 0;
    if (a.direction) {
      const unit = a.amount === "page" ? 0.85 : a.amount === "half" ? 0.45 : null;
      const vertical = a.direction === "up" || a.direction === "down";
      const base = vertical ? vp.height : vp.width;
      const mag = unit ? Math.round(base * unit) : a.amount === "line" ? 40 : Number(a.amount) || Math.round(base * 0.85);
      if (a.direction === "down") dy += mag;
      if (a.direction === "up") dy -= mag;
      if (a.direction === "right") dx += mag;
      if (a.direction === "left") dx -= mag;
    }
    const blocked = await this._gate(a, { resolved, method: "browser" });
    if (blocked) return blocked;
    const before = await this.verifier.before({ visual: this._visual(a, resolved) });
    const cx = anchor ? anchor.x : Math.round(vp.width / 2);
    const cy = anchor ? anchor.y : Math.round(vp.height / 2);
    await this.computer.scroll(cx, cy, dx, dy, { space: "viewport", source: "coordinate" });
    // smooth scrolling animates for ~100-300ms: wait for the offset to stop moving
    await this.browser.waitForSettle({ timeoutMs: 1400, quietMs: 120 });
    const verification = await this.verifier.after(a, before, { visual: this._visual(a, resolved) });
    this.browser.invalidateFrame("page scrolled");
    const fp = verification.fingerprint || {};
    const info = `scrolled to y=${fp.sy ?? "?"}`;
    return { ok: true, message: verification.verdict === "at_edge" ? `${info} (no further scrolling possible in that direction)` : info, method: "cdp", resolved, verification };
  }

  async _do_scroll_to(a) {
    const resolved = await this.browser.resolveTarget(a.target);
    if (!resolved.ok) return this._fail(a, resolved.code, resolved.message);
    this.bus.publish("cursor_state", { state: "SCROLLING", holdMs: 500 });
    this.browser.invalidateFrame("scrolled to element");
    return { ok: true, message: `scrolled ${resolved.ref || "target"} into view`, method: "browser", resolved };
  }

  // ----------------------------------------------------------------- keyboard

  async _do_type(a) {
    // Noah's own logs show typed text abbreviated as "The Jurassic…[25 chars]". A model that copies that line back would
    // type the marker itself (it did, over and over): refuse it and say what to do instead.
    if (/(?:…|\.\.\.)\[\d+ chars\]/.test(String(a.text || ""))) {
      return this._fail(a, "placeholder_text", "That text is a redacted placeholder from Noah's log (…[N chars]), not real text. Write out the actual text you want typed.");
    }
    let resolved = null;
    let focusRect;
    if (a.target) {
      resolved = await this.browser.resolveTarget(a.target);
      if (!resolved.ok) return this._fail(a, resolved.code, resolved.message, { candidates: resolved.candidates });
    }
    const focusNow = resolved ? null : await this.browser.focusInfo();
    const blocked = await this._gate(a, { resolved, method: resolved ? (resolved.source === "ax" ? "ax" : "vision") : "keyboard", focusInSecret: !!focusNow?.isPassword });
    if (blocked) return { ...blocked, resolved };

    const before = await this.verifier.before({});
    if (resolved) {
      focusRect = resolved.rect;
      await this.computer.click(resolved.vx, resolved.vy, { space: "viewport", source: resolved.source === "ax" ? "ax" : "vision", target: { type: a.target.type, ref: resolved.ref, rect: resolved.rect, label: this._label(resolved) }, modelX: resolved.modelX, modelY: resolved.modelY });
      await sleep(40);
    } else {
      if (focusNow?.none) return this._fail(a, "no_focus", "No field is focused. Click a text field first (or pass a `target`).", { resolved });
      if (focusNow && !focusNow.editable && focusNow.tag !== "iframe") return this._fail(a, "not_editable", `The focused element (<${focusNow.tag}>) is not editable. Click a text field first.`, { resolved });
      focusRect = focusNow?.rect;
    }
    // After clicking, re-check what we actually focused (a click can land on a password field the AX label hid).
    const focusAfter = await this.browser.focusInfo();
    if (focusAfter?.isPassword) {
      const again = await this._gate({ ...a }, { resolved, method: "keyboard", focusInSecret: true });
      if (again) return { ...again, resolved };
    }
    if (a.clear) {
      await this.computer.hotkey("mod+a");
      await this.computer.keyPress("Backspace");
    }
    await this.computer.type(a.text, { mode: a.mode, focusRect: focusAfter?.rect || focusRect });
    if (a.submit) {
      const submitGate = await this._gate({ action: "key_press", key: "Enter", intent: a.intent, reason: a.reason }, { resolved, method: "keyboard", focusInSecret: false });
      if (submitGate) return { ...submitGate, resolved, message: `Text was typed, but pressing Enter was blocked: ${submitGate.message}` };
      await this.computer.keyPress("Enter");
    }
    await this.browser.waitForSettle({ timeoutMs: a.submit ? 2500 : 900 });
    let value = null;
    if (resolved?.ref) value = await this.browser.readValue(resolved.ref).catch(() => null);
    const verification = await this.verifier.after(a, before, { extra: { value } });
    if (verification.changed) this.browser.invalidateFrame("page changed after typing");
    const failed = verification.verdict === "no_effect";
    return {
      ok: !failed,
      code: failed ? "no_effect" : undefined,
      message: failed ? `typing did not appear to change the field: ${verification.notes.join("; ")}` : `typed ${[...a.text].length} characters${a.submit ? " and pressed Enter" : ""}`,
      method: resolved ? (resolved.source === "ax" ? "ax" : "vision") : "keyboard",
      resolved,
      verification,
    };
  }

  async _keyGate(a, key) {
    const focus = await this.browser.focusInfo();
    return this._gate({ ...a, action: "key_press", key }, { method: "keyboard", focusInSecret: !!focus?.isPassword });
  }

  async _do_key_press(a) {
    const blocked = await this._keyGate(a, a.key);
    if (blocked) return blocked;
    const before = await this.verifier.before({});
    const focus = await this.browser.focusInfo();
    await this.computer.keyPress(a.key, { repeat: a.repeat || 1, focusRect: focus?.rect });
    await this.browser.waitForSettle({ timeoutMs: 1200 });
    const verification = await this.verifier.after({ ...a, expect: { no_effect_ok: true, ...(a.expect || {}) } }, before, {});
    if (verification.changed) this.browser.invalidateFrame(`page changed after ${a.key}`);
    return { ok: verification.verdict !== "failed_expectation", code: verification.verdict === "failed_expectation" ? "failed_expectation" : undefined, message: `pressed ${a.key}${a.repeat > 1 ? ` ×${a.repeat}` : ""}`, method: "keyboard", verification };
  }

  async _do_hotkey(a) {
    const { parseCombo } = require("../computer/keymap.cjs");
    const { modifiers, key } = parseCombo(a.combo);
    const lower = String(key || "").toLowerCase();
    const primary = modifiers.includes("Control") || modifiers.includes("Meta");
    // clipboard shortcuts are classified as what they do
    const asAction = primary && lower === "v" ? { ...a, action: "paste" } : a;
    const focus = await this.browser.focusInfo();
    const blocked = await this._gate(asAction, { method: "keyboard", focusInSecret: !!focus?.isPassword });
    if (blocked) return blocked;
    const before = await this.verifier.before({});
    await this.computer.hotkey(a.combo);
    if (primary && lower === "c") this.safety.noteClipboardOwned(true);
    await this.browser.waitForSettle({ timeoutMs: 900 });
    const verification = await this.verifier.after({ ...a, expect: { no_effect_ok: true, ...(a.expect || {}) } }, before, {});
    if (verification.changed) this.browser.invalidateFrame(`page changed after ${a.combo}`);
    return { ok: true, message: `pressed ${a.combo}`, method: "keyboard", verification };
  }

  async _do_key_down(a) {
    const blocked = await this._keyGate(a, a.key);
    if (blocked) return blocked;
    await this.computer.keyDown(a.key);
    return { ok: true, message: `holding ${a.key} (release with key_up)`, method: "keyboard" };
  }

  async _do_key_up(a) {
    await this.computer.keyUp(a.key);
    return { ok: true, message: `released ${a.key}`, method: "keyboard" };
  }

  async _do_select_all() {
    await this.computer.hotkey("mod+a");
    return { ok: true, message: "selected all", method: "keyboard" };
  }

  async _do_copy(a) {
    await this.computer.hotkey("mod+c");
    this.safety.noteClipboardOwned(true);
    return { ok: true, message: "copied the current selection", method: "keyboard" };
  }

  async _do_paste(a) {
    const blocked = await this._gate(a, { method: "keyboard" });
    if (blocked) return blocked;
    const before = await this.verifier.before({});
    await this.computer.hotkey("mod+v");
    await this.browser.waitForSettle({ timeoutMs: 900 });
    const verification = await this.verifier.after({ ...a, expect: { no_effect_ok: true } }, before, {});
    return { ok: true, message: "pasted", method: "keyboard", verification };
  }

  async _do_form_input(a) {
    const resolved = await this.browser.resolveTarget(a.target);
    if (!resolved.ok) return this._fail(a, resolved.code, resolved.message, { candidates: resolved.candidates });
    if (!resolved.ref) return this._fail(a, "needs_ref", "form_input needs an element ref or text target (not a coordinate)");
    const blocked = await this._gate({ ...a, text: typeof a.value === "string" ? a.value : undefined }, { resolved, method: "browser" });
    if (blocked) return { ...blocked, resolved };
    const before = await this.verifier.before({});
    // show the pointer at the control (semantic actions still have a visible representation)
    await this.computer.hover(resolved.vx, resolved.vy, { space: "viewport", source: "ax", target: { type: "ref", ref: resolved.ref, rect: resolved.rect, label: this._label(resolved) } });
    const res = await this.browser.formInput(resolved.ref, a.value);
    if (!res?.ok) {
      // A <select>'s own options are read live from the DOM here (this.options), unaffected by whether the
      // accessibility tree exposes them - a CLOSED native <select>'s options are marked accessibility-ignored by
      // Chromium and never appear in Noah's normal perception at all. Surface the real list in the message text (the
      // one channel every caller already reads) instead of only in a `data.options` field nothing downstream looks at,
      // so a caller that guessed wrong can pick a real option next time instead of giving up blind.
      const withOptions = Array.isArray(res?.options) && res.options.length ? `${res.error} - real options: ${res.options.join(", ")}` : res?.error;
      return this._fail(a, "form_input_failed", withOptions || "could not set the value", { resolved, data: res });
    }
    await this.browser.waitForSettle({ timeoutMs: 900 });
    const value = await this.browser.readValue(resolved.ref).catch(() => null);
    const verification = await this.verifier.after({ ...a, text: undefined }, before, { extra: { value } });
    if (verification.changed) this.browser.invalidateFrame("page changed after form_input");
    const failed = verification.verdict === "no_effect" || verification.verdict === "failed_expectation";
    return { ok: !failed, code: failed ? verification.verdict : undefined, message: failed ? verification.notes.join("; ") : `set ${resolved.ref} to ${JSON.stringify(res.text || res.value || res.checked)}`, method: "browser", resolved, verification, data: res };
  }

  // -------------------------------------------------------------- navigation

  async _do_navigate(a) {
    const blocked = await this._gate(a, { method: "browser" });
    if (blocked) return blocked;
    const before = await this.verifier.before({});
    const nav = await this.browser.navigate(a.url); // throws BrowserError on net error / redirect_blocked
    await this.browser.waitForSettle({ timeoutMs: 2500 });
    const verification = await this.verifier.after(a, before, {});
    return { ok: verification.verdict !== "failed_expectation", code: verification.verdict === "failed_expectation" ? "failed_expectation" : undefined, message: `opened ${nav.url}${nav.timedOut ? " (still loading after timeout)" : ""}`, method: "browser", verification, data: nav };
  }

  async _navHistory(a, kind) {
    const before = await this.verifier.before({});
    const nav = await this.browser.navigate(kind);
    await this.browser.waitForSettle({ timeoutMs: 2500 });
    const verification = await this.verifier.after({ ...a, action: kind === "reload" ? "reload" : a.action }, before, {});
    return { ok: verification.verdict !== "failed_expectation" && verification.verdict !== "no_effect", code: verification.verdict === "no_effect" ? "no_effect" : undefined, message: `${kind}: ${nav.url}`, method: "browser", verification, data: nav };
  }

  async _do_back(a) { return this._navHistory(a, "back"); }
  async _do_forward(a) { return this._navHistory(a, "forward"); }
  async _do_reload(a) { return this._navHistory(a, "reload"); }

  async _do_new_tab(a) {
    const blocked = await this._gate(a, { method: "browser" });
    if (blocked) return blocked;
    const tab = await this.browser.newTab(a.url); // the tab is created already loading a.url
    if (a.url) await this.browser.waitForLoad(15000);
    return { ok: true, message: `opened tab ${tab.id}${a.url ? ` at ${a.url}` : ""}`, method: "browser", data: { tabId: tab.id } };
  }

  async _do_switch_tab(a) {
    const tabs = await this.browser.tabs.list(0);
    let target = null;
    if (a.tab_id) target = tabs.find((t) => t.id === a.tab_id);
    else if (a.index !== undefined) target = tabs.find((t) => t.index === a.index);
    else {
      const found = this.browser.tabs.find(a.query);
      if (!found.length) {
        const closed = this.browser.tabs.findClosed(a.query);
        return this._fail(a, "tab_not_found", `No open tab matches "${a.query}".${closed.length ? ` A tab you closed recently matches: "${closed[0].title}" (${closed[0].url}). Use new_tab with that URL to reopen it.` : ""}`, { candidates: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })) });
      }
      if (found.length > 1 && found[1].score >= found[0].score) {
        return this._fail(a, "ambiguous_tab", `Several tabs match "${a.query}": ${found.slice(0, 4).map((f) => `${f.tab.id} "${f.tab.title}"`).join("; ")}. Use switch_tab with tab_id.`, { candidates: found.slice(0, 4).map((f) => ({ id: f.tab.id, title: f.tab.title, url: f.tab.url })) });
      }
      target = found[0].tab;
    }
    if (!target) return this._fail(a, "tab_not_found", `No such tab: ${a.tab_id ?? a.index}`);
    const blocked = await this._gate(a, { method: "browser" });
    if (blocked) return blocked;
    await this.browser.setTarget(target.id);
    await this.browser.tabs.switchTo(target.id);
    await this.browser.waitForSettle({ timeoutMs: 1200 });
    return { ok: true, message: `switched to tab ${target.id} "${target.title}"`, method: "browser", data: { tabId: target.id, url: target.url, title: target.title } };
  }

  async _do_close_tab(a) {
    const tabs = await this.browser.tabs.list(0);
    const id = a.tab_id || this.browser.targetTabId;
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return this._fail(a, "tab_not_found", `No such tab: ${id}`);
    const blocked = await this._gate(a, { method: "browser", tabOwned: !!tab.ownedByNoah, resolved: { element: { text: tab.title } } });
    if (blocked) return blocked;
    const wasTarget = id === this.browser.targetTabId;
    await this.browser.tabs.close(id);
    if (wasTarget) {
      const remaining = await this.browser.tabs.list(0);
      const next = remaining.find((t) => t.active) || remaining[0];
      if (next) await this.browser.setTarget(next.id);
    }
    return { ok: true, message: `closed tab ${id}`, method: "browser" };
  }

  // ------------------------------------------------------------------ control

  async _do_wait(a) {
    this.bus.publish("cursor_state", { state: "WAITING", holdMs: 0 });
    const ctx = await this.browser.current();
    const timeout = a.timeout_ms || 10000;
    const t0 = Date.now();
    if (a.until) {
      const u = a.until;
      for (;;) {
        this.safety.guard();
        const fp = await ctx.observer.fingerprint();
        let ok = true;
        if (u.url_contains) ok = ok && String(fp.url || "").toLowerCase().includes(u.url_contains.toLowerCase());
        if (u.text || u.gone_text) {
          const text = await ctx.cdp.evaluate(`(document.body ? document.body.innerText : "").toLowerCase()`).catch(() => "");
          if (u.text) ok = ok && text.includes(u.text.toLowerCase());
          if (u.gone_text) ok = ok && !text.includes(u.gone_text.toLowerCase());
        }
        if (u.element) ok = ok && (await this.browser.findElements(u.element, { limit: 1 }).catch(() => [])).length > 0;
        if (ok) return { ok: true, message: `condition met after ${Date.now() - t0}ms`, method: "browser" };
        if (Date.now() - t0 >= timeout) return this._fail(a, "wait_timeout", `condition not met within ${timeout}ms`);
        await sleep(150);
      }
    }
    const end = Date.now() + a.ms;
    while (Date.now() < end) {
      this.safety.guard();
      await sleep(Math.min(100, end - Date.now()));
    }
    this.bus.publish("cursor_state", { state: "THINKING", holdMs: 0 });
    return { ok: true, message: `waited ${a.ms}ms`, method: "browser" };
  }

  async _do_screenshot(a) {
    if (a.region) {
      const g = this.browser.frame?.geometry;
      if (!g) {
        this.wantVisual = true;
        return { ok: true, message: "no screenshot exists yet; a full screenshot will be attached to the next observation", method: "cdp" };
      }
      const region = g.regionModelToViewport(a.region);
      const ctx = await this.browser.current();
      const img = await ctx.observer.zoom(region);
      this.pendingImage = img;
      return { ok: true, message: `zoomed into region [${a.region.join(", ")}] (coordinates stay in full-screenshot space)`, method: "cdp" };
    }
    this.wantVisual = true;
    return { ok: true, message: "a fresh screenshot will be attached to the next observation", method: "cdp" };
  }

  async _do_read_page(a) {
    const ctx = await this.browser.current();
    const obs = await ctx.observer.observe({ deep: a.filter === "all" });
    this.browser.frame && !obs.screenshot; // no-op: text reads never replace the model's frame
    let text;
    if (a.filter === "text") {
      text = obs.pageText.content.slice(0, 12000);
    } else if (a.filter === "all") {
      let els = obs.elements;
      if (a.ref) {
        const rec = ctx.refs.get(a.ref);
        if (rec) els = els.filter((e) => e.ctx === rec.ctx || e.ref === a.ref);
      }
      text = ax.formatTree(els, { maxLines: 400 });
    } else {
      const sel = ax.selectForModel(obs.elements, { viewport: obs.viewport, tokenBudget: 4000, maxInView: 150, maxOffscreen: 30 });
      text = sel.lines.join("\n");
    }
    return { ok: true, message: `read page (${a.filter})`, method: "browser", data: { kind: a.filter, text, url: obs.url, untrusted: true } };
  }

  async _do_find_element(a) {
    const found = await this.browser.findElements(a.query, { limit: a.limit || 8 });
    const lines = found.map((e) => `${ax.formatElement(e)}  [match ${e.score}]`);
    return { ok: true, message: found.length ? `found ${found.length} match(es)` : `no element matches "${a.query}"`, method: "browser", data: { kind: "find", text: lines.join("\n") || "(none)", untrusted: true } };
  }

  async _do_upload_file(a) {
    const resolved = await this.browser.resolveTarget(a.target);
    if (!resolved.ok) return this._fail(a, resolved.code, resolved.message);
    this.browser.validateUploadPath(a.path); // fail fast before asking the human
    const blocked = await this._gate(a, { resolved, method: "browser" });
    if (blocked) return { ...blocked, resolved };
    const res = await this.browser.uploadFile(resolved.ref, a.path);
    await this.browser.waitForSettle({ timeoutMs: 1200 });
    return { ok: true, message: `attached ${res.uploaded} (${res.bytes} bytes)`, method: "browser", resolved };
  }

  async _do_download_file(a) {
    let resolved = null;
    if (a.target) {
      resolved = await this.browser.resolveTarget(a.target);
      if (!resolved.ok) return this._fail(a, resolved.code, resolved.message);
    }
    const blocked = await this._gate(a, { resolved, method: "browser" });
    if (blocked) return blocked;
    const since = Date.now();
    if (a.url) {
      const ctx = await this.browser.current();
      ctx.cdp.wc.downloadURL(a.url);
    } else {
      await this.computer.click(resolved.vx, resolved.vy, { space: "viewport", source: resolved.source === "ax" ? "ax" : "vision", target: { type: a.target.type, ref: resolved.ref, rect: resolved.rect, label: this._label(resolved) } });
    }
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      const d = this.browser.recentDownloads(since);
      if (d.length && ["completed", "cancelled", "interrupted", "blocked"].includes(d[d.length - 1].state)) {
        const last = d[d.length - 1];
        return last.state === "completed"
          ? { ok: true, message: `downloaded ${last.name} to ${last.path}`, method: "browser", resolved, data: last }
          : this._fail(a, "download_failed", `download ${last.state}: ${last.name}`);
      }
    }
    const d = this.browser.recentDownloads(since);
    return d.length ? { ok: true, message: `download in progress: ${d[d.length - 1].name}`, method: "browser", resolved } : this._fail(a, "no_download", "no download started");
  }

  async _do_handle_dialog(a) {
    const r = await this.browser.handleDialog(a.accept, a.text);
    return { ok: true, message: `${r.accepted ? "accepted" : "dismissed"} the ${r.type} dialog`, method: "browser" };
  }

  async _do_ask_user(a) {
    return { ok: true, message: a.question, method: "browser", paused: true };
  }
}

module.exports = { ActionExecutor, METHOD_LABEL };
