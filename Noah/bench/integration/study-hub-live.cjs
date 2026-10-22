// Noah/bench/integration/study-hub-live.cjs - the Study Hub's AI features against the REAL chat server (needs internet; billing forced off).
// Sends the real prompts (StudyCore.buildPrompt) through the real preload bridge and checks that StudyCore can read what actually comes back.
//   electron --user-data-dir=<tmp> Noah/bench/integration/study-hub-live.cjs
"use strict";
const path = require("path"), fs = require("fs"), os = require("os");
const ROOT = path.resolve(__dirname, "..", "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { app, BrowserWindow } = require("electron");
process.env.JONAH_ENTITLEMENTS_ENABLED = "0";
app.whenReady().then(async () => {
  let failures = 0;
  const check = (n, ok, d = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`); };
  app.setAppPath(ROOT);
  require(path.join(ROOT, "main.cjs"));
  let win; for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html")); await sleep(300); }
  await sleep(3000);
  const call = (js) => win.webContents.executeJavaScript(js, true);
  const ask = (kind, ctx) => call(`(async () => { const q = StudyCore.buildRequest(${JSON.stringify(kind)}, ${JSON.stringify(ctx)}); const r = await window.study.ask(q.message, q.pageContent); return JSON.stringify(r); })()`).then(JSON.parse);
  const page = { title: "Photosynthesis - Biology notes", url: "https://example.org/bio", text: "Photosynthesis is the process by which plants, algae and some bacteria convert light energy into chemical energy. In the light-dependent reactions in the thylakoid membranes, chlorophyll absorbs light and water is split, releasing oxygen. In the Calvin cycle in the stroma, carbon dioxide is fixed into glucose using ATP and NADPH. The overall equation is 6CO2 + 6H2O + light -> C6H12O6 + 6O2. Factors limiting the rate are light intensity, carbon dioxide concentration and temperature." };

  const fc = await ask("flashcards", { page, count: 6 });
  console.log("flashcards reply:", JSON.stringify(fc).slice(0, 600));
  const cards = fc.success ? await call(`JSON.stringify(StudyCore.parseCards(${JSON.stringify(fc.text)}))`).then(JSON.parse) : [];
  check("real model: flashcards come back as cards StudyCore can read (>=3, both sides, even if the reply was cut off)", cards.length >= 3 && cards.every((c) => c.front && c.back), `${cards.length} cards; first: ${JSON.stringify(cards[0])}`);

  // the rules parser reads the pasted timetable (no model); the model is only the fallback, and its answer is shown against what is actually correct
  const raw = "Monday: 9:00-10:30 Maths (Room 4), 11:00-12:00 English\nTue 10am-11am History H1\nFriday 13:00 to 14:30 Physics lab @ B2";
  const ruled = await call(`JSON.stringify(StudyCore.parseTimetableText(${JSON.stringify(raw)}))`).then(JSON.parse);
  check("rules parser: the pasted timetable becomes exactly the 4 right classes", ruled.rows.length === 4 && ruled.unread.length === 0 && ruled.rows.some((r) => r.day === 0 && r.start === 540 && r.end === 630 && r.subject === "Maths" && r.room === "Room 4") && ruled.rows.some((r) => r.day === 4 && r.start === 780 && r.end === 870), JSON.stringify(ruled.rows));
  const tt = await ask("timetable", { raw });
  const rows = tt.success ? await call(`JSON.stringify(StudyCore.parseTimetableReply(${JSON.stringify(tt.text)}))`).then(JSON.parse) : [];
  const right = rows.filter((r) => ruled.rows.some((x) => x.day === r.day && x.start === r.start && x.end === r.end && x.subject.toLowerCase() === r.subject.toLowerCase())).length;
  console.log(`INFO  the model's own reading of the same timetable: ${right} of ${ruled.rows.length} classes exactly right, ${rows.length - right} wrong or invented (this is why the app reads by rules first and labels the model's rows "AI guess")`);

  const quiz = await ask("quiz", { page, count: 3 });
  console.log("quiz reply:", JSON.stringify(quiz).slice(0, 500));
  check("real model: quiz is returned (3 numbered questions, no answers key)", quiz.success && /1[.)]/.test(quiz.text) && /3[.)]/.test(quiz.text), quiz.error || "");
  const mark = quiz.success ? await ask("mark", { questions: quiz.text, answers: "1. light energy to chemical energy\n2. not sure\n3. temperature" }) : { success: false };
  console.log("mark reply:", JSON.stringify(mark).slice(0, 500));
  check("real model: answers get marked", mark.success && mark.text.length > 40);

  const socratic = await ask("ask", { question: "What is 12 times 13?", socratic: true });
  console.log("study mode reply:", JSON.stringify(socratic).slice(0, 400));
  check("real model: Study Mode replies (we do not claim it obeys: printed above for a human to judge)", socratic.success && socratic.text.length > 10);

  console.log(failures ? `RESULT study-hub-live FAILED (${failures})` : "RESULT study-hub-live ok");
  app.exit(failures ? 1 : 0);
});
