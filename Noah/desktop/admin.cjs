// Noah/desktop/admin.cjs
//
// OPTIONAL administrator access for Jonah on Windows (the user switches it on in the Noah bar; it is OFF by default).
//
// Why: Windows keeps a normal program from reading or operating a window of a program that runs as administrator (installers, Task Manager, some games and editors). Noah's helper
// then fails with "Windows did not accept the input (a program running as administrator...)". If Jonah itself runs as administrator, its helper does too and can see and operate those
// windows. The price is real and the user is told: the whole of Jonah, web pages included, then runs with administrator rights. So:
//   * it is a switch the user turns on, with a plain explanation first, never the default;
//   * Windows asks for its own permission (the UAC prompt) every time Jonah starts that way: if the user says no, Jonah simply carries on normally;
//   * turning it off takes effect the next time Jonah is opened (nothing is "un-elevated" under the user's feet).
// Only the flag file and the relaunch live here; Windows' own prompt is what grants the rights.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const FILE = "admin-access.json";
const supported = (platform = process.platform) => platform === "win32";

/** Is this process running with administrator rights? (Windows: the `fltmc` tool only works for an administrator.) */
function isElevated({ platform = process.platform, run = spawnSync } = {}) {
  if (platform === "win32") {
    try { const r = run("fltmc", [], { windowsHide: true, timeout: 5000, stdio: "ignore" }); return !!r && r.status === 0; } catch (_) { return false; }
  }
  try { return typeof process.getuid === "function" && process.getuid() === 0; } catch (_) { return false; }
}

function readEnabled(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf8")).enabled === true; } catch (_) { return false; }
}

function writeEnabled(dir, enabled) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ enabled: enabled === true, at: Date.now() }));
    return true;
  } catch (_) { return false; }
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The PowerShell that starts a program with the Windows permission prompt; exit 0 = it started, 1 = the user said no (or it could not start). */
function elevateScript({ exe, args = [] }) {
  return `try { Start-Process -FilePath ${psQuote(exe)} -ArgumentList @(${args.map(psQuote).join(",")}) -Verb RunAs -ErrorAction Stop; exit 0 } catch { exit 1 }`;
}

/**
 * Start Jonah again with administrator rights. The new copy waits for this one to finish (--wait-for-pid) so the two never fight over the same ports and files.
 * @returns {{ ok: boolean, declined?: boolean }} ok = Windows gave the rights and the new copy is starting: the caller may quit.
 */
function relaunchElevated({ exe = process.execPath, pid = process.pid, appArgs = [], run = spawnSync, platform = process.platform } = {}) {
  if (!supported(platform)) return { ok: false, unsupported: true };
  const script = elevateScript({ exe, args: [...appArgs, `--wait-for-pid=${pid}`] });
  const encoded = Buffer.from(script, "utf16le").toString("base64"); // (-EncodedCommand: no quoting problems with a path such as C:\Users\A&B\...)
  try {
    const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, timeout: 120000, stdio: "ignore" });
    return r && r.status === 0 ? { ok: true } : { ok: false, declined: true };
  } catch (_) { return { ok: false, declined: true }; }
}

/** A copy started by relaunchElevated waits here (before anything else starts) until the copy that started it has gone, or `maxMs` has passed. */
function waitForParent(argv = process.argv, { alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), maxMs = 20000 } = {}) {
  const arg = (argv || []).find((a) => typeof a === "string" && a.startsWith("--wait-for-pid="));
  const pid = arg ? Number(arg.slice("--wait-for-pid=".length)) : 0;
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  let waited = 0;
  while (waited < maxMs && alive(pid)) { sleep(150); waited += 150; }
  return true;
}

module.exports = { supported, isElevated, readEnabled, writeEnabled, elevateScript, relaunchElevated, waitForParent, FILE };
