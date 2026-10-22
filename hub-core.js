// hub-core.js - the pure logic behind Jonah's Game Hub, Creator Studio and Aesthetic Lab (no DOM, no storage, no network: unit-tested in Node,
// used in the page as window.HubCore). Dates are passed in; nothing here reads the clock.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HubCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY = 86400000, MIN = 60000;
  const pad = (n) => String(n).padStart(2, "0");
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const mondayOf = (d) => { const s = startOfDay(d); return new Date(s.getTime() - ((s.getDay() + 6) % 7) * DAY); };
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // =============================================================== GAME HUB

  /** Minutes played per day -> how today stands against a daily budget. */
  function budgetState(minutesToday, budgetMin) {
    const left = budgetMin - minutesToday;
    return { minutesToday, budgetMin, left, over: left < 0, pct: budgetMin > 0 ? clamp(Math.round((minutesToday / budgetMin) * 100), 0, 999) : 0, level: left < 0 ? "bad" : left <= budgetMin * 0.15 ? "warn" : "ok" };
  }
  /** A break is due when `everyMin` minutes passed since the session started or the last break was taken. Returns minutes since that point and whether to nudge. */
  function breakDue(sessionStartMs, lastBreakMs, nowMs, everyMin) {
    const since = Math.floor((nowMs - Math.max(sessionStartMs, lastBreakMs || 0)) / MIN);
    return { sinceMin: since, due: everyMin > 0 && since >= everyMin };
  }
  const sessionDays = (days, today, n = 7) => Array.from({ length: n }, (_, i) => { const d = new Date(startOfDay(today).getTime() - (n - 1 - i) * DAY); const k = dateKey(d); return { key: k, label: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()], min: Math.round((days && days[k] && days[k].min) || 0) }; });

  const fmtMoney = (n, cur = "$") => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "-" : Number(n) === 0 ? "Free" : `${cur}${Number(n).toFixed(2)}`);
  const fmtDur = (min) => { const m = Math.max(0, Math.round(min)); return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? " " + (m % 60) + "m" : ""}` : `${m}m`; };
  const fmtBytes = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB/s" : b >= 1024 ? Math.round(b / 1024) + " KB/s" : Math.round(b) + " B/s");
  /** "ends in 3 days" style label for an ISO end date. */
  function endsIn(iso, nowMs) {
    const t = Date.parse(iso); if (!Number.isFinite(t)) return "";
    const ms = t - nowMs; if (ms <= 0) return "ended";
    const h = ms / 3600000; return h < 1 ? `ends in ${Math.max(1, Math.round(ms / MIN))} min` : h < 48 ? `ends in ${Math.round(h)} h` : `ends in ${Math.round(h / 24)} days`;
  }
  /** Colour class for a temperature in C (rule-of-thumb for laptops/desktops; not a diagnosis). */
  const tempLevel = (c) => (c === null || c === undefined ? "none" : c >= 95 ? "bad" : c >= 85 ? "warn" : c >= 70 ? "warm" : "ok");

  // =============================================================== CREATOR STUDIO

  const STATUSES = ["idea", "scripted", "filmed", "edited", "scheduled", "posted"];
  const PLATFORMS = ["Instagram", "TikTok", "YouTube", "X", "Pinterest", "Other"];
  const KINDS = { reel: { label: "Reel / short", hours: 3 }, post: { label: "Photo post", hours: 1.5 }, story: { label: "Story", hours: 0.5 }, video: { label: "Long video", hours: 6 }, live: { label: "Live", hours: 1.5 }, thread: { label: "Thread / text", hours: 1 } };
  const nextStatus = (s) => STATUSES[Math.min(STATUSES.length - 1, STATUSES.indexOf(s) + 1)] || "idea";

  /**
   * A week of planned content. items: { id, title, platform, kind, status, when (ISO), hours? }. opts: { restDays: [0-6 JS getDay values], capacityHours }.
   * Returns { days: [{ key, date, items, hours, isRest }], hours, capacityHours, overbooked, warnings[] } - it says out loud what does not fit.
   */
  function weekPlan(items, weekStart, opts) {
    const o = { restDays: [0], capacityHours: 25, ...(opts || {}) };
    const start = mondayOf(weekStart);
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(start.getTime() + i * DAY); return { key: dateKey(d), date: d, items: [], hours: 0, isRest: o.restDays.includes(d.getDay()) }; });
    for (const it of items || []) {
      const t = Date.parse(it.when); if (!Number.isFinite(t)) continue;
      const day = days.find((d) => d.key === dateKey(new Date(t))); if (!day) continue;
      day.items.push(it);
      if (it.status !== "posted") day.hours += Number(it.hours) || (KINDS[it.kind] ? KINDS[it.kind].hours : 1);
    }
    days.forEach((d) => d.items.sort((a, b) => Date.parse(a.when) - Date.parse(b.when)));
    const hours = days.reduce((n, d) => n + d.hours, 0), warnings = [];
    for (const d of days) if (d.isRest && d.items.some((i) => i.status !== "posted")) warnings.push(`You planned work on a rest day (${d.date.toLocaleDateString(undefined, { weekday: "long" })}). Rest days are what stop burnout - move it or take another day off.`);
    const withWork = days.filter((d) => d.items.some((i) => i.status !== "posted") || d.hours > 0).length;
    if (withWork >= 7) warnings.push("Every day this week has content work and there is no day off.");
    if (hours > o.capacityHours) warnings.push(`This week needs about ${Math.round(hours)}h of work but your limit is ${o.capacityHours}h - ${Math.round(hours - o.capacityHours)}h too much. Cut something or move it to next week.`);
    return { days, hours, capacityHours: o.capacityHours, overbooked: hours > o.capacityHours, warnings };
  }
  /** Items grouped by pipeline stage, newest first within a stage. */
  function pipeline(items) { const out = Object.fromEntries(STATUSES.map((s) => [s, []])); for (const it of items || []) (out[it.status] || out.idea).push(it); return out; }

  const INCOME_STATUSES = ["pitched", "agreed", "delivered", "invoiced", "paid"];
  /** Brand deals / income. entries: { id, brand, what, amount, status, due (ISO|""), paidOn (ISO|"") }. Plain tallies - not tax or financial advice. */
  function incomeSummary(entries, now) {
    const nowMs = now instanceof Date ? now.getTime() : now, d = new Date(nowMs);
    const monthKey = (t) => { const x = new Date(t); return x.getFullYear() * 12 + x.getMonth(); };
    const cur = monthKey(nowMs);
    const paid = (entries || []).filter((e) => e.status === "paid" && Number.isFinite(Date.parse(e.paidOn || e.due)));
    const byMonth = (m) => paid.filter((e) => monthKey(Date.parse(e.paidOn || e.due)) === m).reduce((n, e) => n + (Number(e.amount) || 0), 0);
    const last3 = [1, 2, 3].map((i) => byMonth(cur - i));
    const owed = (entries || []).filter((e) => e.status === "invoiced" || e.status === "delivered");
    const overdue = owed.filter((e) => e.status === "invoiced" && Number.isFinite(Date.parse(e.due)) && Date.parse(e.due) < nowMs);
    const sum = (a) => a.reduce((n, e) => n + (Number(e.amount) || 0), 0);
    return {
      thisMonth: byMonth(cur), last3, avg3: Math.round((last3.reduce((a, b) => a + b, 0) / 3) * 100) / 100,
      owed: sum(owed), overdue: overdue.map((e) => e.id), overdueTotal: sum(overdue), pipeline: sum((entries || []).filter((e) => e.status === "agreed" || e.status === "pitched")),
      monthName: d.toLocaleDateString(undefined, { month: "long" }),
    };
  }

  const CHECKLISTS = {
    "Short video": ["Hook written (first 2 seconds)", "Filmed", "Edited + captions", "Caption + hashtags written", "Cover frame chosen", "Posted", "Replied to first 10 comments"],
    "Photo post": ["Shot list done", "Edited", "Caption written", "Tags / location added", "Posted", "Replied to comments"],
    "Brand deal": ["Brief read twice", "Rate + usage rights agreed in writing", "Draft sent for approval", "Posted with required disclosure", "Invoice sent", "Payment received"],
    "Weekly reset": ["Plan next week's posts", "Batch-film one day", "Check what's owed to me", "One full day off", "Write 5 new ideas"],
  };
  /** Platform text limits. Instagram/X/YouTube agree across sources; TikTok's does NOT (2,200 vs 4,000), so the stricter one is used and flagged. */
  const LIMITS = {
    Instagram: { caption: 2200, note: "About 125 characters show before \"...more\"." },
    X: { caption: 280, note: "Counted roughly: X weights links and some characters differently." },
    TikTok: { caption: 2200, note: "Sources disagree (some say 4,000), so the safer 2,200 is used - check TikTok's own help page." },
    YouTube: { caption: 5000, title: 100, note: "Title up to 100, description up to 5,000." },
    Pinterest: { caption: 500, note: "Not verified - treat as a rough guide." },
    Other: { caption: 2200, note: "" },
  };
  const countChars = (text) => Array.from(String(text || "")).length;
  const hashtags = (text) => [...new Set((String(text || "").match(/#[\p{L}\p{N}_]+/gu) || []).map((h) => h.toLowerCase()))];
  function captionCheck(text, platform) {
    const lim = LIMITS[platform] || LIMITS.Other, n = countChars(text);
    return { count: n, limit: lim.caption, left: lim.caption - n, over: n > lim.caption, near: n > lim.caption * 0.9 && n <= lim.caption, tags: hashtags(text).length, note: lim.note };
  }
  /** Plain, offline hashtag ideas from a topic (single words, and pairs joined). The AI is not needed - and small models write poor hashtags. */
  function ruleHashtags(topic, max = 8) {
    const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "your", "about", "into", "have", "what", "when", "how", "are", "you", "its", "our"]);
    const words = [...new Set(String(topic || "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])].filter((w) => !stop.has(w));
    const tags = words.map((w) => "#" + w);
    for (let i = 0; i + 1 < words.length && tags.length < max + 4; i++) tags.push("#" + words[i] + words[i + 1]);
    return [...new Set(tags)].slice(0, max);
  }
  /** Numbered / bulleted caption ideas out of a model reply. */
  function parseCaptions(text) {
    return String(text || "").split(/\r?\n/).map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").replace(/^["'“]|["'”]$/g, "").trim()).filter((l) => l.length >= 8 && !/^(here are|sure|captions?:?)/i.test(l)).slice(0, 8);
  }
  function captionPrompt({ topic, tone, platform, count }) {
    return `Write ${count || 3} different ${platform || "Instagram"} captions about: ${String(topic || "").slice(0, 300)}. Tone: ${String(tone || "friendly").slice(0, 40)}. Number them 1., 2., 3. One caption per line, no explanations, no hashtags.`;
  }

  // =============================================================== AESTHETIC LAB

  /** Pinterest's 2026 palette: hex codes as reported by B&T and campaignme.com (Persimmon by House Digest only). */
  const PINTEREST_2026 = [{ name: "Cool Blue", hex: "#D7EFFF" }, { name: "Jade", hex: "#AEB8A0" }, { name: "Plum Noir", hex: "#351E28" }, { name: "Wasabi", hex: "#E9F056" }, { name: "Persimmon", hex: "#FF5C34" }];
  /** Each look as ONE theme colour - my reading of the aesthetic, not an official palette. */
  const AESTHETICS = [
    { name: "Dark Academia", hex: "#8b5e3c" }, { name: "Coquette", hex: "#f4a6bd" }, { name: "Y2K", hex: "#6ec6ff" }, { name: "Cyberpunk", hex: "#ff2a6d" },
    { name: "Vaporwave", hex: "#b967ff" }, { name: "Cottagecore", hex: "#8fae7a" }, { name: "Clean girl", hex: "#d8c8b8" }, { name: "Goth", hex: "#7a1f3d" },
    { name: "Sunset", hex: "#ff7e5f" }, { name: "Ocean", hex: "#1fa2c4" }, { name: "Midnight", hex: "#3a3f9b" }, { name: "Matcha", hex: "#a3c586" },
  ];
  const wikiSearch = (name) => `https://aesthetics.fandom.com/wiki/Special:Search?query=${encodeURIComponent(name)}`;

  const toHex = (r, g, b) => "#" + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
  const luminance = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  /** Black or white text, whichever reads better on this colour. */
  function textOn(hex) { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || ""); if (!m) return "#fff"; return luminance(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)) > 0.36 ? "#111" : "#fff"; }

  /**
   * The main colours of an image. `rgba` is RGBA bytes (Uint8ClampedArray / Buffer), w*h pixels; transparent pixels are ignored.
   * Method: count the pixels in coarse colour bins (5 bits per channel), take the most popular bins as colours, but only if they are clearly different from the ones
   * already taken, then give every bin to its nearest chosen colour and average. (Plain median cut was tried first: it splits at the median COUNT, so one dominant
   * colour dragged others into muddy blends.) Returns up to k [{ hex, pct }] by share. Deterministic.
   */
  function extractPalette(rgba, w, h, k = 6) {
    const n = w * h, step = Math.max(1, Math.floor(n / 40000)); // look at ~40k pixels at most
    const bins = new Map();
    for (let i = 0; i < n; i += step) {
      const o = i * 4; if (rgba[o + 3] < 128) continue;
      const key = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3);
      let b = bins.get(key); if (!b) { b = { n: 0, r: 0, g: 0, b: 0 }; bins.set(key, b); }
      b.n++; b.r += rgba[o]; b.g += rgba[o + 1]; b.b += rgba[o + 2];
    }
    if (!bins.size) return [];
    const list = [...bins.entries()].sort((a, b) => b[1].n - a[1].n || a[0] - b[0]).map(([, b]) => ({ n: b.n, rgb: [b.r / b.n, b.g / b.n, b.b / b.n] }));
    const dist = (a, c) => Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
    const centres = [];
    for (const b of list) { if (centres.length >= k) break; if (centres.every((c) => dist(c.rgb, b.rgb) >= 56)) centres.push({ rgb: b.rgb.slice(), n: 0, sum: [0, 0, 0] }); }
    for (const b of list) { let best = centres[0], bd = Infinity; for (const c of centres) { const d = dist(c.rgb, b.rgb); if (d < bd) { bd = d; best = c; } } best.n += b.n; for (let i = 0; i < 3; i++) best.sum[i] += b.rgb[i] * b.n; }
    const total = centres.reduce((s, c) => s + c.n, 0);
    // JPEG edges and anti-aliasing make a few stray in-between pixels; a shade covering under 1.5% of the picture is noise, not part of its palette
    return centres.filter((c) => c.n / total >= 0.015 || centres.length === 1).sort((a, b) => b.n - a.n).map((c) => ({ hex: toHex(c.sum[0] / c.n, c.sum[1] / c.n, c.sum[2] / c.n), pct: Math.round((c.n / total) * 100) }));
  }
  /** "#rrggbb" list as plain text for copying. */
  const paletteText = (pal) => pal.map((c) => c.hex.toUpperCase()).join("  ");

  return { DAY, esc, dateKey, startOfDay, mondayOf, budgetState, breakDue, sessionDays, fmtMoney, fmtDur, fmtBytes, endsIn, tempLevel, STATUSES, PLATFORMS, KINDS, nextStatus, weekPlan, pipeline, INCOME_STATUSES, incomeSummary, CHECKLISTS, LIMITS, countChars, hashtags, captionCheck, ruleHashtags, parseCaptions, captionPrompt, PINTEREST_2026, AESTHETICS, wikiSearch, textOn, extractPalette, paletteText, toHex };
});
