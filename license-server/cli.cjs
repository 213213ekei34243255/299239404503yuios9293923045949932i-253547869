// Command-line administration for the licence server, run on the server itself (it reads the same DATA_DIR as the running server).
//
//   node cli.cjs keygen                      show (creating it if needed) the signing key's PUBLIC part for the Mac app's build settings
//   node cli.cjs list                        list accounts and their status
//   node cli.cjs add-account <username>      create an account (asks for the password; or set NEW_PASSWORD in the environment)
//   node cli.cjs set-password <username>     change an account's password
//   node cli.cjs reset-admin <username>      create or reset a Developer Console administrator (asks for the password)
//
// Passwords are never taken from the command line (they would end up in shell history); the prompt does not echo them.
"use strict";
const path = require("path");
const readline = require("readline");
const { loadConfig } = require("./src/config.cjs");
const { openDb } = require("./src/db.cjs");
const C = require("./src/crypto.cjs");
const { LicenseService } = require("./src/service.cjs");

function askHidden(prompt) {
  if (process.env.NEW_PASSWORD) return Promise.resolve(process.env.NEW_PASSWORD);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(s); }; // hide what is typed
    rl.question(prompt, (a) => { rl.output.write("\n"); rl.close(); resolve(a); });
  });
}

async function main() {
  const [cmd, name] = process.argv.slice(2);
  const config = loadConfig();
  const key = C.loadSigningKey({ pemOrBase64: config.signingKey, dataDir: config.dataDir });
  if (cmd === "keygen") {
    console.log(JSON.stringify({ kid: key.kid, spki: key.spki }, null, 2));
    console.log("\nThis is the PUBLIC key. Put it (with the server's https address) into the Mac app's build settings. The private key stays on the server.");
    return;
  }
  const db = openDb(path.join(config.dataDir, "license.db"));
  const service = new LicenseService({ db, config, signingKey: key });
  try {
    if (cmd === "list") {
      for (const a of service.listAccounts()) console.log(`${a.username.padEnd(24)} ${a.effectiveStatus.padEnd(9)} ${a.online ? "online " : "offline"} ${a.device ? a.device.label : "(no device yet)"}`);
    } else if (cmd === "add-account" && name) {
      const pw = await askHidden("Password for the new account: ");
      await service.createAccount({ username: name, password: pw }, "cli");
      console.log(`Created ${name}.`);
    } else if (cmd === "set-password" && name) {
      const acct = service.listAccounts().find((a) => a.username.toLowerCase() === name.toLowerCase());
      if (!acct) throw new Error("No such account.");
      await service.setPassword(acct.id, await askHidden("New password: "), "cli");
      console.log(`Password changed for ${acct.username}; that user is signed out.`);
    } else if (cmd === "reset-admin" && name) {
      const pw = await askHidden("Administrator password (12+ characters): ");
      if (pw.length < 12) throw new Error("The administrator password must be at least 12 characters.");
      const hash = await C.hashPassword(pw);
      const existing = db.prepare("SELECT id FROM admins WHERE username = ?").get(name);
      if (existing) { db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(hash, existing.id); db.prepare("DELETE FROM admin_sessions WHERE admin_id = ?").run(existing.id); }
      else db.prepare("INSERT INTO admins (username, password_hash, created_at) VALUES (?,?,?)").run(name, hash, service.now());
      service.audit("cli", "admin_reset", name, null, null);
      console.log(`Administrator ${name} is ready. All of their console sessions were ended.`);
    } else {
      console.log("Usage: node cli.cjs keygen | list | add-account <username> | set-password <username> | reset-admin <username>");
      process.exitCode = 1;
    }
  } catch (e) { console.error("Error:", e.message); process.exitCode = 1; } finally { db.close(); }
}
main();
