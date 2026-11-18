// Jonah starts on a site; then Chromium's background is put to sleep (as it does after ~30 s idle) and the site reloaded: the card must
// come back. Then the Trust Panel's question ("get") must answer with the site's score.
const fs = require("fs"), path = require("path");
const port = process.argv[2] || 9345, outDir = process.argv[3];
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
  const workers = (await j("/json/list")).filter((t) => t.type === "service_worker").length;
  await s.send("ServiceWorker.enable");
  console.log("stopping Jonah's background (service workers running:", workers, ")", JSON.stringify((await s.send("ServiceWorker.stopAllWorkers")).error || "ok"));
  await sleep(2000);
  await s.send("Page.reload");
  await sleep(9000);
  fs.writeFileSync(path.join(outDir, "trust-after-sleep.png"), Buffer.from((await s.send("Page.captureScreenshot", { format: "png", clip: { x: 980, y: 0, width: 300, height: 220, scale: 1 } })).result.data, "base64"));
  console.log("after sleep + reload -> trust-after-sleep.png");
  // the Trust Panel (an extension page) asks about the active tab = GitHub
  const ext = await j("/json/new?" + encodeURIComponent("chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/menu.html"), "PUT");
  await sleep(1500);
  const e = session(ext.webSocketDebuggerUrl); await e.ready;
  console.log("Trust Panel 'get':", JSON.stringify(await ev(e, `(async () => { const [gh] = await chrome.tabs.query({ url: "https://github.com/*" }); await chrome.tabs.update(gh.id, { active: true }); await new Promise(r => setTimeout(r, 500));
    const r = await chrome.runtime.sendMessage({ type: "jonah:trust-cmd", cmd: "get" }); return r && { enabled: r.enabled, host: r.host, score: r.result && r.result.score, verdict: r.result && r.result.security }; })()`)));
  process.exit(0);
})().catch((e) => { console.error("probe failed", e); process.exit(1); });
