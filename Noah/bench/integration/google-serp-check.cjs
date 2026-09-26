// Real-Electron check of google-serp.cjs.
//
//   npx electron Noah/bench/integration/google-serp-check.cjs          fixture pages only (no network)
//   npx electron Noah/bench/integration/google-serp-check.cjs --live   also ONE real Google search (a throwaway session, not Jonah's)
//
// 1. Fixture: Google's URL is served from local HTML in a private test session, so the whole path (hidden window -> load -> read the
//    page -> results / robot-check detection) runs in real Chromium without touching Google.
// 2. Live (--live): one real search. On a shared mobile IP Google may answer with its robot check; that is reported, never solved.
"use strict";

const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const { createGoogleSearch } = require("../../../google-serp.cjs");

const RESULTS_PAGE = `<!doctype html><html><head><title>python - Google Search</title></head><body>
<div id="tads"><div data-text-ad="1"><a href="https://ads.example/buy"><h3>Sponsored: Learn Python Fast</h3></a></div></div>
<div id="search"><div id="rso">
  <div class="MjjYud"><div class="g"><div data-hveid="CAEQAA"><div><a jsname="UWckNb" href="https://www.python.org/"><br><h3 class="LC20lb">Welcome to Python.org</h3><div><cite>https://www.python.org</cite></div></a></div>
    <div class="VwiC3b" data-sncf="1"><span>The official home of the <em>Python</em> Programming Language.</span></div></div></div></div>
  <div class="MjjYud"><div class="g"><a href="/url?q=https://en.wikipedia.org/wiki/Python_(programming_language)&amp;sa=U"><h3>Python (programming language) - Wikipedia</h3></a>
    <div><span>en.wikipedia.org › wiki › Python</span></div><div>Python is a high-level, general-purpose programming language. Its design philosophy emphasizes readability.</div></div></div>
  <div class="MjjYud"><div class="g"><a href="https://www.google.com/goto?url=CAESTwHrOzAVakFaoyegxI6lBe"><h3>Python Tutorial - W3Schools</h3>
    <div><span>W3Schools</span><cite>https://www.w3schools.com<span> › python</span></cite></div></a><div class="VwiC3b">Well organized and easy to understand tutorials.</div></div></div>
  <div class="MjjYud"><div class="g"><a href="https://www.google.com/goto?url=CAESZQHrOzAVe"><h3>Learn Python - Free Course</h3>
    <cite>freecodecamp.org › news</cite></a><div class="VwiC3b">A free course.</div></div></div>
  <div class="MjjYud"><div class="g"><a href="https://www.google.com/goto?url=CAESno_cite"><h3>A result whose site cannot be told</h3></a></div></div>
  <div class="MjjYud"><a href="https://www.google.com/search?q=python+tutorial"><h3>People also search for</h3></a></div>
  <div class="MjjYud"><div class="g"><a href="https://www.python.org/"><h3>Welcome to Python.org (again)</h3></a></div></div>
  <div class="MjjYud"><div class="g"><a href="javascript:void(0)"><h3>Not a real link</h3></a></div></div>
</div></div>
<div id="bottomads"><a href="https://ads.example/2"><h3>Another ad</h3></a></div>
</body></html>`;

const ROBOT_PAGE = `<!doctype html><html><body><div>Our systems have detected unusual traffic from your computer network.</div>
<form id="captcha-form" action="index"><div class="g-recaptcha"></div></form></body></html>`;

async function fixtureCheck() {
  const partition = "jonah-serp-fixture";
  session.fromPartition(partition).protocol.handle("https", (request) => {
    const url = new URL(request.url);
    const html = url.searchParams.get("q") === "robot check" ? ROBOT_PAGE : RESULTS_PAGE;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  });
  const google = createGoogleSearch({ BrowserWindow, session, partition, minGapMs: 0 });
  const { items } = await google.search("python");
  console.log("fixture results:", JSON.stringify(items, null, 1));
  assert.deepEqual(
    items.map((i) => i.link),
    ["https://www.python.org/", "https://en.wikipedia.org/wiki/Python_(programming_language)", "https://www.w3schools.com/", "https://freecodecamp.org/"],
    "ads, Google's own links, duplicates and javascript: links are skipped; /url?q= is unwrapped; /goto links use the address Google shows",
  );
  assert.deepEqual(items.map((i) => i.displayLink).slice(2), ["www.w3schools.com", "freecodecamp.org"]);
  assert.equal(items[0].title, "Welcome to Python.org");
  assert.equal(items[0].snippet, "The official home of the Python Programming Language.");
  assert.equal(items[0].displayLink, "www.python.org");
  assert.equal(items[1].snippet, "Python is a high-level, general-purpose programming language. Its design philosophy emphasizes readability.", "no snippet element: the result's own text without its title and address line");
  await assert.rejects(google.search("robot check"), (err) => err.code === "captcha");
  console.log("fixture: robot check detected and paused, not solved");
  google.close();
  assert.equal(BrowserWindow.getAllWindows().length, 0, "no hidden window left behind");
}

async function liveCheck() {
  const google = createGoogleSearch({
    BrowserWindow, session, partition: "jonah-serp-live-check", minGapMs: 0,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });
  try {
    const { items } = await google.search("python programming language");
    console.log(`LIVE: ${items.length} results from Google's page`);
    for (const i of items) console.log(`  - ${i.title}\n    ${i.link}\n    ${i.snippet.slice(0, 110)}`);
  } catch (err) {
    console.log(`LIVE: ${err.code} - ${err.message}`);
  } finally {
    google.close();
  }
}

// Without this, closing the fixture's hidden window (the only window) would make Electron quit mid-check. In Jonah the main window
// is always open, so there this never happens.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  let failed = false;
  try {
    await fixtureCheck();
    console.log("FIXTURE CHECK PASSED");
    if (process.argv.includes("--live")) await liveCheck();
  } catch (err) {
    failed = true;
    console.error("CHECK FAILED:", err && err.stack);
  }
  app.exit(failed ? 1 : 0);
});
