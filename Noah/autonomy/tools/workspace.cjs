// Noah/autonomy/tools/workspace.cjs
//
// WHERE Noah may work. A mission can only touch folders the user explicitly granted (the "workspace roots"); everything a tool
// reads or writes goes through resolve(), which answers with the real, canonical path or throws a PolicyError. Rules:
//
//   * a path is judged by its REAL location: `..`, symlinks, junctions and 8.3 short names cannot lead out of a root
//   * Windows tricks are refused outright: device paths (\\?\, \\.\), network (UNC) paths, alternate data streams (a.txt:x),
//     reserved device names (CON, NUL, COM1...), segments ending in a dot or space (Windows strips them: `.env.` is `.env`)
//   * secrets are unreadable AND unwritable inside a root: everything a tool reads is sent to the model provider, so a `.env` or
//     a private key must never reach it. `.git` is off limits to the file tools (use git); `node_modules` is read-only
//   * a root cannot be a whole drive, the user's home folder, an ancestor of it, or a system folder
//
// This is a guard rail against mistakes and prompt injection, not an operating-system sandbox: it cannot stop a program that is
// itself allowed to run from touching other files. (The check and the use are also two steps; a race between them is accepted.)

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

class PolicyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PolicyError";
    this.code = code; // invalid_path | reserved_name | no_workspace | root_too_broad | outside_workspace | protected_path
  }
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const key = (p) => (CASE_INSENSITIVE ? String(p).toLowerCase() : String(p));
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Pure syntax checks (no disk access). `platform` is a parameter so the Windows rules are testable anywhere. */
function checkPathSyntax(p, platform = process.platform) {
  if (typeof p !== "string" || !p.trim()) throw new PolicyError("the path is empty", "invalid_path");
  if (p.includes("\0")) throw new PolicyError("the path contains a NUL character", "invalid_path");
  if (p.length > 1024) throw new PolicyError("the path is too long", "invalid_path");
  if (platform === "win32") {
    if (/^(\\\\|\/\/)[?.][\\/]/.test(p)) throw new PolicyError("device paths (\\\\?\\ and \\\\.\\) are not allowed", "invalid_path");
    if (/^(\\\\|\/\/)/.test(p)) throw new PolicyError("network (UNC) paths are not allowed", "invalid_path");
    if (p.replace(/^[a-zA-Z]:/, "").includes(":")) throw new PolicyError("a ':' inside a path (an alternate data stream) is not allowed", "invalid_path");
    for (const seg of p.split(/[\\/]+/)) {
      if (!seg || seg === "." || seg === "..") continue;
      if (/[. ]$/.test(seg)) throw new PolicyError(`"${seg}" ends with a dot or space, which Windows silently removes`, "invalid_path");
      if (RESERVED.test(seg)) throw new PolicyError(`"${seg}" is a reserved Windows device name`, "reserved_name");
    }
  }
  return p;
}

/** realpath of the nearest EXISTING ancestor (long names, links followed) plus the part that does not exist yet. */
function realpathNearest(abs) {
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
      const parent = path.dirname(cur);
      if (parent === cur) throw e;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function isInside(real, root) {
  const rel = path.relative(key(root), key(real));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

const PROTECTED_FILE = [
  /^\.env(\..+)?$/i,
  /^\.(npmrc|pypirc|netrc|git-credentials|dockercfg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|pfx|p12|keystore|jks|kdbx|ppk)$/i,
  /^(secrets?|credentials?)(\.(json|ya?ml|toml|txt))?$/i,
  /^key\.json$/i,
  /^service[-_]?account.*\.json$/i,
];
const ENV_SAFE = /^\.env\.(example|sample|template|defaults?|dist)$/i;
const PROTECTED_DIR = new Set([".git", ".ssh", ".aws", ".gnupg", ".azure", ".kube"]);

/** Is this FILE NAME a secret? (shared with the command policy, which sees names rather than resolved paths) */
function isSecretName(name) {
  const n = String(name || "");
  if (ENV_SAFE.test(n)) return false;
  return PROTECTED_FILE.some((re) => re.test(n));
}

function tooBroad(real) {
  const parsed = path.parse(real);
  if (key(parsed.root) === key(real)) return "a whole drive or the filesystem root is too broad: pick the project folder itself";
  const home = (() => { try { return fs.realpathSync.native(os.homedir()); } catch (_) { return os.homedir(); } })();
  if (isInside(home, real)) return "that folder contains your home folder (or is it): pick a project folder inside it";
  const system = [process.env.SystemRoot, process.env.windir, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData, "/etc", "/usr", "/bin", "/sbin", "/System", "/Library", "/var", "/opt", "/proc", "/dev"].filter(Boolean);
  for (const s of system) if (isInside(real, s)) return "system folders cannot be used as a workspace";
  return null;
}

class Workspace {
  /** @param {{ roots?: string[], platform?: string }} [o] */
  constructor({ roots = [], platform = process.platform } = {}) {
    this.platform = platform;
    this._roots = [];
    for (const r of roots) this.grant(r);
  }

  /** The user grants a folder. Returns its canonical path. */
  grant(dir) {
    checkPathSyntax(dir, this.platform);
    let real;
    try {
      real = fs.realpathSync.native(path.resolve(dir));
    } catch (_) {
      throw new PolicyError(`the folder does not exist: ${dir}`, "invalid_path");
    }
    if (!fs.statSync(real).isDirectory()) throw new PolicyError(`not a folder: ${dir}`, "invalid_path");
    const why = tooBroad(real);
    if (why) throw new PolicyError(why, "root_too_broad");
    if (!this._roots.some((r) => key(r) === key(real))) this._roots.push(real);
    return real;
  }

  revoke(dir) {
    const real = (() => { try { return fs.realpathSync.native(path.resolve(dir)); } catch (_) { return path.resolve(dir); } })();
    this._roots = this._roots.filter((r) => key(r) !== key(real));
  }

  roots() {
    return [...this._roots];
  }

  hasRoots() {
    return this._roots.length > 0;
  }

  /** The granted root a canonical path lives in, or null. */
  rootOf(real) {
    return this._roots.find((r) => isInside(real, r)) || null;
  }

  /** Why this canonical path is off limits for reading/writing, or null. */
  protectedReason(real, root, { write = false } = {}) {
    const rel = path.relative(root, real);
    const segs = rel.split(path.sep).filter(Boolean);
    for (const s of segs) if (PROTECTED_DIR.has(key(s))) return `${s} is protected (it can hold credentials or repository internals): use the git commands instead`;
    const name = segs[segs.length - 1] || "";
    if (isSecretName(name)) return `${name} looks like a secret file: Noah never reads or writes those (what it reads is sent to the model)`;
    if (write && segs.some((s) => key(s) === "node_modules")) return "node_modules is generated: change package.json and reinstall instead of editing it";
    return null;
  }

  /**
   * The canonical path for `p` (relative paths are taken from `cwd`, default the first root), or a PolicyError.
   * @param {string} p
   * @param {{ cwd?: string, write?: boolean }} [o]
   */
  resolve(p, { cwd, write = false } = {}) {
    if (!this._roots.length) throw new PolicyError("no folder has been granted to Noah yet", "no_workspace");
    checkPathSyntax(p, this.platform);
    const base = cwd ? this.resolve(cwd) : this._roots[0];
    const real = realpathNearest(path.resolve(base, p));
    const root = this.rootOf(real);
    if (!root) throw new PolicyError(`${path.resolve(base, p)} is outside the folders Noah may use`, "outside_workspace");
    const why = this.protectedReason(real, root, { write });
    if (why) throw new PolicyError(why, "protected_path");
    return real;
  }

  /** Non-throwing: does this path leave the workspace? (used by the command policy on arguments that look like paths) */
  escapes(p, { cwd } = {}) {
    try {
      checkPathSyntax(p, this.platform);
      const base = cwd ? realpathNearest(path.resolve(cwd)) : this._roots[0];
      return !this.rootOf(realpathNearest(path.resolve(base, p)));
    } catch (_) {
      return true;
    }
  }

  /** A short name for the model and the logs: root-relative with forward slashes (absolute if outside every root). */
  display(real) {
    const root = this.rootOf(real);
    return (root ? path.relative(root, real) || "." : real).split(path.sep).join("/");
  }
}

module.exports = { Workspace, PolicyError, checkPathSyntax, realpathNearest, isInside, isSecretName, tooBroad };
