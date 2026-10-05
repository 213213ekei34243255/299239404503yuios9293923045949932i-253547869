// Noah/test/unit/preload-modes.test.cjs - what the panel's mode pick looks like AFTER the preload script, i.e. what reaches the main process.
// The panel posts mode "web" / "computer", the renderer relays it, and preload.cjs (the only door between the page and the main process) keeps or drops it. It used to keep only
// "chat" and "agent", so "Computer agent" and "Web agent" silently became "Auto" and a WhatsApp Web request ran as a browser task. Nothing tested that door; this does.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const path = require("path");

function loadPreload() {
  const exposed = {};
  const invoked = [];
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: { invoke: (...a) => { invoked.push(a); return Promise.resolve({ success: true }); }, on() {}, once() {}, send() {}, removeListener() {}, removeAllListeners() {} },
    webFrame: {}, webUtils: {},
  };
  const original = Module._load;
  Module._load = function (request, ...rest) { return request === "electron" ? fakeElectron : original.call(this, request, ...rest); };
  const file = path.join(__dirname, "..", "..", "..", "preload.cjs");
  try {
    delete require.cache[require.resolve(file)];
    require(file);
  } finally { Module._load = original; delete require.cache[require.resolve(file)]; }
  return { exposed, invoked };
}

const loaded = loadPreload(); // once: the script defines a global property that cannot be defined twice
const sentOpts = async (rexy, invoked, opts) => { invoked.length = 0; await rexy.goal("do a thing", opts); const call = invoked.find((c) => c[0] === "rexy:goal"); assert.ok(call, "rexy:goal was invoked"); return call[2]; };

test("every mode the panel can pick reaches the main process: auto (nothing sent), chat, web, computer, and the old name agent", async () => {
  const { exposed, invoked } = loaded;
  const rexy = exposed.rexy;
  assert.equal(typeof rexy.goal, "function");
  assert.equal((await sentOpts(rexy, invoked, { mode: "chat" })).mode, "chat");
  assert.equal((await sentOpts(rexy, invoked, { mode: "web" })).mode, "web", "Web agent used to be dropped here");
  assert.equal((await sentOpts(rexy, invoked, { mode: "computer" })).mode, "computer", "Computer agent used to be dropped here");
  assert.equal((await sentOpts(rexy, invoked, { mode: "agent" })).mode, "agent", "the old name still works (the main process turns it into web)");
  assert.equal("mode" in (await sentOpts(rexy, invoked, { mode: "auto" })), false, "auto is simply not sent");
  assert.equal("mode" in (await sentOpts(rexy, invoked, {})), false);
  assert.equal("mode" in (await sentOpts(rexy, invoked, undefined)), false);
});

test("the page cannot smuggle anything else through the mode, the source, or the attachment ids", async () => {
  const { exposed, invoked } = loaded;
  const rexy = exposed.rexy;
  for (const mode of ["admin", "COMPUTER", "computer ", "__proto__", "constructor", "", null, 7, {}, ["computer"]]) assert.equal("mode" in (await sentOpts(rexy, invoked, { mode })), false, JSON.stringify(mode));
  const o = await sentOpts(rexy, invoked, { mode: "computer", source: "voice", attachmentIds: ["a", 5, null, "b"], extra: "x", ticket: "free" });
  assert.deepEqual(o, { source: "voice", mode: "computer", attachmentIds: ["a", "b"] }, "only the three known things, cleaned");
  assert.equal((await sentOpts(rexy, invoked, { source: "other" })).source, undefined);
});
