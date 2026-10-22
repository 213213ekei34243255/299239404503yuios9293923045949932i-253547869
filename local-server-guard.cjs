// local-server-guard.cjs - the rules for Jonah's two local web servers (main.cjs: 5589 the UI/relay server, 5588 the voice-model file server).
//
// What was wrong (measured 2026-10-22): the UI server served the WHOLE project folder as static files (express.static(__dirname)), only hiding dotfiles. Any web page open in
// Jonah, and any program on the computer, could fetch /market-keys.js (API keys, and a <script> tag can load it cross-origin), /key.json, /entitlements.config.json, the
// source code... And the model server listened on EVERY network interface with no protection.
//
// What this does instead:
//   * only what Jonah's own pages really use is served as a file (search.html and images under assets/); everything else is "404", not "forbidden" (nothing is confirmed to exist)
//   * the Host header must be this machine's loopback name (defeats DNS rebinding: a website that points its own name at 127.0.0.1)
//   * another site cannot load those files as a script, image, style, font, frame ... (Sec-Fetch-* check, plus Cross-Origin-Resource-Policy as a second lock)
//   * path tricks (.., encoded dots and slashes, double encoding, backslashes, NUL, hidden files) are refused outright
// The /api/* relay routes keep their own origin check (search-proxy.cjs); the Host check applies to them too.
"use strict";

const PUBLIC_FILES = new Set(["search.html"]);
const PUBLIC_DIRS = ["assets/"];
const PUBLIC_DIR_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico|avif)$/i;

/** The path part of a request URL ("/a/b?x=1#y" -> "/a/b"), or null for anything that is not a plain path. */
function pathnameOf(rawUrl) {
  const s = String(rawUrl == null ? "" : rawUrl);
  if (!s.startsWith("/") || s.startsWith("//")) return null; // absolute-form, protocol-relative or empty: not a path on this server
  const end = s.search(/[?#]/);
  return end === -1 ? s : s.slice(0, end);
}

/** Is this request path one of the few files Jonah serves? Strict: one level of decoding only, and anything still looking encoded afterwards is refused. */
function isPublicPath(rawUrl) {
  const raw = pathnameOf(rawUrl);
  if (raw === null || raw === "/") return false;
  if (/[\\\u0000-\u001f]/.test(raw) || /%00|%5c|%2f|%2e|%25/i.test(raw)) return false; // backslash, control chars, and ENCODED dots / slashes / percent signs
  let p;
  try { p = decodeURIComponent(raw); } catch (_) { return false; }
  if (/[\\\u0000-\u001f]/.test(p) || p.includes("%")) return false;
  const rel = p.slice(1).toLowerCase();
  const parts = rel.split("/");
  if (parts.some((seg) => seg === "" || seg === "." || seg === ".." || seg.startsWith("."))) return false;
  if (PUBLIC_FILES.has(rel)) return true;
  return PUBLIC_DIRS.some((d) => rel.startsWith(d)) && PUBLIC_DIR_EXT.test(rel);
}

/** The Host header must name loopback on THIS server's port (or be absent, as in HTTP/1.0 tools: they cannot be a browser victim of rebinding). */
function hostAllowed(hostHeader, port) {
  if (hostHeader === undefined || hostHeader === "") return true;
  const m = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/i.exec(String(hostHeader).trim());
  return !!m && (m[2] === undefined ? Number(port) === 80 : Number(m[2]) === Number(port));
}

/** Fetch-metadata check: a request that comes from ANOTHER origin (a different site, or the same machine on another port) may only navigate to a page, never embed a file. */
function crossSiteSubresource(headers) {
  const site = String(headers["sec-fetch-site"] || "").toLowerCase();
  const dest = String(headers["sec-fetch-dest"] || "").toLowerCase();
  if (!site || site === "same-origin" || site === "none") return false;
  return dest !== "document"; // iframe, script, image, style, font, audio, video, object, embed, worker ... all refused (and an empty dest = fetch/XHR from another origin)
}

function hostGuard(port) {
  return (req, res, next) => {
    if (!hostAllowed(req.headers.host, port)) { res.status(400).type("text/plain").send("Bad host"); return; }
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  };
}

/** Middleware: serves only the public files from `root`; every other path is a plain 404. `express` is passed in so this file stays testable without the app. */
function publicStatic(express, root) {
  const serve = express.static(root, { dotfiles: "deny", index: false, redirect: false, fallthrough: false });
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (!isPublicPath(req.url)) { res.status(404).type("text/plain").send("Not found"); return; }
    if (crossSiteSubresource(req.headers)) { res.status(403).type("text/plain").send("Not allowed"); return; }
    serve(req, res, (err) => { if (err) { const gone = err.status === 404 || err.status === 403; res.status(gone ? 404 : 400).type("text/plain").send(gone ? "Not found" : "Bad request"); } else next(); });
  };
}

/** The voice-model server: loopback only, only the model folder, no index, no dotfiles, not embeddable from another origin. */
function modelStatic(express, root) {
  const serve = express.static(root, { dotfiles: "deny", index: false, redirect: false, fallthrough: false });
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.status(405).end(); return; }
    const p = pathnameOf(req.url);
    if (p === null || /[\\\u0000-\u001f]|%2e|%2f|%5c|%00|\.\./i.test(p)) { res.status(404).type("text/plain").send("Not found"); return; }
    if (crossSiteSubresource(req.headers)) { res.status(403).type("text/plain").send("Not allowed"); return; }
    serve(req, res, (err) => { const gone = err && (err.status === 404 || err.status === 403); res.status(gone ? 404 : 400).type("text/plain").send(gone ? "Not found" : "Bad request"); });
  };
}

module.exports = { pathnameOf, isPublicPath, hostAllowed, crossSiteSubresource, hostGuard, publicStatic, modelStatic, PUBLIC_FILES, PUBLIC_DIRS };
