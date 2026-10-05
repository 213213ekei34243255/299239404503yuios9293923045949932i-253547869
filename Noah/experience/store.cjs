// Noah/experience/store.cjs
//
// What Noah has learned from working with ONE user, kept on THIS computer, per signed-in account. The file holds counters and nothing else:
//   pitfalls  { "<area>:<code>": { n, last } }   how often a known slip (advice.cjs) happened, and when last
//   outcomes  { "<area>": { succeeded, other } } how tasks ended
// Nothing the user wrote, read, said or opened is ever kept (see advice.cjs for why that holds by construction). The file is checked on load, so even a hand-edited
// file cannot put text into a prompt. Another account on the same computer, or the same account signed out, gets its OWN file: lessons never cross over.
// Nothing here is uploaded anywhere.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ADVICE, AREAS, isKnown } = require("./advice.cjs");

const DAY = 24 * 60 * 60 * 1000;
const FORGET_AFTER_DAYS = 120; // a slip that has not happened for this long no longer counts
const MAX_COUNT = 100000;

/** The file a user's lessons live in: a hash of the account (never the account id itself), or "device" when nobody is signed in. */
function scopeOf(accountId) {
  return typeof accountId === "string" && accountId ? "a-" + crypto.createHash("sha256").update("noah-experience:" + accountId).digest("hex").slice(0, 20) : "device";
}

const blank = () => ({ v: 1, pitfalls: {}, outcomes: {} });
const clampCount = (n) => Math.max(0, Math.min(MAX_COUNT, Math.floor(Number(n) || 0)));

/** Accept only what this module itself could have written: known keys, plain numbers. Anything else is dropped. */
function clean(raw) {
  const out = blank();
  if (!raw || typeof raw !== "object") return out;
  const p = raw.pitfalls && typeof raw.pitfalls === "object" ? raw.pitfalls : {};
  for (const key of Object.keys(p)) {
    const [area, code] = key.split(":");
    if (!isKnown(area, code)) continue;
    const e = p[key] || {};
    const n = clampCount(e.n);
    if (n > 0) out.pitfalls[key] = { n, last: Number.isFinite(e.last) ? Math.floor(e.last) : 0 };
  }
  const o = raw.outcomes && typeof raw.outcomes === "object" ? raw.outcomes : {};
  for (const area of AREAS) if (o[area] && typeof o[area] === "object") out.outcomes[area] = { succeeded: clampCount(o[area].succeeded), other: clampCount(o[area].other) };
  return out;
}

class ExperienceStore {
  /**
   * @param {object} o
   * @param {string} o.dir                        where the files live (the app's own data folder)
   * @param {() => (string|null)} [o.getAccountId] who is signed in right now (null = nobody)
   * @param {() => boolean} [o.isEnabled]         the user's switch ("Learn from my tasks")
   * @param {() => number} [o.now]
   */
  constructor({ dir, getAccountId = () => null, isEnabled = () => true, now = Date.now } = {}) {
    Object.assign(this, { dir, getAccountId, isEnabled, now });
    this._cache = new Map(); // scope -> data
  }

  _scope() { let id = null; try { id = this.getAccountId(); } catch (_) { /* nobody signed in */ } return scopeOf(id); }
  _file(scope) { return path.join(this.dir, `experience-${scope}.json`); }
  _enabled() { try { return this.isEnabled() !== false; } catch (_) { return true; } }

  _load(scope) {
    if (this._cache.has(scope)) return this._cache.get(scope);
    let data = blank();
    try { data = clean(JSON.parse(fs.readFileSync(this._file(scope), "utf8"))); } catch (_) { /* no file yet, or an unreadable one: start empty */ }
    this._cache.set(scope, data);
    return data;
  }

  _save(scope) {
    if (!this.dir) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = this._file(scope);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...this._load(scope), updated: this.now() }));
      fs.renameSync(tmp, file);
    } catch (_) { /* a lesson that cannot be saved is not worth stopping a task for */ }
  }

  /** One known slip happened. Anything not in advice.cjs is ignored (so no text can ever get in). */
  recordPitfall(area, code) {
    if (!this._enabled() || !isKnown(area, code)) return false;
    const scope = this._scope();
    const d = this._load(scope);
    const key = `${area}:${code}`;
    const e = d.pitfalls[key] || { n: 0, last: 0 };
    e.n = clampCount(e.n + 1);
    e.last = this.now();
    d.pitfalls[key] = e;
    this._save(scope);
    return true;
  }

  /** How a task ended: "succeeded" or anything else ("other"). */
  recordOutcome(area, succeeded) {
    if (!this._enabled() || !AREAS.includes(area)) return false;
    const scope = this._scope();
    const d = this._load(scope);
    const o = d.outcomes[area] || { succeeded: 0, other: 0 };
    if (succeeded) o.succeeded = clampCount(o.succeeded + 1); else o.other = clampCount(o.other + 1);
    d.outcomes[area] = o;
    this._save(scope);
    return true;
  }

  /**
   * The lessons for one area, strongest first: [{ advice, n }]. A slip counts once it has happened `minCount` times (one slip is not a pattern) and recently.
   * Codes that share the same advice sentence are added together.
   */
  lessons(area, { minCount = 2, max = 5 } = {}) {
    if (!this._enabled()) return [];
    const d = this._load(this._scope());
    const since = this.now() - FORGET_AFTER_DAYS * DAY;
    const byAdvice = new Map();
    for (const [key, e] of Object.entries(d.pitfalls)) {
      if (!key.startsWith(area + ":") || !(e.last >= since)) continue;
      const text = ADVICE[key];
      byAdvice.set(text, (byAdvice.get(text) || 0) + e.n);
    }
    return [...byAdvice.entries()].filter(([, n]) => n >= minCount).map(([advice, n]) => ({ advice, n })).sort((a, b) => b.n - a.n).slice(0, max);
  }

  /** What the user may be shown about themselves: counts only. */
  summary() {
    const d = this._load(this._scope());
    return { enabled: this._enabled(), pitfalls: Object.values(d.pitfalls).reduce((a, e) => a + e.n, 0), outcomes: JSON.parse(JSON.stringify(d.outcomes)), lessons: AREAS.flatMap((a) => this.lessons(a, { minCount: 1, max: 20 }).map((l) => ({ area: a, ...l }))) };
  }

  /** Forget everything for the signed-in account (or the device when signed out). */
  forget() {
    const scope = this._scope();
    this._cache.set(scope, blank());
    try { fs.rmSync(this._file(scope), { force: true }); } catch (_) { /* nothing to remove */ }
    return true;
  }
}

module.exports = { ExperienceStore, scopeOf, clean };
