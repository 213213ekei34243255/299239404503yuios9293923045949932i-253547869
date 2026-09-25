"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const ax = require("../../perception/ax.cjs");

let nid = 0;
function node(role, name, { children = [], props = {}, backend, ignored = false, value } = {}) {
  const id = String(++nid);
  return {
    nodeId: id,
    ignored,
    role: { type: "role", value: role },
    name: { type: "computedString", value: name || "" },
    ...(value !== undefined ? { value: { type: "string", value } } : {}),
    properties: Object.entries(props).map(([k, v]) => ({ name: k, value: { type: "boolean", value: v } })),
    childIds: children.map((c) => c.nodeId),
    backendDOMNodeId: backend,
    _children: children,
  };
}
function flatten(root) {
  const out = [];
  (function walk(n) {
    out.push(n);
    n._children.forEach(walk);
  })(root);
  return out.map(({ _children, ...rest }) => rest);
}

function buildPage() {
  nid = 0;
  const cards = [];
  for (let i = 1; i <= 6; i++) {
    cards.push(
      node("listitem", "", {
        backend: 100 + i,
        children: [
          node("link", `Laptop model ${i}`, { backend: 200 + i, props: { focusable: true, url: `https://shop.test/p/${i}` } }),
          node("button", "Add to cart", { backend: 300 + i, props: { focusable: true } }),
        ],
      })
    );
  }
  const root = node("RootWebArea", "Shop", {
    backend: 1,
    children: [
      node("banner", "Site header", {
        backend: 2,
        children: [
          node("searchbox", "Search products", { backend: 3, props: { focusable: true, focused: true }, value: "lap" }),
          node("button", "Search", { backend: 4, props: { focusable: true } }),
        ],
      }),
      node("main", "Results", {
        backend: 5,
        children: [node("heading", "Laptops", { backend: 6, props: { level: 1 } }), node("list", "", { backend: 7, children: cards })],
      }),
      node("textbox", "Password", { backend: 8, props: { focusable: true }, value: "hunter2" }),
      node("generic", "", { backend: 9, children: [node("StaticText", "just text", { backend: 10 })] }),
    ],
  });
  return flatten(root);
}

test("analyzeFrame extracts interactive elements, headings and context labels", () => {
  const res = ax.analyzeFrame(buildPage());
  const roles = res.elements.map((e) => e.role);
  assert.ok(roles.includes("searchbox") && roles.includes("button") && roles.includes("link") && roles.includes("heading"));
  assert.ok(!roles.includes("StaticText") && !roles.includes("generic"));
  const firstAdd = res.elements.find((e) => e.role === "button" && e.name === "Add to cart");
  assert.equal(firstAdd.ctx, "Laptop model 1"); // repeated item disambiguated by its first link/heading
  const link = res.elements.find((e) => e.role === "link");
  assert.equal(link.href, "https://shop.test/p/1");
  assert.equal(res.headings[0].name, "Laptops");
});

test("password-like fields are flagged secret and their value masked", () => {
  const res = ax.analyzeFrame(buildPage());
  const pw = res.elements.find((e) => e.name === "Password");
  assert.equal(pw.secret, true);
  assert.equal(pw.value, "••••");
  const search = res.elements.find((e) => e.role === "searchbox");
  assert.equal(search.value, "lap");
});

test("RefTable is stable across snapshots and resets on navigation", () => {
  const t = new ax.RefTable();
  const a = ax.analyzeFrame(buildPage());
  a.elements.forEach((e) => t.assign(e));
  const before = a.elements.find((e) => e.backendNodeId === 4).ref;
  const b = ax.analyzeFrame(buildPage());
  // A new element appears first; existing nodes must keep their refs.
  b.elements.unshift({ frameKey: "", backendNodeId: 999, role: "button", name: "New", states: {}, interactive: true });
  b.elements.forEach((e) => t.assign(e));
  assert.equal(b.elements.find((e) => e.backendNodeId === 4).ref, before);
  assert.notEqual(b.elements[0].ref, before);
  t.reset();
  const c = ax.analyzeFrame(buildPage());
  c.elements.forEach((e) => t.assign(e));
  assert.equal(c.elements[0].ref, "e1");
});

test("iframe refs are namespaced f1e1", () => {
  const t = new ax.RefTable();
  const key = t.frameKeyFor("FRAME-A", false);
  assert.equal(key, "f1");
  const el = { frameKey: key, backendNodeId: 5, role: "button", name: "Inner", states: {} };
  assert.equal(t.assign(el), "f1e1");
  assert.equal(t.frameKeyFor("FRAME-A", false), "f1");
  assert.equal(t.frameKeyFor("FRAME-B", false), "f2");
});

function withRects(elements) {
  let y = 20;
  for (const e of elements) {
    e.rect = { x: 10, y, width: 100, height: 30 };
    y += 45;
  }
  return elements;
}

test("selectForModel is viewport-first, marks offscreen, and dedupes identical buttons", () => {
  const t = new ax.RefTable();
  const { elements } = ax.analyzeFrame(buildPage());
  elements.forEach((e) => t.assign(e));
  withRects(elements);
  const sel = ax.selectForModel(elements, { viewport: { width: 800, height: 300 }, tokenBudget: 2000 });
  assert.ok(sel.lines.length > 0);
  assert.ok(sel.lines.some((l) => l.includes("(below)")), "elements past the viewport bottom are flagged");
  assert.ok(sel.lines.every((l) => /^f?\d*e\d+ /.test(l) || /^e\d+ /.test(l)));
  // "Add to cart" buttons are distinct by ctx so none are merged away
  const adds = sel.lines.filter((l) => l.includes("Add to cart"));
  assert.ok(adds.length >= 2);
});

test("selectForModel respects the token budget", () => {
  const { elements } = ax.analyzeFrame(buildPage());
  const t = new ax.RefTable();
  elements.forEach((e) => t.assign(e));
  withRects(elements);
  const sel = ax.selectForModel(elements, { viewport: { width: 800, height: 5000 }, tokenBudget: 60 });
  assert.ok(sel.tokens <= 60);
  assert.ok(sel.hidden.trimmed > 0);
});

test("an open modal restricts the listing to the modal's contents", () => {
  nid = 0;
  const modal = node("dialog", "Cookie settings", {
    backend: 50,
    props: { modal: true },
    children: [node("button", "Reject all", { backend: 51, props: { focusable: true } }), node("button", "Accept all", { backend: 52, props: { focusable: true } })],
  });
  const root = node("RootWebArea", "P", { backend: 1, children: [node("button", "Behind", { backend: 2, props: { focusable: true } }), modal] });
  const res = ax.analyzeFrame(flatten(root));
  const t = new ax.RefTable();
  res.elements.forEach((e) => t.assign(e));
  withRects(res.elements);
  const sel = ax.selectForModel(res.elements, { viewport: { width: 800, height: 600 } });
  assert.ok(sel.hidden.modal);
  assert.ok(sel.lines.join("\n").includes("Reject all"));
  assert.ok(!sel.lines.join("\n").includes("Behind"));
});

test("findElements ranks exact > prefix > contains and honours role words", () => {
  const t = new ax.RefTable();
  const { elements } = ax.analyzeFrame(buildPage());
  elements.forEach((e) => t.assign(e));
  withRects(elements);
  const r1 = ax.findElements(elements, "search button");
  assert.equal(r1[0].name, "Search");
  assert.equal(r1[0].role, "button");
  const r2 = ax.findElements(elements, "search field");
  assert.equal(r2[0].role, "searchbox");
  const r3 = ax.findElements(elements, "laptop model 3");
  assert.equal(r3[0].name, "Laptop model 3");
  assert.deepEqual(ax.findElements(elements, "zzzzqqq"), []);
});

test("fingerprint re-finds an element after its node id went stale", () => {
  const t = new ax.RefTable();
  const first = ax.analyzeFrame(buildPage()).elements;
  first.forEach((e) => t.assign(e));
  const target = first.find((e) => e.role === "button" && e.name === "Search");
  const fp = ax.fingerprint(target);
  const reloaded = ax.analyzeFrame(buildPage()).elements.map((e) => ({ ...e, backendNodeId: e.backendNodeId + 5000 }));
  const found = ax.findByFingerprint(fp, reloaded);
  assert.equal(found.name, "Search");
  assert.equal(found.backendNodeId, target.backendNodeId + 5000);
});
