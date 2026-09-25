// Noah/safety/audit.cjs
//
// Append-only action audit log (JSON Lines), one file per day. Records what
// Noah decided and did, never page content or screenshots, and redacts typed
// text. Purpose: after-the-fact review of "what did the agent do on my
// behalf?" independent of any UI.

"use strict";

const fs = require("fs");
const path = require("path");

class AuditLog {
  constructor({ dir, enabled = true, maxBytesPerFile = 5_000_000 } = {}) {
    this.dir = dir;
    this.enabled = enabled && !!dir;
    this.maxBytes = maxBytesPerFile;
    this._ready = false;
  }

  _file() {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return path.join(this.dir, `noah-${day}.jsonl`);
  }

  record(entry) {
    if (!this.enabled) return false;
    try {
      if (!this._ready) {
        fs.mkdirSync(this.dir, { recursive: true });
        this._ready = true;
      }
      const file = this._file();
      try {
        if (fs.statSync(file).size > this.maxBytes) return false; // bounded; never grows unbounded
      } catch (_) {
        /* new file */
      }
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
      fs.appendFileSync(file, line, "utf8");
      return true;
    } catch (_) {
      return false; // auditing must never break the agent
    }
  }

  /** Redacted action summary safe to persist. */
  static summarizeAction(action) {
    const a = { action: action.action };
    for (const k of ["target", "from", "to", "url", "key", "combo", "direction", "amount", "tab_id", "query", "intent", "reason"]) {
      if (action[k] !== undefined) a[k] = typeof action[k] === "string" ? action[k].slice(0, 160) : action[k];
    }
    if (typeof action.text === "string") a.textLength = action.text.length;
    if (typeof action.value === "string") a.valueLength = action.value.length;
    if (action.path) a.path = String(action.path).slice(0, 200);
    return a;
  }

  tail(n = 50) {
    try {
      const lines = fs.readFileSync(this._file(), "utf8").trim().split("\n");
      return lines.slice(-n).map((l) => JSON.parse(l));
    } catch (_) {
      return [];
    }
  }
}

module.exports = { AuditLog };
