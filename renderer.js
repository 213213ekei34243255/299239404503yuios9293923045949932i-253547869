// ===================================
// STABLE SINGLE-WEBVIEW MULTI TAB
// ===================================

let tabData = [];
let activeTabIndex = 0;

document.addEventListener("DOMContentLoaded", function () {
    document.addEventListener("click", () => {
        const webview = document.getElementById("browser");

        if (!webview) return;

        webview.executeJavaScript(`
            // 🔥 FORCE AUDIO CONTEXT
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) {
                const ctx = new AudioContext();
                ctx.resume();
            }

            // try triggering media
            document.querySelectorAll("audio, video").forEach(el => {
                el.muted = false;
                el.play().catch(() => {});
            });
        `);
    }, { once: true });


    const loginBtn = document.getElementById("loginBtn");

    if (loginBtn) {
        loginBtn.addEventListener("click", () => {
            window.api.googleLogin();
        });
    }

    const webview = document.getElementById("browser");
    attachPopupHandler(webview);
    webview.addEventListener("dom-ready", async () => {
        webview.setAudioMuted(false);

        const url = webview.getURL();

        // 🚫 Skip local pages (home.html, file:// etc.)
        if (!url.startsWith("file://")) {

            // ✅ Fix dark broken websites ONLY for real sites
            
        }

        // existing code
        webview.executeJavaScript(`
            document.querySelectorAll("audio, video").forEach(el => {
                el.muted = false;
                el.volume = 1.0;
            });
        `);
    });
    webview.addEventListener("page-title-updated", (e) => {
        if (!tabData[activeTabIndex]) return;

        tabData[activeTabIndex].title = e.title;

        const tabs = document.querySelectorAll(".tab");

        const titleEl = tabs[activeTabIndex]?.querySelector("span");

        if (titleEl) {
            titleEl.textContent = e.title;
        }
    });

    // 🔥 FIX FAVICON
    webview.addEventListener("page-favicon-updated", (e) => {
        const favicon = e.favicons[0];

        const icons = document.querySelectorAll(".tab img");
        if (icons[activeTabIndex]) {
            icons[activeTabIndex].src = favicon;
        }
    });
    
    const browser = document.getElementById("browser"); // real webview
    browser.addEventListener("did-stop-loading", () => {

        const currentURL = browser.getURL();

        // 🔥 BLOCK here (correct place)
        if (
            currentURL.includes("google.com") ||
            currentURL.includes("youtube.com")
        ) return;

        if (typeof injectTrustPanel === "function") {
            injectTrustPanel();
        }

    });
    
    const firstTab = document.querySelector(".tab");
    const tabBar = document.querySelector(".tab-bar");
    const newTabBtn = document.querySelector(".new-tab");
    const urlBar = document.getElementById("urlBar");

    // Initial tab
    // ✅ FIX: Register first tab properly
    tabData.push({
        title: "New Tab",
        url: "home.html",
        webview: document.getElementById("browser") // 🔥 attach main webview
    });

    // ENTER KEY
    urlBar.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
            loadURL();
        }
    });

    // NEW TAB BUTTON
    newTabBtn.addEventListener("click", function () {
        createNewTab("home.html");
    });

    // TAB CLICK + CLOSE
    tabBar.addEventListener("click", function (e) {

        // CLOSE
        if (e.target.classList.contains("close-tab")) {
            e.stopPropagation();
            closeTab(e.target.parentElement);
            return;
        }

        // SWITCH
        const tabElement = e.target.closest(".tab");
        if (!tabElement) return;

        const tabsUI = document.querySelectorAll(".tab");
        const index = Array.from(tabsUI).indexOf(tabElement);

        if (index !== -1) {
            switchTab(index);
        }
    });

});


// ===============================
// LOAD URL
// ===============================

function loadURL() {

    const input = document.getElementById("urlBar").value.trim();
    const browser = document.getElementById("browser");

    if (!input) return;

    let finalURL = "";

    const looksLikeDomain =
        /^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}$/.test(input) ||
        /^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}\/.*$/.test(input);

    if (input.startsWith("http://") || input.startsWith("https://")) {
        finalURL = input;
    }
    else if (looksLikeDomain) {
        finalURL = "https://" + input;
    }
    else {
        finalURL = `https://www.google.com/search?q=${encodeURIComponent(input)}`;
    }

    // LOAD PAGE
    const currentTab = tabData[activeTabIndex];

    if (currentTab.webview) {
        currentTab.webview.loadURL(finalURL);
    }

    currentTab.url = finalURL;

    // Keep compatibility with your API
    if (window.api?.loadURL) window.api.loadURL(finalURL);

    tabData[activeTabIndex].url = finalURL;
}
function attachPopupHandler(webview) {

    // 🔥 THIS is the REAL working handler
    webview.addEventListener("new-window", (e) => {

        const url = e.url;

        console.log("🔥 NEW WINDOW EVENT:", url);

        if (url && url.startsWith("http")) {
            createNewTab(url);
        }

        e.preventDefault(); // 🚨 CRITICAL
    });

}


// ===============================
// CREATE TAB
// ===============================
function attachTabEvents(webview, tabIndex) {

    webview.addEventListener("page-title-updated", (e) => {
        if (!tabData[tabIndex]) return;

        tabData[tabIndex].title = e.title;

        const tabs = document.querySelectorAll(".tab");
        const titleEl = tabs[tabIndex]?.querySelector("span");

        if (titleEl) {
            titleEl.textContent = e.title;
        }
    });

    webview.addEventListener("page-favicon-updated", (e) => {
        const favicon = e.favicons[0];

        const icons = document.querySelectorAll(".tab img");
        if (icons[tabIndex] && favicon) {
            icons[tabIndex].src = favicon;
        }
    });

    webview.addEventListener("did-navigate", (e) => {
        if (!tabData[tabIndex]) return;
        tabData[tabIndex].url = e.url;

        if (activeTabIndex === tabIndex) {
            document.getElementById("urlBar").value = e.url;
        }
    });
}
function attachErrorHandlers(webview) {

    // 🔥 load custom error page
    

    // 🔥 Google blocked page
    webview.addEventListener("did-navigate", () => {
        const url = webview.getURL();

        if (
            url.includes("google.com") &&
            url.includes("sorry")
        ) {
            const blockedPage =
                `file://${location.pathname.replace("index.html", "")}google-blocked.html`;

            webview.loadURL(blockedPage);
        }
    });
}
function createNewTab(url) {

    const tabBar = document.querySelector(".tab-bar");
    const container = document.querySelector(".content");

// 🔥 ensure proper stacking
    container.style.position = "relative";

    // hide all webviews
    tabData.forEach(t => {
        if (t.webview) {
            t.webview.style.visibility = "hidden";
            t.webview.style.pointerEvents = "none";
            t.webview.style.zIndex = "1";
            
        }
    });

    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));

    // 🔥 create NEW webview (same settings as your main one)
    const webview = document.createElement("webview");
    attachPopupHandler(webview);
    webview.style.position = "absolute";
    webview.style.top = "0";
    webview.style.left = "0";
    webview.style.width = "100%";
    webview.style.height = "100%";
    webview.style.visibility = "visible";
    webview.style.pointerEvents = "auto";
    webview.style.zIndex = "1";

    webview.setAttribute("preload", "./webview-preload.js");
    webview.setAttribute("partition", "persist:main");
    webview.setAttribute("plugins", "");
    webview.setAttribute("allow", "camera; microphone; autoplay; encrypted-media");
    webview.setAttribute("webpreferences", "contextIsolation=yes");

    // load URL
    if (!url.startsWith("http")) {
        const fullPath = `file://${location.pathname.replace(/[^/]*$/, '')}${url}`;
        webview.src = fullPath;
    } else {
        webview.src = url;
    }

    container.appendChild(webview);

    // create tab UI
    const newTab = document.createElement("div");
    newTab.className = "tab active";

    newTab.innerHTML = `
        <img src="assets/logo.png" class="tab-logo">
        <span>New Tab</span>
        <span class="close-tab">✕</span>
    `;

    tabBar.insertBefore(newTab, document.querySelector(".new-tab"));

    tabData.push({
        title: "New Tab",
        url: url,
        webview: webview
    });

    activeTabIndex = tabData.length - 1;

    // attach listeners
    attachTabEvents(webview, activeTabIndex);
    attachErrorHandlers(webview);
}
// ===============================
// SWITCH TAB
// ===============================

function switchTab(index) {

    tabData.forEach((tab, i) => {

        if (tab.webview) {
            tab.webview.style.visibility = i === index ? "visible" : "hidden";
            tab.webview.style.pointerEvents = i === index ? "auto" : "none";
            tab.webview.style.zIndex = i === index ? "1" : "0";
        }

        document.querySelectorAll(".tab")[i]
            .classList.toggle("active", i === index);
    });

    activeTabIndex = index;

    const tab = tabData[index];
    document.getElementById("urlBar").value = tab.url || "";
}


// ===============================
// CLOSE TAB
// ===============================

function closeTab(tabElement) {

    const tabsUI = document.querySelectorAll(".tab");
    const index = Array.from(tabsUI).indexOf(tabElement);

    if (tabData.length === 1) return;

    const closingTab = tabData[index];

    // stop media before removing
    if (closingTab.webview) {

        closingTab.webview.executeJavaScript(`
            document.querySelectorAll("video,audio").forEach(m => {
                m.pause();
                m.src = "";
                m.load();
            });
        `).catch(() => {});

        // remove only dynamic webviews
        if (closingTab.webview.id === "browser") {

    // stop first browser completely
            closingTab.webview.loadURL("about:blank");

        } else {

            // remove dynamic webviews normally
            closingTab.webview.loadURL("about:blank");

            setTimeout(() => {
                closingTab.webview.remove();
            }, 100);
        }
    }

    tabData.splice(index, 1);
    tabElement.remove();

    if (activeTabIndex >= tabData.length) {
        activeTabIndex = tabData.length - 1;
    } else if (activeTabIndex > index) {
        activeTabIndex--;
    }

    switchTab(activeTabIndex);
}


// ===============================
// NAVIGATION
// ===============================

function goBack() {
    const currentTab = tabData[activeTabIndex];

    if (currentTab?.webview && currentTab.webview.canGoBack()) {
        currentTab.webview.goBack();
    }
}

function goForward() {
    const currentTab = tabData[activeTabIndex];

    if (currentTab?.webview && currentTab.webview.canGoForward()) {
        currentTab.webview.goForward();
    }
}

function refreshPage() {
    const currentTab = tabData[activeTabIndex];

    if (currentTab?.webview) {
        currentTab.webview.reload();
    }
}


// ===============================
// AI PANEL
// ===============================

function toggleAI() {
    document.getElementById("aiPanel").classList.toggle("ai-hidden");
}