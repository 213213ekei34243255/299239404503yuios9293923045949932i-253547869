// Noah/bench/integration/entitlement-gate-check.cjs
//
// End-to-end check of the billing/entitlement gate with the REAL Jonah app: real main.cjs, real preload bridge, real
// window.rexy.goal()/window.api.trustCheck()/window.api.attachFile() calls (not a reimplementation of the IPC handlers), against a
// real stand-in entitlement server (entitlement-stand-in-server.cjs - NOT noahai.live; see that file's own header).
//
//   node Noah/bench/integration/entitlement-gate-check.cjs
//
// Needs ports 5588/5589 free (the app's own local servers): it skips itself if the real Jonah is open.
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const IS_ELECTRON = Boolean(process.versions.electron);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 150) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); }
}
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.once("listening", () => s.close(() => resolve(true))); s.listen(port, "127.0.0.1"); });

// ====================================================================== RUNNER (inside Electron)

async function runner() {
  const { app, BrowserWindow } = require("electron");
  let failures = 0;
  const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };

  if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "jonah-eg-")));

  // No real browser or Google account in a test: shell.openExternal is replaced so that "the user signs in on Google's page" becomes the
  // same real HTTP request Google's redirect would make to the app's REAL loopback listener. Anything else opened is just recorded.
  const opened = [];
  require("electron").shell.openExternal = async (url) => {
    opened.push(url);
    const u = new URL(url);
    if (u.hostname === "accounts.google.com") {
      const code = `GOOD:e2e-user:${Math.random().toString(36).slice(2)}`;
      await fetch(`${u.searchParams.get("redirect_uri")}?code=${code}&state=${u.searchParams.get("state")}`);
    }
  };
  require(path.join(ROOT, "main.cjs"));

  const win = await until(() => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html")), 30000, 300);
  check("the real browser window opens (no login gate involved in this feature)", !!win);
  if (!win) { console.log("RESULT entitlement-gate FAILED (no window)"); return app.exit(1); }
  await sleep(1500); // let app.whenReady's entitlementGate = createEntitlementGate(...) finish running

  const call = (js) => win.webContents.executeJavaScript(js, true);

  // ---- signed out: every gated feature is refused, with the way forward, and no browser is opened behind the user's back
  const so = await call(`window.rexy.goal("open youtube.com and search for lofi", {mode: "agent"})`);
  check("signed out: an agent task is refused with sign_in_required", so.success === false && so.reason === "sign_in_required" && /Sign in with Google/.test(so.error), JSON.stringify(so));
  const soT = await call(`window.api.trustCheck("example-signedout.com", {})`);
  check("signed out: a Trust Engine check is refused with sign_in_required", soT.blocked === true && soT.reason === "sign_in_required", JSON.stringify(soT));
  const soChat = await call(`window.rexy.goal("what is the capital of France", {mode: "chat"})`);
  check("signed out: chat is refused too (Google sign-in is required for everything, including Free)", soChat.success === false && soChat.reason === "sign_in_required", JSON.stringify(soChat));
  check("signed out: no browser window was opened by those refusals", opened.length === 0, JSON.stringify(opened));
  const st0 = await call(`window.api.billing.status()`);
  check("billing:status says enabled + signed out", st0.ok && st0.enabled === true && st0.signedIn === false, JSON.stringify(st0));
  const co0 = await call(`window.api.billing.checkout("premium", "razorpay")`);
  check("signed out: checkout is refused and no payment page opens", co0.ok === false && co0.reason === "sign_in_required" && opened.length === 0, JSON.stringify(co0));

  // ---- explicit sign-in through the real IPC: real system-browser step (stubbed), real loopback listener, real exchange call
  const si = await call(`window.api.billing.signIn()`);
  check("billing:signIn completes the real loopback flow and the server accepts the exchange", si.ok === true, JSON.stringify(si));
  check("...it opened Google's real auth URL once, with PKCE S256 and the identity-only scope", opened.length === 1 && /accounts\.google\.com\/o\/oauth2\/v2\/auth/.test(opened[0]) && /code_challenge_method=S256/.test(opened[0]) && /scope=openid\+email\+profile|scope=openid%20email%20profile/.test(opened[0]), opened[0]);
  const st1 = await call(`window.api.billing.status()`);
  check("billing:status now signed in, with the server's entitlements (2 agent trials)", st1.ok && st1.signedIn === true && st1.entitlements && st1.entitlements.agent.remaining === 2, JSON.stringify(st1));

  // ---- billing:checkout through the real IPC: the intent is registered, then exactly the catalog's Razorpay link is opened
  const co1 = await call(`window.api.billing.checkout("premium", "razorpay")`);
  check("signed in: checkout opens the catalog's Razorpay link for Premium", co1.ok === true && opened[opened.length - 1] === "https://rzp.io/rzp/1qGVkgs", JSON.stringify(co1) + " " + opened[opened.length - 1]);
  const co2 = await call(`window.api.billing.checkout("https://evil.example/pay", "razorpay")`);
  check("a page-supplied URL is never opened", co2.ok === false && !opened.some((u) => /evil\.example/.test(u)), JSON.stringify(co2));

  // ---- Agent: the real 2-lifetime-trial free plan, via the real rexy:goal handler
  const r1 = await call(`window.rexy.goal("open youtube.com and search for lofi", {mode: "agent"})`);
  check("1st agent use: authorized (the real IPC handler let it proceed)", r1.success === true, JSON.stringify(r1));
  const r2 = await call(`window.rexy.goal("open a random news site", {mode: "agent"})`);
  check("2nd agent use: authorized (2 of 2 lifetime trials)", r2.success === true, JSON.stringify(r2));
  const r3 = await call(`window.rexy.goal("open another site", {mode: "agent"})`);
  check("3rd agent use: REFUSED by the real handler, real main.cjs never called submitGoal", r3.success === false && r3.blocked === true, JSON.stringify(r3));
  check("...with the exact plain-language message the spec requires", typeof r3.error === "string" && /AI Agent limit reached/.test(r3.error), r3.error);
  check("...and the predicted feature was correctly 'agent'", r3.feature === "agent");

  // ---- a control command is never charged, even after the agent trials are exhausted
  const rc = await call(`window.rexy.goal("stop", {mode: "auto"})`);
  check("a 'stop' control command after the trials are gone is NOT blocked by the entitlement gate (it is free)", rc.blocked !== true, JSON.stringify(rc));

  // ---- a plain chat question after agent trials are exhausted is UNAFFECTED (a separate feature/allowance)
  const rchat = await call(`window.rexy.goal("what is the capital of France", {mode: "chat"})`);
  check("chat is a separate allowance from agent: still authorized after agent's trials ran out", rchat.success === true, JSON.stringify(rchat));

  // ---- Trust Engine: the real trust:check handler, 3 uses then a cooldown
  for (let i = 0; i < 3; i++) {
    const r = await call(`window.api.trustCheck("example${i}.com", {})`);
    check(`trust-engine use ${i + 1}/3: authorized`, r.blocked !== true, JSON.stringify(r));
  }
  const rt = await call(`window.api.trustCheck("example-over.com", {})`);
  check("4th trust-engine use: REFUSED (the real trust check never ran)", rt.blocked === true && /Trust Engine limit reached/.test(rt.error), JSON.stringify(rt));

  // ---- Attachments: the real attach:add handler, 5 uses then a cooldown
  const bytes = Array.from(Buffer.from("hello world"));
  for (let i = 0; i < 5; i++) {
    const r = await call(`window.api.attachFile("file${i}.txt", new Uint8Array(${JSON.stringify(bytes)}))`);
    check(`attachment ${i + 1}/5: authorized`, r.ok === true, JSON.stringify(r));
  }
  const ra = await call(`window.api.attachFile("file-over.txt", new Uint8Array(${JSON.stringify(bytes)}))`);
  check("6th attachment: REFUSED (the real store.add was never called - no file was actually added)", ra.ok === false && ra.code === "blocked" && /Attachments limit reached/.test(ra.error), JSON.stringify(ra));

  console.log(`RESULT entitlement-gate ${failures === 0 ? "ok" : failures + " failure(s)"}`);
  app.exit(failures === 0 ? 0 : 1);
}

// ====================================================================== DRIVER (plain Node)

async function driver() {
  if (!(await portFree(5589)) || !(await portFree(5588))) { console.log("SKIP: ports 5588/5589 are in use (the real Jonah is open?)"); return process.exit(0); }
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-eg-run-"));

  const port = await new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const boot = `require(${JSON.stringify(path.join(__dirname, "..", "..", "test", "unit", "entitlement-stand-in-server.cjs"))}).createStandInServer().server.listen(${port}, "127.0.0.1", () => console.log("stand-in up"));`;
  const server = spawn(process.execPath, ["-e", boot], { stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = "";
  server.stdout.on("data", (d) => { serverLog += d; }); server.stderr.on("data", (d) => { serverLog += d; });
  const base = `http://127.0.0.1:${port}`;
  const up = await until(async () => { try { return (await fetch(base + "/api/plans")).ok; } catch { return false; } }, 15000);
  if (!up) { console.log("FAIL  the stand-in entitlement server did not start:\n" + serverLog); server.kill(); return process.exit(1); }

  const dir = path.join(tmp, "macA");
  const child = spawn(electronPath, [`--user-data-dir=${dir}`, __filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, JONAH_ENTITLEMENTS_ENABLED: "1", JONAH_ENTITLEMENTS_URL: base },
    stdio: ["ignore", "pipe", "pipe"], cwd: ROOT,
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", () => {});
  const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 120000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
  for (const line of out.split(/\r?\n/)) if (/^(PASS|FAIL|RESULT)/.test(line)) console.log(line);
  if (code !== 0) { console.log(`FAIL  exited with ${code}`); if (code === -99 || !/RESULT/.test(out)) console.log(out.split(/\r?\n/).slice(-25).join("\n")); }

  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(code === 0 ? 0 : 1);
}

if (IS_ELECTRON) {
  require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e); require("electron").app.exit(2); }));
} else {
  driver().catch((e) => { console.error(e); process.exit(2); });
}
