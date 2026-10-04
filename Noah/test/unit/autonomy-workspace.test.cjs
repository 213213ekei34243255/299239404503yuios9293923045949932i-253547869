// Noah/test/unit/autonomy-workspace.test.cjs - where Noah may work (Noah/autonomy/tools/workspace.cjs), against REAL folders
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Workspace, PolicyError, checkPathSyntax, isSecretName } = require("../../autonomy/tools/workspace.cjs");

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "noah-ws-")));
const proj = path.join(base, "proj");
const evil = path.join(base, "proj-evil"); // shares the prefix "proj": a naive startsWith check would let it in
const other = path.join(base, "other");
const write = (p, s = "x") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
write(path.join(proj, "src", "a.js"));
write(path.join(proj, ".env"), "SECRET=1");
write(path.join(proj, ".env.example"), "SECRET=");
write(path.join(proj, ".git", "config"), "[remote]");
write(path.join(proj, "node_modules", "dep", "index.js"));
write(path.join(proj, "secrets.json"));
write(path.join(proj, "certs", "server.pem"));
write(path.join(evil, "x.txt"));
write(path.join(other, "data.txt"));
test.after(() => { try { fs.unlinkSync(path.join(proj, "link")); } catch (_) { /* none */ } fs.rmSync(base, { recursive: true, force: true }); });

const ws = () => new Workspace({ roots: [proj] });
const denies = (fn, code) => assert.throws(fn, (e) => e instanceof PolicyError && e.code === code, `expected PolicyError ${code}`);

test("a granted folder is stored by its canonical path, and a missing folder or a file is refused", () => {
  const w = new Workspace();
  assert.equal(w.hasRoots(), false);
  assert.equal(w.grant(proj), proj);
  assert.deepEqual(w.roots(), [proj]);
  w.grant(proj); // again: no duplicate
  assert.equal(w.roots().length, 1);
  denies(() => w.grant(path.join(base, "nope")), "invalid_path");
  denies(() => w.grant(path.join(proj, "src", "a.js")), "invalid_path");
  w.revoke(proj);
  assert.equal(w.hasRoots(), false);
});

test("a root cannot be a drive, the home folder, a parent of it, or a system folder", () => {
  const w = new Workspace();
  assert.throws(() => w.grant(path.parse(proj).root), (e) => e.code === "root_too_broad" && /whole drive/.test(e.message), "the user is told it is a whole drive, not something less accurate");
  assert.throws(() => w.grant(os.homedir()), (e) => e.code === "root_too_broad" && /home folder/.test(e.message));
  denies(() => w.grant(os.homedir()), "root_too_broad");
  denies(() => w.grant(path.dirname(os.homedir())), "root_too_broad");
  if (process.platform === "win32") {
    denies(() => w.grant(process.env.SystemRoot), "root_too_broad");
    denies(() => w.grant(path.join(process.env.SystemRoot, "System32")), "root_too_broad");
  } else {
    denies(() => w.grant("/etc"), "root_too_broad");
  }
  w.grant(proj); // a project folder inside the home folder is fine
});

test("nothing resolves until a folder has been granted", () => {
  denies(() => new Workspace().resolve("a.js"), "no_workspace");
});

test("paths inside the workspace resolve to their real location; new files in new folders are fine", () => {
  const w = ws();
  assert.equal(w.resolve("src/a.js"), path.join(proj, "src", "a.js"));
  assert.equal(w.resolve(path.join(proj, "src", "a.js")), path.join(proj, "src", "a.js"));
  assert.equal(w.resolve("brand/new/dir/file.txt", { write: true }), path.join(proj, "brand", "new", "dir", "file.txt"));
  assert.equal(w.resolve("a.js", { cwd: "src" }), path.join(proj, "src", "a.js"));
  assert.equal(w.resolve("."), proj);
});

test("`..`, absolute paths and look-alike sibling folders cannot leave the workspace", () => {
  const w = ws();
  denies(() => w.resolve("../other/data.txt"), "outside_workspace");
  denies(() => w.resolve("src/../../other/data.txt"), "outside_workspace");
  denies(() => w.resolve(path.join(other, "data.txt")), "outside_workspace");
  denies(() => w.resolve(path.join(evil, "x.txt")), "outside_workspace");
  denies(() => w.resolve("a.js", { cwd: "../other" }), "outside_workspace");
  assert.equal(w.escapes(path.join(evil, "x.txt")), true);
  assert.equal(w.escapes("src/a.js"), false);
  assert.equal(w.escapes("../other"), true);
});

test("a link inside the workspace that points outside cannot be used to get out", (t) => {
  try {
    fs.symlinkSync(other, path.join(proj, "link"), "junction");
  } catch (e) {
    t.skip(`cannot create a link here: ${e.code}`);
    return;
  }
  const w = ws();
  denies(() => w.resolve("link/data.txt"), "outside_workspace");
  denies(() => w.resolve("link/new-file.txt", { write: true }), "outside_workspace");
  assert.equal(w.escapes("link/data.txt"), true);
  fs.unlinkSync(path.join(proj, "link"));
});

test("secrets and repository internals are unreadable and unwritable inside the workspace", () => {
  const w = ws();
  for (const p of [".env", ".ENV", ".env.local", ".env.production", ".git/config", ".git/hooks/pre-commit", "secrets.json", "certs/server.pem", "src/id_rsa", "deploy/key.pem", ".npmrc", "key.json"]) {
    for (const wr of [false, true]) denies(() => w.resolve(p, { write: wr }), "protected_path");
  }
  assert.equal(w.resolve(".env.example"), path.join(proj, ".env.example"), "an example file holds no secrets");
  assert.equal(w.resolve("src/environment.js", { write: true }), path.join(proj, "src", "environment.js"), "a name that merely contains 'env' is fine");
});

test("node_modules can be read but not edited", () => {
  const w = ws();
  assert.equal(w.resolve("node_modules/dep/index.js"), path.join(proj, "node_modules", "dep", "index.js"));
  denies(() => w.resolve("node_modules/dep/index.js", { write: true }), "protected_path");
});

test("secret-name rules", () => {
  for (const n of [".env", ".env.staging", "id_rsa", "id_ed25519", "x.pem", "x.PFX", "credentials.json", "secrets", "service-account-prod.json", ".git-credentials"]) assert.equal(isSecretName(n), true, n);
  for (const n of [".env.example", ".env.sample", "id_rsa.pub", "environment.js", "keyboard.js", "README.md", "monkey.json"]) assert.equal(isSecretName(n), false, n);
});

test("Windows path tricks are refused by syntax alone (checked for the win32 rules on any platform)", () => {
  const bad = (p, code, why) => assert.throws(() => checkPathSyntax(p, "win32"), (e) => e instanceof PolicyError && e.code === code && (!why || why.test(e.message)), `${p} should be refused${why ? ` with a message matching ${why}` : ""}`);
  bad("\\\\?\\C:\\proj\\a.js", "invalid_path", /device paths/);
  bad("\\\\.\\PhysicalDrive0", "invalid_path", /device paths/);
  bad("//?/C:/proj/a.js", "invalid_path", /device paths/);
  bad("\\\\server\\share\\a.js", "invalid_path", /network \(UNC\)/);
  bad("C:\\proj\\a.txt:hidden", "invalid_path");
  bad("C:\\proj\\a.txt::$DATA", "invalid_path");
  bad("C:\\proj\\NUL", "reserved_name");
  bad("C:\\proj\\con.txt", "reserved_name");
  bad("C:\\proj\\COM1", "reserved_name");
  bad("C:\\proj\\.env.", "invalid_path"); // Windows would open ".env"
  bad("C:\\proj\\notes ", "invalid_path");
  for (const ok of ["C:\\proj\\a.txt", "C:/proj/src/a.js", "src\\a.js", "..\\x", ".\\a", "console.log.js", "nullable.txt"]) assert.equal(checkPathSyntax(ok, "win32"), ok);
  // a colon is an ordinary character elsewhere
  assert.equal(checkPathSyntax("a:b", "linux"), "a:b");
});

test("empty, NUL and oversized paths are refused everywhere", () => {
  for (const p of ["", "   ", "a\0b", "x".repeat(1100), null, 42]) denies(() => checkPathSyntax(p, "linux"), "invalid_path");
});

test("display gives a short root-relative name", () => {
  const w = ws();
  assert.equal(w.display(path.join(proj, "src", "a.js")), "src/a.js");
  assert.equal(w.display(proj), ".");
  assert.equal(w.display(path.join(other, "data.txt")).replace(/\\/g, "/"), path.join(other, "data.txt").replace(/\\/g, "/"));
});

test("two roots: each resolves, and a path in neither is refused", () => {
  const w = new Workspace({ roots: [proj, other] });
  assert.equal(w.resolve(path.join(other, "data.txt")), path.join(other, "data.txt"));
  assert.equal(w.resolve("src/a.js"), path.join(proj, "src", "a.js"));
  denies(() => w.resolve(path.join(evil, "x.txt")), "outside_workspace");
});
