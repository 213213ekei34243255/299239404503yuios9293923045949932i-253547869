// Noah/test/unit/hubs-images-ipc.test.cjs - the moodboard image fetcher's safety rules and the hub IPC handlers' access rules.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const I = require("../../../hubs/images.cjs");
const { registerHubIpc } = require("../../../hubs/ipc.cjs");

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);

test("private and local addresses are recognised, public ones are not", () => {
  for (const a of ["localhost", "foo.localhost", "printer.local", "10.0.0.5", "127.0.0.1", "192.168.1.9", "172.16.0.1", "172.31.255.255", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "[::1]", "224.0.0.1", "router.home.arpa"]) assert.equal(I.isPrivateAddress(a), true, a);
  for (const a of ["example.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "100.63.0.1", "2606:4700:4700::1111", "cdn.shopify.com"]) assert.equal(I.isPrivateAddress(a), false, a);
});

test("checkUrl: https only, no logins in the link, no private hosts", () => {
  assert.equal(I.checkUrl("https://example.com/a.jpg").ok, true);
  for (const bad of ["http://example.com/a.jpg", "file:///C:/secret.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "https://user:pw@example.com/a.jpg", "https://localhost/a.png", "https://192.168.0.1/a.png", "https://169.254.169.254/latest/meta-data", "not a url", ""]) assert.equal(I.checkUrl(bad).ok, false, bad);
});

test("sniff trusts the bytes, not the server", () => {
  assert.equal(I.sniff(PNG), "image/png");
  assert.equal(I.sniff(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)])), "image/jpeg");
  assert.equal(I.sniff(Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP"), Buffer.alloc(8)])), "image/webp");
  assert.equal(I.sniff(Buffer.from("<html><script>alert(1)</script></html>")), null);
  assert.equal(I.sniff(Buffer.alloc(3)), null);
});

const res = (body, { status = 200, type = "image/png", headers = {} } = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => ({ "content-type": type, ...headers }[k.toLowerCase()] ?? null) }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) });
const pub = async () => ["93.184.216.34"];

test("fetchImage returns a real image as base64", async () => {
  const r = await I.fetchImage("https://example.com/a.png", { fetchFn: async () => res(PNG), lookup: pub });
  assert.equal(r.ok, true); assert.equal(r.mime, "image/png"); assert.equal(Buffer.from(r.base64, "base64").length, PNG.length);
});

test("fetchImage refuses: a host that RESOLVES to a private address, HTML pretending to be an image, a non-image type, an oversize file, an error status", async () => {
  assert.match((await I.fetchImage("https://sneaky.example/a.png", { fetchFn: async () => res(PNG), lookup: async () => ["10.0.0.7"] })).why, /your own network/);
  assert.match((await I.fetchImage("https://example.com/a.png", { fetchFn: async () => res(Buffer.from("<html>hello hello hello</html>")), lookup: pub })).why, /not a picture/);
  assert.match((await I.fetchImage("https://example.com/a.html", { fetchFn: async () => res(PNG, { type: "text/html" }), lookup: pub })).why, /not an image/);
  assert.match((await I.fetchImage("https://example.com/big.png", { fetchFn: async () => res(PNG, { headers: { "content-length": String(I.MAX_BYTES + 1) } }), lookup: pub })).why, /too big/);
  assert.match((await I.fetchImage("https://example.com/big.png", { fetchFn: async () => res(Buffer.alloc(I.MAX_BYTES + 5, 1)), lookup: pub })).why, /too big/);
  assert.match((await I.fetchImage("https://example.com/a.png", { fetchFn: async () => res(PNG, { status: 404 }), lookup: pub })).why, /404/);
  assert.match((await I.fetchImage("https://nowhere.invalid/a.png", { fetchFn: async () => res(PNG), lookup: async () => { throw new Error("ENOTFOUND"); } })).why, /could not be found/);
});

test("redirects are followed at most 3 times and EVERY hop is re-checked (a public link cannot bounce into the private network)", async () => {
  let calls = 0;
  const toPrivate = async () => { calls++; return res(PNG, { status: 302, headers: { location: "https://192.168.1.1/admin.png" } }); };
  assert.match((await I.fetchImage("https://example.com/a.png", { fetchFn: toPrivate, lookup: pub })).why, /inside your own network/);
  assert.equal(calls, 1);
  const loop = async () => res(PNG, { status: 302, headers: { location: "https://example.com/again.png" } });
  assert.match((await I.fetchImage("https://example.com/a.png", { fetchFn: loop, lookup: pub })).why, /Too many redirects/);
  let n = 0;
  const once = async () => (n++ === 0 ? res(PNG, { status: 301, headers: { location: "/b.png" } }) : res(PNG));
  assert.equal((await I.fetchImage("https://example.com/a.png", { fetchFn: once, lookup: pub })).ok, true);
  const toHttp = async () => res(PNG, { status: 302, headers: { location: "http://example.com/x.png" } });
  assert.match((await I.fetchImage("https://example.com/a.png", { fetchFn: toHttp, lookup: pub })).why, /Only https/);
});

function fakeIpc() { const h = {}; return { handle: (n, f) => { h[n] = f; }, call: (n, sender, ...a) => h[n]({ sender }, ...a) }; }
test("hub IPC: only the browser window may call, only known feeds run, and errors become readable messages", async () => {
  const ipc = fakeIpc(); const win = { webContents: { id: 1 }, isDestroyed: () => false };
  const calls = [];
  registerHubIpc({
    ipcMain: ipc, getMainWindow: () => win, app: { getAppMetrics: () => [{ cpu: { percentCPUUsage: 1.5 }, memory: { workingSetSize: 2048 } }, { cpu: { percentCPUUsage: 0.5 }, memory: { workingSetSize: 1024 } }] },
    client: { giveaways: async (p) => { calls.push(["giveaways", p]); return { items: [1] }; }, epic: async () => ({ free: [] }), deals: async () => { const e = new Error("x"); e.status = 400; throw e; }, search: async (t) => ({ items: [t] }), cheapestFor: async (ids) => ({ items: ids }) },
    monitor: { read: async () => ({ cpu: { loadPct: 5 } }) }, fetchImage: async (u) => ({ ok: true, echoed: u }),
  });
  const other = { id: 2 };
  assert.deepEqual(await ipc.call("hub:feed", other, "giveaways", {}), { ok: false, error: "not allowed" }, "a website's page cannot call it");
  assert.deepEqual(await ipc.call("hub:system", other), { ok: false, error: "not allowed" });
  assert.deepEqual(await ipc.call("hub:fetchImage", other, "https://example.com/a.png"), { ok: false, why: "not allowed" });
  assert.deepEqual(await ipc.call("hub:feed", win.webContents, "giveaways", { platform: "steam" }), { ok: true, data: { items: [1] } });
  assert.deepEqual(calls[0], ["giveaways", { platform: "steam" }]);
  assert.equal((await ipc.call("hub:feed", win.webContents, "constructor", {})).ok, false, "only allow-listed names run");
  assert.equal((await ipc.call("hub:feed", win.webContents, "__proto__", {})).ok, false);
  assert.match((await ipc.call("hub:feed", win.webContents, "deals", {})).error, /refused the request \(400\)/);
  assert.deepEqual((await ipc.call("hub:feed", win.webContents, "search", { title: "portal" })).data, { items: ["portal"] });
  assert.deepEqual((await ipc.call("hub:feed", win.webContents, "cheapestFor", { ids: ["1", "2"] })).data, { items: ["1", "2"] });
  assert.deepEqual((await ipc.call("hub:feed", win.webContents, "cheapestFor", { ids: "not an array" })).data, { items: [] });
  const sys = await ipc.call("hub:system", win.webContents);
  assert.equal(sys.ok, true); assert.deepEqual(sys.data.jonah, { cpuPct: 2, memMB: 3, processes: 2 });
  assert.equal((await ipc.call("hub:fetchImage", win.webContents, "https://example.com/a.png")).echoed, "https://example.com/a.png");
  win.isDestroyed = () => true;
  assert.equal((await ipc.call("hub:feed", win.webContents, "epic", {})).ok, false, "a closed window answers nothing");
});
