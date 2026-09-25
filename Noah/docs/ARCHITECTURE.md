# Noah: architecture, setup and status

Noah is the computer-use agent inside Jonah Browser. It replaces the selector-guessing agent in `Rexy/` for browser goals with a hybrid perceive → act → verify loop that drives a real `<webview>` through Chromium's DevTools protocol (CDP), and shows what it is doing with a purple cursor overlay.

- Research and sources: [RESEARCH.md](RESEARCH.md)
- Measured results (generated, never hand-edited): [BENCHMARKS.md](BENCHMARKS.md)

## 1. Status in one screen

| Area | State |
|---|---|
| Hands and eyes (AX/DOM perception, screenshots, CDP mouse + keyboard, coordinate mapping, iframes, drag-and-drop, dialogs, uploads/downloads) | Built, tested in a real Electron `<webview>` at DPR 1, DPR 2 and zoom 1.5 |
| Agent loop, recovery ladder, budgets, checkpoints/resume, approval policy, emergency stop, takeover | Built, tested with a **scripted reference policy** (not an LLM) |
| Purple Noah Cursor overlay | Built, verified inside the real Jonah app: the captured frame contains the solid `#7C3AED` arrow |
| Model providers (Anthropic, OpenAI, Gemini, Qwen/OpenAI-compatible, local, legacy Rexy) and per-role routing with visible failover | Built, tested against fake HTTP servers and wire-format unit tests |
| Hosted model `https://www.noahai.live/predict` (text-only) driving the real Jonah app | Works end to end: it opened the shop, followed the Laptops link and answered, with the purple cursor visible (20 s, 4 steps). **Its answers are unreliable** (see section 9). Live-run scope: one task shape, on a local fixture site |
| Agent session (one persistent agent; voice + text through one router; pause/resume; navigation) | Built. Live run against the real hosted model and real JustNotepad/YouTube (`npm run noah:session`, see BENCHMARKS.md): 43/45 checks on the last run; the 2 failures were runs cancelled by someone using the mouse/keyboard on the test machine, not agent faults. Voice = the transcript path only (`rexy.goal(text, {source:"voice"})`); microphone, speech-to-text and text-to-speech were **not** exercised end to end (`npm run noah:orb` smoke-tests the orb wiring with stand-in bridges) |
| Anthropic / OpenAI / Gemini success rate | **Not measured.** No valid key for any of them was available (see section 9) |
| Real Google Docs / Sheets / Slides / Figma / Canva | **Not tested.** Google sign-in is blocked inside Jonah; fixtures simulate their DOM/canvas patterns |

Nothing in this repository claims a benchmark that was not run. Tier labels below say exactly what each number can and cannot prove.

## 2. How it fits together

```
 Jonah shell (index.html)                              main process
 ┌──────────────────────────────────────────┐   ┌───────────────────────────────────────────────┐
 │ <webview> tabs  (guest pages)             │   │ Noah/index.cjs  createNoah()                   │
 │ noah-renderer.js  window.NoahRenderer     │   │  ├─ core.cjs  bus, safety, browser, computer   │
 │   tabs / rects / event relay / ESC        │◄─►│  ├─ ipc.cjs   noah:* (sender-validated)        │
 │ noah-overlay.js/.css  purple cursor,      │   │  ├─ agent/noah-agent.cjs  the orchestrator     │
 │   status pill, STOP, confirm card         │   │  ├─ models/router.cjs  role → provider chain   │
 │ ai-panel.html  Noah control bar           │   │  └─ config.cjs  settings + safeStorage keys    │
 │ preload.cjs  window.noah (contextBridge)  │   └───────────────────────────────────────────────┘
 └──────────────────────────────────────────┘        │ webContents.debugger (in-process CDP)
                                                      ▼
                                             guest page (never given Node, never trusted)
```

One event stream (`Noah/events.cjs`, `EventBus`) is the single source of truth. The controller emits `mouse_action` / `keyboard_action` / `scroll_action` **before** dispatching input, and the cursor overlay, the AI panel, the audit log and the legacy `runtime:goal-*` relay all consume the same events. The cursor is decoupled from execution: input is dispatched by CDP whether or not the overlay is visible, and the overlay is `pointer-events: none`.

Legacy compatibility: `Rexy/runtime.cjs` hands browser goals to `noah.submit()` when Noah has a usable model, otherwise the old planner runs exactly as before. Voice orb and AI panel keep receiving `runtime:goal-step / completed / error`.

### Files

| Path | Role |
|---|---|
| `Noah/index.cjs`, `core.cjs`, `ipc.cjs`, `config.cjs`, `events.cjs`, `theme.cjs` | wiring, IPC, settings, event bus, cursor theme variables |
| `Noah/computer/{keymap,coordinates,input,controller}.cjs` | virtual mouse/keyboard, coordinate mapping, `computer.*` actions |
| `Noah/browser/{cdp,tabs,browser-controller}.cjs` | CDP session (incl. out-of-process iframes), tab registry ("the tab where I had Amazon"), navigation/dialog/download/upload |
| `Noah/perception/{ax,observer,screenshot}.cjs` | AX tree + refs, element geometry, page text, screenshot capture and diffing |
| `Noah/protocol/actions.cjs` | the 31-action registry, envelope validation, portable tool schema |
| `Noah/agent/*.cjs` | orchestrator, planner/triage, executor, verifier, recovery, memory, task state, context compressor, prompts |
| `Noah/models/*.cjs` | provider adapters, catalog (data only), router |
| `Noah/safety/*.cjs` | URL guard, injection detector, risk classifier, policy, audit log, safety controller, takeover monitor |
| `noah-renderer.js`, `noah-overlay.js`, `noah-overlay.css` | shell bridge and the purple cursor overlay |
| `Noah/bench/**`, `Noah/test/unit/**` | fixtures, harness, scenarios, integration + live scripts, report generator, unit tests |

Existing files changed: `main.cjs` (create Noah, disable native window occlusion so screenshots do not stall, dispose on close), `Rexy/runtime.cjs` (route browser goals to Noah, extended browser-verb list, cancel), `preload.cjs` (`window.noah`), `renderer.js` (`createNewTab` accepts a partition), `index.html` (overlay assets), `ai-panel.html` (control bar, duplicate suppression), `package.json` (`noah:*` scripts).

## 3. Perception: three layers, chosen per step

1. **Semantic (default).** URL, title, visible text, the accessibility tree from `Accessibility.getFullAXTree` for every frame (same-origin and out-of-process), interactive elements with stable refs (`e12`, `f1e4` inside iframes) and CDP-measured bounding boxes. Elements are listed viewport-first under a token budget, modal-aware, de-duplicated; an unchanged page is sent as a diff. Page text is wrapped in a per-task nonce `<untrusted_page_content>` block.
2. **Screenshot (on demand).** Taken when the AX tree is poor (canvas apps, few controls and little text), when a step failed twice, or when the model asks (`need_visual`). Resized to the model's limits; the geometry needed to map its answer back is kept with the image.
3. **Virtual input.** Real CDP mouse, wheel, key and text events, with a drag path that uses `Input.setInterceptDrags` so HTML5 drag-and-drop works and can never enter an OS drag loop that synthetic input cannot end.

### Coordinates

`FrameGeometry` maps model space (image pixels, `normalized_1000`, or `normalized_1`) → screenshot image → CSS viewport (`window.innerWidth/innerHeight`, which includes the scrollbar gutter) → shell CSS pixels (× zoom + the webview rectangle) → screen DIP → physical pixels. Nothing is hard-coded: zoom is read live from the guest, the webview rectangle from the shell, DPR from the display. Verified at DPR 1, DPR 2, zoom 1.5, a page with a scrollbar and a 400 px downscaled screenshot (clicks land within 1.5 px, 3 px for the downscaled image).

### Choosing a method per step

Ladder for a click: ref → pointer event at the measured centre (with an in-page `elementFromPoint` hit-test; if something else covers it, or the element has `pointer-events: none`, fall back to a DOM click) → keyboard activation → vision-guided coordinates. Text entry chooses between key events, `Input.insertText` and `form_input` depending on the target (hidden-textarea editors such as Docs-style pages work through key events). Every step re-observes and verifies (URL, DOM fingerprint, focus, value, frame change, optional pixel diff); there are no blind batches (`maxBatch` 5, and a batch stops at the first failure).

## 4. The agent loop

`NoahAgent` (queue → plan → loop). Per step: observe → build a compact message → one model call (`noah_step` function tool: status, summary, method, ≤5 actions, notes, result, `need_visual`, `remember`) → validate → safety check per action → execute → verify → feed results back. Budgets: 60 steps, 15 min wall clock, 150 model calls, 4 consecutive failures, 60 s per model call (all in `config.limits`). Tasks checkpoint atomically after each step; `resumeTask` continues an interrupted one. The recovery engine classifies failures (unknown ref, blocked pointer, no effect, timeout, dialog, navigation…), attaches a targeted hint, escalates the method, and detects action loops.

## 4b. Agent session, agent run, and one command router

Earlier the agent was a stateless task runner: every message was classified from scratch, "agent mode" was implicitly "a run is in progress", and a paused run blocked everything behind it. After the agent had opened a notepad it looked like it had forgotten the page, voice commands fell through to plain chat, and the panel showed a stream of "thinking..." and "Paused" messages. The fix is structural, not a patch:

```
 Text (panel) ─┐
               ├─► CommandRouter ─► AgentSession ─► NoahAgent (one RUN at a time) ─► BrowserController
 Voice orb ────┘   (agent/command-router.cjs)  (agent/session.cjs)
```

| | **Agent session** (`agent/session.cjs`) | **Agent run** (in `agent/noah-agent.cjs`) |
|---|---|---|
| Lives | for the whole app window; destroyed only when the window closes | one instruction |
| Holds | `enabled`, `executionState`, current/last task, conversation (compact), browser context `{ tabId, url, title, pageReady, lastAction, timestamp }`, the tail of the last text Noah wrote | `runId`, plan, memory, metrics, its abort signal |
| States | `idle → planning → executing ⇄ paused / waiting_for_user → completed / error` | ends in exactly one terminal transition |

Rules enforced by construction (and unit-tested):

- A finished, failed, cancelled, paused or superseded run never destroys the session. **Pause is not destroy**: the task, the page and the run stay; "continue" resumes *the same run* (same task id).
- **Navigation only updates the browser context** (`did-start-navigation`, `did-navigate`, `did-stop-loading`, tab switches in `core.cjs`); it never resets the task or the conversation.
- `enabled` (agent mode) is a different fact from what a run is doing. There is no per-request activation; "turn on agentic mode" is answered ("already on"), not run.
- **One command router** (`agent/command-router.cjs`, `agent/intent.cjs`). Voice transcripts and typed messages both reach `Rexy/runtime.cjs submitGoal` → `noah.route()`, which decides: a control on the session ("continue" / "stop" / "pause"), an instruction (a new task, or a **follow-up** carrying `session.contextFor()`: previous goals, the last result, the page, the text just written), or plain chat. A follow-up like "Continue writing the story" needs neither the page nor the topic to be repeated.
- **Queue policy** (`NoahAgent.submit`): idle → run; a run is working → the newest instruction waits (one place in line, latest wins); the run is paused / asking / waiting for a confirmation → the new instruction *replaces* it (the user has moved on; the session stays); the same words twice within 4 s (voice + text) are one run. `resume()` refuses to approve a confirmation: that needs the card, not a spoken word.
- **Availability is decoupled from model cooldown**: after one slow or failed answer the only configured model used to be "cooling down", which made the agent report itself unavailable. A transient cooldown is now only a preference for *another* model; auth/quota failures stay cooled; sensitive tasks are unchanged (trusted-only).
- **Every run ends** in `completed`, `error` or `idle` (cancelled). Every observation and action has a deadline (`limits.observeTimeoutMs` 30 s, `actionTimeoutMs` 60 s, typing scaled to its length, model 60 s); a hang becomes an ordinary failed step with a readable message; retries stay bounded (invalid model output ×3, escalations ×3, self-decisions ×4).
- **Idle agents are never "paused"**: `SafetyController.active` is true only while a task runs (`taskId` stays set for the audit trail). Takeover (a real click, scroll, keystroke) is detected by input *kind*, so Noah's own typing cannot hide a real click.
- **The UI has one status stream**: the `session_state` event drives a single status line (Ready / Working… / Paused / Waiting for you / Done / Something went wrong), the overlay pill and the voice orb. The panel shows the user's message and one result or question, never the plan, per-step messages, model switches or the model's own words. The waiting bubble is bounded (45 s) and removed by any state change.
- **Voice orb**: listeners are registered once (they used to be added on every utterance and never removed); the orb is released as soon as an agent run starts, so "stop" / "continue" / the next instruction can be spoken while it works; the run's outcome is spoken by a persistent listener when it ends.
- **Metrics are honest**: steps the hosted-model adapter works out itself (typing a script, scrolling, waiting) are counted as `localSteps`, not model calls.

Development logging (off by default): `NOAH_LOG=1` prints one JSON line per lifecycle event — `AGENT_SESSION_CREATED / REUSED / PAUSED / RESUMED / DESTROYED`, `AGENT_RUN_STARTED / COMPLETED / FAILED / CANCELLED`, `BROWSER_NAVIGATION`, `ACTIVE_TAB_CHANGED`, `VOICE_COMMAND_RECEIVED`, `TEXT_COMMAND_RECEIVED`, `IPC_LISTENER_REGISTERED / REMOVED` — each with `sessionId`, `runId`, `tabId`, `url`, `timestamp`. The live test (`npm run noah:session`) reads it to assert one session, no duplicate listeners and start = end for every run.

## 5. Safety architecture (code-enforced, model-independent)

- **URL guard**: only http(s)/about/history navigation; file://, javascript:, data:, chrome:// and localhost (unless enabled) are refused; redirects are re-checked; a live session-cookie value in a URL or typed text is refused.
- **Risk classifier + policy**: low/medium/high/blocked. Modes: `autonomous` (confirm high), `supervised` (confirm medium+), `strict` (confirm every change). Purchases, publishing, destructive actions, security settings, uploads, payment forms and foreign-clipboard use are always confirmed. Credential typing is blocked unless the user turns it on, and is then confirmed.
- **Indirect prompt injection**: instruction-like page text is flagged, taints the task, and escalates later typing/navigation to confirmation; page content can never write memory.
- **Files**: uploads need confirmation and an allow-listed path (sensitive locations refused); executable downloads are blocked during tasks.
- **Emergency stop**: ESC or the STOP button call `SafetyController.stop()`, checked between every low-level input event (mid-drag included). It does not go through the model. Takeover: real keystrokes, real mouse movement or a tab switch pause the agent; Noah's own synthetic input is distinguished from physical input.
- **Audit**: JSONL per action with typed text redacted.
- **Electron**: `contextIsolation`, no Node in pages, IPC handlers validate the sender, API keys never reach the renderer (`getConfig` returns status only) and are stored with `safeStorage`.

## 6. The purple Noah Cursor

Theme constants live in one place (`Noah/theme.cjs`: `NOAH_CURSOR_PRIMARY #7C3AED`, `NOAH_CURSOR_ACCENT #A855F7`, `NOAH_CURSOR_GLOW rgba(124,58,237,.35)`) and reach the overlay as CSS variables over IPC. States: IDLE, MOVING, HOVERING, CLICKING, DOUBLE_CLICKING, RIGHT_CLICKING, DRAGGING, TYPING, SCROLLING, WAITING, THINKING, ERROR, SUCCESS. Movement time scales with distance; clicks draw a ripple, drags a trail, typing highlights the focused field only while real typing happens, targets get a highlight box, a status pill shows a short action label (never chain-of-thought), and high-risk actions show a confirmation card. `prefers-reduced-motion` is honoured. STOP NOAH (ESC) is always visible while a task runs. The AI panel's **Purple cursor** checkbox (config `cursor.mode`: `decoupled` = on, `off`) hides the pointer, ripples, trail and highlights; the status pill, STOP button and confirmation card stay.

## 7. Model configuration (per role)

Roles: `planner` (decomposition, replanning; called rarely), `browser` (the workhorse: AX/text reasoning and element choice), `vision` (screenshot grounding), `fast` (classification, extraction), `local` (offline/private). Defaults live in `Noah/models/catalog.cjs` as **data**, marked `verified: false` because they were taken from public documentation and could not be called live:

| Role | Preference order (first configured wins; the rest are failover targets) |
|---|---|
| planner | `claude-sonnet-5` → `gemini-3.8-flash` → `gpt-5.4` |
| browser | `gemini-3.8-flash` → `claude-sonnet-5` → `gpt-5.4` → `qwen3.8-27b` |
| vision | `gemini-3.8-flash` → `claude-sonnet-5` → `gpt-5.4` → `qwen3.8-27b` |
| fast | `gemini-3.5-flash-lite` → `claude-haiku-4-5-20251001` |
| local | `qwen3-vl:8b` via a local OpenAI-compatible server |

**The hosted Jonah model** (`provider: "rexy"`, default `https://www.noahai.live/predict`, override with `REXY_LLM_ENDPOINT`) is text-only: it has no screenshots, no tool-calling and no planning mode, and answers `{actions, complete, reason}` in CSS-selector vocabulary. `Noah/models/rexy-legacy.cjs` adapts it, and every adaptation below came from probing the live endpoint:

- Sent bare refs (`e12`) it invents selectors (`#Search_products`); sent `[data-noah-ref="e12"]` it echoes them back, so refs are sent in that form and mapped back. Selectors it invents anyway are matched to a listed element by name.
- It plans nothing, so Noah plans locally; and if the goal names a URL, Noah navigates there first (left alone, the model types the goal into Jonah's own home-page search box).
- It re-navigates to the same URL every turn, invents URLs from link text (`/Laptops`), and re-types the same text without submitting. The adapter drops a navigate to the current page, turns an invented URL into a click on the matching link, gives `type` fill semantics (`clear`) and submits a lone search box.
- It never reports `complete` on a reading task. When it proposes "navigate to where I already am" (or repeats a proposal), Noah asks its chat mode to answer the goal, rewritten as a plain question, from the page text.
- It is treated as a **weak** model by the router: it never serves sensitive tasks and is only used when nothing better is usable. The perception policy stays on text/AX when no vision-capable model is usable.

**Acting like a person (all models, plus a deterministic script for weak ones).**

- *No URL jumping.* Inside a site, `navigate` to a URL that the user did not write and that is not a real link on the page is refused with a hint (`agent/human-nav.cjs`, config `humanLike`, default on; the system prompt says the same). The site's home page, other sites, the current URL and URLs from the goal are fine.
- *Goal script* (`models/goal-script.cjs`, used for the hosted model). A goal such as "open youtube.com and search for lo-fi music and scroll down and play the best one" is parsed into steps (search, scroll, pick best/first, play) and each is derived from the goal, what already happened and what is on screen: click the search box and type key by key (about 40 ms per key), press Enter, wheel-scroll in small notches, move the cursor to the most-viewed real result (ads, shorts and channel links skipped) and click it, press play if paused. A failed step is fixed before it is retried (open a collapsed search box, let the page settle); a click that opens nothing playable makes it choose the next result; if it keeps failing the task goes back to the model instead of claiming success.
- *Writing goals* (`models/compose.cjs`): "type a story about Jurassic World on this notepad" is handled as write-once. The topic is pulled out of the request and sent to the hosted chat mode with a prompt that mentions no site or page (the chat mode echoes or "opens links" for commands); a reply that is an echo, too short, or looping is rejected and re-asked, sentences are de-duplicated and capped near 260 words; then Noah clicks the largest text area, jumps to the end (never overwrites), types it once, key by key, checks the text is still in the box (some editors wipe it if typed before they finish loading; then it waits and writes once more), and finishes. If no real text can be produced it says so instead of typing junk.
- *Nothing typed twice, and no placeholders.* Noah's logs abbreviate typed text as `The Jurassic…[25 chars]`. That marker used to be fed back to the model, which copied it and typed it in a loop. It is no longer sent back, the executor refuses any `type` whose text contains it (`placeholder_text`), the agent refuses to type identical text into the same field on the same page again (`already_done`), and the adapter drops a repeated `type` and finishes.
- *Deciding for itself.* Noah pauses for the person only for sign-in, passwords or codes, CAPTCHAs and payments (`agent/ask-policy.cjs`, config `autoDecide`, default on). Any other question, and any "stuck: repeating myself / repeated failures" escalation, is answered by Noah: it re-reads the page and tries a different approach, and only after several genuine attempts ends the task with an honest message. The same question is never asked twice.
- *Two perception bugs found on the way:* after some navigations (YouTube) the cached isolated JS world belonged to the initial blank document, so the page looked like `about:blank` with a 0×0 viewport and every action failed as "offscreen" (fixed: the world is rebuilt when it disagrees with the browser's URL, and the URL comes from the browser first); and the AX tree often has no URL for links, so link URLs are now read from the page's anchors and attached by position.

Rules the router enforces: failover is announced (`model_failover` event, shown in the panel), never silent; a **sensitive task never continues on an untrusted or local model** (it stops with `NO_TRUSTED_MODEL`); a failing model cools down (auth 10 min, quota 15 min, rate limit 60 s, …); each candidate is tried at most once per call; the legacy text-only Rexy backend is a last resort for non-sensitive, non-vision calls only.

Edit roles in `<userData>/browser-data/noah/noah-config.json` (or `window.noah.setConfig`), for example:

```json
{ "roles": { "browser": [ { "provider": "anthropic", "model": "claude-sonnet-5", "trusted": true } ] } }
```

## 8. Setup

1. Noah works out of the box with the hosted Jonah model (no key). For anything beyond simple navigation, give it a stronger model. Either put a key in the project `.env` (only these names are ever read: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `DASHSCOPE_API_KEY`/`QWEN_API_KEY`, `REXY_LLM_API_KEY`, `NOAH_LOCAL_BASE_URL`, `NOAH_LOCAL_MODEL`, and `NOAH_<PROVIDER>_BASE_URL`), or call `window.noah.setKey(provider, key)` (stored with `safeStorage`). Generic `*_BASE_URL` variables are deliberately ignored.
2. Fully local option: install Ollama, `ollama pull qwen3-vl:8b` (about 6 GB), and leave `NOAH_LOCAL_*` unset (defaults to `http://127.0.0.1:11434/v1`).
3. `npm start`. Ask for a browser task in the AI panel, the voice orb, or with the Noah bar. Modes: autonomous / supervised / strict; Sandbox opens Noah's own cookie-less tabs. (There is no debug view: it was removed. Development logging is `NOAH_LOG=1`, see section 4b.)

## 9. What was run, and the honest limits

Commands (all in `package.json`): `npm run noah:test` (unit), `npm run noah:bench` (harness; add `-- --zoom=1.5` or set `NOAH_DPR=2`), `npm run noah:integration` (real Jonah app), `npm run noah:live` (real provider, bounded), `npm run noah:demo` (real Jonah window stays open and replays a task so the cursor can be watched; close the window to end), and `node Noah/bench/report.cjs` to regenerate BENCHMARKS.md.

Measured results are in [BENCHMARKS.md](BENCHMARKS.md). What they are:

- **Tier A** (deterministic controllers, no model) and **Tier B** (the real agent loop driven by a *scripted reference policy*, not an LLM) show the machinery works and recovers; they say nothing about model quality.
- **Integration** drives the real Jonah app through a legacy Rexy goal into Noah, with the real `OpenAIProvider` talking HTTP to a local scripted server, and checks the cursor by counting solid purple pixels in the captured window frame.
- **Live run** (`noah:live`, the only script that talks to a real model): the goal is "open the fixture shop, search for laptops, tell me the cheapest 16GB laptop and its price", using the hosted model at `www.noahai.live`. After the adapter work in section 7 it completed in 20 s over 4 steps with the cursor visible (474 solid purple pixels in the captured frame). **The answer was wrong** in both final runs (it said ₹68,499 each time, once with a product name that is not on the page; the cheapest 16GB laptop on the fixture is ₹61,999), and direct probes of its chat mode gave the right answer in only 1 of 7 phrasings. Getting the machinery to run is Noah's job; getting the comparison right is the model's, and this one is too weak for reading-and-comparing tasks. This is one task on one fixture site, not a success rate. Earlier live attempts in the same session: the `GEMINI_API_KEY` in `.env` is rejected by Google (`API_KEY_INVALID`) and the old Render backend answered `503 Service Suspended`.
- The Anthropic/OpenAI/Gemini adapters have still only been exercised against fake servers and unit-level wire checks: no valid key for them exists on this machine. Ollama is installed but has no model pulled.

Known limitations:

- Real productivity apps (Docs, Sheets, Slides, Figma, Canva) are untested; the fixtures reproduce their hidden-textarea, canvas and drag patterns only.
- Cross-origin (out-of-process) iframes are observable and clickable through coordinates, but in-page hit-testing cannot see inside them.
- Popups opened through `window.open`/`new-window` and incognito windows are not covered; only the main window is supported.
- Tested on Windows 10 with Electron 28.3.3 (Chromium 120) only; DPR 2 was exercised with Chromium's device-scale flag, not a physical HiDPI or macOS Retina display.
- Catalog model IDs and prices are unverified until first used with a real key.
- The integration harness stalled on a few early launches. One stall was root-caused (the takeover monitor correctly paused the agent when the machine's real mouse moved; the test now disables takeover). Two early launches hung before the task started and were not reproduced afterwards in 30+ clean sequential runs; the cause is unknown and may be overlapping test processes sharing Jonah's fixed ports 5588/5589.
- Token counts in Tier B are estimates, not billed usage.

Pre-existing Jonah issues noticed along the way (not introduced by Noah, not changed): `.env` and `key.json` (which contains a GitHub token) are tracked in git; `express.static(__dirname)` on `127.0.0.1:5589` serves the project folder, including those files; API keys are hard-coded in `main.cjs`; the `certificate-error` handler accepts every certificate; `Permissions.requestApproval()` always returns true; several `appendSwitch("enable-features")` calls override each other; the legacy planner can call `executeJS` and cookie actions. Rotate any key that has been committed.

## 10. Next improvements

1. Run `noah:live` with one valid key (or a pulled local model), then a small real-LLM benchmark; publish those numbers next to the scripted ones.
2. Test against real Docs/Sheets/Slides/Figma/Canva once an authenticated session is available.
3. Per-origin permission profiles ("always confirm on this bank", "never touch this site").
4. Multi-window and popup support; macOS validation on a Retina display.
5. Stream model output and act on the first valid action to cut latency; cache AX snapshots across steps.
6. Move the API-key `.env` path out of the served project folder.
