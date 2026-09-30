// try-developer-access.cjs - a one-click demo of the developer-access sign-in on THIS computer.
//
//   node try-developer-access.cjs                (or double-click try-developer-access.cmd)
//   node try-developer-access.cjs --second-mac   (or try-developer-access-second-mac.cmd)  a different "Mac" for the one-device rule
//
// It starts the licence server locally (license-server/, its own database in license-server/data/, never touching any real server), makes two TEST
// accounts, opens the Developer Console in your browser, and starts the real Jonah with the sign-in gate on. Nothing here uses your real profile:
// each "Mac" gets its own separate profile folder. On a real Mac the gate is always on; here it is switched on with JONAH_REQUIRE_LICENSE.
// The app re-checks every 10 seconds in this demo (60 s for real) so a ban shows up quickly.
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const crypto = require("crypto");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");

const ROOT = __dirname;
const SERVER_DIR = path.join(ROOT, "license-server");
const DATA = path.join(SERVER_DIR, "data");
const PORT = Number(process.env.TRY_PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const SECOND = process.argv.includes("--second-mac");
const PROFILE = path.join(process.env.LOCALAPPDATA || os.tmpdir(), SECOND ? "JonahLicenseTest-SecondMac" : "JonahLicenseTest-Mac1");
const ACCOUNTS_FILE = path.join(DATA, "dev-test-accounts.txt");
const ADMIN_FILE = path.join(DATA, "dev-admin.txt");
const TEST_USERS = ["test_one", "test_two"];
const WORDS = ["amber", "falcon", "river", "maple", "comet", "harbor", "violet", "pebble", "lantern", "meadow", "orbit", "cedar", "ripple", "summit", "willow", "ember"];

const say = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.once("listening", () => s.close(() => resolve(true))); s.listen(port, "127.0.0.1"); });
const passphrase = () => Array.from({ length: 3 }, () => WORDS[crypto.randomInt(WORDS.length)]).join("-") + "-" + crypto.randomInt(10, 100);
const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(SERVER_DIR, "cli.cjs"), ...args], { cwd: SERVER_DIR, env: { ...process.env, NODE_NO_WARNINGS: "1", ...env }, encoding: "utf8" });

function readAccountsFile() {
  const out = {};
  try { for (const line of fs.readFileSync(ACCOUNTS_FILE, "utf8").split(/\r?\n/)) { const m = /^(\w+)\s+(\S+)$/.exec(line.trim()); if (m && TEST_USERS.includes(m[1])) out[m[1]] = m[2]; } } catch { /* not created yet */ }
  return out;
}

// Creates the test accounts if they are missing (or resets their password if the file with the passwords was deleted).
function ensureTestAccounts() {
  fs.mkdirSync(DATA, { recursive: true });
  const known = readAccountsFile();
  const existing = new Set((cli(["list"]).stdout || "").split(/\r?\n/).map((l) => l.trim().split(/\s+/)[0]));
  const passwords = {};
  for (const u of TEST_USERS) {
    if (known[u] && existing.has(u)) { passwords[u] = known[u]; continue; }
    passwords[u] = passphrase();
    const r = cli([existing.has(u) ? "set-password" : "add-account", u], { NEW_PASSWORD: passwords[u] });
    if (r.status !== 0) throw new Error(`could not create ${u}: ${r.stderr || r.stdout}`);
  }
  fs.writeFileSync(ACCOUNTS_FILE, "Test accounts for the LOCAL developer-access demo (this file is git-ignored)\n" + TEST_USERS.map((u) => `${u}   ${passwords[u]}`).join("\n") + "\n");
  return passwords;
}

async function healthy() { try { return (await fetch(BASE + "/health")).ok; } catch { return false; } }

async function main() {
  say(`\n  Jonah developer-access demo${SECOND ? "  (SECOND Mac)" : ""}\n  ${"-".repeat(46)}`);
  if (!(await portFree(5589)) || !(await portFree(5588))) {
    say("\n  Jonah's own ports (5588/5589) are busy: another Jonah is open. Close it and run this again.\n");
    return 1;
  }
  if (Number(process.versions.node.split(".")[0]) < 22) { say(`\n  This needs Node 22.5 or newer (you have ${process.versions.node}).\n`); return 1; }

  const passwords = ensureTestAccounts();
  let server = null;
  if (await healthy()) say(`  Reusing the licence server already running on ${BASE}`);
  else {
    const log = fs.openSync(path.join(DATA, "dev-server.log"), "a");
    server = spawn(process.execPath, [path.join(SERVER_DIR, "server.cjs")], { cwd: SERVER_DIR, env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", NODE_NO_WARNINGS: "1" }, stdio: ["ignore", log, log], windowsHide: true });
    for (let i = 0; i < 60 && !(await healthy()); i++) await sleep(250);
    if (!(await healthy())) { say("\n  The licence server did not start. See license-server/data/dev-server.log\n"); if (server) server.kill(); return 1; }
    say(`  Licence server started on ${BASE}`);
  }
  const keys = (await (await fetch(BASE + "/v1/public-keys")).json()).keys.map((k) => ({ kid: k.kid, spki: k.spki }));

  let admin = "";
  try { admin = fs.readFileSync(ADMIN_FILE, "utf8").trim().split(/\r?\n/).filter((l) => /^(Username|Password):/.test(l)).join("   "); } catch { /* none */ }

  say(`
  DEVELOPER CONSOLE (opening in your browser):  ${BASE}/admin/
    ${admin || "No dev administrator yet: run   node license-server/cli.cjs reset-admin owner"}

  TEST ACCOUNTS (sign in to the app with these):
    ${TEST_USERS[0]}   password: ${passwords[TEST_USERS[0]]}
    ${TEST_USERS[1]}   password: ${passwords[TEST_USERS[1]]}
  (your two real accounts also exist in this local database)

  WHAT TO TRY
    1. Sign in to the app with test_one: Jonah opens.  A wrong password is refused.
    2. In the console click Ban on test_one: within ~10 seconds the app closes and comes back at the sign-in
       screen with the "developer access has expired" message.  Signing in again shows the same message.
       Click Unban and it works again.  (Disable, Sign out now and the two big switches lock a running app too.)
    3. ${SECOND ? "You ARE the second Mac now: signing in with an account another Mac already uses shows the 'already authorized on another device' message. Then click Revoke device in the console and this second Mac can sign in." : "The one-device rule: close this Jonah app (leave THIS window open, it runs the server), then double-click try-developer-access-second-mac.cmd and sign in with test_one there. It is refused ('already authorized on another device'). Click Revoke device in the console and that second Mac can sign in. (Only one Jonah can run at a time.)"}
    4. Close THIS window's server (press Enter here) while the app is open: within ~3 minutes it locks with 'cannot reach the authorization server'.
`);
  spawn("cmd", ["/c", "start", "", `${BASE}/admin/`], { detached: true, stdio: "ignore", windowsHide: true }).unref();

  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const app = spawn(electronPath, [`--user-data-dir=${PROFILE}`, "."], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, JONAH_REQUIRE_LICENSE: "1", JONAH_LICENSE_URL: BASE, JONAH_LICENSE_KEYS: JSON.stringify(keys), JONAH_LICENSE_HEARTBEAT_MS: "10000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const relay = (d) => { for (const line of String(d).split(/\r?\n/)) if (line.includes("[license]")) say("  app:", line.replace(/^.*\[license\]\s*/, "")); };
  app.stdout.on("data", relay); app.stderr.on("data", relay);
  app.on("exit", (code) => say(`  (the app process ended, exit ${code}. If access was withdrawn it has restarted itself at the sign-in screen.)`));

  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    say("  Press Enter (or Ctrl+C) here to stop the demo server.\n");
    rl.on("line", resolve); rl.on("close", resolve); process.on("SIGINT", resolve);
  });
  if (server) server.kill();
  try { app.kill(); } catch { /* already gone */ }
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error("\n  Something went wrong:", e.message, "\n"); process.exit(1); });
