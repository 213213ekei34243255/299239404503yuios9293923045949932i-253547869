// Noah/autonomy/tools/command-policy.cjs
//
// What is this shell command going to do, and may Noah run it? classifyCommand() turns a command line into the same risk object
// the browser safety layer uses ({ level, categories, reasons }), and decideCommand() hands it to safety/policy.cjs `decide`, so
// the three modes behave exactly as everywhere else in Noah:
//
//   autonomous  confirm HIGH (and destructive / publish / upload, always)     supervised  also confirm MEDIUM     strict  confirm every change
//   blocked is never run, in any mode.
//
//   low      reads and verifies (ls, git status, npm test, pytest, eslint)       medium   changes files inside the workspace (install, build, git
//                                                                                commit, running a script, inline code without anything dangerous in it)
//   high     deletes recursively, publishes / pushes / uploads, runs downloaded code, global installs, anything that reaches outside the
//            workspace, inline code that deletes or spawns or uses the network, text it cannot inspect (unbalanced quotes, nested $(...))
//   blocked  changes the machine itself (sudo, registry, services, scheduled tasks, shutdown), runs encoded commands, reaches secret files or
//            paths outside the workspace with a file command
//
// The shell is parsed the way the shell it will run in parses it: on Windows only double quotes quote (so `echo it's && rm -rf x` is two
// commands), and cmd /c, bash -c and powershell -Command are looked into rather than trusted.
//
// HONESTY: this is classification by reading the text. It stops accidents and injected one-liners; it is not a sandbox, and a program that is
// allowed to run (a script the model wrote, `node -e`) can do anything its user can. See workspace.cjs for the other half of the guard rail.

"use strict";

const os = require("os");
const path = require("path");
const { rank } = require("../../safety/risk.cjs");
const { decide } = require("../../safety/policy.cjs");
const { isSecretName } = require("./workspace.cjs");
const { isTestPath } = require("./test-paths.cjs");

const MAX_COMMAND = 4000;

const mk = (level, category, reason) => ({ level, categories: category ? [category] : [], reasons: reason ? [reason] : [] });

function mergeRisk(list) {
  let level = "low";
  for (const r of list) if (rank(r.level) > rank(level)) level = r.level;
  const categories = [...new Set(list.flatMap((r) => r.categories))];
  const reasons = [...new Set([...list].sort((a, b) => rank(b.level) - rank(a.level)).flatMap((r) => r.reasons))];
  return { level, categories, reasons };
}

// ------------------------------------------------------------------ parsing

const quoteChars = (platform) => (platform === "win32" ? '"' : "'\"");

/** Split at unquoted ; && || | & and newlines. `piped` marks a segment whose input is the previous segment's output. */
function splitSegments(cmd, platform = process.platform) {
  const quotes = quoteChars(platform);
  const segments = [];
  let cur = "";
  let curPiped = false;
  let q = null;
  const push = (nextPiped) => {
    segments.push({ text: cur.trim(), piped: curPiped });
    cur = "";
    curPiped = nextPiped;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];
    if (q) {
      cur += c;
      if (c === "\\" && q === '"' && platform !== "win32" && n !== undefined) { cur += n; i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (platform !== "win32" && c === "\\" && n !== undefined) { cur += c + n; i++; continue; }
    if (quotes.includes(c)) { q = c; cur += c; continue; }
    if (c === "&" && n === "&") { push(false); i++; continue; }
    if (c === "|" && n === "|") { push(false); i++; continue; }
    if (c === "&") {
      const prev = cur.trimEnd().slice(-1);
      if (prev === ">" || prev === "<" || n === ">") { cur += c; continue; } // 2>&1 and &>file are redirections, not separators
      push(false);
      continue;
    }
    if (c === "|") { push(true); continue; }
    if (c === ";" || c === "\n" || c === "\r") { push(false); continue; }
    cur += c;
  }
  const unbalanced = q !== null;
  push(false);
  return { segments: segments.filter((s) => s.text), unbalanced };
}

/** Split one segment into words, with quotes removed. `quoted` marks a word that had quotes (so `">"` is not a redirection). */
function tokenize(text, platform = process.platform) {
  const quotes = quoteChars(platform);
  const out = [];
  let cur = null;
  let quoted = false;
  let q = null;
  const flush = () => {
    if (cur !== null) out.push({ v: cur, quoted });
    cur = null;
    quoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === "\\" && q === '"' && platform !== "win32" && i + 1 < text.length) { cur += text[++i]; continue; }
      if (c === q) { q = null; continue; }
      cur += c;
      continue;
    }
    if (platform !== "win32" && c === "\\" && i + 1 < text.length) { cur = (cur === null ? "" : cur) + text[++i]; continue; }
    if (quotes.includes(c)) { q = c; quoted = true; if (cur === null) cur = ""; continue; }
    if (/\s/.test(c)) { flush(); continue; }
    cur = (cur === null ? "" : cur) + c;
  }
  flush();
  return out;
}

function extractRedirects(tokens) {
  const words = [];
  const redirects = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const m = !t.quoted && /^(\d*|&)(>>?|<)(.*)$/.exec(t.v);
    if (!m) { words.push(t); continue; }
    let target = m[3];
    if (!target && i + 1 < tokens.length) target = tokens[++i].v;
    if (!target || target.startsWith("&")) continue; // 2>&1 duplicates a stream, it is not a file
    if (/^(\/dev\/null|nul)$/i.test(target)) continue;
    redirects.push({ op: m[2], target });
  }
  return { words, redirects };
}

/** The text inside $( ... ) and `...` (outside single quotes on POSIX). Nested ones are found again when the inner text is classified. */
function substitutions(text, platform = process.platform) {
  const found = [];
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === q) q = null; continue; }
    if (platform !== "win32" && c === "'") { q = "'"; continue; }
    if (c === "$" && text[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < text.length && depth > 0; j++) { if (text[j] === "(") depth++; else if (text[j] === ")") depth--; }
      if (depth === 0) { found.push(text.slice(i + 2, j - 1)); i = j - 1; } else found.push(null); // unbalanced: cannot be inspected
    } else if (c === "`") {
      const j = text.indexOf("`", i + 1);
      if (j > i) { found.push(text.slice(i + 1, j)); i = j; }
    }
  }
  return found;
}

const baseName = (t) => path.basename(String(t).replace(/\\/g, "/")).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");

// ------------------------------------------------------------------ vocabulary

const WRAPPERS = new Set(["cross-env", "env", "time", "nohup", "nice", "call", "command", "exec", "start"]);
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "fish", "iex", "invoke-expression", "powershell", "pwsh", "node", "python", "python3", "py", "perl", "ruby", "php", "cmd"]);
const NETWORK_FETCH = new Set(["curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod"]);
const NO_SECRET_CHECK = new Set(["echo", "printf", "write-output", "write-host"]); // text, not file arguments
const GENERATED_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".next", ".nuxt", ".cache", ".parcel-cache", ".turbo", "target", "__pycache__", ".pytest_cache", ".mypy_cache", ".venv", "venv", ".gradle"]);
const PROTECTED_DIR_NAMES = new Set([".ssh", ".aws", ".gnupg", ".azure", ".kube"]);

const BLOCKED_PROGS = new Set(["sudo", "su", "doas", "runas", "shutdown", "reboot", "halt", "poweroff", "bcdedit", "diskpart", "format", "fdisk", "vssadmin", "regedit", "netsh", "takeown", "icacls", "cacls", "cmdkey", "setx", "dd", "shred", "wipefs", "stop-computer", "restart-computer", "set-executionpolicy", "add-mppreference", "set-mppreference", "new-service", "set-service", "remove-service", "new-localuser", "add-localgroupmember", "enable-psremoting", "invoke-command"]);
const LOTL = new Set(["mshta", "rundll32", "regsvr32", "bitsadmin", "certutil", "wscript", "cscript", "msiexec", "installutil"]);

const READ_PROGS = new Set(["ls", "dir", "cat", "type", "head", "tail", "wc", "grep", "rg", "findstr", "tree", "pwd", "cd", "chdir", "echo", "printf", "where", "which", "whoami", "hostname", "date", "sort", "uniq", "diff", "fc", "more", "less", "stat", "file", "realpath", "basename", "dirname", "get-content", "gc", "get-childitem", "gci", "select-string", "get-location", "test-path", "resolve-path", "write-output", "write-host", "true", "false", "sleep", "timeout", "start-sleep", "clear", "cls", "exit", "set-location", "get-item", "get-filehash"]);
const WRITE_PROGS = new Set(["mkdir", "md", "touch", "cp", "copy", "xcopy", "mv", "move", "ren", "rename", "tee", "chmod", "ln", "mklink", "new-item", "ni", "set-content", "add-content", "ac", "out-file", "copy-item", "cpi", "move-item", "mi", "rename-item", "rni", "unlink"]);
const FILE_PROGS = new Set([...READ_PROGS, ...WRITE_PROGS, "rm", "del", "erase", "rmdir", "rd", "remove-item", "ri", "robocopy", "find"]);

const NPM_INSTALL = new Set(["install", "i", "ci", "add", "update", "upgrade", "up", "dedupe", "rebuild", "link", "remove", "uninstall", "un", "rm", "prune", "install-test", "it", "install-ci-test", "cit"]);
const NPM_OUTWARD = new Set(["publish", "login", "adduser", "logout", "token", "owner", "access", "deprecate", "unpublish", "dist-tag", "team", "org", "profile", "hook", "star", "unstar"]);
const NPM_READ = new Set(["outdated", "ls", "list", "ll", "la", "view", "info", "show", "explain", "why", "search", "help", "root", "prefix", "bin", "fund", "whoami", "ping", "repo", "docs", "bugs", "home", "-v", "--version"]);
const SCRIPT_VERIFY = /^(test|tests|spec|specs|lint|typecheck|type-check|types|check|checks|verify|validate|e2e|unit|integration|format:check|coverage|ci)(:|$|-)/i;
const SCRIPT_BUILD = /^(build|compile|dist|bundle|generate|codegen|prepare|prebuild|package|pack|make|transpile)(:|$|-)/i;
const SCRIPT_SERVER = /^(start|dev|serve|server|watch|preview|storybook)(:|$|-)/i;
const DANGEROUS_INLINE = /\b(rmSync|rmdirSync|unlinkSync|rimraf|rmtree|os\.remove|os\.rmdir|os\.system|os\.popen|subprocess|child_process|execSync|spawnSync|exec\(|spawn\(|shutil|fetch\(|http\.request|https\.request|XMLHttpRequest|urllib|requests\.|socket|net\.connect|eval\()/i;

const R = {
  read: (why) => ({ kind: "read", risk: mk("low", "", ""), mutates: false, why }),
  verify: () => ({ kind: "verify", risk: mk("low", "", ""), mutates: false }),
  write: (why) => ({ kind: "write", risk: mk("medium", "write", why || "changes files in the workspace"), mutates: true }),
  build: () => ({ kind: "build", risk: mk("medium", "build", "builds the project (writes output files)"), mutates: true }),
  install: () => ({ kind: "install", risk: mk("medium", "install", "installs packages (runs their install scripts)"), mutates: true, network: true }),
  script: (why) => ({ kind: "run_script", risk: mk("medium", "run_program", why || "runs a program or script"), mutates: true }),
  unknown: () => ({ kind: "unknown", risk: mk("medium", "run_program", "runs a program Noah does not recognise"), mutates: true }),
  destructive: (why) => ({ kind: "destructive", risk: mk("high", "destructive", why), mutates: true }),
  outward: (why, cat = "send_publish") => ({ kind: "outward", risk: mk("high", cat, why), mutates: true, network: true }),
  remote: (why) => ({ kind: "remote_code", risk: mk("high", "remote_code", why), mutates: true, network: true }),
  blocked: (why, cat = "machine_change") => ({ kind: "blocked", risk: mk("blocked", cat, why), mutates: true }),
};

// ------------------------------------------------------------------ per-program rules

const shortFlags = (args) => {
  const s = new Set();
  for (const a of args) if (/^-[A-Za-z]+$/.test(a)) for (const ch of a.slice(1)) s.add(ch);
  return s;
};
const hasWild = (args) => args.some((a) => /[*?]/.test(a));

function deletionOf(prog, args, lower) {
  const sf = shortFlags(args);
  let recursive = false;
  if (prog === "rm") recursive = sf.has("r") || sf.has("R") || lower.includes("--recursive");
  else if (prog === "del" || prog === "erase") recursive = lower.some((a) => /^\/(s|q|f)$/.test(a));
  else if (prog === "rmdir" || prog === "rd") recursive = lower.includes("/s");
  else recursive = lower.some((a) => /^-(recurse|force)$/.test(a)); // remove-item / ri
  if (!recursive && !hasWild(args)) return null;
  const targets = args.filter((a) => !/^-/.test(a) && !/^\/[a-z]$/i.test(a));
  const generated = targets.length > 0 && targets.every((t) => {
    const s = t.replace(/[\\/]+$/, "");
    return GENERATED_DIRS.has(s) && !/[*?]/.test(s);
  });
  if (generated) return { kind: "write", risk: mk("medium", "delete_generated", "removes a generated folder (it can be rebuilt)"), mutates: true };
  return R.destructive("deletes files or folders recursively or by wildcard");
}

function gitRule(args, lower) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) { i += lower[i] === "-c" || lower[i] === "-C" ? 2 : 1; }
  const sub = lower[i] || "";
  const rest = lower.slice(i + 1);
  const restRaw = args.slice(i + 1);
  const has = (...f) => f.some((x) => rest.includes(x));
  if (!sub || sub === "--version" || sub === "version" || sub === "help") return R.read();
  if (sub === "push") return R.outward("git push sends your commits to a remote");
  if (sub === "reset" && has("--hard")) return R.destructive("git reset --hard throws away uncommitted work");
  if (sub === "clean") return R.destructive("git clean deletes untracked files");
  if (sub === "restore" && has("--staged", "-s") && !has("--worktree", "-w")) return R.write("git restore --staged only unstages");
  if ((sub === "checkout" || sub === "restore") && (restRaw.some((a) => a === "." || a === "*") || has("-f", "--force", "--source"))) return R.destructive(`git ${sub} on everything throws away uncommitted work`);
  if (sub === "stash" && (has("drop", "clear"))) return R.destructive("git stash drop/clear deletes saved work");
  if (sub === "branch" && restRaw.includes("-D")) return R.destructive("git branch -D deletes a branch even if unmerged");
  if (["reflog", "gc", "prune", "filter-branch", "filter-repo", "update-ref"].includes(sub)) return R.destructive(`git ${sub} can permanently remove history`);
  if (sub === "remote" && (has("add", "set-url", "remove", "rm", "rename"))) return R.write("changes where the repository sends code");
  if (sub === "config") return has("--get", "--get-all", "--list", "-l") || !rest.length ? R.write("reads git configuration (it can contain tokens)") : R.write("changes git configuration");
  if (["status", "diff", "log", "show", "ls-files", "rev-parse", "blame", "describe", "shortlog", "grep", "ls-tree", "cat-file", "rev-list", "name-rev", "whatchanged", "count-objects", "check-ignore", "merge-base", "diff-tree", "show-ref"].includes(sub)) return R.read();
  if (sub === "branch" && (!rest.length || rest.every((a) => /^(-a|-v|-vv|-r|--list|--all|--show-current|--contains|--merged|--no-merged)$/.test(a)))) return R.read();
  if (sub === "tag" && (!rest.length || has("-l", "--list"))) return R.read();
  if (sub === "stash" && has("list", "show")) return R.read();
  if (sub === "remote" && (!rest.length || has("-v", "show", "get-url"))) return R.read();
  return { ...R.write(`git ${sub} changes the repository`), network: ["clone", "pull", "fetch", "submodule"].includes(sub) };
}

function packageManagerRule(pm, args, lower) {
  const flagless = args.filter((a) => !a.startsWith("-"));
  const sub = (flagless[0] || "").toLowerCase();
  const global = lower.some((a) => a === "-g" || a === "--global" || a === "--location=global");
  if (!sub) return pm === "yarn" ? R.install() : R.read();
  if (NPM_OUTWARD.has(sub)) return R.outward(`${pm} ${sub} talks to a package registry account`);
  if (NPM_INSTALL.has(sub)) return global ? { kind: "install", risk: mk("high", "system_install", "a global install changes the machine, not just the project"), mutates: true, network: true } : R.install();
  if (NPM_READ.has(sub) || lower.includes("--version") || lower.includes("-v")) return R.read();
  if (sub === "audit") return lower.includes("fix") ? R.install() : R.read();
  if (sub === "config" || sub === "c") return ["set", "delete", "edit"].includes((flagless[1] || "").toLowerCase()) ? { kind: "write", risk: mk("high", "security_setting", `${pm} config changes your user-level settings, outside the project`), mutates: true } : R.read();
  if (sub === "test" || sub === "t" || sub === "tst") return R.verify();
  if (["start", "stop", "restart"].includes(sub)) return { ...R.script(`${pm} ${sub} runs the project's own script`), longRunning: sub === "start" };
  if (["exec", "x", "dlx", "create"].includes(sub)) return packageRunnerRule(args.slice(args.findIndex((a) => !a.startsWith("-")) + 1));
  if (sub === "init") return R.write("creates package.json");
  if (["version", "pkg", "cache", "set-script"].includes(sub)) return R.write(`${pm} ${sub} changes project or cache files`);
  const runVerb = ["run", "run-script", "rum", "urn"].includes(sub);
  if (runVerb || pm === "yarn" || pm === "bun") {
    const script = runVerb ? (flagless[1] || "") : sub; // yarn and bun run a script by name without `run`
    if (SCRIPT_VERIFY.test(script)) return R.verify();
    if (SCRIPT_BUILD.test(script)) return R.build();
    if (SCRIPT_SERVER.test(script)) return { ...R.script(`runs the project's "${script}" script`), longRunning: true };
    return R.script(`runs the project's "${script}" script`);
  }
  return R.script(`${pm} ${sub}`);
}

/**
 * npx / dlx / exec: a known local tool is judged as that tool (with ITS flags: `tsc --noEmit` verifies, `tsc` builds); anything else
 * may download and run a package. Only the runner's own leading flags (-y, --yes, -p <pkg>, --) are skipped.
 */
function packageRunnerRule(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += /^(-p|--package)$/.test(args[i]) ? 2 : 1;
  const rest = args.slice(i);
  const tool = baseName(rest[0] || "");
  if (!tool) return R.unknown();
  const inner = programRule(tool, rest.slice(1), rest.slice(1).map((a) => a.toLowerCase()), null);
  if (inner && ["verify", "build", "read"].includes(inner.kind) && ["tsc", "eslint", "jest", "vitest", "mocha", "prettier", "playwright", "ava", "tap", "stylelint"].includes(tool)) return inner;
  return { kind: "remote_code", risk: mk("medium", "remote_code", `runs "${tool}", which may be downloaded first`), mutates: true, network: true };
}

function pythonRule(args, lower) {
  const a0 = lower[0] || "";
  if (!a0 || a0 === "--version" || a0 === "-v" || a0 === "-V") return R.read();
  if (a0 === "-c") return inlineRule("python", args.slice(1).join(" "));
  if (a0 === "-m") {
    const mod = lower[1] || "";
    if (mod === "pip") return pipRule(args.slice(2), lower.slice(2));
    if (["pytest", "unittest", "mypy", "flake8", "pyflakes", "pylint", "compileall", "doctest", "pyright"].includes(mod)) return R.verify();
    if (mod === "black" || mod === "ruff") return lower.includes("--check") || lower.includes("--diff") ? R.verify() : R.write("formats files");
    if (mod === "venv" || mod === "virtualenv") return R.write("creates a virtual environment");
    if (mod === "http.server") return { ...R.script("starts a local web server"), longRunning: true };
    if (mod === "json.tool") return R.read();
    return R.script(`runs the python module ${mod}`);
  }
  return R.script("runs a python script");
}

function pipRule(args, lower) {
  const sub = lower.find((a) => !a.startsWith("-")) || "";
  if (["install", "uninstall", "download", "wheel"].includes(sub)) return R.install();
  if (["list", "show", "freeze", "check", "config", "index", "debug", "help", "inspect", "cache"].includes(sub) || lower.includes("--version")) return R.read();
  return R.install();
}

function inlineRule(prog, code) {
  if (DANGEROUS_INLINE.test(code)) return { kind: "inline_code", risk: mk("high", "inline_code", `inline ${prog} code that deletes, runs programs or uses the network`), mutates: true, network: true };
  return { kind: "inline_code", risk: mk("medium", "inline_code", `inline ${prog} code cannot be inspected like a command`), mutates: true };
}

function programRule(prog, args, lower, ctx) {
  const sf = shortFlags(args);
  switch (prog) {
    case "rm": case "del": case "erase": case "rmdir": case "rd": case "remove-item": case "ri": {
      const d = deletionOf(prog, args, lower);
      if (d) return d;
      return R.write(prog === "rmdir" || prog === "rd" ? "removes an empty folder" : "deletes a file");
    }
    case "git": return gitRule(args, lower);
    case "npm": case "pnpm": case "yarn": case "bun": return packageManagerRule(prog, args, lower);
    case "npx": return packageRunnerRule(args);
    case "node": case "nodejs": {
      if (!lower.length || lower[0] === "-v" || lower[0] === "--version") return R.read();
      const ei = lower.findIndex((a) => ["-e", "-p", "--eval", "--print"].includes(a));
      if (ei >= 0) return inlineRule("node", args.slice(ei + 1).join(" "));
      if (lower.includes("--test") || lower.includes("--check") || lower.includes("-c")) return R.verify();
      return R.script("runs a node script");
    }
    case "python": case "python3": case "py": return pythonRule(args, lower);
    case "pip": case "pip3": return pipRule(args, lower);
    case "poetry": case "pipenv": case "uv": case "conda": case "mamba": return lower.some((a) => ["install", "add", "sync", "update", "remove", "lock"].includes(a)) ? R.install() : lower.includes("run") ? R.script("runs a command in the environment") : R.read();
    case "cargo": {
      const s = lower.find((a) => !a.startsWith("-")) || "";
      if (["publish", "login", "yank", "owner"].includes(s)) return R.outward(`cargo ${s} talks to crates.io`);
      if (["test", "clippy", "check", "doc", "tree", "metadata", "version", "bench"].includes(s)) return R.verify();
      if (s === "fmt") return lower.includes("--check") ? R.verify() : R.write("formats files");
      if (["fetch", "add", "update", "install", "remove", "vendor"].includes(s)) return R.install();
      if (s === "run") return R.script("runs the project");
      return R.build();
    }
    case "go": {
      const s = lower[0] || "";
      if (["test", "vet", "version", "env", "list", "doc"].includes(s)) return R.verify();
      if (["mod", "get", "install", "work"].includes(s)) return R.install();
      if (s === "fmt") return R.write("formats files");
      if (s === "run") return R.script("runs the program");
      return R.build();
    }
    case "dotnet": {
      const s = lower[0] || "";
      if (s === "test" || s === "--version" || s === "--info" || s === "list") return R.verify();
      if (["restore", "add", "tool"].includes(s)) return R.install();
      if (s === "nuget" && lower.includes("push")) return R.outward("publishes a package");
      if (s === "run") return R.script("runs the project");
      return R.build();
    }
    case "mvn": case "mvnw": case "gradle": case "gradlew": return lower.some((a) => ["test", "verify", "check"].includes(a)) ? R.verify() : R.build();
    case "make": case "cmake": case "ninja": case "msbuild": case "webpack": case "rollup": case "esbuild": case "vite": return prog === "vite" && !lower.includes("build") ? { ...R.script("starts the dev server"), longRunning: true } : R.build();
    case "tsc": return lower.includes("--noemit") ? R.verify() : R.build();
    case "jest": case "vitest": case "mocha": case "ava": case "tap": case "pytest": case "py.test": case "rspec": case "phpunit": case "ctest": case "flake8": case "mypy": case "pyright": case "golangci-lint": case "rubocop": case "shellcheck": case "stylelint": case "playwright": return R.verify();
    case "eslint": return lower.includes("--fix") ? R.write("applies lint fixes to files") : R.verify();
    case "prettier": return lower.includes("--write") || lower.includes("-w") ? R.write("reformats files") : R.verify();
    case "black": return lower.includes("--check") || lower.includes("--diff") ? R.verify() : R.write("reformats files");
    case "ruff": return lower.includes("--fix") || lower.includes("format") ? R.write("rewrites files") : R.verify();
    case "find": {
      if (lower.includes("-delete")) return R.destructive("find -delete removes every match");
      const ei = lower.indexOf("-exec");
      if (ei >= 0) return /^(rm|del|rmdir)$/.test(baseName(args[ei + 1] || "")) ? R.destructive("find -exec rm removes every match") : R.script("find -exec runs a program on every match");
      return R.read();
    }
    case "xcopy": case "robocopy": return lower.some((a) => /^\/(mir|purge|move|mov)$/.test(a)) ? R.destructive("this copy mode deletes files at the destination") : R.write("copies files");
    case "chmod": case "chown": case "attrib": return sf.has("R") || lower.includes("/s") ? R.destructive("changes permissions recursively") : R.write("changes file permissions");
    case "sed": return lower.includes("-i") || lower.some((a) => /^-i/.test(a)) ? R.write("edits files in place") : R.read();
    case "perl": case "ruby": case "php": {
      const flag = prog === "php" ? "-r" : "-e";
      const i = lower.findIndex((a) => a === flag || (prog === "perl" && /^-[a-z]*e$/.test(a)));
      return i >= 0 ? inlineRule(prog, args.slice(i + 1).join(" ")) : R.script(`runs a ${prog} script`);
    }
    case "deno": return lower[0] === "eval" ? inlineRule("deno", args.slice(1).join(" ")) : R.script("runs a deno program");
    case "docker": case "podman": {
      if (lower.includes("--privileged")) return R.blocked("a privileged container can take over the machine");
      const s = lower.find((a) => !a.startsWith("-")) || "";
      if (["push", "login", "logout"].includes(s)) return R.outward(`docker ${s} talks to a registry account`);
      if (lower.includes("prune") || (["rm", "rmi", "kill"].includes(s) && (lower.includes("-f") || lower.includes("--force")))) return R.destructive("removes containers, images or volumes");
      if (["ps", "images", "logs", "inspect", "version", "info", "ls"].includes(s)) return R.read();
      return R.script(`docker ${s}`.trim());
    }
    case "apt": case "apt-get": case "brew": case "choco": case "winget": case "scoop": case "yum": case "dnf": case "pacman": case "snap": case "gem": case "pecl":
      return lower.some((a) => ["install", "upgrade", "update", "remove", "uninstall", "add", "-s", "-u", "-r"].includes(a)) ? { kind: "install", risk: mk("high", "system_install", "installs software on the machine, not just in the project"), mutates: true, network: true } : R.read();
    case "gh": {
      const s = lower.find((a) => !a.startsWith("-")) || "";
      const verb = lower.filter((a) => !a.startsWith("-"))[1] || "";
      if (["list", "view", "status", "diff", "checks", "checkout"].includes(verb) || ["status", "--version"].includes(s)) return R.read();
      return R.outward("the GitHub CLI changes something on GitHub");
    }
    case "scp": case "sftp": case "ftp": case "ssh": case "nc": case "ncat": case "netcat": case "telnet": case "rsync":
      return R.outward(`${prog} sends data to or opens a session on another machine`, prog === "ssh" || prog === "telnet" ? "send_publish" : "file_upload");
    case "twine": return lower.includes("upload") ? R.outward("publishes a package") : R.read();
    case "curl": {
      const upload = lower.some((a) => ["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-f", "--form", "-t", "--upload-file"].includes(a)) || lower.some((a) => /^(--data|-d.)/.test(a)) || (lower.indexOf("-x") >= 0 && /^(post|put|patch|delete)$/.test(lower[lower.indexOf("-x") + 1] || "")) || lower.some((a) => /^--request=(post|put|patch|delete)$/.test(a));
      if (upload) return R.outward("curl is sending data to a server", "file_upload");
      return { kind: "network_read", risk: mk("medium", "network", "downloads from the internet"), mutates: lower.includes("-o") || lower.includes("-O") || lower.some((a) => /^-[a-z]*o$/i.test(a)) || lower.includes("--output"), network: true };
    }
    case "wget": return lower.some((a) => /^--(post|body)/.test(a)) ? R.outward("wget is sending data to a server", "file_upload") : { kind: "network_read", risk: mk("medium", "network", "downloads from the internet"), mutates: true, network: true };
    case "iwr": case "irm": case "invoke-webrequest": case "invoke-restmethod": {
      const up = lower.some((a, i) => (a === "-method" && /^(post|put|patch|delete)$/.test(lower[i + 1] || "")) || a === "-body" || a === "-infile");
      return up ? R.outward("this request is sending data to a server", "file_upload") : { kind: "network_read", risk: mk("medium", "network", "downloads from the internet"), mutates: lower.includes("-outfile"), network: true };
    }
    case "iex": case "invoke-expression": return R.remote("runs text as code");
    default: return null;
  }
}

/** Why this program may never run, or null. */
function blockedReason(prog, args, lower) {
  if (BLOCKED_PROGS.has(prog) || prog.startsWith("mkfs")) return `"${prog}" changes the machine itself`;
  if (LOTL.has(prog)) return `"${prog}" can fetch or run arbitrary code outside the project`;
  const a0 = lower[0] || "";
  if (prog === "reg" && ["add", "delete", "import", "load", "unload", "save", "restore", "copy"].includes(a0)) return "changing the registry is not allowed";
  if (prog === "schtasks" && lower.some((a) => ["/create", "/change", "/delete", "/run"].includes(a))) return "scheduled tasks are not allowed";
  if (prog === "sc" && ["create", "config", "delete", "stop", "start", "failure", "description"].includes(a0)) return "changing services is not allowed";
  if ((prog === "net" || prog === "net1") && ["user", "localgroup", "share", "use", "start", "stop", "accounts", "session"].includes(a0)) return "changing accounts, shares or services is not allowed";
  if (prog === "wmic" && lower.includes("call")) return "wmic call can run anything on the machine";
  if (prog === "powershell" || prog === "pwsh") {
    if (lower.some((a) => ["-enc", "-encodedcommand", "-e", "-ec"].includes(a))) return "an encoded PowerShell command cannot be inspected";
    if (lower.some((a) => ["-executionpolicy", "-ep"].includes(a))) return "Noah does not weaken PowerShell's execution policy";
  }
  return null;
}

// ------------------------------------------------------------------ path arguments

function pathCandidates(args) {
  const out = [];
  for (const raw of args) {
    let a = raw;
    const eq = /^--?[A-Za-z][\w-]*=(.*)$/.exec(a);
    if (eq) a = eq[1];
    else if (/^-/.test(a)) continue;
    if (!a || /^[a-z][a-z0-9+.-]*:\/\//i.test(a)) continue; // a URL
    if (process.platform === "win32" && /^\/[A-Za-z?]+$/.test(a)) continue; // a cmd switch such as /s or /q
    if (/^~([\\/]|$)/.test(a) || /^[A-Za-z]:[\\/]/.test(a) || /^\\\\/.test(a) || /^\//.test(a) || a.split(/[\\/]+/).includes("..")) out.push(a);
  }
  return out;
}

const expandHome = (p) => (/^~([\\/]|$)/.test(p) ? path.join(os.homedir(), p.slice(1)) : p);

// ------------------------------------------------------------------ classification

function classifySegment(seg, ctx, prev) {
  const { platform, workspace, cwd } = ctx;
  const { words, redirects } = extractRedirects(tokenize(seg.text, platform));
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (!w.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.v)) { i++; continue; }
    if (WRAPPERS.has(baseName(w.v))) {
      i++;
      while (i < words.length && !words[i].quoted && /^[-/]/.test(words[i].v)) i++;
      continue;
    }
    break;
  }
  const rest = words.slice(i);
  const parts = [];

  // output redirections write files; both kinds must stay inside the workspace and away from secrets
  for (const r of redirects) {
    if (r.op !== "<") parts.push(R.write("redirects output into a file"));
    const t = expandHome(r.target);
    if (isSecretName(path.basename(t.replace(/\\/g, "/")))) parts.push(R.blocked(`${path.basename(t)} is a secret file: Noah never reads or writes those`, "protected_file"));
    else if (workspace && workspace.escapes(t, { cwd })) parts.push(R.blocked(`${r.target} is outside the workspace`, "outside_workspace"));
  }
  if (!rest.length) {
    const own = parts.length ? parts : [R.read()];
    return combine(own);
  }

  const prog = baseName(rest[0].v);
  const args = rest.slice(1).map((t) => t.v);
  const lower = args.map((a) => a.toLowerCase());

  const why = blockedReason(prog, args, lower);
  if (why) return combine([...parts, R.blocked(why)]);

  // files that must never be read or written, wherever the command is run from
  if (!NO_SECRET_CHECK.has(prog)) {
    for (const a of args) {
      const v = a.replace(/^--?[A-Za-z][\w-]*=/, "");
      if (!v || /^-/.test(v)) continue;
      const segs = v.split(/[\\/]+/).filter(Boolean);
      if (segs.some((s) => PROTECTED_DIR_NAMES.has(s.toLowerCase())) || (prog !== "git" && segs.some((s) => s.toLowerCase() === ".git"))) return combine([...parts, R.blocked(`${v} is protected (credentials or repository internals)`, "protected_file")]);
      // a bare word like `secret` or `credentials` is more likely something to search for than a file: only names that are clearly files count here
      const last = segs[segs.length - 1] || "";
      if (isSecretName(last) && !/^(secrets?|credentials?)$/i.test(last)) return combine([...parts, R.blocked(`${segs[segs.length - 1]} is a secret file: Noah never reads or writes those`, "protected_file")]);
    }
  }

  // paths that leave the workspace: blocked for file commands, confirmed for anything else
  if (workspace) {
    for (const c of pathCandidates(args)) {
      if (!workspace.escapes(expandHome(c), { cwd })) continue;
      if (FILE_PROGS.has(prog) || ["git", "sed"].includes(prog)) return combine([...parts, R.blocked(`${c} is outside the workspace`, "outside_workspace")]);
      parts.push({ kind: "outside", risk: mk("high", "outside_workspace", `${c} is outside the workspace`), mutates: true });
    }
  }

  // piping into an interpreter
  if (seg.piped && INTERPRETERS.has(prog)) {
    if (prev && prev.network) return combine([...parts, R.remote("pipes downloaded text straight into an interpreter")]);
    parts.push({ kind: "inline_code", risk: mk("medium", "inline_code", "pipes text into an interpreter"), mutates: true });
  }

  // a shell inside a shell: judge the command it runs, not the wrapper
  if (["bash", "sh", "zsh", "dash", "fish", "cmd", "powershell", "pwsh"].includes(prog)) {
    const flagIdx = lower.findIndex((a) => ["-c", "/c", "/k", "-command", "-cm", "-com"].includes(a));
    if (flagIdx >= 0) {
      const inner = args.slice(flagIdx + 1).join(" ");
      if (ctx.depth >= 3) return combine([...parts, { kind: "unknown", risk: mk("high", "obfuscation", "shells nested too deeply to inspect"), mutates: true }]);
      const r = classifyCommand(inner, { ...ctx, depth: ctx.depth + 1 });
      return combine([...parts, { kind: r.kinds[0] || "unknown", risk: r.risk, mutates: r.mutates, network: r.network, longRunning: r.longRunning }]);
    }
    parts.push(R.script(`runs a ${prog} script`));
    return combine(parts);
  }

  let r = programRule(prog, args, lower, ctx);
  if (!r) {
    if (READ_PROGS.has(prog)) r = R.read();
    else if (WRITE_PROGS.has(prog)) r = R.write();
    else r = R.unknown();
  }
  return combine([...parts, r]);
}

function combine(parts) {
  return {
    kind: parts.map((p) => p.kind).sort((a, b) => rank(riskOfKind(b)) - rank(riskOfKind(a)))[0],
    risk: mergeRisk(parts.map((p) => p.risk)),
    mutates: parts.some((p) => p.mutates),
    network: parts.some((p) => p.network),
    longRunning: parts.some((p) => p.longRunning),
    kinds: parts.map((p) => p.kind),
  };
}
const KIND_RANK = { blocked: "blocked", destructive: "high", outward: "high", remote_code: "high", outside: "high", inline_code: "medium", install: "medium", build: "medium", write: "medium", run_script: "medium", unknown: "medium", network_read: "medium" };
const riskOfKind = (k) => KIND_RANK[k] || "low";

/**
 * @param {string} cmd
 * @param {{ workspace?: import('./workspace.cjs').Workspace, cwd?: string, platform?: string, depth?: number }} [o]
 * @returns {{ risk: {level:string,categories:string[],reasons:string[]}, kinds: string[], mutates: boolean, network: boolean, longRunning: boolean, blocked: string|null }}
 */
// NAME=value for a credential-looking NAME, in the three shells' forms: `set NAME=v`, `export NAME=v`, `$env:NAME=v`, or a prefix `NAME=v cmd`.
// A flag such as --api-key=v does not match (the name must start after whitespace or a separator, and cannot start with a dash).
const CRED_ASSIGN = /(?:^|[\s;&|(])(?:(?:set|export|env)\s+|\$env:)?["']?([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*)["']?\s*=\s*["']?[^\s"';&|)]/i;

// Rewriting the project's CHECKS through the shell (`echo x >> test/a.test.js`, `del tests\a.js`, `sed -i ... test/a.js`, `npm pkg set scripts.test=...`) is
// the same trick as editing them with the file tools, which asks (fs-tools.cjs). A live run found the second door within minutes of the first being shut.
// Only a command that CHANGES something is judged, and plain git bookkeeping (add, commit, push, ...) never rewrites a file's content.
const TEST_DIR_TOKEN = /(^|[\\/])(tests?|__tests__|specs?|e2e|__snapshots__|__fixtures__|__mocks__)([\\/]|$)/i;
const RUN_REWRITE = /\bnpm\s+(?:pkg\s+(?:set|delete)|set-script)\b[^\n]*?\b(?:scripts\.)?(?:pre|post)?(?:test|lint|check|typecheck|verify|ci)\b/i;
const GIT_BOOKKEEPING = /^\s*git\s+(?:add|commit|status|diff|log|show|branch|push|pull|fetch|remote|tag|config|stash\s+list)\b/i;
const FILE_VERB = /(?:^|[;&|]\s*|\bcmd(?:\.exe)?\s+\/c\s+)(?:rm|del|erase|rmdir|rd|mv|move|ren|rename|cp|copy|xcopy|robocopy|mkdir|md|git\s+(?:checkout|restore|rm|mv|clean|reset))\b/i;
const REWRITING = new Set(["write", "destructive", "inline_code"]); // what the policy calls a command that changes files (install, verify, build and run_script do not)
function touchedCheck(raw, rewrites) {
  if (RUN_REWRITE.test(raw)) return "changes how the tests are run (a script in package.json)";
  if (!rewrites || GIT_BOOKKEEPING.test(raw)) return null; // `npm install && npm test`, `node test/run-all.js` and `make test` only RUN things named test
  const fileVerb = FILE_VERB.test(raw);
  for (const t of raw.split(/[\s"'=<>|&;(),]+/)) {
    if (!t) continue;
    // a file in or named like a test counts anywhere (test/a.js, cart.test.js); the bare folder name test/tests counts only as the target of a file verb
    // (rm -rf tests, git checkout -- test), NOT as the bare word in `npm test > out.log`, which is a script name
    if (isTestPath(t) || (TEST_DIR_TOKEN.test(t) && fileVerb)) return `changes a test file (${t.slice(0, 60)})`;
  }
  return null;
}

function classifyCommand(cmd, { workspace, cwd, platform = process.platform, depth = 0 } = {}) {
  const raw = String(cmd == null ? "" : cmd).trim();
  const fail = (level, cat, why) => ({ risk: mk(level, cat, why), kinds: [level === "blocked" ? "blocked" : "unknown"], mutates: true, network: false, longRunning: false, blocked: level === "blocked" ? why : null });
  if (!raw) return fail("blocked", "invalid_command", "the command is empty");
  if (raw.length > MAX_COMMAND) return fail("blocked", "invalid_command", `the command is longer than ${MAX_COMMAND} characters: put it in a script file instead`);
  if (depth > 3) return fail("high", "obfuscation", "commands nested too deeply to inspect");

  const ctx = { platform, workspace, cwd, depth };
  const { segments, unbalanced } = splitSegments(raw, platform);
  const parts = [];
  if (unbalanced) parts.push({ kind: "unknown", risk: mk("high", "obfuscation", "unbalanced quotes: the command cannot be inspected"), mutates: true });
  for (const inner of substitutions(raw, platform)) {
    if (inner === null) { parts.push({ kind: "unknown", risk: mk("high", "obfuscation", "an unclosed $( ... ) cannot be inspected"), mutates: true }); continue; }
    const r = classifyCommand(inner, { workspace, cwd, platform, depth: depth + 1 });
    parts.push({ kind: r.kinds[0], risk: r.risk, mutates: r.mutates, network: r.network, longRunning: r.longRunning });
  }
  let prev = null;
  for (const seg of segments) {
    prev = classifySegment(seg, ctx, prev);
    parts.push(prev);
  }
  // Inventing a credential for just this command ("set API_KEY=x&& npm test", "API_KEY=x npm test", "$env:API_KEY='x'; npm test"): a check that passes
  // with a made-up key proves very little, and it is the easiest way round a missing secret. It is put to the user in every mode.
  const fake = CRED_ASSIGN.exec(raw);
  if (fake) parts.push({ kind: "unknown", risk: mk("high", "fake_credential", `sets ${fake[1]} for just this command: a check that passes with an invented credential proves very little. If the real value is needed, ask the user for it`), mutates: true });
  const check = touchedCheck(raw, parts.some((p) => REWRITING.has(p.kind)));
  if (check) parts.push({ kind: "unknown", risk: mk("high", "test_file", `${check}: a check that passes after the checks themselves were changed proves much less`), mutates: true });
  if (!parts.length) return fail("blocked", "invalid_command", "the command is empty");
  const c = combine(parts);
  return { risk: c.risk, kinds: [...new Set(c.kinds)], mutates: c.mutates, network: c.network, longRunning: c.longRunning, blocked: c.risk.level === "blocked" ? c.risk.reasons[0] : null };
}

/** The decision under the user's mode: { decision: 'allow'|'confirm'|'deny', why }. */
function decideCommand(classification, { mode = "autonomous" } = {}) {
  return decide(classification.risk, { mode, mutates: classification.mutates });
}

module.exports = { classifyCommand, decideCommand, splitSegments, tokenize, substitutions, extractRedirects, GENERATED_DIRS };
