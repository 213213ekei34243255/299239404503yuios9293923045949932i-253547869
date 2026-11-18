// Drives Noah's own click path on a real page through a local DevTools port (test only) and reports whether radios got checked.
const port = process.argv[2] || 9333, pageUrl = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(path, method = "GET") { return (await fetch(`http://127.0.0.1:${port}${path}`, { method })).json(); }
function session(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const ready = new Promise((r) => (ws.onopen = r));
  return { ready, close: () => ws.close(), send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) };
}
async function evalIn(s, expr) { const r = await s.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text }; return r.result?.result?.value; }
(async () => {
  for (let i = 0; i < 40; i++) { try { await j("/json/version"); break; } catch { await sleep(500); } }
  await sleep(2500);
  const ext = await j("/json/new?" + encodeURIComponent("chrome-extension://idkbjcjlmnkoikibnjjlajfjmimdmajp/noah.html"), "PUT");
  await sleep(2500);
  const s = session(ext.webSocketDebuggerUrl); await s.ready;
  const code = `(async () => {
    const log = []; for (let i = 0; i < 60 && !window.jonahEnsureNoah; i++) await new Promise(r => setTimeout(r, 250));
    await window.jonahEnsureNoah(); const N = await window.JonahNoahReady; const b = N.core.browser, ex = N.core.executor || N.core.actionExecutor;
    const tabs = await chrome.tabs.query({}); const t = tabs.find(x => (x.url||"").includes(${JSON.stringify(new URL(pageUrl).host)}));
    await chrome.tabs.update(t.id, { active: true });
    if (${JSON.stringify(process.env.OVERLAY === "1")}) {
      N.core.bus.publish("task_started", { goal: "probe" }); // what a real task does: Noah's boot injects the overlay
      await new Promise(r => setTimeout(r, 2500));
      log.push("overlay layer present: " + JSON.stringify(await chrome.scripting.executeScript({ target: { tabId: t.id }, world: "MAIN", func: () => { const h = document.querySelector("jonah-noah-layer"); return { host: !!h, inBody: !!document.body.querySelector("#noahOverlay"), bodyHasNoahText: /NOAH/.test(document.body.innerText) }; } }).then(r => r[0].result)));
    }
    const obs = await b.observe({});
    const radios = (obs.elements || []).filter(e => e.role === "radio");
    log.push("elements " + (obs.elements||[]).length + " radios " + radios.length + " keys " + Object.keys(obs).join(","));
    log.push("first radio " + String(JSON.stringify(radios[0])).slice(0,300));
    const picks = (${JSON.stringify(process.env.PICKS || "")} ? ${JSON.stringify(process.env.PICKS || "")}.split(",").map(Number) : [1, 6, 9]).map(i => radios[i]).filter(Boolean);
    for (const r of picks) {
      const res = await ex.execute({ action: "click", target: { type: "ref", ref: r.ref } });
      const v = await b.readValue(r.ref).catch(e => ({ err: e.message }));
      log.push(r.ref + " " + (r.name||"") + " -> ok=" + res.ok + " method=" + res.method + " at " + Math.round(res.resolved?.vx) + "," + Math.round(res.resolved?.vy) + " rect=" + JSON.stringify(res.resolved?.rect) + " verdict=" + res.verification?.summary + " checked=" + JSON.stringify(v));
    }
    // a click on empty space must now be reported as "no effect" (with the old in-page overlay it was always "ok")
    const miss = await ex.execute({ action: "click", target: { type: "viewport", x: 1180, y: 300 } });
    log.push("blank-space click -> ok=" + miss.ok + " verdict=" + miss.verification?.summary);
    const o2 = await b.observe({ screenshot: true });
    log.push("STOP in elements: " + (o2.elements || []).some(e => /STOP NOAH/i.test(e.name || "")) + "; NOAH in pageText: " + /STOP NOAH|Verifying result/.test(o2.pageText || "") + "; screenshot " + (o2.screenshot ? o2.screenshot.width + "x" + o2.screenshot.height : "none"));
    if (o2.screenshot) window.__probeShot = o2.screenshot.base64;
    // text fields / select / checkbox (form pages)
    const fields = (o2.elements || []).filter(e => /textbox|searchbox|combobox|checkbox/.test(e.role));
    for (const f of fields.slice(0, 4)) {
      const act = f.role === "checkbox" ? { action: "click", target: { type: "ref", ref: f.ref } } : f.role === "combobox" ? { action: "form_input", target: { type: "ref", ref: f.ref }, ref: f.ref, value: "Blue" } : { action: "type", target: { type: "ref", ref: f.ref }, text: "Answer for " + (f.name || f.ref) };
      const r = await ex.execute(act);
      log.push(f.role + " " + f.ref + " '" + (f.name||"") + "' " + act.action + " -> ok=" + r.ok + " " + (r.message||"").slice(0,120) + " value=" + JSON.stringify(await b.readValue(f.ref).catch(e => e.message)));
    }
    return log.join(" || ");
  })()`;
  if (process.env.SHOW) console.log(code);
  console.log(await evalIn(s, code));
  const page = (await j("/json/list")).find((x) => x.url.startsWith(pageUrl));
  const p = session(page.webSocketDebuggerUrl); await p.ready;
  const shot = await evalIn(s, "window.__probeShot || ''"); if (shot) require("fs").writeFileSync(process.env.SHOT || "probe-shot.jpg", Buffer.from(shot, "base64"));
  console.log("page truth:", JSON.stringify(await evalIn(p, `[...document.querySelectorAll('input:checked')].map(i => i.name + '=' + i.value).concat([...document.querySelectorAll('input[type=text],textarea,select')].map(i => (i.name||i.id) + ':' + i.value))`)), "dpr", await evalIn(p, "devicePixelRatio+' '+innerWidth+'x'+innerHeight"));
  process.exit(0);
})().catch((e) => { console.error("probe failed", e); process.exit(1); });
