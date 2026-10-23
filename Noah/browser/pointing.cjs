// Noah/browser/pointing.cjs - helps a click made by COORDINATES (from a screenshot) land on what the model meant, and tells it what the click actually hit.
//
// A model that points at a button in a picture is often a few pixels off: on the edge of the button, or on the empty padding beside it. Pure functions, no browser:
//   * isInteractiveHit(hit)           is whatever is under the point something a click does anything to (a button, link, field, ...)?
//   * nearestInteractive(...)          the clickable element closest to the point (distance 0 = inside it), and the runner-up
//   * planSnap(...)                    when the point is on NOTHING clickable and exactly one clickable element is very close, the click goes to that element's middle
//                                      (never when it is ambiguous, and never onto something the point is already on)
//   * describeLanding(...)             one plain sentence for the model: what the click hit, and whether it was moved
// The snap only ever moves a click that would have hit nothing; it cannot redirect a click that was already on a control.
"use strict";

const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea", "label", "summary", "option", "details"]);
const INTERACTIVE_ROLES = /^(button|link|checkbox|radio|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|combobox|textbox|searchbox|slider|spinbutton|treeitem|gridcell|listbox)$/i;
const CLICKABLE_ELEMENT_ROLES = /^(button|link|checkbox|radio|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|combobox|textbox|searchbox|slider|spinbutton|treeitem|clickable|text)$/i;
// A snap target is something control-SIZED. A canvas, a whole panel or a page-wide link is not: clicking its middle would not be "the nearest button", and drawing on a canvas
// (a point chosen on purpose) must never be moved.
const MAX_TARGET_W = 420;
const MAX_TARGET_H = 140;

const SNAP_RADIUS = 14; // CSS pixels: about one fingertip of error
const AMBIGUOUS_GAP = 6; // the runner-up must be at least this much farther, or the point is too close to call

function isInteractiveHit(hit) {
  if (!hit) return false;
  if (INTERACTIVE_TAGS.has(String(hit.tag || "").toLowerCase())) return true;
  if (hit.role && INTERACTIVE_ROLES.test(String(hit.role))) return true;
  return !!hit.href;
}

/** Distance from a point to a rectangle: 0 when inside. */
function distanceToRect(x, y, r) {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.width));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

function usable(el) {
  if (!el || !el.interactive || !el.rect) return false;
  const r = el.rect;
  if (!(r.width >= 3 && r.height >= 3)) return false;
  if (el.role && !CLICKABLE_ELEMENT_ROLES.test(String(el.role))) return false;
  if (el.states && (el.states.disabled || el.states.hidden)) return false;
  return true;
}

/** @returns {{ best: object|null, distance: number, second: object|null, secondDistance: number }} */
function nearestInteractive(elements, x, y) {
  const scored = [];
  for (const el of elements || []) if (usable(el) && el.rect.width <= MAX_TARGET_W && el.rect.height <= MAX_TARGET_H) scored.push({ el, d: distanceToRect(x, y, el.rect) });
  scored.sort((a, b) => a.d - b.d || (a.el.rect.width * a.el.rect.height) - (b.el.rect.width * b.el.rect.height));
  return {
    best: scored[0] ? scored[0].el : null, distance: scored[0] ? scored[0].d : Infinity,
    second: scored[1] ? scored[1].el : null, secondDistance: scored[1] ? scored[1].d : Infinity,
  };
}

/**
 * Should a click at (x, y) - CSS px of the viewport - be moved? Returns null (leave it) or { x, y, el, distance }.
 * @param {object|null} hit       what is under the point (observer.describePoint)
 * @param {object[]} elements     the elements of the last observation, with rect in viewport CSS px
 * @param {{x:number,y:number}} viewport  the viewport size, so the new point stays inside it
 */
function planSnap(hit, elements, x, y, viewport, { radius = SNAP_RADIUS } = {}) {
  if (isInteractiveHit(hit)) return null; // already on a control
  const n = nearestInteractive(elements, x, y);
  if (!n.best || n.distance === 0 || n.distance > radius) return null; // inside one is "the page says it is not a control"; too far is not a near miss
  if (n.second && n.secondDistance - n.distance < AMBIGUOUS_GAP) return null; // two candidates about equally close: do not guess
  const r = n.best.rect;
  const cx = Math.min(Math.max(r.x + r.width / 2, 0), Math.max(0, (viewport && viewport.width) || 1e9) - 1);
  const cy = Math.min(Math.max(r.y + r.height / 2, 0), Math.max(0, (viewport && viewport.height) || 1e9) - 1);
  return { x: cx, y: cy, el: n.best, distance: n.distance };
}

function nameOf(el) {
  return String((el && (el.name || el.text)) || "").replace(/\s+/g, " ").trim().slice(0, 50);
}

/** One sentence about where the click went. `hit` is what was under the FINAL point; `snap` the move made, if any; `near` what is closest when it hit nothing. */
function describeLanding({ x, y, hit, snap, near }) {
  const at = `(${Math.round(x)},${Math.round(y)})`;
  if (snap) return `The point you gave was on nothing clickable, so Noah moved it ${Math.round(snap.distance)} px onto ${snap.el.role || "the control"} "${nameOf(snap.el)}" and clicked there ${at}.`;
  if (isInteractiveHit(hit)) {
    const label = nameOf(hit) || hit.tag;
    return `The click at ${at} landed on ${hit.role || hit.tag || "a control"}${label && label !== hit.tag ? ` "${label}"` : ""}.`;
  }
  if (hit) {
    let s = `The click at ${at} landed on a <${hit.tag || "page element"}> that is not a control`;
    if (near && near.best && near.distance <= 60) s += `; the nearest clickable thing is ${near.best.role || "a control"} "${nameOf(near.best)}", about ${Math.round(near.distance)} px away`;
    return s + ". If that is not what you meant, look at the screenshot again and point more carefully (or use the element's ref or its text).";
  }
  return `The click at ${at} could not be checked.`;
}

/**
 * The whole step, for a point in CSS px of the viewport: look at what is there, move it onto the clearly-closest control if it hit nothing, describe the result.
 * @param {{ describePoint: Function, last?: { elements?: object[] } }} observer
 * @param {{ allowSnap?: boolean }} [opts]  snapping is only for plain clicks: never for a hover, a move or a drag, where the point was chosen on purpose
 * @returns {Promise<{ vx:number, vy:number, info:object|null, snapped:object|null, landing:string }>}
 */
async function landPoint(observer, vp, viewport, { allowSnap = true } = {}) {
  let info = await observer.describePoint(vp.x, vp.y).catch(() => null);
  const elements = observer.last && observer.last.elements;
  let vx = vp.x, vy = vp.y, snapped = null;
  const plan = allowSnap ? planSnap(info, elements, vp.x, vp.y, viewport) : null;
  if (plan) {
    const moved = await observer.describePoint(plan.x, plan.y).catch(() => null);
    if (moved && isInteractiveHit(moved)) { vx = plan.x; vy = plan.y; info = moved; snapped = { from: { x: vp.x, y: vp.y }, to: { x: vx, y: vy }, distance: plan.distance, name: plan.el.name, role: plan.el.role, el: plan.el }; }
  }
  const near = snapped ? null : nearestInteractive(elements, vx, vy);
  return { vx, vy, info, snapped, landing: describeLanding({ x: vx, y: vy, hit: info, snap: snapped, near }) };
}

module.exports = { landPoint, isInteractiveHit, distanceToRect, nearestInteractive, planSnap, describeLanding, SNAP_RADIUS, AMBIGUOUS_GAP };
