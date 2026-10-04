// Noah/autonomy/working-set.cjs
//
// WorkingSet: the contents of the files the mission has recently READ, kept in the briefing so the model edits what is really there instead of
// what it remembers. Found by a live run: with only a one-line note left of a file it read two rounds earlier, the real model "edited" text
// that was not in the file (it guessed `export * from './util'` for a file that said `require('./util')`) in all three scenarios, wasting a round
// each time. The edit guard refused every guess, which is why it was only a wasted round, but a guess that happened to match would not be.
//
//   * remember()  after a successful fs_read;  touch()/drop()  after an edit, write or delete
//   * refresh()   before each round: a file that changed on disk (an edit, or a COMMAND such as a formatter or a build) is read again, a deleted
//                 file is forgotten, so what the model sees is always current
//   * entries()   newest-used first, within a character budget and a per-file cap (cut at a line boundary and said so); files read THIS round are
//                 left out because the round's own results already show them in full
//
// Pure bookkeeping over two injected functions (stat and read), so it is tested without a disk. Not persisted: after a restart the model reads again.

"use strict";

const MAX_ENTRIES = 10;

class WorkingSet {
  /**
   * @param {object} o
   * @param {(path: string) => { mtimeMs: number, size: number } | null} o.statOf   null when the file is gone or not allowed
   * @param {(path: string, args: { offset?: number, limit?: number }) => Promise<object>} o.readFile   an fs_read-shaped result
   * @param {number} [o.maxChars]   0 disables the working set
   * @param {number} [o.perFile]
   */
  constructor({ statOf, readFile, maxChars = 12000, perFile = 6000 }) {
    this.statOf = statOf;
    this.readFile = readFile;
    this.maxChars = maxChars;
    this.perFile = perFile;
    this.map = new Map(); // display path -> entry
    this._clock = 0;
  }

  get enabled() {
    return this.maxChars > 0;
  }

  /** @param {{ offset?: number, limit?: number }} args  @param {object} result a successful fs_read result */
  remember(args, result) {
    if (!this.enabled || !result || !result.ok || typeof result.content !== "string") return;
    this.map.set(result.path, {
      path: result.path, content: result.content, startLine: result.startLine, endLine: result.endLine, totalLines: result.totalLines, truncated: !!result.truncated,
      args: { ...(args && args.offset ? { offset: args.offset } : {}), ...(args && args.limit ? { limit: args.limit } : {}) },
      stat: this.statOf(result.path), dirty: false, usedAt: ++this._clock,
    });
    this._trim();
  }

  /** The file was changed by the mission's own tool: it will be read again before the next round. */
  touch(path) {
    const e = this.map.get(path);
    if (e) { e.dirty = true; e.usedAt = ++this._clock; }
  }

  drop(path) {
    this.map.delete(path);
  }

  _trim() {
    if (this.map.size <= MAX_ENTRIES) return;
    const oldest = [...this.map.values()].sort((a, b) => a.usedAt - b.usedAt).slice(0, this.map.size - MAX_ENTRIES);
    for (const e of oldest) this.map.delete(e.path);
  }

  /** Bring every entry up to date with the disk. */
  async refresh() {
    if (!this.enabled) return;
    for (const e of [...this.map.values()]) {
      const st = this.statOf(e.path);
      if (!st) { this.map.delete(e.path); continue; }
      if (!e.dirty && e.stat && st.mtimeMs === e.stat.mtimeMs && st.size === e.stat.size) continue;
      let r = null;
      try { r = await this.readFile(e.path, e.args); } catch (_) { /* treated as unreadable */ }
      if (!r || !r.ok) { this.map.delete(e.path); continue; }
      Object.assign(e, { content: r.content, startLine: r.startLine, endLine: r.endLine, totalLines: r.totalLines, truncated: !!r.truncated, stat: this.statOf(e.path), dirty: false, usedAt: ++this._clock });
    }
  }

  /**
   * What to show, newest-used first, inside the budget.
   * @param {{ skipPaths?: Set<string>|string[] }} [o]
   * @returns {{ path: string, content: string, startLine: number, endLine: number, totalLines: number, partial: boolean }[]}
   */
  entries({ skipPaths = [] } = {}) {
    if (!this.enabled) return [];
    const skip = new Set(skipPaths);
    const out = [];
    let used = 0;
    for (const e of [...this.map.values()].sort((a, b) => b.usedAt - a.usedAt)) {
      if (skip.has(e.path)) continue;
      const room = Math.min(this.perFile, this.maxChars - used);
      if (room < 300) break;
      let content = e.content;
      let partial = e.truncated;
      let endLine = e.endLine;
      if (content.length > room) {
        const cut = content.lastIndexOf("\n", room);
        content = content.slice(0, cut > 0 ? cut : room);
        endLine = e.startLine + content.split("\n").length - 1;
        partial = true;
      }
      used += content.length;
      out.push({ path: e.path, content, startLine: e.startLine, endLine, totalLines: e.totalLines, partial });
    }
    return out;
  }
}

module.exports = { WorkingSet, MAX_ENTRIES };
