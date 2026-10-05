// Noah/autonomy/mission-store.cjs
//
// MissionStore: missions are checkpointed to disk after every round with an atomic write (temp file + rename), so closing Jonah, a crash or
// a power cut loses at most the round in progress. On the next start, a mission that was still running is found again as PAUSED (resumable),
// never silently lost and never silently restarted. (The same idea as agent/task-state.cjs for browser tasks.)
//
// A record holds the whole MissionState snapshot, the lifecycle snapshot, the folders the user granted for it, and the few runner facts
// needed to carry on (notices waiting for the next round, whether instruction-like text was met). Tool output and file contents are NOT
// stored: they are already summarised in the state, and the full command logs live next to it in their own folder.

"use strict";

const fs = require("fs");
const path = require("path");

const VERSION = 1;

class MissionStore {
  constructor({ dir }) {
    this.dir = dir;
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {
        /* reported by save() returning false */
      }
    }
  }

  _file(id) {
    return path.join(this.dir, `${String(id).replace(/[^\w-]/g, "")}.json`);
  }

  /** Atomic: a half-written checkpoint never exists. Returns false (never throws) when the disk refuses. */
  save(record) {
    if (!this.dir || !record || !record.id) return false;
    try {
      const f = this._file(record.id);
      fs.writeFileSync(f + ".tmp", JSON.stringify({ ...record, version: VERSION, savedAt: Date.now() }));
      fs.renameSync(f + ".tmp", f);
      return true;
    } catch (_) {
      return false;
    }
  }

  load(id) {
    try {
      const r = JSON.parse(fs.readFileSync(this._file(id), "utf8"));
      return r && r.version === VERSION ? r : null;
    } catch (_) {
      return null;
    }
  }

  /** Newest first. Just enough for a list in the UI. */
  list({ limit = 30 } = {}) {
    if (!this.dir) return [];
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch (_) {
      return [];
    }
    const out = [];
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
        const t = r.lifecycle && r.lifecycle.terminal;
        out.push({ id: r.id, objective: r.objective, status: t ? t.kind : "running", reason: t ? t.reason : "", resumable: !!(t && t.resumable), iterations: r.state && r.state.counters ? r.state.counters.iterations : 0, updatedAt: r.savedAt || 0 });
      } catch (_) {
        /* a corrupt file is skipped, not fatal */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  /** At start-up: whatever was still running belonged to a process that is gone. Make it a paused, resumable mission. */
  markInterrupted() {
    let n = 0;
    for (const s of this.list({ limit: 500 })) {
      if (s.status !== "running") continue;
      const r = this.load(s.id);
      if (!r) continue;
      r.lifecycle = { ...r.lifecycle, terminal: { kind: "budget_paused", reason: "Jonah was closed while this mission was running; its progress is saved", resumable: true, at: Date.now() } };
      if (this.save(r)) n++;
    }
    return n;
  }

  remove(id) {
    try {
      fs.unlinkSync(this._file(id));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Delete finished (non-resumable) missions older than `days`. */
  prune(days = 30) {
    const cutoff = Date.now() - days * 86400_000;
    for (const s of this.list({ limit: 1000 })) if (s.status !== "running" && !s.resumable && s.updatedAt < cutoff) this.remove(s.id);
  }
}

module.exports = { MissionStore, VERSION };
