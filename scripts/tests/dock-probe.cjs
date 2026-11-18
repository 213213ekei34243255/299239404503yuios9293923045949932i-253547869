// Why does a click on the new tab's dock not reach the hub opener? What is under the click point, and does the event path work?
const port = process.argv[2] || 9347;
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
  console.log(JSON.stringify(await ev(s, `(async () => {
    const b = document.querySelector('.dock-btn[data-hub="game"]'); const r = b.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const got = []; window.addEventListener("jonah-open-hub", (e) => got.push(e.detail));
    b.click(); await new Promise(r => setTimeout(r, 400));
    const st = await chrome.storage.session.get('jonahOpen');
    return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width)], underPoint: at && (at.className || at.tagName), eventsSeen: got, apiLoaded: !!window.api, sessionSet: st.jonahOpen || null, dockClosed: document.getElementById('hubDock').className };
  })()`)));
  process.exit(0);
})().catch((e) => { console.error("probe failed", e); process.exit(1); });
