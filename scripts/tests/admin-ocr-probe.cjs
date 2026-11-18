// Tests (read-only) Windows OCR and the administrator-mode plumbing of <dir>\noah-native, talking to it as Jonah does.
// Run with NOAH_TEST_NO_RUNAS=1 so the "elevated" helper starts WITHOUT Windows' permission prompt (same code, same pipe, no elevation).
const { spawn, execSync } = require("child_process");
const fs = require("fs"), path = require("path");
const [dir, png] = process.argv.slice(2);
const child = spawn("cmd.exe", ["/d", "/s", "/c", `"${path.join(dir, "noah-native.cmd")}" chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/`], { windowsVerbatimArguments: true, stdio: ["pipe", "pipe", "inherit"], env: process.env });
let buf = Buffer.alloc(0), seq = 0; const waiting = new Map(); let readyRes; const ready = new Promise((r) => (readyRes = r));
const send = (m) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); child.stdin.write(Buffer.concat([h, b])); };
const call = (method, args, ms = 120_000) => new Promise((res, rej) => { const id = ++seq; const t = setTimeout(() => rej(new Error("timeout " + method)), ms); waiting.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error)) : res(m.value); }); send({ t: "call", id, method, args }); });
child.stdout.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  while (buf.length >= 4) { const n = buf.readUInt32LE(0); if (buf.length < 4 + n) break; const m = JSON.parse(buf.subarray(4, 4 + n).toString("utf8")); buf = buf.subarray(4 + n);
    if (m.t === "ready") readyRes(); else if (m.t === "result") { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } else if (m.t === "admin-state") console.log("  admin-state:", JSON.stringify(m.state)); }
});
const helpers = () => { try { return execSync('powershell -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \\"Name=\'powershell.exe\'\\" | Where-Object { $_.CommandLine -like \'*noah-elevated-host*\' }).Count"', { encoding: "utf8" }).trim(); } catch (_) { return "?"; } };
(async () => {
  await ready;
  send({ t: "hello", signedIn: false, admin: false });
  const t0 = Date.now();
  const lines = await call("ocr", { image: fs.readFileSync(png).toString("base64") });
  console.log(`OCR (${Date.now() - t0} ms incl. start):`, lines.map((l) => `"${l.text}" @${l.rect.x},${l.rect.y} (${l.words.length} words)`).join(" | "));
  console.log("selftest, normal:", JSON.stringify(await call("selftest", {})));
  send({ t: "admin", enabled: true });
  await new Promise((r) => setTimeout(r, 300));
  console.log("selftest, administrator mode:", JSON.stringify(await call("selftest", {})));
  console.log("elevated-helper processes while on:", helpers());
  await call("stop", {}); // Stop: Noah lets go of the helper
  send({ t: "admin", enabled: false }); // resets the helper
  await new Promise((r) => setTimeout(r, 2000));
  console.log("elevated-helper processes after Stop / switch off:", helpers());
  child.stdin.end();
  child.on("exit", () => process.exit(0));
  setTimeout(() => process.exit(1), 8000);
})().catch((e) => { console.error("probe failed:", e.message); child.kill(); process.exit(1); });
