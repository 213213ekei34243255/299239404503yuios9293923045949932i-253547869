// HTTP surface: the client API (/v1), the Developer Console API (/admin/api) and the console's static files (/admin).
"use strict";
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const C = require("./crypto.cjs");
const { AuthError } = require("./service.cjs");
const { SlidingWindow } = require("./throttle.cjs");

const MAX_BODY = 16 * 1024;
const ADMIN_COOKIE = "jl_admin";
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const STATIC = { "/admin": ["index.html", "text/html; charset=utf-8"], "/admin/": ["index.html", "text/html; charset=utf-8"], "/admin/console.js": ["console.js", "text/javascript; charset=utf-8"], "/admin/console.css": ["console.css", "text/css; charset=utf-8"] };

function clientIp(req, hops) {
  const sock = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (!hops) return sock;
  const chain = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return (chain[chain.length - hops] || sock).replace(/^::ffff:/, "");
}
function isSecure(req, hops) {
  if (req.socket.encrypted) return true;
  if (!hops) return false;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",").pop().trim().toLowerCase();
  return proto === "https";
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new AuthError("bad_request")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString("utf8")); resolve(v && typeof v === "object" ? v : {}); } catch { reject(new AuthError("bad_request")); }
    });
    req.on("error", reject);
  });
}

function createHandler({ service, config, publicDir, log = () => {} }) {
  const globalRate = new SlidingWindow(600, 60000);
  const statics = {};
  for (const [url, [file]] of Object.entries(STATIC)) {
    try { statics[url] = fs.readFileSync(path.join(publicDir, file)); } catch { /* the console files are optional in tests */ }
  }

  function send(res, status, body, type = "application/json; charset=utf-8", extra = {}) {
    const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(data), ...extra });
    res.end(data);
  }
  const json = (res, status, body, extra) => send(res, status, body, undefined, extra);
  const fail = (res, e) => {
    if (e instanceof AuthError) {
      const extra = e.retryAfterSeconds ? { "Retry-After": String(e.retryAfterSeconds) } : {};
      return json(res, e.status, { ok: false, code: e.code, message: e.message, ...(e.retryAfterSeconds ? { retryAfterSeconds: e.retryAfterSeconds } : {}) }, extra);
    }
    log("error", e && e.stack || e);
    return json(res, 500, { ok: false, code: "server_error", message: "Something went wrong on the server." });
  };

  function adminAllowed(ip) { return config.adminEnabled && (!config.adminAllowedIps.length || config.adminAllowedIps.includes(ip)); }

  // Cookie-authenticated admin request. Every change also needs the CSRF header, and a browser Origin (if sent) must be this site.
  function adminAuth(req, res, needCsrf) {
    const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    const admin = service.adminFromToken(token);
    if (!admin) { json(res, 401, { ok: false, code: "session_ended", message: "Please sign in." }); return null; }
    if (needCsrf) {
      const origin = req.headers.origin;
      if (origin) { let host = ""; try { host = new URL(origin).host; } catch { /* below */ } if (host !== req.headers.host) { json(res, 403, { ok: false, code: "bad_request", message: "Cross-site request refused." }); return null; } }
      if (!C.safeEqual(String(req.headers["x-csrf-token"] || ""), admin.csrf)) { json(res, 403, { ok: false, code: "bad_request", message: "Missing or wrong CSRF token." }); return null; }
    }
    return admin;
  }

  async function adminApi(req, res, url, ip, secure) {
    const method = req.method, p = url.pathname.slice("/admin/api".length);
    if (p === "/login" && method === "POST") {
      const origin = req.headers.origin;
      if (origin) { let host = ""; try { host = new URL(origin).host; } catch { /* below */ } if (host !== req.headers.host) return json(res, 403, { ok: false, code: "bad_request", message: "Cross-site request refused." }); }
      const body = await readJson(req);
      const r = await service.adminLogin({ username: body.username, password: body.password, ip });
      const cookie = `${ADMIN_COOKIE}=${r.token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${config.adminMaxSeconds}${secure ? "; Secure" : ""}`;
      return json(res, 200, { ok: true, username: r.username, csrf: r.csrf }, { "Set-Cookie": cookie });
    }
    const write = method !== "GET";
    const admin = adminAuth(req, res, write);
    if (!admin) return;
    const actor = `admin:${admin.username}`;
    const body = write ? await readJson(req) : {};
    let m;
    if (p === "/logout" && method === "POST") {
      service.adminLogout(parseCookies(req.headers.cookie)[ADMIN_COOKIE]);
      return json(res, 200, { ok: true }, { "Set-Cookie": `${ADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0${secure ? "; Secure" : ""}` });
    }
    if (p === "/me" && method === "GET") return json(res, 200, { ok: true, username: admin.username, csrf: admin.csrf });
    if (p === "/overview" && method === "GET") return json(res, 200, { ok: true, ...service.overview() });
    if (p === "/audit" && method === "GET") return json(res, 200, { ok: true, entries: service.listAudit(url.searchParams.get("limit")) });
    if (p === "/settings" && method === "PATCH") return json(res, 200, { ok: true, settings: service.updateSettings(body, actor, ip) });
    if (p === "/password" && method === "POST") { await service.adminChangePassword(admin.adminId, body.current, body.next, admin.tokenHash); return json(res, 200, { ok: true }); }
    if (p === "/accounts" && method === "POST") return json(res, 201, { ok: true, account: await service.createAccount(body, actor, ip) });
    if ((m = /^\/accounts\/(\d+)$/.exec(p))) {
      const id = Number(m[1]);
      if (method === "PATCH") return json(res, 200, { ok: true, account: service.updateAccount(id, body, actor, ip) });
      if (method === "DELETE") return json(res, 200, { ok: true, ...service.deleteAccount(id, actor, ip) });
    }
    if ((m = /^\/accounts\/(\d+)\/password$/.exec(p)) && method === "POST") return json(res, 200, { ok: true, account: await service.setPassword(Number(m[1]), body.password, actor, ip) });
    if ((m = /^\/accounts\/(\d+)\/action$/.exec(p)) && method === "POST") return json(res, 200, { ok: true, account: service.action(Number(m[1]), body.action, actor, ip) });
    return json(res, 404, { ok: false, code: "not_found", message: "No such endpoint." });
  }

  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    try {
      const url = new URL(req.url, "http://localhost");
      const ip = clientIp(req, config.trustProxyHops), secure = isSecure(req, config.trustProxyHops);
      if (secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
      if (url.pathname === "/health") return json(res, 200, { ok: true });
      if (!globalRate.hit(ip)) return fail(res, new AuthError("rate_limited", { retryAfterSeconds: 30 }));
      if (config.requireHttps && !secure) return json(res, 400, { ok: false, code: "https_required", message: "HTTPS is required." });

      if (url.pathname.startsWith("/admin")) {
        if (!adminAllowed(ip)) return json(res, 404, { ok: false, code: "not_found", message: "Not found." });
        if (STATIC[url.pathname] && req.method === "GET") {
          const buf = statics[url.pathname];
          if (!buf) return json(res, 404, { ok: false, code: "not_found", message: "Not found." });
          return send(res, 200, buf, STATIC[url.pathname][1], { "Content-Security-Policy": CSP });
        }
        if (url.pathname.startsWith("/admin/api/")) return await adminApi(req, res, url, ip, secure);
        return json(res, 404, { ok: false, code: "not_found", message: "Not found." });
      }

      if (req.method === "GET" && url.pathname === "/v1/public-keys") return json(res, 200, { ok: true, issuer: config.issuer, audience: config.audience, keys: [{ kid: service.key.kid, alg: "EdDSA", spki: service.key.spki }] });
      if (req.method === "POST" && url.pathname.startsWith("/v1/")) {
        const body = await readJson(req);
        if (url.pathname === "/v1/auth/challenge") return json(res, 200, { ok: true, ...service.issueChallenge(ip) });
        if (url.pathname === "/v1/auth/login") return json(res, 200, await service.login({ ...body, ip }));
        if (url.pathname === "/v1/session/refresh") return json(res, 200, await service.refresh({ ...body, ip }));
        if (url.pathname === "/v1/session/logout") return json(res, 200, service.logout(body));
      }
      return json(res, 404, { ok: false, code: "not_found", message: "No such endpoint." });
    } catch (e) { return fail(res, e); }
  };
}

function createServer(opts) {
  const handler = createHandler(opts);
  const { config } = opts;
  const server = config.tlsCertFile && config.tlsKeyFile
    ? https.createServer({ cert: fs.readFileSync(config.tlsCertFile), key: fs.readFileSync(config.tlsKeyFile) }, handler)
    : http.createServer(handler);
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  return server;
}

module.exports = { createServer, createHandler, clientIp };
