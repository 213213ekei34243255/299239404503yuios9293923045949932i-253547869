# Noah: Research Findings (Computer-Use + Browser Agents)

*Compiled 2026-09-21 from public documentation and public third-party analyses. No proprietary source code or prompts were used or copied. Where a claim comes from a search snippet or an aggregator site rather than a primary document I opened, it is marked **(secondary)**. Treat model names, prices and benchmark numbers as volatile; they are configuration in Noah, not code.*

---

## 1. Perplexity Computer, Comet, Personal Computer

**Perplexity Computer** ([announcement, Feb 25 2026](https://www.perplexity.ai/hub/blog/introducing-perplexity-computer)) is an orchestration layer, not a single model. The user states an outcome; the system decomposes it into tasks/sub-tasks and spawns sub-agents (research, document generation, data processing, API calls). It runs a strong reasoning model as the core (Opus 4.6 at time of writing) and routes sub-agents to other models by strength (Gemini for deep research, a fast model "for lightweight tasks", another for long-context recall). It is explicitly model-agnostic and lets users pick models per subtask. Each task runs in an isolated environment with a real filesystem, browser and tool integrations, can run asynchronously for long periods, and "checks in if it truly needs you".

**Personal Computer** **(secondary: [AppInsider](https://appleinsider.com/articles/26/03/11/perplexitys-personal-computer-lets-ai-agents-access-your-mac-minis-files), [TechCrunch](https://techcrunch.com/2026/05/07/perplexitys-personal-computer-is-now-available-everyone-on-mac/))** is the local variant on a Mac/Mac mini: agents get access to local files and native apps, and use Comet to operate web tools that have no connector. Reported controls: sensitive actions need approval, actions are logged, there is a kill switch.

**Comet** (browser). The best public technical description is a third-party teardown of the shipped extensions ([Zenity Labs, Feb 11 2026](https://labs.zenity.io/post/perplexity-comet-a-reversing-story)). Findings relevant to Jonah:

| Comet mechanism (as publicly analysed) | Takeaway for Noah |
|---|---|
| Model/backend issues commands; a browser-side extension executes them over CDP (`chrome.debugger`) | Keep the *decision* layer separate from a *narrow, validated executor* |
| Two channels: SSE for chat UI, WebSocket for high-frequency automation RPC | Separate UI event stream from action/observation stream |
| `ReadPage` = `Accessibility.getFullAXTree` rendered as a YAML tree; interactive nodes carry a reference id | AX tree + stable element refs is the primary perception layer |
| `GetPageText` = HTML → markdown | Cheap text-only read for content tasks |
| `ComputerBatch` = sequences of low-level actions using raw pixel coordinates; `FormInput` by node ref | Batched actions; refs for forms, coordinates for everything else |
| "Click on submit" is really "click ref_32"; model can use ref *or* coordinate | Dual targeting in one protocol |
| Hard boundaries in the executor: `isInternalPage`, `isUrlBlocked` (file://, internal pages, admin list, user domain blacklist) | Enforce URL/domain policy in **code**, never only in the prompt |

## 2. Anthropic computer use

Source: [Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) and [Browser use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool) docs.

* **Action set** (17 members): `screenshot`, `zoom`, `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `left_click_drag`, `mouse_move`, `left_mouse_down`, `left_mouse_up`, `cursor_position`, `scroll`, `type`, `key` (chords, `repeat`), `hold_key`, `wait`.
* **Coordinates are in the pixel space of the screenshot returned to the model.** The application must scale back to real display coordinates; Retina/DPR-2 must be handled explicitly; a size mismatch is the classic cause of consistent offset clicks. Recommended web-app sizes: 1280×800 / 1366×768; avoid >1920×1080. *`zoom` returns a region at full resolution but coordinates stay in full-screenshot space.*
* **Batch actions**: the model may emit several actions in one turn; run them **in order, stop at first failure**, mark the rest "not executed", and end with a screenshot. A human-confirmation check must run **before each block**, "because a batch can complete a multistep action within one turn".
* **Verification**: docs recommend prompting the model to screenshot and check after each step because it "sometimes assumes outcomes"; put the instruction text *before* the image; suggest keyboard shortcuts for awkward widgets (dropdowns, scrollbars).
* **Screenshot history** grows costly (≈1,000–1,800 tokens each); prune in batches to preserve prompt caching.
* **Browser use tool** (the hybrid): `read_page` returns the accessibility tree with element **refs**; actions accept a `RefTarget` *or* a `CoordinateTarget`. Guidance: *prefer refs where the tree is usable* (survive layout shifts); *fall back to coordinates for canvas UIs, embedded video, virtualized lists and cross-origin iframes*; *scope reads, read the tree before screenshotting* (tree reads usually cost fewer tokens). Refs are per-tab, valid until navigation/material DOM change; a stale ref must return an error telling the model to re-read; **do not renumber refs already handed out**. Tab state reported as a `browser_state` inventory.
* **Security guidance** (applies directly to Noah): build page reads from the *rendered* a11y tree/visible text, not raw DOM, so hidden text does not reach the model; enforce a domain allowlist and re-check after redirects; validate URL scheme with a parser (http/https only); keep `javascript_exec` and `file_upload` **disabled by default**; restrict uploads to an allow-listed directory; redact secrets from console/network logs; human confirmation for purchases, account changes, messaging, accepting terms.
* **Prompt-injection work**: [Anthropic, Nov 2025](https://www.anthropic.com/news/prompt-injection-defenses) describes RL training against injections, classifiers over all untrusted content entering context, and red-teaming; a ~1% attack success rate against an adaptive attacker is still "meaningful risk". Conclusion: model-side defences are necessary but not sufficient; architectural limits matter.

## 3. OpenAI computer use

Source: [Computer use guide](https://developers.openai.com/api/docs/guides/tools-computer-use), [GPT-5.4 announcement](https://openai.com/index/introducing-gpt-5-4/).

* Two integration styles: **code execution** (model writes Playwright/PyAutoGUI scripts; recommended for newest models) or the **`computer` tool** returning structured actions: `click, double_click, drag, move, scroll, keypress, type, wait, screenshot`. A `computer_call` carries an ordered `actions` array (batching); the app executes them and returns a screenshot (`detail: "original"` preserves resolution). If screenshots are downscaled, map coordinates back.
* Loop is perception → reasoning → action, application-owned execution ("your application decides whether to execute").
* **Run-safely rules** (adopted verbatim in spirit): restrict the environment (isolated browser, allowlist); treat screen content as untrusted, *text on a page cannot grant permission*; confirm consequential actions, *"typing sensitive information into a form counts as transmission"*; bound and verify the run (step/time/cost limits, cancellation) and **check the actual outcome instead of relying only on the model's final answer**.
* GPT-5.4: first general model with native computer use, **75.0% on OSWorld-Verified** (vs 72.4% human reference) per OpenAI's announcement **(secondary snippet)**. Newer models are referenced in the current guide; not evaluated here.

## 4. Gemini computer use

Source: [Gemini API computer use docs](https://ai.google.dev/gemini-api/docs/computer-use) (last updated 2026-09-17).

* Actions return **normalized 0–999 coordinates** that the client scales to the viewport. Newer models attach an `intent` explaining each action; a server-side `safety_decision` classifies each action as regular / `require_confirmation` / blocked; opt-in screenshot scanning for prompt injection.
* Recommended model for computer use: `gemini-3.8-flash`; `gemini-3.5-flash-lite` is the low-latency/low-cost option.
* Implication: coordinate space is a **per-provider property**, so Noah's mapper supports `image_px`, `normalized_1000` and `normalized_1`.

## 5. Browser Use and the move from Playwright to raw CDP

Source: [Closer to the Metal: Leaving Playwright for CDP](https://browser-use.com/posts/playwright-to-cdp) (Aug 2025).

* Reasons: Playwright adds a **second network hop through a Node server**, costly when an agent makes *thousands* of CDP calls (element position, opacity, paint order, event listeners, aria properties); adapters obscure browser behaviour; raw CDP enabled proper **cross-origin iframe** support and async reactions.
* **Implication for Electron:** `webContents.debugger` is *already* an in-process CDP client, so Noah gets the "raw CDP, no extra hop" benefit for free. No Playwright/Puppeteer dependency is added (they also cannot attach to a `<webview>` guest cleanly).

## 6. Playwright's accessibility approach

Source: [Playwright MCP snapshots](https://playwright.dev/mcp/snapshots).

* Snapshot = YAML-like tree of accessible nodes, each with a ref (`e5`, `f1e12` for elements in the first iframe). Refs are unique within a snapshot, valid until the page changes, stale refs fail with a clear error. Optional `boxes` gives viewport-relative CSS-px boxes. A `find` tool returns only matching nodes with context (much cheaper than a full snapshot). Docs recommend combining snapshots with screenshots for canvas apps/charts.
* Trade-off table the docs give (snapshot: cheap, exact, deterministic, no vision model; screenshot: approximate, layout-sensitive, needs vision) is the basis of Noah's method-selection ladder.

## 7. Electron-specific findings (verified by spike on this machine, Electron 28.3.3)

* `webview.getWebContentsId()` (renderer) → `webContents.fromId()` (main) gives the guest; `guest.debugger.attach('1.3')` works.
* `Page.captureScreenshot` returns an image whose size relates to CSS viewport × DPR × zoom; **Noah derives the image→CSS ratio from the actual decoded image size and `Page.getLayoutMetrics`**, not from assumptions.
* `Input.dispatchMouseEvent` produced a real page click at the requested CSS coordinate; `Accessibility.getFullAXTree` returned button/iframe nodes in ~13 ms.
* A cross-origin iframe (`localhost` inside `127.0.0.1`) appears as a **separate target** (`Target.attachedToTarget`), so AX for such frames needs a flattened child session.
* **HTML5 drag-and-drop:** `Input.setInterceptDrags` + `Input.dispatchDragEvent` completed a synthetic drop. Without interception a native drag would enter an OS drag loop that synthetic input can never end (hang risk).

## 8. Models: what to use for which role

Benchmarks below are **OSWorld-Verified (a desktop-task benchmark) and vendor/aggregator figures**; scores are saturating and are *not* a measure of Jonah-style web tasks. Prices/IDs are as reported on 2026-09-21 and must be confirmed against your account.

| Model (ID) | Computer use / vision | Tool calling | Context | Price (in/out per 1M) | Notes |
|---|---|---|---|---|---|
| Claude Opus 5 (`claude-opus-5`) | Supported by Anthropic computer/browser toolsets (doc examples use it) | Yes | 1M **(secondary)** | $5 / $25 **(secondary)** | Best for planner escalation, hard visual tasks |
| Claude Sonnet 5 (`claude-sonnet-5`) | 81.2% OSWorld **(secondary)** | Yes | 1M **(secondary)** | $3 / $15 std **(secondary)** | Best price/perf default for planner + vision |
| Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | Vision, no CU claims | Yes | (n/v) | (n/v) | Fast tier |
| GPT-5.4 | 75.0% OSWorld-Verified (OpenAI) | Yes | (n/v) | (n/v) | Solid alternative for browser role |
| Gemini 3.8 Flash (`gemini-3.8-flash`) | **Google-recommended for computer use** | Yes | (n/v) | ~1.5 / 7.5 for 3.6-class **(secondary)** | Cheap, fast; normalized 0–999 coords |
| Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`) | Supports CU (low latency) | Yes | (n/v) | ~0.30 / 2.50 **(secondary)** | Fast tier candidate |
| Qwen3.8-27B / Qwen3-VL family | 84.3% OSWorld-Verified **(aggregator, unverified)**; Qwen3-VL strong GUI grounding (tech report) | Yes | (n/v) | ~$0.40 in **(secondary)** | Open weights → local/private (vLLM/Ollama) |
| UI-TARS-1.5-7B | Native screenshot→action GUI model | via own action format | small | free (local) | Local computer-use fallback (vLLM) |

**Role recommendations (all overridable in config):**
* **Planner**: Sonnet 5 (escalate to Opus 5 for high-risk or very long tasks). Called ~once per task + on replans, so cost is negligible.
* **Browser reasoning** (most calls, AX-text mode): cheapest reliable model with tool calling: Gemini 3.8 Flash, else Sonnet 5.
* **Vision / computer-use** (screenshot grounding): Gemini 3.8 Flash (Google's recommended CU model, cheap) or Sonnet 5 (mechanically precise clicking per Anthropic docs); Opus 5 for hard canvas tasks.
* **Fast** (classification, page-question extraction, summaries): Gemini 3.5 Flash-Lite or Haiku 4.5.
* **Local** (offline/private, low latency): Qwen3-VL via Ollama, or UI-TARS-1.5-7B via vLLM. **Not installed on this machine** (Ollama runs but has 0 models).
* The pre-existing Render-hosted "Rexy" endpoint is kept as a **text-only legacy provider** (no screenshots, no tool-calling contract).

## 9. Security risks for a browser agent inside Jonah

1. **Indirect prompt injection** via page text, hidden/white text, HTML comments, alt text, tab titles, URL fragments (e.g. "HashJack"), screenshots. Brave's research showed Comet fetching OTPs / touching bank pages from a "summarize this page" request ([Register](https://www.theregister.com/2025/10/28/ai_browsers_prompt_injection/), [Cato HashJack](https://www.catonetworks.com/blog/cato-ctrl-hashjack-first-known-indirect-prompt-injection/)), and the academic survey [Building Browser Agents](https://arxiv.org/pdf/2511.19477) calls for defence in depth.
2. **Confused deputy**: Jonah's tabs share the user's logged-in `persist:main` session, so an injected page can act *as the user* on other sites.
3. **Exfiltration** through navigation URLs, typed text, uploads, cookies, clipboard.
4. **Unintended consequential actions**: purchases, sending messages, deletion, permission grants.
5. **Local-resource abuse**: `file://`, loopback services, internal pages, downloading/executing files.
6. **Model-independent failure**: model hallucinated success, infinite loops, cost blow-ups.
7. **Pre-existing Jonah risks found while reading the code** (not introduced by Noah, but they affect agent safety; see `ARCHITECTURE.md` §Security):
   secrets committed to git (`.env`, `key.json`), `express.static(__dirname)` on `127.0.0.1:5589` serving the project directory (including those files) to any local page, `certificate-error` handler that accepts every certificate, `Permissions.requestApproval()` returning `true` unconditionally, `executeJS`/cookie actions exposed to the planner.

## 10. Design decisions that follow

| Decision | Rationale |
|---|---|
| Hybrid perception: AX tree (refs + boxes) → optional screenshot → coordinate input | Playwright/Anthropic/Comet all converge on this; each layer covers the others' blind spots |
| Raw CDP through `webContents.debugger`; per-frame sessions for OOPIFs | Browser Use finding + verified Electron behaviour |
| Even ref-based clicks become real mouse events at the element's computed point | Faithful event semantics + visible cursor for every semantic action |
| One neutral function-call action protocol; provider adapters convert coordinate spaces | Not tied to any vendor's computer-use tool; works with any tool-calling VLM |
| Batches ≤ 5, verify after **each** action, halt on first failure or unexpected state change | Anthropic batch rule + OpenAI "verify actual outcome" |
| Policy/URL/confirmation enforced in code, model-independent; taint tracking after injection-like content | Comet "hard boundaries"; Anthropic/OpenAI guidance |
| Emergency stop and user-takeover detection independent of the model | Requirement + Personal Computer "kill switch" pattern |
| Visual cursor is a *consumer* of the same action events as the executor | Prevents drift between what is shown and what happens |
