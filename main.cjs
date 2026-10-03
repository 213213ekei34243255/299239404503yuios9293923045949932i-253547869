const { app, BrowserWindow, ipcMain, session, nativeTheme, webContents, screen, safeStorage } = require('electron');
const { createNoah } = require('./Noah/index.cjs');
const { mountSearchProxy, fetchSearch, fetchNews, setWebSearchBackend } = require('./search-proxy.cjs');
const { createGoogleSearch } = require('./google-serp.cjs');
const RexyRuntime = require("./Rexy/runtime.cjs");
const { AttachmentStore, registerAttachmentIpc } = require('./attachments.cjs');
const { configureOcr, shutdownOcr } = require('./file-extract.cjs');
const path = require('path');
const axios = require('axios');
const { autoUpdater } = require("electron-updater");
const express = require('express');
const { shell, dialog } = require('electron');
const fs = require("fs");
const vpn = require('./vpn.cjs'); // ← ADD THIS after all requires
const { pathToFileURL } = require('url');

// Happy Eyeballs (RFC 8305) for every Node-side network call (the Rexy chat/agent model, Noah's providers, search proxy).
// www.noahai.live is behind Cloudflare and resolves to several IPs; on some networks one of them is blackholed. Node 18's
// default (used by Electron 28) tries ONLY the first address the resolver returns, so whenever the bad one came first every
// request hung for 10 s and died with UND_ERR_CONNECT_TIMEOUT - and retrying never helped because the resolver order does not
// change between attempts (a real, reproduced bug: chat replies failed 3x in a row). With this on, Node moves to the next
// address after 300 ms instead. Verified on Electron's own Node 18.18.2 by forcing the bad IP first: fetch failed in 10.3 s
// without it, returned HTTP 200 with it.
try {
  const net = require('net');
  if (typeof net.setDefaultAutoSelectFamily === 'function') {
    net.setDefaultAutoSelectFamily(true);
    net.setDefaultAutoSelectFamilyAttemptTimeout(300);
  }
} catch (_) { /* older runtime: keep the default behaviour */ }

// Windows lets "system mode" (taskbar/Start, often dark) differ from
// "app mode" (what apps should use, often light) — two separate
// registry settings. Electron's nativeTheme defaults to following
// system mode, which is why sites with real dark-mode CSS
// (prefers-color-scheme: dark) were rendering dark here even though
// Edge — which follows app mode — showed them light. Forcing "light"
// makes every page see prefers-color-scheme: light unconditionally, so
// browsing looks the same as it does in a normal browser on this PC.
nativeTheme.themeSource = "light";

const userDataPath = path.join(app.getPath("userData"), "browser-data");
app.setPath("userData", userDataPath);
app.commandLine.appendSwitch("persist-session-cookies");
app.commandLine.appendSwitch("restore-last-session");
const widevineDir =
"C:\\Jonah\\widevine"
app.commandLine.appendSwitch("widevine-cdm-path", widevineDir)
app.commandLine.appendSwitch(
  "enable-features",
  "PlatformHEVCDecoderSupport,HEVCSoftwareDecoding"
);
app.commandLine.appendSwitch("enable-features", "WidevineCdm");
app.commandLine.appendSwitch("enable-widevine-cdm");
app.commandLine.appendSwitch("enable-accelerated-video-decode");
app.commandLine.appendSwitch("enable-features", "PlatformHEVCDecoderSupport");
//app.commandLine.appendSwitch("ignore-gpu-blocklist");
//app.commandLine.appendSwitch("ignore-gpu-blocklist");

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
//app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// CalculateNativeWinOcclusion: without it Chromium stops producing frames for a window that other apps cover,
// which stalls screenshots (Noah reads the page visually) while the agent works in the background.
app.commandLine.appendSwitch("disable-features", "PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies,WebContentsForceDark,CalculateNativeWinOcclusion");
//app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");



app.commandLine.appendSwitch("enable-accelerated-video-decode");
app.commandLine.appendSwitch("enable-crash-reporter");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,HEVCSoftwareDecoding');
let mainWindow;

// Billing/entitlements (noahai.live): gates AI Agent, Trust Engine, attachments and Chat. OFF unless entitlements.config.json says
// {"enabled": true} (how a packaged build is switched on) or JONAH_ENTITLEMENTS_ENABLED=1 (dev override; "0" forces off) - see
// set - see entitlement-gate.cjs's own header for why, and Noah/test/unit/entitlement-*.test.cjs for what is actually verified so far.
// Created inside app.whenReady (needs safeStorage, which is only reliable once the app is ready); a plain pass-through until then.
const { createEntitlementGate, entitlementsEnabled } = require("./entitlement-gate.cjs");
const { registerBillingIpc } = require("./billing.cjs");
const { createUpdater, RELEASE_REPO } = require("./updater.cjs");
let entitlementGate = null;
const entitlementCheck = (feature, extra) => {
    if (entitlementGate) return entitlementGate.gate(feature, extra);
    // before app-ready the gate does not exist yet. With enforcement on, "not ready" must refuse (fail closed), never wave things through.
    if (entitlementsEnabled()) return Promise.resolve({ allowed: false, reason: "not_ready", message: "Jonah is still starting up. Try again in a moment." });
    return Promise.resolve({ allowed: true, bypass: "not_initialized" });
};

// Files the user attaches in the assistant panel: read and held HERE (the renderer only ever sees an id and a summary),
// then handed to the chat model as reference text when a question is asked (see the rexy:goal handler).
const attachmentStore = new AttachmentStore();
configureOcr({ cachePath: path.join(app.getPath("userData"), "ocr-cache") });
registerAttachmentIpc({ ipcMain, mainWindow: () => mainWindow, store: attachmentStore, gate: entitlementCheck });
app.on("will-quit", () => { attachmentStore.clear(); shutdownOcr().catch(() => {}); });
let rexyRuntime = null;
let noah = null; // Noah computer-use agent (see Noah/)
app.disableHardwareAcceleration = false;
app.userAgentFallback =
"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";


app?.commandLine?.appendSwitch("autoplay-policy", "no-user-gesture-required");


// NOTE: previously had app.commandLine.appendSwitch("force-dark-mode", "false")
// here. That switch is presence-based in Chromium — just having it on the
// command line turns ON forced auto-dark rendering for every site,
// regardless of the "false" value, which is what was darkening every
// website's background instead of leaving each site's own theme alone.
// Removed. Forced dark is now explicitly disabled via the
// "disable-features": "WebContentsForceDark" entry above instead.
//app.commandLine.appendSwitch("disable-dev-tools");
//app.commandLine.appendSwitch("disable-features", "DeveloperToolsAvailability");
// (Sec-CH-Prefers-Color-Scheme client hint flag removed — it's an
// experimental header most browsers don't send by default; forcing it
// on could tell theme-aware sites to server-render a dark variant even
// with nativeTheme forced to light above.)

const KOKORO_RENDER_URL =
    process.env.KOKORO_RENDER_URL ||
    "https://kokoro-53xt.onrender.com";

// ---------------------------------------------------------------------
// Render free-tier warm-up
// ---------------------------------------------------------------------
const REXY_PREDICT_URL =
    process.env.REXY_LLM_ENDPOINT ||
    "https://www.noahai.live/predict";
const WARMUP_TARGETS = [
    { name: "Rexy predict", url: REXY_PREDICT_URL, method: "POST", body: JSON.stringify({ mode: "chat", message: "", session_id: "warmup" }) },
    { name: "Kokoro TTS", url: KOKORO_RENDER_URL, method: "GET" },
];
const WARMUP_TIMEOUT_MS = 15_000;
const WARMUP_INTERVAL_MS = 10 * 60 * 1000;

async function warmUpRenderServices() {
    await Promise.all(
        WARMUP_TARGETS.map(async (target) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);
            const startedAt = Date.now();
            try {
                await fetch(target.url, {
                    method: target.method,
                    headers: target.body ? { "Content-Type": "application/json" } : undefined,
                    body: target.body,
                    signal: controller.signal,
                });
                console.log(`[WARMUP] ${target.name} responded in ${Date.now() - startedAt}ms`);
            } catch (err) {
                console.log(`[WARMUP] ${target.name} not ready yet (${err.message}); it may still be cold-starting`);
            } finally {
                clearTimeout(timer);
            }
        })
    );
}

// =======================================================================
// SETTINGS (dark mode, ad/tracker block, focus mode) — persisted to disk
// =======================================================================
const settingsPath = path.join(app.getPath("userData"), "settings.json");

const DEFAULT_SETTINGS = {
    adBlockEnabled: true,
    trackerBlockEnabled: true,
    trackersBlockedCount: 0,
    focusMode: {
        sites: ["instagram.com", "x.com", "tiktok.com", "youtube.com"],
        scheduleEnabled: false,
        scheduleStart: 9 * 60,
        scheduleEnd: 17 * 60,
        pomodoroEndsAt: null
    }
};

function loadSettings() {
    try {
        if (fs.existsSync(settingsPath)) {
            const disk = JSON.parse(fs.readFileSync(settingsPath));
            return {
                ...DEFAULT_SETTINGS,
                ...disk,
                focusMode: { ...DEFAULT_SETTINGS.focusMode, ...(disk.focusMode || {}) }
            };
        }
    } catch (e) {
        console.error("settings load failed:", e.message);
    }
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

let settings = loadSettings();
let _saveSettingsTimer = null;
function saveSettingsNow() {
    try {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch (e) {
        console.error("settings save failed:", e.message);
    }
}
function scheduleSettingsSave() {
    clearTimeout(_saveSettingsTimer);
    _saveSettingsTimer = setTimeout(saveSettingsNow, 400);
}
function broadcastSettings() {
    BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) w.webContents.send("settings:changed", settings);
    });
}

ipcMain.handle("settings:get", () => settings);
ipcMain.handle("settings:set", (_e, partial) => {
    settings = { ...settings, ...partial };
    saveSettingsNow();
    broadcastSettings();
    return settings;
});
ipcMain.handle("focus:update", (_e, focusPartial) => {
    settings.focusMode = { ...settings.focusMode, ...focusPartial };
    saveSettingsNow();
    broadcastSettings();
    return settings.focusMode;
});
ipcMain.handle("focus:startPomodoro", (_e, minutes = 25) => {
    settings.focusMode.pomodoroEndsAt = Date.now() + minutes * 60000;
    saveSettingsNow();
    broadcastSettings();
    return settings.focusMode.pomodoroEndsAt;
});
ipcMain.handle("focus:stopPomodoro", () => {
    settings.focusMode.pomodoroEndsAt = null;
    saveSettingsNow();
    broadcastSettings();
    return true;
});

function isFocusActive() {
    const f = settings.focusMode;
    if (f.pomodoroEndsAt) {
        if (Date.now() < f.pomodoroEndsAt) return true;
        f.pomodoroEndsAt = null;
        scheduleSettingsSave();
    }
    if (!f.scheduleEnabled) return false;
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    return f.scheduleStart <= f.scheduleEnd
        ? (mins >= f.scheduleStart && mins < f.scheduleEnd)
        : (mins >= f.scheduleStart || mins < f.scheduleEnd);
}

// -----------------------------------------------------------------------
// Conservative pop-up-ad + tracker/analytics domain lists, mirrored from
// the iOS app's AdBlockService / TrackerBlockService (short + deliberate,
// not a full EasyList — avoids breaking sites that share infra with ads).
// -----------------------------------------------------------------------
const AD_DOMAINS = [
    "popads.net", "propellerads.com", "poptox.com", "adnxs.com",
    "exoclick.com", "juicyads.com", "clickadu.com"
];
const TRACKER_DOMAINS = [
    "google-analytics.com", "googletagmanager.com", "googlesyndication.com",
    "doubleclick.net", "facebook.net", "connect.facebook.net",
    "analytics.tiktok.com", "ads-twitter.com", "scorecardresearch.com",
    "hotjar.com", "segment.io", "mixpanel.com", "amplitude.com",
    "criteo.com", "outbrain.com", "taboola.com", "adsrvr.org",
    "quantserve.com", "chartbeat.com", "newrelic.com"
];

function domainOf(url) {
    try { return new URL(url).hostname; } catch { return ""; }
}
function hostMatches(hostname, domain) {
    return hostname === domain || hostname.endsWith("." + domain);
}

ipcMain.handle("privacy:getStats", () => ({
    trackersBlockedCount: settings.trackersBlockedCount || 0
}));

// -----------------------------------------------------------------------
// Attaches permission handling + the ad/tracker/focus-mode/Google-login
// request filter to a given session. Applied to the main persistent
// session AND to every webview guest session (including incognito guests)
// the moment it's created, via app.on("web-contents-created") below.
// -----------------------------------------------------------------------
const ALLOWED_PERMISSIONS = new Set([
    "media", "camera", "microphone", "notifications",
    "clipboard-read", "fullscreen", "pointerLock", "background-sync"
]);
const _configuredSessions = new WeakSet();

function attachSessionPolicies(ses) {
    if (!ses || _configuredSessions.has(ses)) return;
    _configuredSessions.add(ses);

    ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
        console.log("[PERMISSION CHECK]", permission, requestingOrigin, details?.mediaType);
        return ALLOWED_PERMISSIONS.has(permission);
    });

    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
        console.log("[PERMISSION REQUEST]", permission, details?.mediaTypes || "");
        callback(ALLOWED_PERMISSIONS.has(permission));
    });

    ses.webRequest.onBeforeRequest((details, callback) => {
        const url = details.url;

        // --- Google login gate (kept from original behavior) ---
        if (details.resourceType === "mainFrame" && url.includes("accounts.google.com")) {
            const isAccountChooser = url.includes("/v3/signin/accountchooser");
            const isIdentifier = url.includes("/v3/signin/identifier");
            if (isAccountChooser) return callback({});
            if (isIdentifier) {
                console.log("🚫 BLOCKED GOOGLE IDENTIFIER:", url);
                BrowserWindow.getAllWindows().forEach(w => w.webContents.send("google-login-blocked"));
                return callback({ redirectURL: `file://${__dirname}/google-blocked.html` });
            }
        }

        const hostname = domainOf(url);
        if (!hostname) return callback({});

        // --- Focus Mode: block whole-page navigation to distracting sites ---
        if (details.resourceType === "mainFrame" && isFocusActive()) {
            const blocked = settings.focusMode.sites.find(d => hostMatches(hostname, d));
            if (blocked) {
                return callback({
                    redirectURL: `file://${__dirname}/focus-blocked.html?site=${encodeURIComponent(blocked)}`
                });
            }
        }

        // --- Ad blocking ---
        if (settings.adBlockEnabled && AD_DOMAINS.some(d => hostMatches(hostname, d))) {
            return callback({ cancel: true });
        }

        // --- Tracker blocking ---
        if (settings.trackerBlockEnabled && TRACKER_DOMAINS.some(d => hostMatches(hostname, d))) {
            settings.trackersBlockedCount = (settings.trackersBlockedCount || 0) + 1;
            scheduleSettingsSave();
            BrowserWindow.getAllWindows().forEach(w => {
                if (!w.isDestroyed()) {
                    w.webContents.send("tracker:blocked", {
                        host: hostname,
                        total: settings.trackersBlockedCount
                    });
                }
            });
            return callback({ cancel: true });
        }

        callback({});
    });

    ses.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders["User-Agent"] =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
        details.requestHeaders["Accept-Language"] = "en-US,en;q=0.9";
        callback({ requestHeaders: details.requestHeaders });
    });
}

// Fires for EVERY webContents Electron creates — including each <webview>
// guest page (main window's browsing tabs AND any incognito window's tabs)
// — so camera/mic permission handling and ad/tracker/focus filtering are
// applied consistently everywhere content is rendered, not just the shell.
app.on("web-contents-created", (_event, contents) => {
    attachSessionPolicies(contents.session);
});

// -----------------------------------------------------------------------
// Incognito windows — a fresh in-memory (non "persist:") session partition
// per window means no cookies/history/local-storage survive it closing,
// and nothing is written to the shared "persist:main" store at all.
// -----------------------------------------------------------------------
let incognitoWindows = [];

function createIncognitoWindow() {
    const incWin = new BrowserWindow({
        width: 1200,
        height: 800,
        backgroundColor: "#0f0f14",
        frame: false,
        icon: path.join(__dirname, "assets/isla.png"),
        webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            nodeIntegration: false,
            contextIsolation: true,
            devTools: false,
            webviewTag: true,
            sandbox: false,
            allowRunningInsecureContent: true,
            webSecurity: true,
            backgroundThrottling: false,
            autoplayPolicy: "no-user-gesture-required",
            plugins: true
        }
    });

    incWin.loadFile("index.html", { search: "incognito=1" });
    incognitoWindows.push(incWin);
    incWin.on("closed", () => {
        incognitoWindows = incognitoWindows.filter(w => w !== incWin);
    });
    return incWin;
}

ipcMain.handle("open-incognito-window", () => {
    createIncognitoWindow();
    return true;
});

// Trust Engine (a port of the iOS engine - see Trust/): the renderer sends a hostname, everything else happens here.
const { createTrustController } = require("./Trust/controller.cjs");
const trustController = createTrustController({ dataDir: app.getPath("userData") });
ipcMain.handle("trust:check", async (_e, host, opts) => {
    try {
        const hostName = typeof host === "string" ? host : "";
        const checkOpts = { deepScan: !!(opts && opts.deepScan), force: !!(opts && opts.force) };
        // Only real, fresh work is charged: a local page, a cache hit or an already-running lookup costs nothing (see needsFreshCheck).
        if (trustController.needsFreshCheck(hostName, checkOpts)) {
            const decision = await entitlementCheck("trust-engine");
            if (!decision.allowed) return { ok: false, blocked: true, error: decision.message, reason: decision.reason, cooldownUntil: decision.cooldownUntil, plan: decision.plan };
        }
        return await trustController.check(hostName, checkOpts);
    } catch (err) {
        return { ok: false, error: err && err.message ? err.message : "Trust check failed" };
    }
});

const historyPath = path.join(app.getPath("userData"), "history.json");
let downloads = [];

ipcMain.handle("get-downloads", () => downloads);
const bookmarksPath = path.join(app.getPath("userData"), "bookmarks.json");

function readBookmarks() {
    try {
        const list = JSON.parse(fs.readFileSync(bookmarksPath, "utf8"));
        return Array.isArray(list) ? list.filter((b) => b && typeof b.url === "string") : [];
    } catch (_) {
        return []; // missing or corrupt file: start from an empty list rather than break the browser
    }
}
function writeBookmarks(list) {
    fs.writeFileSync(bookmarksPath, JSON.stringify(list, null, 2));
}
// Only real web pages can be bookmarked: the list is opened again through the address bar's own loader, which handles
// http(s) (Jonah's start page and javascript:/data: URLs are deliberately not bookmarkable).
const bookmarkKey = (u) => String(u || "").replace(/#.*$/, "");
const isBookmarkable = (u) => typeof u === "string" && u.length <= 2048 && /^https?:\/\//i.test(u);

ipcMain.handle("get-bookmarks", () => readBookmarks());
ipcMain.handle("is-bookmarked", (_e, url) => {
    const key = bookmarkKey(url);
    return !!key && readBookmarks().some((b) => bookmarkKey(b.url) === key);
});
// One button both adds and removes, like a browser's star: returns the new state.
ipcMain.handle("toggle-bookmark", (_e, page) => {
    const url = page && page.url;
    if (!isBookmarkable(url)) return { ok: false, error: "This page can't be bookmarked." };
    const key = bookmarkKey(url);
    const list = readBookmarks();
    const at = list.findIndex((b) => bookmarkKey(b.url) === key);
    try {
        if (at >= 0) {
            list.splice(at, 1);
            writeBookmarks(list);
            return { ok: true, bookmarked: false };
        }
        const title = String((page && page.title) || "").trim().slice(0, 200);
        list.unshift({ url, title: title || url, addedAt: Date.now() });
        writeBookmarks(list);
        return { ok: true, bookmarked: true };
    } catch (err) {
        return { ok: false, error: "Could not save the bookmark: " + err.message };
    }
});
ipcMain.handle("remove-bookmark", (_e, url) => {
    const key = bookmarkKey(url);
    try {
        writeBookmarks(readBookmarks().filter((b) => bookmarkKey(b.url) !== key));
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});
function saveHistory(url) {
    let history = [];

    if (fs.existsSync(historyPath)) {
        try {
            history = JSON.parse(fs.readFileSync(historyPath));
        } catch {
            history = [];
        }
    }

    // avoid duplicates spam
    if (history.length === 0 || history[0] !== url) {
        history.unshift(url);
    }

    // limit size
    history = history.slice(0, 500);

    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
}
ipcMain.handle('search-google', async (event, query) => {
    const { status, body } = await fetchSearch("web", query, { root: __dirname, log: (...a) => console.log("[search]", ...a) });
    if (status !== 200) {
        console.error("Search proxy error:", body && body.error && body.error.message);
        return null;
    }
    return body;
});
ipcMain.handle(
    "kokoro:speak",
    async (_event, text, options = {}) => {

        if (
            !text ||
            !String(text).trim()
        ) {
            return {
                success: false,
                error: "Empty speech text"
            };
        }

        const voice =
            options.voice ||
            "af_heart";

        const speed =
            Number(options.speed) ||
            1;

        console.log(
            "[KOKORO REMOTE] Sending:",
            text
        );

        console.log(
            "[KOKORO REMOTE] Endpoint:",
            KOKORO_RENDER_URL
        );

        try {

            const response =
                await axios.post(
                    `${KOKORO_RENDER_URL}/tts`,
                    {
                        text: String(text),
                        voice,
                        speed
                    },
                    {
                        responseType: "arraybuffer",
                        timeout: 120000,
                        headers: {
                            "Content-Type":
                                "application/json"
                        }
                    }
                );

            const wavBuffer =
                Buffer.from(
                    response.data
                );

            console.log(
                "[KOKORO REMOTE] Received:",
                wavBuffer.length,
                "bytes"
            );

            return {
                success: true,

                audioBase64:
                    wavBuffer.toString(
                        "base64"
                    ),

                mimeType:
                    response.headers[
                        "content-type"
                    ] ||
                    "audio/wav"
            };

        } catch (error) {

            console.error(
                "[KOKORO REMOTE] FAILED:",
                error?.response?.data
                    ? Buffer.from(
                        error.response.data
                    ).toString()
                    : error.message
            );

            return {
                success: false,

                error:
                    error?.response?.data
                        ? Buffer.from(
                            error.response.data
                        ).toString()
                        : error?.message ||
                          String(error)
            };
        }
    }
);
let cachedNews = null;
// News comes from jonahbrowser.store (/news/headlines), which holds the NewsAPI key: India's top headlines, or the newest
// technology articles when there are none - the same as Jonah used to fetch itself. Jonah's .env only holds JONAH_PROXY_KEY.
ipcMain.handle('get-news', async (event, page = 1) => {
    const { status, body } = await fetchNews({ country: "in", page, pageSize: 12 }, { root: __dirname, log: (...a) => console.log("[news]", ...a) });
    if (status === 200) {
        cachedNews = body;
        return body;
    }
    console.error("News error:", body && body.error && body.error.message);
    if (cachedNews) {
        console.log("Using cached news");
        return cachedNews;
    }
    return null;
});
ipcMain.handle('get-all-sports', async () => {
    console.log("🔥 SPORTS HANDLER CALLED");

    try {
        const response = await axios.get(
            "https://v3.football.api-sports.io/fixtures?live=all",
            {
                headers: {
                    "x-apisports-key": "5c0455e6db829e5714d75dd4c26b4bb8"
                }
            }
        );
        return response.data;
    } catch (err) {
        console.error("❌ SPORTS API ERROR:", err.message);
        return { error: true };
    }
});
ipcMain.handle("rexy:start", async () => {

    if (!rexyRuntime) {

        rexyRuntime = new RexyRuntime(mainWindow);
        rexyRuntime.noah = noah && noah.bridge;
        _wireRuntimeEvents(rexyRuntime);

    }

    await rexyRuntime.start();

    console.log("Runtime object:", rexyRuntime);
    return true;

});

function _wireRuntimeEvents(runtime) {
    runtime.on("goal:step", (data) => {
        mainWindow?.webContents.send("runtime:goal-step", data);
    });
    runtime.on("goal:completed", (data) => {
        mainWindow?.webContents.send("runtime:goal-completed", data);
    });
    runtime.on("goal:error", (data) => {
        mainWindow?.webContents.send("runtime:goal-error", {
            error: data?.error?.message || String(data?.error || "Unknown error"),
            source: data?.entry?.source // typed vs spoken: only a spoken request's failure is read aloud
        });
    });
    runtime.on("goal:blocked", (data) => {
        mainWindow?.webContents.send("runtime:goal-blocked", data);
    });
    runtime.on("goal:paused", (data) => {
        mainWindow?.webContents.send("runtime:goal-paused", data);
    });
}

ipcMain.handle("rexy:stop", async () => {

    if (rexyRuntime) {

        rexyRuntime.stop();

    }

    return true;

});

ipcMain.handle("rexy:goal", async (_event, goal, opts) => {

    // The runtime is created here if nothing started it yet: a spoken or typed instruction must never be refused
    // because some earlier step (a stop, a restart) left it missing.
    if (!rexyRuntime) {

        rexyRuntime = new RexyRuntime(mainWindow);
        rexyRuntime.noah = noah && noah.bridge;
        _wireRuntimeEvents(rexyRuntime);

    }

    try {

        // "voice" / "text" only: the renderer cannot smuggle anything else into the agent
        const source = opts && opts.source === "voice" ? "voice" : "text";
        // "chat" / "agent" is the user's explicit pick in the assistant panel; anything else is "auto"
        const mode = opts && (opts.mode === "chat" || opts.mode === "agent") ? opts.mode : "auto";
        // Attached files: the renderer sends only ids; anything that is not a file this process really holds is dropped,
        // and the text sent to the model is cut to what fits and is relevant to THIS question.
        const attachmentIds = attachmentStore.validIds(opts && opts.attachmentIds);
        const attachments = attachmentIds.length ? attachmentStore.buildContext(attachmentIds, String(goal)) : null;

        // Billing/entitlements: predicts which feature this becomes (agent / chat / a free control command on an existing task -
        // see entitlement-gate.cjs's classifyGoal for exactly what this can and cannot see) and asks noahai.live BEFORE any real
        // work starts - submitGoal below can begin the actual model/browser work synchronously, so this must happen first.
        const predictedFeature = entitlementGate ? entitlementGate.classifyGoal(String(goal), mode, { hasAttachments: !!attachments }) : "control";
        const decision = await entitlementCheck(predictedFeature);
        if (!decision.allowed) {
            return { success: false, blocked: true, error: decision.message, reason: decision.reason, feature: predictedFeature, cooldownUntil: decision.cooldownUntil, plan: decision.plan };
        }

        const goalId = rexyRuntime.submitGoal(goal, { source, mode, attachments });

        return {
            success: true,
            goalId,
            kind: rexyRuntime.lastSubmit && rexyRuntime.lastSubmit.id === goalId ? rexyRuntime.lastSubmit.kind : undefined,
            // what of the files was actually shown to the model (the panel says so when it was only excerpts)
            attachmentUse: attachments && rexyRuntime.lastSubmit && rexyRuntime.lastSubmit.kind === "chat" ? attachments.files : undefined
        };

    } catch (err) {

        return {
            success: false,
            error: err.message
        };

    }
console.log("Runtime inside goal:", rexyRuntime);
console.log("Running:", rexyRuntime?.running);
});
const { crashReporter } = require('electron');
crashReporter.start({
  submitURL: '', // no remote upload, just write locally
  uploadToServer: false,
  compress: false
});
ipcMain.handle("rexy:status", () => {

    return {
        running: !!rexyRuntime?.running,
        currentGoal: rexyRuntime?.currentGoal ?? null
    };

});
ipcMain.handle("rexy:navigate", async (_event, url) => {

    console.log("🚀 NAVIGATE REQUEST:", url);

    return await mainWindow.webContents.executeJavaScript(`
        (() => {

            const w = window.RexyRenderer?.webview?.();

            if (!w) {
                return {
                    success:false,
                    error:"No active webview"
                };
            }

            let finalURL = ${JSON.stringify(url)};

            if (
                !finalURL.startsWith("http://") &&
                !finalURL.startsWith("https://")
            ) {
                finalURL = "https://" + finalURL;
            }

            w.loadURL(finalURL);

            return {
                success:true,
                url:finalURL
            };

        })();
    `);

});

ipcMain.handle("rexy:click", async (event, selector) => {

    if (!mainWindow) return false;

    return await mainWindow.webContents.executeJavaScript(`
        window.RexyRenderer.click(${JSON.stringify(selector)});
    `);

});

ipcMain.handle("rexy:type", async (event, data) => {

    if (!mainWindow) return false;

    return await mainWindow.webContents.executeJavaScript(`
        window.RexyRenderer.type(
            ${JSON.stringify(data.selector)},
            ${JSON.stringify(data.text)}
        );
    `);

});

ipcMain.handle("rexy:scroll", async (event, data) => {

    if (!mainWindow) return false;

    return await mainWindow.webContents.executeJavaScript(`
        window.RexyRenderer.scroll(
            ${Number(data.x || 0)},
            ${Number(data.y || 0)}
        );
    `);

});

ipcMain.handle("rexy:execute-js", async (event, script) => {

    if (!mainWindow) return null;

    return await mainWindow.webContents.executeJavaScript(`
        window.RexyRenderer.execute(${JSON.stringify(script)});
    `);

});

ipcMain.handle("rexy:observe", async () => {

    if (!mainWindow) return null;

    return await mainWindow.webContents.executeJavaScript(`
        window.RexyRenderer.observe();
    `);

});

ipcMain.handle("rexy:active-tab", async () => {

    if (!mainWindow) return null;

    return await mainWindow.webContents.executeJavaScript(`

        (()=>{

            const w=window.RexyRenderer.webview();

            if(!w) return null;

            return{

                url:w.getURL(),

                title:w.getTitle()

            };

        })();

    `);

});

ipcMain.handle("rexy:tabs", async () => {

    if (!mainWindow) return [];

    return await mainWindow.webContents.executeJavaScript(`

        (()=>{

            if(typeof tabData==="undefined") return [];

            return tabData.map(t=>({

                title:t.title,

                url:t.url

            }));

        })();

    `);

});
ipcMain.handle('get-all-sports-custom', async (event, endpoint) => {
    console.log("🔥 CUSTOM ENDPOINT:", endpoint);
    try {
        const response = await axios.get(
            `https://v3.football.api-sports.io/${endpoint}`,
            {
                headers: {
                    "x-apisports-key": "5c0455e6db829e5714d75dd4c26b4bb8"
                }
            }
        );
        console.log("✅ DATA SENT BACK");
        return response.data;
    } catch (err) {
        console.error("❌ CUSTOM API ERROR:", err.response?.data || err.message);
        return { error: true };
    }
});
ipcMain.handle("get-history", () => {
    if (fs.existsSync(historyPath)) {
        return JSON.parse(fs.readFileSync(historyPath));
    }
    return [];
});
ipcMain.handle("clear-history", () => {
    if (fs.existsSync(historyPath)) {
        fs.writeFileSync(historyPath, JSON.stringify([]));
    }
    return true;
});
ipcMain.on('open-external', (event, url) => {
    console.log("🚫 BLOCKED EXTERNAL OPEN:", url);
});
console.log("Electron:", process.versions.electron);
console.log("Chromium:", process.versions.chromium);
console.log("Node:", process.versions.node);
const modelServer = express();
modelServer.use(express.static(path.join("C:/Jonah/Kokoro-82M")));
modelServer.listen(5588, () => console.log("Local model server on :5588"));
const uiServer = express();

// Search goes through the Jonah search proxy (jonahbrowser.store), which holds the Google credentials; pages call this
// local relay so the proxy's shared secret (JONAH_PROXY_KEY in .env) never reaches a page.
mountSearchProxy(uiServer, { root: __dirname, log: (...a) => console.log("[search]", ...a) });
// dotfiles: "deny" keeps .env (API keys, JONAH_PROXY_KEY) from being served to any page that can reach this port.
uiServer.use(express.static(__dirname, { dotfiles: "deny" }));

uiServer.listen(5589, "127.0.0.1", () => {
    console.log("Jonah UI server running on http://127.0.0.1:5589");
});
async function createWindow() {
    mainWindow = new BrowserWindow({
        
        width: 1200,
        height: 800,
        backgroundColor: "#0f0f14",
        frame: false,

        icon: path.join(__dirname, 'assets/isla.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            devTools: false, // developer tools are disabled permanently (see the web-contents-created handler)
            webviewTag: true,
            enableRemoteModule: false,
            sandbox: false,
            partition: "persist:main",
            allowRunningInsecureContent: true,
            webSecurity: true,
            backgroundThrottling: false,
            autoplayPolicy: "no-user-gesture-required",
            plugins: true,
            nativeWindowOpen: true,
            webviewTag: true
        }
    });
    const userAgent =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
    const ses = session.fromPartition("persist:main");
    ses.on("will-download", (event, item) => {

        const file = {
            name: item.getFilename(),
            path: "",
            status: "downloading",
            received: 0,
            total: item.getTotalBytes()
        };

        downloads.unshift(file);

        // Optional: set save path (or let user choose)
        const savePath = path.join(app.getPath("downloads"), file.name);
        item.setSavePath(savePath);
        file.path = savePath;

        item.on("updated", () => {
            file.received = item.getReceivedBytes();

            if (item.isPaused()) {
                file.status = "paused";
            } else {
                file.status = "downloading";
            }
        });

        item.once("done", (e, state) => {
            if (state === "completed") {
                file.status = "completed";
            } else {
                file.status = "failed";
            }
        });
    });
    
    mainWindow.webContents.session = ses;
    

    
    mainWindow.webContents.on('render-process-gone', (event, details) => {
        console.error('🔥 RENDERER GONE - reason:', details.reason, 'exitCode:', details.exitCode);
        console.error(details); // dump full details object, may include more info on some builds
    });

    app.on('gpu-process-crashed', (event, killed) => {
        console.error('🔥 GPU PROCESS CRASHED - killed:', killed);
    });

    app.on('child-process-gone', (event, details) => {
        console.error('🔥 CHILD PROCESS GONE:', details);
    });
    mainWindow.webContents.on("did-navigate", (event, url) => {
        saveHistory(url);
    });
    mainWindow.webContents.setWindowOpenHandler(() => {
        return { action: "deny" };
    });

    mainWindow.webContents.on("did-navigate-in-page", (event, url) => {
        saveHistory(url);
    });
    

// 👇 PUT YOUR CODE RIGHT HERE
    vpn.init(mainWindow);
    mainWindow.webContents.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );
    ses.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        );

    // Permission handling + ad/tracker/focus-mode/Google-login filtering
    // is attached uniformly for every session via the
    // app.on("web-contents-created", ...) hook above.
    attachSessionPolicies(ses);

    // Noah must be constructed BEFORE the page loads: the shell asks for its theme/config on startup.
    try {
        noah = createNoah({
            mainWindow,
            ipcMain,
            electron: { webContents, screen, safeStorage, session },
            dataDir: path.join(app.getPath("userData"), "noah"),
            appRoot: __dirname,
            log: (...a) => console.log("[noah]", ...a)
        });
    } catch (err) {
        console.error("Noah failed to start (the legacy agent still works):", err);
    }

    mainWindow.loadFile("index.html");
    mainWindow.webContents.once("did-finish-load", async () => {

        rexyRuntime = new RexyRuntime(mainWindow);
        rexyRuntime.noah = noah && noah.bridge; // browser goals go to Noah when a model is configured
        _wireRuntimeEvents(rexyRuntime);

        await rexyRuntime.start();
        console.log("Runtime running:", rexyRuntime.running);
        console.log("Runtime state:", rexyRuntime.state);

        console.log("🧠 Noah Runtime Started");

    });
    mainWindow.on("closed", () => {

        if (noah) { noah.dispose(); noah = null; }

        if (rexyRuntime) {

            rexyRuntime.stop();

            rexyRuntime = null;

        }

    });
    
    mainWindow.webContents.setAudioMuted(false);
    
    mainWindow.webContents.on("before-input-event", (event, input) => {
  
        if (input.key === "F12") {
            event.preventDefault();
        }

        // Block Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C
        if (input.control && input.shift && ["I", "J", "C"].includes(input.key.toUpperCase())) {
            event.preventDefault();
        }

        // Block Ctrl+U (view source)
        if (input.control && input.key.toUpperCase() === "U") {
            event.preventDefault();
        }
    });
}

// Developer tools are disabled permanently, everywhere: no window, no <webview> page, no shortcut and no menu entry can open them.
app.on("web-contents-created", (_event, contents) => {
    // pages loaded in a <webview> get devTools:false too (this event is only emitted by windows that host webviews)
    contents.on("will-attach-webview", (_e, webPreferences) => {
        webPreferences.devTools = false;
    });
    // backstop: if anything ever gets DevTools open, close it again straight away
    contents.on("devtools-opened", () => {
        try { contents.closeDevTools(); } catch (_) { /* ignore */ }
    });
    // F12, Ctrl+Shift+I / J / C (Cmd+Alt+I / J / C on a Mac) do nothing, in the shell AND inside pages
    contents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown") return;
        const key = String(input.key || "").toUpperCase();
        const devKey = ["I", "J", "C"].includes(key);
        if (key === "F12" || (devKey && input.shift && (input.control || input.meta)) || (devKey && input.alt && input.meta)) event.preventDefault();
    });
});

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  event.preventDefault()
  callback(true)
})
app.whenReady().then(async () => {

    // Billing/entitlements: created here, not at module load, because it needs safeStorage (only reliable once the app is ready).
    // A no-op pass-through unless JONAH_ENTITLEMENTS_ENABLED=1 - see entitlement-gate.cjs's own header.
    entitlementGate = createEntitlementGate({
        userDataDir: app.getPath("userData"), safeStorage,
        // Google sign-in must happen in the user's REAL browser (never an in-app window). Only https/http URLs ever reach this.
        openExternal: (url) => { if (!/^https?:\/\//i.test(url)) throw new Error("refusing to open a non-web URL"); return shell.openExternal(url); },
        allowInsecureLoopback: !app.isPackaged, // http://127.0.0.1 only for a dev/test run, exactly like the old license system's rule
        log: (...a) => console.log("[entitlements]", ...a),
    });
    registerBillingIpc({ ipcMain, gate: entitlementGate, openExternal: (url) => shell.openExternal(url), log: (...a) => console.log("[billing]", ...a) });

    // Updates come from the GitHub Releases in updater.cjs (RELEASE_REPO, kept equal to package.json build.publish by a unit test).
    // It is NOT read from package.json here: electron-builder removes the "build" section from the packaged copy, so doing that crashed
    // startup in the installed app. Windows updates itself; the Mac app installs updates only once it is signed and notarized
    // (installOnMac). Only a packaged app ever checks, and a problem here must never stop the window from opening.
    try {
        createUpdater({
            autoUpdater, dialog, shell, app, getWindow: () => mainWindow,
            ...RELEASE_REPO,
            installOnMac: true, // the Mac build is signed with a Developer ID certificate and accepted by Apple's notary service
            log: (...a) => console.log("[updater]", ...a),
        }).start();
    } catch (e) { console.log("[updater] could not start:", e && e.message); }

    warmUpRenderServices();
    setInterval(warmUpRenderServices, WARMUP_INTERVAL_MS);

    // Pre-attach policies to the shared persistent session so they're
    // ready before the first webview even attaches.
    attachSessionPolicies(session.fromPartition("persist:main"));

    await createWindow();

    // Web search for the Trust Engine and the AI chat: Google's own results page, read in a hidden window of the same session as
    // the tabs (google-serp.cjs). Closed with the main window, or the hidden window would keep Jonah running after it is closed.
    const googlePage = createGoogleSearch({
        BrowserWindow, session, partition: "persist:main",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        log: (...a) => console.log("[google]", ...a),
    });
    setWebSearchBackend((query, options) => googlePage.search(query, options));
    mainWindow.on("closed", () => { setWebSearchBackend(null); googlePage.close(); });
});
    // 🔥 STRONG FILTER SYSTEM

    

        // 🔥 BLOCK EMBEDS / VIDEOS / IFRAMES
        // 🔥 DO NOT block subresources at all
        
    
    
    
    
    
ipcMain.on('minimize-window', () => {
    if (mainWindow) mainWindow.minimize();
});

ipcMain.on('maximize-window', () => {
    if (!mainWindow) return;

    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow.maximize();
    }
});

ipcMain.on('close-window', () => {
    if (mainWindow) mainWindow.close();
});
