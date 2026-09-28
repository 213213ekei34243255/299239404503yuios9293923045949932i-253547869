// Noah/models/draw-goal.cjs
//
// "Draw a rocket with a blue sky and green hills": recognising a DRAWING request and sending Noah to Jonah's
// built-in drawing tool (toy-paint.html) automatically, instead of the user having to open it themselves.
//
// Safety note (this is the whole reason this file is this small and this literal): the file URL below is a
// FIXED STRING computed once from this file's own on-disk location. It is never built from the user's message,
// the page's content, or anything a model returns - `isDrawTask` only decides WHETHER to go there, it has no
// say in WHERE. Nothing in Jonah ever accepts a file:// URL typed into the address bar, said out loud, or
// returned by a model; this is the one, single, hardcoded exception, and it points at a page Jonah ships with
// itself. See renderer.js's `openDrawingTool()` for the matching, human-facing way to open the same page (the
// existing pattern for goHome() - a fixed bundled page loaded by app code, never through the address bar).

"use strict";

const path = require("path");

// Noah/models -> Noah -> repo root -> toy-paint.html. Computed once, not from any request text.
const DRAWING_TOOL_PATH = path.join(__dirname, "..", "..", "toy-paint.html");
const DRAWING_TOOL_URL = "file://" + DRAWING_TOOL_PATH.replace(/\\/g, "/");

const DRAW_VERB = /\b(draw|paint|sketch|doodle)\b/i;
// Idioms that use the same verb but mean something other than "put a picture on the canvas" - never trigger for these.
const NOT_A_PICTURE = /\bdraw(?:ing)?\s+(?:up|(?:(?:my|your|his|her|their|our|its)\s+)?attention|a\s+conclusion|conclusions?|blank|straws|the\s+line|board|near|to\s+a\s+close)\b|\bwithdraw|\bdrawer\b|\bpaint(?:ing)?\s+(?:the\s+town|yourself\s+into)\b/i;

/** Is this goal asking Noah to draw/paint a picture (as opposed to "draw up a plan", "withdraw", ...)? */
function isDrawTask(goal) {
  const g = String(goal || "");
  return DRAW_VERB.test(g) && !NOT_A_PICTURE.test(g);
}

/** Already on the drawing tool (so it must not be re-opened, which would wipe whatever is on the canvas)? */
function isOnDrawingTool(url) {
  return /toy-paint\.html/i.test(String(url || ""));
}

module.exports = { isDrawTask, isOnDrawingTool, DRAWING_TOOL_URL, DRAWING_TOOL_PATH };
