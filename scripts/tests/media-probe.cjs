// Jonah's own panel asks for the microphone and camera with NO prompt-accepting test switch (only Chromium's fake devices), and the owner's
// whale logo on the new tab page and on the voice orb. (Local DevTools port, throwaway profile, test only.)
const fs = require("fs");
const port = process.argv[2] || 9340, shot = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(p, m = "GET") { return (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json(); }
function session(u) { const ws = new WebSocket(u); let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return { ready: new Promise((r) => (ws.onopen = r)), send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) }; }
async function ev(s, e) { const r = await s.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? { EXC: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text } : r.result?.result?.value; }
const media = (c) => `Promise.race([navigator.mediaDevices.getUserMedia(${JSON.stringify(c)}).then(s => { const t = s.getTracks().map(x => x.kind + ":" + x.readyState); s.getTracks().forEach(x => x.stop()); return "granted " + t.join(","); }, e => "refused: " + e.name), new Promise(r => setTimeout(() => r("no answer in 6 s (a prompt is waiting)"), 6000))])`;
(async () => {
  for (let i = 0; i < 60; i++) { try { await j("/json/version"); break; } catch { await sleep(500); } }
  await sleep(2500);
  const panel = await j("/json/new?" + encodeURIComponent("chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/noah.html"), "PUT");
  await sleep(3000);
  const s = session(panel.webSocketDebuggerUrl); await s.ready;
  console.log("Jonah panel, microphone:", await ev(s, media({ audio: true })));
  console.log("Jonah panel, camera:", await ev(s, media({ video: true })));
  console.log("voice orb picture:", JSON.stringify(await ev(s, `(() => { const i = document.querySelector('#jonah-voice-orb img'); return i ? { src: i.getAttribute('src'), loaded: i.complete && i.naturalWidth } : null; })()`)));
  const site = await j("/json/new?" + encodeURIComponent("https://example.com/"), "PUT");
  await sleep(3000);
  const w = session(site.webSocketDebuggerUrl); await w.ready;
  console.log("website (example.com), camera:", await ev(w, media({ video: true })));
  const nt = await j("/json/new?" + encodeURIComponent("chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/newtab.html"), "PUT");
  await sleep(3500);
  const n = session(nt.webSocketDebuggerUrl); await n.ready;
  await n.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 700, deviceScaleFactor: 1, mobile: false });
  console.log("new tab logo:", JSON.stringify(await ev(n, `(() => { const i = document.querySelector('.logo-area img'); return i ? { src: i.getAttribute('src'), alt: i.alt, loaded: i.complete && i.naturalWidth, shownWidth: Math.round(i.getBoundingClientRect().width) } : null; })()`)));
  if (shot) { await sleep(800); const r = await n.send("Page.captureScreenshot", { format: "png", clip: { x: 340, y: 0, width: 600, height: 320, scale: 1 } }); fs.writeFileSync(shot, Buffer.from(r.result.data, "base64")); }
  process.exit(0);
})().catch((e) => { console.error("probe failed", e); process.exit(1); });
