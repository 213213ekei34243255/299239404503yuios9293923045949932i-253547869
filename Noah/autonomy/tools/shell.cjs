// Noah/autonomy/tools/shell.cjs
//
// ShellTool: run a command for a mission, safely and with a result a model can reason about.
//
//   cwd must be inside the workspace  ->  command-policy classifies it (blocked is refused, high is confirmed under the user's mode)
//   ->  anti-repeat gate: the SAME failed command with nothing changed since is refused, not run again
//   ->  spawn with a SCRUBBED environment (Jonah's own keys never reach a child), no stdin (nothing can wait for input), CI=1
//   ->  a timeout kills the whole process TREE (a dev server's children too), as does an abort
//   ->  the output is cleaned (colour codes, progress-bar rewrites), kept whole in a log file when it is long, and shown to the
//       model as head + tail, because the reason a command failed is nearly always at the end
//   ->  the run is recorded in MissionState (and bumps sourceVersion only if the command may change files)
//
// Every failure is a normal result ({ ok:false, code, message }), never an exception: the model reads it and decides what to do.

"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { classifyCommand, decideCommand } = require("./command-policy.cjs");
const { PolicyError } = require("./workspace.cjs");
const { diagnose } = require("../diagnoser.cjs");

const DEFAULT_TIMEOUT_MS = 120_000;
const SERVER_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_CAPTURE = 4 * 1024 * 1024; // what is kept in memory
const MAX_LOG = 16 * 1024 * 1024; // what is written to the log file
const SHOW_HEAD = 3000;
const SHOW_TAIL = 9000;
const GRACE_AFTER_EXIT_MS = 1500; // a grandchild can keep the pipes open after the command itself has ended

const ENV_KEEP = new Set(["path", "pathext", "systemroot", "systemdrive", "windir", "comspec", "temp", "tmp", "tmpdir", "home", "userprofile", "homedrive", "homepath", "appdata", "localappdata", "programdata", "programfiles", "programfiles(x86)", "programw6432", "commonprogramfiles", "commonprogramfiles(x86)", "commonprogramw6432", "number_of_processors", "os", "processor_architecture", "lang", "lc_all", "term", "shell", "user", "username", "logname", "computername", "userdomain", "public"]);

/** Only what a build tool needs to find itself; none of Jonah's own environment (API keys, tokens) is passed on. */
function cleanEnv(extra = {}) {
  const env = {};
  for (const k of Object.keys(process.env)) if (ENV_KEEP.has(k.toLowerCase())) env[k] = process.env[k];
  return { ...env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", npm_config_update_notifier: "false", npm_config_fund: "false", ...extra };
}

/** Kill a process and everything it started. */
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch (_) {
    try { child.kill("SIGKILL"); } catch (__) { /* already gone */ }
  }
}

/** Colour codes out; a line rewritten with \r (progress bars) keeps only its last version. */
function cleanOutput(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .split("\n")
    .map((line) => (line.includes("\r") ? line.replace(/\r+$/, "").split("\r").pop() : line))
    .join("\n");
}

/** Head and tail of a long output with the cut announced. */
function elide(text, head = SHOW_HEAD, tail = SHOW_TAIL) {
  if (text.length <= head + tail + 200) return { text, elided: false };
  const lines = text.slice(head, text.length - tail).split("\n").length;
  return { text: `${text.slice(0, head)}\n... [${lines} lines (${text.length - head - tail} characters) not shown] ...\n${text.slice(text.length - tail)}`, elided: true };
}

class ShellTool {
  /**
   * @param {object} o
   * @param {import('./workspace.cjs').Workspace} o.workspace
   * @param {import('../mission-state.cjs').MissionState} o.state
   * @param {(req: { summary: string, why: string, risk: object }) => Promise<boolean>} [o.confirm]  the confirmation card; absent = every confirmation is refused
   * @param {() => string} [o.getMode]  autonomous | supervised | strict
   * @param {string} [o.logDir]  where long outputs are kept whole
   */
  constructor({ workspace, state, confirm, getMode = () => "autonomous", logDir = null }) {
    this.workspace = workspace;
    this.state = state;
    this.confirm = confirm || (async () => false);
    this.getMode = getMode;
    this.logDir = logDir;
    this._n = 0;
    this._retried = new Map(); // "cmd|cwd|version" -> retries used
  }

  /**
   * @param {{ cmd: string, cwd?: string, timeoutMs?: number, retry?: boolean }} args
   * @param {{ signal?: AbortSignal, bypassRepeat?: boolean }} [opts]  bypassRepeat is for the verifier: a check must be re-runnable
   */
  async run({ cmd, cwd, timeoutMs, retry = false }, { signal, bypassRepeat = false } = {}) {
    let real;
    try {
      real = this.workspace.resolve(cwd || ".");
      if (!fs.statSync(real).isDirectory()) throw new PolicyError(`${cwd} is not a folder`, "invalid_path");
    } catch (err) {
      return { ok: false, code: err.code === "ENOENT" ? "invalid_path" : err.code || "invalid_path", message: err.code === "ENOENT" ? `the folder ${cwd} does not exist` : err.message };
    }
    const where = this.workspace.display(real);
    const cls = classifyCommand(cmd, { workspace: this.workspace, cwd: real });
    const verdict = decideCommand(cls, { mode: this.getMode() });
    const info = { level: cls.risk.level, kinds: cls.kinds };

    if (verdict.decision === "deny") return { ok: false, code: "blocked", message: `Noah will not run this: ${verdict.why}. Do not try to get the same effect another way.`, classification: info };

    if (!bypassRepeat) {
      const prior = this.state.repeatOf(cmd, where);
      if (prior) {
        // keyed on Noah's own edits, NOT sourceVersion: a retried script is itself a "mutating" command and would reset its own budget
        const key = `${cmd}|${where}|${this.state.counters.fileChanges || 0}`;
        const used = this._retried.get(key) || 0;
        if (!(retry && used < 1)) {
          return { ok: false, code: "repeat_blocked", message: `You already ran this exact command${prior.timedOut ? " (it timed out)" : ` (exit ${prior.exitCode})`} and nothing has changed since, so it would fail the same way. Change something first (edit a file, fix a dependency, adjust the command), or run a different diagnostic. If the failure was only temporary (a network error, a server that was not ready yet) run it again with retry:true.`, previous: { exitCode: prior.exitCode, timedOut: prior.timedOut, tail: prior.tail, diagnosis: prior.diagnosis }, classification: info };
        }
        this._retried.set(key, used + 1);
      }
    }

    if (verdict.decision === "confirm") {
      let allowed = false;
      try {
        allowed = await this.confirm({ summary: `Run: ${String(cmd).slice(0, 200)}`, why: verdict.why, risk: cls.risk });
      } catch (_) {
        allowed = false;
      }
      if (!allowed) return { ok: false, code: "user_denied", message: "The user declined this command. Do not run it another way: explain, offer an alternative, or stop.", classification: info };
    }
    if (signal && signal.aborted) return { ok: false, code: "aborted", message: "stopped before it started" };

    const effective = Math.min(Math.max(Number(timeoutMs) || (cls.longRunning ? SERVER_TIMEOUT_MS : DEFAULT_TIMEOUT_MS), 1000), MAX_TIMEOUT_MS);
    const r = await this._spawn(cmd, real, effective, signal);

    const cleaned = cleanOutput(r.output);
    const shown = elide(cleaned);
    let outputPath = null;
    if ((shown.elided || r.truncated) && this.logDir) outputPath = this._writeLog(cmd, cleaned);
    const tail = shown.text.split("\n").filter((l) => l.trim()).slice(-4).join("\n");
    const ok = r.exitCode === 0 && !r.timedOut && !r.aborted;
    // WHY it failed: diagnosed from the WHOLE output (not the elided view), and counted by signature so "the same failure again" is a fact
    const why = ok || r.aborted ? null : diagnose({ cmd, exitCode: r.exitCode, output: cleaned, timedOut: r.timedOut, cwd: real });
    this.state.recordCommand({ cmd, cwd: where, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, tail, diagnosis: why ? why.summary : "", mutates: cls.mutates, kind: cls.kinds[0] });
    const out = { ok, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, cwd: where, output: shown.text, elided: shown.elided, truncated: r.truncated, classification: info };
    if (why) {
      const occurrences = this.state.recordError({ signature: why.signature, kind: why.kind, message: why.summary, hint: why.hint });
      out.diagnosis = { kind: why.kind, summary: why.summary, hint: why.hint, occurrences, ...(why.file ? { file: why.file } : {}), ...(why.line ? { line: why.line } : {}) };
    }
    if (outputPath) out.outputPath = outputPath;
    if (r.aborted) Object.assign(out, { code: "aborted", message: "the command was stopped" });
    else if (r.timedOut) Object.assign(out, { code: "timeout", message: cls.longRunning ? `this looks like a server or watcher: it was stopped after ${Math.round(effective / 1000)}s (the output so far is shown). Background processes are not supported yet, so check it another way, for example with a test that starts it, exercises it and exits.` : `the command did not finish within ${Math.round(effective / 1000)}s and was stopped (the output so far is shown)` });
    else if (!ok) Object.assign(out, { code: "nonzero_exit", message: `the command exited with code ${r.exitCode}` });
    return out;
  }

  _spawn(cmd, cwd, timeoutMs, signal) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const chunks = [];
      let kept = 0;
      let truncated = false;
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let exitTimer = null;
      let child;
      const finish = (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(exitTimer);
        if (signal) signal.removeEventListener("abort", onAbort);
        try { child.stdout.destroy(); child.stderr.destroy(); } catch (_) { /* closed */ }
        resolve({ exitCode: timedOut || aborted ? null : exitCode, output: Buffer.concat(chunks).toString("utf8"), truncated, timedOut, aborted, durationMs: Date.now() - t0 });
      };
      const take = (buf) => {
        if (kept >= MAX_CAPTURE) { truncated = true; return; }
        const room = MAX_CAPTURE - kept;
        chunks.push(buf.length > room ? buf.subarray(0, room) : buf);
        if (buf.length > room) truncated = true;
        kept += Math.min(buf.length, room);
      };
      try {
        child = spawn(cmd, { cwd, shell: true, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
      } catch (err) {
        return resolve({ exitCode: null, output: `could not start the command: ${err.message}`, truncated: false, timedOut: false, aborted: false, durationMs: 0 });
      }
      const timer = setTimeout(() => { timedOut = true; killTree(child); exitTimer = setTimeout(() => finish(null), GRACE_AFTER_EXIT_MS + 500); }, timeoutMs);
      const onAbort = () => { aborted = true; killTree(child); exitTimer = setTimeout(() => finish(null), GRACE_AFTER_EXIT_MS + 500); };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.on("error", (err) => { take(Buffer.from(`could not start the command: ${err.message}`)); finish(null); });
      child.on("close", (code) => finish(code));
      child.on("exit", (code) => { exitTimer = setTimeout(() => finish(code), GRACE_AFTER_EXIT_MS); });
    });
  }

  _writeLog(cmd, text) {
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      const file = path.join(this.logDir, `${String(++this._n).padStart(3, "0")}-${String(cmd).replace(/[^\w.-]+/g, "_").slice(0, 40)}.log`);
      fs.writeFileSync(file, text.length > MAX_LOG ? text.slice(0, MAX_LOG) : text);
      return file;
    } catch (_) {
      return null;
    }
  }

  /** The shape GoalVerifier wants: no repeat gate (a check must be re-runnable), and a refused command is simply a failed check. */
  runner() {
    return async (cmd, { cwd, timeoutMs } = {}) => {
      const r = await this.run({ cmd, cwd, timeoutMs }, { bypassRepeat: true });
      if (r.code === "blocked" || r.code === "user_denied" || r.code === "invalid_path" || r.code === "protected_path" || r.code === "outside_workspace") return { exitCode: null, output: r.message, timedOut: false };
      return { exitCode: r.exitCode, output: r.output || r.message || "", timedOut: !!r.timedOut };
    };
  }
}

module.exports = { ShellTool, cleanEnv, cleanOutput, elide, killTree, DEFAULT_TIMEOUT_MS };
