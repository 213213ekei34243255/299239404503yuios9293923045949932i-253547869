const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const axios = require('axios');
const { autoUpdater } = require("electron-updater");
const express = require('express');
const { shell } = require('electron');
const fs = require("fs");
const vpn = require('./vpn.cjs'); // ← ADD THIS after all requires
const { pathToFileURL } = require('url');
const userDataPath = path.join(app.getPath("userData"), "browser-data");
app.setPath("userData", userDataPath);
app.commandLine.appendSwitch("persist-session-cookies");
app.commandLine.appendSwitch("restore-last-session");
const widevineDir =
"C:\Jonah\widevine"
app.commandLine.appendSwitch("widevine-cdm-path", widevineDir)
app.commandLine.appendSwitch(
  "enable-features",
  "PlatformHEVCDecoderSupport,HEVCSoftwareDecoding"
);
app.commandLine.appendSwitch("enable-features", "WidevineCdm");
app.commandLine.appendSwitch("enable-widevine-cdm");
app.commandLine.appendSwitch("enable-accelerated-video-decode");
app.commandLine.appendSwitch("enable-features", "PlatformHEVCDecoderSupport");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-features", "AudioServiceOutOfProcess");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-features", "PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("enable-webrtc-pipewire-capturer");
app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");
app.commandLine.appendSwitch("enable-accelerated-video-decode");
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,HEVCSoftwareDecoding');
const GOOGLE_API_KEY = "AIzaSyADND9PItYgU1JJwYclnW5E5ZWrZQiomaE";
const GOOGLE_CX = "227fd21b1ac784f3b";
const NEWS_API_KEY = "707146fc1eed4462a9609898231f68cd";
let mainWindow;
app.disableHardwareAcceleration = false;
app.userAgentFallback =
"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
app?.commandLine?.appendSwitch("enable-media-stream");
app?.commandLine?.appendSwitch("enable-usermedia-screen-capturing");
app?.commandLine?.appendSwitch("autoplay-policy", "no-user-gesture-required");
app?.commandLine?.appendSwitch("enable-features", "WebRTCPipeWireCapturer");
app.commandLine.appendSwitch("enable-webrtc-pipewire-capturer");
app.commandLine.appendSwitch("force-dark-mode", "false");
app.commandLine.appendSwitch("disable-dev-tools");
app.commandLine.appendSwitch("disable-features", "DeveloperToolsAvailability");
app.commandLine.appendSwitch("enable-features", "PrefersColorSchemeClientHintHeader");
app.commandLine.appendSwitch("enable-features", "WebRtcHideLocalIpsWithMdns,WebRtcAllowInputVolumeAdjustment");
autoUpdater.on("checking-for-update", () => {
    console.log("Checking for update...");
});

autoUpdater.on("update-available", (info) => {
    console.log("Update available:", info.version);
});

autoUpdater.on("update-not-available", () => {
    console.log("No update available");
});

autoUpdater.on("download-progress", (progress) => {
    console.log(`Downloaded ${progress.percent}%`);
});

autoUpdater.on("update-downloaded", () => {
    console.log("Update downloaded");
});
autoUpdater.on("update-downloaded", () => {
    autoUpdater.quitAndInstall();
});
const historyPath = path.join(app.getPath("userData"), "history.json");
let downloads = [];

ipcMain.handle("get-downloads", () => downloads);
const bookmarksPath = path.join(app.getPath("userData"), "bookmarks.json");

ipcMain.handle("get-bookmarks", () => {
    if (fs.existsSync(bookmarksPath)) {
        return JSON.parse(fs.readFileSync(bookmarksPath));
    }
    return [];
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
    try {
        const response = await axios.get(
            `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&cx=${GOOGLE_CX}&key=${GOOGLE_API_KEY}`
        );
        return response.data;
    } catch (error) {
        console.error("Google API Error:", error.message);
        return null;
    }
});
let cachedNews = null; 
ipcMain.handle('get-news', async (event, page = 1) => {
    try {
        const config = {
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json"
            }
        };
        let response = await axios.get(
            `https://newsapi.org/v2/top-headlines?country=in&pageSize=12&page=${page}&apiKey=${NEWS_API_KEY}`,
            config
        );
        if (response.data.totalResults === 0) {
            response = await axios.get(
                `https://newsapi.org/v2/everything?q=technology&pageSize=12&page=${page}&sortBy=publishedAt&apiKey=${NEWS_API_KEY}`,
                config
            );
        }
        cachedNews = response.data;
        return response.data;
    } catch (error) {
        console.error(
            "News API Error:",
            error.response?.status,
            error.response?.data || error.message
        );
        if (cachedNews) {
            console.log("Using cached news");
            return cachedNews;
        }
        return null;
    }
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

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        backgroundColor: "#0f0f14",
        frame: false,

        icon: path.join(__dirname, 'assets/Jonah.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            webviewTag: true,
            enableRemoteModule: false,
            sandbox: false,
            partition: "persist:main",
            enableBlinkFeatures: "WebRTC,MediaStream",
            experimentalFeatures: true,
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

        ses.webRequest.onBeforeSendHeaders((details, callback) => {
            details.requestHeaders["User-Agent"] =
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

            details.requestHeaders["Accept-Language"] = "en-US,en;q=0.9";

            details.requestHeaders["sec-ch-ua"] =
                '"Chromium";v="122", "Google Chrome";v="122", ";Not A Brand";v="99"';

            details.requestHeaders["sec-ch-ua-platform"] = '"Windows"';

            callback({ requestHeaders: details.requestHeaders });
        });
    
    ses.webRequest.onBeforeRequest((details, callback) => {
        const url = details.url;

        const isGoogle = url.includes("accounts.google.com");

        const isAccountChooser = url.includes("/v3/signin/accountchooser");
        const isIdentifier = url.includes("/v3/signin/identifier");

        if (details.resourceType === "mainFrame" && isGoogle) {

            // ✅ ALLOW account chooser (list of accounts)
            if (isAccountChooser) {
                return callback({});
            }

            // ❌ BLOCK actual login step
            if (isIdentifier) {
                console.log("🚫 BLOCKED GOOGLE IDENTIFIER:", url);

                mainWindow.webContents.send("google-login-blocked");

                return callback({
                    redirectURL: `file://${__dirname}/google-blocked.html`
                });
            }
        }

        // ✅ allow everything else
        callback({});
    });
    mainWindow.loadFile('index.html');
    
    mainWindow.webContents.setAudioMuted(false);
    //mainWindow.webContents.on("devtools-opened", () => {
      //  console.log("🚫 DevTools blocked");
        //mainWindow.webContents.closeDevTools();
    //});
    mainWindow.webContents.on("before-input-event", (event, input) => {
  // Block F12
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

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  event.preventDefault()
  callback(true)
})
app.whenReady().then(async () => {
    autoUpdater.checkForUpdatesAndNotify();
    const ses = session.fromPartition("persist:main");
    // 🔥 STRONG FILTER SYSTEM

    

        // 🔥 BLOCK EMBEDS / VIDEOS / IFRAMES
        // 🔥 DO NOT block subresources at all
        
    
    ses.setDevicePermissionHandler((details) => {
        return true;
    });
    ses.setPermissionRequestHandler((webContents, permission, callback) => {
        const allowed = [
            'media', 'microphone', 'camera', 'geolocation',
            'notifications', 'fullscreen', 'pointerLock',
            'clipboard-read', 'clipboard-sanitized-write',
            'protected-media-identifier','encrypted-media'   
        ];
        callback(allowed.includes(permission));
    });
    ses.setPermissionCheckHandler((webContents, permission) => {
        return ['media', 'camera', 'microphone', 'protected-media-identifier'].includes(permission);
    });
    createWindow();
});
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
