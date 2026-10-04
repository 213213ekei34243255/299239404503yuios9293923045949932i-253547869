// Noah/autonomy/service.cjs
//
// MissionService: the app-facing owner of missions. One mission at a time. It
//   * asks the USER for the folder Noah may work in (a native dialog: an explicit grant per mission, never a standing one),
//   * builds the mission (tools, verifier, lifecycle, runner) with the hosted brain behind `router.call("mission", ...)`,
//   * shows progress on the same single status line the browser agent uses (AgentSession), and routes the confirmation card,
//   * turns the outcome into a message that tells the truth (what was checked, what only was asserted, what failed),
//   * lets the user answer a question, say "continue" after a pause, or stop,
//   * brings a mission back after a restart (checkpoints) as PAUSED, never silently running again.
//
// Everything outside this file is injected (router, bus, session, confirmation card, folder dialog), so it is tested with the real runner and
// real tools against stand-ins for only the app's own pieces.

"use strict";

const { EventEmitter } = require("events");
const { randomUUID } = require("crypto");
const path = require("path");
const { createMission } = require("./mission-runner.cjs");
const { MissionStore } = require("./mission-store.cjs");
const { DesktopBridge } = require("../desktop/bridge.cjs");
const { groundingNote } = require("./answer-check.cjs");

const RECENT_MS = 2 * 60 * 60_000;
const clip = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n - 1) + "…" : String(s ?? ""));

/**
 * The message the user reads when a mission ends or stops. It never says "done" without the evidence, and it says so when files or program
 * output held text that looked like orders to an AI (decided by code, so it does not depend on the model choosing to mention it).
 */
function formatOutcome(o) {
  const text = outcomeText(o);
  const changes = changesBlock(o.changes);
  if (o.status === "cancelled" && text === "Stopped.") {
    // a stop can come half way through: say what had ALREADY been changed, so nobody has to guess what state the project is in
    return changes ? `${text}\n\nBefore it stopped, Noah had already changed these files (read from the files, not from the model's description):\n${changes}` : text;
  }
  const notes = [];
  // a report ("what is unread?") has no machine check: names, times and quotes in the answer that the model never wrote down as seen are flagged by code
  const ungrounded = o.status === "succeeded" ? groundingNote({ answer: o.summary, findings: o.findings, objective: o.objective }) : "";
  if (ungrounded) notes.push(ungrounded);
  if (changes) notes.push(`What actually changed (read from the files Noah edited, not from its own description):\n${changes}`);
  if (o.injection && o.injection.length) {
    const where = [...new Set(o.injection.map((f) => f.source).filter(Boolean))].slice(0, 3).join(", ") || "a file or program output";
    notes.push(`Heads-up: text in ${where} looked like instructions aimed at an AI. It is not from you. Noah treated it as untrusted data and switched to confirming more of what it does. Have a look at what it says, and at the files Noah changed.`);
  }
  // the checks were touched: a passing run after that proves less, and the model's own summary is not what tells the user
  if (o.testFilesChanged && o.testFilesChanged.length) {
    const list = o.testFilesChanged.slice(0, 6).join(", ") + (o.testFilesChanged.length > 6 ? ` (+${o.testFilesChanged.length - 6} more)` : "");
    notes.push(`Heads-up: Noah added or changed test files or test settings (${list}). A passing test run after the checks themselves were changed is weaker proof that the code works. Check that change.`);
  }
  return notes.length ? `${text}\n\n${notes.join("\n\n")}` : text;
}

/** The files Noah's file tools changed, with the lines that really differ. Capped: eight files, two changes each, about 1800 characters. */
function changesBlock(changes) {
  if (!Array.isArray(changes) || !changes.length) return "";
  const lines = [];
  for (const c of changes.slice(0, 8)) {
    lines.push(`• ${c.path}`);
    for (const d of (c.diffs || []).slice(-2)) for (const l of String(d).split("\n").slice(0, 7)) lines.push(`    ${l}`);
  }
  if (changes.length > 8) lines.push(`• … and ${changes.length - 8} more file${changes.length - 8 === 1 ? "" : "s"}`);
  return clip(lines.join("\n"), 1800);
}

function outcomeText(o) {
  const files = o.filesChanged && o.filesChanged.length ? `Files changed: ${o.filesChanged.slice(0, 12).join(", ")}${o.filesChanged.length > 12 ? ` (+${o.filesChanged.length - 12} more)` : ""}.` : "";
  switch (o.status) {
    case "succeeded":
      return [clip(o.summary || "Done.", 1200), o.verification ? `What Noah checked itself:\n${clip(o.verification, 1500)}` : "", files].filter(Boolean).join("\n\n");
    case "blocked_input":
    case "blocked_permission":
      return `${clip(o.reason, 600)}\n\nReply with your answer and I will carry on.`;
    case "budget_paused":
      return `${clip(o.reason, 600)}${o.verification ? `\n\nWhere the checks stand:\n${clip(o.verification, 1000)}` : ""}\n\nSay "continue" to carry on, or stop.`;
    case "budget_exhausted":
      return `${clip(o.reason, 600)}${o.verification ? `\n\nWhere the checks stood:\n${clip(o.verification, 1000)}` : ""}${files ? `\n\n${files}` : ""}`;
    case "impossible":
      return `I could not do this: ${clip(o.reason, 800)}${o.verification ? `\n\nWhere the checks stand:\n${clip(o.verification, 1000)}` : ""}${files ? `\n\n${files}` : ""}`;
    case "unsafe":
      return `I stopped because of a safety rule: ${clip(o.reason, 600)}`;
    case "cancelled":
      return o.reason && o.reason !== "stopped by the user" ? clip(o.reason, 400) : "Stopped.";
    default:
      return clip(o.reason || "The task ended.", 600);
  }
}

class MissionService extends EventEmitter {
  /**
   * @param {object} o
   * @param {{ usable: Function, call: Function }} o.router           the model router (role "mission")
   * @param {{ bus: any, session: any, safety: { confirm: Function, denyAllPending: Function } }} o.core
   * @param {string} o.dataDir
   * @param {(info: { goal: string }) => Promise<string|null>} o.pickFolder   asks the user for a folder; null = they declined
   * @param {() => string} [o.getMode]
   * @param {Function} [o.create]  createMission (replaceable in tests)
   */
  constructor({ router, core, dataDir, pickFolder, getMode = () => "autonomous", create = createMission, limits, log = () => {}, now = Date.now, desktop = process.platform === "win32" || process.platform === "darwin", makeBridge = () => new DesktopBridge({ log }), checkPermissions = () => ({ ok: true }) }) {
    super();
    Object.assign(this, { router, core, dataDir, pickFolder, getMode, create, limits, log, now, desktop: !!desktop, makeBridge, checkPermissions });
    this._bridge = null; // the one helper that sees and operates the desktop (Windows or Mac): started with the first desktop task, killed by Stop, gone with the app
    this.store = dataDir ? new MissionStore({ dir: path.join(dataDir, "missions") }) : null;
    this.current = null; // { id, runner, controller, running, goal, source, endedAt }
    try {
      if (this.store) this.store.markInterrupted();
      if (this.store) this.store.prune();
    } catch (_) {
      /* a damaged store must never stop the app */
    }
  }

  isAvailable() {
    try {
      return this.router.usable("mission").length > 0;
    } catch (_) {
      return false;
    }
  }

  /** Can Noah operate the computer's desktop? (Windows or macOS, and only when the app turned it on.) */
  isDesktopAvailable() {
    return this.desktop && this.isAvailable();
  }

  /** The desktop helper, started on first use. */
  desktopBridge() {
    if (!this._bridge) this._bridge = this.makeBridge();
    return this._bridge;
  }

  isRunning() {
    return !!(this.current && this.current.running);
  }

  /** A mission stopped and waiting for the user (a question, a pause, a budget): the next message can resume it. */
  _waiting() {
    const c = this.current;
    return !!(c && !c.running && c.runner && c.runner.lc.terminal && c.runner.lc.terminal.resumable && this.now() - c.endedAt < RECENT_MS);
  }

  /** The mission asked a question and is waiting for the answer (as opposed to merely being paused). */
  awaitingAnswer() {
    return this._waiting() && ["blocked_input", "blocked_permission"].includes(this.current.runner.lc.terminal.kind);
  }

  hasResumable() {
    return this._waiting();
  }

  // --------------------------------------------------------------------------------------------------- starting

  /** Start a mission for `goal`. Returns at once; the work, the folder dialog and the outcome all happen asynchronously. */
  start(goal, { source = "text", ticket, kind = "project" } = {}) {
    if (this.isRunning()) return { ok: false, reply: "A project task is already running. Say \"stop\" first, or wait for it to finish." };
    const id = randomUUID();
    const controller = new AbortController();
    if (kind === "desktop" && !this.isDesktopAvailable()) return { ok: false, reply: "I can only operate the desktop on Windows and macOS, and only while a model is available." };
    if (kind === "desktop") {
      // on a Mac the user must first allow Jonah to control the computer: say exactly what to do, instead of starting a task that cannot work
      let allowed;
      try { allowed = this.checkPermissions(); } catch (_) { allowed = { ok: true }; } // a failing check must not stop the task: the helper reports a missing permission itself
      if (allowed && allowed.ok === false) return { ok: false, reply: allowed.reply };
    }
    this.current = { id, goal: String(goal), source, ticket, kind, controller, running: true, runner: null, endedAt: 0 };
    this.core.session.runStarted({ runId: id, taskId: id, goal: String(goal), source, followUp: false });
    this._begin(this.current).catch((err) => this._failed(this.current, err));
    return { ok: true, id };
  }

  async _begin(cur) {
    let folder = null;
    const desktop = cur.kind === "desktop"; // a job on the user's apps: there is no project folder to ask for
    if (!desktop) {
      try {
        folder = await this.pickFolder({ goal: cur.goal });
      } catch (err) {
        this.log("folder dialog failed:", err && err.message);
      }
    }
    if (cur.controller.signal.aborted) return this._end(cur, { status: "cancelled", reason: "stopped by the user", resumable: false });
    if (!desktop && !folder) return this._end(cur, { status: "cancelled", reason: "No folder was chosen, so I did not start. I only work inside a folder you pick. (If you meant something in the browser, say so.)", resumable: false });
    cur.runner = this.create({
      id: cur.id, objective: cur.goal, roots: desktop ? [] : [folder], ticket: cur.ticket, dataDir: this.dataDir, limits: this.limits, mode: this.getMode(), bus: this._bus(), desktopBridge: desktop ? this.desktopBridge() : null,
      callModel: (req, o) => this.router.call("mission", req, { signal: o && o.signal, sensitive: false }),
      confirm: (req) => this.core.safety.confirm(req),
    });
    this.core.session.runExecuting("Working on your project");
    await this._run(cur);
  }

  /** Mission events go to the app's bus (and on to the panel) with their own names. */
  _bus() {
    return { publish: (event, payload) => this.core.bus.publish(event, payload) };
  }

  async _run(cur) {
    cur.running = true;
    const outcome = await cur.runner.run({ signal: cur.controller.signal });
    this._end(cur, outcome);
  }

  _end(cur, outcome) {
    cur.running = false;
    cur.endedAt = this.now();
    const text = formatOutcome(outcome);
    const waiting = !!outcome.resumable;
    if (waiting) this.core.session.paused("waiting");
    else this.core.session.runFinished(outcome.status === "succeeded" ? "completed" : outcome.status === "cancelled" ? "cancelled" : "failed", { result: text, error: outcome.status === "succeeded" || outcome.status === "cancelled" ? undefined : text });
    this.core.bus.publish("mission_result", { missionId: cur.id, status: outcome.status, resumable: waiting, text, source: cur.source });
    this.emit("ended", { ...outcome, text });
  }

  _failed(cur, err) {
    this.log("mission failed to start:", err && err.stack);
    if (cur) this._end(cur, { status: "impossible", reason: `Something went wrong starting the task: ${clip((err && err.message) || err, 200)}`, resumable: false });
  }

  // --------------------------------------------------------------------------------------------------- the user steers

  /** The user answered the mission's question (or gave a hint). */
  answer(text, { source = "text" } = {}) {
    if (!this._waiting()) return { ok: false, reply: "There is no project task waiting for an answer." };
    return this._resume(text, source);
  }

  /** "Continue": carry on a paused or blocked mission (in this session, or the latest saved one after a restart). */
  resume({ source = "text" } = {}) {
    if (this._waiting()) return this._resume("", source);
    const saved = this.store && this.store.list({ limit: 1 }).find((m) => m.resumable);
    if (!saved) return { ok: false, reply: "There is no project task to continue." };
    return this._restore(saved.id, source);
  }

  _resume(answer, source) {
    const cur = this.current;
    cur.source = source;
    cur.controller = new AbortController();
    cur.runner.resume({ answer: answer || undefined });
    this.core.session.resumed();
    this._run(cur).catch((err) => this._failed(cur, err));
    return { ok: true, id: cur.id };
  }

  _restore(id, source) {
    if (this.isRunning()) return { ok: false, reply: "A project task is already running." };
    const record = this.store.load(id);
    if (!record) return { ok: false, reply: "I could not load that saved task." };
    const controller = new AbortController();
    const cur = { id, goal: record.objective, source, kind: record.desktop ? "desktop" : "project", controller, running: true, runner: null, endedAt: 0 };
    this.current = cur;
    try {
      cur.runner = this.create({
        id, objective: record.objective, roots: record.roots, restore: record, ticket: record.ticket, dataDir: this.dataDir, limits: this.limits, mode: this.getMode(), bus: this._bus(), desktopBridge: record.desktop && this.isDesktopAvailable() ? this.desktopBridge() : null,
        callModel: (req, o) => this.router.call("mission", req, { signal: o && o.signal, sensitive: false }),
        confirm: (req) => this.core.safety.confirm(req),
      });
      if (!cur.runner.roots.length && !record.desktop) throw new Error("the folder this task worked in is no longer available");
      cur.runner.resume({ answer: undefined });
    } catch (err) {
      this.current = null;
      return { ok: false, reply: `I could not continue that task: ${clip((err && err.message) || err, 200)}` };
    }
    this.core.session.runStarted({ runId: id, taskId: id, goal: record.objective, source, followUp: true });
    this.core.session.runExecuting("Continuing your project task");
    this._run(cur).catch((err) => this._failed(cur, err));
    return { ok: true, id };
  }

  /** Stop a running mission: its running command is killed, and any open confirmation card is answered "no". */
  stop() {
    const c = this.current;
    if (!c || !c.running) return { ok: false };
    c.controller.abort();
    if (this._bridge) { try { this._bridge.stop(); } catch (_) { /* already gone */ } } // typing or a mouse glide in progress stops at once; the helper starts fresh on its next use
    try {
      this.core.safety.denyAllPending("stopped");
    } catch (_) {
      /* nothing was pending */
    }
    return { ok: true };
  }

  /** The app is closing: nothing may be left running. */
  dispose() {
    try { this.stop(); } catch (_) { /* nothing running */ }
    if (this._bridge) { try { this._bridge.dispose(); } catch (_) { /* gone */ } this._bridge = null; }
  }

  /** Pause a running mission: like stop, but it ends as a PAUSE that can be continued, with its progress saved. */
  pause() {
    const c = this.current;
    if (!c || !c.running || !c.runner) return { ok: false };
    c.runner.requestPause();
    return this.stop();
  }

  /** Whether "continue" has something to continue: a mission waiting in this session, or the latest saved one. */
  canResume() {
    if (this.isRunning()) return false;
    if (this._waiting()) return true;
    try {
      return !!(this.store && this.store.list({ limit: 1 }).some((m) => m.resumable));
    } catch (_) {
      return false;
    }
  }

  list() {
    return this.store ? this.store.list() : [];
  }
}

module.exports = { MissionService, formatOutcome };
