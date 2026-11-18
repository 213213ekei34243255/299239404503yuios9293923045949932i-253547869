// Opens sites in a throwaway Jonah profile (local DevTools port, test only) and takes a picture of the top-right corner, where the
// Trust Score card appears (the card is in a closed layer, so it is checked by looking at it, as a person would).
const fs = require("fs"), path = require("path");
const port = process.argv[2] || 9342, outDir = process.argv[3], sites = process.argv.slice(4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(p, m = "GET") { return (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json(); }
function session(u) { const ws = new WebSocket(u); let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return { ready: new Promise((r) => (ws.onopen = r)), send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) }; }
(async () => {
  for (let i = 0; i < 60; i++) { try { await j("/json/version"); break; } catch { await sleep(500); } }
  await sleep(3000);
  const first = (await j("/json/list")).find((t) => t.type === "page");
  for (const [i, url] of sites.entries()) {
    const s = session(first.webSocketDebuggerUrl); await s.ready;
    await s.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await s.send("Page.navigate", { url });
    const wait = url.includes("github") ? 6000 : 40000; // a full check takes up to ~40 s with its searches
    await sleep(wait);
    const shot = await s.send("Page.captureScreenshot", { format: "png", clip: { x: 1000, y: 0, width: 280, height: 330, scale: 1 } });
    const f = path.join(outDir, `trustcard-${i + 1}.png`);
    fs.writeFileSync(f, Buffer.from(shot.result.data, "base64"));
    console.log(url, "->", f);
  }
  process.exit(0);
})().catch((e) => { console.error("probe failed", e); process.exit(1); });
