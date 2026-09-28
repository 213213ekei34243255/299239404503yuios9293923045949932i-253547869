// Noah/models/draw-script.cjs
//
// Actually drawing a scene on Jonah's built-in drawing tool (see draw-goal.cjs for how Noah gets there).
//
// Why this exists, in one sentence: the hosted model's action vocabulary (rexy-legacy.cjs's translateAction) has
// no "drag" at all - it can click a colour and click a tool, but has no way to express "press here, move there,
// let go", which is the one gesture that actually puts a shape on a canvas. Asking it to draw anyway just produces
// clicks with no visible effect (reported live: "clicking all the colours here and there... not doing anything").
// So drawing is scripted, the same way models/compose.cjs scripts writing text instead of asking a small model to
// emit it key by key: a small, fixed table of "object word -> colour, shape, region", walked one part per turn,
// each turn issuing REAL protocol actions (click the colour, click the tool, drag the shape) - the exact same
// click/drag Noah always had, just chosen by this table instead of by the model.
//
// Honest scope: this recognises a short, fixed list of common scene words and draws ONE representative shape per
// word (a filled rectangle or ellipse) in a fixed region and a fixed, conventional colour for that word - it does
// not compose a detailed picture, does not accept an explicit colour override ("a red sun" still draws yellow),
// and does not know any word outside its table. That is a real, working, deterministic drawing of a simple scene,
// not a claim of artistic or general drawing ability.

"use strict";

const { isOnDrawingTool } = require("./draw-goal.cjs");

// layer: draw order, background first, so nearer/foreground shapes correctly sit on top of farther ones,
// REGARDLESS of the order the user happened to mention them in.
const SCENE_PARTS = [
  { key: "sky", match: /\bsk(?:y|ies)\b/i, color: "blue", tool: "Rectangle", region: "top-half", layer: 0 },
  { key: "sea", match: /\b(?:sea|ocean|water)\b/i, color: "blue", tool: "Rectangle", region: "bottom-half", layer: 0 },
  { key: "hills", match: /\b(?:hills?|grass|ground|field|meadow)\b/i, color: "green", tool: "Rectangle", region: "bottom-third", layer: 1 },
  { key: "sun", match: /\bsuns?\b/i, color: "yellow", tool: "Ellipse", region: "top-right-corner", layer: 2 },
  { key: "moon", match: /\bmoons?\b/i, color: "gray", tool: "Ellipse", region: "top-right-corner", layer: 2 },
  { key: "cloud", match: /\bclouds?\b/i, color: "white", tool: "Ellipse", region: "top-left-corner", layer: 2 },
  { key: "star", match: /\bstars?\b/i, color: "yellow", tool: "Ellipse", region: "top-left-small", layer: 2 },
  { key: "tree", match: /\btrees?\b/i, color: "green", tool: "Ellipse", region: "center-left", layer: 2 },
  { key: "house", match: /\bhouses?\b/i, color: "brown", tool: "Rectangle", region: "center-left", layer: 2 },
  { key: "rocket", match: /\brockets?\b/i, color: "gray", tool: "Rectangle", region: "center-tall", layer: 3 },
  { key: "heart", match: /\bhearts?\b/i, color: "rose", tool: "Ellipse", region: "center", layer: 3 },
  { key: "flower", match: /\bflowers?\b/i, color: "pink", tool: "Ellipse", region: "center", layer: 3 },
];

/** Which SCENE_PARTS the goal mentions, background-first (see `layer` above), each at most once. */
function partsFor(goal) {
  const g = String(goal || "");
  const found = [];
  for (const part of SCENE_PARTS) if (part.match.test(g)) found.push(part);
  return found.sort((a, b) => a.layer - b.layer);
}

/** A region name -> a {from:{x,y}, to:{x,y}} drag, in VIEWPORT px, from the canvas's own measured rect. */
function regionRect(canvas, region) {
  const { x, y, width: w, height: h } = canvas;
  const box = (fx0, fy0, fx1, fy1) => ({ from: { x: x + w * fx0, y: y + h * fy0 }, to: { x: x + w * fx1, y: y + h * fy1 } });
  switch (region) {
    case "top-half": return box(0, 0, 1, 0.5);
    case "bottom-half": return box(0, 0.5, 1, 1);
    case "bottom-third": return box(0, 0.66, 1, 1);
    case "top-right-corner": return box(0.72, 0.06, 0.92, 0.26);
    case "top-left-corner": return box(0.08, 0.08, 0.28, 0.28);
    case "top-left-small": return box(0.1, 0.1, 0.17, 0.17);
    case "center-left": return box(0.15, 0.35, 0.32, 0.75);
    case "center-tall": return box(0.46, 0.25, 0.54, 0.75);
    case "center":
    default:
      return box(0.42, 0.4, 0.58, 0.6);
  }
}

/** The page's drawing canvas: the element observer.cjs's _addNamedCanvases promoted (role "canvas", a real rect). */
function findCanvas(els) {
  return (els || []).find((e) => e.role === "canvas" && e.rect && e.rect.width > 0 && e.rect.height > 0) || null;
}

class DrawScript {
  constructor() {
    this._s = new Map(); // taskId -> { done: Set<key>, dead }
  }

  /**
   * @param {object} c { taskId, goal, obs, els, recent:[{text, ok}] }
   * @returns {null | { status, summary, method?, actions?, result? }}  null = not a scene this table can draw / not applicable
   */
  next({ taskId, goal, obs, els, recent }) {
    if (!isOnDrawingTool(obs && obs.url)) return null;
    const parts = partsFor(goal);
    if (!parts.length) return null;

    let st = this._s.get(taskId);
    if (!st) {
      st = { done: new Set(), dead: false };
      this._s.set(taskId, st);
      if (this._s.size > 20) this._s.delete(this._s.keys().next().value);
    }
    if (st.dead) return null;

    // Did the part we just asked for actually land? A drag with no visible effect (canvas not found this turn,
    // an intervening click failed) must not be silently counted as drawn.
    const last = (recent || [])[recent.length - 1];
    const justAttempted = st._attempting;
    st._attempting = null;
    if (justAttempted) {
      if (last && last.ok !== false && /^drag\b/.test(String(last.text || ""))) {
        st.done.add(justAttempted);
      } else {
        st.failures = (st.failures || 0) + 1;
        if (st.failures >= 2) {
          st.dead = true;
          return { status: "give_up", summary: `I could not draw the ${justAttempted} - the last attempt to drag it on the canvas did not seem to work.` };
        }
      }
    }

    const remaining = parts.filter((p) => !st.done.has(p.key));
    if (!remaining.length) {
      st.dead = true;
      const drawn = parts.map((p) => p.key).join(", ");
      return { status: "done", summary: "Finished drawing", result: `Drew the scene (${drawn}) on the canvas.` };
    }

    const canvas = findCanvas(els);
    if (!canvas) {
      st.waits = (st.waits || 0) + 1;
      if (st.waits > 3) {
        st.dead = true;
        return { status: "give_up", summary: "I could not find the drawing canvas on this page." };
      }
      return { status: "continue", summary: "Looking for the drawing canvas", method: "browser", actions: [{ action: "wait", ms: 500 }] };
    }

    const part = remaining[0];
    const { from, to } = regionRect(canvas.rect, part.region);
    st._attempting = part.key;
    return {
      status: "continue",
      summary: `Drawing ${part.key} (${part.color})`,
      method: "ax",
      actions: [
        { action: "click", target: { text: `color ${part.color}` } },
        { action: "click", target: { text: part.tool } },
        { action: "drag", from: { space: "viewport", x: from.x, y: from.y }, to: { space: "viewport", x: to.x, y: to.y }, expect: { no_effect_ok: false } },
      ],
    };
  }
}

module.exports = { DrawScript, SCENE_PARTS, partsFor, regionRect, findCanvas };
