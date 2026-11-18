// End-to-end check of Jonah's computer agent from INSIDE the browser (local DevTools port, throwaway profile, test only):
// Noah's panel -> native messaging -> <exe dir>\noah-native (Electron's mission code) -> Windows helper. Read-only: lists windows,
// and sends one Computer-mode task while NOT signed in (so it can only answer "sign in first" - nothing on the desktop moves).
const port = process.argv[2] || 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(p, m = "GET") { return (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json(); }
function session(u) { const ws = new WebSocket(u); let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return { ready: new Promise((r) => (ws.onopen = r)), send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) }; }
async function ev(s, e) { const r = await s.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? { EXC: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text } : r.result?.result?.value; }
(async () => {
  for (let i = 0; i < 60; i++) { try { await j("/json/version"); break; } catch { await sleep(500); } }
  await sleep(3000);
  const t = await j("/json/new?" + encodeURIComponent("chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/noah.html"), "PUT");
  await sleep(3000);
  const s = session(t.webSocketDebuggerUrl); await s.ready;
  console.log("panel has the computer link:", await ev(s, "typeof window.JonahComputer"));
  console.log("connect:", JSON.stringify(await ev(s, "window.JonahComputer.connect().then(st => st, e => ({ error: e.message }))")));
  console.log("selftest:", JSON.stringify(await ev(s, "window.JonahComputer.selftest().then(r => r, e => ({ error: e.message }))")));
  // what the panel does for a message in Computer mode
  const replies = await ev(s, `(async () => {
    const got = [];
    const on = (e) => { if (e.source === window && e.data && /^rexy:goal-/.test(e.data.type || "")) got.push(e.data.type + ": " + JSON.stringify(e.data.payload).slice(0, 200)); };
    window.addEventListener("message", on);
    window.postMessage({ type: "rexy:submit-goal", goal: "open calculator", mode: "computer" }, "*");
    await new Promise(r => setTimeout(r, 15000));
    window.removeEventListener("message", on);
    return got; })()`);
  console.log("Computer mode 'open calculator' (not signed in):"); for (const r of replies || []) console.log("  " + r);
  const tabs = (await j("/json/list")).map((x) => x.url.slice(0, 60));
  console.log("sign-in tab opened:", tabs.some((u) => u.includes("accounts.google.com")));
  process.exit(0);
})().catch((e) => { console.error("probe failed", e); process.exit(1); });
