// downloads/manager.cjs - the download list: every file the browser saves, its live progress, speed and time left, and what can be done with it.
// It owns the list (the page only shows it), keeps it in a file so it survives a restart, and never overwrites a file you already have.
//
// Electron facts this relies on (measured): the `updated` event fires on progress with state "progressing" or "interrupted"; `done` ends with "completed", "cancelled" or
// "interrupted". A download is saved only when setSavePath is called - and then it goes straight to the folder with no dialog, so this picks a name that is not taken.
"use strict";

const EventEmitter = require("events");
const nodePath = require("path");
const core = require("../downloads-core.js");

const MAX_KEPT = 300;

class DownloadManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {() => string} o.getDir          the folder downloads go to (the user's Downloads folder)
   * @param {string} o.storePath             where the list is kept between runs
   * @param {object} o.fs                    node's fs (injected for tests)
   * @param {object} o.shell                 electron's shell: openPath, showItemInFolder
   * @param {() => number} [o.now]
   * @param {(fn: Function, ms: number) => any} [o.schedule]  setTimeout, injectable
   */
  constructor({ getDir, storePath, fs, shell, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), emitMs = 250 }) {
    super();
    Object.assign(this, { getDir, storePath, fs, shell, now, schedule, emitMs });
    this.entries = [];          // newest first
    this.items = new Map();     // id -> live Electron DownloadItem (only while running)
    this.session = null;
    this._emitTimer = null; this._saveTimer = null; this._seq = 0;
    this._load();
  }

  // ------------------------------------------------------------------ saved list
  _load() {
    try {
      const j = JSON.parse(this.fs.readFileSync(this.storePath, "utf8"));
      if (Array.isArray(j)) this.entries = j.filter((e) => e && e.id && e.name).slice(0, MAX_KEPT).map((e) => (core.isActive(e) ? { ...e, status: "interrupted", speedBps: 0, etaSec: null, note: "Jonah was closed before this finished.", canResume: false } : e));
    } catch (_) { this.entries = []; }
  }
  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = this.schedule(() => {
      try { this.fs.writeFileSync(this.storePath, JSON.stringify(this.entries.slice(0, MAX_KEPT).map((e) => ({ ...e, exists: undefined })), null, 1)); } catch (_) { /* a list that cannot be saved is just forgotten next time */ }
    }, 400);
  }
  _changed() {
    this._save();
    if (this._emitTimer) return;
    this._emitTimer = this.schedule(() => { this._emitTimer = null; this.emit("changed", this.list()); }, this.emitMs);
  }

  /** The list for the page. Finished files get `exists` (they may have been moved or deleted since). */
  list() {
    return this.entries.map((e) => ({ ...e, exists: e.status === "completed" ? this._exists(e.path) : undefined }));
  }
  _exists(p) { try { return !!p && this.fs.existsSync(p); } catch (_) { return false; } }

  // ------------------------------------------------------------------ a new download
  attach(ses) {
    this.session = ses;
    ses.on("will-download", (_event, item) => this.onItem(item));
  }

  _takenNames() {
    const dir = this.getDir(); const taken = new Set();
    try { for (const f of this.fs.readdirSync(dir)) taken.add(String(f).toLowerCase()); } catch (_) { /* folder unreadable: only the running ones count */ }
    for (const e of this.entries) if (core.isActive(e) && e.path && nodePath.dirname(e.path) === dir) taken.add(nodePath.basename(e.path).toLowerCase()); // a running download's file may not exist yet
    return taken;
  }

  onItem(item) {
    const name = core.uniqueName(core.safeName(item.getFilename()), this._takenNames());
    const savePath = nodePath.join(this.getDir(), name);
    item.setSavePath(savePath);
    const id = "d" + this.now().toString(36) + (++this._seq).toString(36);
    const e = { id, name, path: savePath, url: String(item.getURL() || ""), host: core.sourceHost(item.getURL()), mime: String(item.getMimeType ? item.getMimeType() || "" : ""),
      status: "downloading", received: 0, total: Math.max(0, item.getTotalBytes() || 0), speedBps: 0, etaSec: null, startedAt: new Date(this.now()).toISOString(), endedAt: "", canResume: false, note: "" };
    this.entries.unshift(e);
    this.items.set(id, item);
    let last = { t: this.now(), b: 0 };
    this.emit("started", { ...e });

    item.on("updated", (_ev, state) => {
      const t = this.now(), received = item.getReceivedBytes();
      e.received = received; e.total = Math.max(0, item.getTotalBytes() || e.total);
      if (state === "interrupted") { e.status = "interrupted"; e.speedBps = 0; e.etaSec = null; e.canResume = !!(item.canResume && item.canResume()); e.note = e.canResume ? "The connection dropped. You can resume it." : "The connection dropped."; this._changed(); return; }
      e.status = item.isPaused() ? "paused" : "downloading";
      e.note = "";
      if (e.status === "paused") { e.speedBps = 0; e.etaSec = null; last = { t, b: received }; }
      else if (t - last.t >= 400) {
        const inst = Math.max(0, ((received - last.b) / (t - last.t)) * 1000);
        e.speedBps = core.smooth(e.speedBps || null, inst);
        last = { t, b: received };
        e.etaSec = core.etaSec(received, e.total, e.speedBps);
      }
      this._changed();
    });
    item.once("done", (_ev, state) => {
      e.endedAt = new Date(this.now()).toISOString(); e.speedBps = 0; e.etaSec = null;
      if (state === "completed") { e.status = "completed"; e.received = e.total > 0 ? e.total : item.getReceivedBytes(); if (!e.total) e.total = e.received; e.note = ""; }
      else if (state === "cancelled") { e.status = "cancelled"; e.note = "You cancelled this download."; }
      else { e.status = "failed"; e.note = e.note || "The download did not finish."; }
      this.items.delete(id);
      this._changed();
      this.emit("finished", { ...e });
    });
    this._changed();
    return e;
  }

  // ------------------------------------------------------------------ what you can do
  find(id) { return this.entries.find((e) => e.id === String(id)); }
  /**
   * action: pause | resume | cancel | open | show | remove | retry | clear.  `confirmed` is the user's yes to opening a file type that can run code.
   * The file is always the one THIS list recorded - the page never supplies a path.
   */
  async act(id, action, { confirmed = false } = {}) {
    if (action === "clear") { this.entries = this.entries.filter((e) => core.isActive(e)); this._changed(); return { ok: true }; }
    const e = this.find(id);
    if (!e) return { ok: false, error: "That download is not in the list any more." };
    const item = this.items.get(e.id);
    switch (action) {
      case "pause": if (item && e.status === "downloading") { item.pause(); e.status = "paused"; e.speedBps = 0; e.etaSec = null; this._changed(); return { ok: true }; } return { ok: false, error: "It is not downloading." };
      case "resume": if (item && (e.status === "paused" || e.status === "interrupted") && item.canResume()) { item.resume(); e.status = "downloading"; e.note = ""; this._changed(); return { ok: true }; } return { ok: false, error: "This download cannot be resumed. Use Retry." };
      case "cancel": if (item) { item.cancel(); return { ok: true }; } return { ok: false, error: "It is not running." };
      case "retry": {
        if (core.isActive(e)) return { ok: false, error: "It is still running." };
        if (!/^https?:/i.test(e.url) || !this.session || !this.session.downloadURL) return { ok: false, error: "Jonah cannot download that address again." };
        this.session.downloadURL(e.url); return { ok: true };
      }
      case "remove": if (core.isActive(e)) return { ok: false, error: "Cancel it first." }; this.entries = this.entries.filter((x) => x.id !== e.id); this._changed(); return { ok: true };
      case "show": if (!this._exists(e.path)) return { ok: false, error: "The file is no longer there." }; this.shell.showItemInFolder(e.path); return { ok: true };
      case "open": {
        if (e.status !== "completed") return { ok: false, error: "It has not finished." };
        if (!this._exists(e.path)) return { ok: false, error: "The file is no longer there." };
        if (core.isRisky(e.name) && !confirmed) return { ok: false, needsConfirm: true, error: "This kind of file can run programs on your computer." };
        const err = await this.shell.openPath(e.path);
        return err ? { ok: false, error: String(err).slice(0, 120) } : { ok: true };
      }
      default: return { ok: false, error: "Unknown action." };
    }
  }
}

module.exports = { DownloadManager, MAX_KEPT };
