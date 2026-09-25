"use strict";
// Which messages go to Noah (browser agent) and which stay plain chat (Rexy/runtime.cjs _looksLikeBrowserTask).
const test = require("node:test");
const assert = require("node:assert/strict");

const RexyRuntime = require("../../../Rexy/runtime.cjs");
const isBrowserTask = (g) => RexyRuntime.prototype._looksLikeBrowserTask.call({}, g);

test("writing/acting on the page in front of the user is a browser task (these all went to plain chat before)", () => {
  for (const g of [
    "Noah, write a story about Jurassic World on this notepad",
    "Can you please write a story abotu Jurassic world on this notepad",
    "To me a favor, can you write the whole story about Jurassic World on this notepad place?",
    "type a letter into the document",
    "fill in this form with my details",
    "summarize this page",
    "please write a poem in the text box on the page",
    "use the notepad to write a story",
  ]) assert.equal(isBrowserTask(g), true, g);
});

test("plain conversation stays chat", () => {
  for (const g of [
    "write a story about Jurassic World",
    "tell me a joke",
    "what is a notepad?",
    "how do I write a good letter",
    "what is the capital of France",
    "explain quantum computing simply",
  ]) assert.equal(isBrowserTask(g), false, g);
});

test("the goals that already worked still do", () => {
  for (const g of ["open youtube.com and search for lo-fi music", "Noah, open https://en.wikipedia.org", "go to amazon and buy headphones", "Do me a favor, open just notepad.com."]) assert.equal(isBrowserTask(g), true, g);
});
