// Noah/autonomy/diagnoser.cjs
//
// WHY did that command fail? diagnose() reads the output of a failed command and answers with a structured diagnosis instead of a
// wall of text the model has to interpret again every time:
//
//   kind        what sort of failure (missing_module, syntax_error, test_failure, port_in_use, dependency_conflict, ...)
//   signature   a STABLE identity for "this same failure" (durations, memory addresses and line noise removed), so MissionState can
//               count how often it came back and the loop can tell "new error" (progress) from "same error again" (not progress)
//   summary     one line a person would write
//   hint        what is worth trying first (and what is not)
//   file, line  where, when the output says so (relative to the working folder)
//
// It is a pure function over text: no disk, no process. The patterns were written against REAL output recorded from node, npm, python
// and git on this machine (test/unit/fixtures/diagnoser-samples.json). Formats for tools that were not installed here (jest, pytest,
// mocha, go, cargo, tsc) follow their documented output and are covered by hand-written samples, labelled as such in the tests.
// Anything it does not recognise is `unknown_failure` with the last meaningful line: never a guess dressed up as a diagnosis.

"use strict";

const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

const posix = (p) => String(p || "").replace(/\\/g, "/");

/** A path relative to the working folder when it is inside it, with forward slashes. */
function shortPath(p, cwd) {
  const f = posix(p).replace(/^file:\/\/\/?/, "");
  const c = posix(cwd).replace(/\/+$/, "");
  if (c && f.toLowerCase().startsWith(c.toLowerCase() + "/")) return f.slice(c.length + 1);
  const nm = f.lastIndexOf("/node_modules/");
  return nm >= 0 ? f.slice(nm + 1) : f;
}

const FRAME = /((?:[A-Za-z]:)?[\\/][^\s()'"<>|]*?\.(?:[cm]?[jt]sx?|py|json|vue|svelte)):(\d+)(?::(\d+))?/;
const isNoise = (p) => /node:internal|[\\/]node_modules[\\/]|^node:|site-packages|[\\/]lib[\\/]python|<frozen/i.test(p);

/** The first stack frame that is the user's own code. */
function firstUserFrame(lines, cwd) {
  for (const l of lines) {
    if (!/^\s*at\s/.test(l)) continue;
    const m = FRAME.exec(l);
    if (m && !isNoise(m[1])) return { file: shortPath(m[1], cwd), line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined };
  }
  return null;
}

/** Node prints `path:line` above the offending source line. */
function headerLocation(lines, cwd) {
  for (const l of lines.slice(0, 6)) {
    const m = /^((?:[A-Za-z]:)?[\\/]?[^\s:]*?[^\s]*?\.(?:[cm]?[jt]sx?|json|py)):(\d+)\s*$/.exec(l.trim());
    if (m && !isNoise(m[1])) return { file: shortPath(m[1], cwd), line: Number(m[2]) };
  }
  return null;
}

/** Python: the last frame in the user's own files. */
function lastPythonFrame(lines, cwd) {
  let found = null;
  for (const l of lines) {
    const m = /^\s*File "(.+?)", line (\d+)/.exec(l);
    if (m && !isNoise(m[1])) found = { file: shortPath(m[1], cwd), line: Number(m[2]) };
  }
  return found;
}

/** A stable core of a message: numbers, durations, hex and paths removed. */
const stable = (s) => String(s).toLowerCase().replace(/[a-z]:[\\/][^\s'"]*/g, "<path>").replace(/0x[0-9a-f]+/g, "<hex>").replace(/\d+(\.\d+)?\s?ms/g, "<t>").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 80);

const res = (kind, signature, summary, hint, extra = {}) => ({ kind, signature: clip(signature, 160), summary: clip(summary, 200), hint, ...extra });
const loc = (o) => (o && o.file ? ` (${o.file}${o.line ? `:${o.line}` : ""})` : "");

// ------------------------------------------------------------------ rules (first match wins, most specific first)

function commandNotFound({ text }) {
  const m = /'([^']+)' is not recognized as an internal or external command/.exec(text) || /The term '([^']+)' is not recognized/.exec(text) || /(?:^|\n)(?:\/bin\/)?(?:ba)?sh: (?:\d+: )?([^\s:]+): (?:command )?not found/.exec(text) || /(?:^|\n)([^\s:]+): command not found/.exec(text);
  if (!m) return null;
  return res("command_not_found", `command_not_found:${m[1]}`, `"${m[1]}" is not installed or not on the PATH`, `Check the spelling. If it is a project tool, run it through the package manager (npx ${m[1]}, npm run <script>) or install it first (npm install -D ${m[1]}). Do not retry the same command.`, { detail: { program: m[1] } });
}

function npmRules({ text }) {
  const npm = /(?:^|\n)npm (?:error|ERR!)/.test(text);
  if (!npm) return null;
  let m = /Missing script: "([^"]+)"/.exec(text);
  if (m) return res("missing_script", `missing_script:${m[1]}`, `package.json has no "${m[1]}" script`, `Open package.json and look at "scripts", then run one that exists (or add "${m[1]}"). Do not guess script names.`, { detail: { script: m[1] } });
  if (/code ENOENT/.test(text) && /package\.json/.test(text)) return res("no_package_json", "no_package_json", "there is no package.json in this folder", "Run the command from the project folder (set cwd), or create one with npm init -y if this is a new project.");
  if (/code ERESOLVE/.test(text)) {
    const found = /Found: ([^\s@]+)@(\S+)/.exec(text);
    const peer = /peer ([^\s@]+)@"?([^"\s]+)"? from (\S+)/.exec(text);
    const name = (peer && peer[1]) || (found && found[1]) || "a package";
    return res("dependency_conflict", `dependency_conflict:${name}`, `peer dependency conflict${peer ? `: ${peer[3]} needs ${peer[1]}@${peer[2]}${found ? ` but ${found[1]}@${found[2]} is installed` : ""}` : ""}`, `The versions do not agree. Preferred: change one package's version so they match (update ${peer ? peer[3].split("@")[0] : "the older package"} or pin ${name}). Quick workaround: npm install --legacy-peer-deps (it works but leaves the mismatch). Running the same install again changes nothing.`, { detail: { package: name } });
  }
  m = /code E404/.exec(text) && (/'([^']+?)(?:@[^']*)?' is not in this registry/.exec(text) || /404 Not Found - GET \S+\/([^/\s]+)\s/.exec(text));
  if (m) return res("package_not_found", `package_not_found:${m[1]}`, `the package "${m[1]}" does not exist in the registry`, `Check the name for typos (and the scope, e.g. @org/name). A private package needs registry access. Search for the right name instead of retrying.`, { detail: { package: m[1] } });
  m = /code (ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ESOCKETTIMEDOUT)/.exec(text) || /network (?:request|timeout|socket)/i.exec(text) && [0, "NETWORK"];
  if (m) return res("network", `network:${m[1]}`, `a network problem (${m[1]}), not a problem in the project`, "Nothing in the code needs fixing. Check the connection or proxy. One retry (retry:true) is reasonable if it looked temporary; repeated retries are not.", { detail: { code: m[1] } });
  if (/code (EACCES|EPERM)/.test(text)) return res("permission", "permission:npm", "npm was refused permission", "A file or folder is locked or read-only (an open editor, antivirus, or a global install path). Close what uses it or install locally instead of globally.");
  return null; // an npm wrapper around another error (ELIFECYCLE): look at what the script itself printed
}

function nodeRules({ text, lines, cwd }) {
  let m = /Error: Cannot find module '([^']+)'(?:\nRequire stack:\n((?:- .+\n?)+))?/.exec(text) || /Cannot find (?:package|module) '([^']+)' imported from (.+)/.exec(text);
  if (m) {
    const mod = m[1];
    const from = (/imported from/.test(m[0]) ? m[2] : (m[2] || "").split("\n")[0].replace(/^- /, "")).trim();
    const where = from ? { file: shortPath(from, cwd) } : undefined;
    const local = /^[./\\]/.test(mod) || /^[A-Za-z]:[\\/]/.test(mod);
    return res("missing_module", `missing_module:${posix(mod)}`, `cannot find ${local ? "the file" : "the package"} "${mod}"${where ? ` (required from ${where.file})` : ""}`,
      local ? `No file matches "${mod}" relative to ${where ? where.file : "the requiring file"}. Check the spelling and the extension: list that folder to see the real file names (a singular/plural slip such as ./util vs ./utils is common).` : `"${mod}" is not installed. If it should be a dependency: check the spelling, then npm install ${mod}. If it is a typo, fix the import instead.`,
      { ...(where || {}), detail: { module: mod, local } });
  }
  m = /(?:^|\n)(?:\w+Error)?:?\s*(?:Error: )?listen EADDRINUSE: address already in use \S*?:(\d+)/.exec(text) || /EADDRINUSE.*?:(\d+)/.exec(text);
  if (m) {
    const where = firstUserFrame(lines, cwd);
    return res("port_in_use", `port_in_use:${m[1]}`, `port ${m[1]} is already in use`, `Another process is already listening on port ${m[1]} (often an earlier run of this same server). Stop it, or start this one on a different port. Starting it again on the same port will fail the same way.`, { ...(where || {}), detail: { port: Number(m[1]) } });
  }
  m = /(?:^|\n)(?:Uncaught )?(?:Error: )?(ENOENT|EISDIR|EACCES|EPERM|EEXIST|ENOTEMPTY|ENOTDIR): ([^\n']*?)(?:, (\w+))? '([^'\n]+)'/.exec(text);
  if (m) {
    const where = firstUserFrame(lines, cwd);
    const path = shortPath(m[4], cwd);
    const kinds = { ENOENT: ["file_not_found", `"${path}" does not exist`, "Check the path and the folder the command runs in (cwd). Create the file or correct the name; list the folder to see what is there."], EISDIR: ["is_directory", `"${path}" is a folder, not a file`, "The code treats a folder as a file. Point it at a file inside the folder."], EEXIST: ["already_exists", `"${path}" already exists`, "Remove or rename the existing one first, or skip the creation."], ENOTEMPTY: ["not_empty", `"${path}" is not empty`, "Delete its contents first or use a recursive removal."], ENOTDIR: ["not_a_directory", `a part of "${path}" is a file, not a folder`, "Check the path: a name on the way is a file."] };
    const [kind, summary, hint] = kinds[m[1]] || ["permission", `no permission for "${path}" (${m[1]})`, "The file or folder is locked or read-only: another program may have it open."];
    return res(kind, `${kind}:${posix(path)}`, summary + loc(where), hint, { ...(where || {}), detail: { path } });
  }
  m = /(?:^|\n)SyntaxError: (Unexpected token[^\n]*|Expected property name[^\n]*|Unexpected end of JSON input|[^\n]*in JSON at position[^\n]*|[^\n]*JSON[^\n]*)/.exec(text);
  if (m && /JSON/.test(m[1])) return res("json_parse", `json_parse:${stable(m[1])}`, `invalid JSON: ${clip(m[1], 90)}`, "The text being parsed is not valid JSON (a trailing comma, a missing quote, or it is not JSON at all, such as an HTML error page). Look at the actual text.", { detail: { message: m[1] } });
  m = /(?:^|\n)SyntaxError: ([^\n]+)/.exec(text);
  if (m && !/^\s*File "/.test(text.split("\n")[0])) {
    const where = headerLocation(lines, cwd) || firstUserFrame(lines, cwd);
    return res("syntax_error", `syntax_error:${where ? `${where.file}:${where.line}` : stable(m[1])}`, `syntax error: ${clip(m[1], 90)}${loc(where)}`, `The code does not parse. Read ${where ? where.file : "the file"} around${where ? ` line ${where.line}` : " the reported line"}, and check the lines just BEFORE it as well: an unclosed bracket or quote is usually reported on a later line.`, { ...(where || {}), detail: { message: m[1] } });
  }
  m = /(?:^|\n)ReferenceError: (\S+) is not defined/.exec(text);
  if (m) {
    const where = firstUserFrame(lines, cwd) || headerLocation(lines, cwd);
    return res("reference_error", `reference_error:${m[1]}`, `"${m[1]}" is not defined${loc(where)}`, `"${m[1]}" is used but never declared in scope: a typo, a missing require/import, or a variable declared elsewhere. Search the project for "${m[1]}" before changing anything.`, { ...(where || {}), detail: { name: m[1] } });
  }
  m = /(?:^|\n)TypeError: ([^\n]+)/.exec(text);
  if (m) {
    const where = firstUserFrame(lines, cwd) || headerLocation(lines, cwd);
    const undef = /Cannot read propert(?:y|ies) of (undefined|null) \(reading '([^']+)'\)/.exec(m[1]);
    return res("type_error", `type_error:${stable(m[1])}${where ? `@${where.file}:${where.line}` : ""}`, `type error: ${clip(m[1], 100)}${loc(where)}`,
      undef ? `Something is ${undef[1]} where an object was expected (reading "${undef[2]}"). Find what produces that value at${where ? ` ${where.file}:${where.line}` : " that line"} and why it is empty, instead of adding a guard blindly.` : "A value has the wrong type for what the code does with it. Look at the line and at what the value really is.", { ...(where || {}), detail: { message: m[1] } });
  }
  return null;
}

function testRules({ text, lines, cwd }) {
  // node:test
  let m = /ℹ fail (\d+)/.exec(text);
  if (m && Number(m[1]) > 0 && /failing tests:/.test(text)) {
    const names = [];
    const section = text.slice(text.indexOf("failing tests:"));
    for (const l of section.split("\n")) {
      const t = /^✖ (.+?) \([\d.]+ms\)\s*$/.exec(l);
      if (t && !names.includes(t[1])) names.push(t[1]);
    }
    const first = section.split("\n");
    let message = "";
    for (let i = 0; i < first.length; i++) {
      if (/^\s{2}\w*Error(?: \[\w+\])?: /.test(first[i])) { message = first[i].trim().replace(/^\w*Error(?: \[\w+\])?: /, ""); const next = first.slice(i + 1).find((l) => l.trim()); if (next && !/^\s*at /.test(next)) message += ` ${next.trim()}`; break; }
    }
    const at = /test at (\S+?):(\d+):\d+/.exec(section);
    const where = at ? { file: shortPath(at[1], cwd), line: Number(at[2]) } : firstUserFrame(lines, cwd);
    return res("test_failure", `test_failure:${names.slice().sort().join("|") || m[1]}`, `${names.length || m[1]} test${(names.length || Number(m[1])) > 1 ? "s" : ""} failing: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", ..." : ""}${message ? ` - ${clip(message, 100)}` : ""}`, `Read the failing test and the code it calls, then compare what the assertion expected with what it got. Fix the code unless the test itself is wrong; do not edit a test just to make it pass.`, { ...(where || {}), detail: { tests: names, message } });
  }
  // python unittest
  m = /FAIL(?:ED|): ?(?:\((?:failures|errors)=(\d+)[^)]*\))?/.exec(text) && /(?:^|\n)(?:FAIL|ERROR): (\S+) \(([^)]+)\)/.exec(text);
  if (m && /Ran \d+ tests?/.test(text)) {
    const names = [...text.matchAll(/(?:^|\n)(?:FAIL|ERROR): (\S+) \(/g)].map((x) => x[1]);
    const msg = /\n(AssertionError: [^\n]+)/.exec(text);
    const where = lastPythonFrame(lines, cwd);
    return res("test_failure", `test_failure:${names.slice().sort().join("|")}`, `${names.length} test${names.length > 1 ? "s" : ""} failing: ${names.slice(0, 3).join(", ")}${msg ? ` - ${clip(msg[1], 100)}` : ""}`, "Read the failing test and the code it calls; compare expected with actual. Fix the code unless the test itself is wrong.", { ...(where || {}), detail: { tests: names } });
  }
  // pytest
  m = /(?:^|\n)=+ (?:(\d+) failed)[^\n]*=+\s*$/m.exec(text) || /(?:^|\n)(\d+) failed/.exec(text);
  if (m && /FAILED \S+::/.test(text)) {
    const names = [...text.matchAll(/FAILED (\S+?::\S+)/g)].map((x) => x[1]);
    return res("test_failure", `test_failure:${names.slice().sort().join("|")}`, `${names.length} test${names.length > 1 ? "s" : ""} failing: ${names.slice(0, 3).join(", ")}`, "Read the failing test and the code it calls; compare expected with actual. Fix the code unless the test itself is wrong.", { detail: { tests: names } });
  }
  // jest
  if (/(?:^|\n)Tests:\s+(?:\d+ skipped, )?\d+ failed/.test(text) || /(?:^|\n)\s*●\s.+›/.test(text)) {
    const names = [...new Set([...text.matchAll(/(?:^|\n)\s*●\s(.+?›.+?)\s*$/gm)].map((x) => x[1].trim()))];
    const at = /\n\s+at .*?\(?([^\s()]+?\.(?:[cm]?[jt]sx?)):(\d+):\d+\)?/.exec(text);
    return res("test_failure", `test_failure:${names.slice().sort().join("|") || "jest"}`, `${names.length || "some"} test(s) failing: ${names.slice(0, 3).join(", ")}`, "Read the failing test and the code it calls; compare expected with received. Fix the code unless the test itself is wrong.", { ...(at ? { file: shortPath(at[1], cwd), line: Number(at[2]) } : {}), detail: { tests: names } });
  }
  // mocha
  m = /(?:^|\n)\s+(\d+) failing/.exec(text);
  if (m) {
    const names = [...text.matchAll(/(?:^|\n)\s+\d+\) (.+)/g)].map((x) => x[1].trim()).filter((x, i, a) => a.indexOf(x) === i);
    return res("test_failure", `test_failure:${names.slice().sort().join("|") || "mocha"}`, `${m[1]} test(s) failing: ${names.slice(0, 3).join(", ")}`, "Read the failing test and the code it calls; compare expected with actual. Fix the code unless the test itself is wrong.", { detail: { tests: names } });
  }
  // go
  if (/(?:^|\n)--- FAIL: /.test(text)) {
    const names = [...text.matchAll(/--- FAIL: (\S+)/g)].map((x) => x[1]);
    return res("test_failure", `test_failure:${names.slice().sort().join("|")}`, `${names.length} test(s) failing: ${names.slice(0, 3).join(", ")}`, "Read the failing test and the code it calls; compare want with got. Fix the code unless the test itself is wrong.", { detail: { tests: names } });
  }
  // cargo
  if (/(?:^|\n)test \S+ \.\.\. FAILED/.test(text)) {
    const names = [...text.matchAll(/test (\S+) \.\.\. FAILED/g)].map((x) => x[1]);
    return res("test_failure", `test_failure:${names.slice().sort().join("|")}`, `${names.length} test(s) failing: ${names.slice(0, 3).join(", ")}`, "Read the failing test and the code it calls; compare left with right. Fix the code unless the test itself is wrong.", { detail: { tests: names } });
  }
  return null;
}

function compilerRules({ text, cwd }) {
  const ts = [...text.matchAll(/(?:^|\n)(\S+?)\((\d+),(\d+)\): error (TS\d+): ([^\n]+)/g)];
  if (ts.length) {
    const [, file, line, col, code, msg] = ts[0];
    return res("type_check_error", `type_check_error:${code}:${shortPath(file, cwd)}:${line}`, `${ts.length} TypeScript error${ts.length > 1 ? "s" : ""}; first: ${shortPath(file, cwd)}:${line} ${code} ${clip(msg, 90)}`, "Fix the FIRST error first: later ones are often caused by it. Read the line, and the type it is compared with.", { file: shortPath(file, cwd), line: Number(line), column: Number(col), detail: { count: ts.length, code } });
  }
  const gcc = /(?:^|\n)(\S+?\.(?:c|cc|cpp|h|rs)):(\d+):(\d+): (?:fatal )?error: ([^\n]+)/.exec(text);
  if (gcc) return res("compile_error", `compile_error:${shortPath(gcc[1], cwd)}:${gcc[2]}`, `compile error at ${shortPath(gcc[1], cwd)}:${gcc[2]}: ${clip(gcc[4], 100)}`, "Fix the first compiler error; the rest often follow from it.", { file: shortPath(gcc[1], cwd), line: Number(gcc[2]) });
  return null;
}

function pythonRules({ text, lines, cwd }) {
  if (!/Traceback \(most recent call last\):|(?:^|\n)\s*File ".+", line \d+/.test(text)) return null;
  const last = lines.filter((l) => /^[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt)\b.*|^[A-Za-z_][\w.]*: /.test(l)).pop() || "";
  const where = lastPythonFrame(lines, cwd);
  let m = /^(?:ModuleNotFoundError|ImportError): No module named '([^']+)'/.exec(last);
  if (m) return res("missing_module", `missing_module:${m[1]}`, `Python cannot find the module "${m[1]}"${loc(where)}`, `"${m[1]}" is not installed in this Python (pip install ${m[1].split(".")[0]}), or the name is wrong, or it is a local file that is not on the path. Check which before installing.`, { ...(where || {}), detail: { module: m[1], python: true } });
  m = /^SyntaxError: (.+)/.exec(last) || /^IndentationError: (.+)/.exec(last);
  if (m) return res("syntax_error", `syntax_error:${where ? `${where.file}:${where.line}` : stable(m[1])}`, `syntax error: ${clip(m[1], 90)}${loc(where)}`, `The code does not parse. Read ${where ? where.file : "the file"} around${where ? ` line ${where.line}` : " the reported line"}, and the lines just before it.`, { ...(where || {}), detail: { message: m[1] } });
  m = /^NameError: (?:name )?'?([^'\s]+)'? is not defined/.exec(last);
  if (m) return res("reference_error", `reference_error:${m[1]}`, `"${m[1]}" is not defined${loc(where)}`, `"${m[1]}" is used but never defined: a typo, a missing import, or a variable from another scope. Search the project for it.`, { ...(where || {}), detail: { name: m[1] } });
  const name = /^([A-Za-z_][\w.]*)/.exec(last);
  return res("python_exception", `python_exception:${name ? name[1] : "error"}:${where ? `${where.file}:${where.line}` : stable(last)}`, `${clip(last, 120)}${loc(where)}`, `An exception stopped the program${where ? ` at ${where.file}:${where.line}` : ""}. Read that line and what values reach it.`, { ...(where || {}), detail: { exception: name ? name[1] : "" } });
}

function gitRules({ text }) {
  if (/fatal: not a git repository/.test(text)) return res("not_a_git_repo", "not_a_git_repo", "this folder is not a git repository", "Run git inside the repository folder (set cwd), or create one with git init if that is intended.");
  const conflict = /CONFLICT \([^)]+\): (?:Merge conflict in|.*?) ([^\n]+)/.exec(text);
  if (conflict) return res("merge_conflict", `merge_conflict:${clip(conflict[1], 60)}`, `merge conflict in ${clip(conflict[1], 60)}`, "Open the conflicted file(s), resolve the <<<<<<< ======= >>>>>>> markers by hand, then git add and commit. Do not discard either side blindly.");
  if (/nothing to commit/.test(text)) return res("nothing_to_commit", "nothing_to_commit", "there is nothing to commit", "The working tree is already clean: either the change was already committed, or no file was actually changed.");
  if (/Your local changes to the following files would be overwritten/.test(text)) return res("local_changes", "git_local_changes", "local changes would be overwritten", "Commit or stash your changes first, then retry.");
  return null;
}

function jsGeneric({ text, lines, cwd }) {
  // an uncaught plain Error: "Error: message" with a stack
  const m = /(?:^|\n)((?:\w+)?Error)(?: \[[\w_]+\])?: ([^\n]+)/.exec(text);
  if (!m) return null;
  const where = firstUserFrame(lines, cwd) || headerLocation(lines, cwd);
  return res("runtime_error", `runtime_error:${stable(m[2])}${where ? `@${where.file}:${where.line}` : ""}`, `${m[1]}: ${clip(m[2], 110)}${loc(where)}`, `The program threw this itself or from a library${where ? `. Start at ${where.file}:${where.line}` : ""} and read what leads to it.`, { ...(where || {}), detail: { message: m[2] } });
}

const RULES = [commandNotFound, npmRules, nodeRules, testRules, compilerRules, pythonRules, gitRules, jsGeneric];

/**
 * @param {{ cmd?: string, exitCode?: number|null, output?: string, timedOut?: boolean, cwd?: string }} r
 * @returns {null | { kind: string, signature: string, summary: string, hint: string, file?: string, line?: number, column?: number, detail?: object }}
 *   null when the command succeeded.
 */
function diagnose({ cmd = "", exitCode, output = "", timedOut = false, cwd = "" } = {}) {
  if (!timedOut && exitCode === 0) return null;
  if (timedOut) {
    return res("timeout", `timeout:${stable(cmd)}`, "the command did not finish in time", "It may be waiting for input, running a server or a watcher, or stuck in a loop. Do not run it again unchanged: narrow what it does (one test file, a smaller input), or check the code for a loop.");
  }
  const text = String(output || "").replace(/\r\n/g, "\n").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const ctx = { text, lines: text.split("\n"), cmd, cwd, exitCode };
  for (const rule of RULES) {
    const r = rule(ctx);
    if (r) return r;
  }
  const meaningful = ctx.lines.map((l) => l.trim()).filter((l) => l && !/^(>|\$|npm (?:error|ERR!) *$)/.test(l));
  const lastLine = [...meaningful].reverse().find((l) => /error|fail|fatal|exception|cannot|denied|unable|invalid|not found|refused/i.test(l)) || meaningful[meaningful.length - 1] || "";
  if (!lastLine) return res("unknown_failure", `exit_code:${exitCode}`, `the command exited with code ${exitCode} and printed nothing`, "There is no output to learn from. Run it with a verbose or debug flag, or run a smaller piece of it, to make it say why.");
  return res("unknown_failure", `unknown_failure:${exitCode}:${stable(lastLine)}`, clip(lastLine, 140), "This failure is not one Noah recognises. Read the full output, find the first error (not the last line), and form a specific hypothesis before changing anything.", { detail: { exitCode } });
}

module.exports = { diagnose, shortPath, stable };
