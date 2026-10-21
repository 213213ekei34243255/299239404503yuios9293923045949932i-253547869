// Noah/test/unit/hubs-feeds.test.cjs - the Game Hub's feeds (hubs/feeds.cjs), against REAL responses captured 2026-10-21 (Noah/test/fixtures/hubs).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const F = require("../../../hubs/feeds.cjs");
const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "hubs", n), "utf8"));
const EPIC_NOW = Date.parse("2026-10-21T12:00:00Z");

test("GamerPower giveaways: normalised, https-only, with the attribution link carried along", () => {
  const items = F.parseGiveaways(fx("gp.json"));
  assert.equal(items.length, 16);
  for (const g of items) {
    assert.ok(g.id > 0 && g.title && g.platforms.length, g.title);
    for (const u of [g.url, g.image, g.thumb]) assert.ok(u === "" || u.startsWith("https://"), u);
    assert.ok(g.endDate === null || !Number.isNaN(Date.parse(g.endDate)));
  }
  assert.equal(items[0].worth, "$29.99");
  assert.ok(items[0].instructions.length > 0 && items[0].instructions.every((l) => !/[\r\n]/.test(l)));
  assert.equal(F.ATTRIBUTION.url, "https://www.gamerpower.com");
  assert.deepEqual(F.parseGiveaways({ not: "an array" }), []);
});

test("an 'N/A' end date becomes null, an unsafe link becomes empty, odd worth is dropped", () => {
  const [g] = F.parseGiveaways([{ id: 1, title: "x", worth: "N/A", end_date: "N/A", open_giveaway_url: "javascript:alert(1)", gamerpower_url: "http://insecure.example/x", image: "data:text/html,hi", platforms: "PC, Steam", type: "Game", status: "Active" }]);
  assert.equal(g.endDate, null); assert.equal(g.worth, ""); assert.equal(g.url, ""); assert.equal(g.image, ""); assert.deepEqual(g.platforms, ["PC", "Steam"]);
});

test("Epic: only a price of 0 is FREE; discountPercentage is the percent still paid (20 = 80% off); upcoming free games are separate", () => {
  const e = F.parseEpic(fx("epic.json"), EPIC_NOW);
  assert.deepEqual(e.free.map((x) => x.title).sort(), ["Agent A: A puzzle in disguise", "Bad Cheese"]);
  const sale = Object.fromEntries(e.sales.map((x) => [x.title, x.percentOff]));
  assert.deepEqual(sale, { "Eternal Threads": 80, "Castlevania Anniversary Collection": 60, "Monument Valley": 65 });
  assert.ok(!e.free.some((x) => e.sales.some((s) => s.title === x.title)), "nothing is both free and on sale");
  assert.deepEqual(e.upcoming.map((x) => x.title).sort(), ["Home - A Unique Horror Adventure", "Sker Ritual"]);
  for (const x of e.free) { assert.match(x.url, /^https:\/\/store\.epicgames\.com\/en-US\//); assert.ok(x.endDate); }
  assert.equal(F.parseEpic({}).free.length, 0);
});

test("Epic: a promotion that has not started or has ended is not free yet", () => {
  const before = F.parseEpic(fx("epic.json"), Date.parse("2026-10-10T00:00:00Z"));
  assert.equal(before.free.length, 0);
  const after = F.parseEpic(fx("epic.json"), Date.parse("2026-12-01T00:00:00Z"));
  assert.equal(after.free.length, 0);
});

test("CheapShark deals and game search: prices as numbers, redirect links encoded exactly once", () => {
  const d = F.parseDeals(fx("cs-deals.json"));
  assert.ok(d.length >= 3);
  for (const x of d) { assert.ok(x.title && x.dealID); assert.ok(x.sale === null || typeof x.sale === "number"); assert.match(x.url, /^https:\/\/www\.cheapshark\.com\/redirect\?dealID=/); assert.doesNotMatch(x.url, /%25/, "no double encoding"); }
  const g = F.parseGames(fx("cs-games.json"));
  assert.equal(g[0].title, "Portal"); assert.equal(g[0].cheapest, 9.99); assert.doesNotMatch(g[0].url, /%25/);
  const stores = F.parseStores(fx("cs-stores.json"));
  assert.equal(stores["1"], "Steam");
});

test("price alerts fire only at or under the target the user set", () => {
  const games = [{ gameID: "82", cheapest: 9.99, url: "u" }, { gameID: "5", cheapest: null, url: "" }];
  assert.deepEqual(F.priceAlerts([{ gameID: "82", title: "Portal", target: 10 }], games).map((a) => a.price), [9.99]);
  assert.deepEqual(F.priceAlerts([{ gameID: "82", title: "Portal", target: 5 }], games), []);
  assert.deepEqual(F.priceAlerts([{ gameID: "5", title: "x", target: 5 }], games), [], "no price known = no alert");
  assert.deepEqual(F.priceAlerts([{ gameID: "82", title: "Portal", target: "abc" }], games), []);
});

function fakeFetch(map, log) {
  return async (url, opts) => { log.push({ url, ua: opts.headers["User-Agent"] }); const hit = Object.entries(map).find(([k]) => url.includes(k)); if (!hit) return { ok: false, status: 404, text: async () => "" }; const [, body] = hit; return typeof body === "function" ? body() : { ok: true, status: 200, text: async () => JSON.stringify(body) }; };
}

test("the client always sends the descriptive User-Agent CheapShark requires, and only allowed filter values reach the URL", async () => {
  const log = [];
  const c = F.createClient({ fetchFn: fakeFetch({ "/giveaways": fx("gp.json"), "/deals": fx("cs-deals.json"), "/stores": fx("cs-stores.json"), "freeGamesPromotions": fx("epic.json") }, log), sleep: async () => {} });
  const g = await c.giveaways({ platform: "steam; rm -rf", type: "game", sort: "nonsense" });
  assert.ok(log[0].url.endsWith("platform=pc&type=game&sort-by=popularity"), log[0].url);
  assert.equal(g.attribution.name, "GamerPower.com");
  await c.deals({ upperPrice: "9999", pageSize: "0", title: "a&b" });
  const dealsCall = log.find((l) => l.url.includes("/deals"));
  assert.match(dealsCall.url, /upperPrice=60&pageSize=1/); assert.match(dealsCall.url, /title=a%26b/);
  assert.ok(log.every((l) => /^JonahBrowser\//.test(l.ua) && l.ua.length > 20), "descriptive UA on every call");
  const e = await c.epic(); assert.ok(e.free.length >= 0 && Array.isArray(e.sales));
});

test("the client caches (no second request inside the TTL), spaces calls to one host, and falls back to the older answer when the network fails", async () => {
  const log = []; let t = 1000; const sleeps = []; let failing = false;
  const body = () => { if (failing) throw new Error("offline"); return { ok: true, status: 200, text: async () => JSON.stringify(fx("gp.json")) }; };
  const c = F.createClient({ fetchFn: fakeFetch({ "/giveaways": body }, log), now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, ttlMs: 60000 });
  await c.giveaways({ platform: "pc" }); await c.giveaways({ platform: "pc" });
  assert.equal(log.length, 1, "second identical call came from the cache");
  await c.giveaways({ platform: "steam" });
  assert.ok(sleeps.length >= 1 && sleeps[0] > 0 && sleeps[0] <= 150, "a second call to the same host waits (GamerPower: max 10 per second): " + sleeps);
  t += 120000; failing = true;
  const old = await c.giveaways({ platform: "pc" });
  assert.equal(old.items.length, 16, "network down: the older answer is used, not an error");
  await assert.rejects(c.giveaways({ platform: "gog" }), /offline/);
});

test("a non-200 answer is an error with the status, a 400 from CheapShark says so", async () => {
  const c = F.createClient({ fetchFn: async () => ({ ok: false, status: 400, text: async () => "" }), sleep: async () => {} });
  await assert.rejects(c.search("portal"), (e) => e.status === 400 && /cheapshark answered 400/.test(e.message));
  assert.deepEqual(await c.search("a"), { items: [] }, "a one-letter search is not sent at all");
});

test("cheapestFor reads the lowest CURRENT price from /games?ids=", async () => {
  const log = [];
  const c = F.createClient({ fetchFn: fakeFetch({ "games?ids=": fx("cs-ids.json") }, log), sleep: async () => {} });
  const r = await c.cheapestFor(["82", "612", "abc", "82"]);
  assert.match(log[0].url, /ids=82,612$/);
  const lego = r.items.find((x) => x.gameID === "612"), portal = r.items.find((x) => x.gameID === "82");
  assert.equal(portal.cheapest, 9.99); assert.ok(lego.cheapest > 0 && lego.cheapest <= 15.89, "the minimum over the deals, not the first one");
  assert.equal(portal.cheapestEver, 0.99);
});
