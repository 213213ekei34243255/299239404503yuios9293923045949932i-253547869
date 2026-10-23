// Noah/desktop/bridge.cjs
//
// Node's side of Noah's eyes and hands on the computer's desktop. It starts one long-lived helper and sends it one JSON request per line. On Windows the helper is
// PowerShell (host.ps1 + NoahDesktop.cs); on a Mac (Intel or Apple silicon) it is osascript running host-mac.js. Both speak the same protocol. It starts on the first call, restarts if it dies, and `stop()` kills it AT ONCE: that is the emergency stop for anything
// the helper is in the middle of (typing, a mouse glide). Nothing here decides what Noah is allowed to do: policy.cjs does, before a request is sent.
//
// The helper is started with a scrubbed environment (none of Jonah's own keys), because it launches the programs the user asks for.

"use strict";

const path = require("path");
const { spawn } = require("child_process");

// A file that ANOTHER program has to open (PowerShell, osascript) cannot be read from inside app.asar: Electron's own code can, nothing else can. The packaged app keeps the
// helper's files next to the archive instead (package.json build.asarUnpack), in app.asar.unpacked, and this points there. Run from source, the path is unchanged.
const realPath = (p) => String(p).replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
const HOST = realPath(path.join(__dirname, "host.ps1"));
const HOST_MAC = realPath(path.join(__dirname, "host-mac.js"));
const START_TIMEOUT_MS = 60_000; // the first start compiles the C# once: slow on a cold machine

class DesktopError extends Error {
  constructor(message, code = "error") {
    super(message);
    this.name = "DesktopError";
    this.code = code;
  }
}

/** Escape everything that is not plain ASCII, so the line survives any console encoding. */
const NON_ASCII = new RegExp("[" + String.fromCharCode(0x7f) + "-" + String.fromCharCode(0xffff) + "]", "g"); // DEL and everything above
const ascii = (s) => s.replace(NON_ASCII, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

// what a Mac app needs and nothing else (no keys, no tokens, no Jonah settings)
const MAC_ENV = new Set(["path", "home", "tmpdir", "user", "logname", "lang", "lc_all", "lc_ctype", "shell", "tz", "__cf_user_text_encoding"]);

/** The environment the helper (and so every program it starts) gets: what the system's apps need, none of Jonah's secrets. */
function hostEnv(source = process.env, platform = process.platform) {
  if (platform === "darwin") {
    const env = {};
    for (const k of Object.keys(source)) if (MAC_ENV.has(k.toLowerCase())) env[k] = source[k];
    return env;
  }
  const keep = new Set(["path", "pathext", "systemroot", "systemdrive", "windir", "comspec", "temp", "tmp", "home", "userprofile", "homedrive", "homepath", "appdata", "localappdata", "programdata", "programfiles", "programfiles(x86)", "programw6432", "commonprogramfiles", "commonprogramfiles(x86)", "commonprogramw6432", "number_of_processors", "os", "processor_architecture", "lang", "username", "userdomain", "computername", "public", "allusersprofile", "psmodulepath", "sessionname"]);
  const env = {};
  for (const k of Object.keys(source)) if (keep.has(k.toLowerCase())) env[k] = source[k];
  return env;
}

class DesktopBridge {
  /**
   * @param {object} [o]
   * @param {typeof spawn} [o.spawnImpl]
   * @param {string} [o.hostPath]
   * @param {(m: string) => void} [o.log]
   */
  constructor({ spawnImpl = spawn, hostPath = null, log = () => {}, platform = process.platform } = {}) {
    Object.assign(this, { spawnImpl, log, platform });
    this.hostPath = hostPath || (platform === "darwin" ? HOST_MAC : HOST);
    this._child = null;
    this._starting = null;
    this._pending = new Map();
    this._seq = 0;
    this._buf = "";
    this._stderr = "";
    this._disposed = false;
  }

  /** Is the helper running right now? */
  get running() {
    return !!this._child;
  }

  async _ensure() {
    if (this._disposed) throw new DesktopError("The desktop helper was shut down.", "disposed");
    if (this._child) return;
    if (this._starting) return this._starting;
    this._starting = this._start().finally(() => { this._starting = null; });
    return this._starting;
  }

  _start() {
    return new Promise((resolve, reject) => {
      if (this.platform !== "win32" && this.platform !== "darwin") return reject(new DesktopError("Controlling the computer is built for Windows and macOS.", "unsupported"));
      const child = this.platform === "darwin"
        ? this.spawnImpl("/usr/bin/osascript", ["-l", "JavaScript", this.hostPath], { stdio: ["pipe", "pipe", "pipe"], env: hostEnv(process.env, "darwin") })
        : this.spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.hostPath], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: hostEnv(process.env, "win32") });
      this._child = child;
      this._buf = "";
      this._stderr = "";
      let ready = false;
      const timer = setTimeout(() => { if (!ready) { this._kill(); reject(new DesktopError(`The desktop helper did not start within ${START_TIMEOUT_MS / 1000} seconds.`, "start_timeout")); } }, START_TIMEOUT_MS);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (this._child !== child) return; // a helper that has been replaced or stopped no longer speaks for us
        this._buf += chunk;
        let i;
        while ((i = this._buf.indexOf("\n")) >= 0) {
          const line = this._buf.slice(0, i).trim();
          this._buf = this._buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch (_) { this.log(`desktop helper said something that is not JSON: ${line.slice(0, 120)}`); continue; }
          if (msg.ready && !ready) { ready = true; clearTimeout(timer); resolve(); continue; }
          const p = this._pending.get(msg.id);
          if (!p) continue;
          this._pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new DesktopError(msg.error || "The desktop helper reported an error.", msg.code || "error"));
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => { if (this._child === child) this._stderr = (this._stderr + d).slice(-4000); });
      // A helper's own exit can arrive AFTER a newer helper has started (stop() kills it, the next call starts another). It must only clear the
      // state that belongs to ITSELF: otherwise it wipes the new helper's reference, the next call crashes, and the new helper is orphaned.
      const ended = (why) => {
        clearTimeout(timer);
        if (this._child === child) this._gone(why);
        if (!ready) { ready = true; reject(new DesktopError(why, "host_exited")); } // whoever was waiting for THIS start must not wait for ever
      };
      child.on("error", (err) => ended(`could not start ${this.platform === "darwin" ? "osascript" : "PowerShell"}: ${err.message}`));
      child.on("exit", (code) => ended(`the desktop helper stopped (exit ${code})${this._stderr ? `: ${this._stderr.trim().split(/\r?\n/)[0].slice(0, 200)}` : ""}`));
    });
  }

  _gone(why) {
    this._child = null;
    const err = new DesktopError(why, "host_exited");
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(err); }
    this._pending.clear();
  }

  _kill() {
    const c = this._child;
    this._child = null;
    if (!c) return;
    try { c.stdin.end(); } catch (_) { /* closed */ }
    try { if (this.platform === "win32" && c.pid) require("child_process").spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); else c.kill("SIGKILL"); } catch (_) { try { c.kill(); } catch (__) { /* gone */ } }
  }

  /**
   * One operation. Rejects with a DesktopError whose `code` says what went wrong (not_foreground, password_field, stale, timeout, ...).
   * @param {string} op
   * @param {object} [args]
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [o]
   */
  async call(op, args = {}, { timeoutMs = 20_000, signal } = {}) {
    if (signal && signal.aborted) throw new DesktopError("stopped", "aborted");
    await this._ensure();
    const id = ++this._seq;
    const body = ascii(JSON.stringify({ id, op, args: { ...args, timeoutMs } }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        this._kill(); // an application that never answers must not freeze Noah: start again next time
        reject(new DesktopError(`The desktop helper did not answer "${op}" within ${Math.round(timeoutMs / 1000)} seconds, so it was restarted.`, "timeout"));
      }, timeoutMs + 4000);
      this._pending.set(id, { resolve, reject, timer });
      const onAbort = () => { if (this._pending.has(id)) { this._pending.delete(id); clearTimeout(timer); this.stop(); reject(new DesktopError("stopped", "aborted")); } };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try { this._child.stdin.write(body + "\n"); } catch (err) { this._pending.delete(id); clearTimeout(timer); reject(new DesktopError(`could not talk to the desktop helper: ${err.message}`, "host_exited")); }
    });
  }

  /** The emergency stop: kill the helper NOW (it starts again, fresh, on the next call). Anything it was typing or moving stops at once. */
  stop() {
    const err = new DesktopError("stopped", "aborted");
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(err); }
    this._pending.clear();
    this._kill();
  }

  dispose() {
    this._disposed = true;
    this.stop();
  }

  // ---- the operations, named
  windows({ all = false } = {}, o) { return this.call("windows", { all }, o); }
  tree(window, { maxDepth = 8, maxNodes = 250 } = {}, o) { return this.call("tree", { window, maxDepth, maxNodes }, o); }
  /** `pointer` = { x, y } in SCREEN pixels: the helper draws a ring there ("the last click landed here"). */
  screenshot({ window, maxWidth = 1280, grid = false, marks = false, gridIfBlind = false, gridUnits, pointer } = {}, o) { return this.call("screenshot", { window, maxWidth, grid, marks, gridIfBlind, ...(gridUnits ? { gridUnits } : {}), ...(pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y) ? { pointer: { x: Math.round(pointer.x), y: Math.round(pointer.y) } } : {}) }, o); }
  focus(window, o) { return this.call("focus", { window }, o); }
  click(args, o) { return this.call("click", args, o); }
  scroll(args, o) { return this.call("scroll", args, o); }
  setText(element, text, o) { return this.call("setText", { element, text }, o); }
  type(window, text, { element, force } = {}, o) { return this.call("type", { window, text, element, ...(force ? { force: true } : {}) }, { timeoutMs: 20_000 + Math.min(60_000, String(text).length * 12), ...(o || {}) }); }
  key(window, combo, o) { return this.call("key", { window, combo, ...(o && o.force ? { force: true } : {}) }, o); }
  launch(args, o) { return this.call("launch", args, o); }
  closeWindow(window, o) { return this.call("close", { window }, o); }
  cursor(o) { return this.call("cursor", {}, o); }
  waitWindow({ title = "", process = "", waitMs = 8000 } = {}, o) { return this.call("waitWindow", { title, process, waitMs }, { timeoutMs: waitMs + 4000, ...(o || {}) }); }
  apps(o) { return this.call("apps", {}, { timeoutMs: 30_000, ...(o || {}) }); }
  /** The controls of a window that can be pressed, ticked or typed into, with their names and places (fast, and time-limited: a web page may give little). */
  interactive(window, { maxNodes = 120, budgetMs = 4000 } = {}, o) { return this.call("interactive", { window, maxNodes, budgetMs }, { timeoutMs: budgetMs + 9000, ...(o || {}) }); }
  /** What is at a point on the screen. */
  elementAt(x, y, o) { return this.call("elementAt", { x, y }, o); }
  /** How long since the USER last touched the keyboard or mouse (what Noah itself sent does not count). */
  userIdle(o) { return this.call("userIdle", {}, { timeoutMs: 5000, ...(o || {}) }); }
  ping(o) { return this.call("ping", {}, o); }
}

module.exports = { DesktopBridge, DesktopError, hostEnv, ascii, realPath };
