# Step 6 plan: moving Jonah's Electron features into the Chromium build

Written 2026-11-17, after Google sign-in was confirmed working in the Jonah Chromium build.

## The approach
With Electron, Jonah's HTML/JS *is* the whole browser window. With Chromium, the window (tabs, address bar, menus) is
Chromium's own C++ code, which already works well. So we **keep Chromium's window** and add Jonah's own parts as:

1. **A built-in "Jonah" extension** (a "component extension": shipped inside the build, always on, cannot be removed by
   accident, and shown nowhere as a third-party add-on). Most of the existing HTML/CSS/JS can move here with small changes:
   - **Start page**: `home.html` becomes the New Tab page (same design and styles).
   - **Side panel**: Chromium's own side panel shows `ai-panel.html` (Noah chat), study/citation tools and notifications.
   - **Other pages**: Focus Mode blocked page, games, World Cup pages and so on become extension pages.
2. **Small C++ changes** only where an extension can't do the job: registering the built-in extension, Jonah's default
   colours, the toolbar button for Noah, and default settings.
3. **A small helper program** (Chromium's "native messaging") for things a browser page can't do: Noah's desktop
   control (`Noah/computer`, `Noah/desktop/host.ps1`), the local Kokoro voice and file extraction.

`window.api.*` calls in the Electron pages (preload.cjs → ipcMain in main.cjs) become `chrome.*` extension APIs or messages
to the helper program.

## Feature list (from the Electron project) and where each one goes
| Electron feature (files) | In Chromium Jonah | Work |
|---|---|---|
| Tabs, address bar, window buttons (index.html, renderer.js, window-guard.cjs) | Chromium's own; drop | none |
| Bookmarks, history, downloads, incognito (get-bookmarks, downloads-*.js, open-incognito-window) | Chromium's own; drop | none |
| Honest identity (browser-identity.cjs), google-blocked.html | Done in C++ already; Google now accepts sign-in; drop | done |
| Start page with news, sports, radio, markets, shop, social links (home.html, hubs/, get-news, get-all-sports) | New Tab page in the Jonah extension; news/sports via extension fetch | medium |
| Theme light/dark + forced dark for sites (theme-*.js, features.js) | Extension + Chromium theme colours in C++ | small–medium |
| Noah chat / AI panel (ai-panel.html, chat-render.js, Rexy/llm, chat-complete) | Side panel page | medium |
| Study tools, citations, attachments, file extract (study-*.js, citation.html, attachments.cjs, file-extract.cjs) | Side panel + helper program for Office/PDF parsing | medium–large |
| Focus Mode: blocked sites, schedule, Pomodoro (features.js, focus-blocked.html) | Extension: declarativeNetRequest rules + alarms | small–medium |
| Notification centre, Read Aloud (features.js, kokoro-worker.cjs) | Side panel; voice via helper program (Kokoro) or chrome.tts | medium |
| Voice orb, wake word, microphone (voice-orb.js, wake-*.js, mic-processor.js) | Extension offscreen page + side panel | medium–large |
| Noah browser agent: click/type/navigate/observe (Noah/agent, Noah/browser/cdp.cjs, Rexy/*) | Extension `chrome.debugger` API. Chromium honestly shows a "Jonah is debugging this tab" bar while it runs; it is never on by default | large |
| Noah desktop agent (Noah/computer, Noah/desktop) | Helper program over native messaging | large |
| Safety layer (Noah/safety, Trust/*, trust-panel.js) | Moves with the agent; Trust check in the side panel | medium |
| Ad blocker (@cliqz/adblocker-electron) | Extension declarativeNetRequest filter lists | medium |
| Search (search.html, search-proxy.cjs, search-providers.cjs, jonah-search/) | Default search engine set to Jonah search; search.html as an extension page | medium |
| google-serp.cjs | **Needs review before porting**: reading Google result pages automatically may break Google's terms (hard rule 1). Prefer jonah-search or an official API | decision |
| VPN (vpn.cjs) | Extension `chrome.proxy` API | small–medium |
| Billing, plans, entitlements, sign-in to Jonah account (billing*.js, entitlement-*.cjs, plan-notice.cjs) | Extension pages + background worker | medium |
| Auto-update (updater.cjs, electron-updater) | Later: Jonah installer + own update check | large, later |

## Phases (each one ends with a build you can open and check)
1. **Start page**: built-in Jonah extension + `home.html` as New Tab, Jonah colours. *First visible "it looks like Jonah" result.*
2. **Side panel with Noah chat** + study/citation tools + notifications.
3. **Focus Mode, theme, Read Aloud, ad blocker, VPN.**
4. **Noah browser agent and voice orb.**
5. **Helper program**: desktop agent, Kokoro voice, file extraction. Then billing/entitlements.
6. **Shipping**: Jonah installer (Chromium's mini_installer, renamed), update check, and **code signing**.

Each rebuild after a change only recompiles what changed (minutes to about an hour), not the 3-hour full build.

## Things the owner needs to decide (they affect the plan)
1. **Web libraries the start page loads from CDNs** (`hls.js@latest`, `chart.js`, `boxicons`, Google Fonts, simpleicons).
   Pages inside a Chromium extension may not load scripts from the internet, so these files must be shipped inside Jonah.
   They come from cdn.jsdelivr.net / unpkg.com (npm), which are **not** on the approved download list. Options:
   approve these npm packages (exact versions, a few hundred KB each), or rewrite those parts without them.
2. **google-serp.cjs**: keep, replace or drop (see the table above).
3. **Video codecs**: plain Chromium has no H.264/AAC (YouTube works with VP9/AV1; some sites need H.264). Turning them on
   (`proprietary_codecs=true ffmpeg_branding="Chrome"`) has patent-licensing consequences for distribution. Widevine
   (Netflix, Disney+) needs a licence from Google and is not available to self-built browsers.
4. **Code signing certificate** before giving Jonah to other people: Windows SmartScreen and Smart App Control will warn
   about or block an unsigned browser.
