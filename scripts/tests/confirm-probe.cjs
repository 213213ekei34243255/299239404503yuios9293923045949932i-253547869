// From inside Jonah (local DevTools port, throwaway profile, NOAH_TEST_HOOKS=1): the computer agent asks for an OK -> the card shows
// in Noah's panel -> its Allow button is pressed -> the helper gets "allowed". Then the same with Cancel.
const port = process.argv[2] || 9338;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(p, m = "GET") { return (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json(); }
function session(u) { const ws = new WebSocket(u); let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return { ready: new Promise((r) => (ws.onopen = r)), send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) }; }
async function ev(s, e) { const r = await s.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? { EXC: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text } : r.result?.result?.value; }
const round = (button) => `(async () => {
  const C = window.JonahComputer; await C.connect();
  const answer = C._call("testconfirm", {}, 90000);
  let card = null;
  for (let i = 0; i < 40 && !card; i++) { await new Promise(r => setTimeout(r, 150)); const o = window.NoahOverlay && window.NoahOverlay._instance; card = o && o.root.querySelector(".noah-confirm.noah-visible"); }
  if (!card) return { error: "no card in the panel" };
  const text = card.innerText.replace(/\\s+/g, " ").slice(0, 160);
  const r = card.getBoundingClientRect();
  card.querySelector(${JSON.stringify(button)}).click();
  const res = await answer;
  const still = !!window.NoahOverlay._instance.root.querySelector(".noah-confirm.noah-visible");
  return { cardText: text, cardBox: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], panel: [innerWidth, innerHeight], helperGot: res, cardGone: !still };
})()`;
(async () => {
  for (let i = 0; i < 60; i++) { try { await j("/json/version"); break; } catch { await sleep(500); } }
  await sleep(3000);
  const t = await j("/json/new?" + encodeURIComponent("chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/noah.html"), "PUT");
  await sleep(3000);
  const s = session(t.webSocketDebuggerUrl); await s.ready;
  await s.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 1, mobile: false }); // side panel size
  console.log("Allow:", JSON.stringify(await ev(s, round(".noah-allow"))));
  console.log("Cancel:", JSON.stringify(await ev(s, round(".noah-cancel"))));
  // a picture of the panel with the card showing (then Cancel)
  await ev(s, `(() => { window.__pending = window.JonahComputer._call("testconfirm", {}, 90000); return 1; })()`);
  await sleep(1500);
  const shot = await s.send("Page.captureScreenshot", { format: "png" });
  if (process.argv[3]) require("fs").writeFileSync(process.argv[3], Buffer.from(shot.result.data, "base64"));
  await ev(s, `(async () => { window.NoahOverlay._instance.root.querySelector(".noah-confirm .noah-cancel").click(); return await window.__pending; })()`);
  process.exit(0);
})().catch((e) => { console.error("probe failed", e); process.exit(1); });
