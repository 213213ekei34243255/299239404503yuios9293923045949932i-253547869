// Noah/models/rexy-legacy.cjs
//
// Adapter for Jonah's hosted model (`/predict`, default https://www.noahai.live/predict).
// That server owns its own prompt and returns `{ complete, actions:[{type,...}], reason }`
// using CSS-selector style actions. This adapter keeps it usable as a TEXT-ONLY fallback
// (no screenshots, no tool-calling contract) by:
//   * sending the AX element list with our element REFS in the `selector` fields (the server
//     treats selectors as opaque strings), and
//   * translating its action vocabulary into Noah protocol actions.
// Unsafe legacy vocabulary (executeJS, cookies, history) is dropped, never executed.
//
// STATUS: exercised live against the endpoint above (see docs/ARCHITECTURE.md, section 7). The server is a small,
// stateless model that needs the compensations below; it is treated as a weak model by the router.

"use strict";

const { BaseProvider, ProviderError, extractJson } = require("./base.cjs");
const { GoalScripts, siteOf, looksLikeFormTask } = require("./goal-script.cjs");
const { humanNavigationBlock } = require("../agent/human-nav.cjs");
const { needsHuman } = require("../agent/ask-policy.cjs");
const { Composer } = require("./compose.cjs");
const { FormFiller } = require("./form-fill.cjs");
const { verifyCompletion, looksLikeRefusalOrChat } = require("./completion-guard.cjs");

const DROPPED = new Set(["executeJS", "getCookies", "clearCookies", "history", "bookmark", "capturePage", "focusWindow", "download", "upload"]);
const REF = /^(f\d+)?e\d+$/;

// The legacy server was written for real CSS selectors. Sent a bare "e12" it invents one from the element's name
// ("#Search_products"); sent this attribute selector it echoes it back verbatim (checked against the live endpoint).
const refSelector = (ref) => `[data-noah-ref="${ref}"]`;
const REF_IN_SELECTOR = /data-noah-ref\s*=\s*["']?((?:f\d+)?e\d+)["']?|^#((?:f\d+)?e\d+)$/;
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Selector from the server -> Noah target. Exact refs first; otherwise a selector the model made up
 * (`#Search_products`, `input[name="q"]`, `text=Sign in`) is matched to an element we listed by its words.
 */
function targetFrom(selector, els = []) {
  if (typeof selector !== "string" || !selector.trim()) return null;
  const sel = selector.trim();
  if (REF.test(sel)) return { ref: sel };
  const m = REF_IN_SELECTOR.exec(sel);
  if (m) return { ref: m[1] || m[2] };
  const words = [...sel.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
  words.push(sel.replace(/^(text|role|placeholder|label)\s*=/i, "").replace(/[#.[\]>:()="']+/g, " "));
  for (const w of words) {
    const k = slug(w);
    if (!k) continue;
    const hit = els.find((e) => slug(e.name) === k || slug(e.placeholder) === k) || els.find((e) => slug(e.name).includes(k) || (slug(e.name) && k.includes(slug(e.name))));
    if (hit) return { ref: hit.ref };
  }
  // Unresolved. Human words ("Add to cart") stay as they are; CSS-looking ids become plain words for the fuzzy text matcher.
  if (!/[#.[\]>:=]/.test(sel)) return { text: sel };
  return { text: words[words.length - 1].replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || sel };
}

/**
 * The goal as a plain question about the page. The hosted chat mode routes anything phrased like a command
 * ("search for ...", "open <url>") to its web-search / "opening the link" paths instead of reading page_content.
 */
function questionFrom(goal) {
  let g = String(goal || "").replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 4; i++) {
    const next = g
      .replace(/^(?:(?:and|then)\s+)?(?:open|go to|goto|visit|navigate to|search for|search|find|look up|look for)\b.*?[,;.](?=\s|$)\s*/i, "")
      .replace(/^(?:and|then)\s+/i, "")
      .trim();
    if (next === g || !next) break;
    g = next;
  }
  return g || String(goal || "");
}

const goalCompares = (g) => /\b(cheapest|cheaper|lowest|highest|best|compare|most|least|top)\b/i.test(String(g || ""));
// "which" alone is not enough: "go to youtube WHICH can give us chill" is a relative clause, not a question. Only count it
// when it is actually asking something ("which one/video/option is/are ...").
const ANSWER_ASK =/\b(tell me|what|which\s+(?:one|video|option|of|is|are|should)|who|when|where|how many|how much|list|summari[sz]e|find out|compare|show me|read out|give me|name the)\b/i;
/** Does the goal ask for information back (vs. asking Noah to do something in the browser)? */
function goalNeedsAnswer(goal) {
  const g = String(goal || "");
  // "Open Amazon and search for shoes cheapest ones" is browsing even though it says "cheapest": only an explicit request
  // for information counts, or a bare "find the cheapest X" that does not say to search/browse for it.
  return ANSWER_ASK.test(g) || (/\b(cheapest|cheaper|lowest|highest|price of)\b/i.test(g) && !/\b(search|browse|shop|look|open|go to|visit)\b/i.test(g));
}

// "Open X" is done the moment you arrive. "Open X and fill in/answer/submit ..." is NOT done just because you
// arrived - there is real work left on the page that "I tried to navigate here again" says nothing about.
const NEEDS_PAGE_ACTION = /\b(fill(?:s|ed|ing)?|answer(?:s|ed|ing)?|submit(?:s|ted|ting)?|type|types|typing|enter(?:s|ed|ing)?|click(?:s|ed|ing)?|check(?:s|ed|ing)?|tick(?:s|ed|ing)?|select(?:s|ed|ing)?|choose|choos(?:es|ing)|write|writes|writing|complete(?:s|d)?|sign(?:s|ed|ing)?)\b/i;
/** Does the goal ask for something to be DONE on the page (not merely reached)? */
function goalNeedsPageAction(goal) {
  return NEEDS_PAGE_ACTION.test(String(goal || ""));
}

const SEARCH_INTENT = /\b(?:search(?:\s+for)?|look\s+for|shop\s+for|browse\s+for)\s+["“']?(.+?)["”']?(?=[,;]|\.(?=\s|$)|\s+(?:and|then|over here|here|on (?:this|the) (?:site|page|website))\b|\s*$)/i;
const FOLLOW_UP = /\b(click|open (?:the )?(?:first|top|second|third|\d)|select|add (?:it |them )?to (?:the )?cart|buy|purchase|order|sort|filter|scroll|play|watch|download|sign in|log in|login)\b/i;
/** "search for shoes cheapest ones, then ..." -> { query: "shoes cheapest ones", followUp: <more to do after searching?> } */
function searchIntentFrom(goal) {
  const g = String(goal || "");
  const m = SEARCH_INTENT.exec(g);
  if (!m) return null;
  const query = m[1].replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "");
  if (query.length < 2 || query.length > 120) return null;
  return { query, followUp: FOLLOW_UP.test(g.slice(m.index + m[0].length)) };
}

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch (_) {
    return "";
  }
};
const BARE_DOMAIN = /(?<![@\w.-])((?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|io|co|in|uk|us|de|fr|app|dev|ai|tv|me|info|xyz|live|news|shop|store|online|site|tech|wiki)(?:\/[^\s,"'<>)]*)?)(?![\w@-])/i;
const SITE_WORDS = { youtube: "youtube.com", google: "google.com", wikipedia: "wikipedia.org", amazon: "amazon.com", github: "github.com", reddit: "reddit.com", netflix: "netflix.com", twitter: "x.com", facebook: "facebook.com", linkedin: "linkedin.com", bing: "bing.com", duckduckgo: "duckduckgo.com", justnotepad: "justnotepad.com" };
/** The site a goal names: a full URL, a bare domain ("open youtube.com"), or a well-known site word ("open youtube"). */
const firstUrlIn = (text) => {
  const t = String(text || "");
  const full = /https?:\/\/[^\s,"'<>)]+/i.exec(t);
  if (full) return full[0].replace(/[.,;:!?]+$/, "");
  const bare = BARE_DOMAIN.exec(t);
  if (bare) return "https://" + bare[1].replace(/[.,;:!?]+$/, "");
  const word = /\b(?:open|go to|goto|visit|navigate to|launch|load)\s+(?:the\s+)?(youtube|google|wikipedia|amazon|github|reddit|netflix|twitter|facebook|linkedin|bing|duckduckgo|justnotepad)\b/i.exec(t);
  if (word) return "https://" + SITE_WORDS[word[1].toLowerCase()];
  // Typo-tolerant fallback: a real bug report showed "Openm youtube and search for X" (an extra "m" glued onto
  // "open" - a voice-input/fat-finger slip) never matching the strict verb above, so Noah never left its own
  // home page and just typed the query into Jonah's own search box instead. Rather than guess the exact typo
  // shape, catch the more general case: a known site name within the first two words of the goal, immediately
  // followed by a connector introducing what to do there ("and search for...", ": search for...") - this covers
  // any mangled/missing verb without needing the word "open" to survive intact. Tight and bounded (at most one
  // leading word, an exact site name, then a connector) to avoid firing on "I love youtube personally...".
  const early = /^\s*(?:\S+\s+){0,1}(youtube|google|wikipedia|amazon|github|reddit|netflix|twitter|facebook|linkedin|bing|duckduckgo|justnotepad)\b\s*(?:[,:]|and\b)/i.exec(t);
  return early ? "https://" + SITE_WORDS[early[1].toLowerCase()] : "";
};
const PLACEHOLDER = /(?:…|\.\.\.)\[\d+ chars\]/;
/** Was this text already typed (a recent successful type entry, possibly shown truncated with a "…[N chars]" marker)? */
function alreadyTyped(text, recent) {
  for (const e of recent || []) {
    if (e.ok === false || !/^type\b/.test(String(e.text || ""))) continue;
    const q = /"([^"]*)"/.exec(String(e.text || ""));
    const prev = q ? q[1].replace(/(?:…|\.\.\.)\[\d+ chars\]$/, "") : "";
    if (prev.length >= 3 && String(text || "").startsWith(prev)) return true;
  }
  return false;
}
/** Does the page show what Noah recently typed (the visible start of a successful `type`, in a field value or in the page text)? */
function typedTextShown(recent, obs, els) {
  const squash = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
  const shown = squash([obs && obs.pageText && obs.pageText.viewport, obs && obs.pageText && obs.pageText.content, ...(els || []).map((e) => e.value)].join(" "));
  for (const e of recent || []) {
    if (e.ok === false || !/^type\b/.test(String(e.text || ""))) continue;
    const q = /"([^"]*)"/.exec(String(e.text || ""));
    const prefix = squash(q ? q[1].replace(/(?:…|\.\.\.)\[\d+ chars\]$/, "") : "");
    if (prefix.length >= 3 && shown.includes(prefix)) return true;
  }
  return false;
}
/** Noah memory line (`type e1 "laptops" -> ok ...`) -> the {action,args} pair the legacy server understands. */
function entryToLegacy(e) {
  const text = String(e.text || "");
  const m = /^(\w+)\s+(\S+)(?:\s+"([^"]*)")?/.exec(text);
  const action = m ? m[1] : "action";
  const args = {};
  if (m) {
    if (action === "navigate" || action === "new_tab") args.url = m[2];
    else if (/^(f\d+)?e\d+$/.test(m[2])) args.selector = refSelector(m[2]);
    // "The Jurassic…[25 chars]" is Noah's redacted log line, not text: sent back, the model copied it and typed it forever
    if (m[3] !== undefined && !PLACEHOLDER.test(m[3])) args.text = m[3];
  }
  return { action, args, result: { success: e.ok !== false, message: text.replace(/"[^"]*(?:…|\.\.\.)\[\d+ chars\]"/g, '"(typed text)"') } };
}

function translateAction(a, els = []) {
  const t = a.type || a.action;
  switch (t) {
    case "navigate": return { action: "navigate", url: a.url };
    case "back": case "goBack": return { action: "back" };
    case "forward": case "goForward": return { action: "forward" };
    case "reload": return { action: "reload" };
    case "click": case "doubleClick": case "rightClick": case "hover": {
      const target = targetFrom(a.selector, els);
      return target ? { action: { doubleClick: "double_click", rightClick: "right_click" }[t] || t, target } : null;
    }
    case "type": {
      const target = targetFrom(a.selector, els);
      return target ? { action: "type", target, text: String(a.text ?? "") } : { action: "type", text: String(a.text ?? "") };
    }
    case "pressKey": return { action: "key_press", key: a.key };
    case "scroll": {
      const dy = a.deltaY ?? a.y ?? a.amount ?? 0;
      return { action: "scroll", direction: dy < 0 ? "up" : "down", amount: Math.abs(dy) || "page" };
    }
    case "wait": return { action: "wait", ms: a.ms ?? 1000 };
    case "createTab": case "newTab": return { action: "new_tab", url: a.url };
    case "switchTab": return { action: "switch_tab", index: a.index };
    case "closeTab": return { action: "close_tab" };
    case "observe": case "extract": return { action: "read_page", filter: a.type === "text" ? "text" : "interactive" };
    case "ask_user": return { action: "ask_user", question: a.question || "The assistant needs your input." };
    default: return null;
  }
}

class RexyLegacyProvider extends BaseProvider {
  get type() {
    return "rexy";
  }

  /** One chat-mode round trip (the hosted model's plain text mode). page_content keeps it from asking for the page. */
  async _chat(message, pageContent, signal) {
    this._remote = (this._remote || 0) + 1;
    const r = await this.postJson(this.baseURL, {}, { mode: "chat", session_id: `noah-compose-${Date.now()}`, message, page_content: pageContent || "An empty online notepad with one large text box." }, { signal, timeoutMs: 60_000 });
    const j = typeof r === "string" ? extractJson(r) : r;
    return String((j && j.answer) || "");
  }

  isConfigured() {
    return true; // keyless by design (its own deployment)
  }

  async complete(req) {
    const t0 = Date.now();
    this._remote = 0; // real round trips made while answering THIS call (reported through `local()` so metrics stay honest)
    const meta = req.meta || {};
    const obs = meta.observation || {};
    const els = obs.elements || [];
    const local = (name, args) => (process.env.NOAH_DEBUG_LEGACY && console.log("[legacy] local", name, JSON.stringify({ summary: args.summary, status: args.status, act: args.actions && args.actions[0] && args.actions[0].action, url: obs.url, title: obs.title, loading: obs.loading, els: els.length, links: els.filter((e) => e.role === "link").length, watch: els.filter((e) => /watch/.test(e.href || "")).length, withRect: els.filter((e) => e.role === "link" && e.rect).length, vp: obs.viewport, box: (() => { const b = els.find((e) => e.role === "searchbox" || (/textbox|combobox/.test(e.role) && /search/i.test(e.name || ""))); return b && [b.ref, b.role, b.name, b.rect, b.states]; })(), sample: els.filter((e) => e.role === "link").slice(0, 2).map((e) => [e.name && e.name.slice(0, 30), e.href && e.href.slice(0, 40), e.rect && Math.round(e.rect.y)]) })), { text: "", toolCalls: [{ id: "legacy-local", name, args }], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "stop", latencyMs: Date.now() - t0, model: "rexy-render", local: true, remoteCalls: (() => { const n = this._remote || 0; this._remote = 0; return n; })() });

    // The server only chooses the next browser action; it has no planning mode. Plan locally instead of paying a
    // round trip (5-15 s) for an answer that would be thrown away.
    if (req.toolChoice === "noah_plan" || meta.kind === "plan") {
      const goal = String(meta.goal || "");
      return local("noah_plan", { objective: goal.slice(0, 300), complexity: "simple", steps: [goal.slice(0, 200)], success_criteria: [], sensitive: false, needs_visual: false, sites: [] });
    }
    // "open <url> ..." is deterministic: a fresh task starts on Jonah's home page, where the model tends to type the
    // goal into Jonah's own search box. Go to the URL the user gave first.
    const startUrl = firstUrlIn(meta.goal);
    if (startUrl && !(meta.recentActions || []).length && siteOf(obs.url) !== siteOf(startUrl)) {
      return local("noah_step", { status: "continue", summary: `Opening ${startUrl}`, method: "browser", actions: [{ action: "navigate", url: startUrl }] });
    }
    // We opened the site but the page has not arrived yet (slow load, redirect, still blank): wait for it. Asking the model
    // here made it "navigate" a second time, reloading the page it was waiting for.
    if (startUrl && (meta.recentActions || []).some((e) => /^navigate\b/.test(String(e.text || ""))) && siteOf(obs.url) !== siteOf(startUrl)) {
      const loads = (this._loadWaits ||= new Map());
      const key = meta.taskId || "noah";
      const n = loads.get(key) || 0;
      if (n < 5) {
        loads.set(key, n + 1);
        if (loads.size > 20) loads.delete(loads.keys().next().value);
        return local("noah_step", { status: "continue", summary: "Waiting for the site to load", method: "browser", actions: [{ action: "wait", ms: 1500 }] });
      }
    }
    // "Do it like a person": goals such as "search for X, scroll down, open the best one and play it" are run as a visible
    // script (click the box, type key by key, wheel-scroll, move to a result and click it) instead of asking this model
    // for the next step: left alone it navigates straight to URLs it guesses, so nothing is ever typed or scrolled.
    const recent = meta.recentActions || [];
    // "Write a story on the notepad": generate the text once, type it once, finish (see models/compose.cjs)
    const composed = await (this._composer ||= new Composer()).next({ taskId: meta.taskId || "noah", goal: meta.goal, obs, els, recent, generate: (prompt, page) => this._chat(prompt, page || "", req.signal), context: meta.context });
    if (composed) return local("noah_step", composed);
    // A multi-question form (Google Forms, a plain HTML form, a job application, a survey - any of them) has real,
    // trackable state (which question is already answered) the raw model has no memory of - see models/form-fill.cjs
    // for the reported bug this fixed (it filled in two fields, then got confused and started re-navigating to the
    // same form URL in a loop instead of answering the rest). Built on standard accessibility semantics, not one
    // site's markup, and verified against two independently-built forms.
    const formed = await (this._forms ||= new FormFiller()).next({ taskId: meta.taskId || "noah", goal: meta.goal, obs, els, recent, generate: (prompt) => this._chat(prompt, "", req.signal) });
    if (formed) return local("noah_step", formed);
    const scripted = (this._scripts ||= new GoalScripts()).next({ taskId: meta.taskId || "noah", goal: meta.goal, obs, els, recent, needsAnswer: goalNeedsAnswer(meta.goal) });
    if (scripted) return local("noah_step", scripted);
    // Once we are on the site the user named, do not hand the "open <url>" clause to the server: this model treats it as
    // step one of EVERY plan and re-navigates to the same URL each turn, so the page reloads and nothing else happens.
    const goalForServer = startUrl && siteOf(obs.url) === siteOf(startUrl)
      ? String(meta.goal).replace(/\b(?:open|go to|goto|navigate to|visit|launch|load)\s+(?:the\s+)?\S+[\s,;]*(?:(?:website|site|homepage|home page)\s*)?(?:and\s+|then\s+)?/i, "").trim() || String(meta.goal)
      : meta.goal || "";
    // The server is stateless: a follow-up ("continue the story") only makes sense with what it continues.
    const followNote = meta.followUp && meta.context && meta.context.lastGoal ? ` (this continues the earlier request: "${String(meta.context.lastGoal).slice(0, 160)}"${meta.context.browser && meta.context.browser.title ? `, on the page "${String(meta.context.browser.title).slice(0, 60)}"` : ""})` : "";
    const payload = {
      mode: "agent",
      goal: goalForServer + followNote,
      detail_level: "full",
      session_id: meta.taskId || "noah",
      observation: {
        url: obs.url,
        browser: { url: obs.url, title: obs.title, loading: !!obs.loading },
        tabs: (obs.tabs || []).map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })),
        page: {
          pageText: (obs.pageText?.viewport || "").slice(0, 3000),
          buttons: els.filter((e) => /button|menuitem|tab/.test(e.role)).slice(0, 40).map((e) => ({ text: e.name, selector: refSelector(e.ref), visible: true, enabled: !e.states?.disabled })),
          inputs: els.filter((e) => /textbox|searchbox|combobox|checkbox|radio|switch/.test(e.role)).slice(0, 30).map((e) => ({ type: e.role, placeholder: e.name, name: e.name, selector: refSelector(e.ref) })),
          links: els.filter((e) => e.role === "link").slice(0, 40).map((e) => ({ text: e.name, href: e.href, selector: refSelector(e.ref) })),
        },
      },
      // The server only knows what we send it. Give it the outcome of each recent action in its own vocabulary, plus the
      // verification lines and warnings from the last step (URL changed? nothing happened?), so it can tell progress from a loop.
      memory: {
        sessionId: meta.taskId || "noah",
        recentActions: [
          ...(meta.recentActions || []).slice(-6).map(entryToLegacy),
          ...(meta.feedback || []).slice(-3).map((f) => ({ action: "note", args: {}, result: { success: true, message: String(f).slice(0, 300) } })),
        ],
        history: [obs.url].filter(Boolean),
        task: { currentTask: meta.goal },
      },
    };
    let json;
    try {
      json = await this.postJson(this.baseURL, this.getKey() ? { authorization: `Bearer ${this.getKey()}` } : {}, payload, { signal: req.signal, timeoutMs: req.timeoutMs || 120_000 });
    } catch (err) {
      this._account(null, false);
      throw err;
    }
    const parsed = typeof json === "string" ? extractJson(json) : json;
    if (process.env.NOAH_DEBUG_LEGACY) {
      const o = payload.observation;
      console.log("[legacy] >", JSON.stringify({ goal: payload.goal, url: o.url, text: (o.page.pageText || "").slice(0, 220), buttons: o.page.buttons.length, inputs: o.page.inputs.map((i) => i.name + "=" + i.selector), links: o.page.links.length, recent: payload.memory.recentActions.slice(-3) }));
      console.log("[legacy] <", JSON.stringify(parsed).slice(0, 400));
    }
    if (!parsed) throw new ProviderError("legacy Rexy server returned an unreadable response", { code: "unknown", provider: this.name });
    const actions = [];
    const dropped = [];
    for (const a of Array.isArray(parsed.actions) ? parsed.actions : []) {
      const t = a.type || a.action;
      if (DROPPED.has(t)) {
        dropped.push(t);
        continue;
      }
      const m = translateAction(a, els);
      if (m) actions.push(m);
    }
    // The legacy vocabulary has no "clear" or "submit": its `type` means "fill this field", and it issues a separate
    // pressKey/click to submit, which this small model often forgets (it re-typed the same text 8 times, appending
    // each time). Give `type` fill semantics, and submit search-like boxes that nothing else in the batch submits.
    const notes = [];
    // A navigate to the page we are already on only reloads it and invalidates every ref in the rest of the batch.
    const here = String(obs.url || "").replace(/\/+$/, "");
    while (actions.length > 1 && actions[0].action === "navigate" && String(actions[0].url || "").replace(/\/+$/, "") === here) {
      actions.shift();
      notes.push("dropped a redundant navigate to the current page");
    }
    // This model never says "complete" on a reading task: once it is on the right page it keeps proposing the same
    // navigation. Treat "navigate to where I already am" (or the same proposal repeated) as "I think I am there" and
    // ask its chat mode to answer the goal from the page text - the one thing it does reliably.
    const norm = (u) => String(u || "").replace(/\/+$/, "");
    const sig = JSON.stringify(actions.map((a) => [a.action, a.url || a.target?.ref || a.target?.text || "", a.text || ""]));
    const seen = (this._proposals ||= new Map());
    const key = meta.taskId || "noah";
    const prior = seen.get(key) || { sig: "", n: 0 };
    const n = prior.sig === sig ? prior.n + 1 : 1;
    seen.set(key, { sig, n });
    if (seen.size > 20) seen.delete(seen.keys().next().value);
    const alreadyThere = actions.length === 1 && actions[0].action === "navigate" && norm(actions[0].url) === norm(obs.url);
    // "n >= 3" must mean the same NAVIGATION was proposed three times ("I think I've arrived, nothing more to do") - not
    // any repeated action. A `type`/`click` proposed identically three times in a row is not evidence of completion; it
    // is usually evidence of being STUCK (blocked on a confirmation the user has not answered yet, or failing silently).
    // Reported bug: a form-filling task's email field needed confirmation, the confirmation was not answered in time,
    // the model re-proposed the same `type` action, and this heuristic declared the WHOLE task "done" after two actions,
    // having filled in nothing and submitted nothing. A repeated non-navigate action now falls through to the normal
    // failure/recovery path instead (bounded retries, then an honest give-up), never a false "done".
    const repeatedNavigate = n >= 3 && actions.length && actions.every((a) => a.action === "navigate");
    // Reported bug: "go to this form and answer all the questions ... submit it" reached the form, the model then
    // redundantly proposed navigating to the SAME page again, and that alone ("already there") was read as "the whole
    // goal is complete" - "Done. You are on Customer Feedback." - having filled in and submitted nothing. A goal that
    // asks for something to be DONE on the page is never finished by navigation alone.
    if ((alreadyThere || repeatedNavigate) && (meta.recentActions || []).length >= 2 && !parsed.complete && !goalNeedsPageAction(meta.goal)) {
      // An action goal ("open X and search for Y") is finished when the actions are done: there is nothing to answer.
      // Only a question about the page ("what is the cheapest...", "tell me...", "list...") needs an answer from its text.
      const needsAnswer = goalNeedsAnswer(meta.goal);
      if (!needsAnswer) return local("noah_step", { status: "done", summary: "Reached the requested page", result: `Done. You are on ${obs.title || obs.url}.` });
      const content = String(obs.pageText?.content || obs.pageText?.viewport || "").slice(0, 8000);
      let answer = "";
      this._remote = (this._remote || 0) + 1;
      try {
        const r = await this.postJson(this.baseURL, {}, { mode: "chat", session_id: `${key}-answer`, url: obs.url, page_content: content, message: goalCompares(meta.goal) ? `${questionFrom(meta.goal)}\nOnly consider items on the page that satisfy every condition above, and compare the numbers carefully. Answer briefly.` : `${questionFrom(meta.goal)}\nAnswer briefly from the page.` }, { signal: req.signal, timeoutMs: 60_000 });
        answer = String((typeof r === "string" ? extractJson(r) : r)?.answer || "").replace(/^ANSWER:\s*/i, "").trim();
      } catch (_) {
        /* fall through to the normal path */
      }
      // The chat mode answers "I couldn't find a matching command" / "Opening the link" / a generic "I'm sorry, I don't
      // have a page attached" when it mistakes the request for a command or loses track of context. That is a refusal,
      // not an answer: never report it as a completed task (the same check the main agent-mode path uses).
      const echoedInstruction = /only consider items on the page|answer briefly from the page|satisfy every condition above/i.test(answer);
      const refusal = echoedInstruction || looksLikeRefusalOrChat(answer);
      if (answer && !refusal) return local("noah_step", { status: "done", summary: "Answered from the page", result: answer });
      if (answer && refusal) return local("noah_step", { status: "give_up", summary: "The model could not answer this from the page." });
    }
    // This model invents URLs from link text (`/Laptops` for a link called "Laptops" that really goes to /search?q=laptop),
    // which 404s and loops. When a navigate target is not the page itself but its last path segment names a link on the
    // page, click that link instead.
    const linkEls = els.filter((e) => e.role === "link");
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (a.action !== "navigate" || !a.url || originOf(a.url) !== originOf(obs.url)) continue;
      if (linkEls.some((l) => l.href && originOf(new URL(l.href, obs.url).href) === originOf(a.url) && new URL(l.href, obs.url).href.replace(/\/+$/, "") === a.url.replace(/\/+$/, ""))) continue; // a real link target
      let seg = "";
      try {
        seg = decodeURIComponent(new URL(a.url).pathname.split("/").filter(Boolean).pop() || "");
      } catch (_) {
        /* ignore */
      }
      const hit = seg && linkEls.find((l) => slug(l.name) === slug(seg));
      if (hit) {
        actions[i] = { action: "click", target: { ref: hit.ref } };
        notes.push(`turned a guessed URL (${seg}) into a click on the "${hit.name}" link`);
      }
    }
    // The model re-proposing text that was already typed is the loop ("Typing into the textbox" x N): drop it.
    let repeatedType = false;
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i].action === "type" && alreadyTyped(actions[i].text, recent)) {
        repeatedType = true;
        notes.push("dropped a repeat: that text was already typed");
        actions.splice(i, 1);
      }
    }
    if (repeatedType && !actions.length && !parsed.complete) {
      // "Done" only if the text is really on the page. Claiming success when nothing showed up (typed into a field that is
      // not the editor, or an editor that ignores synthetic keys) is worse than an honest failure.
      const shown = typedTextShown(recent, obs, els);
      // Reported bug: a multi-question form goal ("answer all the questions ... submit it, my name is X, email is Y")
      // had its FIRST field (email) filled in, and that alone - "this exact text won't need typing twice" - was read as
      // "the whole goal is done". One field being filled is not a multi-step goal being finished: scroll on to whatever
      // else the goal asked for instead of declaring victory after the first successful action.
      if (shown && looksLikeFormTask(meta.goal)) {
        notes.push("that field is filled in - it is only ONE part of the task; scroll down and answer/fill in/check whatever else the goal asked for, and only say status=done once everything is actually finished and (if asked) submitted");
        return local("noah_step", { status: "continue", summary: "Moving on to the rest of the page", actions: [{ action: "scroll", direction: "down", amount: 400 }], notes });
      }
      if (shown) {
        // This guard fires for both "wrote the text into a document" (compose.cjs) and "typed a query into a search box and
        // the model kept re-proposing the same search" (this run). A generic "Typed the text once." told the user nothing
        // in the second case; say what was typed and where it actually ended up, so the result is meaningful either way.
        const lastTyped = [...recent].reverse().find((e) => e.ok !== false && /^type\b/.test(String(e.text || "")));
        const q = lastTyped && (/"([^"]*)"/.exec(String(lastTyped.text || "")) || [])[1];
        const clean = q && !/(?:…|\.\.\.)\[\d+ chars\]$/.test(q) ? q : null;
        const result = clean ? `Typed "${clean}" and reached "${obs.title || obs.url}".` : `Reached "${obs.title || obs.url}" after typing.`;
        return local("noah_step", { status: "done", summary: "Finished typing", result });
      }
      return local("noah_step", { status: "give_up", summary: "I typed the text, but I cannot see it on the page, so I cannot tell you it worked. Click into the editor yourself and ask me again." });
    }
    // Noah decides by itself: a question the person does not need to answer (which one? what now?) is dropped, and the
    // page is simply looked at again. Only sign-in / password / CAPTCHA / payment questions reach the user.
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i].action === "ask_user" && !needsHuman(actions[i].question, obs)) {
        notes.push("did not ask the user: Noah decides this itself");
        actions.splice(i, 1);
      }
    }
    // "Act like a person": drop URL jumps inside the site (this model guesses watch/category/search URLs). If that leaves
    // nothing, look around the page instead of teleporting.
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i].action === "navigate" && humanNavigationBlock({ url: actions[i].url, goal: meta.goal, currentUrl: obs.url, elements: els })) {
        notes.push("dropped a jump to a guessed URL inside the site");
        actions.splice(i, 1);
      }
    }
    if (!actions.length && !parsed.complete) actions.push({ action: "scroll", direction: "down", amount: 450 });
    actions.forEach((a, i) => {
      if (a.action !== "type" || !a.target) return;
      a.clear = true;
      const el = a.target.ref ? els.find((e) => e.ref === a.target.ref) : null;
      const searchy = el && (el.role === "searchbox" || /search|query|find/i.test(el.name || ""));
      const next = actions[i + 1];
      if (searchy && !next) {
        a.submit = true;
        notes.push("auto-submitted the search box (the model did not press Enter)");
      }
    });
    // ACTION SUCCESS != TASK SUCCESS: the model saying `complete: true` is not evidence that anything was accomplished
    // (it once reported a task "done" with a chat-style refusal as the result, having taken zero actions). Only accept a
    // self-reported completion when SOMETHING has actually and successfully happened for this task, and the model's own
    // explanation is not itself a refusal or generic chat reply.
    const everActed = (meta.recentActions || []).some((r) => r && r.ok !== false);
    const completionVerdict = parsed.complete ? verifyCompletion({ reason: parsed.reason, tookAction: actions.length > 0, everActedThisTask: everActed }) : null;
    const complete = !!parsed.complete && completionVerdict.trusted;
    const args = complete
      ? { status: "done", summary: parsed.reason || "Done", result: parsed.reason || "Goal completed." }
      : actions.length
      ? { status: actions.some((x) => x.action === "ask_user") ? "ask_user" : "continue", summary: parsed.reason || "Working", actions: actions.filter((x) => x.action !== "ask_user" || actions.length === 1) }
      : {
          status: "give_up",
          summary:
            parsed.complete && !completionVerdict.trusted
              ? `I have not actually made progress on this yet (${completionVerdict.why}). Please rephrase what you would like me to do, or tell me exactly where to click/type.`
              : parsed.reason || "The legacy model returned no actions.",
        };
    if (args.status === "ask_user") args.summary = actions.find((x) => x.action === "ask_user")?.question || args.summary;
    if (parsed.complete && !completionVerdict.trusted) notes.push(`ignored an unverified "done" claim from the model (${completionVerdict.why})`);
    if (dropped.length) notes.push(`ignored unsafe legacy actions: ${dropped.join(", ")}`);
    if (notes.length) args.notes = notes;
    const usage = { inputTokens: Math.ceil(JSON.stringify(payload).length / 4), outputTokens: 50 };
    this._account(usage);
    return { text: "", toolCalls: [{ id: "legacy", name: "noah_step", args }], usage, stopReason: "stop", latencyMs: Date.now() - t0, model: "rexy-render" };
  }
}

module.exports = { RexyLegacyProvider, translateAction, questionFrom, searchIntentFrom, goalNeedsAnswer, goalNeedsPageAction };
