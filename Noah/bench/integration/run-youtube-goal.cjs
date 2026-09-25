// Noah/bench/integration/run-youtube-goal.cjs
//
// LIVE: the real Jonah app, the real hosted model, real YouTube. Reproduces the reported bug with the user's own literal
// text and checks the fix against the real site: no premature/false "done", an artist-aware result when one was named,
// and (for a "search only" request) no assumption that a video should be opened.
//
//   electron --user-data-dir=<tmp> Noah/bench/integration/run-youtube-goal.cjs        (NOAH_YT_SCENARIO=1|2|3|4|5)
//
// Scenario 1 (default): the exact msg1 text from the bug report ("do me a favour its winter chills out here find a song
//   on Youtube go to youtube which can give us chill like Cold song if its possible by NCS").
// Scenario 2: msg2 ("Can you search for the song named Cold by NCS") - search only, no video should open.
// Scenario 3: "Find Cold by NCS on YouTube and play it" - search, open an NCS match, playback should start.
// Scenario 4: "Search Cold." - literal single-word search, no assumption about which "Cold".
// Scenario 5: the two messages back to back in one session (msg1 then msg2), the original reproduction.

"use strict";

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, webContents } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULTS = path.join(ROOT, "Noah", "bench", "results");
if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(require("os").tmpdir(), "noah-yt-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[yt]", ...a);
const SCENARIO = process.env.NOAH_YT_SCENARIO || "1";
const results = [];
const check = (id, name, pass, detail = "") => {
  results.push({ id, name, pass: !!pass, detail: String(detail).slice(0, 400) });
  log(pass ? "PASS" : "FAIL", id, "-", name, detail ? "| " + String(detail).slice(0, 300) : "");
};

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  const cfgDir = path.join(app.getPath("userData"), "browser-data", "noah");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "noah-config.json"), JSON.stringify({ takeover: { enabled: false }, policy: { mode: "autonomous" }, limits: { maxSteps: 30, maxModelCalls: 40, maxWallMs: 240000 } }));
  app.getAppPath = () => ROOT;
  require(path.join(ROOT, "main.cjs"));
  let win = null;
  for (let i = 0; i < 160 && !win; i++) {
    await sleep(500);
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html"));
  }
  if (!win) { log("shell window did not open"); return app.exit(2); }
  const ev = (js, ms = 20000) => Promise.race([win.webContents.executeJavaScript(js, true), new Promise((_, rej) => setTimeout(() => rej(new Error("renderer call timed out")), ms))]);
  for (let i = 0; i < 80; i++) { await sleep(500); if (await ev("!!(window.noah && window.rexy)").catch(() => false)) break; }
  await ev("(() => { window.__ev = []; window.noah.onEvent((e) => { e.__t = Date.now(); window.__ev.push(e); }); })()");
  await sleep(1000);

  const guest = () => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.hostWebContents === win.webContents && /youtube\.com/.test(w.getURL()));
  const readPage = async () => {
    const g = guest();
    if (!g) return null;
    return g.executeJavaScript(`(() => {
      const onWatch = /\\/watch\\?v=/.test(location.href);
      // Only a WATCH page's own main player counts as "this task started playback": a search-results page can still carry
      // a stale/background <video> element (a miniplayer, a still-loading thumbnail preview) that is not what was asked for.
      const playing = onWatch ? (() => { const v = document.querySelector('ytd-watch-flexy video, #movie_player video, video'); return v ? (!v.paused && v.currentTime > 0) : false; })() : false;
      const title = document.title;
      const url = location.href;
      const firstResults = [...document.querySelectorAll('a#video-title, a#thumbnail')].map((a) => a.getAttribute('title') || a.textContent).filter(Boolean).slice(0, 5);
      return { url, title, playing, onWatch, firstResults };
    })()`).catch(() => null);
  };

  async function runGoal(id, text) {
    const from = await ev("window.__ev.length");
    const t0 = Date.now();
    const sub = await ev(`window.rexy.goal(${JSON.stringify(text)})`);
    log(id, "submitted:", JSON.stringify(text), "->", JSON.stringify(sub));
    let fin = null;
    while (Date.now() - t0 < 200000 && !fin) {
      await sleep(500);
      fin = await ev(`window.__ev.slice(${from}).find((e) => e.event === 'task_finished') || null`).catch(() => null);
    }
    await sleep(1200);
    const page = await readPage();
    log(id, "result:", fin ? fin.status + " - " + String(fin.result || fin.error).slice(0, 220) : "NO TERMINAL EVENT", "| page:", JSON.stringify(page).slice(0, 260));
    return { sub, fin, page, ms: Date.now() - t0 };
  }

  if (SCENARIO === "1" || SCENARIO === "5") {
    const MSG1 = "do me a favour its winter chills out here find a song on Youtube go to youtube which can give us chill like Cold song if its possible by NCS";
    const r1 = await runGoal("A", MSG1);
    check("A1", "the task reached a terminal state", !!r1.fin, r1.fin ? r1.fin.status : "no terminal event");
    check("A2", "it did NOT report done with a chat-refusal / boilerplate as the result (the exact reported bug)", !(r1.fin && r1.fin.status === "completed" && /attached content|previous conversation|how can i assist|as an ai/i.test(r1.fin.result || "")), r1.fin && r1.fin.result);
    check("A3", "real progress was made: on YouTube with a search actually performed", !!r1.page && /youtube\.com/.test(r1.page.url) && !/^https:\/\/www\.youtube\.com\/?$/.test(r1.page.url), r1.page && r1.page.url);
    if (r1.fin && r1.fin.status === "completed") {
      check("A4", "the result text does not claim something it cannot back up (mentions Cold/NCS, not an unrelated refusal)", /cold|ncs/i.test(r1.fin.result || ""), r1.fin.result);
    }
  }

  if (SCENARIO === "2" || SCENARIO === "5") {
    const MSG2 = "Can you search for the song named Cold by NCS";
    const r2 = await runGoal("B", MSG2);
    check("B1", "search-only request completed", !!r2.fin && r2.fin.status === "completed", r2.fin && (r2.fin.result || r2.fin.error));
    check("B2", "the search query was the TITLE, not the literal filler sentence", !!r2.fin && !/song named/i.test(r2.fin.result || ""), r2.fin && r2.fin.result);
    check("B3", "a search-only request did not open a video - it stayed on a results/search page, doing what was actually asked and nothing more", !!r2.page && !r2.page.onWatch, r2.page && JSON.stringify({ url: r2.page.url, onWatch: r2.page.onWatch }));
  }

  if (SCENARIO === "3") {
    const r3 = await runGoal("C", "Find Cold by NCS on YouTube and play it");
    check("C1", "'find X by Y and play it' completed", !!r3.fin && r3.fin.status === "completed", r3.fin && (r3.fin.result || r3.fin.error));
    check("C2", "it ended on a real watch page, not the homepage or a search page", !!r3.page && /\/watch\?v=/.test(r3.page.url || ""), r3.page && r3.page.url);
    check("C3", "playback actually started (verified from the page's own <video> element, not asserted by the model)", !!r3.page && r3.page.playing === true, r3.page);
  }

  if (SCENARIO === "4") {
    const r4 = await runGoal("D", "Search Cold.");
    check("D1", "a bare 'Search Cold.' completed as a plain search", !!r4.fin && r4.fin.status === "completed", r4.fin && (r4.fin.result || r4.fin.error));
    check("D2", "it did not invent or assume an artist that was never named", !!r4.fin && !/\bNCS\b/.test(r4.fin.result || ""), r4.fin && r4.fin.result);
  }

  if (SCENARIO === "6") {
    // The exact live reproduction: one message that both searches AND says "play it", then a SEPARATE follow-up
    // message that just says "play" - which used to (a) search for the literal phrase "Cold by NCS play it" and
    // (b) fall through to plain chat ("I don't have the capability to play songs") for the follow-up.
    const r1 = await runGoal("E", "Its a cold weather open youtube and search for the song named Cold by NCS play it");
    check("E1", "completed", !!r1.fin && r1.fin.status === "completed", r1.fin && (r1.fin.result || r1.fin.error));
    check("E2", "the search was for the TITLE ('Cold by NCS'), not the literal sentence including 'play it'", !!r1.fin && !/play it/i.test(r1.fin.result || ""), r1.fin && r1.fin.result);
    check("E3", "it actually opened and played a video (not just left on the results page)", !!r1.page && r1.page.onWatch && r1.page.playing, r1.page);

    const r2 = await runGoal("F", "Play the song please");
    check("F1", "the follow-up reached the AGENT, not plain chat (it used to get 'I don't have the capability to play songs')", r2.sub && r2.sub.success === true && r2.sub.kind === "agent", JSON.stringify(r2.sub));
    check("F2", "the follow-up did not claim a refusal as if it were normal", !(r2.fin && /don't have the capability|I'm sorry/i.test(r2.fin.result || "")), r2.fin && r2.fin.result);
  }

  fs.writeFileSync(path.join(RESULTS, `youtube-goal-run-${SCENARIO}.json`), JSON.stringify({ when: new Date().toISOString(), scenario: SCENARIO, results }, null, 2));
  const failed = results.filter((r) => !r.pass);
  log(`SUMMARY ${results.length - failed.length}/${results.length} passed`);
  setTimeout(() => app.exit(failed.length ? 1 : 0), 500);
}

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.whenReady().then(() => main().catch((e) => { console.error("YT RUN ERROR", e); app.exit(2); }));
