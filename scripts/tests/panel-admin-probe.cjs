// From inside Jonah (local DevTools port, throwaway profile, test only): the panel's administrator switch messages and OCR through the panel.
const port = process.argv[2] || 9337, png = process.argv[3];
const fs = require("fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(p, m = "GET") { return (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json(); }
function session(u) { const ws = new WebSocket(u); let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return { ready: new Promise((r) => (ws.onopen = r)), send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) }; }
async function ev(s, e) { const r = await s.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? { EXC: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text } : r.result?.result?.value; }
const adminMsg = (cmd, extra) => `new Promise((res) => { const on = (e) => { if (e.source === window && e.data && e.data.type === "noah:admin-state") { window.removeEventListener("message", on); res(e.data.payload); } };
  window.addEventListener("message", on); window.postMessage(Object.assign({ type: "noah:cmd", cmd: ${JSON.stringify(cmd)} }, ${JSON.stringify(extra || {})}), "*"); setTimeout(() => res("no answer"), 8000); })`;
(async () => {
  for (let i = 0; i < 60; i++) { try { await j("/json/version"); break; } catch { await sleep(500); } }
  await sleep(3000);
  const t = await j("/json/new?" + encodeURIComponent("chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/noah.html"), "PUT");
  await sleep(3000);
  const s = session(t.webSocketDebuggerUrl); await s.ready;
  console.log("admin-get (off by default):", JSON.stringify(await ev(s, adminMsg("admin-get"))));
  console.log("switch shown in panel:", await ev(s, "!document.getElementById('noahAdminRow').hidden"));
  console.log("admin-set on:", JSON.stringify(await ev(s, adminMsg("admin-set", { enabled: true }))));
  console.log("remembered:", JSON.stringify(await ev(s, "chrome.storage.local.get('jonahNoahAdmin')")));
  console.log("selftest via panel (administrator way):", JSON.stringify(await ev(s, "window.JonahComputer.selftest().then(r => r, e => ({ error: e.message }))")));
  const b64 = fs.readFileSync(png).toString("base64");
  console.log("OCR via panel:", JSON.stringify(await ev(s, `window.JonahComputer.ocr(${JSON.stringify(b64)}).then(l => l.map(x => x.text), e => ({ error: e.message }))`)));
  console.log("admin-set off:", JSON.stringify(await ev(s, adminMsg("admin-set", { enabled: false }))));
  process.exit(0);
})().catch((e) => { console.error("probe failed", e); process.exit(1); });
