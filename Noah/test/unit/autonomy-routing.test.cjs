// Noah/test/unit/autonomy-routing.test.cjs - which messages are MISSIONS (work on the user's own project) (Noah/agent/intent.cjs looksLikeMissionTask)
// The first two rows are the very prompts the audit found going to plain chat. The rest pin down the line between a project job, a web page
// and chat: a false positive pops a folder dialog at someone who asked about YouTube, a false negative sends a project job to chat.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { looksLikeMissionTask, looksLikeBrowserTask } = require("../../agent/intent.cjs");

const MISSIONS = [
  "Set up this project, diagnose the errors, modify whatever files are necessary, run the tests, verify that it works, and give me the final result.",
  "Install the dependencies, fix the failing build and run npm test until it passes.",
  "run the tests and fix whatever fails",
  "fix the bug in my code",
  "Refactor the parser module and make sure the unit tests still pass",
  "npm install and start the dev server",
  "git status and commit the changes",
  "debug why the app crashes on startup",
  "Write a python script that renames all the files in this folder",
  "add a unit test for the add function in src/utils.js",
  "compile the project and show me the errors",
  "clone https://github.com/foo/bar and install its dependencies",
  "why does npm test fail in this repo?",
  "create a new node project with a hello world server",
  "update the dependencies in package.json",
  "pip install -r requirements.txt and run main.py",
  "can you fix the failing tests in this codebase",
  "the build is broken, please diagnose it",
  "edit src/index.js and change the port to 8080",
  "run the linter and fix the problems",
  "commit these changes with a good message",
  "investigate the stack trace in my project",
  "Set up the development environment for this repo",
  "cargo test and fix any failures",
];
const NOT_MISSIONS = [
  "open youtube.com and search for lo-fi music",
  "go to amazon and find the cheapest laptop",
  "fill in the form on this page",
  "log in to my bank",
  "search for npm tutorials",
  "run a google search for npm install errors",
  "summarize this page",
  "read the article and tell me the price",
  "play the best result",
  "scroll down and click the first video",
  "type a story on the notepad",
  "write a story about dragons",
  "write a poem about the sea",
  "what is a git branch?",
  "how do I install node?",
  "why is the sky blue?",
  "explain what a unit test is",
  "hello there",
  "open github.com and star the repo",
  "find me a tutorial on how to fix a failing build",
  "fix the error on this page",
  "go to stackoverflow.com and look up how to run the tests in jest",
  "continue",
  "stop",
  "",
];

test("project jobs are missions (including the prompts the audit found going to plain chat)", () => {
  for (const g of MISSIONS) assert.equal(looksLikeMissionTask(g), true, `should be a mission: ${g}`);
});

test("web tasks, questions and chat are not missions", () => {
  for (const g of NOT_MISSIONS) assert.equal(looksLikeMissionTask(g), false, `should NOT be a mission: ${g}`);
});

test("the old classifier still behaves as before (browser tasks), so adding missions did not move any existing route", () => {
  for (const g of ["open youtube.com and search for lo-fi music", "go to amazon and find the cheapest laptop", "summarize this page", "type a story on the notepad", "play the best result", "scroll down and click the first video"]) assert.equal(looksLikeBrowserTask(g), true, g);
  for (const g of ["hello there", "why is the sky blue?", "write a poem about the sea"]) assert.equal(looksLikeBrowserTask(g), false, g);
});

test("the audit's headline prompt: it was NOT a browser task (so it went to chat) and now IS a mission", () => {
  const g = "Set up this project, diagnose the errors, modify whatever files are necessary, run the tests, verify that it works, and give me the final result.";
  assert.equal(looksLikeBrowserTask(g), false, "that is why it never reached the agent");
  assert.equal(looksLikeMissionTask(g), true);
});

test("a question needs a reference to the user's own project to count", () => {
  assert.equal(looksLikeMissionTask("why does npm test fail?"), false);
  assert.equal(looksLikeMissionTask("why does npm test fail in this repo?"), true);
  assert.equal(looksLikeMissionTask("what is wrong with my code?"), false, "no command or file to act on: that is a chat question");
  assert.equal(looksLikeMissionTask("how do I run the tests?"), false);
  assert.equal(looksLikeMissionTask("how do I run the tests in this project?"), true);
});

test("bad input never throws", () => {
  for (const v of [null, undefined, 42, {}, [], "   "]) assert.equal(looksLikeMissionTask(v), false);
});
