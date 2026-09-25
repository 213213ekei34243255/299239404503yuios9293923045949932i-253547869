// Noah/agent/verifier.cjs
//
// ActionVerifier: "every action has an observable result" (spec §9). Before an
// action it snapshots cheap page state; after it, it diffs and reports which
// signals changed, and whether the action's expectation was met.
//
// It uses NO model. Signals: URL/title change, visible-text hash, DOM size,
// scroll position, focus/value, dialogs, tab inventory, downloads, and (when
// visual verification is requested) a perceptual screenshot hash. The model
// judges *semantic* success on the next observation; this layer answers the
// mechanical question "did anything actually happen?" so blind action chains
// and silent no-ops are caught immediately.

"use strict";

const { diffGray } = require("../perception/screenshot.cjs");

// 96x54 luma cells that must change to count as a real visual change (a thin selection outline moves ~40).
const VISUAL_CHANGE_CELLS = 5;

const NAV_ACTIONS = new Set(["navigate", "back", "forward", "reload", "new_tab", "switch_tab", "close_tab"]);
const CLICK_ACTIONS = new Set(["click", "double_click", "right_click", "mouse_up"]);

class ActionVerifier {
  constructor({ browser }) {
    this.browser = browser;
  }

  /** Cheap pre-action state. `visual` also records a screenshot hash. */
  async before({ visual = false } = {}) {
    const ctx = await this.browser.current();
    const fp = await ctx.observer.fingerprint();
    let shot = null;
    if (visual && !ctx.cdp.dialog) shot = await this._hash(ctx);
    return { fp, shot, downloads: this.browser.downloads.length, at: Date.now() };
  }

  async _hash(ctx) {
    try {
      const { captureFrame } = require("../perception/screenshot.cjs");
      const f = await captureFrame(ctx.cdp, { maxLongEdge: 480, format: "jpeg", quality: 40 });
      return f.gray;
    } catch (_) {
      return null;
    }
  }

  /**
   * @param {object} action
   * @param {object} before  result of before()
   * @param {object} [opts]
   * @param {boolean} [opts.visual]
   * @param {object} [opts.extra]  { value: {…readValue…}, typed: string, tabChanged: bool }
   */
  async after(action, before, { visual = false, extra = {} } = {}) {
    let ctx;
    try {
      ctx = await this.browser.current();
    } catch (err) {
      return { changed: true, signals: ["tab_context_changed"], verdict: "ok", notes: [`context unavailable after action (${err.code || err.message})`], expectationMet: null };
    }
    const fp = await ctx.observer.fingerprint();
    const b = before.fp || {};
    const signals = [];
    const notes = [];

    if (fp.url !== b.url) signals.push("url_changed");
    if (fp.title !== b.title) signals.push("title_changed");
    if (fp.textHash !== b.textHash) signals.push("text_changed");
    if (Math.abs((fp.nodes || 0) - (b.nodes || 0)) >= 1) signals.push("dom_changed");
    if (fp.sy !== b.sy || fp.sx !== b.sx) signals.push("scroll_changed");
    if (fp.active !== b.active) signals.push("focus_or_value_changed");
    if (fp.dialog && !b.dialog) signals.push("dialog_opened");
    if (fp.tabCount !== undefined && b.tabCount !== undefined && fp.tabCount !== b.tabCount) signals.push("tab_count_changed");
    if (this.browser.downloads.length > (before.downloads || 0)) signals.push("download_started");
    if (extra.tabChanged) signals.push("active_tab_changed");
    if (fp.sel !== b.sel) signals.push("selection_changed");
    if ((fp.frames || "") !== (b.frames || "")) signals.push("frame_changed");

    let visualDistance = null;
    if (visual && before.shot && !ctx.cdp.dialog) {
      const h = await this._hash(ctx);
      if (h) {
        visualDistance = diffGray(before.shot, h).changed;
        if (visualDistance >= VISUAL_CHANGE_CELLS) signals.push("visual_changed");
      }
    }

    const changed = signals.length > 0;
    const name = action.action;
    let verdict = "ok";

    if (NAV_ACTIONS.has(name)) {
      const navSignals = ["url_changed", "title_changed", "text_changed", "tab_count_changed", "active_tab_changed"];
      if (!signals.some((s) => navSignals.includes(s)) && name !== "reload") {
        verdict = "no_effect";
        notes.push("navigation produced no visible change (same page/tab)");
      }
    } else if (CLICK_ACTIONS.has(name)) {
      if (!changed && !action.expect?.no_effect_ok) {
        verdict = "no_effect";
        notes.push("the click produced no observable change (URL, text, DOM, focus, dialogs, tabs and downloads are all unchanged)");
      }
    } else if (name === "type" || name === "form_input") {
      if (extra.value) {
        const want = String(action.text ?? action.value ?? "");
        const v = extra.value;
        const got = v.value !== undefined ? String(v.value) : v.checked !== undefined ? String(v.checked) : v.text || "";
        // A <select> reports both its value ("es") and the visible label ("Spain"); either satisfies the request.
        const gotAlt = v.type === "select" ? String(v.text || "") : "";
        if (v.type === "password") {
          if (!(v.valueLength > 0)) {
            verdict = "no_effect";
            notes.push("the field is still empty");
          }
        } else if (name === "type" && !(action.clear === false) && want && !got.includes(want.slice(0, Math.min(want.length, 40)))) {
          // Editors that reformat input (masks, autocomplete) can legitimately differ; report, don't fail hard if something changed.
          verdict = changed ? "ok" : "no_effect";
          notes.push(`field now contains "${got.slice(0, 60)}" (expected to contain "${want.slice(0, 40)}")`);
        } else if (name === "form_input" && want && v.checked === undefined) {
          const w = want.toLowerCase();
          const matches = [got, gotAlt].some((g) => g && (g.toLowerCase() === w || g.toLowerCase().includes(w)));
          if (!matches) {
            verdict = "no_effect";
            notes.push(`value is "${got.slice(0, 60)}"${gotAlt ? ` ("${gotAlt.slice(0, 60)}")` : ""}, expected "${want.slice(0, 60)}"`);
          }
        }
      } else if (name === "type" && !changed) {
        verdict = "no_effect";
        notes.push("typing changed nothing observable (no focused editable field?)");
      }
    } else if (name === "scroll" || name === "scroll_to") {
      if (!signals.includes("scroll_changed") && !signals.includes("visual_changed")) {
        verdict = "at_edge";
        notes.push("the page did not scroll (already at the end, or the pointer was over a non-scrollable area)");
      }
    }

    // ---- explicit expectations from the model (deterministic post-conditions)
    let expectationMet = null;
    if (action.expect) {
      const e = action.expect;
      const failures = [];
      if (e.url_contains && !String(fp.url || "").toLowerCase().includes(e.url_contains.toLowerCase())) failures.push(`URL does not contain "${e.url_contains}"`);
      if (e.url_not_contains && String(fp.url || "").toLowerCase().includes(e.url_not_contains.toLowerCase())) failures.push(`URL still contains "${e.url_not_contains}"`);
      if (e.text_visible || e.text_gone) {
        const text = await ctx.cdp
          .evaluate(`(document.body ? document.body.innerText : "").toLowerCase()`, { timeoutMs: 4000 })
          .catch(() => "");
        if (e.text_visible && !text.includes(e.text_visible.toLowerCase())) failures.push(`text "${e.text_visible}" is not on the page`);
        if (e.text_gone && text.includes(e.text_gone.toLowerCase())) failures.push(`text "${e.text_gone}" is still on the page`);
      }
      if (e.element_visible) {
        const found = await this.browser.findElements(e.element_visible, { limit: 1 }).catch(() => []);
        if (!found.length) failures.push(`no element matching "${e.element_visible}" is visible`);
      }
      expectationMet = failures.length === 0;
      if (!expectationMet) {
        verdict = "failed_expectation";
        notes.push(...failures);
      } else if (verdict === "no_effect" || verdict === "at_edge") {
        verdict = "ok"; // the model's own post-condition holds, so nothing more is needed
      }
    }

    return {
      changed,
      signals,
      verdict,
      expectationMet,
      notes,
      visualDistance,
      url: fp.url,
      title: fp.title,
      fingerprint: fp,
      summary: `${verdict}${signals.length ? ` [${signals.join(", ")}]` : " [no signals]"}${notes.length ? ` — ${notes.join("; ")}` : ""}`,
    };
  }
}

module.exports = { ActionVerifier, VISUAL_CHANGE_CELLS };
