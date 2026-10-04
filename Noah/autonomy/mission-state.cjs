// Noah/autonomy/mission-state.cjs
//
// MissionState: what Noah knows about the job it is doing, kept as DATA rather than as a transcript.
//
//   objective + success criteria      what "done" means, as checks (see goal-verifier.cjs)
//   plan                              steps with a status; revising the plan keeps what already happened
//   commands / files                  what was run and changed (the work product)
//   errors                            failure signatures with counts, so "same failure again" is a fact, not a feeling
//   hypotheses / tried                what Noah thinks is wrong, and what it already attempted
//
// `sourceVersion` is the heart of honest verification: it goes up whenever the work product may have changed (a file write,
// or a command that can change files). A check that passed at an older version no longer counts.
//
// render() is the compact text the model sees every iteration: a few thousand characters however long the mission runs.
// Nothing here talks to a model, the disk or the network, so all of it is unit-tested directly.

"use strict";

const { randomUUID } = require("crypto");

const CRITERION_KINDS = ["command", "file_exists", "file_absent", "file_contains", "window_exists", "window_absent", "element_text", "claim"];
const LIMITS = { steps: 30, commands: 40, errors: 30, tried: 30, observations: 20, hypotheses: 20, files: 300, criteria: 12, explored: 500 };

const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const posix = (p) => String(p ?? "").replace(/\\/g, "/");

/** One line saying what a criterion checks. */
function criterionLabel(c) {
  if (c.description) return clip(c.description, 140);
  switch (c.kind) {
    case "command": return clip(`\`${c.cmd}\` exits ${c.expectExit}${c.outputIncludes ? ` and prints "${c.outputIncludes}"` : ""}`, 140);
    case "file_exists": return clip(`${c.path} exists`, 140);
    case "file_absent": return clip(`${c.path} does not exist`, 140);
    case "file_contains": return clip(`${c.path} contains ${c.text ? `"${c.text}"` : `/${c.pattern}/`}`, 140);
    case "window_exists": return clip(`a window ${c.title ? `titled like "${c.title}"` : ""}${c.title && c.process ? " of " : ""}${c.process ? `the program ${c.process}` : ""} is open`, 140);
    case "window_absent": return clip(`no window ${c.title ? `titled like "${c.title}"` : ""}${c.title && c.process ? " of " : ""}${c.process ? `the program ${c.process}` : ""} is open`, 140);
    case "element_text": return clip(`the window "${c.title}" shows "${c.text}"${c.name ? ` in "${c.name}"` : ""}`, 140);
    default: return "(claim)";
  }
}

/** Validate one criterion and give it its stored shape. Throws a readable Error (the caller feeds it back to the model). */
function normalizeCriterion(raw, id) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("a success criterion must be an object");
  const kind = String(raw.kind || "");
  if (!CRITERION_KINDS.includes(kind)) throw new Error(`unknown criterion kind "${kind}" (valid: ${CRITERION_KINDS.join(", ")})`);
  const c = { id, kind, required: raw.required !== false, description: clip(raw.description || "", 200).trim() };
  switch (kind) {
    case "command":
      if (typeof raw.cmd !== "string" || !raw.cmd.trim()) throw new Error("a command criterion needs `cmd`");
      c.cmd = raw.cmd.trim().slice(0, 500);
      if (raw.cwd) c.cwd = String(raw.cwd).slice(0, 300);
      c.expectExit = Number.isInteger(raw.expectExit) ? raw.expectExit : 0;
      if (raw.outputIncludes) c.outputIncludes = String(raw.outputIncludes).slice(0, 200);
      if (raw.outputExcludes) c.outputExcludes = String(raw.outputExcludes).slice(0, 200);
      c.timeoutMs = Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? Math.min(Math.floor(raw.timeoutMs), 600_000) : 120_000;
      break;
    case "file_exists":
    case "file_absent":
    case "file_contains":
      if (typeof raw.path !== "string" || !raw.path.trim()) throw new Error(`a ${kind} criterion needs \`path\``);
      c.path = posix(raw.path.trim()).slice(0, 300);
      if (kind === "file_contains") {
        if (typeof raw.text === "string" && raw.text) c.text = raw.text.slice(0, 300);
        else if (typeof raw.pattern === "string" && raw.pattern) {
          try {
            new RegExp(raw.pattern);
          } catch (e) {
            throw new Error(`file_contains: \`pattern\` is not a valid regular expression (${e.message})`);
          }
          c.pattern = raw.pattern.slice(0, 300);
        } else throw new Error("a file_contains criterion needs `text` or `pattern`");
      }
      break;
    case "window_exists":
    case "window_absent":
      if ((typeof raw.title !== "string" || !raw.title.trim()) && (typeof raw.process !== "string" || !raw.process.trim())) throw new Error(`a ${kind} criterion needs \`title\` (part of the window's title) and/or \`process\` (the program, e.g. notepad)`);
      if (typeof raw.title === "string" && raw.title.trim()) c.title = raw.title.trim().slice(0, 200);
      if (typeof raw.process === "string" && raw.process.trim()) c.process = raw.process.trim().toLowerCase().replace(/\.exe$/, "").slice(0, 80);
      break;
    case "element_text":
      if (typeof raw.title !== "string" || !raw.title.trim()) throw new Error("an element_text criterion needs `title` (part of the window's title)");
      if (typeof raw.text !== "string" || !raw.text) throw new Error("an element_text criterion needs `text` (what the window must show)");
      c.title = raw.title.trim().slice(0, 200);
      c.text = raw.text.slice(0, 300);
      if (typeof raw.name === "string" && raw.name.trim()) c.name = raw.name.trim().slice(0, 120);
      break;
    case "claim":
      if (!c.description) throw new Error("a claim criterion needs a `description` of what will be reported");
      break;
    default:
      break;
  }
  return c;
}

class MissionState {
  constructor({ id, objective, now = Date.now } = {}) {
    this._now = now;
    this.id = id || randomUUID();
    this.objective = clip(String(objective || "").trim(), 1000);
    this.createdAt = now();
    this.criteria = []; // [{ id, kind, required, description, ...kind fields }]
    this.verification = {}; // criterion id -> { passed, at, sourceVersion, evidence, asserted }
    this.steps = []; // [{ id, text, status: pending|active|done|blocked, evidence, note }]
    this.planRevisions = []; // [{ at, reason, added, dropped:[text] }]
    this.commands = []; // oldest first
    this.files = {}; // posix path -> { ops, lastOp, at, bytes }
    this.errors = {}; // signature -> { kind, message, hint, count, firstAt, lastAt }
    this.hypotheses = []; // [{ id, text, status: open|confirmed|rejected, evidence }]
    this.tried = []; // [{ what, outcome: worked|failed|partial, note }]
    this.observations = []; // [{ tool, summary, at }]
    this.explored = []; // keys of things already looked at (a file, a search, a folder): looking at something NEW is progress, looking again is not
    this.next = "";
    this.sourceVersion = 0;
    this.counters = { iterations: 0, commands: 0, replans: 0, fileChanges: 0, progressAt: 0, lastProgress: "" }; // fileChanges counts Noah's own edits only: a command bumping sourceVersion cannot reset a budget keyed on it
    this._seq = { s: 0, h: 0, c: 0, cmd: 0 };
  }

  // ------------------------------------------------------------ progress

  /** One pass of the mission loop. */
  tick() {
    return ++this.counters.iterations;
  }

  progress(kind) {
    this.counters.progressAt = this.counters.iterations;
    this.counters.lastProgress = kind;
  }

  /** Iterations since anything real happened (a step finished, a file changed, a new error, a hypothesis settled, a check passed). */
  stalledFor() {
    return this.counters.iterations - this.counters.progressAt;
  }

  // ------------------------------------------------------------ success criteria

  /** Add criteria all-or-nothing. Returns the new ids. */
  addCriteria(list) {
    const raws = Array.isArray(list) ? list : [list];
    if (!raws.length) throw new Error("no success criteria given");
    if (this.criteria.length + raws.length > LIMITS.criteria) throw new Error(`at most ${LIMITS.criteria} success criteria`);
    let seq = this._seq.c;
    const made = raws.map((raw) => normalizeCriterion(raw, `c${++seq}`)); // throws before anything is stored
    this._seq.c = seq;
    this.criteria.push(...made);
    return made.map((c) => c.id);
  }

  recordVerification(id, { passed, evidence = "", asserted = false, sourceVersion = this.sourceVersion }) {
    if (!this.criteria.some((c) => c.id === id)) throw new Error(`unknown criterion ${id}`);
    const before = this.verification[id];
    this.verification[id] = { passed: !!passed, evidence: clip(evidence, 600), asserted: !!asserted, sourceVersion, at: this._now() };
    if (passed && !(before && before.passed)) this.progress("criterion_passed");
  }

  verificationFor(id) {
    return this.verification[id] || null;
  }

  /**
   * Something OUTSIDE the files changed (a desktop action: a click, typed text, a window opened or closed). Anything checked before is now stale, and a
   * failed command that was refused as "nothing changed since" may be tried again.
   */
  recordExternalChange() {
    this.sourceVersion++;
    this.counters.fileChanges = (this.counters.fileChanges || 0) + 1;
    this.progress("external_change");
    return this.sourceVersion;
  }

  /** A claim stays valid; a machine check is valid only for the sourceVersion it ran against. */
  isFresh(id) {
    const v = this.verification[id];
    return !!v && (v.asserted || v.sourceVersion === this.sourceVersion);
  }

  // ------------------------------------------------------------ plan

  /**
   * Replace the plan. Steps with the same text keep their status and evidence; finished steps stay as history; unfinished steps
   * that are not in the new plan are dropped (and noted in planRevisions, so a replan is visible afterwards).
   */
  setPlan(steps, reason = "") {
    const incoming = (Array.isArray(steps) ? steps : []).map((s) => clip(typeof s === "string" ? s : s && s.text, 200).trim()).filter(Boolean).slice(0, LIMITS.steps);
    if (!incoming.length) throw new Error("a plan needs at least one step");
    const byText = new Map();
    for (const s of this.steps) if (!byText.has(norm(s.text))) byText.set(norm(s.text), s);
    const kept = new Set();
    const next = incoming.map((text) => {
      const old = byText.get(norm(text));
      if (old && !kept.has(old)) {
        kept.add(old);
        return old;
      }
      return { id: `s${++this._seq.s}`, text, status: "pending", evidence: "", note: "" };
    });
    const history = this.steps.filter((s) => !kept.has(s) && s.status === "done");
    const dropped = this.steps.filter((s) => !kept.has(s) && s.status !== "done").map((s) => s.text);
    const revised = this.steps.length > 0;
    this.steps = [...history, ...next].slice(-LIMITS.steps);
    this.progress("plan");
    if (revised) {
      this.counters.replans++;
      this.planRevisions.push({ at: this._now(), reason: clip(reason, 200), added: next.filter((s) => !kept.has(s)).length, dropped });
      if (this.planRevisions.length > 20) this.planRevisions.shift();
    }
    return this.steps;
  }

  _step(id) {
    const s = this.steps.find((x) => x.id === id);
    if (!s) throw new Error(`unknown step ${id}`);
    return s;
  }

  activeStep() {
    return this.steps.find((s) => s.status === "active") || null;
  }

  startStep(id) {
    const s = this._step(id);
    if (s.status === "done") throw new Error(`step ${id} is already done`);
    for (const o of this.steps) if (o.status === "active") o.status = "pending";
    s.status = "active";
    return s;
  }

  completeStep(id, evidence = "") {
    const s = this._step(id);
    if (s.status === "done") return s;
    s.status = "done";
    s.evidence = clip(evidence, 300);
    this.progress("step_done");
    return s;
  }

  blockStep(id, why = "") {
    const s = this._step(id);
    if (s.status === "done") throw new Error(`step ${id} is already done`);
    s.status = "blocked";
    s.note = clip(why, 200);
    return s;
  }

  // ------------------------------------------------------------ what was done

  /**
   * @param {{ cmd: string, cwd?: string, exitCode?: number|null, timedOut?: boolean, durationMs?: number, tail?: string, mutates?: boolean, kind?: string }} rec
   *   `mutates`: the command may change files (install, build, codegen, a script). A command that only inspects or only verifies
   *   (tests, lint, a type check) must say false, or running the tests would invalidate the tests that just passed.
   */
  recordCommand(rec) {
    const c = {
      n: ++this._seq.cmd,
      cmd: clip(rec.cmd, 300),
      cwd: posix(rec.cwd || ""),
      exitCode: rec.exitCode === undefined ? null : rec.exitCode,
      timedOut: !!rec.timedOut,
      durationMs: Number(rec.durationMs) || 0,
      tail: clip(rec.tail, 400),
      diagnosis: clip(rec.diagnosis || "", 160), // the diagnoser's one-line summary, when the command failed
      mutates: !!rec.mutates,
      kind: rec.kind || "",
      at: this._now(),
    };
    if (c.mutates) this.sourceVersion++;
    c.versionAfter = this.sourceVersion; // "nothing has changed since this finished" is `versionAfter === sourceVersion`
    this.commands.push(c);
    this.counters.commands++;
    if (this.commands.length > LIMITS.commands) this.commands.shift();
    return c;
  }

  /**
   * The latest run of this exact command if it FAILED and nothing has changed since: running it again can only fail again.
   * (null when it never ran, last succeeded, or the work product changed after it.)
   */
  repeatOf(cmd, cwd = "") {
    const key = norm(cmd);
    const dir = posix(cwd);
    for (let i = this.commands.length - 1; i >= 0; i--) {
      const c = this.commands[i];
      if (norm(c.cmd) !== key || c.cwd !== dir) continue;
      const failed = c.exitCode !== 0 || c.timedOut;
      return failed && c.versionAfter === this.sourceVersion ? c : null;
    }
    return null;
  }

  /** @param {{ path: string, op: 'write'|'edit'|'create'|'delete', bytes?: number }} rec */
  recordFileChange({ path, op = "write", bytes, check = false, diff = "" }) {
    const p = posix(path);
    if (!p) throw new Error("recordFileChange needs a path");
    const f = this.files[p] || { ops: 0, lastOp: "", at: 0 };
    f.ops++;
    f.lastOp = op;
    f.at = this._now();
    if (bytes !== undefined) f.bytes = bytes;
    if (check) f.check = true; // this change touched the project's CHECKS (a test, or how the tests are run): reported to the user at the end
    // what the change REALLY was (the lines that differ, taken from the edit itself): the final message shows it, so a wrong story from the model sits next to the truth
    if (diff) f.diffs = [...(f.diffs || []), String(diff).slice(0, 400)].slice(-3);
    this.files[p] = f;
    const keys = Object.keys(this.files);
    if (keys.length > LIMITS.files) delete this.files[keys[0]];
    this.sourceVersion++;
    this.counters.fileChanges = (this.counters.fileChanges || 0) + 1;
    this.progress("file_change");
    return f;
  }

  /** Count one occurrence of a failure signature. Returns how many times it has now happened. */
  recordError({ signature, kind = "error", message = "", hint = "" }) {
    const key = clip(signature, 200);
    if (!key) return 0;
    const now = this._now();
    let e = this.errors[key];
    if (!e) {
      e = this.errors[key] = { kind, message: "", hint: "", count: 0, firstAt: now, lastAt: now };
      this.progress("new_error"); // getting past one error to meet the next is movement; the same one again is not
      const sigs = Object.keys(this.errors);
      if (sigs.length > LIMITS.errors) {
        const drop = sigs.filter((s) => s !== key).sort((a, b) => this.errors[a].count - this.errors[b].count || this.errors[a].lastAt - this.errors[b].lastAt)[0];
        delete this.errors[drop];
      }
    }
    e.count++;
    e.lastAt = now;
    if (message) e.message = clip(message, 300);
    if (hint) e.hint = clip(hint, 200);
    return e.count;
  }

  repeatedErrors(min = 2) {
    return Object.entries(this.errors)
      .filter(([, e]) => e.count >= min)
      .sort((a, b) => b[1].count - a[1].count);
  }

  /** Propose a hypothesis. A rejected one proposed again comes back as existing:true, status "rejected" (the loop's signal to stop). */
  addHypothesis(text) {
    const t = clip(String(text || "").trim(), 240);
    if (!t) throw new Error("a hypothesis needs text");
    const old = this.hypotheses.find((h) => norm(h.text) === norm(t));
    if (old) return { id: old.id, status: old.status, existing: true };
    const h = { id: `h${++this._seq.h}`, text: t, status: "open", evidence: "" };
    this.hypotheses.push(h);
    this.progress("hypothesis");
    if (this.hypotheses.length > LIMITS.hypotheses) {
      const i = this.hypotheses.findIndex((x) => x.status !== "open");
      this.hypotheses.splice(i >= 0 ? i : 0, 1);
    }
    return { id: h.id, status: h.status, existing: false };
  }

  resolveHypothesis(id, status, evidence = "") {
    if (!["confirmed", "rejected"].includes(status)) throw new Error('a hypothesis is resolved as "confirmed" or "rejected"');
    const h = this.hypotheses.find((x) => x.id === id);
    if (!h) throw new Error(`unknown hypothesis ${id}`);
    if (h.status === "open") this.progress("hypothesis_resolved");
    h.status = status;
    h.evidence = clip(evidence, 240);
    return h;
  }

  openHypotheses() {
    return this.hypotheses.filter((h) => h.status === "open");
  }

  recordTried({ what, outcome = "failed", note = "" }) {
    if (!["worked", "failed", "partial"].includes(outcome)) throw new Error('outcome must be "worked", "failed" or "partial"');
    this.tried.push({ what: clip(what, 160), outcome, note: clip(note, 160) });
    if (this.tried.length > LIMITS.tried) this.tried.shift();
  }

  recordObservation({ tool, summary }) {
    this.observations.push({ tool: clip(tool, 40), summary: clip(summary, 200), at: this._now() });
    if (this.observations.length > LIMITS.observations) this.observations.shift();
  }

  setNext(text) {
    this.next = clip(text, 300);
  }

  /** Note that something was looked at. Returns true (and counts as progress) the first time only. */
  noteExplored(key) {
    const k = clip(String(key || ""), 200);
    if (!k || this.explored.includes(k)) return false;
    this.explored.push(k);
    if (this.explored.length > LIMITS.explored) this.explored.shift();
    this.progress("explore");
    return true;
  }

  // ------------------------------------------------------------ what the model sees

  _mark(c) {
    const v = this.verification[c.id];
    if (!v) return "[ ]";
    if (!this.isFresh(c.id)) return "[?]";
    if (v.asserted) return "[~]";
    return v.passed ? "[x]" : "[!]";
  }

  /**
   * The compact mission briefing. The objective, the success criteria, the next step and the open hypotheses are always there;
   * the rest is cut from the least important section first (and from its oldest entries first), so the briefing stays under
   * `maxChars` however long the mission runs.
   */
  render({ maxChars = 6000 } = {}) {
    // The sections that are never dropped, at two sizes: normal, and (only if they alone overflow the budget) tight.
    const SIZE = { normal: { obj: 600, crit: 140, plan: 120, planN: 10, next: 300, hypN: 6, hyp: 160, find: 700 }, tight: { obj: 300, crit: 70, plan: 70, planN: 4, next: 160, hypN: 3, hyp: 90, find: 300 } };
    const buildMust = (q) => {
      const must = [];
      must.push(["## Mission", [clip(this.objective, q.obj)]]);
      if (this.criteria.length) {
        must.push(["## Done when ([x] checked now, [~] asserted by you, [!] failing, [?] changed since checked, [ ] not checked)", this.criteria.map((c) => `${this._mark(c)} ${c.id} ${clip(criterionLabel(c), q.crit)}${c.required ? "" : " (optional)"}`)]);
      } else {
        must.push(["## Done when", ["(nothing yet: say how success will be checked)"]]);
      }
      // What the model wrote down as having SEEN (claim_assert). A screenshot is shown once and a tool result scrolls away, so without this the model writes its final answer
      // from nothing and invents details (a real run recorded "unread from Sunil BSNL" and then answered "unread from Jeevith").
      const findings = this.criteria.map((c) => [c, this.verification[c.id]]).filter(([, v]) => v && v.asserted && v.evidence);
      if (findings.length) must.push(["## Findings you recorded (your final answer must use ONLY these details: anything else is flagged to the user as possibly made up)", findings.map(([c, v]) => `${c.id}: ${clip(v.evidence, q.find)}`)]);
      const doneN = this.steps.filter((s) => s.status === "done").length;
      const open = this.steps.filter((s) => s.status !== "done");
      if (this.steps.length) {
        const mark = { pending: "[ ]", active: "[>]", blocked: "[!]", done: "[x]" };
        const shown = open.slice(0, q.planN).map((s) => `${mark[s.status]} ${s.id} ${clip(s.text, q.plan)}${s.status === "blocked" && s.note ? ` (blocked: ${clip(s.note, 80)})` : ""}`);
        const lines = [...(doneN ? [`(${doneN} step${doneN > 1 ? "s" : ""} done)`] : []), ...shown, ...(open.length > q.planN ? [`(+${open.length - q.planN} more)`] : [])];
        must.push(["## Plan", lines]);
      }
      if (this.next) must.push(["## Next", [clip(this.next, q.next)]]);
      const hyp = this.openHypotheses();
      if (hyp.length) must.push(["## Open hypotheses", hyp.slice(0, q.hypN).map((h) => `${h.id}: ${clip(h.text, q.hyp)}`)]);
      return must;
    };
    let must = buildMust(SIZE.normal);

    const optional = [];
    const rep = this.repeatedErrors(2).slice(0, 5);
    if (rep.length) optional.push({ title: "## Failures that keep happening (do not repeat what failed: change something first)", lines: rep.map(([sig, e]) => `x${e.count} [${e.kind}] ${clip(e.message || sig, 140)}${e.hint ? ` -> ${clip(e.hint, 100)}` : ""}`), from: "end", omitted: 0 });
    const cmds = this.commands.slice(-6);
    if (cmds.length) optional.push({ title: "## Recent commands", lines: cmds.map((c) => { const note = c.diagnosis || (c.tail ? c.tail.split("\n").filter(Boolean).pop() || "" : ""); return `$ ${clip(c.cmd, 100)} -> ${c.timedOut ? "timed out" : `exit ${c.exitCode}`}${note ? ` | ${clip(note, 90)}` : ""}`; }), from: "start", omitted: Math.max(0, this.commands.length - 6) });
    const files = Object.keys(this.files);
    if (files.length) optional.push({ title: "## Files changed", lines: files.slice(-15).map((p) => `${p} (${this.files[p].lastOp}${this.files[p].ops > 1 ? ` x${this.files[p].ops}` : ""})`), from: "start", omitted: Math.max(0, files.length - 15) });
    if (this.tried.length) optional.push({ title: "## Already tried", lines: this.tried.slice(-8).map((t) => `${t.outcome}: ${clip(t.what, 110)}${t.note ? ` (${clip(t.note, 60)})` : ""}`), from: "start", omitted: Math.max(0, this.tried.length - 8) });
    const settled = this.hypotheses.filter((h) => h.status !== "open").slice(-4);
    if (settled.length) optional.push({ title: "## Settled hypotheses", lines: settled.map((h) => `${h.status}: ${clip(h.text, 100)}${h.evidence ? ` (${clip(h.evidence, 60)})` : ""}`), from: "start", omitted: 0 });

    const build = () => [...must.map(([title, lines]) => ({ title, lines, omitted: 0 })), ...optional]
      .filter((s) => s.lines.length)
      .map((s) => `${s.title}\n${s.lines.join("\n")}${s.omitted ? `\n(+${s.omitted} earlier not shown)` : ""}`)
      .join("\n\n");
    let out = build();
    for (let i = optional.length - 1; i >= 0 && out.length > maxChars; i--) {
      const sec = optional[i];
      while (sec.lines.length && out.length > maxChars) {
        if (sec.from === "end") sec.lines.pop();
        else sec.lines.shift();
        sec.omitted++;
        out = build();
      }
    }
    if (out.length > maxChars) {
      must = buildMust(SIZE.tight); // the must-keep sections alone overflowed: shorten them, never drop them
      out = build();
    }
    return out.length > maxChars ? out.slice(0, maxChars - 1) + "…" : out; // last resort for an absurdly small budget
  }

  // ------------------------------------------------------------ persistence

  snapshot() {
    const { _now, ...rest } = this; // eslint-disable-line no-unused-vars
    return JSON.parse(JSON.stringify(rest));
  }

  static restore(snap, { now = Date.now } = {}) {
    const m = new MissionState({ id: snap && snap.id, objective: snap && snap.objective, now });
    if (!snap || typeof snap !== "object") return m;
    for (const k of ["createdAt", "criteria", "verification", "steps", "planRevisions", "commands", "files", "errors", "hypotheses", "tried", "observations", "explored", "next", "sourceVersion", "counters", "_seq"]) {
      if (snap[k] !== undefined) m[k] = JSON.parse(JSON.stringify(snap[k]));
    }
    return m;
  }
}

module.exports = { MissionState, normalizeCriterion, criterionLabel, CRITERION_KINDS, LIMITS };
