// Noah/autonomy/tools/fs-tools.cjs
//
// FsTools: read, list, search, write, edit and delete files for a mission, inside the workspace and nowhere else.
//
//   * every path goes through Workspace.resolve (real location, secrets refused, node_modules read-only)
//   * READ BEFORE WRITE: an existing file can be edited or overwritten only after it was read IN FULL in this mission and has not
//     changed on disk since (mtime + size). No blind overwrites, no edits against a stale picture of the file
//   * edit() replaces exact text, refuses an ambiguous match (more than one) and tells the model where the near-misses are
//   * line endings are kept (a CRLF file stays CRLF), writes are atomic (temp file + rename), size is bounded
//   * every change is recorded in MissionState (bumping sourceVersion), by the tool, so the model cannot forget to
//   * under the user's mode (supervised / strict) writes ask for confirmation; deleting a folder recursively always does
//
// Every failure is a normal result ({ ok:false, code, message }), never an exception.

"use strict";

const fs = require("fs");
const path = require("path");
const { PolicyError, isSecretName } = require("./workspace.cjs");
const { decide } = require("../../safety/policy.cjs");
const { GENERATED_DIRS } = require("./command-policy.cjs");
const { isTestPath, changesTestRun } = require("./test-paths.cjs");
const { changedLines } = require("../activity.cjs");

const MAX_READ_BYTES = 4 * 1024 * 1024;
const SHOW_CHARS = 60_000;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_FILE = 1024 * 1024;
const SEARCH_BUDGET_MS = 10_000;
// the byte-order mark, written without the literal character: an invisible character in source is too easy for an editor to strip
const BOM = String.fromCharCode(0xfeff);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".cache", "__pycache__", ".venv", "venv", "target", ".gradle", ".turbo", ".parcel-cache"]);
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const keyOf = (p) => (CASE_INSENSITIVE ? String(p).toLowerCase() : String(p));

const ok = (o) => ({ ok: true, ...o });
const fail = (code, message, extra) => ({ ok: false, code, message, ...(extra || {}) });
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const risk = (level, category, reason) => ({ level, categories: [category], reasons: [reason] });
// An EXISTING test file is the project's evidence: changing it is HIGH risk, so it asks in every mode (a new test file is an ordinary write)
const testRisk = (what) => risk("high", "test_file", `${what} a test file: a check that passes after the test itself was changed proves much less`);
// the same for HOW the tests are run (the "test" script in package.json): `reason` comes from changesTestRun
const runRisk = (reason) => risk("high", "test_file", `${reason}: a check that passes after the way it is run was changed proves much less`);

function fromError(err, shown) {
  if (err instanceof PolicyError) return fail(err.code, err.message);
  switch (err && err.code) {
    case "ENOENT": return fail("not_found", `${shown || "that path"} does not exist`);
    case "ENOTDIR": return fail("not_found", `${shown || "that path"} is not inside a folder`);
    case "EACCES": case "EPERM": return fail("permission", `no permission for ${shown || "that path"}`);
    case "EBUSY": return fail("busy", `${shown || "that file"} is in use by another program`);
    default: return fail("io_error", clip((err && err.message) || String(err), 200));
  }
}

function globToRegex(glob) {
  const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const j = glob.indexOf("}", i);
      if (j > i) { re += "(?:" + glob.slice(i + 1, j).split(",").map(esc).join("|") + ")"; i = j; } else re += "\\{";
    } else re += esc(c);
  }
  return new RegExp("^" + re + "$", CASE_INSENSITIVE ? "i" : "");
}

function countOf(text, find) {
  let n = 0;
  for (let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + find.length)) n++;
  return n;
}
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

class FsTools {
  /**
   * @param {object} o
   * @param {import('./workspace.cjs').Workspace} o.workspace
   * @param {import('../mission-state.cjs').MissionState} o.state
   * @param {(req: object) => Promise<boolean>} [o.confirm]
   * @param {() => string} [o.getMode]
   */
  constructor({ workspace, state, confirm, getMode = () => "autonomous" }) {
    this.workspace = workspace;
    this.state = state;
    this.confirm = confirm || (async () => false);
    this.getMode = getMode;
    this._seen = new Map(); // real path -> { mtimeMs, size, full }
  }

  /** The user's mode decides whether this change needs a confirmation. Returns a failure result, or null to go ahead. */
  async _gate(r, summary) {
    const v = decide(r, { mode: this.getMode(), mutates: true });
    if (v.decision === "deny") return fail("policy_denied", v.why);
    if (v.decision === "confirm") {
      let allowed = false;
      try { allowed = await this.confirm({ summary, why: v.why, risk: r }); } catch (_) { allowed = false; }
      if (!allowed) return fail("user_denied", "The user declined this change. Do not make it another way: explain, offer an alternative, or stop.");
    }
    return null;
  }

  _note(real, st, full) {
    this._seen.set(keyOf(real), { mtimeMs: st.mtimeMs, size: st.size, full });
  }

  /** Has this file been read in full, and is it still as it was? Returns a failure result or null. */
  _readCheck(real, shown, st) {
    const seen = this._seen.get(keyOf(real));
    if (!seen || !seen.full) return fail("not_read", `Read ${shown} in full with fs_read before changing it (so the change is made against what is really there).`);
    if (seen.mtimeMs !== st.mtimeMs || seen.size !== st.size) return fail("changed_on_disk", `${shown} changed on disk since you read it (a command or another program changed it). Read it again before changing it.`);
    return null;
  }

  // ----------------------------------------------------------------- read

  /** @param {{ path: string, offset?: number, limit?: number, numbered?: boolean }} a */
  async read({ path: p, offset = 1, limit = 2000, numbered = true }) {
    let shown = p;
    try {
      const real = this.workspace.resolve(p);
      shown = this.workspace.display(real);
      const st = fs.statSync(real);
      if (st.isDirectory()) return fail("is_directory", `${shown} is a folder: use fs_list`);
      if (st.size > MAX_READ_BYTES) return fail("too_large", `${shown} is ${(st.size / 1048576).toFixed(1)} MB: too large to read whole. Use fs_search to find the part you need.`);
      const buf = fs.readFileSync(real);
      if (buf.subarray(0, 8000).includes(0)) return fail("binary_file", `${shown} is a binary file (${st.size} bytes), not text`);
      let text = buf.toString("utf8");
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const eol = text.includes("\r\n") ? "crlf" : "lf";
      const all = text.split(/\r\n|\n|\r/);
      if (all.length && all[all.length - 1] === "") all.pop();
      const total = all.length;
      const start = Math.max(1, Math.floor(Number(offset)) || 1);
      const want = Math.max(1, Math.floor(Number(limit)) || 2000);
      const out = [];
      let chars = 0;
      let i = start - 1;
      for (; i < total && out.length < want; i++) {
        const line = numbered ? `${String(i + 1).padStart(6)}\t${all[i]}` : all[i];
        if (chars + line.length > SHOW_CHARS && out.length) break;
        out.push(line);
        chars += line.length + 1;
      }
      const end = start - 1 + out.length;
      const truncated = end < total;
      const prior = this._seen.get(keyOf(real));
      const unchanged = !!prior && prior.mtimeMs === st.mtimeMs && prior.size === st.size;
      this._note(real, st, start <= 1 && !truncated);
      return ok({ path: shown, content: out.join("\n"), startLine: start, endLine: end, totalLines: total, truncated, ...(truncated ? { nextOffset: end + 1 } : {}), eol, size: st.size, unchanged });
    } catch (err) {
      return fromError(err, shown);
    }
  }

  // ----------------------------------------------------------------- list

  /** @param {{ path?: string, depth?: number, max?: number }} a */
  async list({ path: p = ".", depth = 1, max = 200 } = {}) {
    let shown = p;
    try {
      const real = this.workspace.resolve(p);
      shown = this.workspace.display(real);
      if (!fs.statSync(real).isDirectory()) return fail("not_a_folder", `${shown} is a file: use fs_read`);
      const maxDepth = Math.min(4, Math.max(1, Math.floor(Number(depth)) || 1));
      const limit = Math.min(1000, Math.max(1, Math.floor(Number(max)) || 200));
      const lines = [];
      let truncated = false;
      const walk = (dir, level) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : a.isDirectory() ? -1 : 1));
        for (const e of entries) {
          if (lines.length >= limit) { truncated = true; return; }
          const full = path.join(dir, e.name);
          const indent = "  ".repeat(level - 1);
          const protectedName = isSecretName(e.name) || [".git", ".ssh", ".aws", ".gnupg"].includes(e.name.toLowerCase());
          if (e.isSymbolicLink()) { lines.push(`${indent}${e.name} -> (link, not followed)`); continue; }
          if (e.isDirectory()) {
            const skip = SKIP_DIRS.has(e.name) || protectedName;
            lines.push(`${indent}${e.name}/${skip ? "  (not listed)" : ""}`);
            if (!skip && level < maxDepth) walk(full, level + 1);
          } else {
            let size = "";
            try { size = ` (${fs.statSync(full).size} B)`; } catch (_) { /* vanished */ }
            lines.push(`${indent}${e.name}${size}${protectedName ? "  [protected: Noah cannot read it]" : ""}`);
          }
        }
      };
      walk(real, 1);
      return ok({ path: shown, listing: lines.join("\n"), count: lines.length, truncated });
    } catch (err) {
      return fromError(err, shown);
    }
  }

  // ----------------------------------------------------------------- search

  /** @param {{ pattern: string, path?: string, glob?: string, ignoreCase?: boolean, literal?: boolean, maxResults?: number }} a */
  async search({ pattern, path: p = ".", glob, ignoreCase = false, literal = false, maxResults = 100 }) {
    if (typeof pattern !== "string" || !pattern) return fail("invalid_arguments", "pattern is empty");
    let re;
    try {
      re = new RegExp(literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, ignoreCase ? "i" : "");
    } catch (e) {
      return fail("invalid_pattern", `not a valid regular expression (${e.message}); set literal:true to search for the text as it is`);
    }
    let shown = p;
    try {
      const real = this.workspace.resolve(p);
      shown = this.workspace.display(real);
      const st = fs.statSync(real);
      const globRe = glob ? globToRegex(String(glob)) : null;
      const globOnName = glob && !String(glob).includes("/");
      const cap = Math.min(500, Math.max(1, Math.floor(Number(maxResults)) || 100));
      const results = [];
      let files = 0;
      let truncated = false;
      const deadline = Date.now() + SEARCH_BUDGET_MS;
      const searchFile = (file) => {
        const rel = this.workspace.display(file);
        if (globRe && !globRe.test(globOnName ? path.basename(file) : rel)) return;
        let s;
        try { s = fs.statSync(file); } catch (_) { return; }
        if (!s.isFile() || s.size > MAX_SEARCH_FILE || isSecretName(path.basename(file))) return;
        let buf;
        try { buf = fs.readFileSync(file); } catch (_) { return; }
        if (buf.subarray(0, 8000).includes(0)) return;
        files++;
        const lines = buf.toString("utf8").split(/\r\n|\n|\r/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i].slice(0, 2000))) {
            results.push(`${rel}:${i + 1}: ${clip(lines[i].trim(), 200)}`);
            if (results.length >= cap) { truncated = true; return; }
          }
        }
      };
      const stack = st.isDirectory() ? [real] : [];
      if (!st.isDirectory()) searchFile(real);
      while (stack.length && !truncated) {
        if (Date.now() > deadline) { truncated = true; break; }
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        const subdirs = [];
        for (const e of entries) {
          if (e.isSymbolicLink()) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) subdirs.push(full); } else searchFile(full);
          if (truncated) break;
        }
        for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
      }
      return ok({ path: shown, matches: results.join("\n"), count: results.length, filesSearched: files, truncated });
    } catch (err) {
      return fromError(err, shown);
    }
  }

  // ----------------------------------------------------------------- write

  _store(real, content) {
    const tmp = `${real}.noah-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, real);
    } catch (_) {
      try { fs.unlinkSync(tmp); } catch (__) { /* none */ }
      fs.writeFileSync(real, content); // a virus scanner or an open handle can refuse the rename: write in place instead
    }
    return fs.statSync(real);
  }

  /** @param {{ path: string, content: string, overwrite?: boolean }} a */
  async write({ path: p, content, overwrite = false }) {
    if (typeof content !== "string") return fail("invalid_arguments", "content must be text");
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_WRITE_BYTES) return fail("too_large", `that is ${(bytes / 1048576).toFixed(1)} MB: write files of at most ${MAX_WRITE_BYTES / 1048576} MB`);
    let shown = p;
    try {
      const real = this.workspace.resolve(p, { write: true });
      shown = this.workspace.display(real);
      let st = null;
      try { st = fs.statSync(real); } catch (e) { if (e.code !== "ENOENT") throw e; }
      let text = content;
      let old = null;
      if (st) {
        if (st.isDirectory()) return fail("is_directory", `${shown} is a folder`);
        if (!overwrite) return fail("exists", `${shown} already exists. Change part of it with fs_edit, or replace all of it with overwrite:true (after reading it with fs_read).`);
        const bad = this._readCheck(real, shown, st);
        if (bad) return bad;
        old = fs.readFileSync(real, "utf8");
        if (old.includes("\r\n") && !text.includes("\r\n")) text = text.replace(/\n/g, "\r\n"); // keep the file's own line endings
      }
      const isTest = !!st && isTestPath(shown);
      const runReason = !isTest && old !== null ? changesTestRun(shown, old, text) : null;
      const denied = await this._gate(isTest ? testRisk("replaces") : runReason ? runRisk(runReason) : risk("medium", "write", st ? "replaces a file" : "creates a file"), `${st ? "Overwrite" : "Create"} ${shown}${isTest ? " (a test file)" : runReason ? " (changes how the tests are run)" : ""}`);
      if (denied) return denied;
      fs.mkdirSync(path.dirname(real), { recursive: true });
      const after = this._store(real, text);
      this._note(real, after, true);
      this.state.recordFileChange({ path: shown, op: st ? "write" : "create", bytes: Buffer.byteLength(text), check: isTest || !!runReason, diff: old !== null ? changedLines(old, text) : `(new file, ${Buffer.byteLength(text)} bytes)` });
      return ok({ path: shown, created: !st, bytes: Buffer.byteLength(text) });
    } catch (err) {
      return fromError(err, shown);
    }
  }

  // ----------------------------------------------------------------- edit

  /** @param {{ path: string, find: string, replace: string, replaceAll?: boolean }} a */
  async edit({ path: p, find, replace, replaceAll = false }) {
    if (typeof find !== "string" || !find) return fail("invalid_arguments", "find must be the exact text to replace (not empty)");
    if (typeof replace !== "string") return fail("invalid_arguments", "replace must be text (it can be empty to delete the found text)");
    if (find === replace) return fail("no_change", "find and replace are identical: nothing to change");
    let shown = p;
    try {
      const real = this.workspace.resolve(p, { write: true });
      shown = this.workspace.display(real);
      const st = fs.statSync(real);
      if (st.isDirectory()) return fail("is_directory", `${shown} is a folder`);
      const bad = this._readCheck(real, shown, st);
      if (bad) return bad;
      let text = fs.readFileSync(real, "utf8");
      const bom = text.charCodeAt(0) === 0xfeff;
      if (bom) text = text.slice(1);
      const crlf = text.includes("\r\n");
      const pureLf = !crlf && !text.includes("\r");
      let f = find;
      let r = replace;
      let n = countOf(text, f);
      if (n === 0 && crlf && f.includes("\n") && !f.includes("\r\n")) { f = f.replace(/\n/g, "\r\n"); n = countOf(text, f); }
      if (n === 0 && pureLf && f.includes("\r\n")) { f = f.replace(/\r\n/g, "\n"); n = countOf(text, f); }
      if (crlf) r = r.replace(/\r?\n/g, "\r\n");
      else if (pureLf) r = r.replace(/\r\n/g, "\n");
      if (n === 0) {
        const first = find.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length >= 6) || "";
        const near = [];
        if (first) text.split(/\r\n|\n|\r/).forEach((l, i) => { if (near.length < 2 && l.includes(first)) near.push(`line ${i + 1}: ${clip(l.trim(), 120)}`); });
        return fail("not_found", `The text to replace was not found in ${shown}. Match it exactly, including spaces and indentation (do not include the line numbers fs_read shows).${near.length ? ` The first line of it appears at ${near.join("; ")}.` : ""}`);
      }
      if (n > 1 && !replaceAll) {
        const at = [];
        for (let i = text.indexOf(f); i >= 0 && at.length < 5; i = text.indexOf(f, i + f.length)) at.push(lineOf(text, i));
        return fail("ambiguous", `That text occurs ${n} times in ${shown} (lines ${at.join(", ")}${n > at.length ? ", ..." : ""}). Include more of the surrounding lines so it matches once, or set replaceAll:true.`);
      }
      const firstAt = text.indexOf(f);
      const next = replaceAll ? text.split(f).join(r) : text.slice(0, firstAt) + r + text.slice(firstAt + f.length);
      const isTest = isTestPath(shown);
      const runReason = !isTest ? changesTestRun(shown, text, next) : null;
      const denied = await this._gate(isTest ? testRisk("edits") : runReason ? runRisk(runReason) : risk("medium", "write", "edits a file"), `Edit ${shown}${isTest ? " (a test file)" : runReason ? " (changes how the tests are run)" : ""}`);
      if (denied) return denied;
      const after = this._store(real, (bom ? BOM : "") + next);
      this._note(real, after, true);
      this.state.recordFileChange({ path: shown, op: "edit", bytes: Buffer.byteLength(next), check: isTest || !!runReason, diff: changedLines(find, replace) });
      const at = lineOf(text, firstAt);
      const shownLines = next.split(/\r\n|\n|\r/);
      const from = Math.max(1, at - 2);
      const snippet = shownLines.slice(from - 1, at + 2 + (r.split("\n").length - 1)).map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join("\n");
      return ok({ path: shown, replacements: replaceAll ? n : 1, line: at, snippet });
    } catch (err) {
      return fromError(err, shown);
    }
  }

  // ----------------------------------------------------------------- delete

  /** @param {{ path: string, recursive?: boolean }} a */
  async delete({ path: p, recursive = false }) {
    let shown = p;
    try {
      const real = this.workspace.resolve(p, { write: true });
      shown = this.workspace.display(real);
      if (this.workspace.roots().some((r) => keyOf(r) === keyOf(real))) return fail("protected_path", "the workspace folder itself cannot be deleted");
      const st = fs.lstatSync(real);
      const isTest = st.isFile() && isTestPath(shown);
      let r = isTest ? testRisk("deletes") : risk("medium", "write", "deletes a file");
      if (st.isDirectory() && !st.isSymbolicLink()) {
        const empty = fs.readdirSync(real).length === 0;
        if (!empty && !recursive) return fail("not_empty", `${shown} is a folder with files in it. Set recursive:true to delete it and everything inside.`);
        if (!empty) r = GENERATED_DIRS.has(path.basename(real)) ? risk("medium", "delete_generated", "removes a generated folder (it can be rebuilt)") : risk("high", "destructive", "deletes a folder and everything inside it");
        else r = risk("medium", "write", "removes an empty folder");
      }
      const denied = await this._gate(r, `Delete ${shown}${isTest ? " (a test file)" : ""}`);
      if (denied) return denied;
      if (st.isDirectory() && !st.isSymbolicLink() && !recursive) fs.rmdirSync(real); // rmSync refuses a folder unless recursive, even an empty one
      else fs.rmSync(real, { recursive: !!recursive, force: false });
      this._seen.delete(keyOf(real));
      this.state.recordFileChange({ path: shown, op: "delete", diff: "(deleted)" });
      return ok({ path: shown, deleted: true });
    } catch (err) {
      return fromError(err, shown);
    }
  }
}

module.exports = { FsTools, globToRegex };
