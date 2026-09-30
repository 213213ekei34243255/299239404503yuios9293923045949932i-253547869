// Noah/bench/integration/license-gate-check.cjs
//
// End-to-end check of the developer-access gate with the REAL Jonah app (real main.cjs, real sign-in window, real licence server):
//
//   node Noah/bench/integration/license-gate-check.cjs                       (against the Node licence server)
//   LICENSE_BACKEND=python node Noah/bench/integration/license-gate-check.cjs  (against the FastAPI backend, jonah-backend/, i.e. what runs on jonahbrowser.store)
//   optional: LG_PYTHON (a Python with the backend's requirements), LG_PY_SITE (extra site-packages, appended LAST), LG_BACKEND_DIR
//
// It starts the licence server as its own process (needs Node >= 22.5 for node:sqlite), then launches the actual app several times - as
// different "Macs" (separate profile folders = separate device keys) - drives the real sign-in window, and uses the real Developer
// Console API to ban, deactivate, revoke and force sign-out. Nothing is stubbed on the app side; the only thing intercepted is the very
// last step of a lock-out (app.relaunch / app.exit), so the run can observe what the app asked for instead of restarting itself.
//
// Needs ports 5588/5589 free (the app's own local servers): it skips itself if the real Jonah is open.
// Every scenario except "unlimited" sets JONAH_REQUIRE_LICENSE=1 because this is Windows (on an Intel Mac the gate is always on
// regardless); "unlimited" leaves it unset to prove the Apple Silicon build's no-login path with the real app.
"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const IS_ELECTRON = Boolean(process.versions.electron);

const EXPIRED = "Sorry, your developer access mode has expired. Kindly reinstall the app from the Mac App Store or jonahbrowser.com, or please contact Customer Care Service.";
const DEVICE = "This account is already authorized on another device. Please contact Customer Care Service to transfer or reset your device authorization.";
const WRONG = "Incorrect username or password.";
const OFFLINE = "Cannot reach the authorization server. Check your internet connection and try again.";
const SESSION_ENDED = "Your session has ended. Please sign in again.";

const USER = "gate_user", PASS = "Gate-pass-123";
const ADMIN = "gate_admin", ADMIN_PASS = "Gate-admin-pass-456";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 150) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); }
}
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.once("listening", () => s.close(() => resolve(true))); s.listen(port, "127.0.0.1"); });

// ====================================================================== RUNNER (inside Electron)

async function runner() {
  const { app, BrowserWindow } = require("electron");
  const scenario = (process.argv.find((a) => a.startsWith("--scenario=")) || "").slice(11);
  const base = process.env.LG_BASE;
  let failures = 0;
  const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  [${scenario}] ${name}${detail ? "  -> " + detail : ""}`); };

  // observe (do not perform) the end of a lock-out
  const realExit = app.exit.bind(app);
  const seen = { relaunch: null, exit: null };
  app.relaunch = (o) => { seen.relaunch = o; };
  app.exit = (c) => { seen.exit = c; };

  // the real Developer Console API
  const admin = {};
  admin.login = async () => {
    const r = await fetch(base + "/admin/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: ADMIN, password: ADMIN_PASS }) });
    admin.cookie = r.headers.get("set-cookie").split(";")[0]; admin.csrf = (await r.json()).csrf;
  };
  admin.call = async (method, p, body) => {
    const r = await fetch(base + "/admin/api" + p, { method, headers: { "Content-Type": "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    return r.json();
  };
  admin.account = async () => (await admin.call("GET", "/overview")).accounts.find((a) => a.username === USER);
  admin.act = async (name) => admin.call("POST", `/accounts/${(await admin.account()).id}/action`, { action: name });

  if (!process.argv.some((a) => a.startsWith("--user-data-dir"))) app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "jonah-lg-")));

  require(path.join(ROOT, "main.cjs"));

  const wins = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  const loginWin = () => wins().find((w) => w.webContents.getURL().includes("license-login.html"));
  const mainWin = () => wins().find((w) => w.webContents.getURL().includes("index.html"));
  const ev = (w, js) => w.webContents.executeJavaScript(js, true);
  const noticeText = async () => { const w = loginWin(); return w ? ev(w, "(function(){var n=document.getElementById('notice');return n.hidden?'':n.textContent})()") : null; };
  const signIn = async (user, pass) => {
    const w = loginWin();
    await ev(w, `document.getElementById('u').disabled=false;document.getElementById('p').disabled=false;document.getElementById('u').value=${JSON.stringify(user)};document.getElementById('p').value=${JSON.stringify(pass)};document.getElementById('form').requestSubmit();true`);
  };
  const waitNotice = (expected, ms = 15000) => until(async () => (await noticeText()) === expected, ms);

  // The unlimited (Apple Silicon) build: license-config.cjs decides `required: false` for it, so main.cjs's whole gate block never
  // runs - no sign-in window, no device key, nothing. Simulated here on Windows by simply not forcing the gate on (every other
  // scenario passes JONAH_REQUIRE_LICENSE=1; this is the one that does not). This takes a different path from every other scenario
  // because there is no sign-in window to wait for at all.
  if (scenario === "unlimited") {
    const mw = await until(mainWin, 30000);
    check("no licence required: the real browser window opens directly", !!mw);
    await sleep(1500);
    check("...and the sign-in window never appears at all", !loginWin());
    console.log(`RESULT [${scenario}] ${failures === 0 ? "ok" : failures + " failure(s)"}`);
    return realExit(failures === 0 ? 0 : 1);
  }

  const win1 = await until(loginWin, 30000);
  check("the sign-in window opens", !!win1);
  if (!win1) return realExit(1);
  await sleep(2500);

  // ---- nothing but the sign-in window may exist before a sign-in
  check("before sign-in the sign-in window is the ONLY window (no browser, no Noah, no hidden windows)", wins().length === 1 && !mainWin(), `${wins().length} window(s)`);
  const probe = await ev(win1, "JSON.stringify({keys:Object.keys(window.jonahLicense||{}).sort(),req:typeof require,proc:typeof process,electron:typeof electron})");
  check("the sign-in page has only its three narrow calls, no Node access", probe === JSON.stringify({ keys: ["init", "login", "quit"], req: "undefined", proc: "undefined", electron: "undefined" }), probe);

  await admin.login();

  if (scenario === "main") {
    check("no notice is shown on a normal launch", (await noticeText()) === "");
    await signIn(USER, "definitely-wrong-1");
    check("wrong password: plain message, still no browser window", (await waitNotice(WRONG)) && !mainWin());
    await signIn(USER, PASS);
    const mw = await until(mainWin, 60000, 300);
    check("correct sign-in: the real browser window (index.html) opens", !!mw);
    check("the sign-in window is gone", !loginWin());
    const acct = await admin.account();
    check("the console shows the user online with this Mac as the authorized device", acct && acct.online && acct.device && acct.device.label && acct.activeSessions >= 1, JSON.stringify(acct && acct.device));
    await sleep(3500);
    check("still allowed while nothing has changed (several checks passed)", !seen.relaunch && !seen.exit);

    if (process.env.LICENSE_BACKEND === "python") {
      // "Unlimited", end to end: the app's own relay (search-proxy.cjs, as main.cjs set it up after the sign-in) talks to the real backend, which
      // allows only 5 requests a minute to an ordinary client. The relay is pointed at the local backend and given an empty folder so it reads no .env.
      process.env.JONAH_SEARCH_PROXY = base;
      const relay = require(path.join(ROOT, "search-proxy.cjs"));
      const axios = require(path.join(ROOT, "node_modules", "axios"));
      const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-lg-relay-"));
      const statuses = [], headers = [], urls = [];
      const spy = { get: async (url, opts) => { const r = await axios.get(url, { ...opts, validateStatus: () => true }); statuses.push(r.status); headers.push(opts.headers || {}); urls.push(url); return r; } };
      for (let i = 0; i < 8; i++) await relay.fetchNews({}, { root: emptyRoot, http: spy });
      check("the signed-in app sends a developer token (X-Jonah-License) to the backend on every request", headers.length === 8 && headers.every((h) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(h["X-Jonah-License"] || "")) && urls.every((u) => u.startsWith(base)));
      check("...and the backend does not rate-limit it: 8 requests through a limit of 5 a minute, no 429", statuses.length === 8 && !statuses.includes(429), JSON.stringify(statuses));
      const plain = [];
      for (let i = 0; i < 8; i++) plain.push((await axios.get(base + "/news/headlines", { validateStatus: () => true })).status);
      check("an ordinary client with no token IS rate-limited by the very same backend", plain.includes(429), JSON.stringify(plain));
    }

    await admin.act("ban");
    const gone = await until(() => seen.relaunch, 10000);
    check("BAN: the app locks itself at its next check", !!gone);
    check("...by restarting into the sign-in screen with the reason attached", gone && gone.args.includes("--license-notice=access_expired") && seen.exit === 0, JSON.stringify(gone && gone.args.slice(-1)));
  }

  if (scenario === "notice") {
    check("after a lock-out the sign-in screen shows the exact access-expired message", (await noticeText()) === EXPIRED);
    await signIn(USER, PASS); // the account is still banned
    await sleep(1500);
    check("banned: signing in again shows the same message and opens nothing", (await waitNotice(EXPIRED)) && !mainWin());
    await admin.act("unban");
    await signIn(USER, PASS);
    check("after an unban the same person can sign in", !!(await until(mainWin, 60000, 300)));
    await admin.call("PATCH", "/settings", { appActive: false });
    const gone = await until(() => seen.relaunch, 10000);
    check("DEACTIVATING THE WHOLE APP locks a running app at its next check", !!gone && gone.args.includes("--license-notice=access_expired"));
    await admin.call("PATCH", "/settings", { appActive: true });
  }

  if (scenario === "off") {
    await admin.call("PATCH", "/settings", { unlimitedEnabled: false });
    await signIn(USER, PASS);
    check("unlimited mode off: sign-in is refused with the access-expired message", (await waitNotice(EXPIRED)) && !mainWin());
    await admin.call("PATCH", "/settings", { unlimitedEnabled: true });
  }

  if (scenario === "device") {
    await signIn(USER, PASS);
    check("a second Mac with the right password gets the device message, nothing opens", (await waitNotice(DEVICE)) && !mainWin());
    await admin.act("revoke-device");
    await signIn(USER, PASS);
    check("after the admin revokes the device this Mac can sign in", !!(await until(mainWin, 60000, 300)));
    const acct = await admin.account();
    check("the console now shows THIS Mac as the authorized device", acct && acct.device && acct.online);
    await admin.act("force-reauth");
    const gone = await until(() => seen.relaunch, 10000);
    check("FORCE RE-LOGIN signs the running app out at its next check", !!gone && gone.args.includes("--license-notice=session_ended"));
  }

  if (scenario === "session") {
    check("a session-ended notice reads as plain 'sign in again'", (await noticeText()) === SESSION_ENDED);
  }

  if (scenario === "junk") {
    check("an unknown notice word on the command line shows nothing (it can never grant or invent anything)", (await noticeText()) === "");
  }

  if (scenario === "offline") {
    await signIn(USER, PASS);
    check("server unreachable: says so, and the app does not start", (await waitNotice(OFFLINE)) && !mainWin());
  }

  if (scenario === "unconfigured") {
    const state = await ev(win1, "JSON.stringify({disabled:document.getElementById('go').disabled,notice:document.getElementById('notice').textContent})");
    check("no server configured: the form is disabled and explains why", /"disabled":true/.test(state) && /not set up/i.test(state), state);
    check("...and no browser window exists", !mainWin());
  }

  console.log(`RESULT [${scenario}] ${failures === 0 ? "ok" : failures + " failure(s)"}`);
  realExit(failures === 0 ? 0 : 1);
}

// ====================================================================== DRIVER (plain Node)

async function driver() {
  if (!(await portFree(5589)) || !(await portFree(5588))) { console.log("SKIP: ports 5588/5589 are in use (the real Jonah is open?)"); return process.exit(0); }
  const electronPath = require(path.join(ROOT, "node_modules", "electron"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-lg-run-"));
  const serverPort = await new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const base = `http://127.0.0.1:${serverPort}`;

  const seed = JSON.stringify([{ username: USER, password: PASS }]);
  let server;
  if (process.env.LICENSE_BACKEND === "python") {
    const backendDir = process.env.LG_BACKEND_DIR || path.join(ROOT, "jonah-backend");
    const py = process.env.LG_PYTHON || path.join(ROOT, "jonah-search", ".venv", "Scripts", "python.exe");
    const site = process.env.LG_PY_SITE || "";
    const boot = `import sys\n${site ? `sys.path.append(${JSON.stringify(site)})\n` : ""}sys.path.insert(0, ${JSON.stringify(backendDir)})\nimport uvicorn\nuvicorn.run('app.main:app', host='127.0.0.1', port=${serverPort}, log_level='warning', proxy_headers=False)`;
    server = spawn(py, ["-c", boot], {
      cwd: backendDir,
      env: { ...process.env, ENVIRONMENT: "development", LICENSE_DATA_DIR: path.join(tmp, "server"), LICENSE_ADMIN_USERNAME: ADMIN, LICENSE_ADMIN_PASSWORD: ADMIN_PASS, LICENSE_SEED_ACCOUNTS: seed, RATE_LIMIT_PER_MINUTE: "5", PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log("[gate-check] backend: FastAPI (jonah-backend)");
  } else {
    server = spawn("node", [path.join(ROOT, "license-server", "server.cjs")], {
      env: { ...process.env, PORT: String(serverPort), DATA_DIR: path.join(tmp, "server"), ADMIN_USERNAME: ADMIN, ADMIN_PASSWORD: ADMIN_PASS, SEED_ACCOUNTS: seed, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log("[gate-check] backend: Node licence server");
  }
  let serverLog = "";
  server.stdout.on("data", (d) => { serverLog += d; }); server.stderr.on("data", (d) => { serverLog += d; });
  const up = await until(async () => { try { return (await fetch(base + "/health")).ok; } catch { return false; } }, 20000);
  if (!up) { console.log("FAIL  the licence server did not start:\n" + serverLog); server.kill(); return process.exit(1); }
  const keys = (await (await fetch(base + "/v1/public-keys")).json()).keys.map((k) => ({ kid: k.kid, spki: k.spki }));

  const dirA = path.join(tmp, "macA"), dirC = path.join(tmp, "macC"), dirD = path.join(tmp, "macD"), dirE = path.join(tmp, "macE");
  const baseEnv = { ...process.env, ELECTRON_RUN_AS_NODE: undefined, JONAH_REQUIRE_LICENSE: "1", JONAH_LICENSE_URL: base, JONAH_LICENSE_KEYS: JSON.stringify(keys), JONAH_LICENSE_HEARTBEAT_MS: "1000", LG_BASE: base };
  delete baseEnv.ELECTRON_RUN_AS_NODE;

  const scenarios = [
    ["main", dirA, []],
    ["notice", dirA, ["--license-notice=access_expired"]],
    ["off", dirA, []],
    ["session", dirA, ["--license-notice=session_ended"]],
    ["junk", dirA, ["--license-notice=<b>hello</b>"]],
    ["device", dirC, []],
    ["offline", dirD, [], { JONAH_LICENSE_URL: "http://127.0.0.1:9" }],
    ["unconfigured", dirD, [], { JONAH_LICENSE_URL: "", JONAH_LICENSE_KEYS: "[]" }],
    ["unlimited", dirE, [], { JONAH_REQUIRE_LICENSE: "" }],
  ];

  let bad = 0;
  const only = (process.argv.find((x) => x.startsWith("--only=")) || "").slice(7);
  for (const [name, dir, extraArgs, extraEnv] of scenarios) {
    if (only && only !== name) continue;
    // "session" and "junk" only look at the sign-in screen; skip the login-only scenarios' heavy boot by letting them run the same way
    const child = spawn(electronPath, [`--user-data-dir=${dir}`, path.join(__dirname, "license-gate-check.cjs"), `--scenario=${name}`, ...extraArgs], { env: { ...baseEnv, ...(extraEnv || {}) }, stdio: ["ignore", "pipe", "pipe"], cwd: ROOT });
    let out = "";
    child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", () => {});
    const code = await new Promise((resolve) => { const t = setTimeout(() => { child.kill(); resolve(-99); }, 180000); child.on("exit", (c) => { clearTimeout(t); resolve(c); }); });
    for (const line of out.split(/\r?\n/)) if (/^(PASS|FAIL|RESULT)/.test(line)) console.log(line);
    if (code !== 0) { bad++; console.log(`FAIL  scenario "${name}" exited with ${code}`); if (code === -99 || !/RESULT/.test(out)) console.log(out.split(/\r?\n/).slice(-15).join("\n")); }
    await sleep(1500); // let the ports free up
  }

  server.kill();
  console.log(bad === 0 ? "\nALL SCENARIOS PASSED" : `\n${bad} SCENARIO(S) FAILED`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(bad === 0 ? 0 : 1);
}

if (IS_ELECTRON) {
  require("electron").app.whenReady().then(() => runner().catch((e) => { console.error("RUNNER ERROR", e); require("electron").app.exit(2); }));
} else {
  driver().catch((e) => { console.error(e); process.exit(2); });
}
