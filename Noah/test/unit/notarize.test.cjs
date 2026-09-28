// Noah/test/unit/notarize.test.cjs
//
// build/notarize.cjs - the time-limited notarization step of the Mac build. These use a stand-in for `xcrun`/`ditto` and a fake clock, so they
// prove Jonah's side (what it asks Apple, how it reacts to each answer, that it stops waiting, that it never prints the credentials). They do
// NOT prove Apple's real service answers in exactly these shapes - only a real run does (see the honest-status note in notarize.cjs).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const afterSign = require("../../../build/notarize.cjs");
const { notarizeApp, summaryFor, parseJson } = afterSign;

const CREDS = { APPLE_API_KEY: "/secret/dir/AuthKey_ABC123.p8", APPLE_API_KEY_ID: "ABC123KEYID", APPLE_API_ISSUER: "11111111-2222-3333-4444-555555555555" };
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom", code = 1) => ({ code, stdout: "", stderr });

// Fake environment: `script(cmdline, callIndexForThatCommand)` decides each reply. A fake clock advances only when the code sleeps.
function harness(script, extra = {}) {
  const calls = [], logs = [];
  let t = 1000000;
  const count = {};
  const h = {
    calls, logs,
    clock: () => t,
    opts: {
      appPath: path.join(os.tmpdir(), "fake-out", "Jonah.app"),
      env: { ...CREDS, ...(extra.env || {}) },
      run: async (cmd, args) => {
        const line = [cmd, ...args.filter((a) => !a.startsWith("--") && ![CREDS.APPLE_API_KEY, CREDS.APPLE_API_KEY_ID, CREDS.APPLE_API_ISSUER].includes(a))].join(" ");
        calls.push({ cmd, args });
        const key = cmd === "xcrun" ? `${cmd} ${args[0]} ${args[1]}` : `${cmd} ${args[0] || ""}`.trim();
        count[key] = (count[key] || 0) + 1;
        return script(key, count[key], line, args);
      },
      sleep: async (ms) => { t += ms; },
      now: () => t,
      log: (m) => logs.push(m),
      exists: () => true,
      ...(extra.opts || {}),
    },
  };
  return h;
}
const submitOk = (id = "sub-1") => ok(JSON.stringify({ id, message: "Successfully uploaded file", path: "x.zip" }));
const info = (status) => ok(JSON.stringify({ id: "sub-1", status }));
const sequence = (...replies) => (n) => replies[Math.min(n, replies.length) - 1];

test("no credentials: nothing is run and nothing is asked of Apple", async () => {
  const h = harness(() => ok(), { env: { APPLE_API_KEY: "", APPLE_API_KEY_ID: "", APPLE_API_ISSUER: "" } });
  const r = await notarizeApp(h.opts);
  assert.equal(r.state, "skipped");
  assert.equal(h.calls.length, 0);
});

test("NOTARIZE_MAX_MINUTES=0 skips notarizing", async () => {
  const h = harness(() => ok(), { env: { NOTARIZE_MAX_MINUTES: "0" } });
  assert.equal((await notarizeApp(h.opts)).state, "skipped");
  assert.equal(h.calls.length, 0);
});

test("success: zip, upload, poll until Accepted, then staple - in that order", async () => {
  const infoReplies = sequence(info("In Progress"), info("In Progress"), info("Accepted"));
  const h = harness((key, n) => {
    if (key === "ditto -c") return ok();
    if (key === "xcrun notarytool submit") return submitOk();
    if (key === "xcrun notarytool info") return infoReplies(n);
    if (key === "xcrun stapler staple") return ok();
    throw new Error("unexpected " + key);
  });
  const r = await notarizeApp(h.opts);
  assert.deepEqual({ state: r.state, id: r.id }, { state: "stapled", id: "sub-1" });
  const order = h.calls.map((c) => (c.cmd === "ditto" ? "ditto" : c.args.slice(0, 2).join(" ")));
  assert.deepEqual(order, ["ditto", "notarytool submit", "notarytool info", "notarytool info", "notarytool info", "stapler staple"]);
  const submit = h.calls.find((c) => c.args[1] === "submit");
  assert.ok(submit.args.includes("--key") && submit.args.includes(CREDS.APPLE_API_KEY_ID) && submit.args.includes(CREDS.APPLE_API_ISSUER), "the credentials are passed to notarytool");
  assert.ok(!submit.args.includes("--wait"), "no unbounded --wait: Jonah does its own bounded waiting");
  assert.ok(h.logs.some((l) => /Apple says: In Progress/.test(l)), "each status is shown in the log");
});

test("the credentials are never written to the log", async () => {
  const h = harness((key) => (key === "xcrun notarytool submit" ? submitOk() : key === "xcrun notarytool info" ? info("Accepted") : ok()));
  await notarizeApp(h.opts);
  const all = h.logs.join("\n");
  for (const secret of [CREDS.APPLE_API_KEY, CREDS.APPLE_API_KEY_ID, CREDS.APPLE_API_ISSUER, "AuthKey_ABC123", "secret/dir"]) assert.ok(!all.includes(secret), `log leaked ${secret}`);
});

test("Apple still working at the limit: stops waiting, reports the id, does NOT fail and does NOT staple", async () => {
  const h = harness((key) => {
    if (key === "xcrun notarytool submit") return submitOk("held-1");
    if (key === "xcrun notarytool info") return info("In Progress");
    return ok();
  }, { env: { NOTARIZE_MAX_MINUTES: "20" } });
  const start = h.clock();
  const r = await notarizeApp(h.opts);
  assert.equal(r.state, "pending");
  assert.equal(r.id, "held-1");
  const waited = h.clock() - start;
  assert.ok(waited >= 20 * 60000 && waited < 21 * 60000, `waited ${waited} ms`);
  assert.ok(!h.calls.some((c) => c.args[0] === "stapler"), "nothing to staple yet");
  assert.ok(h.logs.some((l) => /held-1/.test(l) && /WITHOUT notarization/.test(l)));
  assert.ok(h.calls.filter((c) => c.args[1] === "info").length <= 45, "polls every 30 s, not in a tight loop");
});

test("Invalid: the build fails with Apple's own report", async () => {
  const h = harness((key) => {
    if (key === "xcrun notarytool submit") return submitOk("bad-1");
    if (key === "xcrun notarytool info") return info("Invalid");
    if (key === "xcrun notarytool log") return ok('{"issues":[{"path":"Jonah.app/x","message":"The binary is not signed with a valid Developer ID certificate."}]}');
    return ok();
  });
  await assert.rejects(notarizeApp(h.opts), (e) => e.rejected === true && /not signed with a valid Developer ID/.test(e.message) && /bad-1/.test(e.message));
});

test("upload is retried, then works", async () => {
  const h = harness((key, n) => {
    if (key === "xcrun notarytool submit") return n < 3 ? fail("Could not connect to the server") : submitOk();
    if (key === "xcrun notarytool info") return info("Accepted");
    return ok();
  });
  const r = await notarizeApp(h.opts);
  assert.equal(r.state, "stapled");
  assert.equal(h.calls.filter((c) => c.args[1] === "submit").length, 3);
});

test("upload never works: a warning-level result, not a thrown error", async () => {
  const h = harness((key) => (key === "xcrun notarytool submit" ? fail("no network") : ok()));
  const r = await notarizeApp(h.opts);
  assert.equal(r.state, "unavailable");
  assert.equal(h.calls.filter((c) => c.args[1] === "submit").length, 3);
});

test("a garbled or failing status reply five times in a row gives up as unavailable; one blip does not", async () => {
  const blips = harness((key, n) => {
    if (key === "xcrun notarytool submit") return submitOk();
    if (key === "xcrun notarytool info") return n === 2 ? ok("not json") : info(n < 4 ? "In Progress" : "Accepted");
    return ok();
  });
  assert.equal((await notarizeApp(blips.opts)).state, "stapled");

  const dead = harness((key) => (key === "xcrun notarytool submit" ? submitOk() : key === "xcrun notarytool info" ? fail("HTTP 500") : ok()));
  const r = await notarizeApp(dead.opts);
  assert.equal(r.state, "unavailable");
  assert.equal(dead.calls.filter((c) => c.args[1] === "info").length, 5);
});

test("stapling is retried (Apple's ticket can lag behind 'Accepted'); if it never works the app still counts as accepted", async () => {
  const lag = harness((key, n) => {
    if (key === "xcrun notarytool submit") return submitOk();
    if (key === "xcrun notarytool info") return info("Accepted");
    if (key === "xcrun stapler staple") return n < 3 ? fail("Record not found", 65) : ok();
    return ok();
  });
  assert.equal((await notarizeApp(lag.opts)).state, "stapled");

  const never = harness((key) => (key === "xcrun notarytool submit" ? submitOk() : key === "xcrun notarytool info" ? info("Accepted") : key === "xcrun stapler staple" ? fail("nope", 65) : ok()));
  assert.equal((await notarizeApp(never.opts)).state, "accepted");
});

test("zip failure and a missing key file are 'unavailable', and nothing is sent", async () => {
  const z = harness((key) => (key === "ditto -c" ? fail("ditto failed") : ok()));
  assert.equal((await notarizeApp(z.opts)).state, "unavailable");
  assert.ok(!z.calls.some((c) => c.args[1] === "submit"));

  const nokey = harness(() => ok(), { opts: { exists: () => false } });
  assert.equal((await notarizeApp(nokey.opts)).state, "unavailable");
  assert.equal(nokey.calls.length, 0);
});

test("parseJson tolerates a stray line around the JSON and returns null for junk", () => {
  assert.deepEqual(parseJson('Conducting pre-submission checks...\n{"id":"a","status":"Accepted"}\n'), { id: "a", status: "Accepted" });
  assert.equal(parseJson("nothing here"), null);
  assert.equal(parseJson("{broken"), null);
  assert.equal(parseJson(""), null);
});

// ------------------------------------------------------------------ the electron-builder hook wrapper

const ctx = { electronPlatformName: "darwin", appOutDir: "/out/mac", packager: { appInfo: { productFilename: "Jonah" } } };

test("hook: other platforms are ignored", async () => {
  let called = false;
  await afterSign({ ...ctx, electronPlatformName: "win32" }, { notarizeApp: async () => { called = true; return { state: "stapled" }; } });
  assert.equal(called, false);
});

test("hook: builds the .app path from the product name, and writes the outcome to the run summary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-sum-"));
  const summary = path.join(dir, "summary.md");
  let seen;
  const r = await afterSign(ctx, { env: { ...CREDS, GITHUB_STEP_SUMMARY: summary, NOTARIZE_MAX_MINUTES: "20" }, notarizeApp: async (o) => { seen = o.appPath; return { state: "pending", id: "held-9" }; }, log: () => {} });
  assert.equal(path.basename(seen), "Jonah.app");
  assert.equal(r.state, "pending");
  const text = fs.readFileSync(summary, "utf8");
  assert.match(text, /NOT finished/);
  assert.match(text, /signed but not notarized/);
  assert.match(text, /held-9/);
});

test("hook: Apple's 'no' stops the build; any other surprise is only a warning", async () => {
  const rejected = Object.assign(new Error("Apple found problems"), { rejected: true });
  await assert.rejects(afterSign(ctx, { env: {}, notarizeApp: async () => { throw rejected; }, log: () => {} }), /Apple found problems/);
  const logs = [];
  const r = await afterSign(ctx, { env: {}, notarizeApp: async () => { throw new Error("spawn xcrun ENOENT"); }, log: (m) => logs.push(m) });
  assert.equal(r.state, "unavailable");
  assert.ok(logs.some((l) => /ENOENT/.test(l)));
});

test("summary text: says plainly whether the DMG is notarized", () => {
  assert.match(summaryFor({ state: "stapled" }, 20), /done/);
  assert.match(summaryFor({ state: "pending", id: "x" }, 20), /signed but not notarized/);
  assert.match(summaryFor({ state: "unavailable", reason: "upload failed" }, 20), /not notarized/);
  assert.equal(summaryFor({ state: "skipped" }, 20), "");
});
