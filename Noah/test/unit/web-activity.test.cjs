// Noah/test/unit/web-activity.test.cjs - the WEB agent's step-by-step view (Noah/agent/web-activity.cjs): the browser agent's own events become the same Activity lines the
// computer agent shows (looked at the page, took a screenshot, waited for the page to settle, clicked..., finished), and the two events the executor now publishes for it
// (an action starting, and every wait for the page) really are published. Real event bus; the agent itself is replaced by the events it publishes.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventBus } = require("../../events.cjs");
const { attachWebActivity, describeWebAction, shortUrl, labelOf } = require("../../agent/web-activity.cjs");
const { ActionExecutor } = require("../../agent/action-executor.cjs");
const { ACTIONS } = require("../../protocol/actions.cjs");

function rig() {
  const bus = new EventBus();
  const out = [];
  bus.subscribe((e) => { if (/^mission_/.test(e.event)) out.push(e); });
  const logs = [];
  const detach = attachWebActivity({ bus, log: (m) => logs.push(m) });
  const lines = () => out.filter((e) => e.event === "mission_activity");
  const texts = () => lines().filter((e) => !e.pending).map((e) => e.text);
  return { bus, out, lines, texts, logs, detach, send: (event, p = {}) => bus.publish(event, p) };
}
const start = (r, goal = "find a recipe") => r.send("task_started", { taskId: "t1", goal });

test("a web task starts and ends in the Activity view, with an honest end label (finished, not 'checked')", () => {
  const r = rig();
  start(r);
  assert.deepEqual(r.out.map((e) => [e.event, e.web, e.objective]), [["mission_started", true, "find a recipe"]]);
  r.send("task_finished", { taskId: "t1", status: "completed", result: "Done" });
  assert.deepEqual([r.out.at(-1).event, r.out.at(-1).status, r.out.at(-1).web], ["mission_finished", "web_done", true]);
  for (const [status, mapped] of [["failed", "web_failed"], ["cancelled", "cancelled"], ["weird", "web_failed"]]) {
    const q = rig();
    start(q);
    q.send("task_finished", { taskId: "t1", status });
    assert.equal(q.out.at(-1).status, mapped, status);
  }
});

test("a task that was replaced by a newer instruction does not end the view; and nothing is shown outside a task", () => {
  const r = rig();
  r.send("observe", { state: "start", step: 1 });
  r.send("action_started", { action: "click", detail: { action: "click" } });
  assert.equal(r.out.length, 0, "events outside a task are ignored");
  start(r);
  r.send("task_finished", { taskId: "t1", status: "cancelled", superseded: true });
  assert.deepEqual(r.out.map((e) => e.event), ["mission_started"], "superseded: no finish line (the next task starts its own)");
  r.send("observe", { state: "start", step: 1 });
  assert.equal(r.out.length, 1, "and it is over: later events are ignored until the next task");
});

test("looking at the page: one line that is replaced in place, with the title, the address without its query, and the number of elements", () => {
  const r = rig();
  start(r);
  r.send("observe", { state: "start", step: 1, screenshot: false });
  const [pending] = r.lines();
  assert.deepEqual([pending.pending, pending.kind, pending.text, pending.iteration], [true, "look", "Looking at the page…", 1]);
  r.send("observe", { state: "end", step: 1, url: "https://user:pw@example.com/search?q=secret&token=abc#frag", title: "Example search", elements: 212, screenshot: null });
  const done = r.lines()[1];
  assert.equal(done.id, pending.id, "the same id: the panel replaces the 'Looking…' line");
  assert.deepEqual([done.pending, done.text], [false, "Looked at the page (212 elements)"]);
  assert.equal(done.detail, "Example search · example.com/search");
  assert.doesNotMatch(JSON.stringify(r.out), /secret|token=abc|frag|user:pw/, "no query string, fragment or credentials anywhere");
  assert.equal(r.lines().length, 2, "no screenshot line when none was taken");
});

test("a screenshot gets its own line, only when one was really taken, with its size and the reason", () => {
  const r = rig();
  start(r);
  r.send("observe", { state: "start", step: 2, screenshot: true, reason: "the_page_looks_blank" });
  r.send("observe", { state: "end", step: 2, url: "https://example.com/", title: "T", elements: 1, screenshot: { width: 1280, height: 692 } });
  const shot = r.lines().find((l) => l.kind === "shot");
  assert.deepEqual([shot.text, shot.level, shot.pending], ["Took a screenshot of the page", "ok", false]);
  assert.equal(shot.detail, "1280×692 · the page looks blank");
  assert.equal(r.lines()[0].detail, "A screenshot will be taken too", "and the 'Looking…' line says so while it happens");
});

test("an action is shown as it starts and replaced by what happened: clicked, typed, opened, scrolled", () => {
  const r = rig();
  start(r);
  const run = (detail, result) => { r.send("action_started", { action: detail.action, detail }); r.send("action_result", { action: detail.action, ok: true, ...result }); };
  run({ action: "navigate", url: "https://www.example.com/recipes?id=7" }, {});
  run({ action: "click", target: { type: "text", text: "Sign in" } }, {});
  run({ action: "type", target: { name: "Search" }, text: "pasta" }, {});
  run({ action: "scroll", direction: "down" }, {});
  run({ action: "key_press", key: "Enter" }, {});
  assert.deepEqual(r.texts(), ["Opened www.example.com/recipes", "Clicked “Sign in”", "Typed 5 characters into “Search”", "Scrolled down", "Pressed Enter"]);
  const pend = r.lines().filter((l) => l.pending);
  assert.deepEqual(pend.map((l) => l.text), ["Opening www.example.com/recipes…", "Clicking “Sign in”…", "Typing into “Search”…", "Scrolling down…", "Pressing Enter…"]);
  const ids = r.lines().map((l) => l.id);
  for (const p of pend) assert.equal(ids.filter((i) => i === p.id).length, 2, `${p.text} is replaced in place`);
  assert.equal(new Set(pend.map((l) => l.id)).size, 5, "five different actions, five different lines");
  assert.deepEqual(pend.map((l) => l.kind), ["go", "click", "type", "scroll", "key"]);
});

test("a typed value is shown as the protocol hands it over (already masked for secrets), and clipped", () => {
  const r = rig();
  start(r);
  r.send("action_started", { action: "type", detail: { action: "type", target: { name: "Password" }, text: "[hidden]" } });
  r.send("action_result", { action: "type", ok: true });
  assert.equal(r.lines().at(-1).detail, "[hidden]");
  r.send("action_started", { action: "type", detail: { action: "type", target: { name: "Notes" }, text: "x".repeat(500) } });
  r.send("action_result", { action: "type", ok: true });
  assert.ok(r.lines().at(-1).detail.length <= 80);
});

test("a click that did nothing, a blocked one and a failed one are each told apart", () => {
  const r = rig();
  start(r);
  const click = (result) => { r.send("action_started", { action: "click", detail: { action: "click", target: { text: "Buy now" } } }); r.send("action_result", { action: "click", ...result }); return r.lines().at(-1); };
  const nothing = click({ ok: true, verdict: "no_effect" });
  assert.deepEqual([nothing.level, nothing.text, nothing.detail], ["ok", "Clicked “Buy now”", "Nothing on the page seemed to change."]);
  const blocked = click({ ok: false, code: "blocked", message: "Blocked by policy: this would buy something" });
  assert.deepEqual([blocked.level, blocked.text], ["refused", "Could not click “Buy now”"]);
  assert.match(blocked.detail, /would buy something/);
  const denied = click({ ok: false, code: "user_denied", message: "The user declined" });
  assert.equal(denied.level, "refused");
  const failed = click({ ok: false, code: "no_target", message: "No element matches “Buy now”" });
  assert.deepEqual([failed.level, failed.text], ["fail", "Could not click “Buy now”"]);
});

test("waiting for the page: a wait worth a line is shown, the many tiny ones are not, and an unsettled page or a dialog is said plainly", () => {
  const r = rig();
  start(r);
  r.send("page_wait", { ms: 120, settled: true });
  r.send("page_wait", { ms: 299, settled: true });
  assert.equal(r.lines().length, 0, "waits under 0.3 s are not worth a line each");
  r.send("page_wait", { ms: 840, settled: true });
  assert.equal(r.lines().at(-1).text, "Waited 0.8 s for the page to settle");
  r.send("page_wait", { ms: 1600, settled: false });
  assert.deepEqual([r.lines().at(-1).text, r.lines().at(-1).detail], ["Waited 1.6 s: the page was still changing", "Carrying on with what is there."]);
  r.send("page_wait", { ms: 5, settled: true, dialog: true });
  assert.match(r.lines().at(-1).text, /A dialog opened/);
  assert.ok(r.lines().every((l) => l.kind === "wait"));
});

test("the agent's thinking, its plan, a recovery and a question are shown too", () => {
  const r = rig();
  start(r);
  r.send("plan", { plan: { complexity: "trivial", steps: ["go"] } });
  assert.equal(r.lines().length, 0, "a trivial plan is not worth a line");
  r.send("plan", { plan: { complexity: "multi", steps: [{ text: "open the site" }, "search", "read the result"] } });
  assert.deepEqual([r.lines().at(-1).kind, r.lines().at(-1).text, r.lines().at(-1).detail], ["plan", "Made a plan (3 steps)", "1. open the site"]);
  r.send("step", { n: 2, summary: "The search box is at the top; typing the query next." });
  assert.deepEqual([r.lines().at(-1).kind, r.lines().at(-1).text, r.lines().at(-1).iteration], ["idea", "The search box is at the top; typing the query next.", 2]);
  r.send("step", { n: 3, summary: "" });
  assert.equal(r.lines().at(-1).iteration, 2, "an empty summary adds nothing");
  r.send("recovery", { failure: "click_no_effect", strategy: "dom_click" });
  assert.deepEqual([r.lines().at(-1).text, r.lines().at(-1).detail], ["Trying another way: click no effect", "Next: dom click"]);
  r.send("ask_user", { question: "Which account should I use?" });
  assert.deepEqual([r.lines().at(-1).kind, r.lines().at(-1).detail], ["ask", "Which account should I use?"]);
});

test("each step has its own heading number, taken from the agent's own step counter", () => {
  const r = rig();
  start(r);
  r.send("observe", { state: "start", step: 1 });
  r.send("observe", { state: "start", step: 2 });
  assert.deepEqual(r.lines().map((l) => l.iteration), [1, 2]);
  assert.notEqual(r.lines()[0].id, r.lines()[1].id, "the same kind of line in two steps has two ids");
});

test("every action the browser agent can take has words for it (a new action cannot be left without)", () => {
  for (const name of Object.keys(ACTIONS)) {
    const d = describeWebAction({ action: name, target: { text: "X" }, url: "https://a.b/c", text: "hi", key: "Enter", keys: ["Ctrl", "L"], direction: "up", ms: 500 });
    assert.ok(d.kind && d.doing && d.done && d.failed, name);
    assert.doesNotMatch(d.doing, /undefined|\[object/, name);
    assert.doesNotMatch(d.done, /undefined|\[object/, name);
  }
  const unknown = describeWebAction({ action: "brand_new_action" });
  assert.deepEqual([unknown.kind, unknown.done], ["note", "Did: brand new action"]);
  assert.ok(describeWebAction(undefined).doing, "even nothing at all does not throw");
});

test("labels: the words the page uses, a spot when it was by coordinates, nothing invented", () => {
  assert.equal(labelOf({ target: { text: "Sign in" } }), "“Sign in”");
  assert.equal(labelOf({ target: { x: 10, y: 20 } }), "a spot on the page");
  assert.equal(labelOf({ target: { ref: "e5" } }), "an element");
  assert.equal(labelOf({}), "");
  assert.equal(labelOf({ target: { text: "x".repeat(200) } }).length, 62, "a long label is cut");
  assert.equal(shortUrl("not a url?x=1#y"), "not a url");
  assert.equal(shortUrl("https://example.com/?a=1"), "example.com");
  assert.equal(shortUrl(undefined), "");
});

test("describing never breaks the agent: bad events are survived and logged; detaching stops it", () => {
  const r = rig();
  start(r);
  assert.doesNotThrow(() => { r.send("action_started"); r.send("action_result"); r.send("observe", { state: "end" }); r.send("plan", {}); r.send("page_wait"); r.send("step", { n: "x" }); });
  r.bus.publish("recovery", { failure: { toString() { throw new Error("hostile"); } } });
  assert.ok(r.logs.some((l) => /web activity: hostile/.test(l)), JSON.stringify(r.logs));
  const before = r.out.length;
  r.detach();
  r.send("observe", { state: "start", step: 9 });
  assert.equal(r.out.length, before);
});

// ------------------------------------------------------------------------------------------------ the executor's two new events
function executor({ settleResult = { settled: true, ms: 840 } } = {}) {
  const bus = new EventBus();
  const seen = [];
  bus.subscribe((e) => seen.push(e));
  const browser = { waitForSettle: async (o) => { browser.calls.push(o); if (settleResult instanceof Error) throw settleResult; return settleResult; }, calls: [] };
  const ex = new ActionExecutor({ browser, computer: {}, safety: { guard() {}, checkAction: async () => ({ allowed: true }) }, verifier: {}, bus, getConfig: () => ({}) });
  return { ex, seen, browser };
}

test("every action announces itself before it runs, with the protocol's REDACTED form of it, and its result follows", async () => {
  const { ex, seen } = executor();
  const r = await ex.execute({ action: "does_not_exist", target: { text: "x" } });
  assert.equal(r.ok, false);
  assert.deepEqual(seen.map((e) => e.event), ["action_started", "action_result"], "started first, result after");
  assert.equal(seen[0].action, "does_not_exist");
  assert.deepEqual(seen[0].detail, { action: "does_not_exist", target: { text: "x" } });
});

test("a typed secret is masked in the announcement (the panel never sees it)", async () => {
  const { ex, seen } = executor();
  await ex.execute({ action: "type", target: { name: "Password", role: "textbox", type: "text" }, text: "hunter2-very-secret-password", sensitive: true });
  const started = seen.find((e) => e.event === "action_started");
  assert.doesNotMatch(JSON.stringify(started), /hunter2-very-secret-password/, JSON.stringify(started));
});

test("every wait for the page goes through one helper that reports how long it waited, and passes the same options on", async () => {
  const a = executor({ settleResult: { settled: true, ms: 840 } });
  const r = await a.ex._settle({ timeoutMs: 1600 });
  assert.deepEqual(r, { settled: true, ms: 840 }, "the browser's answer is returned unchanged");
  assert.deepEqual(a.browser.calls, [{ timeoutMs: 1600 }]);
  const w = a.seen.find((e) => e.event === "page_wait");
  assert.deepEqual([w.ms, w.settled, w.dialog, w.timeoutMs], [840, true, false, 1600]);

  const b = executor({ settleResult: { settled: false, ms: 1600 } });
  await b.ex._settle({ timeoutMs: 1600 });
  assert.equal(b.seen.find((e) => e.event === "page_wait").settled, false);

  const c = executor({ settleResult: { settled: true, ms: 3, dialog: true } });
  await c.ex._settle({});
  assert.equal(c.seen.find((e) => e.event === "page_wait").dialog, true);

  const d = executor({ settleResult: undefined });
  await d.ex._settle({ timeoutMs: 100 });
  const ev = d.seen.find((e) => e.event === "page_wait");
  assert.ok(Number.isFinite(ev.ms) && ev.settled === true, "an answer without detail still reports a real duration");
});

test("a stopped wait stays stopped: the error is not swallowed and no wait is reported", async () => {
  const e = executor({ settleResult: Object.assign(new Error("stopped"), { code: "STOPPED" }) });
  await assert.rejects(() => e.ex._settle({ timeoutMs: 100 }), /stopped/);
  assert.equal(e.seen.filter((x) => x.event === "page_wait").length, 0);
});

test("no part of the executor waits for the page any other way", () => {
  const src = require("fs").readFileSync(require.resolve("../../agent/action-executor.cjs"), "utf8");
  const direct = src.match(/this\.browser\.waitForSettle\(/g) || [];
  assert.equal(direct.length, 1, "only the helper itself calls the browser's wait");
  assert.ok((src.match(/this\._settle\(/g) || []).length >= 15, "and all the other waits use the helper");
});
