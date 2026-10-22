// Noah/test/unit/local-server-guard.test.cjs - the rules for Jonah's local servers (local-server-guard.cjs): which files are served, who may ask, and what a hostile page or program cannot do.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const G = require("../../../local-server-guard.cjs");

test("only search.html and images under assets/ are public", () => {
  for (const p of ["/search.html", "/search.html?q=a", "/search.html#x", "/assets/IO.png", "/assets/pay/card.png", "/assets/logo.jpeg", "/ASSETS/IO.PNG", "/Search.HTML", "/assets/icon.svg"]) assert.equal(G.isPublicPath(p), true, p);
});

test("everything else is refused: secrets, source, config, listings, hidden files, other file types under assets/", () => {
  for (const p of ["/", "", "/market-keys.js", "/key.json", "/package.json", "/package-lock.json", "/main.cjs", "/preload.cjs", "/entitlements.config.json", "/billing-links.config.json", "/.env", "/.env.local", "/.git/config",
    "/Noah/docs/AUTONOMY.md", "/Rexy/runtime.cjs", "/Trust/engine.cjs", "/node_modules/express/index.js", "/home.html", "/index.html", "/assets/", "/assets", "/assets/a.js", "/assets/notes.txt", "/assets/data.json", "/assets/.hidden.png", "/assets/x.png.exe", "/search.html/", "/search.html.bak", "/search.htm"]) assert.equal(G.isPublicPath(p), false, p || "(empty)");
});

test("path tricks never reach a file: dot-dot, encoded dots and slashes, double encoding, backslashes, NUL, malformed encoding, absolute and protocol-relative forms", () => {
  for (const p of ["/assets/../key.json", "/assets/../../key.json", "/assets/./IO.png", "/assets/%2e%2e/key.json", "/assets/%2E%2E/key.json", "/assets/..%2fkey.json", "/assets/%2e%2e%2fkey.json", "/assets/%252e%252e/key.json", "/assets/%25%32%65/key.json",
    "/assets\\..\\key.json", "/assets/..\\key.json", "/search.html%00.js", "/assets/IO.png%00", "/assets/IO.png\u0000", "/%2e%2e/%2e%2e/windows/win.ini", "/assets/%", "/assets/%zz.png", "/assets//IO.png", "//assets/IO.png", "//evil.example/search.html",
    "http://127.0.0.1:5589/search.html", "search.html", "/assets/IO.png/../../key.json", "/assets/%5c..%5ckey.json", "/assets/IO.png%2f..%2f..%2fkey.json"]) assert.equal(G.isPublicPath(p), false, JSON.stringify(p));
});

test("pathnameOf: a plain path, query and fragment stripped; anything else is null", () => {
  assert.equal(G.pathnameOf("/a/b?x=1#y"), "/a/b"); assert.equal(G.pathnameOf("/a#frag"), "/a");
  for (const bad of ["a/b", "", null, undefined, "//host/x", "http://x/y"]) assert.equal(G.pathnameOf(bad), null, String(bad));
});

test("Host header: only loopback on THIS port (a website pointing its own name at 127.0.0.1 is refused)", () => {
  for (const h of ["127.0.0.1:5589", "localhost:5589", "LOCALHOST:5589", "[::1]:5589", undefined, ""]) assert.equal(G.hostAllowed(h, 5589), true, String(h));
  for (const h of ["evil.example:5589", "127.0.0.1.evil.example:5589", "evil.example", "127.0.0.1:5588", "127.0.0.1:80", "localhost.evil.example:5589", "127.0.0.1:5589@evil.example", "0.0.0.0:5589", "192.168.1.5:5589", "127.0.0.1:5589, evil.example", " 127.0.0.1:55890"]) assert.equal(G.hostAllowed(h, 5589), false, h);
  assert.equal(G.hostAllowed("127.0.0.1", 80), true);
});

test("fetch metadata: another origin may only NAVIGATE to a page; same-origin, user navigation and tools with no headers are fine", () => {
  const h = (site, dest) => ({ "sec-fetch-site": site, "sec-fetch-dest": dest });
  for (const x of [h("same-origin", "script"), h("same-origin", "image"), h("none", "document"), h("cross-site", "document"), h("same-site", "document"), {}, h("", "")]) assert.equal(G.crossSiteSubresource(x), false, JSON.stringify(x));
  for (const x of [h("cross-site", "script"), h("cross-site", "image"), h("same-site", "script"), h("same-site", "image"), h("cross-site", "iframe"), h("cross-site", "style"), h("cross-site", "font"), h("cross-site", "empty"), h("cross-site", ""), h("same-site", "audio"), h("cross-site", "object"), h("cross-site", "worker")]) assert.equal(G.crossSiteSubresource(x), true, JSON.stringify(x));
});

// ------------------------------------------------------------------ a real server using the real middleware

function raw(port, { path: p, headers = {}, method = "GET" }) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers, agent: false }, (res) => { let b = ""; res.on("data", (d) => { b += d; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    r.on("error", reject); r.end();
  });
}
async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-guard-"));
  fs.mkdirSync(path.join(root, "assets", "pay"), { recursive: true });
  fs.writeFileSync(path.join(root, "search.html"), "<html>search page</html>");
  fs.writeFileSync(path.join(root, "assets", "IO.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(root, "assets", "secret.txt"), "not public");
  fs.writeFileSync(path.join(root, "market-keys.js"), "window.JONAH_MARKET_KEYS = { twelveData: 'SECRET-KEY' };");
  fs.writeFileSync(path.join(root, "key.json"), "SECRET-TOKEN");
  fs.writeFileSync(path.join(root, ".env"), "JONAH_PROXY_KEY=SECRET");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const app = express();
  let port = 0;
  app.use((req, res, next) => G.hostGuard(port)(req, res, next));
  app.get("/api/ping", (_req, res) => res.json({ ok: true }));
  app.use(G.publicStatic(express, root));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  port = server.address().port;
  try { await fn(port); } finally { server.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test("a real server: the public files work, the secrets are 404 (not 403), and nothing secret is ever in a response", async () => {
  await withServer(async (port) => {
    const ok = await raw(port, { path: "/search.html" });
    assert.equal(ok.status, 200); assert.match(ok.body, /search page/);
    assert.equal(ok.headers["cross-origin-resource-policy"], "same-origin"); assert.equal(ok.headers["x-content-type-options"], "nosniff");
    assert.equal((await raw(port, { path: "/assets/IO.png" })).status, 200);
    assert.equal((await raw(port, { path: "/api/ping" })).status, 200, "API routes are not affected by the file rules");
    for (const p of ["/market-keys.js", "/key.json", "/.env", "/package.json", "/assets/secret.txt", "/", "/assets/", "/assets/../key.json", "/assets/%2e%2e/key.json", "/assets/%2e%2e%2fkey.json", "/assets%2f..%2fkey.json", "/assets\\..\\key.json", "/%2e%2e/key.json", "/search.html/../key.json"]) {
      const r = await raw(port, { path: p });
      assert.equal(r.status, 404, p + " -> " + r.status);
      assert.ok(!/SECRET/.test(r.body), p + " leaked");
    }
    assert.equal((await raw(port, { path: "/search.html", method: "POST" })).status, 404, "only GET and HEAD serve files");
    assert.equal((await raw(port, { path: "/search.html", method: "HEAD" })).status, 200);
  });
});

test("a real server: a spoofed Host (DNS rebinding) is refused, for files AND for the API", async () => {
  await withServer(async (port) => {
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1.evil.example:${port}`, "127.0.0.1:1", `192.168.1.9:${port}`]) {
      assert.equal((await raw(port, { path: "/search.html", headers: { Host: host } })).status, 400, host);
      assert.equal((await raw(port, { path: "/api/ping", headers: { Host: host } })).status, 400, "api " + host);
    }
    assert.equal((await raw(port, { path: "/search.html", headers: { Host: `localhost:${port}` } })).status, 200);
  });
});

test("a real server: another page cannot embed the files (script / image / frame / fetch), but the user can navigate to them", async () => {
  await withServer(async (port) => {
    for (const [site, dest] of [["cross-site", "script"], ["cross-site", "image"], ["same-site", "script"], ["same-site", "image"], ["cross-site", "iframe"], ["cross-site", "empty"]]) {
      const r = await raw(port, { path: "/assets/IO.png", headers: { "Sec-Fetch-Site": site, "Sec-Fetch-Dest": dest } });
      assert.equal(r.status, 403, `${site}/${dest}`);
    }
    assert.equal((await raw(port, { path: "/search.html", headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "document" } })).status, 200, "a click from another page navigates there");
    assert.equal((await raw(port, { path: "/search.html", headers: { "Sec-Fetch-Site": "none", "Sec-Fetch-Dest": "document" } })).status, 200, "typing the address");
    assert.equal((await raw(port, { path: "/assets/IO.png", headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "image" } })).status, 200, "the page's own images");
  });
});

test("the model server: refuses traversal, non-GET and cross-origin embedding; serves its own files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-model-"));
  fs.writeFileSync(path.join(root, "model.onnx"), "MODEL"); fs.writeFileSync(path.join(root, ".hidden"), "H");
  const outside = path.join(path.dirname(root), "outside-secret.txt"); fs.writeFileSync(outside, "OUTSIDE");
  const app = express(); let port = 0;
  app.use((req, res, next) => G.hostGuard(port)(req, res, next)); app.use(G.modelStatic(express, root));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); }); port = server.address().port;
  try {
    assert.equal((await raw(port, { path: "/model.onnx" })).status, 200);
    for (const p of ["/.hidden", "/../outside-secret.txt", "/%2e%2e/outside-secret.txt", "/..%2foutside-secret.txt", "/nope.bin", "/", "/\\..\\outside-secret.txt"]) { const r = await raw(port, { path: p }); assert.ok([404, 403].includes(r.status) && !/OUTSIDE/.test(r.body), p + " -> " + r.status); }
    assert.equal((await raw(port, { path: "/model.onnx", method: "POST" })).status, 405);
    assert.equal((await raw(port, { path: "/model.onnx", headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "script" } })).status, 403);
    assert.equal((await raw(port, { path: "/model.onnx", headers: { Host: "evil.example" } })).status, 400);
  } finally { server.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { force: true }); }
});

test("main.cjs really uses the guard: loopback binding, the host guard, no whole-folder static", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "..", "main.cjs"), "utf8");
  assert.match(src, /modelServer\.listen\(5588, "127\.0\.0\.1"/);
  assert.match(src, /uiServer\.listen\(5589, "127\.0\.0\.1"/);
  assert.match(src, /modelServer\.use\(serverGuard\.hostGuard\(5588\)\)/); assert.match(src, /uiServer\.use\(serverGuard\.hostGuard\(5589\)\)/);
  assert.match(src, /uiServer\.use\(serverGuard\.publicStatic\(express, __dirname\)\)/);
  assert.doesNotMatch(src, /express\.static\(__dirname/, "the project folder is never served as static files again");
  assert.doesNotMatch(src, /modelServer\.listen\(5588, \(\)/, "the model server is not on every interface");
});
