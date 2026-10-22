// Noah/bench/integration/downloads-check.cjs
//
// End-to-end check with the REAL Jonah window and REAL downloads: a local server streams files slowly, so the page's live progress bar, speed, time left, pause / resume /
// cancel, safe file naming, open / show-in-folder (with the "can run programs" question), history and the floating progress chip can all be watched while they happen.
// Files go to a temporary folder, never your real Downloads; the Open / Show-in-folder calls are intercepted so nothing is actually launched.
//
//   node Noah/bench/integration/downloads-check.cjs
//
// Needs ports 5588/5589 free: it skips itself if the real Jonah is open.
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const IS_ELECTRON = Boolean(process.versions.electron);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 150) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.once("listening", () => s.close(() => resolve(true))); s.listen(port, "127.0.0.1"); });

const SLOW_BYTES = 3 * 1024 * 1024;
const slowBuf = Buffer.alloc(SLOW_BYTES); for (let i = 0; i < SLOW_BYTES; i++) slowBuf[i] = (i * 31 + 7) & 255;
const SLOW_SHA = crypto.createHash("sha256").update(slowBuf).digest("hex");

async function runner() {
  const { app, BrowserWindow, webContents, shell, session } = require("electron");
  let failures = 0;
  const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + String(detail).slice(0, 240) : ""}`); };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-dl-"));
  if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "jonah-dlu-")));
  app.setPath("downloads", dir); // never the user's real Downloads folder
  app.setAppPath(ROOT);
  const opened = [], shown = [];
  shell.openPath = async (p) => { opened.push(p); return ""; };
  shell.showItemInFolder = (p) => { shown.push(p); };

  let slowSent = 0, hold = false;
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    const attach = (name) => ({ "Content-Disposition": `attachment; filename="${name}"`, "Content-Type": "application/octet-stream" });
    if (url === "/slow.bin") { // 3 MB over about 4 seconds, with a known size
      res.writeHead(200, { ...attach("slow.bin"), "Content-Length": SLOW_BYTES });
      let off = 0; const iv = setInterval(() => { if (hold) return; if (off >= SLOW_BYTES) { clearInterval(iv); res.end(); return; } const n = Math.min(160 * 1024, SLOW_BYTES - off); res.write(slowBuf.subarray(off, off + n)); off += n; slowSent = off; }, 200);
      res.on("close", () => clearInterval(iv));
    } else if (url === "/nosize.bin") { // no Content-Length at all
      res.writeHead(200, attach("nosize.bin")); let n = 0; const iv = setInterval(() => { res.write(Buffer.alloc(100 * 1024, 65)); if (++n >= 8) { clearInterval(iv); res.end(); } }, 250); res.on("close", () => clearInterval(iv));
    } else if (url === "/forever.bin") { // never ends: for cancelling
      res.writeHead(200, { ...attach("forever.bin"), "Content-Length": 50 * 1024 * 1024 }); const iv = setInterval(() => res.write(Buffer.alloc(64 * 1024, 66)), 150); res.on("close", () => clearInterval(iv));
    } else if (url === "/notes.txt") { res.writeHead(200, { ...attach("notes.txt"), "Content-Length": 11 }); res.end("hello notes"); }
    else if (url === "/setup.exe") { res.writeHead(200, { ...attach("setup.exe"), "Content-Length": 4 }); res.end("MZ\u0000\u0000"); }
    else if (url === "/evil") { res.writeHead(200, { ...attach("..\\..\\..\\escape.txt"), "Content-Length": 4 }); res.end("nope"); }
    else { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><title>t</title><script>setInterval(() => { try { window.downloads; document.title = 'dl:' + typeof window.downloads; } catch (e) {} }, 100)</script>hi"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  require(path.join(ROOT, "main.cjs"));
  const win = await until(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html")), 30000, 300);
  check("the real browser window opens", !!win);
  if (!win) { console.log("RESULT downloads FAILED (no window)"); return app.exit(1); }
  await sleep(4000);

  const call = (js) => win.webContents.executeJavaScript(js, true);
  const click = (sel) => call(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const ses = session.fromPartition("persist:main");
  const startDl = (u) => ses.downloadURL(base + u);
  const panelText = () => call(`(document.getElementById("jonah-tool-downloads") || {}).textContent || ""`);
  const list = () => call(`downloads.list()`);
  await call(`window.confirm = (m) => { window.__asked = m; return window.__answer !== false; }; window.alert = (m) => { window.__alert = m; }; 0`);

  check("with no downloads the page is closed and the list is empty", !(await call(`!!document.getElementById("jonah-tool-downloads")`)) && (await list()).length === 0);
  await call(`showDownloads(); 0`); await sleep(400);
  check("the Downloads page opens from the menu entry, with a friendly empty state", /No downloads yet/.test(await panelText()) && (await call(`document.querySelector('#jonah-tool-downloads [data-act="clear"]').disabled`)));
  await call(`closeToolPanel("downloads"); 0`);

  // ================================================================ a real download, watched while it runs
  await call(`tabData[activeTabIndex].webview.loadURL(${JSON.stringify(base + "/slow.bin")}).catch(() => {}); 0`);
  const opens = await until(() => call(`!!document.getElementById("jonah-tool-downloads")`), 15000, 100);
  check("starting a download opens the Downloads page by itself", !!opens);
  const gotCard = await until(async () => /slow\.bin/.test(await panelText()), 8000, 100);
  check("the file appears with its name, type tile and 'Downloading' status", !!gotCard && /Downloading/.test(await panelText()) && /^BIN$/.test(await call(`document.querySelector("#jonah-tool-downloads .dl-tile").textContent`)));
  const sawBar = await until(() => call(`(() => { const i = document.querySelector("#jonah-tool-downloads .dl-bar i"); return !!i && parseFloat(i.style.width) > 0 && parseFloat(i.style.width) < 100; })()`), 8000, 100);
  check("a progress bar shows how much has downloaded (between 0 and 100%)", !!sawBar);
  const p1 = await call(`parseFloat((document.querySelector('#jonah-tool-downloads [data-pct]') || {}).textContent) || 0`);
  await sleep(1200);
  const p2 = await call(`parseFloat((document.querySelector('#jonah-tool-downloads [data-pct]') || {}).textContent) || 0`);
  check("the percentage keeps climbing while you watch (no refresh needed)", p2 > p1, `${p1}% -> ${p2}%`);
  const det = await call(`(document.querySelector("#jonah-tool-downloads [data-detail]") || {}).textContent || ""`);
  check("the line under the name shows received of total size, speed and time left", /of 3 MB/.test(det) && /[KM]B\/s/.test(det) && /left/.test(det), det);
  check("the summary strip counts what is running and shows the overall speed", /1 file downloading/.test(await panelText()) && (await call(`!!document.querySelector("#dlSum")`)));
  check("there are Pause and Cancel buttons while it runs", await call(`!!document.querySelector('#jonah-tool-downloads [data-act="pause"]') && !!document.querySelector('#jonah-tool-downloads [data-act="cancel"]')`));

  await click('#jonah-tool-downloads [data-act="pause"]'); await sleep(800);
  const r1 = (await list())[0].received; await sleep(1200); const r2 = (await list())[0].received;
  check("Pause really stops the download (received bytes stay put) and says Paused with a Resume button", r2 === r1 && /Paused/.test(await panelText()) && (await call(`!!document.querySelector('#jonah-tool-downloads [data-act="resume"]')`)), `${r1} vs ${r2}`);
  check("a paused bar changes colour and the speed is not shown", (await call(`!!document.querySelector("#jonah-tool-downloads .dl-bar.paused")`)) && !/B\/s/.test(await call(`(document.querySelector("#jonah-tool-downloads [data-detail]") || {}).textContent || ""`)));
  await click('#jonah-tool-downloads [data-act="resume"]');
  const grew = await until(async () => (await list())[0].received > r2, 8000, 150);
  check("Resume carries on from where it stopped", !!grew);
  const done = await until(async () => (await list())[0].status === "completed", 30000, 250);
  check("the download completes", !!done);
  const entry = (await list())[0];
  const onDisk = path.join(dir, "slow.bin");
  check("the file is in the downloads folder, byte for byte what the server sent", fs.existsSync(onDisk) && fs.statSync(onDisk).size === SLOW_BYTES && crypto.createHash("sha256").update(fs.readFileSync(onDisk)).digest("hex") === SLOW_SHA);
  check("the finished entry has the full size, an end time and a speed of zero", entry.received === SLOW_BYTES && entry.total === SLOW_BYTES && !!entry.endedAt && entry.speedBps === 0 && entry.host === "127.0.0.1");
  await until(async () => /Completed/.test(await panelText()), 4000, 150);
  check("the open page flips the card to Completed and offers Open / Show in folder", /Completed/.test(await panelText()) && (await call(`!!document.querySelector('#jonah-tool-downloads [data-act="open"]') && !!document.querySelector('#jonah-tool-downloads [data-act="show"]')`)));
  // the 'Finished' notice on the chip (with the page closed): a download seen paused then completed, fed straight to the page's own handler
  await call(`closeToolPanel("downloads"); const base = { id: "syn1", name: "video.mp4", received: 5, total: 10, startedAt: new Date().toISOString(), url: "", host: "" }; DownloadsUI.onList([{ ...base, status: "paused" }]); DownloadsUI.onList([{ ...base, status: "completed", received: 10, endedAt: new Date().toISOString(), exists: true }]); 0`); await sleep(300);
  check("with the page closed, finishing a download shows 'Finished: name' on the chip", /Finished: video\.mp4/.test(await call(`(document.getElementById("dlChip") || {}).textContent || ""`)));
  await call(`document.getElementById("dlChip") && document.getElementById("dlChip").remove(); downloads.list().then((l) => DownloadsUI.onList(l)); 0`); await sleep(300);

  // ================================================================ never overwrite
  const mtime = fs.statSync(onDisk).mtimeMs;
  startDl("/slow.bin"); await until(async () => (await list()).length === 2, 8000, 100);
  const second = (await list())[0];
  check("a second download of the same name gets 'slow (1).bin' and the first file is not touched", second.name === "slow (1).bin" && fs.statSync(onDisk).mtimeMs === mtime);
  await call(`document.querySelector("#jonah-tool-downloads") || openDownloads(); 0`); await sleep(500);
  await click('#jonah-tool-downloads [data-card] [data-act="cancel"]'); await sleep(900);
  check("Cancel stops it: status Cancelled with a note and a Try again button", (await list())[0].status === "cancelled" && /Cancelled/.test(await panelText()) && (await call(`!!document.querySelector('#jonah-tool-downloads [data-act="retry"]')`)));

  // ================================================================ unknown size
  startDl("/nosize.bin"); await until(async () => (await list()).some((d) => d.name === "nosize.bin"), 8000, 100);
  const unk = await until(() => call(`!!document.querySelector("#jonah-tool-downloads .dl-bar.unknown")`), 6000, 100);
  check("when the size is not known the bar is an activity bar and says so (no fake percentage)", !!unk && /Size unknown/.test(await panelText()) && /downloaded/.test(await panelText()));
  await until(async () => (await list()).find((d) => d.name === "nosize.bin").status === "completed", 15000, 200);
  check("an unknown-size download finishes with its real size", (await list()).find((d) => d.name === "nosize.bin").total === 8 * 100 * 1024);

  // ================================================================ hostile name, text file, program file
  startDl("/evil"); await until(async () => (await list()).some((d) => /escape/.test(d.name)), 8000, 100); await sleep(800);
  const evil = (await list()).find((d) => /escape/.test(d.name));
  check("a download named '..\\..\\..\\escape.txt' stays inside the downloads folder", !!evil && path.dirname(evil.path) === dir && !evil.name.includes("..\\") && fs.existsSync(evil.path), evil && evil.path);
  startDl("/notes.txt"); startDl("/setup.exe");
  await until(async () => { const l = await list(); return l.filter((d) => ["notes.txt", "setup.exe"].includes(d.name) && d.status === "completed").length === 2; }, 10000, 200);
  await call(`openDownloads(); 0`); await sleep(600);
  const cardOf = (name) => call(`[...document.querySelectorAll("#jonah-tool-downloads [data-card]")].find(c => c.querySelector(".n").textContent === ${JSON.stringify(name)}).dataset.card`);
  const notesId = await cardOf("notes.txt"), exeId = await cardOf("setup.exe");
  await click(`#jonah-tool-downloads [data-act="open"][data-id="${notesId}"]`); await sleep(500);
  check("Open on a text file opens it straight away (no question)", opened.length === 1 && opened[0] === path.join(dir, "notes.txt") && (await call(`window.__asked`)) === undefined);
  await call(`window.__answer = false; 0`);
  await click(`#jonah-tool-downloads [data-act="open"][data-id="${exeId}"]`); await sleep(500);
  check("Open on a program file ASKS first, and saying no launches nothing", /can run programs/.test(await call(`window.__asked || ""`)) && opened.length === 1);
  await call(`window.__answer = true; 0`);
  await click(`#jonah-tool-downloads [data-act="open"][data-id="${exeId}"]`); await sleep(500);
  check("saying yes opens it, exactly once, and only the recorded file", opened.length === 2 && opened[1] === path.join(dir, "setup.exe"));
  const direct = await call(`downloads.act(${JSON.stringify(exeId)}, "open")`);
  check("asking the main process directly for a program file WITHOUT the yes is refused", direct.ok === false && direct.needsConfirm === true && opened.length === 2);
  const fakePath = await call(`downloads.act(${JSON.stringify(notesId)}, "open", { confirmed: true, path: "C:\\\\Windows\\\\System32\\\\cmd.exe" })`);
  check("a path sent by the page is ignored (only the recorded file opens)", fakePath.ok === true && opened[2] === path.join(dir, "notes.txt"));
  await click(`#jonah-tool-downloads [data-act="show"][data-id="${notesId}"]`); await sleep(400);
  check("Show in folder reveals that file", shown.length === 1 && shown[0] === path.join(dir, "notes.txt"));

  // ================================================================ file gone, search, remove, clear
  fs.unlinkSync(path.join(dir, "notes.txt"));
  await call(`downloads.list().then((l) => DownloadsUI.onList(l)); 0`); await sleep(500);
  check("a file deleted outside Jonah is noticed: 'moved or deleted' and a Download again button", /moved or deleted/.test(await panelText()) && (await call(`!!document.querySelector('#jonah-tool-downloads [data-act="retry"][data-id="${notesId}"]')`)));
  await call(`(() => { const i = document.getElementById("dlSearch"); i.value = "slow"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`); await sleep(300);
  check("search narrows the list to matching names", (await call(`document.querySelectorAll("#jonah-tool-downloads [data-card]").length`)) === 2 && !/notes\.txt/.test(await panelText()));
  await call(`(() => { const i = document.getElementById("dlSearch"); i.value = "zzz"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`); await sleep(300);
  check("a search with no match says so", /Nothing matches/.test(await panelText()));
  await call(`(() => { const i = document.getElementById("dlSearch"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); })()`); await sleep(300);
  await click(`#jonah-tool-downloads [data-act="remove"][data-id="${notesId}"]`); await sleep(500);
  check("Remove takes it off the list", !(await list()).some((d) => d.id === notesId));
  check("the list groups downloads under 'Today'", /TODAY|Today/.test(await panelText()));
  // history is kept in a file (checked before anything is cleared)
  await sleep(900);
  const saved = fs.existsSync(path.join(app.getPath("userData"), "downloads.json")) ? JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "downloads.json"), "utf8")) : [];
  check("the list is saved to a file so it survives a restart", saved.some((d) => d.name === "slow.bin" && d.status === "completed") && saved.every((d) => !("exists" in d)), `${saved.length} saved`);
  startDl("/forever.bin"); await until(async () => (await list()).some((d) => d.name === "forever.bin" && d.status === "downloading"), 8000, 100); await sleep(600);
  await call(`document.querySelector("#jonah-tool-downloads .jtp-close").click(); 0`); await sleep(900);
  check("with the page closed a floating chip shows the running download's name and progress", await call(`(() => { const c = document.getElementById("dlChip"); return !!c && /forever\.bin/.test(c.textContent) && /%/.test(c.textContent) && !!c.querySelector(".dl-bar"); })()`), await call(`(document.getElementById("dlChip") || {}).textContent || "none"`));
  await call(`document.getElementById("dlChip").click(); 0`); await sleep(500);
  check("clicking the chip opens the page and the chip goes away", (await call(`!!document.getElementById("jonah-tool-downloads")`)) && !(await call(`!!document.getElementById("dlChip")`)));
  await click('#jonah-tool-downloads [data-act="clear"]'); await sleep(600);
  const afterClear = await list();
  check("'Clear finished' removes finished ones but keeps what is still downloading", afterClear.length === 1 && afterClear[0].name === "forever.bin" && afterClear[0].status === "downloading");
  check("clearing the list never deletes the files themselves", fs.existsSync(path.join(dir, "slow.bin")) && fs.existsSync(path.join(dir, "setup.exe")));
  await click('#jonah-tool-downloads [data-act="cancel"]'); await sleep(800);

  // ================================================================ security
  check("the old 'get-downloads' call still answers", Array.isArray(await call(`window.api.getDownloads()`)));
  await call(`createNewTab(${JSON.stringify(base + "/")}); 0`); await sleep(4500);
  const evilPage = webContents.getAllWebContents().find((w) => w.getType() === "webview" && w.getURL().startsWith(base + "/"));
  check("a website page has NO access to the downloads bridge", !!evilPage && (await evilPage.executeJavaScript(`typeof window.downloads`)) === "undefined");

  console.log(failures ? `RESULT downloads FAILED (${failures} failing)` : "RESULT downloads ok");
  server.close(); fs.rmSync(dir, { recursive: true, force: true });
  app.exit(failures ? 1 : 0);
}

async function driver() {
  if (!(await portFree(5589)) || !(await portFree(5588))) { console.log("SKIP: ports 5588/5589 are in use (the real Jonah is open?)"); return process.exit(0); }
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-dl-run-"));
  const env = { ...process.env, JONAH_ENTITLEMENTS_ENABLED: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [`--user-data-dir=${path.join(tmp, "data")}`, __filename], { env, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", () => {});
  const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 280000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  for (const line of out.split(/\r?\n/)) if (/^(PASS|FAIL|RESULT)/.test(line)) console.log(line);
  if (code !== 0) { console.log(`FAIL  exited with ${code}`); if (code === -99 || !/RESULT/.test(out)) console.log(out.split(/\r?\n/).slice(-30).join("\n")); }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : 1);
}

if (IS_ELECTRON) require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e); require("electron").app.exit(2); }));
else driver().catch((e) => { console.error(e); process.exit(2); });
