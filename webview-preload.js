const { contextBridge, ipcRenderer, shell } = require('electron');

console.log("✅ WEBVIEW PRELOAD LOADED");

contextBridge.exposeInMainWorld('api', {
    search: (query) => ipcRenderer.invoke('search-google', query),
    getNews: (page = 1) => ipcRenderer.invoke('get-news', page),
    openExternal: (url) => shell.openExternal(url),
    // 🔥 ADD THIS
    googleLogin: () => ipcRenderer.invoke('google-login')
});

contextBridge.exposeInMainWorld("sportsAPI", {
    getAll: () => ipcRenderer.invoke("get-all-sports"),
    getCustom: (endpoint) => ipcRenderer.invoke("get-all-sports-custom", endpoint)

});
