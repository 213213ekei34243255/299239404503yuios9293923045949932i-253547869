// Noah/autonomy/tools/registry.cjs
//
// ToolRegistry: the tool surface a mission's model sees, and the one place every tool call goes through.
//
//   schemas()   function-calling definitions (JSON Schema) for the model provider
//   execute()   validate the arguments STRICTLY -> run -> record a one-line observation in MissionState -> return the result
//   verifierEnv()   the three functions GoalVerifier needs, backed by the same workspace-scoped tools
//
// Strict validation is deliberate: a model that invents an argument (`filepath`, `exec`) or sends a number as a string must get a
// clear correction ("unknown argument filepath; valid: path, offset, limit"), not a tool that silently does something else.
// Tool names use underscores (fs_read) because not every provider accepts dots in function names.

"use strict";

const fs = require("fs");
const { Workspace, PolicyError } = require("./workspace.cjs");
const { FsTools } = require("./fs-tools.cjs");
const { ShellTool } = require("./shell.cjs");
const { classifyCommand } = require("./command-policy.cjs");
const { DESKTOP_DEFS, DesktopTools } = require("../../desktop/tools.cjs");

const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

const P = {
  str: (description, required = false) => ({ type: "string", description, required }),
  int: (description, required = false) => ({ type: "integer", description, required }),
  bool: (description, required = false) => ({ type: "boolean", description, required }),
  oneOf: (description, values, required = false) => ({ type: "string", description, required, enum: values }),
  strings: (description, required = false) => ({ type: "array", description, required, items: { type: "string" } }),
  /** a list of objects; `shape` documents the fields for the model, the content is checked by whoever consumes it */
  objects: (description, shape, required = false) => ({ type: "array", description, required, items: { type: "object", properties: shape } }),
};

const DEFS = {
  fs_read: {
    description: "Read a text file (numbered lines). Required before fs_edit or fs_write on an existing file. Long files: use offset/limit.",
    params: { path: P.str("file path, relative to the workspace", true), offset: P.int("first line to show (1-based)"), limit: P.int("how many lines to show") },
    run: (t, a) => t.fs.read(a),
    note: (a, r) => (r.ok ? `fs_read ${r.path} (lines ${r.startLine}-${r.endLine} of ${r.totalLines})` : `fs_read ${a.path} failed: ${r.code}`),
  },
  fs_list: {
    description: "List a folder (folders first). Skips node_modules, .git and build output; secret files are shown as protected.",
    params: { path: P.str("folder, default the workspace root"), depth: P.int("levels to show, 1-4"), max: P.int("most entries to show") },
    run: (t, a) => t.fs.list(a),
    note: (a, r) => (r.ok ? `fs_list ${r.path} (${r.count} entries)` : `fs_list ${a.path || "."} failed: ${r.code}`),
  },
  fs_search: {
    description: "Search file contents with a regular expression (or literal text). Skips node_modules, .git, binaries and secrets.",
    params: { pattern: P.str("regular expression, or text if literal is true", true), path: P.str("folder or file, default the workspace root"), glob: P.str("only files matching, e.g. *.js or src/**/*.ts"), ignoreCase: P.bool("case-insensitive"), literal: P.bool("treat the pattern as plain text"), maxResults: P.int("most matches to show") },
    run: (t, a) => t.fs.search(a),
    note: (a, r) => (r.ok ? `fs_search /${clip(a.pattern, 40)}/ -> ${r.count} matches` : `fs_search failed: ${r.code}`),
  },
  fs_write: {
    description: "Create a file, or replace one completely (overwrite:true, only after reading it). To change part of a file use fs_edit.",
    params: { path: P.str("file path", true), content: P.str("the whole file content", true), overwrite: P.bool("replace an existing file") },
    run: (t, a) => t.fs.write(a),
    note: (a, r) => (r.ok ? `fs_write ${r.path} (${r.created ? "created" : "replaced"}, ${r.bytes} bytes)` : `fs_write ${a.path} failed: ${r.code}`),
  },
  fs_edit: {
    description: "Replace exact text in a file you have read. `find` must match once (include surrounding lines if needed) unless replaceAll is true.",
    params: { path: P.str("file path", true), find: P.str("the exact existing text (without line numbers)", true), replace: P.str("the new text (may be empty)", true), replaceAll: P.bool("replace every occurrence") },
    run: (t, a) => t.fs.edit(a),
    note: (a, r) => (r.ok ? `fs_edit ${r.path} (line ${r.line})` : `fs_edit ${a.path} failed: ${r.code}`),
  },
  fs_delete: {
    description: "Delete a file or an empty folder; recursive:true for a folder with files in it (asks the user).",
    params: { path: P.str("path", true), recursive: P.bool("delete a folder and everything in it") },
    run: (t, a) => t.fs.delete(a),
    note: (a, r) => (r.ok ? `fs_delete ${r.path}` : `fs_delete ${a.path} failed: ${r.code}`),
  },
  shell_run: {
    description: "Run a shell command in the workspace. No input is possible (nothing can prompt), the environment is clean, and it is stopped on timeout. The same failed command is not run twice unless something changed.",
    params: { cmd: P.str("the command line", true), cwd: P.str("folder to run in, default the workspace root"), timeoutMs: P.int("milliseconds before it is stopped (default 120000)"), retry: P.bool("run again although it just failed, because the failure looked temporary") },
    run: (t, a, o) => t.shell.run(a, o),
    note: (a, r) => `shell_run ${clip(a.cmd, 70)} -> ${r.exitCode !== undefined && r.exitCode !== null ? `exit ${r.exitCode}` : r.code || "not run"}`,
  },
};

function schemaOf(def) {
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(def.params)) {
    properties[k] = { type: v.type, description: v.description, ...(v.enum ? { enum: v.enum } : {}), ...(v.items ? { items: v.items } : {}) };
    if (v.required) required.push(k);
  }
  return { type: "object", properties, required };
}

const typeWord = (spec) => (spec.type === "integer" ? "a whole number" : spec.type === "boolean" ? "true or false" : spec.type === "array" ? (spec.items && spec.items.type === "object" ? "a list of objects" : "a list of text items") : "text");

/** Check `args` against a tool's parameters. Returns { ok:true, args } (with harmless coercions) or { ok:false, message }. */
function validateArgs(name, def, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return { ok: false, message: `${name}: the arguments must be an object` };
  const valid = Object.keys(def.params);
  const out = {};
  for (const k of Object.keys(args)) {
    if (!valid.includes(k)) return { ok: false, message: `${name}: unknown argument "${k}" (valid: ${valid.join(", ")})` };
    const spec = def.params[k];
    let v = args[k];
    if (v === undefined || v === null) continue;
    if (spec.type === "integer" && typeof v === "string" && /^-?\d+$/.test(v.trim())) v = Number(v);
    if (spec.type === "boolean" && typeof v === "string" && /^(true|false)$/i.test(v.trim())) v = v.trim().toLowerCase() === "true";
    if (spec.type === "array" && typeof v === "string") { try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) v = parsed; } catch (_) { /* reported below */ } } // a list sent as JSON text
    const okType = spec.type === "string" ? typeof v === "string" : spec.type === "integer" ? Number.isInteger(v) : spec.type === "array" ? Array.isArray(v) : typeof v === "boolean";
    if (!okType) return { ok: false, message: `${name}: "${k}" must be ${typeWord(spec)}` };
    if (spec.enum && !spec.enum.includes(v)) return { ok: false, message: `${name}: "${k}" must be one of: ${spec.enum.join(", ")}` };
    if (spec.type === "array") {
      if (v.length > 50) return { ok: false, message: `${name}: "${k}" has too many items (at most 50)` };
      const bad = v.findIndex((it) => (spec.items.type === "string" ? typeof it !== "string" : !(it && typeof it === "object" && !Array.isArray(it))));
      if (bad >= 0) return { ok: false, message: `${name}: item ${bad + 1} of "${k}" must be ${spec.items.type === "string" ? "text" : "an object"}` };
    }
    out[k] = v;
  }
  for (const [k, spec] of Object.entries(def.params)) if (spec.required && (out[k] === undefined || (spec.type === "string" && out[k] === "" && k === "path"))) return { ok: false, message: `${name}: "${k}" is required` };
  return { ok: true, args: out };
}

class ToolRegistry {
  /**
   * @param {object} o
   * @param {import('./workspace.cjs').Workspace} o.workspace
   * @param {import('../mission-state.cjs').MissionState} o.state
   * @param {(req: object) => Promise<boolean>} [o.confirm]
   * @param {() => string} [o.getMode]
   * @param {string} [o.logDir]
   */
  constructor({ workspace, state, confirm, getMode, logDir, desktop = null }) {
    this.workspace = workspace;
    this.desktop = desktop; // optional: Noah's eyes and hands on the Windows desktop (desktop/tools.cjs)
    this.defs = desktop ? { ...DEFS, ...DESKTOP_DEFS } : DEFS;
    this.state = state;
    this.fs = new FsTools({ workspace, state, confirm, getMode });
    this.shell = new ShellTool({ workspace, state, confirm, getMode, logDir });
  }

  names() {
    return Object.keys(this.defs);
  }

  /**
   * Would this call change anything? ("act" vs "inspect"). A shell command is judged by the command policy; a command that cannot even
   * be placed (bad folder) counts as changing things, so nothing slips through as "read only".
   */
  isMutating(name, args = {}) {
    if (name in DESKTOP_DEFS) return DesktopTools.isMutating(name);
    if (name === "fs_write" || name === "fs_edit" || name === "fs_delete") return true;
    if (name !== "shell_run") return false;
    try {
      const cwd = this.workspace.resolve((args && args.cwd) || ".");
      return classifyCommand(String(args && args.cmd), { workspace: this.workspace, cwd }).mutates;
    } catch (_) {
      return true;
    }
  }

  /** Function-calling definitions for the model. */
  schemas() {
    return Object.entries(this.defs).map(([name, def]) => ({ name, description: def.description, parameters: schemaOf(def) }));
  }

  /** @returns {Promise<object>} always a result object: { ok:true, ... } or { ok:false, code, message } */
  async execute(name, args, { signal } = {}) {
    const def = this.defs[name];
    if (!def) return { ok: false, code: "unknown_tool", message: `unknown tool "${name}". Valid tools: ${this.names().join(", ")}` };
    const v = validateArgs(name, def, args);
    if (!v.ok) return { ok: false, code: "invalid_arguments", message: v.message };
    let result;
    try {
      result = await def.run(this, v.args, { signal });
    } catch (err) {
      result = err instanceof PolicyError ? { ok: false, code: err.code, message: err.message } : { ok: false, code: "tool_error", message: clip((err && err.message) || String(err), 200) };
    }
    try {
      this.state.recordObservation({ tool: name, summary: def.note(v.args, result) });
    } catch (_) {
      /* an observation note must never break a tool call */
    }
    return result;
  }

  /** The pictures the desktop tools took since the last model message (handed over once). */
  takeImages() {
    return this.desktop ? this.desktop.takeImages() : [];
  }

  /** What GoalVerifier needs: the same workspace-scoped file and shell access the model has, and no more. */
  verifierEnv() {
    const ws = this.workspace;
    return {
      run: this.shell.runner(),
      // a path the policy refuses makes the CHECK fail (GoalVerifier turns the error into "the check could not run"); it must never read as "does not exist"
      exists: async (p) => fs.existsSync(ws.resolve(p)),
      readFile: async (p) => fs.readFileSync(ws.resolve(p), "utf8"),
      desktop: this.desktop ? this.desktop.verifierEnv() : null,
    };
  }
}

module.exports = { ToolRegistry, validateArgs, schemaOf, P, DEFS, Workspace };
