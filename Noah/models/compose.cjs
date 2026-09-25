// Noah/models/compose.cjs
//
// "Type a story about Jurassic World on this notepad": writing goals. The text has to come from somewhere, and a weak
// step-by-step model cannot produce it in an action (it typed a truncated copy of its own log line, "The Jurassic…[25 chars]",
// over and over). So the request is turned into text ONCE by the model's chat mode, then typed into the page's editor
// ONCE, key by key, and the task is finished.

"use strict";

const WRITE_VERB = /\b(type|write|compose|draft|start (?:typing|writing)|put (?:down|in))\b/i;
const WRITE_OBJECT = /\b(story|essay|poem|paragraphs?|article|context|letter|notes?|summary|content|text|song|lyrics|script|blog|about|program|programme|code|snippet|function|algorithm)\b/i;
const EDITOR_HINT = /\b(note ?pad|notes?|document|doc|editor|text ?box|text ?area|page|ide|compiler|playground|sandbox|snippet)\b/i;
const codeCompose = require("./code-compose.cjs");
const SEARCHY = /\b(search(?:\s+for)?|look\s+for|shop\s+for|browse\s+for)\b/i;

/** A goal that asks Noah to WRITE something into an editor (as opposed to searching, or typing one short literal). */
function composeIntentFrom(goal) {
  const g = String(goal || "");
  if (!WRITE_VERB.test(g) || !WRITE_OBJECT.test(g) || SEARCHY.test(g)) return null;
  if (!EDITOR_HINT.test(g) && !/\b(story|essay|poem|paragraphs?|article|letter|lyrics|script|blog)\b/i.test(g)) return null;
  const request = g.replace(/^\s*noah\s*[,:]\s*/i, "").replace(/\s+/g, " ").trim().slice(0, 600);
  return { request, code: codeCompose.isCodeRequest(request) };
}

const CONTINUES = /\b(continue|keep (?:going|writing|typing)|go on|carry on|next|another|more|rest|finish|extend|expand|lengthen|longer)\b/i;
const CONTINUE_OBJECT = /\b(story|paragraphs?|sentences?|essay|poem|letter|article|lyrics|script|text|writing|chapter|part|it|notepad|note ?pad|page|there)\b/i;

/**
 * "Continue writing the story" / "write the next paragraph on the notepad": no topic of its own, so it carries on the
 * writing the session already did. `context` is AgentSession.contextFor(): the previous goals and the text Noah last wrote.
 * @returns {null | { request: string, instruction: string, continuation: true, existing: string }}
 */
function continuationIntentFrom(goal, context) {
  if (!context) return null;
  const g = String(goal || "");
  if (!CONTINUES.test(g) || SEARCHY.test(g) || !(CONTINUE_OBJECT.test(g) || WRITE_VERB.test(g))) return null;
  const writing = (context.previousGoals || []).filter((p) => composeIntentFrom(p));
  // the goal that named the subject ("...dinosaur story"), not an earlier "continue" that had none of its own
  const base = [...writing].reverse().find((p) => !CONTINUES.test(p)) || writing[writing.length - 1] || "";
  const existing = String(context.lastWritten || "");
  if (!base && !existing) return null;
  const baseIntent = base ? composeIntentFrom(base) : null;
  return { request: baseIntent ? baseIntent.request : "", code: !!(baseIntent && baseIntent.code), instruction: g.replace(/\s+/g, " ").trim().slice(0, 300), continuation: true, existing };
}

/** The big multi-line text area of the page: the largest textbox that is not a search/password field. */
function pickEditor(els) {
  let best = null;
  let bestArea = 0;
  for (const e of els || []) {
    if (!e.ref || !e.rect || e.role === "searchbox" || e.role === "combobox") continue;
    if (e.role !== "textbox" && e.role !== "document") continue;
    if (/password|search|buscar/i.test(e.name || "")) continue;
    const area = e.rect.width * e.rect.height;
    if (area >= 20000 && area > bestArea) {
      best = e;
      bestArea = area;
    }
  }
  return best;
}

/** What the chat model returned -> just the text to type (no "Sure, here is...", quotes, markdown or sign-off). */
function cleanGenerated(raw) {
  let t = String(raw || "").replace(/\r/g, "").trim();
  t = t.replace(/^(?:sure|certainly|of course|okay|ok|absolutely)[^\n]*\n+/i, "");
  t = t.replace(/^(?:here(?:'s| is| are)[^\n]*:)\s*\n+/i, "");
  t = t.replace(/\n+\s*(?:let me know|i hope|feel free|would you like|is there anything)[^\n]*$/i, "");
  t = t.replace(/\*\*|__|^#{1,6}\s+/gm, "");
  t = t.replace(/^["“”']+|["“”']+$/g, "").trim();
  return dedupeAndCap(t).slice(0, 2500);
}

/**
 * Small models loop ("The dinosaur spoke in the words of the notepad, and it was a story..." x30). Keep each sentence
 * once and stop at a sentence boundary around ~260 words, so what gets typed reads like a story.
 */
function dedupeAndCap(text, maxWords = 260) {
  const seen = new Set();
  const out = [];
  let words = 0;
  for (const para of String(text).split(/\n{2,}|\n/)) {
    const kept = [];
    for (const sentence of para.match(/[^.!?]+[.!?]+["”']?|[^.!?]+$/g) || []) {
      const key = sentence.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const n = key.split(" ").length;
      if (words + n > maxWords && words > 0) return [...out, kept.join("").trim()].filter(Boolean).join("\n\n");
      kept.push(sentence);
      words += n;
    }
    if (kept.length) out.push(kept.join("").trim());
  }
  return out.join("\n\n");
}

const KIND = /\b(story|poem|essay|letter|article|blog|lyrics|script|paragraphs?|summary|song)\b/i;
/** "...write a story about the Jurassic word on this note pad..." -> "Jurassic word" */
function topicFrom(request) {
  const m = /\babout\s+(?:the\s+|a\s+|an\s+)?(.+?)(?=\s+(?:on|in|at|inside|into|using|okay|ok|you|and|please|can|so|for me)\b|[.,;!?]|$)/i.exec(String(request || ""));
  // dictation/typing slip: "the Jurassic word" is "Jurassic World" (a capitalised name followed by "word")
  return m ? m[1].trim().slice(0, 80).replace(/\b([A-Z][a-z]+)\s+word$/, "$1 World") : "";
}
const NAV = /https?:\/\/\S+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|app|dev|ai|in)\b|\b(?:open|go to|visit|launch)\s+\S+\s+and\b|^\s*noah\b[,:]?|\b(?:do me a favou?r|okay|ok|please|can you|you can|just)\b/gi;

/**
 * The prompts for the text, best first. They never mention the page, the site or opening anything: the hosted chat
 * mode answers such messages as commands ("Opening the link") or echoes them back, which is exactly what got typed.
 */
function promptsFor(request) {
  const kind = ((KIND.exec(request) || [])[1] || "text").toLowerCase().replace(/s$/, "");
  const topic = topicFrom(request);
  const plain = `Reply with only the ${kind} itself: plain paragraphs, no title, no introduction, no quotation marks, no markdown.`;
  const cleaned = String(request || "").replace(NAV, " ").replace(/\s+/g, " ").trim();
  const subject = topic ? `about ${topic}` : cleaned ? `for this request: ${cleaned}` : "on any interesting subject";
  return [`Write a ${kind} of about 150 words ${subject}. ${plain}`, `Please write a short ${kind}, around 120 words, ${subject}. ${plain}`];
}

/**
 * The requests for the NEXT paragraph, best first: [{ message, page }]. The story so far goes in as the PAGE the chat mode
 * reads (`page_content`), never quoted inside the message: the hosted chat mode answers a message that carries a long quoted
 * passage with {"needs_web_search": true} (it takes the passage for a search query), which used to make every follow-up fail.
 * Measured against the live endpoint: 16/16 usable answers with the story as the page, 0/4 with it quoted in the message.
 * Messages start with "Write" (the chat mode answers "Continue ..." as a command).
 */
function continuationPromptsFor({ request, existing }) {
  const kind = ((KIND.exec(request) || [])[1] || "story").toLowerCase().replace(/s$/, "");
  const topic = topicFrom(request);
  const cleaned = String(request || "").replace(NAV, " ").replace(/\s+/g, " ").trim();
  const subject = topic ? `about ${topic}` : cleaned ? `for this request: ${cleaned}` : "";
  const plain = "Reply with only the new paragraph: plain text, no title, no introduction, no quotation marks, no markdown.";
  const so_far = String(existing || "").trim().slice(-1500).replace(/^\S*\s/, "");
  return so_far
    ? [
        { message: `Write the next paragraph (about 100 words) of the ${kind} on this page. ${plain}`, page: so_far },
        { message: `Write the next paragraph (about 100 words) of this ${kind}. ${plain}`, page: `${kind[0].toUpperCase()}${kind.slice(1)} so far: ${so_far}` },
      ]
    : [{ message: `Write a new paragraph of about 100 words for a ${kind} ${subject || "on any interesting subject"}. ${plain}` }];
}

/** Does most of `text` already appear in `existing` (a model that answers "continue" by repeating what is there)? */
function repeatsExisting(text, existing) {
  const grams = (t) => {
    const w = String(t || "").toLowerCase().match(/[a-z0-9']+/g) || [];
    const out = new Set();
    for (let i = 0; i + 4 <= w.length; i++) out.add(w.slice(i, i + 4).join(" "));
    return out;
  };
  const a = grams(text);
  if (!a.size) return false;
  const b = grams(existing);
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / a.size > 0.5;
}

/** Did the "generated" text just repeat the request (or come back too short to be what was asked for)? */
function looksWrong(text, request, minWords = 25) {
  const words = (t) => String(t || "").toLowerCase().match(/[a-z0-9']+/g) || [];
  const w = words(text);
  if (w.length < minWords) return true;
  const r = new Set(words(request));
  const shared = w.filter((x) => r.has(x)).length;
  return w.length < 80 && shared / w.length > 0.7;
}

class Composer {
  constructor() {
    this._s = new Map();
  }

  /**
   * @param {object} c { taskId, goal, obs, els, recent:[{text,ok}], generate: async (prompt) => string }
   * @returns {Promise<null | { status, summary, method?, actions?, result? }>} null = not a writing goal / give the task back
   */
  async next({ taskId, goal, obs, els, recent, generate, context }) {
    if (!/^https?:/i.test(obs.url || "")) return null;
    const intent = continuationIntentFrom(goal, context) || composeIntentFrom(goal);
    if (!intent) return null;
    let st = this._s.get(taskId);
    if (!st) {
      st = { text: "", emitted: false, tries: 0, gen: 0, waits: 0, retypes: 0, dead: false };
      this._s.set(taskId, st);
      if (this._s.size > 20) this._s.delete(this._s.keys().next().value);
    }
    if (st.dead) return null;

    // 1) what happened to the typing we asked for?
    if (st.emitted) {
      const last = recent[recent.length - 1];
      if (last && last.ok !== false && /^type\b/.test(String(last.text || ""))) {
        // Some editors (JustNotepad) initialise a moment after load and wipe what was typed before that: look before
        // saying "done". The field shows the text (value, or page text for contenteditable) or it is empty again.
        const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
        const ed = pickEditor(els);
        const shown = norm((ed && ed.value) || "") + " " + norm(obs.pageText && (obs.pageText.viewport || obs.pageText.content));
        if (st.code) {
          // Code editors show only the lines around the caret (the END of what was inserted), so look for the first or the last line.
          const codeLines = st.text.split("\n").map((l) => norm(l)).filter((l) => l.length >= 4);
          const probes = [codeLines[0], codeLines[codeLines.length - 1]].filter(Boolean).map((l) => l.slice(0, 24));
          const seen = probes.some((p) => shown.includes(p));
          st.dead = true;
          const n = st.text.split("\n").filter((l) => l.trim()).length;
          return { status: "done", summary: "Finished writing", result: seen ? `Wrote ${n} lines of ${st.language} code into the editor.` : `I put ${n} lines of ${st.language} code into the editor, but I could not read it back to confirm it is there. Please check the editor.` };
        }
        const prefix = norm(st.text).slice(0, 25);
        const visible = norm((ed && ed.value) || "").includes(prefix) || norm(obs.pageText && (obs.pageText.viewport || obs.pageText.content)).includes(prefix);
        const emptyAgain = !!ed && !ed.value;
        if (!visible && emptyAgain && st.retypes < 1) {
          st.retypes++;
          st.emitted = false;
          return { status: "continue", summary: "The text did not stay in the box: letting the page settle, then writing it again", method: "browser", actions: [{ action: "wait", ms: 1500 }] };
        }
        st.dead = true; // finished: never type it again
        const words = st.text.split(/\s+/).filter(Boolean).length;
        return { status: "done", summary: "Finished writing", result: `Typed about ${words} words into the page.` };
      }
      st.emitted = false;
      if (++st.tries > 2) {
        st.dead = true;
        return null;
      }
    }

    // 2) the editor
    const editor = pickEditor(els);
    if (!editor) {
      if (st.waits++ < 3) return { status: "continue", summary: "Waiting for the editor to load", method: "browser", actions: [{ action: "wait", ms: 1200 }] };
      st.dead = true;
      // A CODE task that finds no editor must say so: handing it to the step model made that model type into the wrong place
      // and then report success ("Typed the text once") with nothing on the page.
      if (intent.code) return { status: "give_up", summary: "I could not find a code editor or text box on this page to write in. Click into the editor yourself and ask me again." };
      return null;
    }

    // 3) the text: generated once (a second, differently worded try if the first comes back wrong)
    if (!st.text) {
      const isCode = !!intent.code;
      const language = isCode ? codeCompose.languageFor(intent.request, obs.title, obs.url) : null;
      const prompts = isCode
        ? codeCompose.codePromptsFor({ request: intent.request, language, existing: intent.existing, continuation: intent.continuation })
        : intent.continuation
        ? continuationPromptsFor({ request: intent.request, existing: intent.existing })
        : promptsFor(intent.request).map((message) => ({ message }));
      let text = "";
      let failedToReach = false;
      try {
        const p = prompts[Math.min(st.gen, prompts.length - 1)];
        const raw = await generate(p.message, p.page);
        text = isCode ? codeCompose.cleanGeneratedCode(raw) : cleanGenerated(raw);
      } catch (_) {
        failedToReach = true; // the request itself failed (network / server), as opposed to an unusable answer
      }
      const compareTo = intent.continuation ? `${intent.instruction} ${intent.request}` : intent.request;
      const unusable = isCode
        ? !codeCompose.looksLikeCode(text, language) || (intent.continuation && repeatsExisting(text, intent.existing))
        : looksWrong(text, compareTo) || /\[\d+ chars\]/.test(text) || (intent.continuation && repeatsExisting(text, intent.existing));
      if (unusable) {
        st.unreachable = (st.unreachable || 0) + (failedToReach ? 1 : 0);
        if (++st.gen >= 4) {
          st.dead = true; // could not get real text: say so honestly rather than type junk or pretend it is done
          const why =st.unreachable >= 2 ? "I could not reach the AI model just now (network problem), so I typed nothing. Try again in a moment." : "The AI model did not give me usable text just now, so I typed nothing. Try again, or give me the exact text to type.";
          return { status: "give_up", summary: why };
        }
        // spaced out: an outage of a few seconds is common and must not use up every attempt in one breath
        return { status: "continue", summary: "Thinking about what to write", method: "browser", actions: [{ action: "wait", ms: failedToReach ? 3000 : 900 }] };
      }
      st.text = text;
      st.code = isCode;
      st.language = language;
      // a continuation starts a new paragraph after what is already in the box
      st.typed = intent.continuation && (editor.value || isCode) ? `\n\n${text}` : text;
    }

    // 4a) CODE: click into the editor, select what is there (a fresh program REPLACES the site's starter code; a continuation
    //     appends), and insert it all in ONE go: typing key by key into Ace/CodeMirror/Monaco corrupts code (autocomplete, auto-indent).
    if (st.code) {
      st.emitted = true;
      const appending = !!intent.continuation;
      return {
        status: "continue",
        summary: "Writing the code in the editor",
        method: "ax",
        actions: [
          { action: "click", target: { ref: editor.ref } },
          { action: "hotkey", combo: appending ? "ctrl+End" : "ctrl+a" },
          { action: "type", text: st.typed || st.text, mode: "insert" },
        ],
      };
    }

    // 4) click into the editor, jump to the end (never overwrite what is already there), then type it all in one go
    st.emitted = true;
    return {
      status: "continue",
      summary: "Writing in the notepad",
      method: "ax",
      actions: [
        { action: "click", target: { ref: editor.ref } },
        { action: "hotkey", combo: "ctrl+End" },
        { action: "type", text: st.typed || st.text },
      ],
    };
  }
}

module.exports = { composeIntentFrom, continuationIntentFrom, continuationPromptsFor, repeatsExisting, pickEditor, cleanGenerated, promptsFor, topicFrom, looksWrong, Composer };
