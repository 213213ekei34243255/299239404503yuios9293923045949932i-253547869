// Talks to <dir>\noah-native as Jonah does: attaches sample files (reads them with Electron's file-extract.cjs), asks the chat a question
// about them, and transcribes a short sample of silence + checks speech recognition loads. No web search is answered here (the test
// plays Jonah and says the search is not available), so the chat question is about the files.
const { spawn } = require("child_process");
const fs = require("fs"), path = require("path");
const [dir, samples] = process.argv.slice(2);
const child = spawn("cmd.exe", ["/d", "/s", "/c", `"${path.join(dir, "noah-native.cmd")}" chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/`], { windowsVerbatimArguments: true, stdio: ["pipe", "pipe", "inherit"] });
let buf = Buffer.alloc(0), seq = 0; const waiting = new Map(); let readyRes; const ready = new Promise((r) => (readyRes = r));
const send = (m) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); child.stdin.write(Buffer.concat([h, b])); };
const call = (method, args, ms = 180_000) => new Promise((res, rej) => { const id = ++seq; const t = setTimeout(() => rej(new Error("timeout " + method)), ms); waiting.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error)) : res(m.value); }); send({ t: "call", id, method, args }); });
child.stdout.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  while (buf.length >= 4) { const n = buf.readUInt32LE(0); if (buf.length < 4 + n) break; const m = JSON.parse(buf.subarray(4, 4 + n).toString("utf8")); buf = buf.subarray(4 + n);
    if (m.t === "ready") readyRes(); else if (m.t === "result") { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } }
    else if (m.t === "websearch") { console.log("  (chat asked for a web search:", m.query, ")"); send({ t: "rpc-reply", reqId: m.reqId, value: { error: "not available in this test", code: "test" } }); } }
});
(async () => {
  await ready;
  send({ t: "hello", signedIn: false });
  const ids = [];
  for (const f of ["sample.docx", "sample.xlsx", "sample.pptx", "sample.pdf", "ocr-test.png"]) {
    const t0 = Date.now();
    const r = await call("attach", { name: f, data: fs.readFileSync(path.join(samples, f)).toString("base64") });
    console.log(`attach ${f} (${Date.now() - t0} ms):`, r.ok ? `${r.kind}, ${r.chars} chars${r.warnings && r.warnings.length ? ", warnings: " + r.warnings.join("; ") : ""}` : `FAILED ${r.code}: ${r.error}`);
    if (r.ok) ids.push(r.id);
  }
  const q = process.env.Q || "Summarize the attached files in a few lines.";
  const t0 = Date.now();
  const a = await call("chat", { goal: q, attachmentIds: ids });
  console.log(`chat answer (${Date.now() - t0} ms):\n  ` + String(a.text).replace(/\n/g, "\n  "));
  const t1 = Date.now();
  await call("sttWarm", {});
  const silence = Buffer.alloc(16000 * 2); // 1 s of silence, int16
  const tr = await call("transcribe", { pcm: silence.toString("base64") });
  console.log(`speech recognition ready + 1 s of silence transcribed in ${Date.now() - t1} ms: "${tr.text}"`);
  child.stdin.end();
  child.on("exit", () => process.exit(0));
  setTimeout(() => process.exit(1), 8000);
})().catch((e) => { console.error("probe failed:", e.message); child.kill(); process.exit(1); });
