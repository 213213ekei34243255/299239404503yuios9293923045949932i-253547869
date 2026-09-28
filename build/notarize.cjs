// build/notarize.cjs - electron-builder "afterSign" hook: notarize the signed .app with Apple, with a TIME LIMIT.
//
// Why this exists. electron-builder's own notarization runs `notarytool submit --wait`, which has no time limit and prints nothing while
// it waits. Apple holds a developer account's first notarization submissions "In Progress" for hours (sometimes days). On GitHub Actions
// that looked like a silent hang right after the "signing" line, until the job's timeout cancelled the whole build (nothing produced).
//
// What this does instead (package.json sets mac.notarize:false so electron-builder's own step stays out of the way):
//   1. zip the .app and upload it (a few tries)                   -> Apple answers with a submission id
//   2. ask Apple for the status every 30 s and print each answer  -> the build log always shows what Apple is saying
//   3. Accepted                          -> staple the ticket to the app; the DMG is then built from the stapled app
//      Invalid / Rejected                -> FAIL the build, with Apple's own report (that is a real problem in the app)
//      still "In Progress" at the limit  -> print the id and carry on: the DMG is signed but NOT notarized yet
//      anything unexpected (tool missing, unreadable reply, network) is a warning, never a failed build: a signed DMG is worth having.
//
// Settings (environment; without the three APPLE_* nothing happens at all):
//   APPLE_API_KEY (path to the .p8 file), APPLE_API_KEY_ID, APPLE_API_ISSUER   - the App Store Connect API key
//   NOTARIZE_MAX_MINUTES  how long to wait for Apple (default 20; 0 = do not notarize)
//
// Honest status: the flow is unit-tested against a stand-in for `xcrun` (Noah/test/unit/notarize.test.cjs). It has NOT been run against
// Apple's real service from here (this machine is Windows) - the first real run is the proof.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_MAX_MINUTES = 20;
const POLL_MS = 30000;
const UPLOAD_TRIES = 3;
const UPLOAD_RETRY_MS = 10000;
const STAPLE_TRIES = 6; // right after "Accepted" Apple's ticket service can take a moment to have the ticket ("Record not found")
const STAPLE_RETRY_MS = 10000;
const MAX_STATUS_FAILURES = 5;

function defaultRun(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return resolve({ code: -1, stdout: "", stderr: String(e && e.message || e) }); }
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + String(e && e.message || e) }));
    child.on("close", (code) => resolve({ code: code == null ? -1 : code, stdout, stderr }));
  });
}
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// notarytool prints one JSON document with --output-format json; tolerate a stray line before/after it.
function parseJson(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60), s = total % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function readMaxMinutes(env) {
  const raw = env.NOTARIZE_MAX_MINUTES;
  if (raw == null || String(raw).trim() === "") return DEFAULT_MAX_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_MAX_MINUTES;
}

/**
 * Notarize `appPath`. Resolves with { state, id?, reason? }:
 *   "skipped"      nothing to do (no credentials / limit 0)
 *   "stapled"      Apple accepted it and the ticket is attached to the app
 *   "accepted"     Apple accepted it but the ticket could not be attached (the app is still notarized; Gatekeeper checks online)
 *   "pending"      Apple was still working at the limit (id says which submission to check later)
 *   "unavailable"  something outside Apple's verdict went wrong (reason says what)
 * Rejects (error.rejected === true) only when Apple says the app is Invalid/Rejected.
 */
async function notarizeApp(opts) {
  const { appPath } = opts;
  const env = opts.env || process.env;
  const run = opts.run || defaultRun;
  const sleep = opts.sleep || defaultSleep;
  const now = opts.now || Date.now;
  const log = opts.log || ((m) => console.log(`  • ${m}`));
  const exists = opts.exists || fs.existsSync;
  const pollMs = opts.pollMs == null ? POLL_MS : opts.pollMs;

  const keyPath = env.APPLE_API_KEY, keyId = env.APPLE_API_KEY_ID, issuer = env.APPLE_API_ISSUER;
  if (!keyPath || !keyId || !issuer) {
    log("notarization skipped: APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER are not all set");
    return { state: "skipped", reason: "no credentials" };
  }
  const maxMinutes = opts.maxMinutes == null ? readMaxMinutes(env) : opts.maxMinutes;
  if (!(maxMinutes > 0)) {
    log("notarization skipped: NOTARIZE_MAX_MINUTES is 0");
    return { state: "skipped", reason: "limit is 0" };
  }
  if (!exists(keyPath)) {
    log("notarization skipped: the API key file is missing, so nothing can be sent to Apple");
    return { state: "unavailable", reason: "API key file missing" };
  }

  // Arguments carry the credentials, so they are never printed - only the messages below are.
  const auth = ["--key", keyPath, "--key-id", keyId, "--issuer", issuer];
  const xcrun = (...args) => run("xcrun", args);
  const maxMs = maxMinutes * 60000;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-notarize-"));
  try {
    // ---- 1. zip + upload
    const zip = path.join(tmp, `${path.parse(appPath).name}.zip`);
    const z = await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", path.basename(appPath), zip], { cwd: path.dirname(appPath) });
    if (z.code !== 0) {
      log(`could not zip the app for Apple (exit ${z.code}) - not notarizing`);
      return { state: "unavailable", reason: "zip failed" };
    }
    let id = null;
    for (let attempt = 1; attempt <= UPLOAD_TRIES && !id; attempt++) {
      log(`uploading to Apple's notary service (try ${attempt}/${UPLOAD_TRIES})...`);
      const r = await xcrun("notarytool", "submit", zip, ...auth, "--output-format", "json");
      const j = r.code === 0 ? parseJson(r.stdout) : null;
      if (j && typeof j.id === "string" && j.id) id = j.id;
      else {
        log(`upload did not go through (exit ${r.code})${r.stderr ? `: ${String(r.stderr).trim().split("\n").pop().slice(0, 200)}` : ""}`);
        if (attempt < UPLOAD_TRIES) await sleep(UPLOAD_RETRY_MS);
      }
    }
    if (!id) return { state: "unavailable", reason: "upload failed" };
    log(`Apple accepted the upload. Submission id: ${id}`);

    // ---- 2. ask for the status until there is a verdict or the limit is reached
    const started = now();
    let failures = 0;
    for (;;) {
      const r = await xcrun("notarytool", "info", id, ...auth, "--output-format", "json");
      const info = r.code === 0 ? parseJson(r.stdout) : null;
      if (!info || !info.status) {
        failures++;
        log(`could not read the status from Apple (${failures}/${MAX_STATUS_FAILURES})`);
        if (failures >= MAX_STATUS_FAILURES) return { state: "unavailable", id, reason: "status unreadable" };
      } else {
        failures = 0;
        const status = String(info.status);
        log(`Apple says: ${status} (waited ${fmtDuration(now() - started)})`);
        if (status === "Accepted") break;
        if (status === "Invalid" || status === "Rejected") {
          const lg = await xcrun("notarytool", "log", id, ...auth);
          const err = new Error(`Apple ${status === "Invalid" ? "found problems with" : "rejected"} the app (submission ${id}).\n${lg.stdout || lg.stderr || "(no report available)"}`);
          err.rejected = true;
          throw err;
        }
      }
      const left = started + maxMs - now();
      if (left <= 0) {
        log(`still "In Progress" after ${maxMinutes} min - carrying on WITHOUT notarization. Apple keeps working on submission ${id}.`);
        return { state: "pending", id, waitedMs: now() - started };
      }
      await sleep(Math.min(pollMs, left));
    }

    // ---- 3. attach the ticket
    for (let attempt = 1; attempt <= STAPLE_TRIES; attempt++) {
      const s = await xcrun("stapler", "staple", appPath);
      if (s.code === 0) { log("notarized, and the ticket is attached to the app"); return { state: "stapled", id }; }
      log(`could not attach the ticket yet (try ${attempt}/${STAPLE_TRIES})`);
      if (attempt < STAPLE_TRIES) await sleep(STAPLE_RETRY_MS);
    }
    log("notarized, but the ticket could not be attached (Gatekeeper will check with Apple online instead)");
    return { state: "accepted", id };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* the OS cleans temp */ }
  }
}

// One short paragraph for the run's summary page (only when GitHub gives us somewhere to write it).
function summaryFor(result, maxMinutes) {
  const id = result.id ? ` Submission id: \`${result.id}\`.` : "";
  switch (result.state) {
    case "stapled": return "**Notarization: done.** Apple accepted the app and the ticket is attached.";
    case "accepted": return `**Notarization: accepted by Apple**, but the ticket could not be attached to the app (Gatekeeper will check online).${id}`;
    case "pending": return `**Notarization: NOT finished.** Apple was still processing after ${maxMinutes} minutes, so this DMG is **signed but not notarized**.${id} A new developer account's first submissions are often held for hours or days; Apple keeps working on it. Check it with \`xcrun notarytool info <id> --key <AuthKey.p8> --key-id <id> --issuer <issuer>\`, and build again once it says Accepted.`;
    case "unavailable": return `**Notarization: not attempted or not completed** (${result.reason}). This DMG is signed but not notarized.${id}`;
    default: return "";
  }
}

async function afterSign(context, deps = {}) {
  if (context.electronPlatformName !== "darwin") return;
  const env = deps.env || process.env;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const log = deps.log || ((m) => console.log(`  • ${m}`));
  let result;
  try {
    result = await (deps.notarizeApp || notarizeApp)({ ...deps, appPath, env });
  } catch (e) {
    if (e && e.rejected) throw e; // Apple's verdict is "no": that must stop the build
    log(`notarization hit an unexpected problem and was skipped: ${e && e.message || e}`);
    result = { state: "unavailable", reason: "unexpected error" };
  }
  const maxMinutes = readMaxMinutes(env);
  if (result.state === "pending" || result.state === "unavailable") {
    console.log(`::warning title=Not notarized::${summaryFor(result, maxMinutes).replace(/[*`]/g, "")}`);
  }
  const text = summaryFor(result, maxMinutes);
  if (text && env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n\n`); } catch { /* the summary is a courtesy */ }
  }
  return result;
}

module.exports = afterSign;
module.exports.notarizeApp = notarizeApp;
module.exports.summaryFor = summaryFor;
module.exports.parseJson = parseJson;
