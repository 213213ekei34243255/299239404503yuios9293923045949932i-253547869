// Jonah started straight onto a site (as the owner's Jonah was): is the Trust card on the page, and does the Trust Panel answer?
const fs = require("fs"), path = require("path");
const port = process.argv[2] || 9344, outDir = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(p, m = "GET") { return (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json(); }
function session(u) { const ws = new WebSocket(u); let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return { ready: new Promise((r) => (ws.onopen = r)), send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) }; }
async function ev(s, e) { const r = await s.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? { EXC: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text } : r.result?.result?.value; }
(async () => {
  for (let i = 0; i < 60; i++) { try { await j("/json/version"); break; } catch { await sleep(500); } }
  await sleep(9000);
  const page = (await j("/json/list")).find((t) => t.type === "page" && /github\.com/.test(t.url));
  const s = session(page.webSocketDebuggerUrl); await s.ready;
  const shot = await s.send("Page.captureScreenshot", { format: "png" });
  const vp = await ev(s, "[innerWidth, innerHeight]");
  fs.writeFileSync(path.join(outDir, "trust-startup.png"), Buffer.from(shot.result.data, "base64"));
  console.log("page", page.url, "viewport", JSON.stringify(vp), "-> trust-startup.png");
  // the Trust Panel's question, from an extension page (as the side panel asks it)
  const ext = await j("/json/new?" + encodeURIComponent("chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/menu.html"), "PUT");
  await sleep(1500);
  const e = session(ext.webSocketDebuggerUrl); await e.ready;
  console.log("Trust Panel 'get':", JSON.stringify(await ev(e, `chrome.runtime.sendMessage({ type: "jonah:trust-cmd", cmd: "get" })`)));
  process.exit(0);
})().catch((e) => { console.error("probe failed", e); process.exit(1); });
