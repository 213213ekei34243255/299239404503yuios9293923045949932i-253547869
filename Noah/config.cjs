// Noah/config.cjs
//
// Settings (persisted JSON) and secrets (env + OS-keychain-encrypted file),
// kept strictly apart:
//
//   * Settings never contain API keys and are safe to send to the renderer.
//   * Keys come from (1) real environment variables, (2) an allow-listed subset
//     of the project's .env file (only variable names Noah understands - the
//     file is parsed, never loaded wholesale into process.env), (3) a file
//     encrypted with Electron safeStorage (DPAPI/Keychain/libsecret) written via
//     the `noah:set-key` IPC. The renderer can learn only WHETHER a key exists.

"use strict";

const fs = require("fs");
const path = require("path");
const { DEFAULT_PROVIDERS, DEFAULT_ROLES, ROLES } = require("./models/catalog.cjs");
const { DEFAULT_POLICY, MODES } = require("./safety/policy.cjs");

const DEFAULT_CONFIG = {
  version: 1,
  enabled: true,
  policy: { ...DEFAULT_POLICY },
  sessionMode: "user", // "user": Noah works in the user's tabs/session. "isolated": Noah only uses tabs it opened, in a separate cookie-less partition.
  cursor: { mode: "decoupled", reducedMotion: false }, // mode: decoupled | lead | off
  autoDecide: true, // decide by itself instead of asking; only login/payment/CAPTCHA-type questions pause for the person (agent/ask-policy.cjs)
  humanLike: true, // refuse same-site URL jumps: search boxes, scrolling and clicks instead (agent/human-nav.cjs)
  visualVerification: false, // add a screenshot-hash check to action verification (slower)
  perception: {
    maxGeometry: 380,
    screenshot: { maxLongEdge: 1280, format: "jpeg", quality: 75 },
    tokenBudget: { elements: 3000, text: 1400 },
    perceptionMode: "auto", // auto | text | hybrid | vision
  },
  limits: { maxSteps: 60, maxWallMs: 15 * 60_000, maxConsecutiveFailures: 4, maxModelCalls: 150, maxBatch: 5, stepTimeoutMs: 60_000, observeTimeoutMs: 30_000, actionTimeoutMs: 60_000 },
  // Takeover = a real key press, click or scroll in the page (or a tab switch). Plain mouse MOVEMENT is not takeover by
  // default: people wave the pointer around while they watch, and clicking Resume moves it across the page.
  takeover: { enabled: true, mouseMove: false, cursorDeltaPx: 14 },
  stopShortcut: "Escape",
  dialogAutoDismissMs: 20_000,
  uploadRoots: [],
  maxUploadBytes: 50 * 1024 * 1024,
  auditEnabled: true,
  providers: JSON.parse(JSON.stringify(DEFAULT_PROVIDERS)),
  roles: JSON.parse(JSON.stringify(DEFAULT_ROLES)),
  routing: { allowLegacyFallback: true, allowSensitiveOnLocal: false, requireTrustedForSensitive: true, cooldownMs: 60_000 },
  theme: {},
};

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = isObject(v) && isObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Keep only values of the right shape; the renderer/IPC must not be able to corrupt settings. */
function sanitizePatch(patch) {
  const p = {};
  if (!isObject(patch)) return p;
  if (typeof patch.enabled === "boolean") p.enabled = patch.enabled;
  if (typeof patch.humanLike === "boolean") p.humanLike = patch.humanLike;
  if (typeof patch.autoDecide === "boolean") p.autoDecide = patch.autoDecide;
  if (typeof patch.visualVerification === "boolean") p.visualVerification = patch.visualVerification;
  if (["user", "isolated"].includes(patch.sessionMode)) p.sessionMode = patch.sessionMode;
  if (isObject(patch.cursor)) {
    p.cursor = {};
    if (["decoupled", "lead", "off"].includes(patch.cursor.mode)) p.cursor.mode = patch.cursor.mode;
    if (typeof patch.cursor.reducedMotion === "boolean") p.cursor.reducedMotion = patch.cursor.reducedMotion;
  }
  if (isObject(patch.policy)) {
    p.policy = {};
    if (MODES.includes(patch.policy.mode)) p.policy.mode = patch.policy.mode;
    if (typeof patch.policy.allowCredentialTyping === "boolean") p.policy.allowCredentialTyping = patch.policy.allowCredentialTyping;
    if (typeof patch.policy.allowLocalhost === "boolean") p.policy.allowLocalhost = patch.policy.allowLocalhost;
    for (const k of ["allowedDomains", "blockedDomains", "confirmAlwaysDomains"]) {
      if (Array.isArray(patch.policy[k])) p.policy[k] = patch.policy[k].filter((d) => typeof d === "string" && d.length < 200).slice(0, 200);
    }
    if (Number.isFinite(patch.policy.confirmTimeoutMs)) p.policy.confirmTimeoutMs = Math.min(600_000, Math.max(5_000, patch.policy.confirmTimeoutMs));
  }
  if (isObject(patch.perception) && ["auto", "text", "hybrid", "vision"].includes(patch.perception.perceptionMode)) p.perception = { perceptionMode: patch.perception.perceptionMode };
  if (isObject(patch.takeover)) {
    p.takeover = {};
    if (typeof patch.takeover.enabled === "boolean") p.takeover.enabled = patch.takeover.enabled;
    if (typeof patch.takeover.mouseMove === "boolean") p.takeover.mouseMove = patch.takeover.mouseMove;
  }
  if (Array.isArray(patch.uploadRoots)) p.uploadRoots = patch.uploadRoots.filter((d) => typeof d === "string").slice(0, 20);
  if (isObject(patch.routing)) {
    p.routing = {};
    for (const k of ["allowLegacyFallback", "allowSensitiveOnLocal", "requireTrustedForSensitive"]) if (typeof patch.routing[k] === "boolean") p.routing[k] = patch.routing[k];
  }
  if (isObject(patch.roles)) {
    p.roles = {};
    for (const role of ROLES) {
      const list = patch.roles[role];
      if (Array.isArray(list)) {
        p.roles[role] = list
          .filter((c) => isObject(c) && typeof c.provider === "string" && typeof c.model === "string")
          .map((c) => ({ provider: c.provider.slice(0, 40), model: c.model.slice(0, 100), trusted: !!c.trusted }))
          .slice(0, 8);
      }
    }
  }
  if (isObject(patch.limits)) {
    p.limits = {};
    for (const k of ["maxSteps", "maxWallMs", "maxConsecutiveFailures", "maxModelCalls", "maxBatch", "stepTimeoutMs", "observeTimeoutMs", "actionTimeoutMs"]) if (Number.isFinite(patch.limits[k]) && patch.limits[k] > 0) p.limits[k] = Math.floor(patch.limits[k]);
  }
  if (isObject(patch.theme)) p.theme = patch.theme;
  return p;
}

/** Only these variable names are ever read from a .env file. */
const ENV_ALLOWLIST = new Set([
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY", "REXY_LLM_API_KEY",
  "NOAH_ANTHROPIC_BASE_URL", "NOAH_OPENAI_BASE_URL", "NOAH_GOOGLE_BASE_URL", "NOAH_LOCAL_BASE_URL", "NOAH_LOCAL_MODEL",
]);

function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim().replace(/^set\s+/i, "").replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !ENV_ALLOWLIST.has(m[1])) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v) out[m[1]] = v;
  }
  return out;
}

class ConfigStore {
  /**
   * @param {object} o
   * @param {string} o.dir            directory for settings + encrypted keys (userData/noah)
   * @param {string} [o.appRoot]      project root (to find .env)
   * @param {NodeJS.ProcessEnv} [o.env]
   * @param {{isEncryptionAvailable:Function, encryptString:Function, decryptString:Function}} [o.safeStorage]
   */
  constructor({ dir, appRoot, env = process.env, safeStorage } = {}) {
    this.dir = dir;
    this.appRoot = appRoot;
    this.env = env;
    this.safeStorage = safeStorage;
    this.file = dir ? path.join(dir, "noah-config.json") : null;
    this.keyFile = dir ? path.join(dir, "noah-keys.enc.json") : null;
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this._dotenv = null;
    this._stored = null;
    this.load();
  }

  load() {
    try {
      if (this.file && fs.existsSync(this.file)) {
        const disk = JSON.parse(fs.readFileSync(this.file, "utf8"));
        this.config = deepMerge(this.config, sanitizeDisk(disk));
      }
    } catch (err) {
      console.warn("[noah] config load failed:", err.message);
    }
    if (this.dir) this.config.userDataDir = path.resolve(this.dir, "..");
    return this.config;
  }

  get() {
    return this.config;
  }

  /** Apply a validated patch and persist. */
  update(patch) {
    this.config = deepMerge(this.config, sanitizePatch(patch));
    this.save();
    return this.config;
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const { userDataDir, ...persist } = this.config;
      fs.writeFileSync(this.file + ".tmp", JSON.stringify(persist, null, 2));
      fs.renameSync(this.file + ".tmp", this.file);
    } catch (err) {
      console.warn("[noah] config save failed:", err.message);
    }
  }

  // ---------------------------------------------------------------- secrets

  _dotenvVars() {
    if (this._dotenv) return this._dotenv;
    this._dotenv = {};
    for (const p of [this.appRoot && path.join(this.appRoot, ".env"), this.dir && path.join(this.dir, ".env")].filter(Boolean)) {
      try {
        if (fs.existsSync(p)) Object.assign(this._dotenv, parseEnvFile(fs.readFileSync(p, "utf8")));
      } catch (_) {
        /* ignore */
      }
    }
    return this._dotenv;
  }

  _storedKeys() {
    if (this._stored) return this._stored;
    this._stored = {};
    try {
      if (this.keyFile && this.safeStorage?.isEncryptionAvailable() && fs.existsSync(this.keyFile)) {
        const enc = JSON.parse(fs.readFileSync(this.keyFile, "utf8"));
        for (const [name, b64] of Object.entries(enc)) {
          try {
            this._stored[name] = this.safeStorage.decryptString(Buffer.from(b64, "base64"));
          } catch (_) {
            /* unreadable entry */
          }
        }
      }
    } catch (_) {
      /* ignore */
    }
    return this._stored;
  }

  /** Store a key encrypted with the OS keychain. Returns false if encryption is unavailable. */
  setKey(providerName, key) {
    if (!/^[a-z0-9_-]{1,40}$/i.test(providerName) || typeof key !== "string" || key.length < 8 || key.length > 400) return false;
    if (!this.safeStorage?.isEncryptionAvailable()) return false;
    const stored = this._storedKeys();
    stored[providerName] = key;
    const enc = {};
    for (const [n, v] of Object.entries(stored)) enc[n] = this.safeStorage.encryptString(v).toString("base64");
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.keyFile, JSON.stringify(enc));
    return true;
  }

  clearKey(providerName) {
    const stored = this._storedKeys();
    delete stored[providerName];
    if (this.safeStorage?.isEncryptionAvailable() && this.keyFile) {
      const enc = {};
      for (const [n, v] of Object.entries(stored)) enc[n] = this.safeStorage.encryptString(v).toString("base64");
      fs.writeFileSync(this.keyFile, JSON.stringify(enc));
    }
  }

  /** Resolve the API key for a provider (env > keychain file > allow-listed .env). Main-process only. */
  getKey(providerName) {
    const prov = this.config.providers[providerName];
    if (!prov) return null;
    for (const name of prov.keyEnv || []) {
      if (this.env[name]) return this.env[name];
    }
    const stored = this._storedKeys()[providerName];
    if (stored) return stored;
    const dot = this._dotenvVars();
    for (const name of prov.keyEnv || []) if (dot[name]) return dot[name];
    return null;
  }

  getBaseURL(providerName) {
    const prov = this.config.providers[providerName];
    if (!prov) return null;
    const envName = { anthropic: "NOAH_ANTHROPIC_BASE_URL", openai: "NOAH_OPENAI_BASE_URL", google: "NOAH_GOOGLE_BASE_URL", local: "NOAH_LOCAL_BASE_URL" }[providerName];
    // Note: the generic ANTHROPIC_BASE_URL / OPENAI_BASE_URL variables are deliberately NOT honoured: they are
    // often set by other tools to proxies, and Noah must never route page content there implicitly.
    return (envName && (this.env[envName] || this._dotenvVars()[envName])) || prov.baseURL;
  }

  /** Renderer-safe view: no secrets, only which providers have credentials. */
  publicView() {
    const c = JSON.parse(JSON.stringify(this.config));
    delete c.userDataDir;
    c.providerStatus = {};
    for (const [name, p] of Object.entries(this.config.providers)) {
      c.providerStatus[name] = { hasKey: !!this.getKey(name) || !!p.keyless, keyless: !!p.keyless, local: !!p.local, legacy: !!p.legacy };
      delete c.providers[name].keyEnv;
    }
    return c;
  }
}

function sanitizeDisk(disk) {
  // Disk content is trusted more than IPC, but still drop prototype-pollution keys and unknown top-level junk.
  const allowed = Object.keys(DEFAULT_CONFIG);
  const out = {};
  for (const k of allowed) if (disk && k in disk && k !== "__proto__") out[k] = disk[k];
  return out;
}

module.exports = { ConfigStore, DEFAULT_CONFIG, sanitizePatch, deepMerge, parseEnvFile, ENV_ALLOWLIST };
