// hubs/feeds.cjs - the Game Hub's outside data: free giveaways (GamerPower), PC deals (CheapShark) and Epic's free-games feed.
// Runs in the MAIN process (a page cannot set the User-Agent header CheapShark now requires). Every parser is pure and tested against real responses
// captured on 2026-10-21 (Noah/test/fixtures/hubs); the network function is injected so tests never touch the internet.
//
// What was measured, and why the code is the way it is:
//  - GamerPower: free, no key, "do not exceed 10 requests per second", and an active link back to GamerPower.com is REQUIRED (the UI shows it; ATTRIBUTION below).
//  - CheapShark: free, no key, but answers 400 without a descriptive User-Agent.
//  - Epic's freeGamesPromotions is unofficial. Its promotion `discountPercentage` is the percent you still PAY: 0 = free, 20 = 80% off. So "free" is decided by the
//    price (discountPrice === 0) and a naive "has a promotion" reader would list ordinary sales as free.
"use strict";

const UA = "JonahBrowser/1.4 (game hub; https://jonahbrowser.com)";
const ATTRIBUTION = { name: "GamerPower.com", url: "https://www.gamerpower.com" };
const HOSTS = { gamerpower: "https://www.gamerpower.com/api", cheapshark: "https://www.cheapshark.com/api/1.0", epic: "https://store-site-backend-static.ak.epicgames.com" };
const GP_PLATFORMS = ["pc", "steam", "epic-games-store", "gog", "ps4", "ps5", "xbox-series-xs", "xbox-one", "switch", "android", "ios", "drm-free", "itchio"];
const GP_TYPES = ["game", "loot", "beta"];
const GP_SORT = ["date", "value", "popularity"];

const str = (v, max = 400) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
/** Only https links are ever shown or opened; anything else becomes "". */
const safeUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === "https:" ? x.href : ""; } catch (_) { return ""; } };
/** CheapShark returns dealIDs already percent-encoded; decode then encode ONCE so the redirect link is never double-encoded. */
const dealParam = (id) => { const raw = str(id, 200); let dec = raw; try { dec = decodeURIComponent(raw); } catch (_) { /* keep as is */ } return encodeURIComponent(dec); };
const money = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : null);

// ------------------------------------------------------------------ parsers

/** GamerPower /giveaways -> [{ id, title, worth, image, thumb, description, instructions, url, pageUrl, type, platforms[], endDate|null, users, active }] */
function parseGiveaways(json) {
  if (!Array.isArray(json)) return [];
  return json.filter((g) => g && g.title).map((g) => {
    const end = Date.parse(String(g.end_date || "").replace(" ", "T") + "Z");
    return {
      id: Number(g.id) || 0,
      title: str(g.title, 140),
      worth: /^\$?[\d.,]+$/.test(String(g.worth || "").trim()) ? (String(g.worth).startsWith("$") ? String(g.worth) : "$" + g.worth) : "",
      image: safeUrl(g.image), thumb: safeUrl(g.thumbnail),
      description: str(g.description, 400),
      instructions: String(g.instructions || "").split(/\r?\n/).map((l) => str(l, 160)).filter(Boolean).slice(0, 8),
      url: safeUrl(g.open_giveaway_url || g.gamerpower_url), pageUrl: safeUrl(g.gamerpower_url),
      type: str(g.type, 20),
      platforms: String(g.platforms || "").split(",").map((p) => str(p, 30)).filter(Boolean),
      endDate: Number.isFinite(end) ? new Date(end).toISOString() : null,
      users: Number(g.users) || 0,
      active: String(g.status || "Active").toLowerCase() === "active",
    };
  });
}

/** Epic freeGamesPromotions -> { free: [...], sales: [...], upcoming: [...] }. Free = the price you pay right now is 0. */
function parseEpic(json, now = Date.now()) {
  const out = { free: [], sales: [], upcoming: [] };
  const els = json && json.data && json.data.Catalog && json.data.Catalog.searchStore && json.data.Catalog.searchStore.elements;
  if (!Array.isArray(els)) return out;
  const img = (e) => { const k = (e.keyImages || []).find((i) => i.type === "OfferImageWide") || (e.keyImages || [])[0]; return safeUrl(k && k.url); };
  const slug = (e) => { const m = (e.offerMappings || []).concat(e.catalogNs && e.catalogNs.mappings ? e.catalogNs.mappings : []).find((x) => x && x.pageSlug); return str((m && m.pageSlug) || e.productSlug || "", 120).replace(/\/home$/, ""); };
  const link = (e) => (slug(e) ? `https://store.epicgames.com/en-US/p/${encodeURIComponent(slug(e))}` : "https://store.epicgames.com/en-US/free-games");
  for (const e of els) {
    if (!e || !e.title) continue;
    const tp = e.price && e.price.totalPrice, pr = e.promotions || {};
    const cur = ((pr.promotionalOffers || [])[0] || {}).promotionalOffers || [];
    const up = ((pr.upcomingPromotionalOffers || [])[0] || {}).promotionalOffers || [];
    const base = { title: str(e.title, 140), image: img(e), url: link(e), originalPrice: tp && tp.fmtPrice ? str(tp.fmtPrice.originalPrice, 20) : "" };
    const active = cur.find((o) => Date.parse(o.startDate) <= now && now < Date.parse(o.endDate));
    if (active) {
      const pay = active.discountSetting && Number(active.discountSetting.discountPercentage); // percent still paid
      const isFree = (tp && Number(tp.discountPrice) === 0) || pay === 0;
      const entry = { ...base, endDate: active.endDate, percentOff: Number.isFinite(pay) ? 100 - pay : null, price: tp && tp.fmtPrice ? str(tp.fmtPrice.discountPrice, 20) : "" };
      (isFree ? out.free : out.sales).push(entry);
    } else if (up.length) {
      const u = up[0];
      const pay = u.discountSetting && Number(u.discountSetting.discountPercentage);
      if (pay === 0) out.upcoming.push({ ...base, startDate: u.startDate, endDate: u.endDate });
    }
  }
  return out;
}

/** CheapShark /deals -> [{ dealID, gameID, title, sale, normal, savings, storeID, rating, metacritic, steamPercent, thumb, url }] */
function parseDeals(json) {
  if (!Array.isArray(json)) return [];
  return json.filter((d) => d && d.dealID && d.title).map((d) => ({
    dealID: str(d.dealID, 200), gameID: str(d.gameID, 20), title: str(d.title, 140),
    sale: money(d.salePrice), normal: money(d.normalPrice), savings: Math.round(Number(d.savings) || 0),
    storeID: str(d.storeID, 6), thumb: safeUrl(d.thumb), steamPercent: Number(d.steamRatingPercent) || 0, metacritic: Number(d.metacriticScore) || 0,
    url: `https://www.cheapshark.com/redirect?dealID=${dealParam(d.dealID)}`,
  }));
}
/** CheapShark /games?title= -> [{ gameID, title, cheapest, dealID, thumb, url }] */
function parseGames(json) {
  if (!Array.isArray(json)) return [];
  return json.filter((g) => g && g.gameID && g.external).map((g) => ({
    gameID: str(g.gameID, 20), title: str(g.external, 140), cheapest: money(g.cheapest), dealID: str(g.cheapestDealID, 200), thumb: safeUrl(g.thumb),
    url: g.cheapestDealID ? `https://www.cheapshark.com/redirect?dealID=${dealParam(g.cheapestDealID)}` : "",
  }));
}
/** CheapShark /stores -> { "1": "Steam", ... } (active stores only) */
function parseStores(json) { const m = {}; if (Array.isArray(json)) for (const s of json) if (s && s.storeID && s.storeName && Number(s.isActive) !== 0) m[String(s.storeID)] = str(s.storeName, 40); return m; }

/** The price alerts that fired: a watched title whose cheapest price is at or under the target the user set. */
function priceAlerts(watch, games) {
  const byId = new Map((games || []).map((g) => [String(g.gameID), g]));
  const out = [];
  for (const w of watch || []) {
    const g = byId.get(String(w.gameID));
    if (g && g.cheapest !== null && Number.isFinite(Number(w.target)) && g.cheapest <= Number(w.target)) out.push({ gameID: w.gameID, title: w.title, price: g.cheapest, target: Number(w.target), url: g.url });
  }
  return out;
}

// ------------------------------------------------------------------ fetching (rate-limited, cached, with the User-Agent)

/** One polite client: min gap between calls to a host, a cache per URL, a timeout, and a size cap. `fetchFn` is injected (Node 18+ fetch in the app). */
function createClient({ fetchFn = (...a) => fetch(...a), now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), minGapMs = { gamerpower: 150, cheapshark: 300, epic: 300 }, ttlMs = 5 * 60 * 1000 } = {}) {
  const cache = new Map(), lastCall = {};
  async function getJson(host, url, ttl = ttlMs) {
    const hit = cache.get(url);
    if (hit && now() - hit.at < ttl) return hit.json;
    const wait = (lastCall[host] || 0) + (minGapMs[host] || 0) - now();
    if (wait > 0) await sleep(wait);
    lastCall[host] = now();
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetchFn(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctl.signal });
      if (!res.ok) { const e = new Error(`${host} answered ${res.status}`); e.status = res.status; throw e; }
      const text = await res.text();
      if (text.length > 4 * 1024 * 1024) throw new Error(`${host} sent an unexpectedly large answer`);
      const json = JSON.parse(text);
      cache.set(url, { at: now(), json });
      return json;
    } catch (err) {
      if (hit) return hit.json; // an older answer beats none, when the network fails
      throw err;
    } finally { clearTimeout(timer); }
  }
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  return {
    async giveaways({ platform = "pc", type = "game", sort = "popularity" } = {}) {
      const p = pick(platform, GP_PLATFORMS, "pc"), t = pick(type, GP_TYPES, "game"), s = pick(sort, GP_SORT, "popularity");
      return { items: parseGiveaways(await getJson("gamerpower", `${HOSTS.gamerpower}/giveaways?platform=${p}&type=${t}&sort-by=${s}`)), attribution: ATTRIBUTION };
    },
    async epic() { return parseEpic(await getJson("epic", `${HOSTS.epic}/freeGamesPromotions?locale=en-US&country=US&allowCountries=US`), now()); },
    async deals({ upperPrice = 15, pageSize = 12, sortBy = "Savings", title = "" } = {}) {
      const sb = pick(sortBy, ["Deal Rating", "Title", "Savings", "Price", "Metacritic", "Reviews", "Release", "Store", "recent"], "Savings");
      const q = `upperPrice=${Math.min(60, Math.max(0, Number(upperPrice) || 15))}&pageSize=${Math.min(30, Math.max(1, Number(pageSize) || 12))}&sortBy=${encodeURIComponent(sb)}${title ? "&title=" + encodeURIComponent(str(title, 80)) : ""}`;
      const [deals, stores] = await Promise.all([getJson("cheapshark", `${HOSTS.cheapshark}/deals?${q}`), getJson("cheapshark", `${HOSTS.cheapshark}/stores`, 24 * 3600 * 1000).catch(() => [])]);
      return { items: parseDeals(deals), stores: parseStores(stores) };
    },
    async search(title) {
      const t = str(title, 80); if (t.length < 2) return { items: [] };
      return { items: parseGames(await getJson("cheapshark", `${HOSTS.cheapshark}/games?title=${encodeURIComponent(t)}&limit=8`)) };
    },
    /** Current cheapest price for specific CheapShark game ids (for price alerts). */
    async cheapestFor(ids) {
      const list = [...new Set((ids || []).map((x) => String(x).replace(/\D/g, "")).filter(Boolean))].slice(0, 25);
      if (!list.length) return { items: [] };
      const json = await getJson("cheapshark", `${HOSTS.cheapshark}/games?ids=${list.join(",")}`);
      const items = Object.entries(json || {}).map(([id, g]) => {
        const deals = (g && g.deals || []).filter((d) => Number.isFinite(Number(d.price))).sort((a, b) => Number(a.price) - Number(b.price));
        return { gameID: id, title: str(g && g.info && g.info.title, 140), cheapest: deals.length ? money(deals[0].price) : null, cheapestEver: money(g && g.cheapestPriceEver && g.cheapestPriceEver.price), url: deals.length ? `https://www.cheapshark.com/redirect?dealID=${dealParam(deals[0].dealID)}` : "" };
      });
      return { items };
    },
  };
}

module.exports = { UA, ATTRIBUTION, GP_PLATFORMS, GP_TYPES, parseGiveaways, parseEpic, parseDeals, parseGames, parseStores, priceAlerts, createClient, safeUrl };
