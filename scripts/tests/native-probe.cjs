// Talks to <dir>\noah-native the way Jonah does (native messaging framing) and runs read-only checks:
// startup, state, routing of a few sentences (no model is signed in here, so nothing can actually start), and the Windows helper self-test.
const { spawn } = require("child_process");
const path = require("path");
const dir = process.argv[2];
const child = spawn("cmd.exe", ["/d", "/s", "/c", `"${path.join(dir, "noah-native.cmd")}" chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/`], { windowsVerbatimArguments: true, stdio: ["pipe", "pipe", "inherit"] });
let buf = Buffer.alloc(0), seq = 0;
const waiting = new Map();
const send = (m) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); child.stdin.write(Buffer.concat([h, b])); };
const call = (method, args, ms = 90_000) => new Promise((res, rej) => { const id = ++seq; const t = setTimeout(() => rej(new Error("timeout " + method)), ms); waiting.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error)) : res(m.value); }); send({ t: "call", id, method, args }); });
let readyRes; const ready = new Promise((r) => (readyRes = r));
child.stdout.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0); if (buf.length < 4 + n) break;
    const m = JSON.parse(buf.subarray(4, 4 + n).toString("utf8")); buf = buf.subarray(4 + n);
    if (m.t === "ready") readyRes(m.state);
    else if (m.t === "result") { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } }
    else if (m.t === "event") console.log("  event:", m.evt.event, String(m.evt.text || m.evt.reply || m.evt.summary || "").slice(0, 100));
    else if (m.t === "signin") { console.log("  helper asked Jonah to open the sign-in (test answers: not signed in)"); send({ t: "rpc-reply", reqId: m.reqId, value: { signedIn: false } }); }
    else if (m.t === "sign") send({ t: "rpc-reply", reqId: m.reqId, error: "test: no account" });
    else if (m.t !== "state") console.log("  msg:", m.t);
  }
});
(async () => {
  const t0 = Date.now();
  const st = await Promise.race([ready, new Promise((_, r) => setTimeout(() => r(new Error("no ready in 30 s")), 30_000))]);
  console.log("ready in", Date.now() - t0, "ms; state:", JSON.stringify(st));
  send({ t: "hello", signedIn: false });
  for (const [text, mode] of [["open notepad and write hello", "auto"], ["search youtube for cats", "auto"], ["open calculator", "computer"], ["what is 2+2", "auto"]]) {
    const r = await call("route", { text, mode });
    console.log(`route [${mode}] "${text}" ->`, JSON.stringify(r).slice(0, 220));
  }
  console.log("selftest:", JSON.stringify(await call("selftest", {}, 120_000)));
  child.stdin.end(); // Jonah closing the connection
  const exitAt = Date.now();
  child.on("exit", (code) => { console.log("helper exited", code, "after", Date.now() - exitAt, "ms"); process.exit(0); });
  setTimeout(() => { console.log("helper did NOT exit after the connection closed"); process.exit(1); }, 8000);
})().catch((e) => { console.error("probe failed:", e.message); child.kill(); process.exit(1); });
