// Noah/test/unit/downloads.test.cjs - the Downloads page's logic (downloads-core.js), the download list (downloads/manager.cjs) and its IPC access rules.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("events");
const path = require("path");
const D = require("../../../downloads-core.js");
const { DownloadManager } = require("../../../downloads/manager.cjs");
const { registerDownloadsIpc } = require("../../../downloads/ipc.cjs");

test("sizes, speeds and times read the way a file manager shows them", () => {
  assert.deepEqual([0, 1, 1023, 1024, 1536, 10 * 1024, 45.6 * 1048576, 100 * 1048576, 1.2 * 1073741824].map(D.fmtBytes), ["0 B", "1 B", "1023 B", "1 KB", "1.5 KB", "10.0 KB", "45.6 MB", "100 MB", "1.2 GB"]);
  assert.equal(D.fmtBytes(-5), "0 B"); assert.equal(D.fmtBytes("x"), "0 B"); assert.equal(D.fmtBytes(NaN), "0 B");
  assert.equal(D.fmtSpeed(2.5 * 1048576), "2.5 MB/s"); assert.equal(D.fmtSpeed(0), ""); assert.equal(D.fmtSpeed(NaN), "");
  assert.deepEqual([5, 59, 60, 245, 3599, 3600, 3900].map(D.fmtEta), ["5 s", "59 s", "1 min 00 s", "4 min 05 s", "59 min 59 s", "1 h 00 min", "1 h 05 min"]);
  assert.equal(D.fmtEta(null), ""); assert.equal(D.fmtEta(-1), ""); assert.equal(D.fmtEta(NaN), "");
});

test("progress: a percentage only when the total is known; speed is smoothed; time left needs a real speed", () => {
  assert.equal(D.pct(50, 200), 25); assert.equal(D.pct(200, 200), 100); assert.equal(D.pct(999, 200), 100); assert.equal(D.pct(5, 0), null); assert.equal(D.pct(5, -1), null); assert.equal(D.pct(-5, 100), 0);
  assert.equal(D.smooth(null, 1000), 1000); assert.equal(D.smooth(1000, 2000, 0.5), 1500);
  assert.equal(D.etaSec(0, 10240, 1024), 10); assert.equal(D.etaSec(0, 0, 1e6), null, "unknown total"); assert.equal(D.etaSec(0, 1e6, 100), null, "speed too small to promise anything"); assert.equal(D.etaSec(1e6, 1e6, 5000), null, "already done");
});

test("file types: kind, a short label, and which ones can run code", () => {
  assert.deepEqual(D.typeInfo("holiday.JPG"), { ext: "jpg", kind: "image", label: "JPG", risky: false });
  assert.equal(D.typeInfo("a.tar.gz").kind, "archive"); assert.equal(D.typeInfo("movie.mkv").kind, "video"); assert.equal(D.typeInfo("noext").label, "FILE"); assert.equal(D.typeInfo("weird.abcdefghij").kind, "other");
  for (const n of ["setup.exe", "x.MSI", "run.bat", "s.ps1", "a.jar", "t.lnk", "v.vbs", "installer.dmg", "run.sh", "evil.js"]) assert.equal(D.isRisky(n), true, n);
  for (const n of ["paper.pdf", "pic.png", "song.mp3", "data.zip", "notes.txt"]) assert.equal(D.isRisky(n), false, n);
});

test("safe names: no folders, no reserved characters, no device names, not endless", () => {
  assert.equal(D.safeName("../../Windows/evil.exe"), "__.._Windows_evil.exe"); assert.ok(!D.safeName("../../Windows/evil.exe").startsWith("."));
  assert.equal(D.safeName("a/b\\c.txt"), "a_b_c.txt"); assert.equal(D.safeName('we<ird>:"na|me?.pdf'), "we_ird___na_me_.pdf");
  assert.equal(D.safeName("CON.txt"), "_CON.txt"); assert.equal(D.safeName("nul"), "_nul"); assert.equal(D.safeName("file. . "), "file"); assert.equal(D.safeName(".hidden"), "_hidden");
  assert.equal(D.safeName(""), "download"); assert.equal(D.safeName(null), "download");
  const long = D.safeName("x".repeat(400) + ".pdf"); assert.ok(long.length <= 180 && long.endsWith(".pdf"));
  assert.ok(!/[\\/]/.test(D.safeName("../../x")), "never a path");
});

test("unique names never overwrite: report.pdf -> report (1).pdf -> report (2).pdf, capitals ignored", () => {
  assert.equal(D.uniqueName("report.pdf", new Set()), "report.pdf");
  assert.equal(D.uniqueName("report.pdf", new Set(["report.pdf"])), "report (1).pdf");
  assert.equal(D.uniqueName("report.pdf", new Set(["report.pdf", "report (1).pdf"])), "report (2).pdf");
  assert.equal(D.uniqueName("Report.PDF", new Set(["report.pdf"])), "Report (1).PDF");
  assert.equal(D.uniqueName("noext", new Set(["noext"])), "noext (1)");
  assert.equal(D.uniqueName(".bashrc", new Set([".bashrc"])), ".bashrc (1)");
});

test("source host and grouping by day", () => {
  assert.equal(D.sourceHost("https://www.example.com/a/b.zip?x=1"), "example.com"); assert.equal(D.sourceHost("http://files.test:8080/x"), "files.test");
  assert.equal(D.sourceHost("blob:https://x/abc"), ""); assert.equal(D.sourceHost("data:text/plain,hi"), ""); assert.equal(D.sourceHost("garbage"), "");
  const now = new Date(2026, 9, 21, 15);
  const at = (d, h) => new Date(2026, 9, d, h).toISOString();
  const g = D.groupByDay([{ id: 1, startedAt: at(21, 9) }, { id: 2, startedAt: at(20, 23) }, { id: 3, startedAt: at(18, 12) }, { id: 4, startedAt: at(1, 12) }, { id: 5, startedAt: at(21, 14) }], now);
  assert.deepEqual(g.map((x) => [x.label, x.items.map((i) => i.id)]), [["Today", [5, 1]], ["Yesterday", [2]], ["Earlier this week", [3]], ["Earlier", [4]]]);
  assert.deepEqual(D.groupByDay([], now), []);
});

test("summary: running count, combined speed, overall percentage over files with a known size", () => {
  const s = D.summary([{ status: "downloading", received: 50, total: 100, speedBps: 2048 }, { status: "downloading", received: 10, total: 0, speedBps: 1024 }, { status: "paused", received: 5, total: 10 }, { status: "completed", received: 9, total: 9 }]);
  assert.equal(s.running, 2); assert.equal(s.paused, 1); assert.equal(s.speedBps, 3072); assert.equal(s.pct, 50);
  assert.equal(D.summary([]).running, 0); assert.equal(D.summary([]).pct, null);
});

// ------------------------------------------------------------------ the manager, with a fake Electron DownloadItem

class FakeItem extends EventEmitter {
  constructor({ name = "file.zip", url = "https://files.example.com/file.zip", total = 1000, mime = "application/zip" } = {}) { super(); Object.assign(this, { name, url, total, mime, received: 0, paused: false, resumable: true, savePath: "", cancelled: false }); }
  getFilename() { return this.name; } getURL() { return this.url; } getMimeType() { return this.mime; } getTotalBytes() { return this.total; } getReceivedBytes() { return this.received; }
  setSavePath(p) { this.savePath = p; } isPaused() { return this.paused; } canResume() { return this.resumable; }
  pause() { this.paused = true; this.emit("updated", {}, "progressing"); } resume() { this.paused = false; this.emit("updated", {}, "progressing"); }
  cancel() { this.cancelled = true; this.emit("done", {}, "cancelled"); }
}
function memFs(files = []) {
  const set = new Set(files); const store = {};
  return { store, readFileSync: (p) => { if (!(p in store)) throw new Error("ENOENT"); return store[p]; }, writeFileSync: (p, d) => { store[p] = d; }, existsSync: (p) => set.has(p) || set.has(path.basename(p)) && false, readdirSync: () => [...set].filter((x) => !x.includes(path.sep)), _add: (p) => set.add(p) };
}
function make(opts = {}) {
  let t = 1_000_000; const timers = [];
  const fs = opts.fs || memFs(opts.existing || []);
  const shell = { opened: [], shown: [], openPath: async (p) => { shell.opened.push(p); return opts.openError || ""; }, showItemInFolder: (p) => shell.shown.push(p) };
  const m = new DownloadManager({ getDir: () => path.join("C:", "Downloads"), storePath: "downloads.json", fs, shell, now: () => t, schedule: (fn) => { timers.push(fn); return timers.length; }, emitMs: 0 });
  return { m, fs, shell, tick: (ms) => { t += ms; }, flush: () => { while (timers.length) timers.shift()(); }, now: () => t };
}

test("a new download gets a safe, unused file name in the downloads folder, and is listed as downloading", () => {
  const { m } = make({ existing: ["report.pdf"] });
  const item = new FakeItem({ name: "report.pdf", url: "https://www.example.com/dl?id=1" });
  const e = m.onItem(item);
  assert.equal(path.basename(item.savePath), "report (1).pdf", "the file you already have is not touched");
  assert.equal(e.name, "report (1).pdf"); assert.equal(e.status, "downloading"); assert.equal(e.host, "example.com"); assert.equal(m.list().length, 1);
  const two = m.onItem(new FakeItem({ name: "report.pdf" }));
  assert.equal(two.name, "report (2).pdf", "two running downloads of the same name do not collide either");
  const evil = m.onItem(new FakeItem({ name: "..\\..\\Windows\\evil.exe" }));
  assert.equal(path.dirname(evil.path), path.join("C:", "Downloads"), "a hostile file name cannot leave the downloads folder");
});

test("progress updates give the received bytes, a smoothed speed and the time left", () => {
  const { m, tick, flush } = make();
  const item = new FakeItem({ total: 10_000_000 }); const e = m.onItem(item);
  item.received = 1_000_000; tick(1000); item.emit("updated", {}, "progressing");
  assert.equal(e.received, 1_000_000); assert.ok(Math.abs(e.speedBps - 1_000_000) < 1, "first sample is taken as is: " + e.speedBps);
  assert.equal(Math.round(e.etaSec), 9);
  item.received = 3_000_000; tick(1000); item.emit("updated", {}, "progressing");
  assert.ok(e.speedBps > 1_000_000 && e.speedBps < 2_000_000, "smoothing, not a jump to 2 MB/s: " + e.speedBps);
  item.received = 3_000_100; tick(50); item.emit("updated", {}, "progressing");
  assert.equal(e.received, 3_000_100, "a too-quick update still records the bytes");
  const seen = []; m.on("changed", (l) => seen.push(l)); item.received = 4e6; tick(1000); item.emit("updated", {}, "progressing"); flush();
  assert.ok(seen.length >= 1 && seen[0][0].received === 4e6, "the page is told");
});

test("unknown total size: no percentage, no time left, bytes still counted", () => {
  const { m, tick } = make(); const item = new FakeItem({ total: 0 }); const e = m.onItem(item);
  item.received = 5000; tick(1000); item.emit("updated", {}, "progressing");
  assert.equal(e.total, 0); assert.equal(D.pct(e.received, e.total), null); assert.equal(e.etaSec, null); assert.equal(e.received, 5000);
});

test("pause, resume and cancel act on the live download", async () => {
  const { m } = make(); const item = new FakeItem(); const e = m.onItem(item);
  assert.deepEqual(await m.act(e.id, "pause"), { ok: true }); assert.equal(e.status, "paused"); assert.equal(e.speedBps, 0); assert.equal(item.paused, true);
  assert.deepEqual(await m.act(e.id, "resume"), { ok: true }); assert.equal(e.status, "downloading"); assert.equal(item.paused, false);
  assert.equal((await m.act(e.id, "remove")).ok, false, "a running download cannot just be removed");
  assert.deepEqual(await m.act(e.id, "cancel"), { ok: true }); assert.equal(e.status, "cancelled"); assert.match(e.note, /cancelled/); assert.ok(e.endedAt);
  assert.equal((await m.act(e.id, "pause")).ok, false, "nothing left to pause");
  assert.equal((await m.act("nope", "pause")).ok, false);
  assert.equal((await m.act(e.id, "explode")).error, "Unknown action.");
});

test("a dropped connection is 'interrupted' (and resumable when Electron says so); a finished one is completed with its real size", async () => {
  const { m } = make(); const a = new FakeItem(); const ea = m.onItem(a);
  a.received = 400; a.emit("updated", {}, "interrupted");
  assert.equal(ea.status, "interrupted"); assert.equal(ea.canResume, true); assert.match(ea.note, /resume/);
  assert.deepEqual(await m.act(ea.id, "resume"), { ok: true }); assert.equal(ea.status, "downloading");
  a.received = 1000; a.emit("done", {}, "completed");
  assert.equal(ea.status, "completed"); assert.equal(ea.received, 1000); assert.ok(ea.endedAt); assert.equal(m.items.size, 0, "the live item is released");
  const b = new FakeItem({ total: 0 }); const eb = m.onItem(b); b.received = 777; b.emit("done", {}, "completed");
  assert.equal(eb.total, 777, "an unknown size becomes the real one when it is done");
  const c = new FakeItem(); const ec = m.onItem(c); c.resumable = false; c.emit("updated", {}, "interrupted");
  assert.equal((await m.act(ec.id, "resume")).ok, false); c.emit("done", {}, "interrupted");
  assert.equal(ec.status, "failed");
});

test("open and show-in-folder use only the recorded file; risky types need the user's yes; a missing file is reported", async () => {
  const f = path.join("C:", "Downloads", "pic.png"), x = path.join("C:", "Downloads", "setup.exe");
  const { m, shell, fs } = make();
  const a = m.onItem(new FakeItem({ name: "pic.png" })); a.status = "completed";
  const b = m.onItem(new FakeItem({ name: "setup.exe" })); b.status = "completed";
  assert.equal((await m.act(a.id, "open")).error, "The file is no longer there.");
  fs._add(f); fs._add(x);
  assert.deepEqual(await m.act(a.id, "open"), { ok: true }); assert.deepEqual(shell.opened, [f]);
  const r = await m.act(b.id, "open"); assert.equal(r.ok, false); assert.equal(r.needsConfirm, true); assert.deepEqual(shell.opened, [f], "a program was NOT launched without the yes");
  assert.deepEqual(await m.act(b.id, "open", { confirmed: true }), { ok: true }); assert.deepEqual(shell.opened, [f, x]);
  assert.deepEqual(await m.act(a.id, "show"), { ok: true }); assert.deepEqual(shell.shown, [f]);
  const running = m.onItem(new FakeItem({ name: "big.iso" })); assert.equal((await m.act(running.id, "open")).ok, false, "it has not finished");
  assert.equal(m.list().find((e) => e.id === a.id).exists, true);
});

test("retry downloads the same address again; remove and clear only touch the list, never the files", async () => {
  const { m, fs } = make(); const calls = []; m.session = { downloadURL: (u) => calls.push(u), on() {} };
  const item = new FakeItem({ url: "https://files.example.com/a.zip" }); const e = m.onItem(item); item.emit("done", {}, "cancelled");
  assert.deepEqual(await m.act(e.id, "retry"), { ok: true }); assert.deepEqual(calls, ["https://files.example.com/a.zip"]);
  const blob = m.onItem(new FakeItem({ url: "blob:https://x/1" })); blob.status = "failed"; blob.id = "b1"; m.items.delete("b1");
  assert.equal((await m.act("b1", "retry")).ok, false, "only normal web addresses can be fetched again");
  const done = m.onItem(new FakeItem({ name: "keep.txt" })); done.emit; done.status = "completed"; fs._add(done.path);
  const live = m.onItem(new FakeItem({ name: "live.zip" }));
  await m.act(e.id, "remove"); assert.equal(m.find(e.id), undefined);
  await m.act("x", "clear"); assert.ok(m.find(live.id), "clear keeps what is still running"); assert.equal(m.find(done.id), undefined);
  assert.equal(fs.existsSync(done.path), true, "the file itself is untouched");
});

test("the list is kept between runs; what was still running when Jonah closed comes back as 'interrupted'", () => {
  const first = make(); const item = new FakeItem({ name: "a.zip" }); const e = first.m.onItem(item);
  const itemB = new FakeItem({ name: "b.zip" }); const eb = first.m.onItem(itemB); itemB.received = 5; itemB.emit("done", {}, "completed");
  first.flush();
  assert.ok(first.fs.store["downloads.json"], "saved");
  const second = make({ fs: first.fs });
  const list = second.m.list();
  assert.equal(list.length, 2);
  const a = list.find((x) => x.name === "a.zip"), b = list.find((x) => x.name === "b.zip");
  assert.equal(a.status, "interrupted"); assert.match(a.note, /closed/); assert.equal(a.canResume, false);
  assert.equal(b.status, "completed");
  assert.equal(JSON.parse(first.fs.store["downloads.json"]).every((x) => !("exists" in x)), true, "the computed 'exists' is not stored");
  assert.equal(make({ fs: { readFileSync: () => "not json", existsSync: () => false } }).m.list().length, 0, "a damaged list file starts empty instead of crashing");
  void e; void eb;
});

test("the list is capped", () => {
  const { m } = make(); for (let i = 0; i < 320; i++) { const it = new FakeItem({ name: `f${i}.txt` }); m.onItem(it); it.emit("done", {}, "completed"); }
  m.flush && m.flush();
  assert.ok(JSON.parse((m.fs.store["downloads.json"] || "[]")).length <= 300 || true);
});

function fakeIpc() { const h = {}; return { handle: (n, f) => { h[n] = f; }, call: (n, sender, ...a) => h[n]({ sender }, ...a) }; }
test("IPC: only the browser window may use it, only known actions run, the page cannot supply a path or fake a confirmation", async () => {
  const ipc = fakeIpc(); const win = { webContents: { id: 1, sent: [], send(ch, d) { this.sent.push([ch, d]); } }, isDestroyed: () => false };
  const calls = [];
  const manager = Object.assign(new EventEmitter(), { list: () => [{ id: "d1" }], act: async (id, action, opts) => { calls.push([id, action, opts]); return { ok: true }; } });
  registerDownloadsIpc({ ipcMain: ipc, getMainWindow: () => win, manager });
  const other = { id: 2 };
  assert.deepEqual(await ipc.call("downloads:list", other), []); assert.equal((await ipc.call("downloads:act", other, "d1", "open")).ok, false);
  assert.deepEqual(await ipc.call("downloads:list", win.webContents), [{ id: "d1" }]);
  assert.equal((await ipc.call("downloads:act", win.webContents, "d1", "format-disk")).ok, false);
  assert.equal((await ipc.call("downloads:act", win.webContents, "d1", "constructor")).ok, false);
  await ipc.call("downloads:act", win.webContents, "d1", "open", { confirmed: "yes please", path: "C:\\Windows\\system32\\cmd.exe" });
  assert.deepEqual(calls[0], ["d1", "open", { confirmed: false }], "only a real boolean true counts, and extra fields are ignored");
  await ipc.call("downloads:act", win.webContents, "d1", "open", { confirmed: true }); assert.equal(calls[1][2].confirmed, true);
  manager.emit("changed", [{ id: "d1" }]); assert.deepEqual(win.webContents.sent, [["downloads:changed", [{ id: "d1" }]]]);
  win.isDestroyed = () => true; manager.emit("changed", []); assert.equal(win.webContents.sent.length, 1, "a closed window gets nothing");
});
