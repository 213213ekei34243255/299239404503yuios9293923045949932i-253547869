// From inside Jonah (local DevTools port, throwaway profile): attachments through the panel, a chat answer about them, a chat question that
// needs a web search, and the wake word switched on with a FAKE microphone (Chromium's test device: a beep, no real audio).
const fs = require("fs"), path = require("path");
const port = process.argv[2] || 9339, samples = process.argv[3], shotOut = process.argv[4];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(p, m = "GET") { return (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json(); }
function session(u) { const ws = new WebSocket(u); let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return { ready: new Promise((r) => (ws.onopen = r)), send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) }; }
async function ev(s, e) { const r = await s.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? { EXC: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text } : r.result?.result?.value; }
const waitFor = (types, ms) => `new Promise((res) => { const got = []; const on = (e) => { if (e.source === window && e.data && ${JSON.stringify(types)}.includes(e.data.type)) { got.push(e.data); if (/goal-(completed|error|paused)|attach-result/.test(e.data.type)) { window.removeEventListener("message", on); res(got); } } }; window.addEventListener("message", on); setTimeout(() => res(got.length ? got : "timeout"), ${ms}); })`;
(async () => {
  for (let i = 0; i < 60; i++) { try { await j("/json/version"); break; } catch { await sleep(500); } }
  await sleep(3000);
  const t = await j("/json/new?" + encodeURIComponent("chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/noah.html"), "PUT");
  await sleep(3500);
  const s = session(t.webSocketDebuggerUrl); await s.ready;
  await s.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 1, mobile: false });
  console.log("orb button in panel:", await ev(s, "!!document.getElementById('jonah-voice-orb')"));
  // 1. attachments, the way the panel's paper-clip sends them
  const ids = [];
  for (const f of ["sample.docx", "sample.pdf", "ocr-test.png"]) {
    const b64 = fs.readFileSync(path.join(samples, f)).toString("base64");
    const r = await ev(s, `(async () => { const p = ${waitFor(["noah:attach-result"], 120000)}; const bin = atob(${JSON.stringify(b64)}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      window.postMessage({ type: "noah:attach-file", reqId: "t-${f}", name: ${JSON.stringify(f)}, data: u.buffer }, "*"); const got = await p; return got[got.length - 1].payload; })()`);
    console.log(`attach ${f}:`, JSON.stringify(r && r.result ? { ok: r.result.ok, kind: r.result.kind, chars: r.result.chars, error: r.result.error } : r));
    if (r && r.result && r.result.ok) ids.push(r.result.id);
  }
  const ask = async (goal, extra) => {
    const t0 = Date.now();
    const got = await ev(s, `(async () => { const p = ${waitFor(["rexy:goal-submitted", "rexy:goal-completed", "rexy:goal-error"], 150000)}; window.postMessage(Object.assign({ type: "rexy:submit-goal", goal: ${JSON.stringify(goal)}, mode: "auto" }, ${JSON.stringify(extra || {})}), "*"); return await p; })()`);
    const last = Array.isArray(got) ? got[got.length - 1] : got;
    console.log(`\n"${goal}" (${Date.now() - t0} ms) -> ${last && last.type}:\n  ` + String(last && last.payload ? (last.payload.reason || last.payload.error) : JSON.stringify(got)).slice(0, 700).replace(/\n/g, "\n  "));
  };
  await ask("What is the launch date and the invoice total in the attached files?", { attachmentIds: ids });
  await ask("What is the latest stable version of Node.js right now?");
  // 3. the wake word, with Chromium's fake microphone
  const wake = await ev(s, `(async () => { const states = []; const on = (e) => { if (e.source === window && e.data && e.data.type === "noah:wake-state") states.push(e.data.payload.phase + (e.data.payload.error ? " (" + e.data.payload.error + ")" : "")); };
    window.addEventListener("message", on); window.postMessage({ type: "noah:wake", enabled: true }, "*"); await new Promise(r => setTimeout(r, 25000)); window.postMessage({ type: "noah:wake", enabled: false }, "*"); await new Promise(r => setTimeout(r, 800)); window.removeEventListener("message", on); return states; })()`);
  console.log("\nwake word states:", JSON.stringify(wake));
  if (shotOut) { const sh = await s.send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(shotOut, Buffer.from(sh.result.data, "base64")); }
  process.exit(0);
})().catch((e) => { console.error("probe failed", e); process.exit(1); });
