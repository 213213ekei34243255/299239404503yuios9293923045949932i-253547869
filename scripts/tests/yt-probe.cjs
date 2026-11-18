// Opens a YouTube video in a throwaway Jonah profile (local DevTools port, test only) and reports whether the ad schedule was removed.
const port = process.argv[2] || 9335, vid = process.argv[3] || "dQw4w9WgXcQ";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(p, m = "GET") { return (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json(); }
function session(u) { const ws = new WebSocket(u); let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  return { ready: new Promise((r) => (ws.onopen = r)), send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) }; }
async function ev(s, e) { const r = await s.send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.text; }
(async () => {
  for (let i = 0; i < 60; i++) { try { await j("/json/version"); break; } catch { await sleep(500); } }
  await sleep(6000); // background.js registers the YouTube scripts at startup
  const t = await j("/json/new?" + encodeURIComponent("https://www.youtube.com/watch?v=" + vid), "PUT");
  await sleep(12000);
  const s = session(t.webSocketDebuggerUrl); await s.ready;
  console.log(JSON.stringify(await ev(s, `(() => { const p = window.ytInitialPlayerResponse; const app = document.querySelector('ytd-app') || document.querySelector('ytd-watch-flexy');
    return { url: location.href.slice(0, 60), title: document.title.slice(0, 60), scriptRan: !!window.__jonahYtAdfree, playerData: !!p,
      adPlacements: !!(p && p.adPlacements), playerAds: !!(p && p.playerAds), adSlots: !!(p && p.adSlots),
      consentWall: /consent|before you continue/i.test(document.body ? document.body.innerText.slice(0, 400) : ''),
      adBoxesVisible: [...document.querySelectorAll('ytd-ad-slot-renderer,#player-ads,ytd-in-feed-ad-layout-renderer')].filter(e => e.offsetParent).length,
      videoReady: (document.querySelector('video') || {}).readyState }; })()`)));
  console.log("playback:", JSON.stringify(await ev(s, `(async () => { const v = document.querySelector('video'); if (!v) return 'no video element';
    v.muted = true; try { await v.play(); } catch (e) { return 'play() refused: ' + e.message; }
    await new Promise(r => setTimeout(r, 8000));
    const mp = document.getElementById('movie_player');
    return { currentTime: Math.round(v.currentTime * 10) / 10, paused: v.paused, adShowing: !!(mp && mp.classList.contains('ad-showing')), playerState: mp && mp.getPlayerState ? mp.getPlayerState() : null }; })()`)));
  console.log("in-app click:", JSON.stringify(await ev(s, `(async () => { const before = location.href;
    const a = [...document.querySelectorAll('a[href*="/watch?v="]')].find(x => x.offsetParent && !x.href.includes(${JSON.stringify(vid)}));
    if (!a) return 'no other video link'; a.click();
    for (let i = 0; i < 40 && location.href === before; i++) await new Promise(r => setTimeout(r, 250));
    await new Promise(r => setTimeout(r, 6000));
    const mp = document.getElementById('movie_player'); const pr = mp && mp.getPlayerResponse ? mp.getPlayerResponse() : null; const v = document.querySelector('video');
    return { now: location.href.slice(24, 60), adPlacements: !!(pr && pr.adPlacements), adShowing: !!(mp && mp.classList.contains('ad-showing')), currentTime: v && Math.round(v.currentTime), title: pr && pr.videoDetails && pr.videoDetails.title.slice(0, 40) }; })()`)));
  process.exit(0);
})().catch((e) => { console.error("probe failed", e); process.exit(1); });
