// In-memory brute-force protection. One server instance is assumed (the database is one SQLite file), so process memory is enough.
"use strict";

// Counts consecutive failures per key. After `free` failures the key is locked for baseMs, doubling with every further failure up to maxMs.
class FailureTracker {
  constructor({ free = 5, baseMs = 30000, maxMs = 900000, max = 20000, now = Date.now } = {}) {
    Object.assign(this, { free, baseMs, maxMs, max, now });
    this.map = new Map();
  }
  check(key) {
    const e = this.map.get(key);
    if (!e) return { locked: false, retryAfterMs: 0 };
    const left = e.lockedUntil - this.now();
    if (left > 0) return { locked: true, retryAfterMs: left };
    return { locked: false, retryAfterMs: 0 };
  }
  fail(key) {
    let e = this.map.get(key);
    if (!e) {
      if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value); // bounded: drop the oldest
      e = { count: 0, lockedUntil: 0 };
    }
    e.count++;
    if (e.count >= this.free) e.lockedUntil = this.now() + Math.min(this.maxMs, this.baseMs * 2 ** (e.count - this.free));
    this.map.delete(key); this.map.set(key, e); // most recent last
    return this.check(key);
  }
  success(key) { this.map.delete(key); }
}

// At most `limit` events per `windowMs` per key.
class SlidingWindow {
  constructor(limit, windowMs, { max = 20000, now = Date.now } = {}) { Object.assign(this, { limit, windowMs, max, now }); this.map = new Map(); }
  hit(key) {
    const t = this.now(), cutoff = t - this.windowMs;
    const arr = (this.map.get(key) || []).filter((x) => x > cutoff);
    if (arr.length >= this.limit) { this.map.set(key, arr); return false; }
    arr.push(t);
    if (!this.map.has(key) && this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, arr);
    return true;
  }
}

module.exports = { FailureTracker, SlidingWindow };
