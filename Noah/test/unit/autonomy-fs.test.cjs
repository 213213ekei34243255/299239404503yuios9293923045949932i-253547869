// Noah/test/unit/autonomy-fs.test.cjs - the file tools (Noah/autonomy/tools/fs-tools.cjs), against REAL files
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Workspace } = require("../../autonomy/tools/workspace.cjs");
const { FsTools, globToRegex } = require("../../autonomy/tools/fs-tools.cjs");
const { MissionState } = require("../../autonomy/mission-state.cjs");

// the byte-order mark, built from its code so no editor can strip it from the source
const BOM = String.fromCharCode(0xfeff);
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-fs-")));
const root = path.join(base, "proj");
const other = path.join(base, "other");
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const P = (...a) => path.join(root, ...a);
const put = (rel, content) => { fs.mkdirSync(path.dirname(P(rel)), { recursive: true }); fs.writeFileSync(P(rel), content); };
const get = (rel) => fs.readFileSync(P(rel), "utf8");

function make({ mode = "autonomous", confirm } = {}) {
  const ws = new Workspace({ roots: [root] });
  const state = new MissionState({ objective: "test" });
  return { fsx: new FsTools({ workspace: ws, state, confirm, getMode: () => mode }), state, ws };
}
const reset = () => { fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(other, { recursive: true }); fs.writeFileSync(path.join(other, "data.txt"), "outside"); };
const FILE = "export function add(a, b) {\n  return a + b;\n}\nexport const VERSION = 1;\n";

test("read: numbered lines, totals and line endings", async () => {
  reset(); put("src/a.js", FILE); put("src/crlf.txt", "one\r\ntwo\r\nthree\r\n"); put("src/bom.txt", BOM + "hello\n"); put("empty.txt", "");
  const { fsx } = make();
  const r = await fsx.read({ path: "src/a.js" });
  assert.equal(r.ok, true);
  assert.equal(r.path, "src/a.js");
  assert.equal(r.totalLines, 4);
  assert.equal(r.eol, "lf");
  assert.match(r.content, /^ {5}1\texport function add\(a, b\) \{\n {5}2\t {2}return a \+ b;/);
  assert.equal((await fsx.read({ path: "src/a.js", numbered: false })).content.split("\n")[0], "export function add(a, b) {");
  assert.equal((await fsx.read({ path: "src/crlf.txt" })).eol, "crlf");
  assert.equal((await fsx.read({ path: "src/bom.txt", numbered: false })).content, "hello");
  const e = await fsx.read({ path: "empty.txt" });
  assert.deepEqual([e.ok, e.totalLines, e.content], [true, 0, ""]);
});

test("read: a slice, a truncated long file with the next offset, and the 'unchanged' flag", async () => {
  reset(); put("long.txt", Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`).join("\n"));
  const { fsx } = make();
  const slice = await fsx.read({ path: "long.txt", offset: 10, limit: 3, numbered: false });
  assert.deepEqual(slice.content.split("\n").map((l) => l.split(" ")[1]), ["10", "11", "12"]);
  assert.equal(slice.truncated, true);
  assert.equal(slice.nextOffset, 13);
  const all = await fsx.read({ path: "long.txt", limit: 5000 });
  assert.equal(all.truncated, true, "bounded by size, not only by the line limit");
  assert.ok(all.content.length <= 61000);
  assert.equal(all.nextOffset, all.endLine + 1);
  assert.equal((await fsx.read({ path: "long.txt", offset: 10, limit: 3 })).unchanged, true);
  put("long.txt", "changed\n");
  assert.equal((await fsx.read({ path: "long.txt" })).unchanged, false);
});

test("read: refuses what it must (folders, binary, huge, missing, secrets, outside) with a code that says why", async () => {
  reset(); put("src/x.js", "x"); put(".env", "KEY=1"); fs.writeFileSync(P("bin.dat"), Buffer.from([1, 2, 0, 3])); fs.writeFileSync(P("huge.txt"), Buffer.alloc(5 * 1024 * 1024, 97));
  const { fsx } = make();
  const code = async (p) => (await fsx.read({ path: p })).code;
  assert.equal(await code("src"), "is_directory");
  assert.equal(await code("bin.dat"), "binary_file");
  assert.equal(await code("huge.txt"), "too_large");
  assert.equal(await code("missing.txt"), "not_found");
  assert.equal(await code(".env"), "protected_path");
  assert.equal(await code("../other/data.txt"), "outside_workspace");
  assert.equal(await code("a\0b"), "invalid_path");
});

test("write: creates new files (and their folders), refuses to replace without reading, records the change", async () => {
  reset();
  const { fsx, state } = make();
  const r = await fsx.write({ path: "deep/new/dir/file.txt", content: "hello\n" });
  assert.deepEqual([r.ok, r.created, r.bytes], [true, true, 6]);
  assert.equal(get("deep/new/dir/file.txt"), "hello\n");
  assert.equal(state.sourceVersion, 1);
  assert.deepEqual(Object.keys(state.files), ["deep/new/dir/file.txt"]);
  assert.equal(state.files["deep/new/dir/file.txt"].lastOp, "create");
  const again = await fsx.write({ path: "deep/new/dir/file.txt", content: "x" });
  assert.equal(again.code, "exists");
  assert.match(again.message, /fs_edit/);
  assert.equal(get("deep/new/dir/file.txt"), "hello\n");
  assert.deepEqual(fs.readdirSync(P("deep/new/dir")), ["file.txt"], "no temp file is left behind");
  assert.equal((await fsx.write({ path: "x.txt", content: 42 })).code, "invalid_arguments");
  assert.equal((await fsx.write({ path: "big.txt", content: "x".repeat(2 * 1024 * 1024 + 1) })).code, "too_large");
  assert.equal((await fsx.write({ path: ".env", content: "K=1" })).code, "protected_path");
  assert.equal((await fsx.write({ path: "../other/new.txt", content: "x" })).code, "outside_workspace");
  assert.equal((await fsx.write({ path: "node_modules/x/i.js", content: "x" })).code, "protected_path");
});

test("write: replacing needs overwrite:true AND a full, still-current read first", async () => {
  reset(); put("a.txt", "one\ntwo\nthree\n");
  const { fsx, state } = make();
  assert.equal((await fsx.write({ path: "a.txt", content: "new", overwrite: true })).code, "not_read");
  await fsx.read({ path: "a.txt", limit: 1 }); // only part of it
  assert.equal((await fsx.write({ path: "a.txt", content: "new", overwrite: true })).code, "not_read", "a partial read is not enough");
  await fsx.read({ path: "a.txt" });
  put("a.txt", "someone else changed it\n"); // a command or another program changed it
  assert.equal((await fsx.write({ path: "a.txt", content: "new", overwrite: true })).code, "changed_on_disk");
  assert.equal(get("a.txt"), "someone else changed it\n");
  await fsx.read({ path: "a.txt" });
  const ok = await fsx.write({ path: "a.txt", content: "new\n", overwrite: true });
  assert.deepEqual([ok.ok, ok.created], [true, false]);
  assert.equal(get("a.txt"), "new\n");
  assert.equal(state.files["a.txt"].lastOp, "write");
  assert.equal((await fsx.write({ path: "a.txt", content: "newer\n", overwrite: true })).ok, true, "our own write counts as read: no pointless re-read");
});

test("write: a CRLF file stays CRLF when it is replaced", async () => {
  reset(); put("w.txt", "a\r\nb\r\n");
  const { fsx } = make();
  await fsx.read({ path: "w.txt" });
  await fsx.write({ path: "w.txt", content: "x\ny\nz\n", overwrite: true });
  assert.equal(get("w.txt"), "x\r\ny\r\nz\r\n");
});

test("edit: exact replacement, against what was read", async () => {
  reset(); put("src/a.js", FILE);
  const { fsx, state } = make();
  assert.equal((await fsx.edit({ path: "src/a.js", find: "a + b", replace: "a - b" })).code, "not_read");
  await fsx.read({ path: "src/a.js" });
  const r = await fsx.edit({ path: "src/a.js", find: "return a + b;", replace: "return a - b;" });
  assert.equal(r.ok, true);
  assert.equal(r.replacements, 1);
  assert.equal(r.line, 2);
  assert.match(r.snippet, /\n {5}2\t {2}return a - b;/);
  assert.equal(get("src/a.js"), FILE.replace("a + b", "a - b"));
  assert.equal(state.files["src/a.js"].lastOp, "edit");
  assert.equal(state.sourceVersion, 1);
  // our own edit keeps the picture current: a second edit does not need another read
  assert.equal((await fsx.edit({ path: "src/a.js", find: "VERSION = 1", replace: "VERSION = 2" })).ok, true);
  assert.match(get("src/a.js"), /VERSION = 2/);
  assert.deepEqual(fs.readdirSync(P("src")), ["a.js"]);
});

test("edit: an ambiguous match is refused with the line numbers; replaceAll does them all", async () => {
  reset(); put("m.js", "foo();\nbar();\nfoo();\nfoo();\n");
  const { fsx } = make();
  await fsx.read({ path: "m.js" });
  const amb = await fsx.edit({ path: "m.js", find: "foo();", replace: "baz();" });
  assert.equal(amb.code, "ambiguous");
  assert.match(amb.message, /3 times.*lines 1, 3, 4/);
  assert.equal(get("m.js"), "foo();\nbar();\nfoo();\nfoo();\n");
  const all = await fsx.edit({ path: "m.js", find: "foo();", replace: "baz();", replaceAll: true });
  assert.equal(all.replacements, 3);
  assert.equal(get("m.js"), "baz();\nbar();\nbaz();\nbaz();\n");
  await fsx.read({ path: "m.js" });
  assert.equal((await fsx.edit({ path: "m.js", find: "bar();\nbaz();", replace: "bar();\nqux();" })).ok, true, "extra surrounding lines make it unique");
});

test("edit: not found says where the near miss is, and a pasted line number is explained", async () => {
  reset(); put("n.js", "function go() {\n    doTheThing(1, 2);\n}\n");
  const { fsx } = make();
  await fsx.read({ path: "n.js" });
  const miss = await fsx.edit({ path: "n.js", find: "  doTheThing(1, 2);\n  more();", replace: "x" });
  assert.equal(miss.code, "not_found");
  assert.match(miss.message, /line 2: doTheThing\(1, 2\);/);
  assert.match(miss.message, /do not include the line numbers/);
  assert.equal((await fsx.edit({ path: "n.js", find: "     2\t    doTheThing(1, 2);", replace: "x" })).code, "not_found");
  assert.equal(get("n.js"), "function go() {\n    doTheThing(1, 2);\n}\n", "nothing changed");
});

test("edit: sanity checks on the arguments", async () => {
  reset(); put("s.js", "abc\n");
  const { fsx } = make();
  await fsx.read({ path: "s.js" });
  assert.equal((await fsx.edit({ path: "s.js", find: "", replace: "x" })).code, "invalid_arguments");
  assert.equal((await fsx.edit({ path: "s.js", find: "abc", replace: 5 })).code, "invalid_arguments");
  assert.equal((await fsx.edit({ path: "s.js", find: "abc", replace: "abc" })).code, "no_change");
  assert.equal((await fsx.edit({ path: "s.js", find: "abc", replace: "" })).ok, true, "an empty replacement deletes the text");
  assert.equal(get("s.js"), "\n");
  assert.equal((await fsx.edit({ path: "nope.js", find: "a", replace: "b" })).code, "not_found");
  assert.equal((await fsx.edit({ path: ".", find: "a", replace: "b" })).code, "is_directory");
});

test("edit: line endings and a byte-order mark are preserved", async () => {
  reset(); put("c.txt", "alpha\r\nbeta\r\ngamma\r\n"); put("bom.txt", BOM + "hello world\n");
  const { fsx } = make();
  await fsx.read({ path: "c.txt" });
  assert.equal((await fsx.edit({ path: "c.txt", find: "beta\ngamma", replace: "BETA\nGAMMA\nDELTA" })).ok, true, "a find written with LF matches a CRLF file");
  assert.equal(get("c.txt"), "alpha\r\nBETA\r\nGAMMA\r\nDELTA\r\n");
  await fsx.read({ path: "bom.txt" });
  await fsx.edit({ path: "bom.txt", find: "hello", replace: "goodbye" });
  assert.equal(get("bom.txt"), BOM + "goodbye world\n");
});

test("edit: a file that changed on disk since it was read must be read again", async () => {
  reset(); put("e.js", "one\n");
  const { fsx } = make();
  await fsx.read({ path: "e.js" });
  put("e.js", "one plus a command's change\n");
  const r = await fsx.edit({ path: "e.js", find: "one", replace: "two" });
  assert.equal(r.code, "changed_on_disk");
  assert.equal(get("e.js"), "one plus a command's change\n");
});

test("the user's mode decides when a write asks; a refusal means nothing is written", async () => {
  reset(); put("keep.txt", "original\n");
  const asked = [];
  let answer = false;
  const { fsx, state } = make({ mode: "supervised", confirm: async (req) => { asked.push(req.summary); return answer; } });
  assert.equal((await fsx.write({ path: "new.txt", content: "x" })).code, "user_denied");
  assert.equal(fs.existsSync(P("new.txt")), false);
  await fsx.read({ path: "keep.txt" });
  assert.equal((await fsx.edit({ path: "keep.txt", find: "original", replace: "changed" })).code, "user_denied");
  assert.equal(get("keep.txt"), "original\n");
  assert.equal(state.sourceVersion, 0, "a refused change is not a change");
  answer = true;
  assert.equal((await fsx.write({ path: "new.txt", content: "x" })).ok, true);
  assert.deepEqual(asked, ["Create new.txt", "Edit keep.txt", "Create new.txt"]);
  // autonomous mode asks for nothing here
  const auto = make({ mode: "autonomous", confirm: async () => { throw new Error("must not be asked"); } });
  assert.equal((await auto.fsx.write({ path: "auto.txt", content: "y" })).ok, true);
});

test("delete: files and empty folders go; a folder with files needs recursive and (unless generated) the user's OK", async () => {
  reset(); put("f.txt", "x"); put("d/inner.txt", "x"); put("node_modules/p/i.js", "x"); fs.mkdirSync(P("empty"));
  let asked = 0;
  let answer = false;
  const { fsx, state } = make({ confirm: async () => { asked++; return answer; } });
  assert.equal((await fsx.delete({ path: "f.txt" })).ok, true);
  assert.equal(fs.existsSync(P("f.txt")), false);
  assert.equal(state.files["f.txt"].lastOp, "delete");
  assert.equal((await fsx.delete({ path: "empty" })).ok, true);
  assert.equal((await fsx.delete({ path: "d" })).code, "not_empty");
  assert.equal(asked, 0);
  assert.equal((await fsx.delete({ path: "d", recursive: true })).code, "user_denied");
  assert.equal(fs.existsSync(P("d/inner.txt")), true, "declined: still there");
  assert.equal(asked, 1);
  answer = true;
  assert.equal((await fsx.delete({ path: "d", recursive: true })).ok, true);
  assert.equal(fs.existsSync(P("d")), false);
  asked = 0;
  answer = false;
  assert.equal((await fsx.delete({ path: "node_modules", recursive: true })).ok, false, "node_modules is write-protected for the tools");
  assert.equal((await fsx.delete({ path: "missing.txt" })).code, "not_found");
});

test("delete: never the workspace itself, a secret, or anything outside", async () => {
  reset(); put(".env", "K=1");
  const { fsx } = make();
  assert.equal((await fsx.delete({ path: ".", recursive: true })).code, "protected_path");
  assert.equal((await fsx.delete({ path: root, recursive: true })).code, "protected_path");
  assert.equal((await fsx.delete({ path: ".env" })).code, "protected_path");
  assert.equal((await fsx.delete({ path: "../other/data.txt" })).code, "outside_workspace");
  assert.equal(fs.existsSync(path.join(other, "data.txt")), true);
  assert.equal(fs.existsSync(root), true);
});

test("list: folders first, big generated folders not opened, secrets labelled, depth and size limits", async () => {
  reset(); put("src/a.js", "x"); put("src/lib/b.js", "xx"); put("zeta.txt", "x"); put("alpha.txt", "x"); put("node_modules/p/i.js", "x"); put(".env", "K"); put(".git/config", "c");
  const { fsx } = make();
  const l = await fsx.list({});
  const lines = l.listing.split("\n");
  assert.equal(lines[0].replace(/\s+\(not listed\)/, ""), ".git/");
  assert.ok(lines.indexOf("src/") < lines.indexOf("alpha.txt (1 B)"), "folders come before files");
  assert.match(l.listing, /node_modules\/ {2}\(not listed\)/);
  assert.match(l.listing, /\.env \(\d+ B\) {2}\[protected/);
  assert.doesNotMatch(l.listing, /i\.js/);
  assert.doesNotMatch(l.listing, /^\s+config/m, ".git is not opened");
  assert.doesNotMatch(l.listing, /a\.js/, "depth 1 shows only the top level");
  const deep = await fsx.list({ path: "src", depth: 2 });
  assert.match(deep.listing, /lib\/\n {2}b\.js \(2 B\)/);
  assert.equal(deep.path, "src");
  const few = await fsx.list({ max: 2 });
  assert.deepEqual([few.count, few.truncated], [2, true]);
  assert.equal((await fsx.list({ path: "zeta.txt" })).code, "not_a_folder");
  assert.equal((await fsx.list({ path: "../other" })).code, "outside_workspace");
});

test("search: matches with file and line, filters, and what it never searches", async () => {
  reset();
  put("src/a.js", "const x = 1;\n// TODO fix this\nconst y = 2;\n"); put("src/b.ts", "let t = 'todo lowercase';\n"); put("README.md", "TODO docs\n");
  put("node_modules/dep/i.js", "// TODO in a dependency\n"); put(".git/notes", "TODO in git\n"); put(".env", "TODO=secret\n"); put("secrets.json", '{"TODO":1}');
  fs.writeFileSync(P("bin.dat"), Buffer.concat([Buffer.from("TODO "), Buffer.from([0, 1, 2])]));
  const { fsx } = make();
  const s = await fsx.search({ pattern: "TODO" });
  assert.deepEqual(s.matches.split("\n").sort(), ["README.md:1: TODO docs", "src/a.js:2: // TODO fix this"]);
  assert.equal(s.count, 2);
  assert.equal((await fsx.search({ pattern: "todo", ignoreCase: true })).count, 3);
  assert.equal((await fsx.search({ pattern: "TODO", glob: "*.js" })).matches, "src/a.js:2: // TODO fix this");
  assert.equal((await fsx.search({ pattern: "TODO", glob: "src/**/*.js" })).count, 1);
  assert.equal((await fsx.search({ pattern: "TODO", path: "src" })).count, 1);
  assert.equal((await fsx.search({ pattern: "TODO", path: "src/a.js" })).count, 1);
  assert.equal((await fsx.search({ pattern: "a.b", literal: true })).count, 0);
  put("lit.txt", "a.b and axb\n");
  assert.equal((await fsx.search({ pattern: "a.b", literal: true })).count, 1);
  assert.equal((await fsx.search({ pattern: "a.b" })).count, 1, "as a regex a.b matches both 'a.b' and 'axb', but they are on one line: one result");
  assert.equal((await fsx.search({ pattern: "(" })).code, "invalid_pattern");
  assert.equal((await fsx.search({ pattern: "" })).code, "invalid_arguments");
  assert.equal((await fsx.search({ pattern: "x", path: "../other" })).code, "outside_workspace");
});

test("search: results are capped", async () => {
  reset(); put("many.txt", Array.from({ length: 300 }, (_, i) => `hit ${i}`).join("\n"));
  const { fsx } = make();
  const s = await fsx.search({ pattern: "hit", maxResults: 10 });
  assert.deepEqual([s.count, s.truncated], [10, true]);
});

test("glob patterns", () => {
  const m = (g, p) => globToRegex(g).test(p);
  assert.ok(m("*.js", "a.js") && !m("*.js", "src/a.js"));
  assert.ok(m("**/*.ts", "src/deep/a.ts") && m("**/*.ts", "a.ts"));
  assert.ok(m("src/**", "src/a/b.js") && !m("src/**", "lib/a.js"));
  assert.ok(m("*.{js,ts}", "a.ts") && !m("*.{js,ts}", "a.md"));
  assert.ok(m("a?.js", "ab.js") && !m("a?.js", "abc.js"));
  assert.ok(m("a+b(1).js", "a+b(1).js"), "regex characters in a glob are literal");
});
