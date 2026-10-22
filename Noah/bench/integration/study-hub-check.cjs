// Noah/bench/integration/study-hub-check.cjs
//
// End-to-end check with the REAL Jonah window: the Study Hub (Today / Timetable / Deadlines / Focus / Cards / Routines / AI Tutor), driven exactly as a user would:
// real clicks and typed values on the real DOM, data saved to the real localStorage, the real focus-timer, the real preload bridge.
//
// The chat MODEL itself is replaced by a canned reply for the AI features (window.study.ask is stubbed in the page) - this proves the screen, the parsing and
// the saving, NOT that the live model answers well. The real "study:ask" main-process handler is checked separately at the end (it is called for real; with billing
// forced off, what comes back is whatever the live chat server returns, and the check says so).
//
//   node Noah/bench/integration/study-hub-check.cjs
//
// Needs ports 5588/5589 free: it skips itself if the real Jonah is open.
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const IS_ELECTRON = Boolean(process.versions.electron);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 150) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.once("listening", () => s.close(() => resolve(true))); s.listen(port, "127.0.0.1"); });

async function runner() {
  const { app, BrowserWindow } = require("electron");
  let failures = 0;
  const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };

  if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "jonah-sh-")));
  app.setAppPath(ROOT);
  require(path.join(ROOT, "main.cjs"));
  const win = await until(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html")), 30000, 300);
  check("the real browser window opens", !!win);
  if (!win) { console.log("RESULT study-hub FAILED (no window)"); return app.exit(1); }
  await sleep(3000);

  const call = (js) => win.webContents.executeJavaScript(js, true);
  const click = (sel) => call(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const setVal = (sel, v) => call(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  const text = (sel) => call(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ""`);
  const tab = async (name) => { await click(`.sh-tab[data-v="${name}"]`); await sleep(120); };
  const saved = () => call(`JSON.parse(localStorage.getItem("jonahStudy") || "{}")`);

  await call(`localStorage.removeItem("jonahStudy"); StudyHub.reset();`);

  // ---- the menu entries and the hub opening
  await call(`document.getElementById("toolsMenuBtn").click()`); await sleep(150);
  const labels = await call(`[...document.querySelectorAll(".tools-menu-item")].map(e => e.textContent.trim())`);
  check("the book menu has Study Hub, Focus Timer, Flashcards and AI Tutor", ["Study Hub", "Focus Timer", "Flashcards", "AI Tutor"].every((l) => labels.some((x) => x.includes(l))), JSON.stringify(labels));
  await call(`[...document.querySelectorAll(".tools-menu-item")].find(e => e.textContent.includes("Study Hub")).click()`); await sleep(300);
  check("Study Hub opens on the Today tab", (await call(`!!document.getElementById("jonah-tool-study")`)) && /Today/.test(await text(".sh-tab.active")));
  check("all seven tabs are there", (await call(`document.querySelectorAll(".sh-tab").length`)) === 7);
  const geo = await call(`(() => { const r = document.getElementById("jonah-tool-study").getBoundingClientRect(); return { w: Math.round(r.width), l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), iw: innerWidth, ih: innerHeight }; })()`);
  check("it is the wide panel and fits the window", geo.w >= 600 && geo.r <= geo.iw + 1 && geo.l >= 0 && geo.b <= geo.ih + 1, JSON.stringify(geo));
  check("Today with nothing set up says so, honestly", /No timetable yet/.test(await text("#shBody")) && /Nothing due/.test(await text("#shBody")));

  // ---- timetable: quick line, live preview, form, delete
  await tab("timetable");
  await setVal("#ttQuick", "Mon/Wed 9:00-10:30 Maths @ Room 4");
  check("typing a quick line shows a live preview", /Mon 09:00.10:30, Wed 09:00.10:30/.test(await text("#ttQuickMsg")), await text("#ttQuickMsg"));
  await click('[data-act="ttQuickAdd"]'); await sleep(150);
  check("quick add makes two classes (Mon and Wed)", (await saved()).classes.length === 2);
  await setVal("#ttQuick", "gibberish here");
  await click('[data-act="ttQuickAdd"]'); await sleep(100);
  check("a line it cannot read adds nothing and says so", (await saved()).classes.length === 2 && /Could not read/.test(await text("#ttQuickMsg")));
  await call(`document.querySelector('.ttDay[value="4"]').click()`);
  await setVal("#ttStart", "13:00"); await setVal("#ttEnd", "14:30"); await setVal("#ttSubj", "Physics <b>lab</b>"); await setVal("#ttRoom", "B2");
  await click('[data-act="ttAdd"]'); await sleep(150);
  const s1 = await saved();
  check("the form adds a Friday 13:00-14:30 class", s1.classes.length === 3 && s1.classes[2].day === 4 && s1.classes[2].start === 780 && s1.classes[2].end === 870 && s1.classes[2].room === "B2");
  check("the weekly grid draws one block per class, and html in a subject is shown as text, not run", (await call(`document.querySelectorAll(".sh-tt .blk").length`)) === 3 && (await call(`!document.querySelector(".sh-tt .blk b")`)));
  await click('[data-act="delClass"][data-id="2"]'); await sleep(120);
  check("deleting a class removes it", (await saved()).classes.length === 2);

  // ---- pasted timetable: read by rules first (no model call), unreadable lines reported, AI only as a labelled fallback
  await call(`StudyHub.hub.askOverride = async (p, pc) => { window.__lastPrompt = p; window.__lastPage = pc; return { success: true, text: window.__reply }; }; window.__reply = ${JSON.stringify('Here you go:\n[{"day":1,"start":"10:00","end":"11:00","subject":"Chemistry club","room":"L1"},{"day":9,"start":"10:00","end":"11:00","subject":"nonsense day"},{"day":2,"start":"x","end":"11:00","subject":"bad time"}]')}; window.__lastPrompt = ""; 0`);
  await setVal("#ttPaste", "Tuesday 10 till 11 History @ H1\nlunch break");
  await click('[data-act="ttRead"]'); await sleep(300);
  check("Read it understands the pasted line WITHOUT calling the model, and has not saved it yet", /Read 1 classes/.test(await text("#shBody")) && (await call(`window.__lastPrompt`)) === "" && (await saved()).classes.length === 2);
  check("the line it could not read is reported back", /Could not read 1 line/.test(await text("#shBody")) && /lunch break/.test(await text("#shBody")));
  await click('[data-act="ttAIUnread"]'); await sleep(400);
  check("the AI fallback gets ONLY the unreadable line, as attached page content", /lunch break/.test(await call(`window.__lastPage`)) && !/History/.test(await call(`window.__lastPage`)));
  check("AI rows are labelled as guesses and invalid ones are dropped (1 rule row + 1 AI row)", /AI guess/.test(await text("#shBody")) && /Read 2 classes/.test(await text("#shBody")));
  await click('[data-act="ttAcceptAI"]'); await sleep(150);
  const afterTT = await saved();
  check("accepting adds both classes without the 'ai' marker", afterTT.classes.length === 4 && afterTT.classes.every((c) => !("ai" in c)));
  await click('[data-act="delClass"][data-id="3"]'); await sleep(100); // keep three classes for the rest of the run

  // ---- deadlines: add, countdown, planner, check off
  await tab("deadlines");
  await setVal("#ddTitle", "Chemistry lab report"); await setVal("#ddSubj", "Chemistry"); await setVal("#ddHours", "3");
  await click('[data-act="ddAdd"]'); await sleep(150);
  check("a deadline is saved with its hours and due date", await (async () => { const d = (await saved()).deadlines; return d.length === 1 && d[0].hours === 3 && d[0].title === "Chemistry lab report" && Date.parse(d[0].due) > Date.now(); })());
  check("it is listed with a countdown chip", /due in/.test(await text("#shBody")));
  await click('[data-act="suggest"]'); await sleep(200);
  const planTxt = await text("#shBody");
  check("the planner proposes sessions (or says honestly what will not fit)", /Suggested study sessions/.test(planTxt) && (/\d\d:\d\d\u2013\d\d:\d\d/.test(planTxt) || /will not fit/.test(planTxt)));
  await setVal("#ddTitle", "Impossible essay"); await setVal("#ddHours", "40");
  await call(`document.getElementById("ddDue").value = new Date(Date.now() + 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0,16)`);
  await click('[data-act="ddAdd"]'); await sleep(150);
  await click('[data-act="suggest"]'); await sleep(200);
  check("an impossible load is reported as not fitting", /Impossible essay.*will not fit/.test(await text("#shBody")));
  await call(`document.querySelector('input[data-act="toggleDue"]').click()`); await sleep(150);
  check("ticking a deadline moves it to Done", /Done \(1\)/.test(await text("#shBody")) && (await saved()).deadlines.some((d) => d.done));

  // ---- focus timer: start, ticks, pause, reset, completion credits the day, long break rule
  await tab("focus");
  check("the focus tab shows 25:00", (await text("#stClock")) === "25:00");
  await click('[data-act="tStart"]'); await sleep(2200);
  const running = await text("#stClock");
  check("starting counts down (clock moved off 25:00)", running !== "25:00" && /^24:5\d$/.test(running), running);
  check("the ring is drawn", await call(`Number(document.getElementById("stRing").getAttribute("stroke-dashoffset")) > 0`));
  await call(`document.getElementById("jonah-tool-study").remove()`); await sleep(1200);
  check("with the panel closed a floating timer chip stays on screen", await call(`!!document.getElementById("studyTimerChip") && /Focus/.test(document.getElementById("studyTimerChip").textContent)`));
  await call(`openStudyHub("focus")`); await sleep(200);
  check("reopening the hub brings the chip back inside it", await call(`!document.getElementById("studyTimerChip")`));
  await click('[data-act="tPause"]'); await sleep(200);
  const paused = await text("#stClock"); await sleep(1500);
  check("pause freezes the clock", (await text("#stClock")) === paused && paused !== "25:00", paused);
  // finish a block for real: move the end time into the past and let the real ticker finish it
  await click('[data-act="tStart"]'); await sleep(300);
  await call(`StudyHub.timer.endAt = Date.now() - 1000`); await sleep(1200);
  const today = await call(`StudyCore.dateKey(new Date())`);
  const day = (await saved()).days[today] || {};
  check("a finished focus block credits 25 minutes and 1 session to today", day.focusMin === 25 && day.sessions === 1, JSON.stringify(day));
  check("the timer moved on to a short break", /Short break/.test(await text("#stPhase")) && (await text("#stClock")) === "05:00");
  await setVal('[data-cfg="short"]', "7");
  check("changing the short-break length is saved and applied", (await saved()).timerCfg.short === 7 && (await text("#stClock")) === "07:00");
  check("the 'block distracting sites' option exists and is on by default", await call(`document.querySelector('[data-act="blockSites"]').checked`));

  // ---- cards: manual add, AI cards (JSON), duplicates skipped, review, grading changes the schedule, streak
  await tab("cards");
  await setVal("#cdFront", "2 + 2?"); await setVal("#cdBack", "4");
  await click('[data-act="cardAdd"]'); await sleep(150);
  check("a card can be added by hand", (await saved()).cards.length === 1);
  await call(`window.__reply = ${JSON.stringify('```json\n[{"front":"Capital of France?","back":"Paris"},{"front":"2 + 2?","back":"duplicate of the one I typed"},{"front":"no back"}]\n```')}`);
  await setVal("#cdTopic", "geography");
  await click('[data-act="cardsAITopic"]'); await sleep(500);
  const cs = (await saved()).cards;
  check("AI cards: the good one is added, the duplicate and the one-sided card are not", cs.length === 2 && cs.some((c) => c.front === "Capital of France?"), JSON.stringify(cs.map((c) => c.front)));
  check("the prompt asked for the topic", /geography/.test(await call(`window.__lastPrompt`)));
  await click('[data-act="reviewStart"]'); await sleep(200);
  check("review starts on a card with the answer hidden", /Think of the answer/.test(await text("#shBody")));
  await call(`document.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }))`); await sleep(150);
  check("Space reveals the answer and shows the four interval previews", (await call(`document.querySelectorAll(".sh-grade button").length`)) === 4 && /10 min/.test(await text(".sh-grade")) && /4 d/.test(await text(".sh-grade")));
  await call(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }))`); await sleep(150);
  const afterGood = (await saved()).cards.filter((c) => c.reps === 1);
  check("pressing 3 (Good) schedules that card for tomorrow", afterGood.length === 1 && afterGood[0].interval === 1);
  await click('[data-act="reveal"]'); await sleep(100);
  await call(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }))`); await sleep(150);
  const st = await saved();
  check("pressing 1 (Again) counts a lapse and brings the card round again this session", st.cards.some((c) => c.lapses === 1) && /Think of the answer/.test(await text("#shBody")));
  check("each review adds to today's card count", (st.days[today].cards || 0) === 2);

  // ---- routines
  await tab("routines");
  await click('[data-act="rtTemplate"][data-name="Wind down"]'); await sleep(150);
  check("a starter routine is added with its steps", (await call(`document.querySelectorAll('input[data-act="rtCheck"]').length`)) === 3);
  await call(`document.querySelectorAll('input[data-act="rtCheck"]')[0].click()`); await sleep(150);
  check("ticking a step shows 1/3", /1\/3/.test(await text("#shBody")));
  for (let i = 1; i < 3; i++) { await call(`document.querySelectorAll('input[data-act="rtCheck"]')[${i}].click()`); await sleep(150); }
  const rs = await saved();
  check("finishing every step completes the routine and credits the day ONCE", /3\/3/.test(await text("#shBody")) && rs.days[today].routines === 1);
  await call(`document.querySelectorAll('input[data-act="rtCheck"]')[0].click()`); await sleep(100); await call(`document.querySelectorAll('input[data-act="rtCheck"]')[0].click()`); await sleep(150);
  check("un-ticking and re-ticking the last step does not credit it a second time", (await saved()).days[today].routines === 1);
  await setVal("#rtName", "Sunday reset"); await setVal("#rtItems", "Clean desk\n\nPlan week\n");
  await click('[data-act="rtAdd"]'); await sleep(150);
  check("a custom routine drops blank lines", (await saved()).routines.length === 2 && (await saved()).routines[1].items.length === 2);
  // a new day starts empty
  await call(`(() => { const s = StudyHub.state(); s.routines[0].day = "2000-01-01"; StudyHub.paint(); })()`); await sleep(100);
  check("a routine from yesterday starts empty today", /0\/3/.test(await text("#shBody")));

  // ---- AI tutor (canned model): needs a page; explain / quiz / mark / study mode
  await tab("ai");
  await click('[data-act="aiExplain"]'); await sleep(500);
  check("with no readable page the tutor says so instead of asking the model", /Open a web page/.test(await text("#shBody")));
  await call(`window.__lastPrompt = ""; window.__reply = "Mitochondria make energy.\\n- point **one**\\n- point <img src=x onerror=alert(1)>two"`);
  await setVal("#aiQuestion", "what are mitochondria?");
  await click('[data-act="aiAsk"]'); await sleep(500);
  check("Ask sends the question and shows the reply with bold and bullets", /Student question: what are mitochondria/.test(await call(`window.__lastPrompt`)) && (await call(`document.querySelectorAll(".sh-ai-out li").length`)) === 2 && (await call(`!!document.querySelector(".sh-ai-out b")`)));
  check("html in the model's reply is shown as text, never run", await call(`!document.querySelector(".sh-ai-out img")`));
  await call(`document.querySelector('[data-act="socratic"]').click()`); await sleep(150);
  await setVal("#aiQuestion", "what is 12*13?");
  await click('[data-act="aiAsk"]'); await sleep(400);
  check("Study Mode switches the prompt to hints-not-answers", /do NOT give the final answer/.test(await call(`window.__lastPrompt`)) && (await saved()).socratic === true);
  await call(`window.__reply = "Hint: split 13 into 10 + 3.\\nWhat is 12 x 10?\\n1. The student asked about the product.\\n2. rambling"; 0`);
  await setVal("#aiQuestion", "what is 12*13 again?");
  await click('[data-act="aiAsk"]'); await sleep(400);
  const smOut = await text(".sh-ai-out");
  check("Study Mode shows the hint and the question and drops the rambling after it", /What is 12 x 10\?/.test(smOut) && !/rambling|The student asked/.test(smOut), smOut);
  await setVal("#aiLevel", "university");
  check("the reading level is saved", (await saved()).level === "university");
  await call(`StudyHub.hub.askOverride = async () => ({ success: false, error: "You are out of free messages." }); 0`);
  await click('[data-act="aiPlan"]'); await sleep(400);
  check("an error from the assistant (e.g. billing) is shown to the student, not swallowed", /out of free messages/.test(await text(".sh-ai-out")));
  await call(`StudyHub.hub.askOverride = async (p) => { window.__lastPrompt = p; return { success: true, text: window.__reply }; }; window.__reply = "Week plan: study."`);
  await click('[data-act="aiPlan"]'); await sleep(400);
  check("Plan my week sends the real deadlines and classes", /Chemistry lab report/.test(await call(`window.__lastPrompt`)) && /"subject":"Maths"/.test(await call(`window.__lastPrompt`)));

  // ---- Today now has real content
  await tab("today");
  const today2 = await text("#shBody");
  check("Today shows the streak, due work and the cards/routines counters", /streak/.test(today2) && /Chemistry lab report|Impossible essay/.test(today2) && /Flashcards/.test(today2) && /done today/.test(today2), today2.slice(0, 200).replace(/\s+/g, " "));
  check("Today's feasibility line is shown for deadlines this week", /will not fit|fits around/.test(today2));

  // ---- it all survives a restart of the page
  const before = JSON.stringify((await saved()).classes);
  await call(`location.reload()`); await sleep(3500);
  await call(`openStudyHub("timetable")`); await sleep(300);
  check("after a reload the timetable is still there", JSON.stringify((await saved()).classes) === before && (await call(`document.querySelectorAll(".sh-tt .blk").length`)) === 3);

  // ---- the real main-process handler (no stub): called for real
  const real = await call(`window.study.ask === undefined ? "no bridge" : (async () => { const r = await window.study.ask("Reply with exactly the single word: pong"); return JSON.stringify(r).slice(0, 300); })()`);
  check("the real preload bridge study.ask exists and returns a structured result", typeof real === "string" && real !== "no bridge" && /"success":(true|false)/.test(real), real);
  const refuse = await call(`(async () => JSON.stringify(await window.study.ask("   ")))()`);
  check("an empty question is refused by the main process, no model call", /"success":false/.test(refuse), refuse);

  console.log(failures ? `RESULT study-hub FAILED (${failures} failing)` : "RESULT study-hub ok");
  app.exit(failures ? 1 : 0);
}

async function driver() {
  if (!(await portFree(5589)) || !(await portFree(5588))) { console.log("SKIP: ports 5588/5589 are in use (the real Jonah is open?)"); return process.exit(0); }
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-sh-run-"));
  const env = { ...process.env, JONAH_ENTITLEMENTS_ENABLED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [`--user-data-dir=${path.join(tmp, "data")}`, __filename], { env, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", () => {});
  const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 240000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  for (const line of out.split(/\r?\n/)) if (/^(PASS|FAIL|RESULT)/.test(line)) console.log(line);
  if (code !== 0) { console.log(`FAIL  exited with ${code}`); if (code === -99 || !/RESULT/.test(out)) console.log(out.split(/\r?\n/).slice(-30).join("\n")); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : 1);
}

if (IS_ELECTRON) require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e); require("electron").app.exit(2); }));
else driver().catch((e) => { console.error(e); process.exit(2); });
