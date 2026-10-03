// Trust/controller.cjs
//
// Main-process glue around TrustService: validates what the renderer asks for, keeps the per-session result cache, and
// de-duplicates concurrent checks of the same host. The renderer only ever passes a hostname; everything else (what is looked
// up, where) is decided here.

"use strict";

const fs = require("fs");
const path = require("path");
const { TrustService, TrustResultCache } = require("./service.cjs");

/**
 * Hosts that must never be sent to third parties (search engines, Reddit, the AI backend): the check would leak an internal
 * or private address, and a brand cannot be derived from it anyway. localhost, *.local / *.internal / *.lan, single-label
 * intranet names, and any IP literal.
 */
function isCheckableHost(host) {
  const h = String(host || "").toLowerCase().trim();
  if (!h || h.length > 253) return false;
  if (!/^[a-z0-9.-]+$/.test(h)) return false; // also rejects [::1]-style IPv6 literals and anything with a port/userinfo
  if (!h.includes(".")) return false; // localhost, intranet names
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false; // IPv4 literal
  if (/\.(localhost|local|internal|lan|home|corp|test|invalid|example)$/.test(h)) return false;
  if (h.startsWith(".") || h.endsWith(".") || h.includes("..")) return false;
  return true;
}

/** A stable per-install session/device id (iOS keeps the same in UserDefaults), so the server can tell installs apart. */
function loadIdentity(dir) {
  const file = path.join(dir, "trust-identity.json");
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved && saved.sessionId && saved.deviceId) return saved;
  } catch (_) { /* first run */ }
  const rnd = () => require("crypto").randomUUID();
  const fresh = { sessionId: "trust_win_" + rnd(), deviceId: "win_" + rnd() };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fresh));
  } catch (_) { /* not persisted: still valid for this run */ }
  return fresh;
}

function createTrustController({ dataDir, service, cache = new TrustResultCache() } = {}) {
  const svc = service || new TrustService(dataDir ? loadIdentity(dataDir) : {});
  const inflight = new Map(); // `${host}|${deep}` -> Promise

  /**
   * @param {string} rawHost
   * @param {{ deepScan?: boolean, force?: boolean }} [opts]  force = "Retry check": skip the cache
   */
  async function check(rawHost, opts = {}) {
    const host = String(rawHost || "").toLowerCase().trim();
    if (!isCheckableHost(host)) return { ok: false, skipped: true, error: "not a checkable public host" };
    const deepScan = !!opts.deepScan;

    if (!opts.force) {
      const hit = cache.get(host, { deepScan });
      if (hit) return { ok: true, result: hit, cached: true };
    }
    const key = `${host}|${deepScan}`;
    if (!inflight.has(key)) {
      inflight.set(key, svc.checkDomain(host, { deepScan }).finally(() => inflight.delete(key)));
    }
    const result = await inflight.get(key);
    // A "nothing was actually checked" result (every source failed / timed out) is most often a one-off network blip: do not
    // let it stand in for a real verdict on the next visit.
    if (result.source !== "none") cache.store(host, result, { deepScan });
    return { ok: true, result, cached: false };
  }

  /**
   * Would check() have to do a real, fresh lookup (i.e. spend the Trust Engine's network/work)? false for a host that is not checkable,
   * a cache hit, or a lookup already in flight. Billing uses this so a usage unit is only charged for work that actually happens -
   * the Trust card runs automatically on navigation, and a local page or a revisited site must not eat a user's allowance.
   */
  function needsFreshCheck(rawHost, opts = {}) {
    const host = String(rawHost || "").toLowerCase().trim();
    if (!isCheckableHost(host)) return false;
    const deepScan = !!opts.deepScan;
    if (!opts.force && cache.get(host, { deepScan })) return false;
    return !inflight.has(`${host}|${deepScan}`);
  }

  return { check, isCheckableHost, needsFreshCheck };
}

module.exports = { createTrustController, isCheckableHost, loadIdentity };
