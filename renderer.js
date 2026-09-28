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

    // The first tab (declared in index.html) is not wired through attachTabEvents like tabs created later, so without this
    // the bookmark star and the trust card kept showing the PREVIOUS page's state after a link click or a Noah-driven navigation.
    for (const evt of ["did-navigate", "did-navigate-in-page", "did-stop-loading"]) {
        webview.addEventListener(evt, () => { if (tabData[activeTabIndex]?.webview === webview) pageChanged(); });
    }

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

function loadURL(inputURL = null) {

    const suggestionBox = document.getElementById("suggestionsBox");
    if (suggestionBox) {
        suggestionBox.style.display = "none";
        suggestionBox.innerHTML = "";
    }

    let input = inputURL;

    if (!input) {
        input = document.getElementById("urlBar").value.trim();
    }
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

// Opens an address picked from the History / Bookmarks list in the current tab.
function loadURLDirect(url) {
    document.getElementById("historyPanel")?.remove();
    loadURL(String(url || ""));
}

// ===============================
// BOOKMARK STAR
// ===============================

/** The page in the active tab, read live from the webview (the tab record can lag a navigation). */
function currentPage() {
    const tab = tabData[activeTabIndex];
    if (!tab) return { url: "", title: "" };
    let url = tab.url || "";
    let title = tab.title || "";
    try {
        if (tab.webview) {
            url = tab.webview.getURL() || url;
            title = tab.webview.getTitle() || title;
        }
    } catch (_) { /* webview not ready yet: the tab record is the best we have */ }
    return { url, title };
}

/** The active tab's page may have changed (navigation, tab switch): everything in the chrome that mirrors it re-syncs. */
function pageChanged() {
    refreshStar();
    if (typeof syncTrust === "function") syncTrust();
}

// Opens Jonah's built-in drawing tool in the current tab - the same pattern as goHome() below (a fixed, bundled
// page loaded directly, never through the address bar's general parser, which never accepts file:// at all).
function openDrawingTool() {
    const tab = tabData[activeTabIndex];
    if (!tab || !tab.webview) return;
    tab.webview.loadURL(new URL("toy-paint.html", location.href).href);
    tab.url = "toy-paint.html";
    const bar = document.getElementById("urlBar");
    if (bar) bar.value = "";
}

// Opens Jonah's own start page in the current tab (the Home button, and Alt+Home like other browsers).
function goHome() {
    const tab = tabData[activeTabIndex];
    if (!tab || !tab.webview) return;
    tab.webview.loadURL(new URL("home.html", location.href).href);
    tab.url = "home.html";
    const bar = document.getElementById("urlBar");
    if (bar) bar.value = ""; // the start page shows an empty address bar, as everywhere else
    pageChanged();
}
document.addEventListener("keydown", (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === "Home") {
        e.preventDefault();
        goHome();
    }
});

async function refreshStar() {
    const btn = document.getElementById("bookmarkBtn");
    if (!btn || !window.api?.isBookmarked) return;
    let on = false;
    try {
        const { url } = currentPage();
        on = !!url && (await window.api.isBookmarked(url));
    } catch (_) { /* leave the star empty */ }
    btn.textContent = on ? "★" : "☆";
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? "Remove bookmark (Ctrl+D)" : "Bookmark this page (Ctrl+D)";
}

async function toggleBookmark() {
    const btn = document.getElementById("bookmarkBtn");
    const res = await window.api.toggleBookmark(currentPage()).catch(() => null);
    if (!res || !res.ok) {
        if (btn) {
            btn.classList.remove("nope");
            void btn.offsetWidth; // restart the shake if it is still running
            btn.classList.add("nope");
            btn.title = (res && res.error) || "This page can't be bookmarked.";
        }
        return;
    }
    refreshStar();
}

document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === "d") {
        e.preventDefault();
        toggleBookmark();
    }
});

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
            pageChanged();
        }
    });

    // The address bar only followed full navigations, so after a single-page-app route change, or a page that swapped
    // itself in (a Noah-driven click into a site), it kept showing the previous address (google.com/search?q=Notepad
    // over a notepad app). Follow in-page navigations and re-sync when loading stops.
    const syncAddress = () => {
        try {
            const u = webview.getURL();
            if (!u || !tabData[tabIndex]) return;
            tabData[tabIndex].url = u;
            const bar = document.getElementById("urlBar");
            // Jonah's own start page shows an empty bar (as before), not its file path
            if (activeTabIndex === tabIndex && bar && document.activeElement !== bar) bar.value = /^file:.*\/home\.html(?:[?#].*)?$/i.test(u) ? "" : u;
            if (activeTabIndex === tabIndex) pageChanged();
        } catch (_) { /* webview not ready */ }
    };
    webview.addEventListener("did-navigate-in-page", (e) => {
        if (e.isMainFrame !== false) syncAddress();
    });
    webview.addEventListener("did-stop-loading", syncAddress);
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
function createNewTab(url, opts = {}) {

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
    webview.setAttribute("partition", opts.partition || "persist:main");
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
    pageChanged();
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

function getActiveWebView() {

    if (!tabData.length) return null;

    return tabData[activeTabIndex]?.webview || null;

}
window.addEventListener("DOMContentLoaded", () => {

    window.api.onNavigate((_, url) => {

        loadURL(url);
    window.api.onBack(() => {
        goBack();
    });

    window.api.onForward(() => {
        goForward();
    });

    window.api.onReload(() => {
        refreshPage();
    });

    });

});
async function rexyExecute(script) {

    const webview = getActiveWebView();

    if (!webview) return null;

    return await webview.executeJavaScript(script);

}
async function rexyClick(selector) {

    return rexyExecute(`

        (() => {

            const el = document.querySelector(${JSON.stringify("PLACEHOLDER")});

            if(!el) return false;

            el.click();

            return true;

        })()

    `.replace("PLACEHOLDER", selector));

}
async function rexyType(selector,text){

    return rexyExecute(`

        (()=>{

            const el=document.querySelector(${JSON.stringify("PLACEHOLDER")});

            if(!el) return false;

            el.focus();

            el.value=${JSON.stringify("TEXT")};

            el.dispatchEvent(new Event("input",{bubbles:true}));

            return true;

        })()

    `
        .replace("PLACEHOLDER",selector)
        .replace("TEXT",text));

}
async function rexyScroll(x,y){

    return rexyExecute(`

        window.scrollTo(${x},${y});

        true;

    `);

}
async function rexyObserve() {

    const webview = getActiveWebView();

    if (!webview) return null;

    return await webview.executeJavaScript(`

        (()=>{

            return{

                title:document.title,

                url:location.href,

                html:document.documentElement.outerHTML,

                text:document.body.innerText,

                buttons:[...document.querySelectorAll("button")].map(b=>({

                    text:b.innerText,

                    id:b.id,

                    class:b.className

                })),

                inputs:[...document.querySelectorAll("input")].map(i=>({

                    type:i.type,

                    placeholder:i.placeholder,

                    id:i.id

                }))

            };

        })();

    `);

}
window.RexyRenderer = {

    webview: getActiveWebView,
    loadURL,

    navigate: (url) => {

        const webview = getActiveWebView();

        if (!webview) {
            return Promise.reject(new Error("No active webview"));
        }

        return new Promise((resolve, reject) => {

            const cleanup = () => {
                webview.removeEventListener("did-stop-loading", loaded);
                webview.removeEventListener("did-fail-load", failed);
            };

            const loaded = () => {
                cleanup();
                resolve(true);
            };

            const failed = (e) => {
                // Ignore subframe failures (ads, trackers, embedded
                // widgets) and aborted loads (-3, common on redirects and
                // prefetches) — same filtering index.html's own
                // did-fail-load handler already applies. Only a real
                // main-frame failure should reject navigation.
                if (!e.isMainFrame) return;
                if (e.errorCode === -3) return;
                cleanup();
                reject(new Error(`Navigation failed: ${e.errorDescription || e.errorCode}`));
            };

            webview.addEventListener("did-stop-loading", loaded, { once: true });
            webview.addEventListener("did-fail-load", failed);

            webview.loadURL(url);

        });

    },

    click: rexyClick,

    observe: rexyObserve,

    type: rexyType,

    scroll: rexyScroll,

    execute: rexyExecute

};
// ===============================
// AI PANEL <-> RUNTIME BRIDGE
// ===============================

window.addEventListener("DOMContentLoaded", () => {

    // Panel -> Runtime: relay goal submissions from ai-panel.html
    window.addEventListener("message", async (event) => {
        const data = event.data || {};
        if (data.type === "rexy:submit-goal") {
            try {
                const result = await window.rexy.goal(data.goal, { mode: data.mode, attachmentIds: data.attachmentIds });
                console.log("Goal submitted:", result);
                // lets the panel drop its waiting indicator as soon as it is clear how the message was handled
                const f = document.querySelector("#aiPanel iframe");
                if (f && f.contentWindow) f.contentWindow.postMessage({ type: "rexy:goal-submitted", payload: result }, "*");
            } catch (err) {
                console.error("Failed to submit goal:", err);
            }
        }
    });

    // Runtime -> Panel: relay progress back down into the AI panel iframe
    function _relayToPanel(type, payload) {
        const panelFrame = document.querySelector("#aiPanel iframe, #aiPanel webview");
        if (panelFrame?.contentWindow) {
            panelFrame.contentWindow.postMessage({ type, payload }, "*");
        }
    }

    window.rexy.onGoalStep((data) => _relayToPanel("rexy:goal-step", data));
    window.rexy.onGoalCompleted((data) => _relayToPanel("rexy:goal-completed", data));
    window.rexy.onGoalError((data) => _relayToPanel("rexy:goal-error", data));
    window.rexy.onGoalBlocked((data) => _relayToPanel("rexy:goal-blocked", data));
    window.rexy.onGoalPaused((data) => _relayToPanel("rexy:goal-paused", data));

});