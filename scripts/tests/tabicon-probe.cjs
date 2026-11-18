// The new tab page: big Jonah artwork back at the top, and the tab's icon is the owner's whale. (Local DevTools port, throwaway profile.)
const fs = require("fs");
const port = process.argv[2] || 9341, shot = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(p, m = "GET") { return (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json(); }
function session(u) { const ws = new WebSocket(u); let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return { ready: new Promise((r) => (ws.onopen = r)), send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) }; }
async function ev(s, e) { const r = await s.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? { EXC: r.result.exceptionDetails.text } : r.result?.result?.value; }
(async () => {
  for (let i = 0; i < 60; i++) { try { await j("/json/version"); break; } catch { await sleep(500); } }
  await sleep(2500);
  const nt = await j("/json/new?" + encodeURIComponent("chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/newtab.html"), "PUT");
  await sleep(3500);
  const n = session(nt.webSocketDebuggerUrl); await n.ready;
  await n.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 700, deviceScaleFactor: 1, mobile: false });
  console.log("top artwork:", JSON.stringify(await ev(n, `(() => { const i = document.querySelector('.logo-area img'); return { src: i.getAttribute('src'), loaded: i.naturalWidth, shownWidth: Math.round(i.getBoundingClientRect().width) }; })()`)));
  console.log("tab icon reported by the browser:", JSON.stringify(await ev(n, `chrome.tabs.query({}).then(ts => ts.filter(t => (t.url || '').endsWith('newtab.html')).map(t => t.favIconUrl))`)));
  if (shot) { await sleep(600); const r = await n.send("Page.captureScreenshot", { format: "png", clip: { x: 240, y: 0, width: 800, height: 420, scale: 0.6 } }); fs.writeFileSync(shot, Buffer.from(r.result.data, "base64")); }
  process.exit(0);
})().catch((e) => { console.error("probe failed", e); process.exit(1); });
