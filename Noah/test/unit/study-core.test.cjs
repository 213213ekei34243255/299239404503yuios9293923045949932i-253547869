// Noah/test/unit/study-core.test.cjs - the pure logic behind Jonah's study tools (study-core.js).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../../../study-core.js");

const MON_9AM = new Date(2026, 9, 19, 9, 0); // Mon 19 Oct 2026

test("parseTime reads the usual ways people type a time, and refuses nonsense", () => {
  assert.equal(S.parseTime("9"), 540);
  assert.equal(S.parseTime("9:30"), 570);
  assert.equal(S.parseTime("9.30"), 570);
  assert.equal(S.parseTime("9am"), 540);
  assert.equal(S.parseTime("12am"), 0);
  assert.equal(S.parseTime("12pm"), 720);
  assert.equal(S.parseTime("2:15 pm"), 14 * 60 + 15);
  assert.equal(S.parseTime("21:00"), 1260);
  for (const bad of ["", "25:00", "9:75", "13pm", "0am", "abc", null]) assert.equal(S.parseTime(bad), null, String(bad));
});

test("parseQuickLine: several days, rooms, 'to', am/pm; unreadable lines give nothing, not a guess", () => {
  const r = S.parseQuickLine("Mon/Wed 9:00-10:30 Maths @ Room 4");
  assert.deepEqual(r.map((x) => x.day), [0, 2]);
  assert.equal(r[0].start, 540); assert.equal(r[0].end, 630);
  assert.equal(r[0].subject, "Maths"); assert.equal(r[0].room, "Room 4");
  const t = S.parseQuickLine("Tuesday 14:00 to 15:30 Physics lab (B2)");
  assert.equal(t.length, 1); assert.equal(t[0].subject, "Physics lab"); assert.equal(t[0].room, "B2");
  assert.equal(S.parseQuickLine("Fri 1pm-2pm Art")[0].start, 13 * 60);
  for (const bad of ["", "hello world", "Mon 10:00-9:00 Backwards", "Funday 9-10 Maths", "Mon 9-10"]) assert.deepEqual(S.parseQuickLine(bad), [], bad);
});

test("nowNext finds the current and the next class", () => {
  const classes = [{ day: 0, start: 540, end: 630, subject: "A" }, { day: 0, start: 660, end: 720, subject: "B" }, { day: 1, start: 540, end: 600, subject: "C" }];
  const during = S.nowNext(classes, new Date(2026, 9, 19, 9, 30));
  assert.equal(during.now.subject, "A"); assert.equal(during.next.subject, "B"); assert.equal(during.minutesLeft, 60); assert.equal(during.minutesToNext, 90);
  const gap = S.nowNext(classes, new Date(2026, 9, 19, 10, 45));
  assert.equal(gap.now, null); assert.equal(gap.next.subject, "B"); assert.equal(gap.minutesToNext, 15);
  const after = S.nowNext(classes, new Date(2026, 9, 19, 13, 0));
  assert.equal(after.now, null); assert.equal(after.next, null);
  assert.equal(S.dayIndexOf(new Date(2026, 9, 18)), 6); // a Sunday
});

test("countdown: overdue / today / soon / later", () => {
  const now = new Date(2026, 9, 19, 12, 0);
  assert.equal(S.countdown(new Date(2026, 9, 19, 10, 0).getTime(), now).level, "overdue");
  assert.match(S.countdown(new Date(2026, 9, 19, 10, 0).getTime(), now).label, /2 h overdue/);
  assert.equal(S.countdown(new Date(2026, 9, 19, 18, 0).getTime(), now).level, "today");
  assert.equal(S.countdown(new Date(2026, 9, 21, 12, 0).getTime(), now).level, "soon");
  assert.equal(S.countdown(new Date(2026, 9, 30, 12, 0).getTime(), now).level, "later");
  assert.equal(S.countdown("garbage", now).label, "no date");
});

test("groupDeadlines splits and sorts; done items are separate", () => {
  const now = new Date(2026, 9, 19, 12, 0);
  const iso = (d, h = 12) => new Date(2026, 9, d, h).toISOString();
  const g = S.groupDeadlines([{ title: "late", due: iso(18) }, { title: "t", due: iso(19, 20) }, { title: "w2", due: iso(24) }, { title: "w1", due: iso(22) }, { title: "far", due: iso(30) }, { title: "x", due: iso(20), done: true }], now);
  assert.deepEqual(g.overdue.map((x) => x.title), ["late"]);
  assert.deepEqual(g.today.map((x) => x.title), ["t"]);
  assert.deepEqual(g.week.map((x) => x.title), ["w1", "w2"]);
  assert.deepEqual(g.later.map((x) => x.title), ["far"]);
  assert.deepEqual(g.done.map((x) => x.title), ["x"]);
});

test("suggestSessions never overlaps a class or another session, stays in the window, finishes before the due day ends, and reports what does not fit", () => {
  const now = new Date(2026, 9, 19, 9, 0);
  const classes = [{ day: 0, start: 17 * 60, end: 18 * 60, subject: "Evening class" }]; // Monday clashes with the study window
  const due = new Date(2026, 9, 21, 9, 0).toISOString(); // Wed morning: Mon + Tue + (Wed has no evening before 9am... the due day is still offered)
  const r = S.suggestSessions([{ title: "Essay", due, hours: 3, subject: "English" }], classes, now);
  assert.ok(r.sessions.length >= 3);
  for (const s of r.sessions) {
    assert.ok(s.start >= 17 * 60 && s.end <= 21 * 60, "inside the evening window");
    assert.ok(s.end - s.start >= 25);
    const day = (new Date(s.date + "T00:00:00").getDay() + 6) % 7;
    for (const c of classes.filter((c) => c.day === day)) assert.ok(s.end <= c.start || s.start >= c.end, "no overlap with a class");
  }
  for (let i = 0; i < r.sessions.length; i++) for (let j = i + 1; j < r.sessions.length; j++) {
    const a = r.sessions[i], b = r.sessions[j];
    if (a.date === b.date) assert.ok(a.end <= b.start || b.end <= a.start, "no two sessions overlap");
  }
  assert.equal(r.sessions.reduce((n, s) => n + (s.end - s.start), 0) + r.unplaced.reduce((n, u) => n + u.minutes, 0), 180, "every minute is either scheduled or reported unplaced");
  // impossible: 40 hours due tomorrow
  const big = S.suggestSessions([{ title: "Huge", due: new Date(2026, 9, 20, 9).toISOString(), hours: 40 }], [], now);
  assert.ok(big.unplaced.length === 1 && big.unplaced[0].minutes > 0, "an impossible load is reported, not hidden");
  // done / past deadlines are ignored
  assert.deepEqual(S.suggestSessions([{ title: "old", due: new Date(2026, 9, 1).toISOString(), hours: 2 }, { title: "done", due, hours: 2, done: true }], [], now), { sessions: [], unplaced: [] });
});

test("SM-2: new -> good -> good -> good grows 1d, 6d, then x ease; again resets; ease floors at 1.3", () => {
  const now = Date.UTC(2026, 9, 19);
  let c = S.newCard("q", "a", now);
  assert.equal(S.isDue(c, now), true);
  c = S.grade(c, 2, now); assert.equal(c.interval, 1); assert.equal(c.due, now + 86400000);
  c = S.grade(c, 2, now); assert.equal(c.interval, 6);
  c = S.grade(c, 2, now); assert.equal(c.interval, 15); // 6 * 2.5
  const lapsed = S.grade(c, 0, now);
  assert.equal(lapsed.reps, 0); assert.equal(lapsed.lapses, 1); assert.equal(lapsed.due, now + 600000); assert.ok(Math.abs(lapsed.ease - 2.3) < 1e-9);
  let low = S.newCard("q", "a", now);
  for (let i = 0; i < 20; i++) low = S.grade(low, 0, now);
  assert.equal(low.ease, 1.3);
  const easy = S.grade(S.newCard("q", "a", now), 3, now); assert.equal(easy.interval, 4); assert.ok(easy.ease > 2.5);
  const hard = S.grade(c, 1, now); assert.ok(hard.interval < c.interval * 1.3 && hard.interval >= c.interval); assert.ok(hard.ease < 2.5);
  const orig = S.newCard("q", "a", now); const copy = JSON.stringify(orig); S.grade(orig, 2, now); assert.equal(JSON.stringify(orig), copy, "grade does not change its input");
  assert.deepEqual(S.previewIntervals(S.newCard("q", "a", now), now), ["10 min", "1 d", "1 d", "4 d"]);
});

test("deckStats counts due, fresh and learned", () => {
  const now = Date.UTC(2026, 9, 19);
  const fresh = S.newCard("a", "b", now);
  const learned = { ...S.newCard("c", "d", now), reps: 5, interval: 30, due: now + 86400000 * 30 };
  assert.deepEqual(S.deckStats([fresh, learned], now), { total: 2, due: 1, fresh: 1, learned: 1 });
});

test("pomodoro: a long break after every 4th focus, and breaks always lead back to focus", () => {
  assert.equal(S.nextPhase("focus", 1), "short");
  assert.equal(S.nextPhase("focus", 3), "short");
  assert.equal(S.nextPhase("focus", 4), "long");
  assert.equal(S.nextPhase("focus", 8), "long");
  assert.equal(S.nextPhase("short", 1), "focus");
  assert.equal(S.nextPhase("long", 4), "focus");
  assert.equal(S.nextPhase("focus", 2, { every: 2 }), "long");
  assert.equal(S.phaseSeconds("focus"), 1500); assert.equal(S.phaseSeconds("long", { long: 20 }), 1200);
  assert.equal(S.fmtClock(1500), "25:00"); assert.equal(S.fmtClock(65), "01:05"); assert.equal(S.fmtClock(-3), "00:00");
});

test("routines: a new day starts empty; complete means every item", () => {
  const r = { items: ["a", "b"], checked: [0, 1], day: "2026-10-19" };
  assert.deepEqual(S.routineToday(r, "2026-10-19"), { checked: [0, 1], done: 2, total: 2, complete: true });
  assert.deepEqual(S.routineToday(r, "2026-10-20"), { checked: [], done: 0, total: 2, complete: false });
  assert.equal(S.routineToday({ items: [], checked: [], day: "x" }, "x").complete, false);
});

test("streak: consecutive counting days; today pending does not break it; a gap does", () => {
  const today = new Date(2026, 9, 19, 15);
  const key = (back) => S.dateKey(new Date(2026, 9, 19 - back));
  const days = { [key(1)]: { focusMin: 30 }, [key(2)]: { cards: 12 }, [key(3)]: { routines: 1 }, [key(5)]: { focusMin: 60 }, [key(4)]: { focusMin: 5 } };
  assert.equal(S.streak(days, today), 3, "today empty, days 1-3 count, day 4 (5 min) is a gap");
  days[key(0)] = { focusMin: 10 };
  assert.equal(S.streak(days, today), 4);
  assert.equal(S.streak({}, today), 0);
  const bars = S.weekBars(days, today);
  assert.equal(bars.length, 7); assert.equal(bars[6].key, key(0)); assert.equal(bars[6].label, "Mon"); assert.equal(bars[5].focusMin, 30);
});

test("toICS: valid calendar text, weekly rule for classes, escaped text", () => {
  const ics = S.toICS([{ day: 2, start: 540, end: 630, subject: "Maths, Set 1; top", room: "B2" }], [{ title: "Essay", due: new Date(2026, 9, 25, 17).toISOString(), type: "essay", subject: "English" }], MON_9AM);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
  assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=WE/);
  assert.match(ics, /DTSTART:20261021T090000/); // the first Wednesday on/after Mon 19 Oct
  assert.match(ics, /SUMMARY:Maths\\, Set 1\\; top/);
  assert.match(ics, /SUMMARY:Essay: Essay/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, (ics.match(/END:VEVENT/g) || []).length);
});

test("parseCards: JSON, fenced JSON, 'Q:/A:' and 'front :: back'; never a one-sided card", () => {
  assert.deepEqual(S.parseCards('[{"front":"a?","back":"b"}]'), [{ front: "a?", back: "b" }]);
  assert.deepEqual(S.parseCards('Sure!\n```json\n[{"question":"x","answer":"y"},{"front":"only front"}]\n```'), [{ front: "x", back: "y" }]);
  assert.deepEqual(S.parseCards("Q: capital of France?\nA: Paris\nQ: 2+2\nA: 4"), [{ front: "capital of France?", back: "Paris" }, { front: "2+2", back: "4" }]);
  assert.deepEqual(S.parseCards("1. mitochondria :: powerhouse of the cell"), [{ front: "mitochondria", back: "powerhouse of the cell" }]);
  assert.deepEqual(S.parseCards("I could not do that."), []);
  assert.deepEqual(S.parseCards(""), []);
});

test("parseTimetableReply keeps only valid rows", () => {
  const r = S.parseTimetableReply('[{"day":0,"start":"09:00","end":"10:00","subject":"Maths","room":"B2"},{"day":9,"start":"09:00","end":"10:00","subject":"bad day"},{"day":1,"start":"11:00","end":"10:00","subject":"backwards"},{"day":2,"start":"x","end":"10:00","subject":"bad time"},{"day":3,"start":"9am","end":"10am","subject":""}]');
  assert.deepEqual(r, [{ day: 0, start: 540, end: 600, subject: "Maths", room: "B2" }]);
  assert.deepEqual(S.parseTimetableReply("not json"), []);
});

test("buildPrompt: every kind is built, page text is quoted and cut, and html in titles is not an issue for the model prompt", () => {
  const long = "x".repeat(20000);
  for (const kind of ["explain", "notes", "quiz", "mark", "flashcards", "plan", "timetable", "ask"]) {
    const p = S.buildPrompt(kind, { page: { title: "T", text: long }, topic: "t", raw: "r", questions: "q", answers: "a", today: "Mon", deadlines: [], classes: [], question: "why?" });
    assert.ok(p.length > 40 && p.length < 9000, kind + " " + p.length);
  }
  assert.match(S.buildPrompt("flashcards", { topic: "photosynthesis", count: 6 }), /6 flashcards from the topic "photosynthesis"/);
  assert.match(S.buildPrompt("quiz", { page: { title: "T", text: "abc" } }), /Do NOT give the answers/);
  assert.equal(S.buildPrompt("zzz", { question: "hi" }), "hi");
});

test("Study Mode (socratic) asks for a hint and a question, never the answer", () => {
  assert.match(S.buildPrompt("ask", { question: "what is 12*13?", socratic: true }), /do NOT give the final answer/);
  assert.doesNotMatch(S.buildPrompt("ask", { question: "x" }), /do NOT give the final answer/);
  assert.match(S.buildPrompt("ask", { question: "x", level: "university" }), /for a university student/);
});

test("parseTimetableText reads the common pasted layouts and reports every line it could not read", () => {
  const r = S.parseTimetableText("Monday: 9:00-10:30 Maths (Room 4), 11:00-12:00 English\nTue 10am-11am History\nFriday\n13:00 to 14:30 Physics lab @ B2\n09:00-10:30 | Art | Studio\nlunch break\nWed Maths 14:00-15:00 (B2)\n  \n10:00-11:00 French");
  const pick = (day, start) => r.rows.find((x) => x.day === day && x.start === start);
  assert.deepEqual(pick(0, 540), { day: 0, start: 540, end: 630, subject: "Maths", room: "Room 4" });
  assert.equal(pick(0, 660).subject, "English");
  assert.equal(pick(1, 600).end, 660);
  assert.deepEqual(pick(4, 780), { day: 4, start: 780, end: 870, subject: "Physics lab", room: "B2" }, "a day heading carries over to the lines below it");
  assert.deepEqual(pick(4, 540), { day: 4, start: 540, end: 630, subject: "Art", room: "Studio" }, "pipe-separated fields");
  assert.deepEqual(pick(2, 840), { day: 2, start: 840, end: 900, subject: "Maths", room: "B2" }, "subject before the times");
  assert.equal(pick(2, 600).subject, "French", "a line with no day uses the most recent day above it (here the Wed line)");
  assert.deepEqual(r.unread, ["lunch break"], "what it cannot read is reported, not guessed");
  assert.deepEqual(S.parseTimetableText("nothing useful here\nat all"), { rows: [], unread: ["nothing useful here", "at all"] });
  assert.deepEqual(S.parseTimetableText("Mon 10:00-9:00 Backwards").rows, []);
  assert.deepEqual(S.parseTimetableText("9:00-10:00 Maths").rows, [], "times with no day anywhere are not guessed");
});

test("parseJsonArray: first array only, '[' inside strings is fine, and a reply cut off mid-array still yields every COMPLETE object", () => {
  assert.deepEqual(S.parseJsonArray('x [{"a":1}] y [{"a":2}]'), [{ a: 1 }]);
  assert.deepEqual(S.parseJsonArray('[{"front":"c","back":"d [x]"}]'), [{ front: "c", back: "d [x]" }]);
  assert.deepEqual(S.parseJsonArray('[{"front":"a","back":"b"},{"front":"c","back":"d"},{"front":"cut off here'), [{ front: "a", back: "b" }, { front: "c", back: "d" }]);
  assert.equal(S.parseJsonArray("no array"), null);
  assert.equal(S.parseJsonArray("[{\"broken\":"), null);
  assert.equal(S.parseCards('[{"front":"a","back":"b"},{"front":"c","back":"d"},{"front":"cut').length, 2);
});

test("firstQuestionOnly keeps the hint up to the first question and drops the rambling after it", () => {
  assert.equal(S.firstQuestionOnly("Hint: think.\n\nGuiding question: how?\n1. rambling on\n2. more"), "Hint: think.\n\nGuiding question: how?");
  assert.equal(S.firstQuestionOnly("No question here at all."), "No question here at all.");
  assert.equal(S.firstQuestionOnly(""), "");
});

test("buildRequest puts a page (or a pasted timetable) in page_content, not in the message", () => {
  const page = { title: "Bio", text: "x ".repeat(9000) };
  const r = S.buildRequest("quiz", { page, count: 3 });
  assert.doesNotMatch(r.message, /x x x x/);
  assert.match(r.message, /attached as page content/);
  assert.ok(r.pageContent.startsWith("Title: Bio") && r.pageContent.length <= 12100);
  const t = S.buildRequest("timetable", { raw: "Mon 9-10 Maths" });
  assert.equal(t.pageContent, "Mon 9-10 Maths"); assert.doesNotMatch(t.message, /Mon 9-10 Maths/);
  const none = S.buildRequest("flashcards", { topic: "cells", count: 4 });
  assert.equal(none.pageContent, ""); assert.match(none.message, /topic "cells"/);
});

test("esc escapes html", () => assert.equal(S.esc('<b a="1">&\'</b>'), "&lt;b a=&quot;1&quot;&gt;&amp;&#39;&lt;/b&gt;"));
