// jonah-shell.js - what Electron Jonah's window (index.html, renderer.js, preload.cjs and the main process) gave its tool panels,
// for Jonah on Chromium. The tools themselves (hub-ui.js, study-ui.js, the calculator, abacus, formula reference and research
// notes from index.html) are the Electron files, unchanged or with their inline onclick="" turned into data attributes.
//
// The tools open over Noah's chat in Chromium's side panel (Electron showed them over the page). A menu asks for one by
// writing { view } to chrome.storage.session "jonahOpen" and opening the side panel; this page opens it.
//
// Honest limits: the page tools may READ the open page (title, address, text, selection, picture addresses) and nothing
// else - the few page reads the Electron tools used are listed in READERS. Running other code in a page is refused.
(function () {
  "use strict";

  // ------------------------------------------------------------------ the open page (Electron: tabData[activeTabIndex].webview)
  const page = { url: "", title: "", tabId: null };
  async function refreshPage() {
    try {
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (t) { page.url = t.url || ""; page.title = t.title || ""; page.tabId = t.id; }
    } catch (_) { /* no tab */ }
  }
  refreshPage();
  chrome.tabs.onActivated.addListener(refreshPage);
  chrome.tabs.onUpdated.addListener((_id, _change, t) => { if (t && t.active) refreshPage(); });

  // The page reads the Electron tools did with webview.executeJavaScript("..."), as real functions.
  const READERS = [
    [/getSelection/, () => ({ title: document.title, url: location.href, sel: String(getSelection() || "").slice(0, 500) })],
    [/document\.images/, () => [...document.images].filter((i) => i.naturalWidth >= 200 && i.naturalHeight >= 150 && /^https:/.test(i.currentSrc || i.src)).map((i) => i.currentSrc || i.src).filter((u, i, a) => a.indexOf(u) === i).slice(0, 24)],
    [/meta\[name='author'\]/, () => ({
      title: document.title, url: location.href,
      author: document.querySelector("meta[name='author']")?.content,
      published: document.querySelector("meta[property='article:published_time']")?.content,
      siteName: document.querySelector("meta[property='og:site_name']")?.content,
    })],
    [/innerText/, () => ({ title: document.title, url: location.href, text: (document.body && document.body.innerText) || "" })],
  ];
  async function readPage(code) {
    await refreshPage();
    const reader = READERS.find(([re]) => re.test(String(code)));
    if (!reader) throw new Error("Jonah can only read the open page here, not run code in it.");
    if (!/^https?:/i.test(page.url) || page.tabId == null) throw new Error("Open a web page first.");
    const [res] = await chrome.scripting.executeScript({ target: { tabId: page.tabId }, func: reader[1] });
    return res ? res.result : null;
  }
  const webview = { getURL: () => page.url, getTitle: () => page.title, executeJavaScript: readPage };
  window.tabData = [{ get url() { return page.url; }, get title() { return page.title; }, webview }];
  window.activeTabIndex = 0;
  window.currentPage = () => ({ url: page.url, title: page.title });
  window.createNewTab = (url) => { if (/^https?:\/\//i.test(String(url))) chrome.tabs.create({ url: String(url) }); };

  // ------------------------------------------------------------------ Jonah's notifications (Electron: features.js pushNotification)
  window.jonahNotify = (title, body) => chrome.runtime.sendMessage({ type: "jonah:notify", title: String(title || ""), body: String(body || "") }).catch(() => {});

  // ------------------------------------------------------------------ window.study (Electron main "study:ask": the Noah chat server)
  window.study = {
    async ask(prompt, pageContent) {
      try {
        const text = await window.jonahNoahAsk(String(prompt || ""), String(pageContent || "").slice(0, 20000));
        return text ? { success: true, text } : { success: false, error: "The assistant sent back nothing. Try again in a moment." };
      } catch (err) {
        return { success: false, error: String(err && err.message || err) };
      }
    },
  };

  // ------------------------------------------------------------------ window.api parts the tools use (Focus Mode, from the Focus Timer)
  window.api = Object.assign(window.api || {}, {
    startPomodoro: (minutes) => chrome.runtime.sendMessage({ type: "jonah:focus", action: "start", minutes: Number(minutes) || 25 }),
    stopPomodoro: () => chrome.runtime.sendMessage({ type: "jonah:focus", action: "stop" }),
  });

  // ------------------------------------------------------------------ window.hubs (Electron main: hubs/ipc.cjs)
  const M = window.JonahHubModules || {};
  const client = M.feeds ? M.feeds.createClient() : null;
  const FEEDS = new Set(["giveaways", "epic", "deals", "search", "cheapestFor"]);
  let prevCpu = null;
  function cpuLoad(a, b) {
    let idle = 0, total = 0;
    b.processors.forEach((p, i) => { const q = a.processors[i]; if (!q) return; idle += p.usage.idle - q.usage.idle; total += p.usage.total - q.usage.total; });
    return total > 0 ? Math.round((1 - idle / total) * 100) : null;
  }
  function sniff(b) {
    const s = (from, to) => new TextDecoder("latin1").decode(b.slice(from, to));
    if (b.length < 12) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (s(0, 4) === "RIFF" && s(8, 12) === "WEBP") return "image/webp";
    if (s(0, 3) === "GIF") return "image/gif";
    if (s(4, 12) === "ftypavif") return "image/avif";
    if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
    return null;
  }
  window.hubs = {
    async feed(name, params) {
      if (!client) return { ok: false, error: "The game feeds are not available." };
      if (!FEEDS.has(name)) return { ok: false, error: "unknown feed" };
      try {
        const p = params && typeof params === "object" ? params : {};
        const data = name === "search" ? await client.search(String(p.title || "")) : name === "cheapestFor" ? await client.cheapestFor(Array.isArray(p.ids) ? p.ids : []) : await client[name](p);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: err && err.status === 400 ? "The deals service refused the request (400)." : "Could not reach the service right now (" + String(err && err.message || err).slice(0, 80) + ")." };
      }
    },
    // PC readings. Chromium lets a browser read CPU load, memory and battery; temperatures, disks, network speed and GPU need
    // Windows programs that a browser page may not run, so those are reported as not available (never guessed).
    async system() {
      try {
        const a = prevCpu || await chrome.system.cpu.getInfo();
        if (!prevCpu) await new Promise((r) => setTimeout(r, 350));
        const cpu = await chrome.system.cpu.getInfo(); prevCpu = cpu;
        const mem = await chrome.system.memory.getInfo();
        const GB = 1024 ** 3, r1 = (n) => Math.round(n * 10) / 10;
        let battery = null;
        try { const b = await navigator.getBattery(); battery = { percent: Math.round(b.level * 100), state: b.charging ? "charging" : "on battery", minutesLeft: !b.charging && Number.isFinite(b.dischargingTime) ? Math.round(b.dischargingTime / 60) : null }; } catch (_) { /* no battery */ }
        const snap = {
          platform: "win32", at: new Date().toISOString(),
          cpu: { model: String(cpu.modelName || "CPU").replace(/\s+/g, " ").trim(), threads: cpu.numOfProcessors, loadPct: cpuLoad(a, cpu), speedMHz: null },
          memory: { totalGB: r1(mem.capacity / GB), freeGB: r1(mem.availableCapacity / GB), usedPct: Math.round((1 - mem.availableCapacity / mem.capacity) * 100) },
          uptimeHours: null, temps: [], battery, disks: [], net: null, gpus: [], gpuNames: [],
          notes: ["In Jonah on Chromium the PC readings are CPU load, memory and battery. Temperatures, disks, network speed and GPU readings need Windows tools a browser page may not run, so they are not shown."],
          jonah: null,
        };
        snap.findings = M.system && M.system.findings ? M.system.findings(snap) : [];
        snap.hottest = null;
        return { ok: true, data: snap };
      } catch (err) {
        return { ok: false, error: "Could not read the system (" + String(err && err.message || err).slice(0, 80) + ")." };
      }
    },
    async fetchImage(url) {
      const c = M.images ? M.images.checkUrl(String(url == null ? "" : url).slice(0, 2000)) : { ok: false, why: "not available" };
      if (!c.ok) return c;
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
      try {
        const res = await fetch(c.url, { signal: ctl.signal, credentials: "omit" });
        if (!res.ok) return { ok: false, why: `The site answered ${res.status}.` };
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > (M.images.MAX_BYTES || 8 * 1024 * 1024)) return { ok: false, why: "That image is too big (limit 8 MB)." };
        const mime = sniff(buf);
        if (!mime) return { ok: false, why: "That file is not a picture Jonah can read." };
        let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        return { ok: true, mime, base64: btoa(bin), bytes: buf.length };
      } catch (err) {
        return { ok: false, why: err && err.name === "AbortError" ? "The site took too long." : "Could not download it (" + String(err && err.message || err).slice(0, 60) + ")." };
      } finally { clearTimeout(timer); }
    },
  };

  // ------------------------------------------------------------------ window.downloads (Electron preload: downloads:list / act / changed)
  // Electron Jonah's Downloads panel (downloads-ui.js) on top of Chromium's real downloads (chrome.downloads).
  const dlSpeed = new Map();
  const DL_NOTES = { cancelled: "You cancelled this download.", failed: "The download did not finish.", interrupted: "The download was interrupted. You can resume it." };
  function toEntry(it) {
    const name = String(it.filename || "").split(/[\\/]/).pop() || it.url;
    let status;
    if (it.state === "complete") status = "completed";
    else if (it.state === "interrupted") status = it.error === "USER_CANCELED" ? "cancelled" : it.canResume ? "interrupted" : "failed";
    else status = it.paused ? "paused" : "downloading";
    const now = Date.now(), prev = dlSpeed.get(it.id);
    let bps = 0;
    if (prev && status === "downloading") { const dt = (now - prev.t) / 1000; bps = dt > 0.3 ? Math.max(0, (it.bytesReceived - prev.bytes) / dt) : prev.bps; }
    dlSpeed.set(it.id, { bytes: it.bytesReceived, t: now, bps });
    const eta = it.estimatedEndTime && status === "downloading" ? Math.max(0, Math.round((Date.parse(it.estimatedEndTime) - now) / 1000)) : null;
    let host = ""; try { host = new URL(it.finalUrl || it.url).hostname.replace(/^www\./, ""); } catch (_) { /* no host */ }
    return {
      id: String(it.id), name, url: it.finalUrl || it.url, host, status,
      received: it.bytesReceived || 0, total: it.totalBytes > 0 ? it.totalBytes : 0, speedBps: bps, etaSec: eta,
      startedAt: it.startTime, endedAt: it.endTime || null, exists: it.exists, canResume: !!it.canResume, note: DL_NOTES[status] || "",
    };
  }
  window.downloads = {
    async list() {
      const items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 200 });
      return items.filter((i) => i.filename || i.url).map(toEntry);
    },
    async act(id, action) {
      const n = Number(id);
      try {
        switch (action) {
          case "pause": await chrome.downloads.pause(n); break;
          case "resume": await chrome.downloads.resume(n); break;
          case "cancel": await chrome.downloads.cancel(n); break;
          case "open": chrome.downloads.open(n); break;
          case "show": chrome.downloads.show(n); break;
          case "remove": await chrome.downloads.erase({ id: n }); break;
          case "retry": { const [it] = await chrome.downloads.search({ id: n }); if (it) await chrome.downloads.download({ url: it.finalUrl || it.url }); break; }
          case "clear": await chrome.downloads.erase({ state: "complete" }); await chrome.downloads.erase({ state: "interrupted" }); break;
          default: return { ok: false, error: "Unknown action." };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    },
    onChanged(cb) {
      const push = async () => { try { cb(await window.downloads.list()); } catch (_) { /* closed */ } };
      chrome.downloads.onChanged.addListener(push);
      chrome.downloads.onCreated.addListener(push);
      chrome.downloads.onErased.addListener(push);
      // live speed and time left while something is downloading
      const timer = setInterval(async () => { try { if ((await chrome.downloads.search({ state: "in_progress" })).length) push(); } catch (_) { /* closed */ } }, 1000);
      return () => clearInterval(timer);
    },
  };

  // ------------------------------------------------------------------ opening a tool asked for by a menu
  const OPEN = {
    "hub:game": () => window.openHub && window.openHub("game"),
    "hub:creator": () => window.openHub && window.openHub("creator"),
    "hub:aesthetic": () => window.openHub && window.openHub("aesthetic"),
    "study:today": () => window.openStudyHub && window.openStudyHub("today"),
    "study:focus": () => window.openStudyHub && window.openStudyHub("focus"),
    "study:cards": () => window.openStudyHub && window.openStudyHub("cards"),
    "study:ai": () => window.openStudyHub && window.openStudyHub("ai"),
    calc: () => window.openCalculatorPanel && window.openCalculatorPanel(),
    abacus: () => window.openAbacusPanel && window.openAbacusPanel(),
    formula: () => window.openFormulaPanel && window.openFormulaPanel(),
    notes: () => window.openResearchNotesPanel && window.openResearchNotesPanel(),
    downloads: () => window.openDownloads && window.openDownloads(),
    history: () => window.openJonahHistory && window.openJonahHistory(),
    models: () => window.openJonahModels && window.openJonahModels(),
    focus: () => window.JonahFeatures && window.JonahFeatures.openFocus(),
    privacy: () => window.JonahFeatures && window.JonahFeatures.openPrivacy(),
    notifications: () => window.JonahFeatures && window.JonahFeatures.openNotifications(),
    billing: () => window.JonahFeatures && window.JonahFeatures.openBilling(),
    trust: () => window.JonahFeatures && window.JonahFeatures.openTrust(),
    orb: () => window.JonahFeatures && window.JonahFeatures.openOrb(),
  };
  function openRequested(req) {
    if (!req || !OPEN[req.view] || Date.now() - (req.t || 0) > 15000) return;
    chrome.storage.session.remove("jonahOpen").catch(() => {});
    try { OPEN[req.view](); } catch (err) { console.error("Jonah tool failed to open:", req.view, err); }
  }
  window.addEventListener("load", () => {
    // noah.html#open=history (etc.) opens that tool directly, e.g. for a tool opened in its own tab
    const m = /^#open=([\w:]+)$/.exec(location.hash);
    if (m && OPEN[m[1]]) { try { OPEN[m[1]](); } catch (err) { console.error(err); } return; }
    chrome.storage.session.get("jonahOpen").then((r) => openRequested(r.jonahOpen)).catch(() => {});
  });
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.jonahOpen && changes.jonahOpen.newValue) openRequested(changes.jonahOpen.newValue);
  });
})();
