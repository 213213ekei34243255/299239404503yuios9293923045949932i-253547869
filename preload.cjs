Object.defineProperty(navigator, 'webdriver', {
  get: () => false,
});

const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('api', {
    minimize: () => ipcRenderer.send('minimize-window'),
    maximize: () => ipcRenderer.send('maximize-window'),
    onNavigate: (callback) => ipcRenderer.on('navigate', callback),
    getPage: () => ipcRenderer.invoke('get-page-content'),
    close: () => ipcRenderer.send('close-window'),
    googleLogin: () => ipcRenderer.invoke('google-login'),
    getNews: (page) => ipcRenderer.invoke('get-news', page),
    getVpnStatus: () => ipcRenderer.invoke('vpn-get-status'),
    onVpnStatus: (cb) => ipcRenderer.on('vpn-status', (_, data) => cb(data)),
    searchGoogle: (query) => ipcRenderer.invoke('search-google', query),
    openExternal: (url) => shell.openExternal(url),

    // 🔥 ADD THIS
    send: (channel, data) => ipcRenderer.send(channel, data),

    onTypeURL: (cb) => ipcRenderer.on('type-url', cb),
    sendOpenExternal: (url) => ipcRenderer.send('open-external', url),
    onInjectJS: (cb) => ipcRenderer.on('inject-js', cb),
    onGoogleBlocked: (cb) => ipcRenderer.on("google-login-blocked", cb),
    onPressEnterURL: (cb) => ipcRenderer.on('press-enter-url', cb),

    getHistory: () => ipcRenderer.invoke("get-history"),
    clearHistory: () => ipcRenderer.invoke("clear-history"), // 🔥 ADD THIS
    kokoroSpeak: (text, options = {}) =>
            ipcRenderer.invoke(
                "kokoro:speak",
                text,
                options
            ),
    trustCheck: (host, opts) => ipcRenderer.invoke("trust:check", host, { deepScan: !!(opts && opts.deepScan), force: !!(opts && opts.force) }),
    getBookmarks: () => ipcRenderer.invoke("get-bookmarks"),
    isBookmarked: (url) => ipcRenderer.invoke("is-bookmarked", url),
    toggleBookmark: (page) => ipcRenderer.invoke("toggle-bookmark", { url: page && page.url, title: page && page.title }),
    removeBookmark: (url) => ipcRenderer.invoke("remove-bookmark", url),
    getDownloads: () => ipcRenderer.invoke("get-downloads"),

    getSearchURL: (query) => {
        return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    },

    // ---------------- Settings (theme, ad/tracker block, focus mode) ----------------
    getSettings: () => ipcRenderer.invoke("settings:get"),
    setSettings: (partial) => ipcRenderer.invoke("settings:set", partial),
    onSettingsChanged: (cb) => ipcRenderer.on("settings:changed", (_e, data) => cb(data)),

    getFocusSettings: () => ipcRenderer.invoke("settings:get").then(s => s.focusMode),
    updateFocus: (partial) => ipcRenderer.invoke("focus:update", partial),
    startPomodoro: (minutes) => ipcRenderer.invoke("focus:startPomodoro", minutes),
    stopPomodoro: () => ipcRenderer.invoke("focus:stopPomodoro"),

    getPrivacyStats: () => ipcRenderer.invoke("privacy:getStats"),
    onTrackerBlocked: (cb) => ipcRenderer.on("tracker:blocked", (_e, data) => cb(data)),

    // ---------------- Incognito ----------------
    openIncognitoWindow: () => ipcRenderer.invoke("open-incognito-window")
});

// ---------------------------------------------------------------------------
// Noah (computer-use agent). Minimal, explicit surface: no generic ipc access,
// no secrets. The main process re-validates the sender of every call.
// ---------------------------------------------------------------------------
contextBridge.exposeInMainWorld('noah', {
    submit: (goal) => ipcRenderer.invoke('noah:submit', String(goal)),
    stop: () => ipcRenderer.invoke('noah:stop'),
    pause: () => ipcRenderer.invoke('noah:pause'),
    resume: () => ipcRenderer.invoke('noah:resume'),
    confirm: (id, allow) => ipcRenderer.invoke('noah:confirm', String(id), allow === true),
    getConfig: () => ipcRenderer.invoke('noah:get-config'),
    setConfig: (patch) => ipcRenderer.invoke('noah:set-config', patch),
    setKey: (provider, key) => ipcRenderer.invoke('noah:set-key', String(provider), String(key)),
    getTheme: () => ipcRenderer.invoke('noah:get-theme'),
    listTasks: () => ipcRenderer.invoke('noah:list-tasks'),
    resumeTask: (taskId) => ipcRenderer.invoke('noah:resume-task', String(taskId)),
    getState: () => ipcRenderer.invoke('noah:get-state'),
    getAudit: () => ipcRenderer.invoke('noah:get-audit'),
    onEvent: (cb) => {
        const listener = (_e, evt) => cb(evt);
        ipcRenderer.on('noah:event', listener);
        return () => ipcRenderer.removeListener('noah:event', listener);
    }
});

contextBridge.exposeInMainWorld('sportsAPI', {
    getAll: () => ipcRenderer.invoke('get-all-sports'),
    getCustom: (endpoint) => ipcRenderer.invoke('get-all-sports-custom', endpoint)
});
contextBridge.exposeInMainWorld("rexy", {

    // Runtime
    start: () => ipcRenderer.invoke("rexy:start"),

    stop: () => ipcRenderer.invoke("rexy:stop"),

    goal: (goal, opts) => ipcRenderer.invoke("rexy:goal", goal, {
        ...(opts && opts.source === "voice" ? { source: "voice" } : {}),
        ...(opts && (opts.mode === "chat" || opts.mode === "agent") ? { mode: opts.mode } : {}),
    }),

    status: () => ipcRenderer.invoke("rexy:status"),

    // Browser Control

    navigate: (url) => ipcRenderer.invoke("rexy:navigate", url),

    click: (selector) => ipcRenderer.invoke("rexy:click", selector),

    type: (selector, text) => ipcRenderer.invoke("rexy:type", {
        selector,
        text
    }),

    scroll: (x, y) => ipcRenderer.invoke("rexy:scroll", {
        x,
        y
    }),

    executeJS: (script) => ipcRenderer.invoke("rexy:execute-js", script),

    observe: () => ipcRenderer.invoke("rexy:observe"),
    onBack: (callback) =>
        ipcRenderer.on("rexy:back", callback),

    onForward: (callback) =>
        ipcRenderer.on("rexy:forward", callback),

    onReload: (callback) =>
        ipcRenderer.on("rexy:reload", callback),
    onGoalStep: (callback) => {
        const listener = (_e, data) => callback(data);
        ipcRenderer.on("runtime:goal-step", listener);
        return listener;
    },

    onGoalCompleted: (callback) => {
        const listener = (_e, data) => callback(data);
        ipcRenderer.on("runtime:goal-completed", listener);
        return listener;
    },

    onGoalPaused: (callback) => {
        const listener = (_e, data) => callback(data);
        ipcRenderer.on("runtime:goal-paused", listener);
        return listener;
    },

    onGoalError: (callback) => {
        const listener = (_e, data) => callback(data);
        ipcRenderer.on("runtime:goal-error", listener);
        return listener;
    },

    onGoalBlocked: (callback) => {
        const listener = (_e, data) => callback(data);
        ipcRenderer.on("runtime:goal-blocked", listener);
        return listener;
    },

    offGoalStep: (listener) => ipcRenderer.removeListener("runtime:goal-step", listener),
    offGoalCompleted: (listener) => ipcRenderer.removeListener("runtime:goal-completed", listener),
    offGoalPaused: (listener) => ipcRenderer.removeListener("runtime:goal-paused", listener),
    offGoalError: (listener) => ipcRenderer.removeListener("runtime:goal-error", listener),
    offGoalBlocked: (listener) => ipcRenderer.removeListener("runtime:goal-blocked", listener),

    screenshot: () => ipcRenderer.invoke("rexy:screenshot"),

    activeTab: () => ipcRenderer.invoke("rexy:active-tab"),

    tabs: () => ipcRenderer.invoke("rexy:tabs")

});
