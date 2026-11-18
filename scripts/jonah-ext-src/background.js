// background.js - Jonah's built-in extension, background part. Does what Electron Jonah's main process did for the menus:
//   * settings (Focus Mode, ads, trackers) saved in chrome.storage.local "jonahSettings" (Electron: settings.json)
//   * Focus Mode: sends distracting sites to focus-blocked.html during a Pomodoro or the schedule (Electron: webRequest redirect)
//   * No ads & trackers: the same domain lists as Electron main.cjs (AD_DOMAINS, TRACKER_DOMAINS), with Chromium's own
//     declarativeNetRequest blocking, and a count of blocked tracker requests
//   * Read page aloud: the page's text through Chromium's speech (chrome.tts; Electron used the Kokoro voice)
//   * Jonah notifications list (Electron: features.js notification centre)
//   * Game Hub: CheapShark refuses requests without a descriptive User-Agent, so requests from THIS extension to cheapshark.com
//     say who they are ("JonahBrowser/1.5.5 (game hub; ...)", the same text Electron sent). Only those requests; never websites.
"use strict";

// The Trust Engine's watcher (Electron trust-panel.js) and the web search it shares with Noah's chat (Electron google-serp.cjs rules).
importScripts("google-results.js", "jonah-google-search.js", "jonah-trust.js");

const AD_DOMAINS = ["popads.net", "propellerads.com", "poptox.com", "adnxs.com", "exoclick.com", "juicyads.com", "clickadu.com"];
const TRACKER_DOMAINS = [
  "google-analytics.com", "googletagmanager.com", "googlesyndication.com", "doubleclick.net", "facebook.net", "connect.facebook.net",
  "analytics.tiktok.com", "ads-twitter.com", "scorecardresearch.com", "hotjar.com", "segment.io", "mixpanel.com", "amplitude.com",
  "criteo.com", "outbrain.com", "taboola.com", "adsrvr.org", "quantserve.com", "chartbeat.com", "newrelic.com",
];
const DEFAULTS = {
  adBlockEnabled: true,
  trackerBlockEnabled: true,
  trackersBlockedCount: 0,
  focusMode: { sites: ["instagram.com", "x.com", "tiktok.com", "youtube.com"], scheduleEnabled: false, scheduleStart: 9 * 60, scheduleEnd: 17 * 60, pomodoroEndsAt: null },
};
const ID = { ad: 100, tracker: 101, ua: 102, anthropic: 103, youtubeAds: 104, focusBase: 1000 };
// YouTube (same three layers as Brave Shields): 1) the player's ad requests are blocked (rule below), 2) the ad schedule is removed
// from the video data before the player reads it (js/yt-adfree-main.js), 3) the ad boxes on the page are hidden (css/yt-adfree.css).
const YT_AD_URLS = /^https?:\/\/([a-z0-9-]+\.)*youtube\.com\/(pagead\/|api\/stats\/ads|get_midroll_|ptracking|youtubei\/v1\/player\/ad_break)/.source;
const YT_MATCHES = ["*://*.youtube.com/*", "*://*.youtube-nocookie.com/*"];
async function applyYouTube(on) {
  const have = new Set((await chrome.scripting.getRegisteredContentScripts()).map((c) => c.id));
  const mine = ["jonah-yt-main", "jonah-yt-css"].filter((id) => have.has(id));
  if (!on) { if (mine.length) await chrome.scripting.unregisterContentScripts({ ids: mine }); return; }
  if (mine.length === 2) return;
  if (mine.length) await chrome.scripting.unregisterContentScripts({ ids: mine });
  await chrome.scripting.registerContentScripts([
    { id: "jonah-yt-main", matches: YT_MATCHES, js: ["js/yt-adfree-main.js"], runAt: "document_start", world: "MAIN", allFrames: true, persistAcrossSessions: true },
    { id: "jonah-yt-css", matches: YT_MATCHES, css: ["css/yt-adfree.css"], runAt: "document_start", allFrames: true, persistAcrossSessions: true },
  ]);
}
const ALL_TYPES = ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"];

async function getSettings() {
  const { jonahSettings } = await chrome.storage.local.get("jonahSettings");
  const s = Object.assign({}, DEFAULTS, jonahSettings || {});
  s.focusMode = Object.assign({}, DEFAULTS.focusMode, (jonahSettings && jonahSettings.focusMode) || {});
  return s;
}
async function setSettings(patch) {
  const s = await getSettings();
  const next = Object.assign({}, s, patch || {});
  if (patch && patch.focusMode) next.focusMode = Object.assign({}, s.focusMode, patch.focusMode);
  await chrome.storage.local.set({ jonahSettings: next });
  await applyRules(next);
  return next;
}

function focusActive(f) {
  if (f.pomodoroEndsAt && Date.now() < f.pomodoroEndsAt) return true;
  if (!f.scheduleEnabled) return false;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  return f.scheduleStart <= f.scheduleEnd ? mins >= f.scheduleStart && mins < f.scheduleEnd : mins >= f.scheduleStart || mins < f.scheduleEnd;
}

// Rules are applied one call at a time: on startup start() runs from onInstalled, onStartup and the top level at once, and two
// overlapping calls both added rule 100 ("Rule with id 100 does not have a unique ID") so the ad/tracker rules never loaded.
let rulesQueue = Promise.resolve();
function applyRules(s) {
  const run = rulesQueue.then(() => applyRulesNow(s));
  rulesQueue = run.catch(() => {});
  return run;
}
async function applyRulesNow(s) {
  s = s || await getSettings();
  const rules = [];
  if (s.adBlockEnabled) rules.push({ id: ID.ad, priority: 1, action: { type: "block" }, condition: { requestDomains: AD_DOMAINS, resourceTypes: ALL_TYPES } });
  if (s.adBlockEnabled) rules.push({ id: ID.youtubeAds, priority: 1, action: { type: "block" }, condition: { regexFilter: YT_AD_URLS, resourceTypes: ["xmlhttprequest", "ping", "image", "script", "sub_frame", "other"] } });
  await applyYouTube(!!s.adBlockEnabled).catch((e) => console.error("Jonah YouTube ad rules:", e));
  if (s.trackerBlockEnabled) rules.push({ id: ID.tracker, priority: 1, action: { type: "block" }, condition: { requestDomains: TRACKER_DOMAINS, resourceTypes: ALL_TYPES.filter((t) => t !== "main_frame") } });
  rules.push({
    id: ID.ua, priority: 2,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "User-Agent", operation: "set", value: "JonahBrowser/1.5.5 (game hub; https://jonahbrowser.com)" }] },
    condition: { requestDomains: ["cheapshark.com"], initiatorDomains: [chrome.runtime.id], resourceTypes: ["xmlhttprequest"] },
  });
  // Anthropic's API answers requests from a browser only when they say so on purpose (Noah's agent with the user's own key).
  rules.push({
    id: ID.anthropic, priority: 2,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "anthropic-dangerous-direct-browser-access", operation: "set", value: "true" }] },
    condition: { requestDomains: ["api.anthropic.com"], initiatorDomains: [chrome.runtime.id], resourceTypes: ["xmlhttprequest"] },
  });
  if (focusActive(s.focusMode)) {
    s.focusMode.sites.slice(0, 200).forEach((site, i) => {
      rules.push({ id: ID.focusBase + i, priority: 3, action: { type: "redirect", redirect: { extensionPath: "/focus-blocked.html?site=" + encodeURIComponent(site) } }, condition: { requestDomains: [site], resourceTypes: ["main_frame"] } });
    });
  }
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  // removing the new ids too makes this safe to repeat (removals are applied before additions)
  const ids = new Set(old.map((r) => r.id).concat(rules.map((r) => r.id)));
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [...ids], addRules: rules });
}

// tracker requests blocked since the last look (Chromium keeps matched-rule records for a few minutes)
let lastMatchCheck = Date.now();
async function countTrackers() {
  try {
    const since = lastMatchCheck; lastMatchCheck = Date.now();
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ minTimeStamp: since });
    const n = (rulesMatchedInfo || []).filter((m) => m.rule.ruleId === ID.tracker).length;
    if (n) { const s = await getSettings(); await chrome.storage.local.set({ jonahSettings: Object.assign(s, { trackersBlockedCount: (s.trackersBlockedCount || 0) + n }) }); }
  } catch (_) { /* quota: try again next minute */ }
}

// ------------------------------------------------------------------ notifications (Jonah's own list + a Windows notification)
async function notify(title, body) {
  const { jonahNotifications = [] } = await chrome.storage.local.get("jonahNotifications");
  jonahNotifications.unshift({ title: String(title).slice(0, 120), body: String(body || "").slice(0, 400), time: Date.now() });
  await chrome.storage.local.set({ jonahNotifications: jonahNotifications.slice(0, 50) });
  try { chrome.notifications.create({ type: "basic", iconUrl: "icons/jonah-128.png", title: String(title), message: String(body || "") }); } catch (_) { /* notifications off */ }
}

// ------------------------------------------------------------------ read page aloud
async function readAloud() {
  const speaking = await chrome.tts.isSpeaking();
  if (speaking) { chrome.tts.stop(); await chrome.storage.session.set({ jonahReading: false }); return { reading: false }; }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !/^https?:/i.test(tab.url || "")) return { reading: false, error: "Open a web page to read it aloud." };
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const main = document.querySelector("article, main, [role=main]") || document.body;
      return (main ? main.innerText : "").replace(/\s+\n/g, "\n").slice(0, 60000);
    },
  });
  const text = String((res && res.result) || "").trim();
  if (text.length < 20) return { reading: false, error: "There is no readable text on this page." };
  const parts = text.match(/[^.!?\n]+[.!?]?/g) || [text];
  await chrome.storage.session.set({ jonahReading: true });
  parts.forEach((p, i) => chrome.tts.speak(p.trim(), {
    enqueue: true,
    onEvent: (e) => { if ((e.type === "end" && i === parts.length - 1) || e.type === "interrupted" || e.type === "cancelled" || e.type === "error") chrome.storage.session.set({ jonahReading: false }); },
  }));
  return { reading: true };
}

// ------------------------------------------------------------------ "Cite this page" (Electron: openCitationOverlay in index.html)
// The same citation card as Jonah on Electron, inside the page. It is a real function handed to Chromium (never a code string).
function citationCard(data) {
  const old = document.getElementById("jonah-cite-panel");
  if (old) old.remove();
  const getSiteName = (d) => d.siteName || location.hostname.replace("www.", "");
  const getAuthor = (d) => d.author || getSiteName(d);
  const getDateAPA = (d) => (d.published ? "(" + new Date(d.published).getFullYear() + ")" : "(n.d.)");
  const cleanTitle = (t) => (t ? t.split(" - ")[0] : "");
  const apa = getAuthor(data) + ". " + getDateAPA(data) + ". " + cleanTitle(data.title) + ". " + data.url;
  const mla = '"' + cleanTitle(data.title) + '." ' + getSiteName(data) + ", " + data.url + ".";
  const mk = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const panel = mk("div"); panel.id = "jonah-cite-panel";
  const header = mk("div", "Citation", "header");
  const close = mk("span", "✕"); close.id = "closeBtn"; close.onclick = () => panel.remove(); header.appendChild(close);
  panel.appendChild(header);
  for (const [name, text] of [["APA", apa], ["MLA", mla]]) {
    const box = mk("div", null, "box"); box.appendChild(mk("strong", name)); box.appendChild(mk("p", text));
    const b = mk("button", "Copy"); b.onclick = () => navigator.clipboard.writeText(text); box.appendChild(b);
    panel.appendChild(box);
  }
  const style = document.createElement("style");
  style.textContent = `
    #jonah-cite-panel { all: initial; position: fixed; top: 50px; right: 20px; width: 350px; max-height: 80vh; overflow-y: auto; background: rgba(255,105,180,0.48);
      color: black; font-family: Arial; border-radius: 12px; box-shadow: 0 0 25px rgba(0,234,255,0.4); border: 1px solid rgba(255,105,180,0.48); z-index: 2147483000;
      backdrop-filter: blur(12px); animation: jonahCiteIn 0.3s ease; scroll-behavior: smooth; }
    #jonah-cite-panel .header { padding: 10px; font-weight: bold; color: #00eaff; display: flex; justify-content: space-between; border-bottom: 1px solid rgba(0,234,255,0.3); }
    #jonah-cite-panel .box { display: block; padding: 10px; margin: 10px; background: rgba(255,105,180,0.48); border-radius: 8px; }
    #jonah-cite-panel p { display: block; margin: 6px 0; }
    #jonah-cite-panel button { margin-top: 5px; background: linear-gradient(135deg, rgba(255,105,180,0.48)); border: none; padding: 5px 10px; color: black; border-radius: 6px; cursor: pointer; transition: 0.3s; }
    #jonah-cite-panel button:hover { box-shadow: 0 0 10px #00eaff; transform: scale(1.05); }
    #jonah-cite-panel #closeBtn { cursor: pointer; }
    @keyframes jonahCiteIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }`;
  document.documentElement.appendChild(style);
  document.documentElement.appendChild(panel);
}
async function citePage() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !/^https?:/i.test(tab.url || "")) return false; // not a website: nothing happens (as in Electron)
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      title: document.title, url: location.href,
      author: document.querySelector("meta[name='author']")?.content,
      published: document.querySelector("meta[property='article:published_time']")?.content,
      siteName: document.querySelector("meta[property='og:site_name']")?.content,
    }),
  });
  const data = res && res.result;
  if (!data || !/^https?:/i.test(data.url || "")) return false;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: citationCard, args: [data] });
  return true;
}

// ------------------------------------------------------------------ messages from Jonah's pages
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!sender || sender.id !== chrome.runtime.id) return false; // only Jonah's own pages
  // messages this handler does not know are left to the others (the Trust Engine's "jonah:trust-cmd", jonah-trust.js): answering them
  // here with null raced the real answer and left the Trust Panel stuck on "Loading..."
  if (!msg || typeof msg.type !== "string" || msg.type === "jonah:trust-cmd" || msg.type === "jonah:news" || msg.type.startsWith("noah:")) return false;
  (async () => {
    switch (msg && msg.type) {
      case "jonah:settings:get": return getSettings();
      case "jonah:settings:set": return setSettings(msg.patch);
      case "jonah:focus": {
        const s = await getSettings();
        if (msg.action === "start") {
          const ends = Date.now() + Math.min(240, Math.max(1, Number(msg.minutes) || 25)) * 60000;
          await setSettings({ focusMode: { pomodoroEndsAt: ends } });
          chrome.alarms.create("jonah-pomodoro-end", { when: ends });
          await notify("Focus Mode", `${Math.round((ends - Date.now()) / 60000)} minute Pomodoro started`);
          return ends;
        }
        chrome.alarms.clear("jonah-pomodoro-end");
        await setSettings({ focusMode: { pomodoroEndsAt: null } });
        if (s.focusMode.pomodoroEndsAt) await notify("Focus Mode", "Pomodoro stopped");
        return true;
      }
      case "jonah:privacy:stats": { await countTrackers(); const s = await getSettings(); return { trackersBlockedCount: s.trackersBlockedCount || 0 }; }
      case "jonah:notify": await notify(msg.title, msg.body); return true;
      case "jonah:notifications": { const { jonahNotifications = [] } = await chrome.storage.local.get("jonahNotifications"); return jonahNotifications; }
      case "jonah:notifications:clear": await chrome.storage.local.set({ jonahNotifications: [] }); return true;
      case "jonah:readAloud": return readAloud();
      case "jonah:cite": return citePage();
      default: return null;
    }
  })().then(reply, (err) => reply({ error: String(err && err.message || err) }));
  return true;
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "jonah-pomodoro-end") {
    await setSettings({ focusMode: { pomodoroEndsAt: null } });
    await notify("Focus Mode", "Pomodoro finished - time for a break.");
  } else if (a.name === "jonah-minute") {
    await applyRules();
    await countTrackers();
  }
});

function start() {
  chrome.alarms.create("jonah-minute", { periodInMinutes: 1 });
  applyRules().catch((e) => console.error("Jonah rules:", e));
}
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
start();
