// noah-builtins.js - the few Node.js / Electron built-ins Noah's agent code (Noah/*.cjs, bundled unchanged into noah-bundle.js)
// expects, for Jonah on Chromium. Files are kept in memory and saved to chrome.storage.local ("noahfs") in the background;
// NoahBuiltins.ready() loads them before Noah starts.
(function () {
  "use strict";
  const unavailable = (what) => () => { throw new Error(what + " is not available in Jonah on Chromium."); };

  // ------------------------------------------------------------------ path (Windows-style separators are accepted, "/" is used)
  const norm = (p) => {
    const parts = [];
    for (const s of String(p).replace(/\\/g, "/").split("/")) {
      if (!s || s === ".") continue;
      if (s === "..") parts.pop(); else parts.push(s);
    }
    return "/" + parts.join("/");
  };
  const path = {
    sep: "/", delimiter: ";",
    join: (...a) => norm(a.filter((x) => x !== "").join("/")),
    resolve: (...a) => { let out = ""; for (const x of a) { const s = String(x).replace(/\\/g, "/"); out = /^([a-z]:)?\//i.test(s) ? s : out + "/" + s; } return norm(out.replace(/^[a-z]:/i, "")); },
    normalize: norm,
    basename: (p, ext) => { let b = String(p).replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || ""; if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; },
    dirname: (p) => { const s = norm(p); const i = s.lastIndexOf("/"); return i <= 0 ? "/" : s.slice(0, i); },
    extname: (p) => { const b = path.basename(p); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : ""; },
    relative: (from, to) => { const a = norm(from).split("/").filter(Boolean), b = norm(to).split("/").filter(Boolean); let i = 0; while (i < a.length && a[i] === b[i]) i++; return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/"); },
    isAbsolute: (p) => /^([a-z]:)?[\\/]/i.test(String(p)),
    parse: (p) => { const base = path.basename(p), ext = path.extname(p); return { root: "/", dir: path.dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base }; },
  };
  path.posix = path; path.win32 = path;

  // ------------------------------------------------------------------ events
  class EventEmitter {
    constructor() { this._ev = new Map(); }
    _list(n) { if (!this._ev) this._ev = new Map(); if (!this._ev.has(n)) this._ev.set(n, []); return this._ev.get(n); }
    on(n, f) { this._list(n).push(f); return this; }
    addListener(n, f) { return this.on(n, f); }
    prependListener(n, f) { this._list(n).unshift(f); return this; }
    once(n, f) { const w = (...a) => { this.off(n, w); f.apply(this, a); }; w.listener = f; return this.on(n, w); }
    off(n, f) { const l = this._list(n); const i = l.findIndex((x) => x === f || x.listener === f); if (i >= 0) l.splice(i, 1); return this; }
    removeListener(n, f) { return this.off(n, f); }
    removeAllListeners(n) { if (n === undefined) this._ev = new Map(); else this._list(n).length = 0; return this; }
    emit(n, ...a) { const l = this._list(n).slice(); if (n === "error" && !l.length) throw a[0] instanceof Error ? a[0] : new Error(String(a[0])); for (const f of l) { try { f.apply(this, a); } catch (err) { console.error("[noah]", n, err); } } return l.length > 0; }
    listenerCount(n) { return this._list(n).length; }
    listeners(n) { return this._list(n).slice(); }
    setMaxListeners() { return this; }
  }
  const events = Object.assign(EventEmitter, { EventEmitter, once: (em, n) => new Promise((r) => em.once(n, (...a) => r(a))) });

  // ------------------------------------------------------------------ fs (in memory, saved to chrome.storage.local)
  const files = new Map(); // path -> { data: string, mtimeMs }
  let saveTimer = null;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const obj = {}; for (const [k, v] of files) obj[k] = v;
      chrome.storage.local.set({ noahfs: obj }).catch((e) => console.warn("[noah] could not save files:", e));
    }, 400);
  };
  const enoent = (p) => Object.assign(new Error("ENOENT: no such file or directory, '" + p + "'"), { code: "ENOENT" });
  const isDir = (p) => { const d = norm(p) + "/"; for (const k of files.keys()) if (k.startsWith(d)) return true; return false; };
  const toText = (d) => (typeof d === "string" ? d : d instanceof Uint8Array ? new TextDecoder().decode(d) : String(d));
  const fs = {
    existsSync: (p) => files.has(norm(p)) || isDir(p),
    readFileSync: (p, enc) => { const f = files.get(norm(p)); if (!f) throw enoent(p); return enc ? f.data : new TextEncoder().encode(f.data); },
    writeFileSync: (p, d) => { files.set(norm(p), { data: toText(d), mtimeMs: Date.now() }); persist(); },
    appendFileSync: (p, d) => { const k = norm(p), f = files.get(k); files.set(k, { data: (f ? f.data : "") + toText(d), mtimeMs: Date.now() }); persist(); },
    mkdirSync: () => undefined,
    statSync: (p) => { const f = files.get(norm(p)); if (!f && !isDir(p)) throw enoent(p); return { size: f ? f.data.length : 0, mtimeMs: f ? f.mtimeMs : Date.now(), mtime: new Date(f ? f.mtimeMs : Date.now()), isFile: () => !!f, isDirectory: () => !f }; },
    renameSync: (a, b) => { const f = files.get(norm(a)); if (!f) throw enoent(a); files.delete(norm(a)); files.set(norm(b), f); persist(); },
    unlinkSync: (p) => { files.delete(norm(p)); persist(); },
    rmSync: (p) => { const k = norm(p); files.delete(k); for (const x of [...files.keys()]) if (x.startsWith(k + "/")) files.delete(x); persist(); },
    readdirSync: (p) => { const d = norm(p) + "/"; const out = new Set(); for (const k of files.keys()) if (k.startsWith(d)) out.add(k.slice(d.length).split("/")[0]); return [...out]; },
    realpathSync: (p) => norm(p),
    promises: {},
  };
  for (const k of ["readFile", "writeFile", "appendFile", "mkdir", "stat", "rename", "unlink", "rm", "readdir"]) {
    fs.promises[k] = async (...a) => fs[k + "Sync"](...a);
  }

  // ------------------------------------------------------------------ crypto (randomUUID, createHash("sha256"))
  function sha256(bytes) {
    const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const l = bytes.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n); m.set(bytes); m[l] = 0x80;
    const dv = new DataView(m.buffer); dv.setUint32(n - 4, l * 8); dv.setUint32(n - 8, Math.floor(l / 0x20000000));
    const w = new Uint32Array(64), r = (x, s) => (x >>> s) | (x << (32 - s));
    for (let o = 0; o < n; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) w[i] = (w[i - 16] + (r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 7] + (r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10))) >>> 0;
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    const out = new Uint8Array(32); const ov = new DataView(out.buffer); H.forEach((v, i) => ov.setUint32(i * 4, v)); return out;
  }
  const crypto = {
    randomUUID: () => globalThis.crypto.randomUUID(),
    randomBytes: (n) => { const b = new Uint8Array(n); globalThis.crypto.getRandomValues(b); b.toString = (enc) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); return b; },
    createHash: (alg) => {
      if (!/^sha-?256$/i.test(alg)) throw new Error("Only sha256 is available in Jonah on Chromium.");
      const chunks = [];
      const h = {
        update: (d) => { chunks.push(typeof d === "string" ? new TextEncoder().encode(d) : new Uint8Array(d)); return h; },
        digest: (enc) => {
          const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0)); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
          const d = sha256(all);
          if (enc === "hex") return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
          if (enc === "base64") return btoa(String.fromCharCode(...d));
          return d;
        },
      };
      return h;
    },
  };

  // ------------------------------------------------------------------ os, electron, the rest
  const os = { platform: () => "win32", homedir: () => "/home", tmpdir: () => "/tmp", EOL: "\n", type: () => "Windows_NT", release: () => "10.0", arch: () => "x64", cpus: () => [], totalmem: () => 0, freemem: () => 0, hostname: () => "jonah" };
  const electron = {
    // Electron encrypted model keys with the Windows keychain (DPAPI). A browser page cannot use DPAPI, so in Jonah on Chromium
    // the keys the user types are kept in Jonah's private extension storage in this profile on this PC, NOT encrypted with the
    // Windows login (the Models screen says so). They are only ever sent to the model company they belong to.
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from("jonah-local:" + String(s)),
      decryptString: (b) => { const s = Buffer.from(b).toString(); return s.startsWith("jonah-local:") ? s.slice(12) : ""; },
    },
    screen: { getPrimaryDisplay: () => ({ scaleFactor: window.devicePixelRatio || 1, size: { width: screen.width, height: screen.height }, workAreaSize: { width: screen.availWidth, height: screen.availHeight }, bounds: { x: 0, y: 0, width: screen.width, height: screen.height } }), getAllDisplays: () => [electron.screen.getPrimaryDisplay()], getDisplayMatching: () => electron.screen.getPrimaryDisplay(), getDisplayNearestPoint: () => electron.screen.getPrimaryDisplay(), getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    ipcMain: { handle() {}, removeHandler() {}, on() {}, removeListener() {} },
  };
  const stubModule = (name) => new Proxy({}, { get: (_t, k) => (k === "__esModule" ? false : unavailable(name + "." + String(k))) });

  window.NoahBuiltins = {
    modules: { path, events, fs, crypto, os, electron },
    stub: stubModule,
    files,
    async ready() {
      const { noahfs } = await chrome.storage.local.get("noahfs");
      if (noahfs && typeof noahfs === "object") for (const [k, v] of Object.entries(noahfs)) if (v && typeof v.data === "string") files.set(k, v);
    },
  };
  // a few globals Node code may touch
  if (typeof window.process === "undefined") window.process = { platform: "win32", env: {}, versions: {}, cwd: () => "/", nextTick: (f, ...a) => queueMicrotask(() => f(...a)), hrtime: { bigint: () => BigInt(Math.round(performance.now() * 1e6)) } };
  if (typeof window.global === "undefined") window.global = window;
  // Noah's model providers keep fetch as a property (this.fetch = fetch) and call it as a method; in a page that needs a
  // bound fetch ("Illegal invocation" otherwise).
  if (!window.fetch.__jonahBound) { const f = window.fetch.bind(window); f.__jonahBound = true; window.fetch = f; }
  if (typeof window.setImmediate === "undefined") window.setImmediate = (f, ...a) => setTimeout(f, 0, ...a);
  // a small Buffer (from / toString for utf8, base64, hex)
  if (typeof window.Buffer === "undefined") {
    class Buffer extends Uint8Array {
      static from(v, enc) {
        if (typeof v === "string") {
          if (enc === "base64") { const s = atob(v.replace(/[^A-Za-z0-9+/=]/g, "")); const b = new Buffer(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
          if (enc === "hex") { const b = new Buffer(v.length >> 1); for (let i = 0; i < b.length; i++) b[i] = parseInt(v.substr(i * 2, 2), 16); return b; }
          const u = new TextEncoder().encode(v); const b = new Buffer(u.length); b.set(u); return b;
        }
        const u = v instanceof ArrayBuffer ? new Uint8Array(v) : Uint8Array.from(v); const b = new Buffer(u.length); b.set(u); return b;
      }
      static isBuffer(x) { return x instanceof Buffer; }
      static byteLength(s) { return new TextEncoder().encode(String(s)).length; }
      static concat(list) { const n = list.reduce((s, x) => s + x.length, 0), b = new Buffer(n); let o = 0; for (const x of list) { b.set(x, o); o += x.length; } return b; }
      toString(enc) {
        if (enc === "base64") { let s = ""; for (let i = 0; i < this.length; i += 0x8000) s += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000)); return btoa(s); }
        if (enc === "hex") return [...this].map((x) => x.toString(16).padStart(2, "0")).join("");
        return new TextDecoder().decode(this);
      }
    }
    window.Buffer = Buffer;
  }
})();
