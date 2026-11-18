// Smoke test: starts Noah's bundle the way Jonah's side panel does, with stand-ins for the chrome.* APIs, and reports whether
// the agent comes up and is available (has a model for the "browser" role).   node test_noah_boot.cjs <extension dir>
const fs = require("fs");
const path = require("path");
const dir = process.argv[2];
const ev = () => ({ addListener() {}, removeListener() {} });
const store = {};
globalThis.window = globalThis;
globalThis.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 };
globalThis.document = { hasFocus: () => true };
globalThis.devicePixelRatio = 1;
globalThis.chrome = {
  storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } },
  runtime: { onMessage: ev(), sendMessage: async () => {} }, scripting: { insertCSS: async () => {}, executeScript: async () => [] },
  tabs: { onUpdated: ev(), onRemoved: ev(), onZoomChange: ev(), onActivated: ev(), sendMessage: async () => {}, query: async () => [{ id: 1, index: 0, url: "https://example.com/", title: "Example", active: true, status: "complete" }],
    getZoom: async () => 1, update: async () => ({}), create: async () => ({ id: 2 }), remove: async () => {}, reload: async () => {}, goBack: async () => {}, goForward: async () => {} },
  windows: { getLastFocused: async () => ({ id: 1 }) },
  debugger: { onEvent: ev(), onDetach: ev(), attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}) },
};
for (const f of ["noah-builtins.js", "noah-bundle.js", "noah-boot.js"]) {
  new Function(fs.readFileSync(path.join(dir, "js", f), "utf8"))();
}
window.JonahNoahReady.then(async (n) => {
  console.log("agent available:", n.agent.isAvailable());
  console.log("browser role candidates:", JSON.stringify(n.router.usable ? n.router.usable("browser").map((c) => c.provider + ":" + (c.model || "")) : "?"));
  if (process.argv[3] === "keys") {
    console.log("save fake key:", n.config.setKey("anthropic", "sk-ant-FAKE-TEST-KEY-0000"));
    const d = n.router.describe(); const a = d.roles.browser.active;
    console.log("web agent would use:", a && a.provider, a && a.model, "trusted:", a && a.trusted);
    console.log("hasKey:", n.config.publicView().providerStatus.anthropic.hasKey);
    n.config.clearKey("anthropic");
    const a2 = n.router.describe().roles.browser.active;
    console.log("after remove:", a2 && a2.provider, "hasKey:", n.config.publicView().providerStatus.anthropic.hasKey);
  }
  console.log('shellInfo:', JSON.stringify(await n.core.browser.shellInfo()));
  const tabs = await n.core.tabs.list();
  console.log("tabs seen:", tabs.map((t) => t.id + " " + t.url).join(", "));
  process.exit(0);
}, (err) => { console.error("BOOT FAILED:", err && err.stack || err); process.exit(1); });
