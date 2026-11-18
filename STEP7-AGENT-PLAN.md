# Step 7 plan: Noah's web agent in Jonah on Chromium + making Jonah light (memory/CPU)

Owner's request (2026-11-17): bring Electron Jonah's full web agent (fills forms, does everything in the browser) and every
remaining function over; make Jonah use little memory and CPU. "Take your time."

## What the Electron web agent is (measured)
- Noah/ = ~17,000 lines: agent/ (3.3k), autonomy/ (4.8k, missions), browser/ (1.4k), perception/ (2.2k), models/ (3.4k),
  safety/ (1.2k), protocol/, intake/, experience/, config.cjs, core.cjs, index.cjs, ipc.cjs.
- Electron-specific surface is small: browser/*.cjs + perception/screenshot.cjs + perception/ocr.cjs + core.cjs use a
  webContents: isLoading, isDestroyed, getURL, getTitle, on/removeListener (load/navigation events), loadURL, reload,
  goBack/goForward, canGoBack/canGoForward, getZoomFactor, capturePage, executeJavaScript, debugger.attach/sendCommand/on("message").
- Node built-ins used by the core: path, fs (memory.cjs, task-state.cjs, audit.cjs, url-guard.cjs, experience/store.cjs,
  config.cjs), os, events, crypto.
- Models (models/router.cjs): without a Jonah account the only working brain is the legacy provider
  (models/rexy-legacy.cjs -> https://www.noahai.live/predict, text-only, AX element list with element refs; no key needed).
  User API keys (Anthropic / OpenAI / Google) give the strong vision models. The hosted /api/llm/step needs a Jonah account
  and is "to be built by the backend" (per noahai.cjs STATUS).

## How it runs in Chromium
- Runs in Noah's side panel page (noah.html) while the panel is open (Electron: the agent ran while the panel showed progress).
- Noah's .cjs files are bundled UNCHANGED by a CommonJS loader (scripts\bundle_noah.py -> resources/jonah/js/noah-bundle.js):
  each file becomes a registered module; require() resolves relative paths; built-ins are shims:
  path (posix), events (EventEmitter), crypto (randomUUID/createHash via SubtleCrypto where sync is not needed),
  fs (small in-memory + chrome.storage.local-backed store for memory/task-state/experience/audit/config), os (platform win32),
  electron (stub: safeStorage unavailable), child_process (throws: desktop/computer agent stays out of the browser bundle).
- A fake webContents (js/noah-webcontents.js) per tab, built on chrome.debugger (CDP 1.3, flattened child sessions) and chrome.tabs:
  executeJavaScript -> Runtime.evaluate; capturePage -> Page.captureScreenshot; loadURL/reload/back/forward -> chrome.tabs;
  events from chrome.tabs.onUpdated / onRemoved / chrome.debugger.onEvent / onDetach.
- Honesty (hard rule 1): Chromium shows its own "Jonah started debugging this browser" bar while the agent is attached.
  It is NOT hidden. No navigator.webdriver spoofing, no CAPTCHA solving, no bot-check bypass (Noah/safety already stops on
  CAPTCHAs/logins: ask-policy "needsHuman"). Passwords are never typed by the agent (owner's rule 2): the agent pauses and asks.
- Panel: noah-host.js routes "rexy:submit-goal" with mode "web" (and auto when it looks like a browser task) to the agent;
  agent events -> window.postMessage({type:"noah:event"}) which ai-panel.html already renders (onNoahEvent); Stop/Pause/Resume
  buttons -> agent.cancel/pause/resume.

## Memory / CPU (owner: "optimised for good")
1. Release-style build in a separate folder out\JonahRelease (keeps out\Jonah for quick testing):
   is_component_build=false, dcheck_always_on=false, symbol_level=0, blink_symbol_level=0, is_debug=false,
   disable_fieldtrial_testing_config=true, target_cpu="x64" (+ is_official_build later if PGO/LTO memory allows).
   Expected: faster start (1 big dll instead of ~550), less memory, no developer checks.
   Needs ~3-5 h full build and ~30-50 GB more on C:.
2. Memory Saver (tab discarding) on by default; Efficiency settings.
3. Start page: pause radio/market/websocket work when the tab is hidden; load heavy libraries only when needed.
4. Side panel: load the tool scripts lazily (only when a tool opens).

## Order of work
A. Loader + shims + fake webContents; run Noah's agent against one tab; log steps.
B. Wire to the panel (Web agent mode, Stop/Pause/Resume, events).
C. Test: open a site, search, fill a simple test form (a form page Jonah serves itself, so no real site is touched).
D. Memory/CPU items 2-4; then the release build (item 1) as the final, long build.
