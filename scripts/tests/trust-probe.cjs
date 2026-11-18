// Talks to <dir>\noah-native as Jonah's background does and runs Trust Engine checks. Web searches are answered "not available in this
// test" (so this shows how the engine copes without them); Reddit and noahai.live are real requests.
const { spawn } = require("child_process");
const path = require("path");
const [dir, ...hosts] = process.argv.slice(2);
const child = spawn("cmd.exe", ["/d", "/s", "/c", `"${path.join(dir, "noah-native.cmd")}" chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/`], { windowsVerbatimArguments: true, stdio: ["pipe", "pipe", "inherit"] });
let buf = Buffer.alloc(0), seq = 0, searches = 0; const waiting = new Map(); let readyRes; const ready = new Promise((r) => (readyRes = r));
const send = (m) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); child.stdin.write(Buffer.concat([h, b])); };
const call = (method, args, ms = 130_000) => new Promise((res, rej) => { const id = ++seq; const t = setTimeout(() => rej(new Error("timeout " + method)), ms); waiting.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error)) : res(m.value); }); send({ t: "call", id, method, args }); });
child.stdout.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  while (buf.length >= 4) { const n = buf.readUInt32LE(0); if (buf.length < 4 + n) break; const m = JSON.parse(buf.subarray(4, 4 + n).toString("utf8")); buf = buf.subarray(4 + n);
    if (m.t === "ready") readyRes(); else if (m.t === "result") { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } }
    else if (m.t === "websearch") { searches++; send({ t: "rpc-reply", reqId: m.reqId, value: { error: "not available in this test", code: "test" } }); } }
});
(async () => {
  await ready;
  send({ t: "hello", signedIn: false });
  for (const host of hosts) {
    const before = searches, t0 = Date.now();
    const r = await call("trustCheck", { host });
    const x = r.result || {};
    console.log(`\n${host} (${Math.round((Date.now() - t0) / 1000)} s, ${searches - before} web searches asked):`, r.ok ? "" : JSON.stringify(r));
    if (r.ok) console.log(`  score ${x.score}/100 | ${x.security} | risk ${x.riskLevel || "-"} | confidence ${x.confidenceScore ?? "-"} | source ${x.source}\n  issues: ${JSON.stringify((x.issues || []).slice(0, 3))}\n  unknown: ${JSON.stringify(x.unknownSources || [])}`);
  }
  const again = await call("trustCheck", { host: hosts[hosts.length - 1] });
  console.log(`\nsame site again: cached=${again.cached}`);
  child.stdin.end(); child.on("exit", () => process.exit(0)); setTimeout(() => process.exit(1), 8000);
})().catch((e) => { console.error("probe failed:", e.message); child.kill(); process.exit(1); });
