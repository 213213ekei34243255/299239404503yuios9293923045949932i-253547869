// All authorization decisions. The Mac app (and anything else) is never trusted with any of them.
"use strict";
const C = require("./crypto.cjs");
const { FailureTracker, SlidingWindow } = require("./throttle.cjs");

const MESSAGES = {
  access_expired: "Sorry, your developer access mode has expired. Kindly reinstall the app from the Mac App Store or jonahbrowser.com, or please contact Customer Care Service.",
  device_conflict: "This account is already authorized on another device. Please contact Customer Care Service to transfer or reset your device authorization.",
  invalid_credentials: "Incorrect username or password.",
  session_ended: "Your session has ended. Please sign in again.",
  rate_limited: "Too many attempts. Please wait a moment and try again.",
  bad_request: "The request was not valid.",
  bad_challenge: "The sign-in request expired. Please try again.",
  bad_device_proof: "This device could not be verified. Please try again.",
};
const STATUS = { invalid_credentials: 401, access_expired: 403, device_conflict: 403, session_ended: 401, rate_limited: 429, bad_request: 400, bad_challenge: 400, bad_device_proof: 400 };

class AuthError extends Error {
  constructor(code, extra = {}) {
    super(MESSAGES[code] || code);
    this.code = code; this.status = STATUS[code] || 400; Object.assign(this, extra);
  }
}

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const ACTIONS = new Set(["ban", "unban", "disable", "enable", "revoke-device", "force-reauth", "kill-sessions"]);

class LicenseService {
  constructor({ db, config, signingKey, now = () => Math.floor(Date.now() / 1000), log = () => {} }) {
    this.db = db; this.config = config; this.key = signingKey; this.now = now; this.log = log;
    const ms = () => this.now() * 1000;
    this.pairFails = new FailureTracker({ free: 5, baseMs: 30000, maxMs: 900000, now: ms });
    this.userFails = new FailureTracker({ free: 30, baseMs: 60000, maxMs: 900000, now: ms });
    this.ipFails = new FailureTracker({ free: 20, baseMs: 60000, maxMs: 900000, now: ms });
    this.adminFails = new FailureTracker({ free: 5, baseMs: 60000, maxMs: 1800000, now: ms });
    this.challengeRate = new SlidingWindow(60, 60000, { now: ms });
    this.refreshRate = new SlidingWindow(120, 60000, { now: ms });
    this.challenges = new Map();
    this._defaults();
  }

  // ------------------------------------------------------------------ settings

  _defaults() {
    const put = this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
    put.run("app_active", "1");
    put.run("unlimited_enabled", "1");
    put.run("token_ttl_seconds", String(this.config.tokenTtlSeconds));
  }
  getSettings() {
    const rows = Object.fromEntries(this.db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value]));
    return { appActive: rows.app_active === "1", unlimitedEnabled: rows.unlimited_enabled === "1", tokenTtlSeconds: Number(rows.token_ttl_seconds) || this.config.tokenTtlSeconds };
  }
  updateSettings(patch, actor, ip) {
    const put = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const changed = [];
    if (patch.appActive !== undefined) { if (typeof patch.appActive !== "boolean") throw new AuthError("bad_request"); put.run("app_active", patch.appActive ? "1" : "0"); changed.push(`appActive=${patch.appActive}`); }
    if (patch.unlimitedEnabled !== undefined) { if (typeof patch.unlimitedEnabled !== "boolean") throw new AuthError("bad_request"); put.run("unlimited_enabled", patch.unlimitedEnabled ? "1" : "0"); changed.push(`unlimitedEnabled=${patch.unlimitedEnabled}`); }
    if (patch.tokenTtlSeconds !== undefined) {
      const n = Number(patch.tokenTtlSeconds);
      if (!Number.isInteger(n) || n < 60 || n > 3600) throw new AuthError("bad_request");
      put.run("token_ttl_seconds", String(n)); changed.push(`tokenTtlSeconds=${n}`);
    }
    if (changed.length) this.audit(actor, "settings", null, changed.join(", "), ip);
    return this.getSettings();
  }
  _accessOpen() { const s = this.getSettings(); return s.appActive && s.unlimitedEnabled; }

  // ------------------------------------------------------------------ audit

  audit(actor, action, target, detail, ip) {
    this.db.prepare("INSERT INTO audit (ts, actor, action, target, detail, ip) VALUES (?,?,?,?,?,?)").run(this.now(), String(actor), String(action), target == null ? null : String(target), detail == null ? null : String(detail).slice(0, 300), ip || null);
    if (Math.random() < 0.02) this.db.exec("DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - 5000");
  }
  listAudit(limit = 200) {
    return this.db.prepare("SELECT id, ts, actor, action, target, detail, ip FROM audit ORDER BY id DESC LIMIT ?").all(Math.min(1000, Math.max(1, Number(limit) || 200)));
  }

  // ------------------------------------------------------------------ accounts

  effectiveStatus(a, now = this.now()) {
    if (a.status === "banned") return "banned";
    if (a.status === "disabled") return "disabled";
    if (a.expires_at != null && now >= a.expires_at) return "expired";
    return "active";
  }
  _byName(username) { return this.db.prepare("SELECT * FROM accounts WHERE username = ?").get(username); }
  _byId(id) { return this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id); }

  _validateNewPassword(pw, min = 8) {
    if (typeof pw !== "string" || pw.length < min || pw.length > C.MAX_PASSWORD_LENGTH) throw Object.assign(new AuthError("bad_request"), { message: `Password must be ${min}-${C.MAX_PASSWORD_LENGTH} characters.` });
  }
  _validateUsername(u) {
    if (typeof u !== "string" || !USERNAME_RE.test(u)) throw Object.assign(new AuthError("bad_request"), { message: "Username must be 3-32 characters: letters, digits, dot, dash or underscore." });
  }
  _parseExpiry(v) {
    if (v === null || v === "" || v === undefined) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw Object.assign(new AuthError("bad_request"), { message: "Expiry must be a date/time in the future or empty." });
    return n;
  }

  async createAccount({ username, password, expiresAt, note }, actor, ip) {
    this._validateUsername(username); this._validateNewPassword(password);
    if (this._byName(username)) throw Object.assign(new AuthError("bad_request"), { message: "That username already exists." });
    const hash = await C.hashPassword(password);
    const t = this.now();
    const r = this.db.prepare("INSERT INTO accounts (username, password_hash, expires_at, note, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(username, hash, this._parseExpiry(expiresAt), String(note || "").slice(0, 200), t, t);
    this.audit(actor, "account_create", username, null, ip);
    return this.getAccountView(Number(r.lastInsertRowid));
  }

  // For first-time setup: creates the accounts that do not exist yet and never touches an existing one.
  async seedAccounts(list) {
    const created = [];
    for (const a of list || []) {
      if (!a || !a.username || !a.password || this._byName(a.username)) continue;
      await this.createAccount({ username: a.username, password: a.password, expiresAt: a.expiresAt, note: a.note || "seeded" }, "system");
      created.push(a.username);
    }
    return created;
  }

  _view(a) {
    const now = this.now();
    const s = this.db.prepare("SELECT COUNT(*) AS n, MAX(last_used_at) AS last FROM sessions WHERE account_id = ? AND revoked = 0 AND expires_at > ?").get(a.id, now);
    const online = s.n > 0 && s.last != null && s.last >= now - (this.getSettings().tokenTtlSeconds + 60);
    return {
      id: a.id, username: a.username, status: a.status, effectiveStatus: this.effectiveStatus(a, now), expiresAt: a.expires_at, note: a.note,
      createdAt: a.created_at, lastLoginAt: a.last_login_at, online, activeSessions: s.n,
      device: a.device_pub ? { id: a.device_id, label: a.device_label, hw: a.device_hw ? a.device_hw.slice(0, 12) : "", boundAt: a.device_bound_at } : null,
    };
  }
  getAccountView(id) { const a = this._byId(id); return a ? this._view(a) : null; }
  listAccounts() { return this.db.prepare("SELECT * FROM accounts ORDER BY username COLLATE NOCASE").all().map((a) => this._view(a)); }
  overview() {
    const accounts = this.listAccounts();
    const counts = { active: 0, disabled: 0, banned: 0, expired: 0, online: 0 };
    for (const a of accounts) { counts[a.effectiveStatus]++; if (a.online) counts.online++; }
    return { settings: this.getSettings(), counts, accounts, serverTime: this.now() };
  }

  updateAccount(id, patch, actor, ip) {
    const a = this._byId(id); if (!a) throw Object.assign(new AuthError("bad_request"), { message: "No such account." });
    const sets = [], vals = [], notes = [];
    let endSessions = false;
    if (patch.username !== undefined && patch.username !== a.username) {
      this._validateUsername(patch.username);
      const other = this._byName(patch.username);
      if (other && other.id !== a.id) throw Object.assign(new AuthError("bad_request"), { message: "That username already exists." });
      sets.push("username = ?"); vals.push(patch.username); notes.push(`username ${a.username} -> ${patch.username}`); endSessions = true;
    }
    if (patch.expiresAt !== undefined) { const e = this._parseExpiry(patch.expiresAt); sets.push("expires_at = ?"); vals.push(e); notes.push(`expiresAt=${e}`); endSessions = true; }
    if (patch.note !== undefined) { sets.push("note = ?"); vals.push(String(patch.note).slice(0, 200)); notes.push("note"); }
    if (sets.length) {
      sets.push("updated_at = ?"); vals.push(this.now());
      this.db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
      // a rename or a new expiry date makes the signed-in user sign in again (a note edit does not)
      if (endSessions) this._killSessions(id);
      this.audit(actor, "account_update", a.username, notes.join(", "), ip);
    }
    return this.getAccountView(id);
  }

  async setPassword(id, password, actor, ip) {
    const a = this._byId(id); if (!a) throw Object.assign(new AuthError("bad_request"), { message: "No such account." });
    this._validateNewPassword(password);
    const hash = await C.hashPassword(password);
    this.db.prepare("UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?").run(hash, this.now(), id);
    this._killSessions(id);
    this.audit(actor, "password_change", a.username, null, ip);
    return this.getAccountView(id);
  }

  deleteAccount(id, actor, ip) {
    const a = this._byId(id); if (!a) throw Object.assign(new AuthError("bad_request"), { message: "No such account." });
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    this.audit(actor, "account_delete", a.username, null, ip);
    return { deleted: true };
  }

  // Revokes every session and bumps the epoch: any refresh with an older session is refused from now on.
  _killSessions(accountId) {
    this.db.prepare("UPDATE accounts SET session_epoch = session_epoch + 1 WHERE id = ?").run(accountId);
    this.db.prepare("UPDATE sessions SET revoked = 1 WHERE account_id = ? AND revoked = 0").run(accountId);
  }

  action(id, action, actor, ip) {
    if (!ACTIONS.has(action)) throw new AuthError("bad_request");
    const a = this._byId(id); if (!a) throw Object.assign(new AuthError("bad_request"), { message: "No such account." });
    const t = this.now();
    const setStatus = (s) => this.db.prepare("UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?").run(s, t, id);
    switch (action) {
      case "ban": setStatus("banned"); this._killSessions(id); break;
      case "unban": setStatus("active"); break;
      case "disable": setStatus("disabled"); this._killSessions(id); break;
      case "enable": setStatus("active"); break;
      case "revoke-device":
        this.db.prepare("UPDATE accounts SET device_pub = NULL, device_id = NULL, device_hw = NULL, device_label = NULL, device_bound_at = NULL, updated_at = ? WHERE id = ?").run(t, id);
        this._killSessions(id); break;
      case "force-reauth": case "kill-sessions": this._killSessions(id); break;
    }
    this.audit(actor, action, a.username, null, ip);
    return this.getAccountView(id);
  }

  // ------------------------------------------------------------------ challenges (single use, 60 s)

  issueChallenge(ip) {
    if (!this.challengeRate.hit(`c:${ip}`)) throw new AuthError("rate_limited", { retryAfterSeconds: 30 });
    const t = this.now();
    for (const [k, v] of this.challenges) if (v.exp < t) this.challenges.delete(k);
    if (this.challenges.size > 20000) throw new AuthError("rate_limited", { retryAfterSeconds: 30 });
    const id = C.randomToken(16), nonce = C.randomToken(32);
    this.challenges.set(id, { nonce, exp: t + 60 });
    return { challengeId: id, nonce, expiresIn: 60, serverTime: t };
  }
  _consumeChallenge(id) {
    const c = this.challenges.get(String(id));
    if (!c) return null;
    this.challenges.delete(String(id)); // single use, whatever happens next
    return c.exp >= this.now() ? c.nonce : null;
  }

  // ------------------------------------------------------------------ client authentication

  _tokenFor(account, session, nonce) {
    const t = this.now(), ttl = this.getSettings().tokenTtlSeconds;
    const claims = { iss: this.config.issuer, aud: this.config.audience, sub: account.id, usr: account.username, did: session.device_id, sid: session.id, ep: session.epoch, unl: 1, nc: nonce, iat: t, exp: t + ttl };
    return { accessToken: C.signToken(claims, this.key), expiresIn: ttl };
  }

  _validateDevice(device) {
    if (!device || typeof device !== "object") return null;
    const parsed = C.parseDevicePublicKey(device.pub);
    if (!parsed || typeof device.hw !== "string" || !/^[0-9a-f]{64}$/.test(device.hw) || typeof device.sig !== "string" || device.sig.length > 200) return null;
    return { pub: String(device.pub), id: parsed.id, hw: device.hw, sig: device.sig, label: String(device.label || "").replace(/[^\x20-\x7E]/g, "").slice(0, 80) };
  }

  async login({ username, password, challengeId, device, ip }) {
    const now = this.now();
    const lower = typeof username === "string" ? username.trim().toLowerCase() : "";
    const pairKey = `${lower}|${ip}`, userKey = lower, ipKey = ip;
    const locks = [this.pairFails.check(pairKey), this.userFails.check(userKey), this.ipFails.check(ipKey)].filter((l) => l.locked);
    if (locks.length) throw new AuthError("rate_limited", { retryAfterSeconds: Math.ceil(Math.max(...locks.map((l) => l.retryAfterMs)) / 1000) });

    // Master switches: when the app or unlimited mode is off, nobody gets in, and nothing is learned about any account.
    if (!this._accessOpen()) { this.audit("client", "login_denied", lower || "?", "access switched off", ip); throw new AuthError("access_expired"); }

    const nonce = this._consumeChallenge(challengeId);
    if (!nonce) throw new AuthError("bad_challenge");
    if (typeof password !== "string" || !password || password.length > C.MAX_PASSWORD_LENGTH || !USERNAME_RE.test(lower)) {
      await C.verifyAgainstDummy(String(password || "x"));
      this._noteFailure(pairKey, userKey, ipKey); this.audit("client", "login_failed", lower.slice(0, 40) || "?", "malformed", ip);
      throw new AuthError("invalid_credentials");
    }
    const account = this._byName(lower);
    const ok = account ? await C.verifyPassword(password, account.password_hash) : await C.verifyAgainstDummy(password);
    if (!ok) { this._noteFailure(pairKey, userKey, ipKey); this.audit("client", "login_failed", lower, "wrong password", ip); throw new AuthError("invalid_credentials"); }
    this.pairFails.success(pairKey); this.userFails.success(userKey);

    const eff = this.effectiveStatus(account, now);
    if (eff !== "active") { this.audit("client", "login_denied", account.username, eff, ip); throw new AuthError("access_expired"); }

    const dev = this._validateDevice(device);
    if (!dev) throw new AuthError("bad_request");
    if (!C.verifyDeviceSignature(dev.pub, `login|${nonce}|${lower}|${dev.hw}`, dev.sig)) throw new AuthError("bad_device_proof");

    if (!account.device_pub) {
      // first login: this Mac becomes the account's device. The conditional update makes two simultaneous first logins pick one winner.
      const r = this.db.prepare("UPDATE accounts SET device_pub = ?, device_id = ?, device_hw = ?, device_label = ?, device_bound_at = ?, updated_at = ? WHERE id = ? AND device_pub IS NULL").run(dev.pub, dev.id, dev.hw, dev.label, now, now, account.id);
      if (r.changes !== 1) { this.audit("client", "device_conflict", account.username, "lost bind race", ip); throw new AuthError("device_conflict"); }
      this.audit("client", "device_bound", account.username, dev.label, ip);
    } else if (account.device_pub !== dev.pub || account.device_hw !== dev.hw) {
      this.audit("client", "device_conflict", account.username, dev.label, ip);
      throw new AuthError("device_conflict");
    }

    const fresh = this._byId(account.id);
    const sid = C.randomHex(16), refresh = C.randomToken(32);
    this.db.prepare("INSERT INTO sessions (id, account_id, refresh_hash, device_id, epoch, created_at, last_used_at, expires_at, ip) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(sid, account.id, C.sha256Hex(refresh), dev.id, fresh.session_epoch, now, now, now + this.config.sessionIdleSeconds, ip || null);
    // keep the newest few sessions; a crashed app must not pile them up
    this.db.prepare("UPDATE sessions SET revoked = 1 WHERE account_id = ? AND revoked = 0 AND id NOT IN (SELECT id FROM sessions WHERE account_id = ? AND revoked = 0 ORDER BY created_at DESC, rowid DESC LIMIT ?)").run(account.id, account.id, this.config.maxSessionsPerAccount);
    this.db.prepare("UPDATE accounts SET last_login_at = ? WHERE id = ?").run(now, account.id);
    this.audit("client", "login", account.username, dev.label, ip);
    const session = { id: sid, epoch: fresh.session_epoch, device_id: dev.id };
    return { ok: true, sessionId: sid, refreshToken: refresh, username: account.username, ...this._tokenFor(account, session, nonce), serverTime: now };
  }

  _noteFailure(pairKey, userKey, ipKey) { this.pairFails.fail(pairKey); this.userFails.fail(userKey); this.ipFails.fail(ipKey); }

  async refresh({ sessionId, refreshToken, challengeId, sig, ip }) {
    if (!this.refreshRate.hit(`r:${ip}`)) throw new AuthError("rate_limited", { retryAfterSeconds: 30 });
    const now = this.now();
    if (!this._accessOpen()) throw new AuthError("access_expired");
    const nonce = this._consumeChallenge(challengeId);
    if (!nonce) throw new AuthError("bad_challenge");
    if (typeof sessionId !== "string" || typeof refreshToken !== "string" || typeof sig !== "string") throw new AuthError("bad_request");

    const s = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
    // 1) prove the caller holds this session's secret; 2) only then say WHY access ended. A banned/disabled/expired account must be told
    // "access expired" even though banning also revoked its session, so the account status is checked before the session's own state.
    if (!s || !C.safeEqual(C.sha256Hex(refreshToken), s.refresh_hash)) throw new AuthError("session_ended");
    const account = this._byId(s.account_id);
    if (!account) throw new AuthError("session_ended");
    if (this.effectiveStatus(account, now) !== "active") throw new AuthError("access_expired");
    if (s.revoked || s.expires_at < now) throw new AuthError("session_ended");
    if (account.session_epoch !== s.epoch) throw new AuthError("session_ended");
    if (!account.device_pub || account.device_id !== s.device_id) throw new AuthError("session_ended"); // device authorization was revoked
    if (!C.verifyDeviceSignature(account.device_pub, `refresh|${nonce}|${sessionId}`, sig)) throw new AuthError("bad_device_proof");

    this.db.prepare("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?").run(now, now + this.config.sessionIdleSeconds, s.id);
    return { ok: true, ...this._tokenFor(account, s, nonce), serverTime: now };
  }

  logout({ sessionId, refreshToken }) {
    const s = typeof sessionId === "string" ? this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) : null;
    if (s && typeof refreshToken === "string" && C.safeEqual(C.sha256Hex(refreshToken), s.refresh_hash)) {
      this.db.prepare("UPDATE sessions SET revoked = 1 WHERE id = ?").run(s.id);
    }
    return { ok: true }; // never reveals whether the session existed
  }

  // ------------------------------------------------------------------ admins (the Developer Console)

  async ensureBootstrapAdmin(print = console.log) {
    if (this.db.prepare("SELECT COUNT(*) AS n FROM admins").get().n > 0) return null;
    let username = this.config.adminUsername, password = this.config.adminPassword, generated = false;
    if (!username || !password) { username = username || "admin"; password = C.randomToken(15); generated = true; }
    if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
    await this._createAdmin(username, password);
    if (generated) print(`\n  First administrator created for the Developer Console.\n  Username: ${username}\n  Password: ${password}\n  This is shown ONCE. Sign in and change it.\n`);
    return { username, generated };
  }
  async _createAdmin(username, password) {
    this.db.prepare("INSERT INTO admins (username, password_hash, created_at) VALUES (?,?,?)").run(username, await C.hashPassword(password), this.now());
  }

  async adminLogin({ username, password, ip }) {
    const lower = typeof username === "string" ? username.trim().toLowerCase().slice(0, 64) : "";
    const keys = [`a:${lower}|${ip}`, `aip:${ip}`];
    const locks = keys.map((k) => this.adminFails.check(k)).filter((l) => l.locked);
    if (locks.length) throw new AuthError("rate_limited", { retryAfterSeconds: Math.ceil(Math.max(...locks.map((l) => l.retryAfterMs)) / 1000) });
    const admin = lower ? this.db.prepare("SELECT * FROM admins WHERE username = ?").get(lower) : null;
    const ok = typeof password === "string" && password && password.length <= C.MAX_PASSWORD_LENGTH && (admin ? await C.verifyPassword(password, admin.password_hash) : await C.verifyAgainstDummy(password));
    if (!admin || !ok) { keys.forEach((k) => this.adminFails.fail(k)); this.audit("admin?", "admin_login_failed", lower.slice(0, 40), null, ip); throw new AuthError("invalid_credentials"); }
    this.adminFails.success(keys[0]);
    const token = C.randomToken(32), csrf = C.randomToken(24), t = this.now();
    this.db.prepare("INSERT INTO admin_sessions (token_hash, admin_id, csrf, created_at, last_used_at, ip) VALUES (?,?,?,?,?,?)").run(C.sha256Hex(token), admin.id, csrf, t, t, ip || null);
    this.db.prepare("UPDATE admins SET last_login_at = ? WHERE id = ?").run(t, admin.id);
    this.audit(`admin:${admin.username}`, "admin_login", null, null, ip);
    return { token, csrf, username: admin.username };
  }
  adminFromToken(token) {
    if (typeof token !== "string" || token.length < 20) return null;
    const hash = C.sha256Hex(token), t = this.now();
    const s = this.db.prepare("SELECT s.*, a.username FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?").get(hash);
    if (!s) return null;
    if (t - s.last_used_at > this.config.adminIdleSeconds || t - s.created_at > this.config.adminMaxSeconds) { this.db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(hash); return null; }
    this.db.prepare("UPDATE admin_sessions SET last_used_at = ? WHERE token_hash = ?").run(t, hash);
    return { adminId: s.admin_id, username: s.username, csrf: s.csrf, tokenHash: hash };
  }
  adminLogout(token) { if (typeof token === "string") this.db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(C.sha256Hex(token)); }
  async adminChangePassword(adminId, current, next, keepTokenHash) {
    const admin = this.db.prepare("SELECT * FROM admins WHERE id = ?").get(adminId);
    if (!admin || !(await C.verifyPassword(String(current || ""), admin.password_hash))) throw new AuthError("invalid_credentials");
    if (typeof next !== "string" || next.length < 12 || next.length > C.MAX_PASSWORD_LENGTH) throw Object.assign(new AuthError("bad_request"), { message: "Administrator password must be at least 12 characters." });
    this.db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(await C.hashPassword(next), adminId);
    this.db.prepare("DELETE FROM admin_sessions WHERE admin_id = ? AND token_hash != ?").run(adminId, keepTokenHash || "");
    this.audit(`admin:${admin.username}`, "admin_password_change", null, null, null);
    return { ok: true };
  }
}

module.exports = { LicenseService, AuthError, MESSAGES };
