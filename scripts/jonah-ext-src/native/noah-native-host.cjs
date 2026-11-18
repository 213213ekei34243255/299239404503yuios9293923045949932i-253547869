// noah-native-host.cjs - Jonah's computer agent. Runs Electron Jonah's Noah mission code (Noah/autonomy, Noah/desktop - UNCHANGED, copied
// next to this file) in Node, outside the browser, because it must do what a browser page cannot: operate the apps on this computer through
// Windows UI Automation (desktop/host.ps1 + NoahDesktop.cs), read and change files, and run commands - exactly as in Electron Jonah.
//
// Jonah starts it through Chromium's native messaging (chrome.runtime.connectNative("com.cogniai.jonah.noah")); it lives only while
// Noah's panel holds that connection, and exits the moment the connection closes (that is also an emergency stop).
// Messages: 4-byte little-endian length + UTF-8 JSON, both ways. stdout is ONLY that channel; logging goes to data/noah-native.log.
//
// What stays in the browser: the Jonah account. Noah's model (noahai.live) is reached from here, but every request is SIGNED by the
// browser (its device key never leaves it): this process asks, Jonah answers with the signed headers.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

const HERE = __dirname;
const APP = path.join(HERE, "app"); // Electron Jonah's files, unchanged (make_noah_native.py)
const NOAH = path.join(APP, "Noah");
const DATA = path.join(HERE, "data");
fs.mkdirSync(DATA, { recursive: true });

// ---------------------------------------------------------------- logging (never to stdout)
const LOG = path.join(DATA, "noah-native.log");
try { if (fs.statSync(LOG).size > 2_000_000) fs.renameSync(LOG, LOG + ".old"); } catch (_) { /* first run */ }
function logLine(...a) {
  const text = a.map((x) => (typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch (_) { return String(x); } })())).join(" ");
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${text}\n`); } catch (_) { /* disk full */ }
}
console.log = console.info = console.warn = console.error = console.debug = (...a) => logLine(...a);
const log = (...a) => logLine("[noah]", ...a);
process.on("uncaughtException", (e) => logLine("uncaught:", e && e.stack || e));
process.on("unhandledRejection", (e) => logLine("unhandled rejection:", e && e.stack || e));

// ---------------------------------------------------------------- native messaging
const writeOut = process.stdout.write.bind(process.stdout);
// stdout belongs to native messaging alone: anything else that writes there (console.dir, console.table, a library's own print -
// Electron's Rexy/llm.cjs prints every server reply with console.dir) goes to the log instead of corrupting the channel
process.stdout.write = (chunk, encoding, cb) => {
  logLine(typeof chunk === "string" ? chunk.replace(/\s+$/, "") : Buffer.isBuffer(chunk) ? chunk.toString("utf8").replace(/\s+$/, "") : String(chunk));
  if (typeof encoding === "function") encoding(); else if (typeof cb === "function") cb();
  return true;
};
const MAX_OUT = 900_000; // Chromium accepts at most 1 MB per message from a native host
function shrink(v, depth = 0) {
  if (typeof v === "string") return v.length > 20_000 ? v.slice(0, 20_000) + "…" : v;
  if (!v || typeof v !== "object" || depth > 6) return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => shrink(x, depth + 1));
  const o = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === "string" && (/^data:image\//.test(x) || /base64|png|jpeg|image/i.test(k)) && x.length > 2000) continue; // pictures stay here
    o[k] = shrink(x, depth + 1);
  }
  return o;
}
function send(msg) {
  let body = Buffer.from(JSON.stringify(msg), "utf8");
  if (body.length > MAX_OUT) body = Buffer.from(JSON.stringify(shrink(msg)), "utf8");
  if (body.length > MAX_OUT) { logLine("message too large, dropped:", msg.t, msg.evt && msg.evt.event); return; }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  writeOut(Buffer.concat([head, body]));
}
let inBuf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const n = inBuf.readUInt32LE(0);
    if (inBuf.length < 4 + n) break;
    const raw = inBuf.subarray(4, 4 + n).toString("utf8");
    inBuf = inBuf.subarray(4 + n);
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { logLine("bad message from Jonah"); continue; }
    Promise.resolve().then(() => onMessage(msg)).catch((e) => logLine("message failed:", e && e.stack || e));
  }
});
// Jonah closed the connection (panel closed, browser closed, or Noah's emergency stop): stop everything NOW.
process.stdin.on("end", () => shutdown("connection closed"));
process.stdin.on("error", () => shutdown("connection error"));

// ---------------------------------------------------------------- the Jonah account (lives in the browser)
const account = { signedIn: false, accountId: null, baseURL: null };
let rpcSeq = 0;
const rpcWaiting = new Map();
function askJonah(t, payload, timeoutMs = 20_000) {
  const reqId = ++rpcSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { rpcWaiting.delete(reqId); reject(new Error(`Jonah did not answer (${t})`)); }, timeoutMs);
    rpcWaiting.set(reqId, { resolve, reject, timer });
    send(Object.assign({ t, reqId }, payload));
  });
}

// ---------------------------------------------------------------- reading text in screenshots (OCR)
// Electron's Noah/perception/ocr.cjs runs tesseract.js, an npm package that also downloads its language data on first use. Here the
// same function - recognizeText(imageBuffer) -> [{ text, confidence, rect, words: [{ text, rect }] }] in the image's own pixels - is
// answered by Windows' built-in OCR engine (noah-ocr.ps1: Windows.Media.Ocr, offline, nothing downloaded). Every caller in Noah's code
// (desktop/tools.cjs) gets this module instead of the tesseract one; nothing else changes.
const windowsOcr = (() => {
  let child = null, starting = null, queue = Promise.resolve(), buf = "", waiter = null;
  const tmpDir = path.join(DATA, "ocr-tmp");
  function start() {
    if (child) return Promise.resolve();
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      const c = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "noah-ocr.ps1")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      c.stdout.setEncoding("utf8");
      const timer = setTimeout(() => { try { c.kill(); } catch (_) {} reject(new Error("OCR helper did not start")); }, 30_000);
      c.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let m; try { m = JSON.parse(line); } catch (_) { continue; }
          if (m.ready !== undefined) { clearTimeout(timer); if (m.ready) { child = c; log("OCR ready (Windows OCR, " + m.language + ")"); resolve(); } else reject(new Error(m.error || "no OCR")); continue; }
          if (waiter) { const w = waiter; waiter = null; w(m); }
        }
      });
      c.stderr.on("data", (d) => logLine("ocr:", String(d).slice(0, 300)));
      c.on("exit", () => { if (child === c) child = null; clearTimeout(timer); if (waiter) { const w = waiter; waiter = null; w({ ok: false }); } reject(new Error("OCR helper stopped")); });
    }).finally(() => { starting = null; });
    return starting;
  }
  async function recognizeOnce(imageBuffer) {
    await start();
    fs.mkdirSync(tmpDir, { recursive: true });
    const file = path.join(tmpDir, `shot-${process.pid}-${Date.now()}.png`);
    fs.writeFileSync(file, imageBuffer);
    try {
      const res = await new Promise((resolve) => {
        const t = setTimeout(() => { waiter = null; resolve({ ok: false }); }, 30_000);
        waiter = (m) => { clearTimeout(t); resolve(m); };
        child.stdin.write(file + "\n");
      });
      if (!res || !res.ok) return [];
      // Windows' engine gives no per-line confidence; what it returns has already passed its own threshold
      return (res.lines || []).map((l) => ({ text: String(l.text || "").replace(/\s+/g, " ").trim(), confidence: 90, rect: l.rect, words: (l.words || []).map((w) => ({ text: w.text, confidence: 90, rect: w.rect })) }))
        .filter((l) => l.text && l.rect && l.rect.width > 0 && l.rect.height > 0);
    } finally {
      fs.unlink(file, () => {});
    }
  }
  return {
    MIN_LINE_CONFIDENCE: 45,
    /** Never throws (as in Electron): any failure is "no text found". One image at a time. */
    recognizeText(imageBuffer) {
      const run = queue.then(() => recognizeOnce(imageBuffer)).catch((e) => { log("OCR failed:", e && e.message); return []; });
      queue = run.catch(() => []);
      return run;
    },
    async shutdown() { const c = child; child = null; if (c) try { c.stdin.end(); c.kill(); } catch (_) {} },
  };
})();
{
  const Module = require("module");
  const ocrPath = path.join(NOAH, "perception", "ocr.cjs");
  const m = new Module(ocrPath, module);
  m.filename = ocrPath; m.loaded = true; m.exports = windowsOcr;
  require.cache[ocrPath] = m;
}

// ---------------------------------------------------------------- Noah (Electron Jonah's code, unchanged)
const R = (p) => require(path.join(NOAH, p));
const { ConfigStore } = R("config.cjs");
const { EventBus } = R("events.cjs");
const { AgentSession } = R("agent/session.cjs");
const { AuditLog } = R("safety/audit.cjs");
const { SafetyController } = R("safety/safety-controller.cjs");
const { ModelRouter } = R("models/router.cjs");
const { NoahaiProvider } = R("models/noahai.cjs");
const { MissionService } = R("autonomy/service.cjs");
const { CommandRouter } = R("agent/command-router.cjs");
const { attachDesktopGuard } = R("desktop/guard.cjs");
const { createExperience } = R("experience/index.cjs");

// no secrets are kept here: no OS keychain stand-in, and none of Jonah's environment
const config = new ConfigStore({ dir: DATA, appRoot: null, env: {}, safeStorage: { isEncryptionAvailable: () => false } });
const bus = new EventBus();
const session = new AgentSession({ bus });
const audit = new AuditLog({ dir: path.join(DATA, "audit"), enabled: config.get().auditEnabled !== false });
const safety = new SafetyController({ bus, getPolicy: () => config.get().policy, audit, getCookieValues: async () => [] });
const core = { bus, session, audit, safety, config };

const providers = {
  noahai: new NoahaiProvider({
    name: "noahai",
    baseURL: config.getBaseURL("noahai"),
    getKey: () => null,
    isSignedIn: () => account.signedIn,
    // every request to noahai.live is signed by Jonah's device key, in the browser
    getAuthHeaders: (method, p, raw) => askJonah("sign", { method, path: p, body: raw }).then((r) => r.headers || {}),
    options: config.get().providers.noahai,
  }),
};
const router = new ModelRouter({ config, bus, providers, log });
const experience = createExperience({ dir: path.join(DATA, "experience"), bus, getAccountId: () => (account.signedIn ? account.accountId : null), isEnabled: () => config.get().learn !== false });

// The folders a COMPUTER task may use the shell and file tools in: Desktop, Documents, Downloads, as Windows names them (OneDrive-aware).
let userFolders = [];
try {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('MyDocuments'); try { (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path } catch { Join-Path $env:USERPROFILE 'Downloads' }"],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  userFolders = String(r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && fs.existsSync(s));
} catch (e) { log("could not read the user folders:", e.message); }
if (!userFolders.length) userFolders = ["Desktop", "Documents", "Downloads"].map((n) => path.join(os.homedir(), n)).filter((p) => fs.existsSync(p));

// A project task works only inside a folder the user picks, every time (Electron: dialog.showOpenDialog).
function pickFolder() {
  return new Promise((resolve) => {
    const ps = [
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
      "Add-Type -AssemblyName System.Windows.Forms",
      "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Width = 1; Height = 1; StartPosition = 'CenterScreen' }",
      "$owner.Show(); $owner.Activate()",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$d.Description = 'Choose the folder Noah may work in. Noah will read and change files only inside this folder, and run commands there.'",
      "$d.ShowNewFolderButton = $true",
      "if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
      "$owner.Close()",
    ].join("; ");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", ps], { windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => resolve(null));
    child.on("exit", () => { const p = out.trim(); resolve(p && fs.existsSync(p) ? p : null); });
  });
}

const modelAccess = {
  isSignedIn: () => account.signedIn,
  // the one-time Google sign-in for the Jonah account opens in the browser
  signIn: () => askJonah("signin", {}, 10 * 60_000).then((r) => !!(r && r.signedIn)).catch(() => false),
};

// ---------------------------------------------------------------- administrator access (optional, OFF by default)
// Electron Jonah restarted the WHOLE app as administrator (Noah/desktop/admin.cjs). Here only Noah's Windows helper is elevated
// (noah-elevated-host.ps1, after Windows' own permission prompt): it can then see and operate programs that run as administrator,
// while the browser and web pages keep running normally. The switch lives in Noah's panel; Jonah remembers it and tells this process.
const { DesktopBridge, hostEnv } = R("desktop/bridge.cjs");
const elevation = { enabled: false, active: false, declined: false };
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
function elevatedSpawn() {
  const net = require("net"), crypto = require("crypto"), { PassThrough } = require("stream"), { EventEmitter } = require("events");
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = undefined; // an elevated process cannot be killed from here: closing the pipe is what stops it (it exits at once)
  let sock = null, fallback = null, exited = false;
  const name = "jonah-noah-" + crypto.randomBytes(12).toString("hex");
  const token = crypto.randomBytes(24).toString("hex");
  const exit = (code) => { if (exited) return; exited = true; elevation.active = false; try { server.close(); } catch (_) {} child.emit("exit", code); sendAdminState(); };
  child.kill = () => { log("administrator helper: closing its pipe (it exits at once)"); try { if (sock) sock.destroy(); } catch (_) {} try { if (fallback) fallback.kill(); } catch (_) {} exit(null); };
  const server = net.createServer((s) => {
    if (sock) { s.destroy(); return; }
    sock = s; server.close();
    s.write(token + "\n");
    child.stdin.pipe(s); s.pipe(child.stdout);
    s.on("error", () => {});
    s.on("close", () => exit(0));
    elevation.active = true; elevation.declined = false; sendAdminState();
  });
  server.on("error", (e) => { log("elevated helper pipe:", e.message); child.emit("error", e); });
  server.listen("\\\\.\\pipe\\" + name, () => {
    const script = path.join(HERE, "noah-elevated-host.ps1"), hostDir = path.join(NOAH, "desktop");
    // (NOAH_TEST_NO_RUNAS=1: tests only - the same helper and pipe, started without Windows' prompt and without elevation)
    const runAs = process.env.NOAH_TEST_NO_RUNAS === "1" ? "" : "-Verb RunAs ";
    const ps = `try { Start-Process -FilePath 'powershell.exe' ${runAs}-WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',${psq('"' + script + '"')},'-Pipe',${psq(name)},'-Token',${psq(token)},'-HostDir',${psq('"' + hostDir + '"')}) -ErrorAction Stop; exit 0 } catch { exit 1 }`;
    const launcher = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], { windowsHide: true, stdio: "ignore" });
    launcher.on("exit", (code) => {
      if (code === 0) return; // Windows said yes: the elevated helper connects to the pipe
      // the user said no at Windows' prompt (or it could not start): carry on normally, as Electron Jonah did
      log("administrator access declined: the computer helper runs normally");
      elevation.declined = true;
      try { server.close(); } catch (_) {}
      fallback = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(NOAH, "desktop", "host.ps1")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: hostEnv(process.env, "win32") });
      child.pid = fallback.pid;
      child.stdin.pipe(fallback.stdin); fallback.stdout.pipe(child.stdout); fallback.stderr.pipe(child.stderr);
      fallback.on("exit", (c) => exit(c));
      fallback.on("error", (e) => child.emit("error", e));
      sendAdminState();
    });
  });
  return child;
}
const makeBridge = () => new DesktopBridge({ log, spawnImpl: elevation.enabled ? elevatedSpawn : spawn });
function adminState() {
  return {
    supported: true, enabled: elevation.enabled, elevated: elevation.active, declinedAtStart: elevation.declined,
    note: elevation.enabled && !elevation.active && !elevation.declined ? "Windows will ask for permission when Noah next works on your computer." : !elevation.enabled ? "" : undefined,
  };
}
function sendAdminState() { send({ t: "admin-state", state: adminState() }); }
function setAdmin(enabled) {
  enabled = enabled === true;
  if (enabled === elevation.enabled) return;
  elevation.enabled = enabled;
  elevation.declined = false;
  // the next computer task starts the helper the new way; a task that is running keeps its helper until it ends
  if (!missions.isRunning() && missions._bridge) { try { missions._bridge.dispose(); } catch (_) {} missions._bridge = null; }
  else if (missions.isRunning()) pendingBridgeReset = true;
  sendAdminState();
}
let pendingBridgeReset = false;

const missions = new MissionService({
  router, core, dataDir: DATA, pickFolder, getMode: () => config.get().policy.mode, log, modelAccess, experience,
  desktopFolders: () => userFolders, makeBridge,
});
bus.subscribe((e) => {
  if (pendingBridgeReset && e && (e.event === "mission_finished" || e.event === "mission_result") && !missions.isRunning()) {
    pendingBridgeReset = false;
    if (missions._bridge) { try { missions._bridge.dispose(); } catch (_) {} missions._bridge = null; }
  }
});

// What Jonah's panel routes here: computer tasks and project tasks. Web tasks run in the browser (Noah's web agent there), never here.
const WEB_TASK = "WEB_TASK";
const webAgentStub = {
  submit: () => { throw Object.assign(new Error("web tasks run in Jonah's browser"), { code: WEB_TASK }); },
  stop: () => ({ ok: false }), pause: () => ({ ok: false }), resume: () => ({ ok: false }), isAvailable: () => false,
};
const commandRouter = new CommandRouter({ session, agent: webAgentStub, missions, log, experience });

// ---------------------------------------------------------------- the Stop bar + Ctrl+Alt+X (Electron: an always-on-top BrowserWindow + globalShortcut)
const guard = createWindowsGuard({ onStop: () => { try { if (missions.isRunning()) missions.stop(); } finally { guard.hide(); } sendState(); } });
const detachGuard = attachDesktopGuard({
  guard, bus, mainWindow: null, log,
  notify: ({ title, body }) => send({ t: "notify", title, body }),
  focusWindow: (hwnd) => missions.desktopBridge().focus(hwnd),
});

// While Noah waits for the user's OK on a computer task, the bar says so and offers "Review" (brings Jonah, with the card, to the front).
bus.subscribe((e) => {
  if (!e || !guard.isArmed()) return;
  if (e.event === "confirm_request") guard.ask("Noah needs your OK in Jonah");
  else if (e.event === "confirm_resolved") guard.unask();
});

function createWindowsGuard({ onStop }) {
  const SHORTCUT = "Ctrl+Alt+X";
  let child = null, armed = false, showing = false, hotkey = false;
  // one plain line: no line breaks, no invisible characters (window titles carry zero-width spaces), UTF-8 (the bar reads UTF-8)
  // control characters and invisible ones (zero-width spaces, direction marks...) as character codes: no invisible characters in this file
  const INVISIBLE = new RegExp("[" + [[0, 31], [127, 127], [0x200b, 0x200f], [0x2028, 0x202f], [0x2060, 0x206f], [0xfeff, 0xfeff]].map(([a, b]) => String.fromCharCode(a) + "-" + String.fromCharCode(b)).join("") + "]+", "g");
  const clean = (s) => String(s || "").replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  const write = (line) => { try { if (child) child.stdin.write(Buffer.from(clean(line) + "\n", "utf8")); } catch (_) { /* gone */ } };
  function ensure() {
    if (child) return;
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "noah-stop-bar.ps1")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line === "stop") onStop();
        else if (line === "review") send({ t: "focus" });
        else if (line.startsWith("hotkey ")) hotkey = line === "hotkey ok";
      }
    });
    child.stderr.on("data", (d) => logLine("stop bar:", String(d).slice(0, 300)));
    const mine = child;
    child.on("exit", () => { if (child === mine) { child = null; showing = false; hotkey = false; } });
  }
  return {
    SHORTCUT,
    isShowing: () => showing,
    isArmed: () => armed,
    shortcutActive: () => hotkey,
    arm() { armed = true; ensure(); write("arm"); },
    show(text = "Noah is using your computer") { if (!armed) this.arm(); ensure(); showing = true; write("show " + String(text).slice(0, 60)); },
    setText(text) { if (child) write("text " + clean(text).slice(0, 70)); },
    ask(text) { if (!armed) return; ensure(); showing = true; write("ask " + clean(text).slice(0, 70)); },
    unask() { if (child) write("unask"); },
    hideBar() { showing = false; write("hide"); },
    hide() { showing = false; armed = false; hotkey = false; write("quit"); const c = child; child = null; if (c) setTimeout(() => { try { c.kill(); } catch (_) { /* gone */ } }, 1500); },
    // Noah's process is ending: the bar must not outlive it (it would keep Ctrl+Alt+X taken)
    dispose() { const c = child; this.hide(); if (c) { try { c.kill(); } catch (_) { /* gone */ } try { spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch (_) { /* gone */ } } },
  };
}

// ---------------------------------------------------------------- the chat's files, the chat's answers, speech recognition
// Electron Jonah's own modules, unchanged (in app\): attachments.cjs + file-extract.cjs (PDF, Word, Excel, PowerPoint, OpenDocument,
// RTF, text, images by tesseract OCR), Rexy/llm.cjs + chat-complete.cjs + grounding.cjs (the chat's answers from noahai.live, with a web
// search when the question needs fresh facts) and search-proxy.cjs. Loaded on first use, so a computer task does not pay for them.
let attachmentStore = null, chatLLM = null;
/** a web search done by Jonah (js/jonah-google-search.js: Google's results page in the user's own Jonah, Electron's rules) */
function viaJonahSearch(query) {
  return askJonah("websearch", { query: String(query || "").slice(0, 300) }, 45_000).then((r) => {
    if (r && r.error) throw Object.assign(new Error(r.error), { code: r.code || "error" });
    return { items: (r && r.items) || [] };
  });
}

// ---- the Trust Engine (Electron Jonah's Trust/controller.cjs + service.cjs + engine.cjs, unchanged): scores a site 0-100 from Reddit,
// web search, the domain's identity, (deep scan) its certificate, and the noahai.live model's overall read. Two things are Jonah's:
//   * identity: Electron sent a RANDOM fake browser identity (Chrome on Windows/Mac/iPhone/Linux) to Reddit; Jonah says who it is
//   * searches go through Jonah's Google reader with a budget per check (5 automatic, 12 for a deep scan): the check runs on every
//     new site, and ten Google searches a page would soon bring Google's robot check. A search over budget counts as "not checked"
//     (Electron's engine treats a failed source as unknown evidence - it lowers confidence, never the score).
// The owner's jonahbrowser.store server (search API + news), with the key Electron Jonah ships in its .env (JONAH_PROXY_KEY): copied by
// make_noah_native.py into app\.env, read by Electron's own search-proxy.cjs readSetting() - never given to a web page.
const proxyKey = () => { try { return require(path.join(APP, "search-proxy.cjs")).readSetting("JONAH_PROXY_KEY", APP); } catch (_) { return ""; } };
async function proxySearch(query) {
  const sp = require(path.join(APP, "search-proxy.cjs"));
  const base = (sp.readSetting("JONAH_SEARCH_PROXY", APP) || "https://www.jonahbrowser.store").replace(/\/+$/, "");
  const r = await fetch(`${base}/search/web?q=${encodeURIComponent(String(query || "").slice(0, 300))}`, { headers: { "X-Jonah-Key": proxyKey() }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`search server answered HTTP ${r.status}`);
  const data = await r.json();
  return ((data && data.items) || []).map((it) => ({ title: it.title || "", snippet: it.snippet || "", link: it.link || "" }));
}
const { AsyncLocalStorage } = require("async_hooks");
const trustBudget = new AsyncLocalStorage();
const JONAH_UA = "JonahBrowser/1.5.5 (Trust Engine; +https://www.jonahbrowser.store)";
let trustController = null;
function trust() {
  if (!trustController) {
    const { createTrustController, loadIdentity } = require(path.join(APP, "Trust", "controller.cjs"));
    const { TrustService } = require(path.join(APP, "Trust", "service.cjs"));
    const service = new TrustService({
      ...loadIdentity(DATA),
      randomUA: () => JONAH_UA,
      log: (...a) => log("[trust]", ...a),
      secureFetch: (url, opts) => fetch(url, opts), // (Electron used Chromium's net stack here; Node checks certificates with its own trust store)
      search: async (query) => {
        // with the owner's jonahbrowser.store key (app\.env, from Electron Jonah's own package): its Google search API first - an
        // official API, no robot check; Google's results page only if that fails
        if (proxyKey()) {
          try { return await proxySearch(query); } catch (e) { log("[trust] search server:", e.message, "- trying Google's page"); }
        }
        const budget = trustBudget.getStore();
        if (budget) {
          if (budget.left <= 0) throw Object.assign(new Error("search limit for this check reached"), { transient: false });
          budget.left -= 1;
        }
        const { items } = await viaJonahSearch(query);
        return items.map((it) => ({ title: it.title || "", snippet: it.snippet || "", link: it.link || "" }));
      },
    });
    trustController = createTrustController({ service });
  }
  return trustController;
}
function attachments() {
  if (!attachmentStore) {
    const fx = require(path.join(APP, "file-extract.cjs"));
    // tesseract's English data: copied from Electron Jonah's own cache (no download)
    fx.configureOcr({ cachePath: path.join(DATA, "tesseract-cache") });
    const { AttachmentStore } = require(path.join(APP, "attachments.cjs"));
    attachmentStore = new AttachmentStore();
  }
  return attachmentStore;
}
function llm() {
  if (!chatLLM) {
    // the web search the chat uses: Google's results page, read in the user's own Jonah (the browser does it: see jonah-search in
    // noah-computer.js) with Electron's rules - one at a time, never solving Google's "not a robot" check, pausing when it shows
    const viaJonah = viaJonahSearch;
    const sp = require(path.join(APP, "search-proxy.cjs"));
    sp.setWebSearchBackend(viaJonah);
    // Electron's order is: a search API key (Serper / Brave) -> Google's results page -> the Jonah search proxy (JONAH_PROXY_KEY). With
    // no key configured at all (as here), the proxy can only fail, and its "key missing" then hid the real reason (e.g. Google's robot
    // check). So without keys the chat's search is Google's page alone, and its own reason is what the user is told.
    const keyed = ["SERPER_API_KEY", "BRAVE_SEARCH_API_KEY", "JONAH_PROXY_KEY"].some((k) => process.env[k]) || !!proxyKey();
    if (!keyed) {
      const original = sp.fetchSearch;
      sp.fetchSearch = async (kind, query, opts = {}) => {
        if (kind !== "web" || !String(query || "").trim()) return original(kind, query, opts);
        try {
          const { items } = await viaJonah(query);
          return { status: 200, body: { kind: "customsearch#search", items, jonah: { source: "google-results-page" } } };
        } catch (err) {
          return { status: 503, body: { error: { message: (err && err.message) || "Google search failed" } } };
        }
      };
    }
    // Electron's describeSearchFailure() has no words for Google's robot check or cookie page: add them (else it says "not responding")
    const g = require(path.join(APP, "Rexy", "grounding.cjs"));
    const describe = g.describeSearchFailure;
    g.describeSearchFailure = (results) => {
      const msg = String((results && results.body && results.body.error && results.body.error.message) || (results && results.message) || "");
      if (/not a robot|captcha/i.test(msg)) return "Google is asking to confirm you're not a robot: open google.com in a Jonah tab and complete the check once";
      if (/cookie-consent|consent page/i.test(msg)) return "Google's cookie page needs a choice once: open google.com in a Jonah tab and choose an option";
      return describe(results);
    };
    const LLMClient = require(path.join(APP, "Rexy", "llm.cjs"));
    chatLLM = new LLMClient({});
  }
  return chatLLM;
}
let lastChatQuestion = "";
/** Electron's Rexy runtime _chatReply(), the same steps: attachments or the open page as material, "search it" follow-ups, long replies completed. */
async function chatReply({ goal, attachmentIds, pageContent, pageNote, sessionId }) {
  const { isBareSearchFollowUp, needsGrounding } = require(path.join(APP, "Rexy", "grounding.cjs"));
  const files = attachmentIds && attachmentIds.length && attachmentStore ? attachmentStore.buildContext(attachmentIds, String(goal)) : null;
  let message = String(goal || "");
  if (!files && isBareSearchFollowUp(goal) && lastChatQuestion) message = lastChatQuestion;
  else if (!files && (needsGrounding(goal) || /\?\s*$/.test(message.trim()))) lastChatQuestion = message.trim().slice(0, 300);
  if (!files && pageContent && pageNote) message = `${goal}\n\n${pageNote}`;
  const client = llm();
  const done = await require(path.join(APP, "Rexy", "chat-complete.cjs")).completeChat({
    message,
    log: (m) => log("[chat]", m),
    ask: (m) => client.chat({ message: m, sessionId: sessionId || undefined, ...(files ? { pageContent: files.text } : pageContent ? { pageContent } : {}) }),
  });
  return {
    text: done.text || "I don't have an answer for that right now. Could you rephrase it, or ask me to open a page or search for something specific?",
    attachmentUse: files ? files.files : undefined,
  };
}

// Speech recognition (Electron's voice: Moonshine-base through transformers.js; here the Node build with the ONNX runtime, and the
// model copied from Electron Jonah's cache into app\models - no download, nothing leaves the computer).
let sttPromise = null;
function stt() {
  if (!sttPromise) {
    sttPromise = (async () => {
      const { pipeline, env } = await import(require("url").pathToFileURL(path.join(APP, "node_modules", "@huggingface", "transformers", "dist", "transformers.node.mjs")).href);
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = path.join(APP, "models") + path.sep;
      const t0 = Date.now();
      const p = await pipeline("automatic-speech-recognition", "onnx-community/moonshine-base-ONNX", { dtype: "q8", device: "cpu" });
      log(`speech recognition ready in ${Date.now() - t0} ms`);
      return p;
    })().catch((e) => { sttPromise = null; throw e; });
  }
  return sttPromise;
}
async function transcribe(pcm16b64) {
  const buf = Buffer.from(String(pcm16b64 || ""), "base64");
  const n = Math.floor(buf.length / 2);
  const audio = new Float32Array(n);
  for (let i = 0; i < n; i++) audio[i] = buf.readInt16LE(i * 2) / 32768;
  if (!n) return { text: "" };
  const p = await stt();
  const r = await p(audio);
  return { text: String((r && r.text) || "").trim() };
}

// ---------------------------------------------------------------- talking to Jonah
function snapshot() {
  const safe = (f, d) => { try { return f(); } catch (_) { return d; } };
  return {
    running: safe(() => missions.isRunning(), false),
    canResume: safe(() => missions.canResume(), false),
    awaiting: safe(() => missions.awaitingAnswer(), false),
    available: safe(() => missions.isAvailable(), false),
    desktopAvailable: safe(() => missions.isDesktopAvailable(), false),
    desktop: missions.desktop,
    signedIn: account.signedIn,
  };
}
let lastState = "";
function sendState() {
  const s = snapshot();
  const k = JSON.stringify(s);
  if (k === lastState) return;
  lastState = k;
  send({ t: "state", state: s });
}
bus.subscribe((evt) => {
  if (!evt) return;
  send({ t: "event", evt });
  sendState();
});

const CALLS = {
  // { handled: false } = not a computer or project task: Jonah's browser gives it to the web agent or to chat
  route: (a) => {
    try { return commandRouter.route(String(a.text || ""), { source: a.source || "text", mode: a.mode || "computer" }); }
    catch (e) { if (e && e.code === WEB_TASK) return { handled: false, kind: "web" }; throw e; }
  },
  stop: () => missions.stop(),
  pause: () => missions.pause(),
  resume: (a) => missions.resume({ source: (a && a.source) || "text" }),
  answer: (a) => missions.answer(String(a.text || ""), { source: a.source || "text" }),
  requestModelAccess: () => (typeof missions.requestModelAccess === "function" ? missions.requestModelAccess() : { reply: "" }),
  state: () => snapshot(),
  // read-only check of the Windows helper (host.ps1 + NoahDesktop.cs): it starts, answers, and can list the open windows. Moves nothing.
  selftest: async () => {
    const b = missions.desktopBridge();
    const t0 = Date.now();
    await b.ping({ timeoutMs: 60_000 });
    const wins = await b.windows({}, { timeoutMs: 20_000 });
    return {
      ok: true, startMs: Date.now() - t0, windows: Array.isArray(wins) ? wins.length : null, folders: userFolders.length,
      viaPipe: elevation.active, // the helper started the administrator way (named pipe), not as a plain child process
      ocrInjected: require(path.join(NOAH, "perception", "ocr.cjs")) === windowsOcr, // Noah's own require() gets Windows OCR
    };
  },
  // read the text in a picture (PNG/JPEG as base64) with the same OCR Noah's computer tasks use
  ocr: async (a) => windowsOcr.recognizeText(Buffer.from(String(a.image || ""), "base64")),
  admin: () => adminState(),
  // chat attachments (Electron: attach:add / attach:remove / attach:clear)
  attach: (a) => attachments().add({ name: String(a.name || "file"), data: Buffer.from(String(a.data || ""), "base64") }),
  attachRemove: (a) => (attachmentStore ? attachmentStore.remove(String(a.id || "")) : false),
  attachClear: () => { if (attachmentStore) attachmentStore.clear(); return true; },
  referencesAttachment: (a) => require(path.join(APP, "attachments.cjs")).referencesAttachment(String(a.goal || "")),
  // a chat answer (Electron: Rexy runtime _chatReply), with attachments, the open page, or a web search when needed
  chat: (a) => chatReply(a || {}),
  // the start page's Trending News (Electron main 'get-news': search-proxy.cjs fetchNews, India's top headlines, 12 a page)
  news: async (a) => {
    const { status, body } = await require(path.join(APP, "search-proxy.cjs")).fetchNews({ country: "in", page: (a && a.page) || 1, pageSize: 12 }, { root: APP, log: (...x) => log("[news]", ...x) });
    return status === 200 ? body : { error: (body && body.error && body.error.message) || `news server answered ${status}` };
  },
  // the Trust Engine (Electron: ipc "trust:check" host, { deepScan, force }) -> { ok, result, cached } | { ok: false, skipped | error }
  trustCheck: (a) => trustBudget.run({ left: a && a.deepScan ? 12 : 5 }, () =>
    trust().check(String((a && a.host) || ""), { deepScan: !!(a && a.deepScan), force: !!(a && a.force) })),
  // speech: 16 kHz mono PCM as little-endian int16, base64 -> text
  transcribe: (a) => transcribe(a.pcm),
  sttWarm: () => stt().then(() => true),
  // tests only (NOAH_TEST_HOOKS=1): ask a sample confirmation, exactly as a computer task does, and report the answer
  testconfirm: async () => {
    if (process.env.NOAH_TEST_HOOKS !== "1") throw new Error("not available");
    const t0 = Date.now();
    const allowed = await safety.confirm({ summary: "Send the email to test@example.com", why: "Sending a message is something you approve.", risk: { level: "medium" }, timeoutMs: 60_000 });
    return { allowed, ms: Date.now() - t0 };
  },
};

async function onMessage(m) {
  switch (m.t) {
    case "admin":
      setAdmin(m.enabled === true);
      return;
    case "hello":
    case "account":
      Object.assign(account, { signedIn: !!m.signedIn, accountId: m.accountId || null, baseURL: m.baseURL || null });
      if (typeof m.admin === "boolean") setAdmin(m.admin);
      if (m.config) { try { config.update(m.config); } catch (e) { log("config from Jonah not applied:", e.message); } }
      lastState = ""; sendState();
      return;
    case "config":
      try { config.update(m.patch || {}); } catch (e) { log("config not applied:", e.message); }
      return;
    case "confirm":
      try { safety.resolveConfirmation(String(m.id), m.allow === true); } catch (_) { /* not ours */ }
      return;
    case "call": {
      const f = CALLS[m.method];
      let value, error;
      try { value = f ? await f(m.args || {}) : undefined; if (!f) error = "unknown call " + m.method; } catch (e) { error = e && e.message || String(e); }
      send({ t: "result", id: m.id, value: value === undefined ? null : value, error });
      sendState();
      return;
    }
    case "rpc-reply": {
      const w = rpcWaiting.get(m.reqId);
      if (!w) return;
      rpcWaiting.delete(m.reqId);
      clearTimeout(w.timer);
      if (m.error) w.reject(new Error(m.error)); else w.resolve(m.value || {});
      return;
    }
    default:
      return;
  }
}

let down = false;
function shutdown(why) {
  if (down) return;
  down = true;
  log("shutting down:", why);
  try { if (missions.isRunning()) missions.stop(); } catch (_) { /* gone */ }
  try { detachGuard && detachGuard(); } catch (_) { /* gone */ }
  try { guard.dispose(); } catch (_) { /* gone */ }
  try { missions.dispose(); } catch (_) { /* gone */ }
  try { windowsOcr.shutdown(); } catch (_) { /* gone */ }
  setTimeout(() => process.exit(0), 300);
}

log(`started (node ${process.version}); folders for computer tasks: ${userFolders.join(" | ")}`);
send({ t: "ready", state: snapshot() });
