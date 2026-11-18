// noah-host.js - what Electron Jonah's browser window did for the Noah panel (ai-panel.html), for Jonah on Chromium.
//
// In Electron the panel lived in an <iframe> and talked to the window around it with window.parent.postMessage. In Chromium the
// panel is the side panel page itself, so window.parent IS this page: the panel's requests arrive here, and the answers are posted
// back the same way the Electron window posted them, so ai-panel.html's own code is unchanged.
//
// Ported now:   chat (the same Noah server Electron Jonah uses: www.noahai.live/predict, mode "chat"), questions about the open
//               page (its text is read only when the message asks about the page), opening links, closing the panel.
// Agents:       the web agent (Noah in Jonah's tabs, noah-boot.js) and the computer agent (Noah on this computer's apps and in folders
//               you pick: Electron's mission code in the noah-native folder next to Jonah, reached through noah-computer.js).
// Not yet:      voice / wake word, file attachments, administrator access. The panel says so plainly instead of pretending.
(function () {
  "use strict";
  const ENDPOINT = "https://www.noahai.live/predict";
  const SESSION_KEY = "jonah-noah-session";
  // A message that asks Noah to DO something in the browser (Auto mode); questions stay chat.
  const BROWSER_TASK = /^(?:please\s+|can you\s+|could you\s+|noah[,:]?\s+)*(?:open|go to|navigate|search (?:for|on)|look up|find (?:me )?(?:a|the|cheap)|fill|book|buy|order|add .+ to (?:my )?(?:cart|basket)|sign up|log ?in to|click|scroll|play|download|compare prices|check out|subscribe)\b/i;
  let noahLoading = null;
  // Loads Noah's agent (noah-builtins.js, noah-bundle.js = Electron Jonah's Noah/ code, noah-boot.js) the first time it is needed.
  function ensureNoah() {
    if (window.JonahNoah) return Promise.resolve(window.JonahNoah);
    if (!noahLoading) {
      noahLoading = ["js/jonah-account.js", "js/noah-builtins.js", "js/noah-bundle.js", "js/noah-boot.js"].reduce((p, src) => p.then(() => new Promise((res, rej) => {
        const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("could not load " + src)); document.head.appendChild(s);
      })), Promise.resolve()).then(() => window.JonahNoahReady);
      noahLoading.catch(() => { noahLoading = null; });
    }
    return noahLoading;
  }
  window.jonahEnsureNoah = ensureNoah;
  // Auto mode: a message that MIGHT be a job on this computer's apps or on a project is shown to the computer agent first; Electron's own
  // CommandRouter there (agent/intent.cjs) makes the real decision and hands back anything that is not its job.
  const DESKTOP_HINT = /\b(?:notepad|wordpad|excel|word|powerpoint|outlook|onenote|calculator|paint|file explorer|explorer|task manager|control panel|settings|vs ?code|visual studio|blender|davinci|obs|spotify|discord|steam|desktop|my (?:pc|computer|laptop)|this (?:pc|computer)|on my (?:pc|computer|laptop)|windows|apps?|application|program|folders?|files?|documents|downloads)\b/i;
  const PROJECT_HINT = /\b(?:code|coding|repo|repository|project|script|bug|tests?|npm|python|node\.?js|git|compile|build|refactor|function|class)\b/i;
  // Electron attachments.cjs referencesAttachment(): the message is about what the user attached
  const REFERS_TO_ATTACHMENT = /\b(attach(?:ed|ment|ments)?|upload(?:ed)?|this (?:file|document|doc|pdf|sheet|spreadsheet|presentation|deck|slide|slides|image|picture|photo|screenshot)|the (?:file|document|pdf|spreadsheet|presentation|image|picture|photo|screenshot)|in (?:it|the file|the doc))\b/i;
  const computerBusy = () => !!(window.JonahComputer && window.JonahComputer.isBusy());

  function sessionId() {
    try {
      let id = localStorage.getItem(SESSION_KEY);
      if (!id) { id = "jonah-" + crypto.randomUUID(); localStorage.setItem(SESSION_KEY, id); }
      return id;
    } catch (_) {
      return "jonah-" + Date.now();
    }
  }

  const reply = (type, payload) => window.postMessage({ type, payload }, "*");

  // A message that asks about the page that is open (same idea as Noah/agent/intent.cjs looksLikePageQuestion).
  const PAGE_REF = /\b(?:this|these|the current|the open|current|that)\s+(?:page|article|site|website|web ?page|tab|document|post|blog|story|video)\b|\bwhat(?:'s| is) on (?:the |this )?(?:page|screen)\b/i;
  const PAGE_VERB = /\b(?:summari[sz]e|summary|tl;?dr|recap|sum (?:it )?up|(?:key|main) (?:points?|ideas?|takeaways?)|gist|outline|highlights|explain|describe|what(?:'s| is| are| does)|tell me about|translate|simplify|analy[sz]e|review)\b/i;
  const BARE = /^(?:please\s+|can you\s+|could you\s+)*(?:give me |write |make )?(?:a |the )?(?:quick |short |brief )*(?:summari[sz]e|summary|tl;?dr|recap|sum (?:it )?up|key points|main points)(?:\s+(?:it|this|that|for me|please))*[.!?\s]*$/i;
  const looksLikePageQuestion = (g) => g.length <= 300 && !/https?:\/\/|www\./i.test(g) && (BARE.test(g) || (PAGE_REF.test(g) && PAGE_VERB.test(g)));

  async function readActivePage() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || !/^https?:/i.test(tab.url || "")) return null;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => (document.body ? document.body.innerText : "").replace(/\s+\n/g, "\n").slice(0, 20000),
      });
      return { url: tab.url, title: tab.title || "", text: String((res && res.result) || "") };
    } catch (_) {
      return null;
    }
  }

  async function ask(payload) {
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          body: JSON.stringify(payload),
        });
        const data = await r.json().catch(() => null);
        if (r.ok && data && typeof data === "object") return data;
        lastErr = new Error("Noah's server answered HTTP " + r.status);
      } catch (err) {
        lastErr = err;
      }
      await new Promise((res) => setTimeout(res, 900 * attempt));
    }
    throw lastErr || new Error("Noah's server could not be reached");
  }

  // The chat's answer. Electron's own chat code (Rexy/llm.cjs + chat-complete.cjs + grounding.cjs, in Noah's helper) answers it: the
  // attached files or the open page as material, a web search when the question needs fresh facts, long replies completed.
  // Only if the helper cannot be reached does the panel ask the server directly (no web search, no attachments).
  async function chat(goal, attachmentIds) {
    let pageContent = null, pageNote = null, pageUrl = null;
    if (!(attachmentIds && attachmentIds.length) && looksLikePageQuestion(goal)) {
      const page = await readActivePage();
      if (!page) return { text: "I can only read normal web pages (http/https). Open the page you mean in the current tab and ask again." };
      if (page.text.length < 60) return { text: "I could not find readable text on this page" + (page.title ? ` ("${page.title.slice(0, 80)}")` : "") + ". It may still be loading, or it is mostly video or images." };
      const cut = page.text.length > 18000;
      pageUrl = page.url;
      pageContent = `Page title: ${page.title}\nPage address: ${page.url}\n\n${page.text.slice(0, 18000)}${cut ? "\n\n[the rest of the page was cut]" : ""}`;
      pageNote = `(Answer using ONLY the open web page attached as page content${cut ? "; only its first part is attached, so say so if that matters" : ""}. If the page does not contain the answer, say that.)`;
    }
    if (window.JonahComputer) {
      try {
        return await window.JonahComputer._call("chat", { goal, attachmentIds: attachmentIds || [], pageContent, pageNote, sessionId: sessionId() }, 180000);
      } catch (err) {
        if (attachmentIds && attachmentIds.length) throw err; // attached files live in the helper: nothing to fall back to
        console.warn("[noah] chat through the helper failed, asking the server directly:", err && err.message);
      }
    }
    const payload = { mode: "chat", message: goal, session_id: sessionId() };
    if (pageContent) { payload.url = pageUrl; payload.page_content = pageContent; }
    const data = await ask(payload);
    const answer = typeof data.answer === "string" ? data.answer.trim() : "";
    if (answer) return { text: answer };
    if (data.needs_web_search) return { text: "To answer that I need to search the web, and Noah's helper (which does the search) could not be started. Please try again." };
    return { text: "I don't have an answer for that." };
  }

  // The study tools (Electron main "study:ask") ask the same Noah server one question at a time.
  window.jonahNoahAsk = async function (message, pageContent) {
    const payload = { mode: "chat", message: String(message || ""), session_id: sessionId() + "-study" };
    if (pageContent) payload.page_content = String(pageContent);
    const data = await ask(payload);
    return typeof data.answer === "string" ? data.answer.trim() : "";
  };

  window.jonahClosePanel = function () {
    try {
      if (chrome.sidePanel && chrome.sidePanel.close) {
        chrome.windows.getCurrent().then((w) => chrome.sidePanel.close({ windowId: w.id })).catch(() => window.close());
        return;
      }
    } catch (_) { /* fall through */ }
    window.close();
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const d = event.data || {};
    switch (d.type) {
      case "rexy:submit-goal": {
        const goal = String(d.goal || "").trim();
        if (!goal) return;
        const mode = d.mode === "agent" ? "web" : d.mode;
        const attachmentIds = Array.isArray(d.attachmentIds) ? d.attachmentIds.filter((x) => typeof x === "string").slice(0, 20) : [];
        // ---- attached files (Electron: a message about them in Auto, or any message in Chat, is answered FROM them)
        if (attachmentIds.length && mode !== "web" && mode !== "computer" && (mode === "chat" || REFERS_TO_ATTACHMENT.test(goal) || !(BROWSER_TASK.test(goal) || DESKTOP_HINT.test(goal) || PROJECT_HINT.test(goal)))) {
          reply("rexy:goal-submitted", { success: true, kind: "chat" });
          try {
            const r = await chat(goal, attachmentIds);
            reply("rexy:goal-completed", { reason: r.text, attachmentUse: r.attachmentUse });
          } catch (err) {
            reply("rexy:goal-error", { error: "I could not answer from the attached files (" + (err && err.message ? err.message : "error") + "). Please try again." });
          }
          return;
        }
        // ---- the computer agent: Computer mode, an answer/stop for a running computer task, or (Auto) something that may be its job
        if (mode === "computer" || (mode !== "chat" && mode !== "web" && (computerBusy() || DESKTOP_HINT.test(goal) || PROJECT_HINT.test(goal)))) {
          try {
            if (window.JonahAccount === undefined) await ensureNoah().catch(() => null); // the account signs the helper's model requests
            const r = await window.JonahComputer.route(goal, { mode: mode === "computer" ? "computer" : "auto", source: "text" });
            if (r && r.handled) {
              if (r.kind === "mission") reply("rexy:goal-submitted", { success: true, kind: "agent" });
              else { reply("rexy:goal-submitted", { success: true, kind: "chat" }); if (r.reply) reply("rexy:goal-completed", { reason: r.reply }); }
              return;
            }
            if (mode === "computer") { reply("rexy:goal-submitted", { success: false, error: "The computer agent could not take that task." }); return; }
            // not a computer or project task: the web agent or chat below
          } catch (err) {
            if (mode === "computer") {
              reply("rexy:goal-submitted", { success: false, error: "Noah's computer agent could not start (" + (err && err.message ? err.message : err) + ")." });
              return;
            }
          }
        }
        if (mode === "web" || (mode !== "chat" && BROWSER_TASK.test(goal) && !looksLikePageQuestion(goal))) {
          try {
            const noah = await ensureNoah();
            if (!noah.agent.isAvailable()) { reply("rexy:goal-submitted", { success: false, error: "Noah's web agent has no model to work with right now. Please try again in a moment." }); return; }
            noah.agent.submit(goal, { source: "ui" });
            reply("rexy:goal-submitted", { success: true, kind: "agent" });
          } catch (err) {
            reply("rexy:goal-submitted", { success: false, error: "Noah's web agent could not start (" + (err && err.message ? err.message : err) + ")." });
          }
          return;
        }
        reply("rexy:goal-submitted", { success: true, kind: "chat" });
        try {
          const r = await chat(goal);
          reply("rexy:goal-completed", { reason: r.text });
        } catch (err) {
          reply("rexy:goal-error", { error: "I could not reach Noah's server (" + (err && err.message ? err.message : "network error") + "). Please try again." });
        }
        return;
      }
      case "noah:open-url":
        if (/^https?:\/\//i.test(String(d.url || ""))) chrome.tabs.create({ url: d.url });
        return;
      // (noah:wake / noah:wake-get are answered by Electron's voice orb, js/voice-orb.js, which runs in this panel)
      // ---- attaching files: read by Electron's file-extract.cjs in Noah's helper; the panel gets back an id and a summary
      case "noah:attach-file": {
        const reqId = String(d.reqId || "").slice(0, 40);
        const done = (result) => reply("noah:attach-result", { reqId, result });
        if (!(d.data instanceof ArrayBuffer)) { done({ ok: false, error: "The file was not received." }); return; }
        if (d.data.byteLength > 30 * 1024 * 1024) { done({ ok: false, code: "too_big", error: "This file is larger than 30 MB." }); return; }
        if (!window.JonahComputer) { done({ ok: false, error: "Noah's helper is not available in this build." }); return; }
        const bytes = new Uint8Array(d.data);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        window.JonahComputer._call("attach", { name: String(d.name || "file"), data: btoa(bin) }, 180000)
          .then(done, (err) => done({ ok: false, error: "Could not read this file: " + (err && err.message ? err.message : err) }));
        return;
      }
      case "noah:attach-remove":
        if (window.JonahComputer && typeof d.id === "string") window.JonahComputer._call("attachRemove", { id: d.id }).catch(() => {});
        return;
      case "noah:attach-clear":
        if (window.JonahComputer && window.JonahComputer.connected()) window.JonahComputer._call("attachClear", {}).catch(() => {});
        return;
      case "noah:cmd": {
        // Administrator access (Windows): only Noah's computer helper is elevated, never the browser (noah-computer.js)
        if (d.cmd === "admin-get" || d.cmd === "admin-set") {
          const C0 = window.JonahComputer;
          if (!C0) { reply("noah:admin-state", { supported: false }); return; }
          (d.cmd === "admin-set" ? C0.adminSet(d.enabled === true) : C0.adminGet()).then((st) => reply("noah:admin-state", st)).catch(() => reply("noah:admin-state", { supported: false }));
          return;
        }
        // the computer agent gets Stop / Pause / Continue / confirmation answers / settings too (Electron ipc.cjs: a running mission first)
        const C = window.JonahComputer;
        if (C && C.connected()) {
          if (d.cmd === "stop") C.stop();
          else if (d.cmd === "pause") C.pause();
          else if (d.cmd === "resume") C.resume();
          else if (d.cmd === "confirm") C.confirm(d.id, d.allow === true);
          else if (d.cmd === "config") C.config(d.patch || {});
        }
        // the agent's controls; Noah's code is only loaded once it has been used (keeps the panel light)
        const n = window.JonahNoah;
        if (!n) { if (d.cmd === "config") ensureNoah().then((x) => { x.config.update(d.patch || {}); reply("noah:config", x.config.publicView()); }).catch(() => {}); return; }
        try {
          if (d.cmd === "stop") n.agent.stop("user_button");
          else if (d.cmd === "pause") n.agent.pause();
          else if (d.cmd === "resume") n.agent.resume();
          else if (d.cmd === "confirm") n.core.safety.resolveConfirmation(String(d.id), d.allow === true);
          else if (d.cmd === "config") { n.config.update(d.patch || {}); reply("noah:config", n.config.publicView()); }
          else if (d.cmd === "get-config") reply("noah:config", n.config.publicView());
          else if (d.cmd === "get-state") { const st = n.agent.state(); if (st && st.session) reply("noah:event", Object.assign({ event: "session_state" }, st.session)); }
        } catch (err) { console.warn("[noah] command failed:", d.cmd, err); }
        return;
      }
      default: // billing:* (plans and Jonah sign-in come with the Jonah account work), noah:typing, noah:attach-clear, ...
        return;
    }
  });
})();

// Test switch: noah.html#agent=<task> starts that task on the most recent web tab and logs every agent event to the console
// (Jonah's own pages only - websites cannot open this page). Used to test the web agent without clicking on the screen.
(function () {
  "use strict";
  const m = /^#agent=([^&]+)(?:&url=(.+))?$/.exec(location.hash);
  if (!m) return;
  const goal = decodeURIComponent(m[1]);
  const startUrl = m[2] ? decodeURIComponent(m[2]) : "";
  window.addEventListener("message", (e) => { if (e.source === window && e.data && e.data.type === "noah:event") console.log("[noah:event]", JSON.stringify(e.data.payload).slice(0, 600)); });
  window.addEventListener("message", (e) => { if (e.source === window && e.data && /^rexy:goal-/.test(e.data.type || "")) console.log("[noah:reply]", e.data.type, JSON.stringify(e.data.payload).slice(0, 300)); });
  setTimeout(async () => {
    if (/^https?:\/\//.test(startUrl)) { await chrome.tabs.create({ url: startUrl, active: true }); await new Promise((r) => setTimeout(r, 6000)); }
    const tabs = await chrome.tabs.query({});
    const web = tabs.filter((t) => /^https?:/.test(t.url || t.pendingUrl || "")).sort((a, b) => b.id - a.id)[0];
    if (web) await chrome.tabs.update(web.id, { active: true });
    console.log("[noah:test] starting:", goal, "on tab", web && web.url);
    window.postMessage({ type: "rexy:submit-goal", goal, mode: "web" }, "*");
  }, 2500);
})();
