// Preload script injected into every page loaded inside the <webview>
// (i.e. every site the user actually browses to, as opposed to the app
// shell in index.html). Kept intentionally minimal — camera/microphone
// and notification permissions are handled at the session level in
// main.cjs (see attachSessionPolicies), not here, so they work
// identically for every site without needing per-page JS.
// Tell the main process when the USER clicks / scrolls / touches the page, so the Noah agent can pause and let them take
// over (Noah's own injected input is recognised there by timing). `isTrusted` keeps page scripts from faking it, and
// the channel can only ever pause the agent. Throttled; carries no page data.
try {
    const { ipcRenderer } = require("electron");
    let lastSent = 0;
    for (const type of ["mousedown", "wheel", "touchstart"]) {
        window.addEventListener(
            type,
            (e) => {
                const t = Date.now();
                if (!e.isTrusted || t - lastSent < 80) return;
                lastSent = t;
                ipcRenderer.send("noah:page-input", { type, t });
            },
            { capture: true, passive: true }
        );
    }
} catch (e) {
    // no ipcRenderer in this context: takeover by click/scroll simply is not reported
}

try {
    Object.defineProperty(navigator, "webdriver", {
        get: () => false,
    });
} catch (e) {
    // ignore — some pages may already have a non-configurable descriptor
}

// Theme colour: Jonah's OWN home page (a file: page called home.html) says which colour the user picked, and the browser around it - its toolbar and the
// assistant panel - follows. Nothing else is allowed to do this: a website's script cannot recolour the browser. Only a six-digit hex colour is passed on.
try {
    const { ipcRenderer } = require("electron");
    window.addEventListener("jonah-theme", (e) => {
        if (location.protocol !== "file:" || !/\/home\.html$/.test(location.pathname)) return;
        const hex = String((e && e.detail) || "");
        if (/^#[0-9a-fA-F]{6}$/.test(hex)) ipcRenderer.sendToHost("jonah-theme", hex);
    });
} catch (e) {
    // no ipcRenderer in this context: the colour still applies to the page itself, just not to the browser around it
}

// Home page dock: Jonah's OWN home.html asks the browser window to open one of its hubs. Only these three names are ever passed on.
try {
    const { ipcRenderer } = require("electron");
    window.addEventListener("jonah-open-hub", (e) => {
        if (location.protocol !== "file:" || !/\/home\.html$/.test(location.pathname)) return;
        const name = String((e && e.detail) || "");
        if (name === "game" || name === "creator" || name === "aesthetic") ipcRenderer.sendToHost("jonah-open-hub", name);
    });
} catch (e) {
    // no ipcRenderer in this context: the dock simply cannot open a hub
}
