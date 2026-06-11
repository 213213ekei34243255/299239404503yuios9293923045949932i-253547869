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

    getBookmarks: () => ipcRenderer.invoke("get-bookmarks"),
    getDownloads: () => ipcRenderer.invoke("get-downloads"),

    getSearchURL: (query) => {
        return `search.html?q=${encodeURIComponent(query)}`;
    }
});

contextBridge.exposeInMainWorld('sportsAPI', {
    getAll: () => ipcRenderer.invoke('get-all-sports'),
    getCustom: (endpoint) => ipcRenderer.invoke('get-all-sports-custom', endpoint)
});