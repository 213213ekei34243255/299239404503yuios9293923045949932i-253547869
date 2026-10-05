// Noah/test/unit/session-privacy.test.cjs - the session id every chat and agent request carries to the server.
// It used to be the literal "default" for EVERY user of EVERY install: a server that keeps any conversation per session id would have mixed everybody's chats together.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const LLMClient = require("../../../Rexy/llm.cjs");

function withFetch(fn) {
  return async () => {
    const original = global.fetch;
    const bodies = [];
    global.fetch = async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      const reply = { answer: "ok", action: "wait", complete: true };
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => reply, text: async () => JSON.stringify(reply) };
    };
    try { await fn(bodies); } finally { global.fetch = original; }
  };
}

test("a chat request and an agent request carry this run's own random session id, never the shared word \"default\"", withFetch(async (bodies) => {
  const llm = new LLMClient({ endpoint: "http://127.0.0.1:9/predict" });
  await llm.chat({ message: "hello" });
  await llm.predict({ goal: "open a page", observation: {}, memory: {} });
  assert.equal(bodies.length, 2);
  const [chat, agent] = bodies.map((b) => b.session_id);
  assert.match(chat, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "a random UUID");
  assert.equal(chat, agent, "one conversation within the run");
  assert.notEqual(chat, "default");
}));

test("two runs (two users, two computers) never share a session id, and an explicit one is still honoured", withFetch(async (bodies) => {
  const a = new LLMClient({ endpoint: "http://127.0.0.1:9/predict" });
  const b = new LLMClient({ endpoint: "http://127.0.0.1:9/predict" });
  assert.notEqual(a.sessionId, b.sessionId);
  await a.chat({ message: "one" });
  await b.chat({ message: "two" });
  assert.notEqual(bodies[0].session_id, bodies[1].session_id);
  await a.chat({ message: "three", sessionId: "chosen-by-the-caller" });
  assert.equal(bodies[2].session_id, "chosen-by-the-caller");
  const c = new LLMClient({ endpoint: "http://127.0.0.1:9/predict", sessionId: "fixed" });
  await c.predict({ goal: "x", observation: {}, memory: { sessionId: "from-memory" } });
  assert.equal(bodies[3].session_id, "from-memory");
  assert.equal(c.sessionId, "fixed");
}));

test("nothing in the app sends the shared word any more", () => {
  for (const f of ["Rexy/llm.cjs", "Rexy/runtime.cjs"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/session_?[iI]d[^\n]*\|\|\s*"default"/.test(src), `${f} falls back to "default"`);
  }
});
