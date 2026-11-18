// Watches a real Noah task started by the noah.html#agent= test switch (through a local DevTools port, test only) and grades the quiz.
const port = process.argv[2] || 9334, host = process.argv[3] || "peppy-manatee";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(p) { return (await fetch(`http://127.0.0.1:${port}${p}`)).json(); }
function session(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const ready = new Promise((r) => (ws.onopen = r));
  return { ready, close: () => ws.close(), send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) };
}
async function ev(s, expr) { const r = await s.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? { EXC: r.result.exceptionDetails.text } : r.result?.result?.value; }
(async () => {
  for (let i = 0; i < 60; i++) { try { await j("/json/version"); break; } catch { await sleep(500); } }
  const t0 = Date.now(); let panel, last = "";
  while (Date.now() - t0 < 12 * 60_000) {
    await sleep(10_000);
    const list = await j("/json/list");
    if (!panel) { const p = list.find((x) => x.url.includes("noah.html")); if (p) { panel = session(p.webSocketDebuggerUrl); await panel.ready; } }
    const st = panel ? await ev(panel, `(() => { const a = window.JonahNoah && window.JonahNoah.agent; const c = a && a.current; return c ? { status: c.status, step: c.step } : { done: !!a }; })()`) : null;
    const s = JSON.stringify(st); if (s !== last) { console.log(Math.round((Date.now() - t0) / 1000) + "s", s); last = s; }
    if (st && st.done) break;
  }
  const page = (await j("/json/list")).find((x) => x.url.includes(host));
  if (!page) { console.log("quiz tab not found"); process.exit(1); }
  const p = session(page.webSocketDebuggerUrl); await p.ready;
  console.log("grade:", JSON.stringify(await ev(p, `(() => { const key = questions.map(q => q[2]); let answered = 0, right = 0; const wrong = [];
    key.forEach((k, i) => { const c = document.querySelector('input[name=q' + i + ']:checked'); if (c) { answered++; if (+c.value === k) right++; else wrong.push(i + 1); } });
    const res = document.getElementById('result'); return { answered, right, of: key.length, wrong, result: res && res.innerText.slice(0, 120) }; })()`)));
  process.exit(0);
})().catch((e) => { console.error("run failed", e); process.exit(1); });
