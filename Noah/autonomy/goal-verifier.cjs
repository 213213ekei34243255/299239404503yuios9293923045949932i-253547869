// Noah/autonomy/goal-verifier.cjs
//
// GOAL-level verification. noah-agent's verifier asks "did that click do something?"; this one asks "is the job actually done?",
// by running the mission's success criteria (a command exits 0, a file contains X, a file exists) and recording the results in
// MissionState against the sourceVersion they ran at. Two consequences, both enforced by code rather than by a prompt:
//
//   * the mission cannot succeed until every REQUIRED criterion has been checked and passed;
//   * a pass goes stale the moment the work product changes (a file edit, a mutating command), so "the tests passed, then I
//     edited a file" can never be reported as success. runAll() re-runs exactly the stale ones.
//
// Criteria of kind `claim` are the one thing a machine cannot check (e.g. "report the cheapest price"). They need concrete
// evidence, never go stale, and are always reported as ASSERTED, not verified.
//
// The verifier touches no disk or process itself: it is handed `run`, `exists` and `readFile` (the workspace-scoped tools,
// see tools/), so what it checks is exactly what Noah is allowed to see and do.

"use strict";

const { criterionLabel } = require("./mission-state.cjs");

const MAX_FILE_CHARS = 1_000_000;

const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
/** The end of some output: that is where a failing command says why. */
const tailOf = (s, n = 500) => {
  const t = String(s ?? "").replace(/\s+$/, "");
  return t.length > n ? "…" + t.slice(-(n - 1)) : t;
};

/** Does this window match the criterion's title (a part, any case) and/or program? */
function windowMatches(w, c) {
  if (c.title && !String(w.title || "").toLowerCase().includes(String(c.title).toLowerCase())) return false;
  if (c.process && String(w.process || "").toLowerCase() !== c.process) return false;
  return true;
}

class GoalVerifier {
  /**
   * @param {object} o
   * @param {import('./mission-state.cjs').MissionState} o.state
   * @param {(cmd: string, opts: { cwd?: string, timeoutMs?: number }) => Promise<{ exitCode: number|null, output: string, timedOut?: boolean }>} o.run
   * @param {(path: string) => Promise<boolean>} o.exists
   * @param {(path: string) => Promise<string>} o.readFile
   */
  constructor({ state, run, exists, readFile, desktop = null }) {
    this.state = state;
    this.desktop = desktop; // { windows(), tree(window) } on a desktop task, else null
    this.run = run;
    this.exists = exists;
    this.readFile = readFile;
  }

  async _evaluate(c) {
    switch (c.kind) {
      case "command": {
        const r = await this.run(c.cmd, { cwd: c.cwd, timeoutMs: c.timeoutMs });
        const out = String(r.output ?? "");
        const head = `exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}`;
        if (r.timedOut) return { passed: false, evidence: `${head}: ${tailOf(out)}` };
        if (r.exitCode !== c.expectExit) return { passed: false, evidence: `${head}, expected ${c.expectExit}: ${tailOf(out)}` };
        if (c.outputIncludes && !out.includes(c.outputIncludes)) return { passed: false, evidence: `${head}, but the output does not contain "${c.outputIncludes}": ${tailOf(out, 300)}` };
        if (c.outputExcludes && out.includes(c.outputExcludes)) return { passed: false, evidence: `${head}, but the output contains "${c.outputExcludes}": ${tailOf(out, 300)}` };
        return { passed: true, evidence: `${head}: ${tailOf(out, 300)}` };
      }
      case "file_exists": {
        const ok = await this.exists(c.path);
        return { passed: !!ok, evidence: ok ? `${c.path} exists` : `${c.path} does not exist` };
      }
      case "file_absent": {
        const ok = await this.exists(c.path);
        return { passed: !ok, evidence: ok ? `${c.path} still exists` : `${c.path} is gone` };
      }
      case "file_contains": {
        let text;
        try {
          text = String(await this.readFile(c.path)).slice(0, MAX_FILE_CHARS);
        } catch (err) {
          return { passed: false, evidence: `could not read ${c.path}: ${clip(err && err.message, 160)}` };
        }
        const hit = c.text ? text.includes(c.text) : new RegExp(c.pattern, "m").test(text);
        return { passed: hit, evidence: hit ? `${c.path} contains ${c.text ? `"${clip(c.text, 80)}"` : `/${clip(c.pattern, 80)}/`}` : `${c.path} does not contain ${c.text ? `"${clip(c.text, 80)}"` : `/${clip(c.pattern, 80)}/`}` };
      }
      case "window_exists":
      case "window_absent": {
        if (!this.desktop) return { passed: false, evidence: "this check needs a desktop task: there is no desktop to look at" };
        const found = (await this.desktop.windows()).filter((w) => windowMatches(w, c));
        const want = c.kind === "window_exists";
        const what = `${c.title ? `"${clip(c.title, 60)}"` : ""}${c.title && c.process ? " / " : ""}${c.process || ""}`;
        if (want) return { passed: found.length > 0, evidence: found.length ? `a window is open: "${clip(found[0].title, 80)}" (${found[0].process})` : `no open window matches ${what}` };
        return { passed: found.length === 0, evidence: found.length === 0 ? `no window matches ${what}` : `still open: "${clip(found[0].title, 80)}" (${found[0].process})` };
      }
      case "element_text": {
        if (!this.desktop) return { passed: false, evidence: "this check needs a desktop task: there is no desktop to look at" };
        const wins = (await this.desktop.windows()).filter((w) => windowMatches(w, { title: c.title }));
        if (!wins.length) return { passed: false, evidence: `no open window has "${clip(c.title, 60)}" in its title` };
        const needle = c.text.toLowerCase();
        for (const w of wins) {
          const tree = await this.desktop.tree(w.window);
          const hit = tree.nodes.find((n) => !n.password && (!c.name || String(n.name || "").toLowerCase().includes(c.name.toLowerCase())) && (String(n.value ?? "").toLowerCase().includes(needle) || String(n.name || "").toLowerCase().includes(needle)));
          if (hit) return { passed: true, evidence: `"${clip(w.title, 60)}" shows "${clip(c.text, 80)}"${hit.name ? ` (in "${clip(hit.name, 50)}")` : ""}` };
        }
        return { passed: false, evidence: `"${clip(wins[0].title, 60)}" does not show "${clip(c.text, 80)}"${c.name ? ` in "${clip(c.name, 50)}"` : ""}` };
      }
      default:
        return { passed: false, evidence: "a claim is asserted, not checked" };
    }
  }

  /** Run one machine check now, against the current sourceVersion. A check that cannot even run is a FAILED check, never a crash. */
  async check(c) {
    if (c.kind === "claim") return { passed: false, evidence: "a claim is asserted, not checked" };
    const sourceVersion = this.state.sourceVersion; // read BEFORE running: anything that changes while it runs makes the result stale
    let r;
    try {
      r = await this._evaluate(c);
    } catch (err) {
      r = { passed: false, evidence: `the check could not run: ${clip(err && err.message, 200)}` };
    }
    this.state.recordVerification(c.id, { passed: r.passed, evidence: r.evidence, asserted: false, sourceVersion });
    return r;
  }

  /** The model's assertion for a `claim` criterion. Concrete evidence is required. */
  assertClaim(id, evidence) {
    const c = this.state.criteria.find((x) => x.id === id);
    if (!c) throw new Error(`unknown criterion ${id}`);
    if (c.kind !== "claim") throw new Error(`${id} is a machine-checked criterion: it cannot be asserted, only checked`);
    const e = String(evidence || "").trim();
    if (e.length < 12) throw new Error("a claim needs concrete evidence: say what you observed, not just that it is done");
    this.state.recordVerification(id, { passed: true, evidence: e, asserted: true });
  }

  /** Check every criterion that was never run or has gone stale (`force`: all of them), one after another. */
  async runAll({ force = false } = {}) {
    const ran = [];
    for (const c of this.state.criteria) {
      if (c.kind === "claim") continue;
      if (!force && this.state.verificationFor(c.id) && this.state.isFresh(c.id)) continue;
      await this.check(c);
      ran.push(c.id);
    }
    return { ran, ...this.status() };
  }

  /** Where the mission stands. `passed` is the ONLY thing Lifecycle.finish("succeeded") trusts. */
  status() {
    if (!this.state.criteria.length) return { passed: false, reason: "no_criteria", pending: [], stale: [], failing: [], unverifiedClaims: [] };
    const required = this.state.criteria.filter((c) => c.required);
    if (!required.length) return { passed: false, reason: "no_required_criteria", pending: [], stale: [], failing: [], unverifiedClaims: [] };
    const pending = [];
    const stale = [];
    const failing = [];
    const unverifiedClaims = [];
    for (const c of required) {
      const v = this.state.verificationFor(c.id);
      if (!v) pending.push(c.id);
      else if (!this.state.isFresh(c.id)) stale.push(c.id);
      else if (!v.passed) failing.push({ id: c.id, label: criterionLabel(c), evidence: v.evidence });
      else if (v.asserted) unverifiedClaims.push(c.id);
    }
    const passed = !pending.length && !stale.length && !failing.length;
    return { passed, reason: passed ? "ok" : failing.length ? "failing" : stale.length ? "stale" : "never_run", pending, stale, failing, unverifiedClaims };
  }

  /** What Lifecycle.finish("succeeded") asks: true, or the reason it must refuse. */
  canSucceed() {
    const s = this.status();
    if (s.passed) return true;
    switch (s.reason) {
      case "no_criteria": return "there are no success criteria to check";
      case "no_required_criteria": return "there is no required success criterion";
      case "failing": return `still failing: ${s.failing.map((f) => f.id).join(", ")}`;
      case "stale": return `the work changed after these were checked, re-check them: ${s.stale.join(", ")}`;
      default: return `not checked yet: ${s.pending.join(", ")}`;
    }
  }

  /** The honest account for the final answer: what was verified by a machine, what was only asserted, what is not green. */
  summaryText() {
    const lines = [];
    for (const c of this.state.criteria) {
      const v = this.state.verificationFor(c.id);
      const label = criterionLabel(c);
      if (!v) lines.push(`NOT RUN   ${label}`);
      else if (!this.state.isFresh(c.id)) lines.push(`STALE     ${label} (the work changed after this was checked)`);
      else if (v.asserted) lines.push(`ASSERTED  ${label} (stated by Noah, not machine-checked): ${clip(v.evidence, 160)}`);
      else lines.push(`${v.passed ? "PASS      " : "FAIL      "}${label}: ${clip(v.evidence, 160)}`);
    }
    return lines.join("\n");
  }
}

module.exports = { GoalVerifier, tailOf };
