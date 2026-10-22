// study-core.js - the PURE logic behind Jonah's study tools (timetable, deadlines, focus timer, flashcards, routines, stats, AI helpers).
// No DOM, no storage, no network: everything takes its inputs (and "now") as arguments, so it is unit-tested in Node (Noah/test/unit/study-core.test.cjs)
// and used by the app in the page (window.StudyCore). Days are numbered 0 = Monday ... 6 = Sunday. Times are minutes since midnight.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.StudyCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const dayIndexOf = (date) => (date.getDay() + 6) % 7; // JS Sunday=0 -> our Monday=0
  const dateKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

  // ------------------------------------------------------------------ time

  /** "9", "9:30", "9.30", "9am", "9:30 pm", "21:00" -> minutes since midnight, or null. */
  function parseTime(text) {
    const m = /^\s*(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*$/i.exec(String(text || ""));
    if (!m) return null;
    let h = Number(m[1]);
    const mi = m[2] ? Number(m[2]) : 0;
    const ap = m[3] ? m[3].toLowerCase()[0] : "";
    if (mi > 59) return null;
    if (ap) { if (h < 1 || h > 12) return null; if (ap === "p" && h !== 12) h += 12; if (ap === "a" && h === 12) h = 0; }
    if (h > 23) return null;
    return h * 60 + mi;
  }
  const fmtTime = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
  const fmtDuration = (min) => { const m = Math.max(0, Math.round(min)); return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`; };
  const fmtClock = (sec) => { const s = Math.max(0, Math.round(sec)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };

  const DAY_WORDS = { mon: 0, monday: 0, tue: 1, tues: 1, tuesday: 1, wed: 2, weds: 2, wednesday: 2, thu: 3, thur: 3, thurs: 3, thursday: 3, fri: 4, friday: 4, sat: 5, saturday: 5, sun: 6, sunday: 6 };

  const TIME = String.raw`\d{1,2}(?:[:.h]\d{2})?\s*(?:am|pm)?`;
  const RANGE = String.raw`(${TIME})\s*(?:-|–|—|to|until|till)\s*(${TIME})`;
  const DAYS_RE = String.raw`(?:${Object.keys(DAY_WORDS).sort((a, b) => b.length - a.length).join("|")})`;
  const DAY_LEAD = new RegExp(String.raw`^\s*(${DAYS_RE}(?:\s*[,/&+-]\s*${DAYS_RE}|\s+and\s+${DAYS_RE})*)\b\s*[:\-–—]?\s*(.*)$`, "i");
  const dayIndexes = (txt) => [...new Set((String(txt).toLowerCase().match(new RegExp(DAYS_RE, "g")) || []).map((w) => DAY_WORDS[w]))];

  /** "9:00-10:30 Maths @ Room 4", "Maths 9:00-10:30 (B2)", "9:00-10:30 | Maths | Room 4" for the given days -> entries, or null when it cannot be read. */
  function parseSegment(days, segment) {
    let text = String(segment || "").trim();
    if (!text) return null;
    if (text.includes("|")) { const f = text.split("|").map((x) => x.trim()).filter(Boolean); if (f.length >= 2) text = `${f[0]} ${f[1]}${f[2] ? " @ " + f[2] : ""}`; }
    let m = new RegExp(String.raw`^${RANGE}\s*[:\-–—]?\s*(.+)$`, "i").exec(text), t1, t2, rest;
    if (m) { t1 = m[1]; t2 = m[2]; rest = m[3]; } else { m = new RegExp(String.raw`^(.+?)\s+${RANGE}\s*(\(.*\)|@.*)?$`, "i").exec(text); if (!m) return null; rest = m[1] + (m[4] ? " " + m[4] : ""); t1 = m[2]; t2 = m[3]; }
    const start = parseTime(t1), end = parseTime(t2);
    if (start === null || end === null || end <= start) return null;
    rest = rest.trim();
    let room = "";
    const at = /\s(?:@|at|in)\s+(.+)$/i.exec(rest) || /\(([^)]+)\)\s*$/.exec(rest);
    if (at) { room = at[1].trim(); rest = rest.slice(0, at.index).trim(); }
    rest = rest.replace(/^[-–—:,\s]+|[-–—:,\s]+$/g, "");
    if (!rest || !days.length) return null;
    return days.map((day) => ({ day, start, end, subject: rest.slice(0, 80), room: room.slice(0, 40) }));
  }
  /**
   * A pasted timetable (any number of lines) -> { rows, unread }. Understands "Mon/Wed 9:00-10:30 Maths @ Room 4", "Monday: 9-10 Maths, 11-12 English",
   * a day on its own line followed by lines of times, and "9:00-10:30 | Maths | Room 4". Every line it cannot read goes to `unread` - nothing is guessed.
   */
  function parseTimetableText(raw) {
    const rows = [], unread = [];
    let current = [];
    for (const lineRaw of String(raw || "").split(/\r?\n/)) {
      const line = lineRaw.trim();
      if (!line) continue;
      let days = current, body = line;
      const lead = DAY_LEAD.exec(line);
      if (lead) { days = dayIndexes(lead[1]); body = lead[2].trim(); if (!body) { current = days; continue; } current = days; }
      const segments = body.includes("|") && !/[;]/.test(body) ? [body] : body.split(/\s*;\s*|,\s*(?=\d)/);
      const got = segments.map((sg) => parseSegment(days, sg));
      if (got.every((g) => g)) rows.push(...got.flat()); else unread.push(line);
    }
    return { rows, unread };
  }
  /** One typed line -> entries ([] when it cannot be read - never a half-guess). A day is required in the line itself. */
  function parseQuickLine(line) {
    const t = String(line || "").trim();
    if (!t || t.includes("\n") || !DAY_LEAD.test(t)) return [];
    return parseTimetableText(t).rows;
  }

  const classesOn = (classes, day) => (classes || []).filter((c) => c.day === day).sort((a, b) => a.start - b.start);

  /** What is on now and what is next today: { now: class|null, next: class|null, minutesToNext, minutesLeft }. */
  function nowNext(classes, date) {
    const day = dayIndexOf(date);
    const mins = date.getHours() * 60 + date.getMinutes();
    const today = classesOn(classes, day);
    const now = today.find((c) => c.start <= mins && mins < c.end) || null;
    const next = today.find((c) => c.start > mins) || null;
    return { now, next, minutesLeft: now ? now.end - mins : null, minutesToNext: next ? next.start - mins : null };
  }

  // ------------------------------------------------------------------ deadlines

  /** { label, level: overdue | today | soon | later, ms } for a due date (ms or ISO) seen from `now`. */
  function countdown(due, now) {
    const dueMs = typeof due === "number" ? due : Date.parse(due);
    const nowMs = now instanceof Date ? now.getTime() : now;
    if (!Number.isFinite(dueMs)) return { label: "no date", level: "later", ms: Infinity };
    const ms = dueMs - nowMs;
    const abs = Math.abs(ms);
    const span = abs < HOUR ? `${Math.max(1, Math.round(abs / MIN))} min` : abs < DAY ? `${Math.round(abs / HOUR)} h` : `${Math.round(abs / DAY)} day${Math.round(abs / DAY) === 1 ? "" : "s"}`;
    if (ms < 0) return { label: `${span} overdue`, level: "overdue", ms };
    const sameDay = dateKey(new Date(dueMs)) === dateKey(new Date(nowMs));
    if (sameDay) return { label: `due in ${span}`, level: "today", ms };
    return { label: `due in ${span}`, level: ms < 3 * DAY ? "soon" : "later", ms };
  }

  /** Open items grouped for display: overdue, today, this week, later, plus done. Each group sorted by due date. */
  function groupDeadlines(items, now) {
    const nowMs = now instanceof Date ? now.getTime() : now;
    const groups = { overdue: [], today: [], week: [], later: [], done: [] };
    for (const it of items || []) {
      if (it.done) { groups.done.push(it); continue; }
      const c = countdown(it.due, nowMs);
      if (c.level === "overdue") groups.overdue.push(it);
      else if (c.level === "today") groups.today.push(it);
      else if (c.ms < 7 * DAY) groups.week.push(it);
      else groups.later.push(it);
    }
    for (const k of Object.keys(groups)) groups[k].sort((a, b) => Date.parse(a.due) - Date.parse(b.due) || (b.priority || 0) - (a.priority || 0));
    return groups;
  }

  /**
   * A feasible study plan: for each open deadline (soonest first) spread its estimated hours over the days left before it, in the free part of the evening window
   * (default 17:00-21:00) that does not overlap a class. Sessions are `session` minutes with `breakMin` between. Returns
   * { sessions: [{ date: "YYYY-MM-DD", start, end, title, subject }], unplaced: [{ title, minutes }] } - "unplaced" is the honest part: not everything fits.
   */
  function suggestSessions(deadlines, classes, now, opts) {
    const o = { windowStart: 17 * 60, windowEnd: 21 * 60, session: 50, breakMin: 10, maxDays: 14, ...(opts || {}) };
    const today = startOfDay(now);
    const open = (deadlines || []).filter((d) => !d.done && Date.parse(d.due) > now.getTime()).sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
    const busy = {}; // dateKey -> [[start,end]]
    const sessions = [];
    const unplaced = [];
    const freeSlots = (date) => {
      const key = dateKey(date);
      const blocks = classesOn(classes, dayIndexOf(date)).map((c) => [c.start, c.end]).concat(busy[key] || []).sort((a, b) => a[0] - b[0]);
      let cursor = o.windowStart;
      if (dateKey(date) === dateKey(now)) cursor = Math.max(cursor, Math.ceil((now.getHours() * 60 + now.getMinutes() + 15) / 5) * 5);
      const free = [];
      for (const [s, e] of blocks) { if (s > cursor) free.push([cursor, Math.min(s, o.windowEnd)]); cursor = Math.max(cursor, e); }
      if (cursor < o.windowEnd) free.push([cursor, o.windowEnd]);
      return free.filter(([s, e]) => e - s >= 25);
    };
    for (const d of open) {
      let need = Math.round((Number(d.hours) || 2) * 60);
      const dueDay = startOfDay(new Date(d.due));
      const lastDay = new Date(Math.min(dueDay.getTime(), today.getTime() + o.maxDays * DAY)); // study up to the due day itself
      const days = [];
      for (let t = today.getTime(); t <= lastDay.getTime(); t += DAY) days.push(new Date(t));
      let progress = true;
      while (need > 0 && progress) { // round-robin over the days so the work is spread, not crammed
        progress = false;
        for (const date of days) {
          if (need <= 0) break;
          const slot = freeSlots(date)[0];
          if (!slot) continue;
          const len = Math.min(o.session, need, slot[1] - slot[0]);
          if (len < 25 && need > len) continue;
          const key = dateKey(date);
          const s = { date: key, start: slot[0], end: slot[0] + len, title: d.title, subject: d.subject || "" };
          sessions.push(s);
          (busy[key] = busy[key] || []).push([slot[0], slot[0] + len + o.breakMin]);
          need -= len;
          progress = true;
        }
      }
      if (need > 0) unplaced.push({ title: d.title, minutes: need });
    }
    sessions.sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
    return { sessions, unplaced };
  }

  // ------------------------------------------------------------------ spaced repetition (Anki-style SM-2)

  const newCard = (front, back, now) => ({ id: "c" + Math.random().toString(36).slice(2, 9), front: String(front).slice(0, 600), back: String(back).slice(0, 1200), ease: 2.5, interval: 0, reps: 0, lapses: 0, due: now instanceof Date ? now.getTime() : now || Date.now() });
  const isDue = (card, now) => card.due <= (now instanceof Date ? now.getTime() : now);

  /**
   * Grade a card: 0 again, 1 hard, 2 good, 3 easy. SM-2 as Anki adapted it: "again" resets the card (due again in 10 minutes, ease falls); first good review is 1 day, the second
   * 6 days, then interval x ease; "hard" grows the interval only 1.2x and lowers ease; "easy" grows it 1.3x extra, raises ease, and starts at 4 days. Ease never drops below 1.3.
   * Returns a NEW card (the input is not changed).
   */
  function grade(card, g, now) {
    const nowMs = now instanceof Date ? now.getTime() : now;
    const c = { ...card };
    if (g === 0) { c.lapses = (c.lapses || 0) + 1; c.reps = 0; c.interval = 0; c.ease = Math.max(1.3, c.ease - 0.2); c.due = nowMs + 10 * MIN; return c; }
    if (g === 1) { c.interval = c.reps === 0 ? 1 : Math.max(1, Math.round(c.interval * 1.2)); c.ease = Math.max(1.3, c.ease - 0.15); }
    else if (g === 2) c.interval = c.reps === 0 ? 1 : c.reps === 1 ? 6 : Math.max(1, Math.round(c.interval * c.ease));
    else { c.interval = c.reps === 0 ? 4 : Math.max(1, Math.round(c.interval * c.ease * 1.3)); c.ease = c.ease + 0.15; }
    c.reps += 1;
    c.due = nowMs + c.interval * DAY;
    return c;
  }
  const fmtInterval = (days, isAgain) => (isAgain ? "10 min" : days < 1 ? "<1 d" : days < 30 ? `${days} d` : days < 365 ? `${Math.round(days / 30)} mo` : `${(days / 365).toFixed(1)} y`);
  /** The label each of the four answer buttons would give: ["10 min", "1 d", "1 d", "4 d"]. */
  const previewIntervals = (card, now) => [0, 1, 2, 3].map((g) => { const n = grade(card, g, now); return fmtInterval(n.interval, g === 0); });
  function deckStats(cards, now) {
    const nowMs = now instanceof Date ? now.getTime() : now;
    const s = { total: cards.length, due: 0, fresh: 0, learned: 0 };
    for (const c of cards) { if (c.reps === 0 && c.lapses === 0) s.fresh++; else if (c.interval >= 21) s.learned++; if (c.due <= nowMs) s.due++; }
    return s;
  }

  // ------------------------------------------------------------------ focus timer

  const DEFAULT_TIMER = { focus: 25, short: 5, long: 15, every: 4 };
  /** After `phase` ends: the next phase. `doneFocus` counts the focus sessions finished INCLUDING the one that just ended. */
  function nextPhase(phase, doneFocus, cfg) {
    const c = { ...DEFAULT_TIMER, ...(cfg || {}) };
    if (phase !== "focus") return "focus";
    return doneFocus > 0 && doneFocus % c.every === 0 ? "long" : "short";
  }
  const phaseSeconds = (phase, cfg) => ({ ...DEFAULT_TIMER, ...(cfg || {}) }[phase] || 25) * 60;

  // ------------------------------------------------------------------ routines

  const ROUTINE_TEMPLATES = {
    "Morning start": ["Water + stretch (5 min)", "Look at today's timetable", "Pick the ONE most important task", "Phone away for the first focus block"],
    "Deep work block": ["Close extra tabs", "Write the goal of this session in one line", "50 min focus, no switching", "5 min break: stand up, no screen", "Write down what you finished"],
    "Exam week": ["Past-paper question (timed)", "Review mistakes from yesterday", "Flashcards due today", "Explain one topic out loud without notes", "Sleep before midnight"],
    "Wind down": ["Plan tomorrow's three tasks", "Pack bag / charge laptop", "Screens off 30 min before bed"],
  };
  /** Done-state for today: a routine keeps `checked` (item indexes) with the `day` they belong to; a new day starts empty. */
  function routineToday(routine, todayKey) {
    const checked = routine.day === todayKey ? routine.checked || [] : [];
    return { checked, done: checked.length, total: routine.items.length, complete: routine.items.length > 0 && checked.length >= routine.items.length };
  }

  // ------------------------------------------------------------------ stats

  /** days: { "YYYY-MM-DD": { focusMin, cards, routines } }. A day counts for the streak when it has >= 10 focus minutes, >= 10 cards, or a finished routine. */
  const dayCounts = (d) => !!d && ((d.focusMin || 0) >= 10 || (d.cards || 0) >= 10 || (d.routines || 0) >= 1);
  function streak(days, today) {
    let n = 0;
    let t = startOfDay(today).getTime();
    if (!dayCounts(days[dateKey(new Date(t))])) t -= DAY; // today not done yet: the streak is still alive until the day ends
    for (;;) { if (!dayCounts(days[dateKey(new Date(t))])) break; n++; t -= DAY; }
    return n;
  }
  function weekBars(days, today) {
    const out = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(startOfDay(today).getTime() - i * DAY); const k = dateKey(d); out.push({ key: k, label: DAY_SHORT[dayIndexOf(d)], focusMin: (days[k] && days[k].focusMin) || 0 }); }
    return out;
  }

  // ------------------------------------------------------------------ export (.ics)

  const icsEsc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const icsStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  /** A calendar file other apps open: weekly repeating classes + one-off deadlines. */
  function toICS(classes, deadlines, now) {
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Jonah//Study//EN", "CALSCALE:GREGORIAN"];
    const BY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
    const stamp = icsStamp(now);
    (classes || []).forEach((c, i) => {
      const first = new Date(startOfDay(now).getTime() + ((c.day - dayIndexOf(now) + 7) % 7) * DAY);
      const s = new Date(first.getFullYear(), first.getMonth(), first.getDate(), Math.floor(c.start / 60), c.start % 60);
      const e = new Date(first.getFullYear(), first.getMonth(), first.getDate(), Math.floor(c.end / 60), c.end % 60);
      lines.push("BEGIN:VEVENT", `UID:class-${i}-${c.day}-${c.start}@jonah`, `DTSTAMP:${stamp}`, `DTSTART:${icsStamp(s)}`, `DTEND:${icsStamp(e)}`, `RRULE:FREQ=WEEKLY;BYDAY=${BY[c.day]}`, `SUMMARY:${icsEsc(c.subject)}`, ...(c.room ? [`LOCATION:${icsEsc(c.room)}`] : []), "END:VEVENT");
    });
    (deadlines || []).forEach((d, i) => {
      const due = new Date(Date.parse(d.due));
      if (Number.isNaN(due.getTime())) return;
      lines.push("BEGIN:VEVENT", `UID:due-${i}-${due.getTime()}@jonah`, `DTSTAMP:${stamp}`, `DTSTART:${icsStamp(new Date(due.getTime() - 30 * MIN))}`, `DTEND:${icsStamp(due)}`, `SUMMARY:${icsEsc((d.type ? d.type[0].toUpperCase() + d.type.slice(1) + ": " : "") + d.title)}`, `DESCRIPTION:${icsEsc(d.subject || "")}`, "END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    return lines.join("\r\n") + "\r\n";
  }

  // ------------------------------------------------------------------ AI helpers (prompts out, answers parsed back - the model call itself is in the app)

  const clipText = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + " [...cut]" : t; };
  /** A prompt for the chat model. `ctx`: { page: { title, url, text }, topic, level, count, deadlines, classes, question, raw } */
  function buildPrompt(kind, ctx) {
    const c = ctx || {};
    // `pageSeparate`: the material travels in the chat server's own page_content field (see buildRequest), so the message only points at it
    const page = c.page ? (c.pageSeparate ? `Page title: ${clipText(c.page.title, 200)}\n(The page text is attached as page content.)` : `Page title: ${c.page.title || ""}\nPage text:\n"""\n${clipText(c.page.text, 6000)}\n"""`) : "";
    switch (kind) {
      case "explain": return `You are a patient tutor. Explain the key ideas of this page simply, for a ${c.level || "high-school"} student. Use short paragraphs and one everyday example. Do not invent facts that are not on the page.\n\n${page}`;
      case "notes": return `Turn this page into concise study notes: a one-line summary, then 6-10 bullet points of the most examinable facts, then 3 terms with one-line definitions. Only use what is on the page.\n\n${page}`;
      case "quiz": return `Write ${c.count || 5} quiz questions that test understanding of this page (mix recall and "why"). Number them. Do NOT give the answers yet; end with the line "Reply with your answers and I will mark them."\n\n${page}`;
      case "mark": return `You asked the student these questions:\n${clipText(c.questions, 3000)}\n\nThe student answered:\n${clipText(c.answers, 3000)}\n\nMark each answer (correct / partly / wrong) with one sentence of feedback, and say what to revise. Be encouraging and honest.`;
      case "flashcards": return `Make ${c.count || 8} flashcards from ${c.page ? "this page" : `the topic "${clipText(c.topic, 200)}"`}. Reply with ONLY a JSON array, no other text, like [{"front":"question","back":"short answer"}]. Questions must be answerable from memory, answers under 25 words.\n\n${page}`;
      case "plan": return `You are a study coach. Today is ${c.today}. Here are the student's deadlines (JSON): ${JSON.stringify(c.deadlines || [])}. Weekly classes (JSON, day 0=Mon): ${JSON.stringify(c.classes || [])}. Write a realistic week plan: which topic to study when, with short sessions and breaks, hardest things first, and one rest evening. If it cannot all fit, say what to drop or ask for an extension. Keep it under 250 words.`;
      case "timetable": return `Read the pasted timetable${c.pageSeparate ? " (attached as page content)" : ""} and reply with ONLY one JSON array like [{"day":0,"start":"09:00","end":"10:00","subject":"Maths","room":"B2"}] where day 0=Monday ... 6=Sunday and times are 24-hour. One object per class. Skip anything you cannot read. Do not repeat the array.${c.pageSeparate ? "" : `\n\n"""\n${clipText(c.raw, 6000)}\n"""`}`;
      case "ask": return c.socratic
        ? `${c.page ? page + "\n\n" : ""}Student question: ${clipText(c.question, 1500)}\n\nSTUDY MODE: do NOT give the final answer or do the work for the student. Give one small hint that moves them forward, then ask ONE guiding question. If they already attempted it, say what is right about it first. Keep it under 90 words.`
        : `${c.page ? page + "\n\n" : ""}Student question: ${clipText(c.question, 1500)}\n\nAnswer as a tutor${c.level ? " for a " + c.level + " student" : ""}: explain the idea step by step and ask one short check-for-understanding question at the end.`;
      default: return String(c.question || "");
    }
  }
  /** What to send to the chat server: { message, pageContent }. A page (or a pasted timetable) goes in page_content - the field the server treats as "material the caller brought" - never inside the message. */
  function buildRequest(kind, ctx) {
    const c = ctx || {};
    if (c.page) return { message: buildPrompt(kind, { ...c, pageSeparate: true }), pageContent: `Title: ${clipText(c.page.title, 200)}\n\n${String(c.page.text || "").replace(/\s+/g, " ").trim().slice(0, 12000)}` };
    if (kind === "timetable") return { message: buildPrompt(kind, { ...c, pageSeparate: true }), pageContent: String(c.raw || "").trim().slice(0, 12000) };
    return { message: buildPrompt(kind, c), pageContent: "" };
  }
  const stripFences = (t) => String(t || "").replace(/```(?:json)?/gi, "").trim();
  function parseJsonArray(text) {
    const t = stripFences(text);
    const a = t.indexOf("[");
    if (a < 0) return null;
    // walk to the matching "]" (strings respected); a reply that was cut off before it still yields every COMPLETE object it contained
    let depth = 0, inStr = false, esc2 = false, end = -1;
    const objs = [];
    let objStart = -1, objDepth = 0;
    for (let i = a; i < t.length; i++) {
      const ch = t[i];
      if (inStr) { if (esc2) esc2 = false; else if (ch === "\\") esc2 = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "[") depth++;
      else if (ch === "]") { depth--; if (depth === 0) { end = i; break; } }
      else if (ch === "{") { if (objDepth === 0) objStart = i; objDepth++; }
      else if (ch === "}") { objDepth--; if (objDepth === 0 && objStart >= 0) { objs.push(t.slice(objStart, i + 1)); objStart = -1; } }
    }
    if (end > 0) { try { const v = JSON.parse(t.slice(a, end + 1)); if (Array.isArray(v)) return v; } catch (_) { /* fall through to salvage */ } }
    const out = [];
    for (const o of objs) { try { out.push(JSON.parse(o)); } catch (_) { /* skip a broken object */ } }
    return out.length ? out : null;
  }
  /** Study Mode asks for ONE hint and ONE question; the small model keeps going. Keep up to and including the first line that asks something. */
  function firstQuestionOnly(text) {
    const lines = String(text || "").trim().split(/\r?\n/);
    const at = lines.findIndex((l) => /\?\s*$/.test(l.trim()));
    return at >= 0 ? lines.slice(0, at + 1).join("\n").trim() : String(text || "").trim();
  }
  /** Flashcards out of a model reply: a JSON array when it obeyed, else "Q: .. A: .." / "front :: back" lines. Never returns a card without both sides. */
  function parseCards(text) {
    const json = parseJsonArray(text);
    let cards = [];
    if (json) cards = json.map((x) => ({ front: String((x && (x.front || x.q || x.question)) || "").trim(), back: String((x && (x.back || x.a || x.answer)) || "").trim() }));
    else {
      const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const same = /^(?:[-*\d.)\s]*)(.+?)\s*(?:::|=>|\|)\s*(.+)$/.exec(lines[i]);
        const q = /^(?:[-*\d.)\s]*)(?:q|question)\s*[:.-]\s*(.+)$/i.exec(lines[i]);
        const a = lines[i + 1] && /^(?:[-*\s]*)(?:a|answer)\s*[:.-]\s*(.+)$/i.exec(lines[i + 1]);
        if (q && a) { cards.push({ front: q[1].trim(), back: a[1].trim() }); i++; } else if (same) cards.push({ front: same[1].trim(), back: same[2].trim() });
      }
    }
    return cards.filter((c) => c.front && c.back);
  }
  /** Timetable entries out of a model reply (JSON array). Anything with an unreadable day or time is dropped. */
  function parseTimetableReply(text) {
    const arr = parseJsonArray(text) || [];
    const out = [];
    for (const x of arr) {
      const day = Number(x && x.day);
      const start = parseTime(x && x.start), end = parseTime(x && x.end);
      const subject = String((x && x.subject) || "").trim();
      if (Number.isInteger(day) && day >= 0 && day <= 6 && start !== null && end !== null && end > start && subject) out.push({ day, start, end, subject: subject.slice(0, 80), room: String((x && x.room) || "").slice(0, 40) });
    }
    return out;
  }

  return { DAY_NAMES, DAY_SHORT, ROUTINE_TEMPLATES, DEFAULT_TIMER, esc, dateKey, dayIndexOf, startOfDay, parseTime, fmtTime, fmtDuration, fmtClock, parseQuickLine, parseTimetableText, classesOn, nowNext, countdown, groupDeadlines, suggestSessions, newCard, isDue, grade, previewIntervals, fmtInterval, deckStats, nextPhase, phaseSeconds, routineToday, dayCounts, streak, weekBars, toICS, buildPrompt, buildRequest, parseJsonArray, firstQuestionOnly, parseCards, parseTimetableReply };
});
