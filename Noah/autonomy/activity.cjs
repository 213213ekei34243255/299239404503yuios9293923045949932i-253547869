// Noah/autonomy/activity.cjs
//
// What the user SEES while a mission works: one plain line per thing Noah does, built from the real tool result (never from what the model
// says it did). "Read src/index.js (2 lines)", "Ran npm test: failed (exit 1)" with the diagnosis under it, "Edited src/index.js" with the
// before and after of the changed line, "Refused: read the file first".
//
// Only paths, counts, commands, short diagnoses and the one changed line are shown. Never whole file contents, and never an environment
// value (commands cannot name secrets: command-policy refuses them, and the file tools cannot read them).
//
// The panel turns `kind` into an icon and `level` into a colour; this file only decides the words.

"use strict";

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const firstLine = (s, n) => clip(String(s ?? "").split(/\r?\n/).find((l) => l.trim()) || "", n);
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const secs = (ms) => `${Math.max(0.1, Math.round(ms / 100) / 10)}s`;
const list = (x) => (Array.isArray(x) ? x : []); // a model can send anything: describing it must never throw

/** The phase the mission is in, in words a person would use. */
const PHASE_WORDS = {
  understand: "Looking around",
  plan: "Planning",
  inspect: "Looking closer",
  act: "Making changes",
  observe: "Checking what happened",
  reason: "Thinking it over",
  verify: "Verifying",
  recover: "Working out what went wrong",
};
const phaseWords = (phase) => PHASE_WORDS[phase] || "Working";

/**
 * What an edit really changed. The lines that are the same at the start and the end of the old and new text are dropped, so a change that
 * ADDS lines under an unchanged first line shows the added lines (showing only each text's first line once made a real change look like
 * "x" became "x"). At most `max` lines per side; blank lines are not shown.
 */
function changedLines(find, replace, max = 3) {
  const a = String(find ?? "").split(/\r?\n/);
  const b = String(replace ?? "").split(/\r?\n/);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const side = (lines, sign) => {
    const real = lines.filter((l) => l.trim());
    const shown = real.slice(0, max).map((l) => `${sign} ${clip(l, 120)}`);
    if (real.length > max) shown.push(`${sign} … (${real.length - max} more ${real.length - max === 1 ? "line" : "lines"})`);
    return shown;
  };
  const out = [...side(a.slice(s, ea), "−"), ...side(b.slice(s, eb), "+")];
  return out.length ? out.join("\n") : "(only spacing changed)";
}

const FS_VERB = { fs_read: "read", fs_list: "list", fs_search: "search", fs_write: "write", fs_edit: "edit", fs_delete: "delete" };
const FS_KIND = { fs_read: "read", fs_list: "list", fs_search: "search", fs_write: "write", fs_edit: "edit", fs_delete: "delete" };

/** A line shown BEFORE a slow call finishes, so a long command does not look like nothing is happening. Only commands are slow enough to need it. */
function describeStart(name, args = {}) {
  if (name === "shell_run") return { kind: "run", level: "info", ok: true, text: `Running ${clip(args.cmd, 110)}…`, detail: "" };
  if (name === "desktop_launch") return { kind: "launch", level: "info", ok: true, text: `Opening ${clip(args.app || args.file, 60)}…`, detail: "" };
  if (name === "desktop_wait") return { kind: "window", level: "info", ok: true, text: `Waiting for ${clip(args.title || args.process, 60)}…`, detail: "" };
  return null;
}

const DESKTOP_VERB = { desktop_windows: "list the windows", desktop_read: "read the window", desktop_screenshot: "look at the window", desktop_focus: "bring the window to the front", desktop_click: "click", desktop_type: "type", desktop_set_text: "fill in the field", desktop_key: "press the key", desktop_scroll: "scroll", desktop_launch: "open the app", desktop_wait: "wait for the window", desktop_close: "close the window" };
const DESKTOP_KIND = { desktop_windows: "look", desktop_read: "look", desktop_screenshot: "look", desktop_focus: "window", desktop_click: "click", desktop_type: "type", desktop_set_text: "type", desktop_key: "key", desktop_scroll: "click", desktop_launch: "launch", desktop_wait: "window", desktop_close: "close" };
const winName = (a, r) => clip((r && r.title) || (a && a.title) || (a && a.window ? "window " + a.window : "the window"), 60);

function failure(name, args, r) {
  if (DESKTOP_VERB[name]) {
    const ruled = new Set(["policy_denied", "user_denied", "password_field"]);
    return { kind: DESKTOP_KIND[name], level: ruled.has(r.code) ? "refused" : "fail", ok: false, text: `Could not ${DESKTOP_VERB[name]}`, detail: clip(r.message || r.code || "it did not work", 220) };
  }
  const where = args.path ? ` ${args.path}` : "";
  const verb = FS_VERB[name];
  const refused = new Set(["blocked", "user_denied", "policy_denied", "password_field", "protected_path", "not_read", "changed_on_disk", "repeat", "already_failed", "invalid_arguments", "not_ready", "unreadable_secret"]);
  const why = clip(r.message || r.code || "it did not work", 220);
  if (verb) return { kind: FS_KIND[name], level: refused.has(r.code) ? "refused" : "fail", ok: false, text: `Could not ${verb}${where}`, detail: why };
  return { kind: "note", level: refused.has(r.code) ? "refused" : "fail", ok: false, text: `${name.replace(/_/g, " ")} did not work`, detail: why };
}

/**
 * One finished call as a line for the user.
 * @returns {{ kind: string, level: "ok"|"info"|"fail"|"refused", ok: boolean, text: string, detail: string }}
 */
function describeCall(name, args = {}, result = {}) {
  const r = result || {};
  const a = args || {};
  if (r.code === "not_executed") return { kind: "note", level: "info", ok: false, text: `Skipped ${name.replace(/_/g, " ")}`, detail: "An earlier step in the same round did not work, so this one was not run." };

  // commands: "it ran and failed" is different from "it was never run"
  if (name === "shell_run") {
    const cmd = clip(a.cmd, 110);
    const ran = r.exitCode !== undefined || r.timedOut === true;
    if (!ran && r.ok === false) return { kind: "run", level: r.code === "blocked" || r.code === "user_denied" ? "refused" : "fail", ok: false, text: `Did not run ${cmd}`, detail: clip(r.message || r.code, 220) };
    const took = r.durationMs != null ? ` in ${secs(r.durationMs)}` : "";
    if (r.ok) return { kind: "run", level: "ok", ok: true, text: `Ran ${cmd}: passed${took}`, detail: "" };
    if (r.timedOut) return { kind: "run", level: "fail", ok: false, text: `Ran ${cmd}: stopped, it took too long${took}`, detail: "" };
    const d = r.diagnosis;
    // the file and line, unless the summary already names the file (the real diagnoser often does: "required from src/index.js")
    const detail = d && d.summary ? `${clip(d.summary, 200)}${d.file && !String(d.summary).includes(d.file) ? ` (${d.file}${d.line ? ":" + d.line : ""})` : ""}` : firstLine(String(r.output || "").split("\n").filter((l) => l.trim()).slice(-1)[0], 200);
    return { kind: "run", level: "fail", ok: false, text: `Ran ${cmd}: failed (exit ${r.exitCode})${took}`, detail };
  }

  if (r.ok === false && (FS_VERB[name] || DESKTOP_VERB[name])) return failure(name, a, r);

  switch (name) {
    case "desktop_windows": return { kind: "look", level: "ok", ok: true, text: `Looked at the open windows (${plural(r.count || 0, "window")})`, detail: "" };
    case "desktop_read": return { kind: "look", level: "ok", ok: true, text: `Read ${winName(a, r)} (${plural(r.controls || 0, "control")})`, detail: "" };
    case "desktop_screenshot": return { kind: "look", level: "ok", ok: true, text: `Took a picture of ${winName(a, r)}`, detail: "" };
    case "desktop_focus": return { kind: "window", level: "ok", ok: true, text: `Brought ${winName(a, r)} to the front`, detail: "" };
    case "desktop_click": {
      // say WHAT was pressed: the words that were clicked, or what Windows says is under the pointer, never just two numbers
      const said = String(r.name || "").trim();
      const named = said && !/^\(\s*-?\d+\s*,\s*-?\d+\s*\)$/.test(said) ? said : "";
      const hit = r.hit && r.hit.name ? String(r.hit.name).trim() : "";
      const where = r.at ? ` at (${r.at.x}, ${r.at.y})` : a.x !== undefined ? ` at (${a.x}, ${a.y})` : "";
      const text = named ? `Clicked "${clip(named, 60)}"${r.method === "mouse" && !r.via ? " with the mouse" : ""}` : hit ? `Clicked a spot on "${clip(hit, 50)}"${where}` : `Clicked a spot${where}`;
      return { kind: "click", level: "ok", ok: true, text, detail: r.via === "text" ? "Found by reading the words on the window" : "" };
    }
    case "desktop_type": return { kind: "type", level: "ok", ok: true, text: `Typed ${plural(r.typed || 0, "character")}${a.title ? ` into ${clip(a.title, 40)}` : ""}`, detail: clip(a.text, 160) };
    case "desktop_set_text": return { kind: "type", level: "ok", ok: true, text: "Filled in a field", detail: clip(a.text, 160) };
    case "desktop_key": return { kind: "key", level: "ok", ok: true, text: `Pressed ${clip(a.combo, 30)}`, detail: "" };
    case "desktop_scroll": return { kind: "click", level: "ok", ok: true, text: `Scrolled ${r.scrolled < 0 ? "down" : "up"}`, detail: "" };
    case "desktop_launch": return { kind: "launch", level: "ok", ok: true, text: `Opened ${clip(r.app || a.app || a.file, 60)}`, detail: "" };
    case "desktop_wait": return { kind: "window", level: "ok", ok: true, text: `Found the window ${winName(a, r)}`, detail: "" };
    case "desktop_close": return { kind: "close", level: r.closed ? "ok" : "info", ok: true, text: r.closed ? `Closed ${winName(a, r)}` : `Asked ${winName(a, r)} to close (it is still open)`, detail: "" };
    default: break;
  }

  switch (name) {
    case "fs_read": return { kind: "read", level: "ok", ok: true, text: `Read ${r.path || a.path}${r.totalLines != null ? ` (${plural(r.totalLines, "line")}${r.truncated ? ", first part" : ""})` : ""}`, detail: "" };
    case "fs_list": return { kind: "list", level: "ok", ok: true, text: `Looked in ${r.path || a.path || "the project folder"}${r.count != null ? ` (${plural(r.count, "item")})` : ""}`, detail: "" };
    case "fs_search": return { kind: "search", level: "ok", ok: true, text: `Searched for “${clip(a.pattern, 60)}”${a.path ? ` in ${a.path}` : ""}: ${r.count ? plural(r.count, "match", "matches") : "no matches"}`, detail: "" };
    case "fs_write": return { kind: "write", level: "ok", ok: true, text: `${r.created ? "Created" : "Replaced"} ${r.path || a.path}${r.bytes != null ? ` (${r.bytes} bytes)` : ""}`, detail: "" };
    case "fs_delete": return { kind: "delete", level: "ok", ok: true, text: `Deleted ${r.path || a.path}`, detail: "" };
    case "fs_edit": {
      const line = Array.isArray(r.line) ? r.line[0] : r.line;
      const n = r.replacements > 1 ? ` (${r.replacements} places)` : line ? ` (line ${line})` : "";
      // the lines that changed, before and after: exactly what the user would want to check
      const detail = changedLines(a.find, a.replace);
      return { kind: "edit", level: "ok", ok: true, text: `Edited ${r.path || a.path}${n}`, detail };
    }
    default: break;
  }

  if (r.ok === false) {
    if (name === "finish") return { kind: "finish", level: "refused", ok: false, text: "Not finished yet: the checks do not all pass", detail: clip(r.verification || r.message, 400) };
    return failure(name, a, r);
  }

  switch (name) {
    case "criteria_add": {
      const items = list(a.criteria).map((c) => clip(c && (c.description || c.cmd || c.path || c.text || c.what), 70)).filter(Boolean);
      return { kind: "goal", level: "ok", ok: true, text: "Decided how success will be checked", detail: items.slice(0, 5).map((t) => `• ${t}`).join("\n") };
    }
    case "plan_set": {
      const steps = list(a.steps).map((s) => clip(s, 90));
      return { kind: "plan", level: "ok", ok: true, text: `${a.reason ? "Changed the plan" : "Made a plan"} (${plural(steps.length, "step")})`, detail: steps.slice(0, 8).map((s, i) => `${i + 1}. ${s}`).join("\n") };
    }
    case "step_update": return { kind: "step", level: "ok", ok: true, text: `Step ${a.id}: ${a.status}`, detail: clip(a.evidence || a.why, 160) };
    case "hypothesis_add": return { kind: "idea", level: "ok", ok: true, text: `Suspects: ${clip(a.text, 160)}`, detail: "" };
    case "hypothesis_resolve": return { kind: "idea", level: "ok", ok: true, text: `Suspicion ${a.id}: ${a.status}`, detail: clip(a.evidence, 160) };
    case "claim_assert": return { kind: "note", level: "info", ok: true, text: `Noted ${a.id} as stated, not checked by a machine`, detail: clip(a.evidence, 160) };
    case "next_set": return { kind: "note", level: "info", ok: true, text: `Next: ${clip(a.text, 160)}`, detail: "" };
    case "tried_add": return { kind: "note", level: "info", ok: true, text: `Noted what did not work: ${clip(a.what, 140)}`, detail: clip(a.outcome || a.note, 160) };
    case "run_checks": return { kind: "check", level: r.passed ? "ok" : "fail", ok: !!r.passed, text: `Ran the success checks: ${r.passed ? "all pass" : r.reason || "not all pass"}`, detail: clip(r.verification, 400) };
    case "finish": return { kind: "finish", level: "ok", ok: true, text: "Finished: every check passed", detail: "" };
    case "ask_user": return { kind: "ask", level: "info", ok: true, text: `Asking you: ${clip(a.question, 200)}`, detail: "" };
    case "give_up": return { kind: "stop", level: "fail", ok: false, text: `Giving up: ${clip(a.reason, 200)}`, detail: "" };
    default: return { kind: "note", level: "info", ok: true, text: name.replace(/_/g, " "), detail: "" };
  }
}

module.exports = { describeCall, describeStart, phaseWords, PHASE_WORDS, changedLines };
