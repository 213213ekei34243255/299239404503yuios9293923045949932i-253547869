// Noah/test/unit/hub-core.test.cjs - the pure logic of the Game Hub, Creator Studio and Aesthetic Lab (hub-core.js).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("../../../hub-core.js");

test("play budget and break reminders", () => {
  assert.deepEqual(H.budgetState(30, 180), { minutesToday: 30, budgetMin: 180, left: 150, over: false, pct: 17, level: "ok" });
  assert.equal(H.budgetState(170, 180).level, "warn");
  assert.equal(H.budgetState(200, 180).over, true); assert.equal(H.budgetState(200, 180).level, "bad");
  const start = 1_000_000;
  assert.deepEqual(H.breakDue(start, 0, start + 59 * 60000, 60), { sinceMin: 59, due: false });
  assert.deepEqual(H.breakDue(start, 0, start + 60 * 60000, 60), { sinceMin: 60, due: true });
  assert.equal(H.breakDue(start, start + 50 * 60000, start + 70 * 60000, 60).due, false, "a break taken restarts the clock");
  assert.equal(H.breakDue(start, 0, start + 9e9, 0).due, false, "0 = reminders off");
  const days = H.sessionDays({ "2026-10-20": { min: 95.4 }, "2026-10-21": { min: 10 } }, new Date(2026, 9, 21, 15));
  assert.equal(days.length, 7); assert.deepEqual([days[5].min, days[6].min, days[0].min], [95, 10, 0]);
});

test("labels: money, durations, speeds, end times, temperature levels", () => {
  assert.equal(H.fmtMoney(0), "Free"); assert.equal(H.fmtMoney(9.5), "$9.50"); assert.equal(H.fmtMoney(null), "-"); assert.equal(H.fmtMoney("x"), "-");
  assert.equal(H.fmtDur(75), "1h 15m"); assert.equal(H.fmtDur(60), "1h"); assert.equal(H.fmtDur(5), "5m");
  assert.equal(H.fmtBytes(500), "500 B/s"); assert.equal(H.fmtBytes(2048), "2 KB/s"); assert.equal(H.fmtBytes(3 * 1048576), "3.0 MB/s");
  const now = Date.parse("2026-10-21T00:00:00Z");
  assert.equal(H.endsIn("2026-10-21T00:30:00Z", now), "ends in 30 min"); assert.equal(H.endsIn("2026-10-21T10:00:00Z", now), "ends in 10 h"); assert.equal(H.endsIn("2026-10-26T00:00:00Z", now), "ends in 5 days");
  assert.equal(H.endsIn("2026-10-20T00:00:00Z", now), "ended"); assert.equal(H.endsIn("garbage", now), "");
  assert.deepEqual([60, 75, 88, 97, null].map(H.tempLevel), ["ok", "warm", "warn", "bad", "none"]);
});

const wk = new Date(2026, 9, 19); // Monday
const at = (d, h) => new Date(2026, 9, d, h).toISOString();
test("weekPlan: groups by day, adds hours, and warns about rest days, a week with no day off, and too many hours", () => {
  const items = [
    { id: 1, title: "Reel", kind: "reel", status: "edited", when: at(20, 10) },
    { id: 2, title: "Post", kind: "post", status: "scripted", when: at(20, 9) },
    { id: 3, title: "Sunday vlog", kind: "video", status: "idea", when: at(25, 12) }, // Sunday
    { id: 4, title: "Done", kind: "video", status: "posted", when: at(21, 12) },
  ];
  const p = H.weekPlan(items, new Date(2026, 9, 22), { restDays: [0], capacityHours: 25 });
  assert.equal(p.days.length, 7); assert.equal(p.days[0].key, "2026-10-19");
  assert.deepEqual(p.days[1].items.map((i) => i.title), ["Post", "Reel"], "sorted by time");
  assert.equal(p.days[1].hours, 4.5); assert.equal(p.days[2].hours, 0, "posted work no longer counts as hours still to do");
  assert.ok(p.warnings.some((w) => /rest day \(Sunday\)/.test(w)));
  assert.equal(p.overbooked, false);
  const heavy = [...items, ...Array.from({ length: 6 }, (_, i) => ({ id: 10 + i, title: "v" + i, kind: "video", status: "idea", when: at(19 + (i % 5), 8) }))];
  const q = H.weekPlan(heavy, wk, { restDays: [0], capacityHours: 25 });
  assert.equal(q.overbooked, true); assert.ok(q.warnings.some((w) => /too much/.test(w)));
  const everyDay = Array.from({ length: 7 }, (_, i) => ({ id: i, title: "d" + i, kind: "story", status: "idea", when: at(19 + i, 9) }));
  assert.ok(H.weekPlan(everyDay, wk, { restDays: [] }).warnings.some((w) => /no day off/.test(w)));
  assert.deepEqual(H.weekPlan([{ id: 1, when: "garbage" }], wk).days.flatMap((d) => d.items), []);
});

test("pipeline stages and moving an item forward", () => {
  const p = H.pipeline([{ status: "idea" }, { status: "posted" }, { status: "weird" }]);
  assert.equal(p.idea.length, 2, "an unknown status is shown as an idea, not lost"); assert.equal(p.posted.length, 1);
  assert.equal(H.nextStatus("idea"), "scripted"); assert.equal(H.nextStatus("posted"), "posted");
});

test("income: paid this month, the 3-month average, what is owed, and which invoices are overdue", () => {
  const now = new Date(2026, 9, 21).getTime();
  const e = [
    { id: 1, brand: "A", amount: 500, status: "paid", paidOn: new Date(2026, 9, 3).toISOString() },
    { id: 2, brand: "B", amount: 300, status: "paid", paidOn: new Date(2026, 8, 10).toISOString() },
    { id: 3, brand: "C", amount: 900, status: "paid", paidOn: new Date(2026, 7, 10).toISOString() },
    { id: 4, brand: "D", amount: 1200, status: "invoiced", due: new Date(2026, 9, 1).toISOString() },
    { id: 5, brand: "E", amount: 400, status: "invoiced", due: new Date(2026, 10, 1).toISOString() },
    { id: 6, brand: "F", amount: 250, status: "delivered" },
    { id: 7, brand: "G", amount: 700, status: "agreed" },
  ];
  const s = H.incomeSummary(e, now);
  assert.equal(s.thisMonth, 500); assert.deepEqual(s.last3, [300, 900, 0]); assert.equal(s.avg3, 400);
  assert.equal(s.owed, 1850); assert.deepEqual(s.overdue, [4]); assert.equal(s.overdueTotal, 1200); assert.equal(s.pipeline, 700);
  assert.deepEqual(H.incomeSummary([], now).last3, [0, 0, 0]);
});

test("platform limits: counted in characters not bytes, over/near flags, TikTok's disagreement is flagged", () => {
  assert.equal(H.countChars("héllo \u{1F600}"), 7);
  const c = H.captionCheck("x".repeat(2100), "Instagram");
  assert.deepEqual([c.count, c.limit, c.left, c.over, c.near], [2100, 2200, 100, false, true]);
  assert.equal(H.captionCheck("x".repeat(281), "X").over, true);
  assert.match(H.LIMITS.TikTok.note, /disagree/);
  assert.equal(H.LIMITS.YouTube.title, 100);
  assert.equal(H.captionCheck("a", "Unknown").limit, 2200);
  assert.deepEqual(H.hashtags("Love it #Cats #cats #DogLife and #été but not # or #-"), ["#cats", "#doglife", "#été"]);
});

test("offline hashtag ideas and caption parsing", () => {
  assert.deepEqual(H.ruleHashtags("The best morning skincare routine", 6), ["#best", "#morning", "#skincare", "#routine", "#bestmorning", "#morningskincare"]);
  assert.deepEqual(H.ruleHashtags("a to the", 5), []);
  const caps = H.parseCaptions("Sure! Here are 3 captions:\n1. Golden hour, no filter needed.\n2) \"Soft mornings and strong coffee.\"\n- Short\n3. Chasing light and good company.");
  assert.deepEqual(caps, ["Golden hour, no filter needed.", "Soft mornings and strong coffee.", "Chasing light and good company."]);
  assert.match(H.captionPrompt({ topic: "autumn walk", tone: "calm", platform: "TikTok", count: 2 }), /Write 2 different TikTok captions about: autumn walk\. Tone: calm\./);
});

test("Pinterest's 2026 palette has the five reported hex codes; aesthetics are valid, unique, and link to a search (not a guessed page)", () => {
  assert.deepEqual(H.PINTEREST_2026.map((c) => [c.name, c.hex]), [["Cool Blue", "#D7EFFF"], ["Jade", "#AEB8A0"], ["Plum Noir", "#351E28"], ["Wasabi", "#E9F056"], ["Persimmon", "#FF5C34"]]);
  assert.equal(new Set(H.AESTHETICS.map((a) => a.name)).size, H.AESTHETICS.length);
  for (const a of H.AESTHETICS) assert.match(a.hex, /^#[0-9a-f]{6}$/i);
  assert.equal(H.wikiSearch("Dark Academia"), "https://aesthetics.fandom.com/wiki/Special:Search?query=Dark%20Academia");
});

test("readable text colour", () => { assert.equal(H.textOn("#ffffff"), "#111"); assert.equal(H.textOn("#351e28"), "#fff"); assert.equal(H.textOn("#e9f056"), "#111"); assert.equal(H.textOn("nope"), "#fff"); });

function image(w, h, fill) { const b = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) { const c = fill(i % w, Math.floor(i / w)); b.set(c.length === 4 ? c : [...c, 255], i * 4); } return b; }
test("palette extraction: finds the dominant colours, orders by share, ignores transparent pixels, and is deterministic", () => {
  const img = image(100, 100, (x) => (x < 60 ? [200, 30, 30] : x < 90 ? [30, 60, 200] : [240, 240, 240]));
  const p = H.extractPalette(img, 100, 100, 3);
  assert.equal(p.length, 3);
  assert.equal(p[0].hex, "#c81e1e"); assert.equal(p[1].hex, "#1e3cc8"); assert.equal(p[2].hex, "#f0f0f0");
  assert.deepEqual(p.map((c) => c.pct), [60, 30, 10]);
  assert.deepEqual(H.extractPalette(img, 100, 100, 3), p, "same image, same palette");
  assert.deepEqual(H.extractPalette(image(10, 10, () => [10, 20, 30, 0]), 10, 10, 4), [], "fully transparent = nothing");
  const half = image(10, 10, (x) => (x < 5 ? [255, 0, 0, 255] : [0, 255, 0, 0]));
  assert.deepEqual(H.extractPalette(half, 10, 10, 4).map((c) => c.hex), ["#ff0000"], "the transparent half is ignored");
  const gradient = image(64, 64, (x, y) => [x * 4, y * 4, 128]);
  const g = H.extractPalette(gradient, 64, 64, 5); assert.ok(g.length >= 3 && g.length <= 5); assert.ok(g.every((c) => /^#[0-9a-f]{6}$/.test(c.hex)));
  assert.equal(H.paletteText([{ hex: "#c81e1e" }, { hex: "#1e3cc8" }]), "#C81E1E  #1E3CC8");
});

test("palette extraction drops stray anti-aliasing / JPEG-edge shades (under 1.5% of the picture)", () => {
  const img = image(100, 100, (x, y) => (y === 0 && x < 2 ? [100, 80, 200] : x < 50 ? [255, 0, 0] : [0, 0, 255]));
  const p = H.extractPalette(img, 100, 100, 6);
  assert.deepEqual(p.map((c) => c.hex).sort(), ["#0000ff", "#ff0000"], "two real colours, the 2 odd pixels are not a third");
  assert.equal(H.extractPalette(image(4, 4, () => [10, 200, 10]), 4, 4, 5).length, 1, "a one-colour picture still gives its colour");
});

test("checklists exist and every item is a non-empty string", () => { for (const [k, v] of Object.entries(H.CHECKLISTS)) { assert.ok(k && v.length >= 4); assert.ok(v.every((s) => typeof s === "string" && s.length > 3)); } });
