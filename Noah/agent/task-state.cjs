// Noah/agent/task-state.cjs
//
// Long-running task support (spec §18): every task has an id, a goal, a plan, a current step, a
// history, browser state and a failure reason, and is CHECKPOINTED to disk after every step with an
// atomic write. If Jonah crashes or is closed mid-task the task is found again on next start as
// "interrupted" and can be resumed (re-observe -> continue) instead of being lost.
//
// Screenshots are never persisted (privacy + size); only the tiny textual state needed to resume.

"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const MAX_HISTORY = 60;

class TaskStore {
  constructor({ dir }) {
    this.dir = dir;
    if (dir) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {
        /* ignore */
      }
    }
  }

  create(goal, opts = {}) {
    const now = Date.now();
    const task = {
      id: opts.id || randomUUID(),
      goal,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      plan: null,
      step: 0,
      completedSteps: [],
      history: [], // [{ step, summary, method, actions:[{action,ok,code,message,verdict}] }]
      browserState: { tabId: null, url: null, title: null },
      lastAction: null,
      failureReason: null,
      nextAction: null,
      memory: null,
      sensitive: false,
      taint: { tainted: false, reasons: [] },
      budgets: { steps: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, screenshots: 0, actions: 0, failures: 0, recoveries: 0, startedAt: now },
      result: null,
      checkpointSeq: 0,
      resumedFrom: opts.resumedFrom || null,
    };
    return task;
  }

  _file(id) {
    return path.join(this.dir, `${String(id).replace(/[^\w-]/g, "")}.json`);
  }

  /** Atomic write: never leaves a half-written checkpoint. */
  save(task) {
    if (!this.dir) return false;
    try {
      task.updatedAt = Date.now();
      task.checkpointSeq++;
      if (task.history.length > MAX_HISTORY) task.history = task.history.slice(-MAX_HISTORY);
      const f = this._file(task.id);
      fs.writeFileSync(f + ".tmp", JSON.stringify(task));
      fs.renameSync(f + ".tmp", f);
      return true;
    } catch (_) {
      return false;
    }
  }

  load(id) {
    try {
      return JSON.parse(fs.readFileSync(this._file(id), "utf8"));
    } catch (_) {
      return null;
    }
  }

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
        const t = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8"));
        out.push({ id: t.id, goal: t.goal, status: t.status, updatedAt: t.updatedAt, step: t.step, failureReason: t.failureReason, resumable: !TERMINAL.has(t.status) });
      } catch (_) {
        /* skip corrupt */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  /** On startup: anything left "running" belonged to a process that died. Mark it resumable. */
  markInterrupted() {
    let n = 0;
    for (const t of this.list({ limit: 200 })) {
      if (["running", "planning", "observing", "executing", "verifying", "recovering", "awaiting_confirmation", "queued"].includes(t.status)) {
        const full = this.load(t.id);
        if (full) {
          full.status = "interrupted";
          full.failureReason = full.failureReason || "Jonah closed or crashed while this task was running";
          this.save(full);
          n++;
        }
      }
    }
    return n;
  }

  /** Delete terminal checkpoints older than `days` (keeps the folder small). */
  prune(days = 14) {
    const cutoff = Date.now() - days * 86400_000;
    for (const t of this.list({ limit: 1000 })) {
      if (TERMINAL.has(t.status) && t.updatedAt < cutoff) {
        try {
          fs.unlinkSync(this._file(t.id));
        } catch (_) {
          /* ignore */
        }
      }
    }
  }
}

module.exports = { TaskStore, TERMINAL };
