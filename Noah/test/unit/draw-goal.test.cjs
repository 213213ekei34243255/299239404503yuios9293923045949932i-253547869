// Noah/test/unit/draw-goal.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const { isDrawTask, isOnDrawingTool, DRAWING_TOOL_URL, DRAWING_TOOL_PATH } = require("../../models/draw-goal.cjs");

test("DRAWING_TOOL_URL/PATH point at the real, existing bundled file", () => {
  assert.ok(fs.existsSync(DRAWING_TOOL_PATH), `${DRAWING_TOOL_PATH} must exist`);
  assert.match(DRAWING_TOOL_URL, /^file:\/\//);
  assert.ok(DRAWING_TOOL_URL.endsWith("toy-paint.html"));
});

test("isDrawTask: recognises real drawing requests", () => {
  for (const g of [
    "draw a rocket colour and also the surroundings with blue skies and great green hills and a sun",
    "Draw a rocket",
    "paint a picture of a sunset",
    "can you sketch a cat for me",
    "doodle something fun",
    "Noah, draw a house with a red roof",
  ]) {
    assert.ok(isDrawTask(g), g);
  }
});

test("isDrawTask: does not fire on idioms/unrelated uses of the same words", () => {
  for (const g of [
    "draw up a project plan",
    "draw my attention to the bug on line 12",
    "let's draw a conclusion from this data",
    "I need to withdraw money from my account",
    "open the top drawer",
    "write a story about a rocket",
    "search for a picture of a rocket",
    "",
    null,
    undefined,
  ]) {
    assert.ok(!isDrawTask(g), JSON.stringify(g));
  }
});

test("isOnDrawingTool: true only for the drawing tool's own page", () => {
  assert.ok(isOnDrawingTool(DRAWING_TOOL_URL));
  assert.ok(isOnDrawingTool("file:///C:/Jonah2/toy-paint.html"));
  assert.ok(isOnDrawingTool("file:///C:/Jonah2/toy-paint.html#anything"));
  assert.ok(!isOnDrawingTool("https://jspaint.app/"));
  assert.ok(!isOnDrawingTool("file:///C:/Jonah2/home.html"));
  assert.ok(!isOnDrawingTool(""));
  assert.ok(!isOnDrawingTool(undefined));
});
