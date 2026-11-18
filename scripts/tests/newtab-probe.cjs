// The new tab: clicking the side dock's buttons (a real mouse click) asks the side panel to open the hub; the news path answers; and the
// Trust Panel view (noah.html#open=trust) without descriptions. (Local DevTools port, throwaway profile.)
const fs = require("fs"), path = require("path");
const port = process.argv[2] || 9346, outDir = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(p, m = "GET") { return (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json(); }
function session(u) { const ws = new WebSocket(u); let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return { ready: new Promise((r) => (ws.onopen = r)), send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) }; }
async function ev(s, e) { const r = await s.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? { EXC: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text } : r.result?.result?.value; }
(async () => {
  for (let i = 0; i < 60; i++) { try { await j("/json/version"); break; } catch { await sleep(500); } }
  await sleep(2500);
  const nt = await j("/json/new?" + encodeURIComponent("chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/newtab.html"), "PUT");
  await sleep(3500);
  const s = session(nt.webSocketDebuggerUrl); await s.ready;
  await s.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  for (const hub of ["game", "creator", "aesthetic"]) {
    const box = await ev(s, `(() => { const b = document.querySelector('.dock-btn[data-hub="${hub}"]'); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, getComputedStyle(b).visibility]; })()`);
    if (!box || box.EXC) { console.log(hub, "button not found", JSON.stringify(box)); continue; }
    await ev(s, "chrome.storage.session.remove('jonahOpen')");
    for (const type of ["mousePressed", "mouseReleased"]) await s.send("Input.dispatchMouseEvent", { type, x: box[0], y: box[1], button: "left", clickCount: 1 });
    await sleep(500);
    console.log(`${hub} button clicked ->`, JSON.stringify(await ev(s, "chrome.storage.session.get('jonahOpen').then(r => r.jonahOpen && r.jonahOpen.view)")));
  }
  console.log("news:", JSON.stringify(await ev(s, `chrome.runtime.sendMessage({ type: "jonah:news", page: 1 }).then(d => d && (d.error || ('articles: ' + (d.articles || []).length)))`)));
  const tp = await j("/json/new?" + encodeURIComponent("chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/noah.html#open=trust"), "PUT");
  await sleep(5500);
  const t = session(tp.webSocketDebuggerUrl); await t.ready;
  await t.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 640, deviceScaleFactor: 1, mobile: false });
  await sleep(1200);
  fs.writeFileSync(path.join(outDir, "trust-panel.png"), Buffer.from((await t.send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
  console.log("trust panel text:", JSON.stringify(await ev(t, "(document.querySelector('.jtp-body') || document.body).innerText.replace(/\\s+/g,' ').slice(0, 200)")));
  process.exit(0);
})().catch((e) => { console.error("probe failed", e); process.exit(1); });
