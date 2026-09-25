// Noah/models/form-fill.cjs
//
// A multi-question form (a Google Form, a plain HTML registration form, a job application, a survey - any of them) has
// real work no other module here understands: read EVERY question, answer each one exactly once, scroll for more, and
// only submit once nothing required is left unanswered. The generic AX-tree step loop has no memory across turns
// beyond a short "recent actions" list, so on a real form it filled in two fields, scrolled a few times, then got
// confused and started re-navigating to the same form URL over and over (a reported bug, fixed by having this module
// hold the state the raw model does not: which question is answered, and what is genuinely left).
//
// This is deliberately built on STANDARD accessibility semantics, not one site's markup: a "question" is any
// radio/checkbox group (an ARIA `radiogroup`/`group` whose accessible name is the question, via `ctx` - the same way
// Noah already reads a fieldset/legend, a Google Forms question, or any other properly-built group) or any labelled
// text field; "required" is read from the real `required`/`aria-required` state Noah's accessibility layer already
// captures for every element, with a few common TEXT conventions ("*", "(required)", "Required question") as a
// fallback for sites that only signal it visually. Verified live against two independently-built forms: a real
// Google Form and a plain hand-written HTML form (Noah/bench/fixtures.cjs `/form`) with different markup, different
// required-marking, a different submit-button label ("Register", not "Submit") and a different confirmation shape
// (the form stays on the page; a result line appears) - the SAME module handled both.
//
//   GOAL           -> identity (name/email/etc named in the goal, "my name is X")
//   PAGE ELEMENTS  -> one row per question: { key, label, kind: 'text'|'choice', required, options|textRef }
//   STATE          -> which question keys are already answered (never re-answered, never skipped twice)
//   LOOP           -> answer the first unanswered question -> (nothing left visible) scroll -> (a submit-shaped
//                      button is visible, nothing required left) click it -> verified from the page's OWN change,
//                      never asserted from "I clicked something labelled Submit"

"use strict";

const { looksLikeFormTask } = require("./goal-script.cjs");

const MAX_SCROLLS = 8;
// Bound on how many free-text answers are generated per task (cost/latency, and a circuit breaker against a
// runaway page) - raised from 6: a real reported case was a 30-question homework page, where 6 gave up less
// than a fifth of the way through even before the deeper answer-quality issue below.
const MAX_GENERATED = 40;
const MIN_QUESTIONS_TO_START = 2; // one lone text field is very likely a search box, not a form

// ----------------------------------------------------------------------------------------------------- identity

// "my name is X" and "name - X" / "name: X" (no "my", no "is" - exactly the phrasing a real report used: "email id -
// abraham@gmail.com name - Shaun Sunil") both name the same fact; a person filling in their own form says it either way.
const IDENTITY_FIELDS = [
  ["name", /\b(?:my\s+)?name\s*(?:is|[-:])\s*([A-Za-z][\w' .-]*?)(?=\s+(?:and|email|phone|mobile)\b|[,;.]|\s*$)/i],
  ["email", /\be-?mail(?:\s+id)?\s*(?:is|[-:])\s*([^\s,;]+@[^\s,;]+)/i],
  ["phone", /\b(?:phone|number|mobile)(?:\s+(?:number|is))?\s*(?:is|[-:])\s*([\d +().-]{6,20})/i],
];
/** Pull "my name is X" / "email id is Y" style facts out of the goal, the same way a person would fill in their own form. */
function identityFrom(goal) {
  const g = String(goal || "");
  const out = {};
  for (const [key, re] of IDENTITY_FIELDS) {
    const m = re.exec(g);
    if (m) out[key] = m[1].trim().replace(/[.,;]+$/, "");
  }
  return out;
}
/** Does the goal give this specific question an explicit answer ("my name is X", "email id is Y")? */
function valueFor(question, identity) {
  const l = question.label.toLowerCase();
  if (identity.email && /\be-?mail\b/.test(l)) return identity.email;
  if (identity.name && /\bname\b/.test(l) && !/\bfile\s*name\b|\busername\b/.test(l)) return identity.name;
  if (identity.phone && /\bphone|\bmobile|\bnumber\b/.test(l)) return identity.phone;
  return null;
}

// ------------------------------------------------------------------------------------------------- reading a question

// Text conventions used by SOME sites in place of (or alongside) the real `required`/`aria-required` state: a
// trailing "*", "(required)"/"required field", or Google's own "... Required question" suffix.
const REQUIRED_TEXT = /(?:\*\s*$|\(\s*required\s*\)|required\s*field|required\s+question\s*$)/i;
/** A question's accessible name with any of the above trailing markers removed, for a clean label. */
function cleanLabel(s) {
  return String(s || "")
    .replace(/\s*required\s+question\s*$/i, "")
    .replace(/\s*\(\s*required\s*\)\s*$/i, "")
    .replace(/\s*\*\s*$/, "")
    .trim();
}

const SKIP_TEXTBOX = /^(search|find|url|address|command line arguments)$/i;
/** Never treat a password/secret field as a "question" to answer - Noah's own safety layer handles credentials, and
 * nothing here should even try. `el.secret` is set by the accessibility layer for exactly this reason. */
function isSecretField(e) {
  return !!e.secret || e.role === "textbox" && /\bpassword\b/i.test(e.name || "");
}

/**
 * @param {Array} els  the same AX element list every other step gets
 * @returns {Array<{key:string, label:string, kind:'text'|'choice'|'listbox', required:boolean, options?:Array, textRef?:string, y:number}>}
 */
// A native <select>'s own options ARE exposed in the accessibility tree even while it is closed (verified: Chromium
// reports the popup and its options as part of the combobox's own subtree) - a placeholder like "Choose..." is not a
// real answer, so it is never picked.
const PLACEHOLDER_OPTION = /^(?:-+|choose|select)\b.*$|^$/i;
const OPTION_ROLE = /^(option|menuitemoption|menulistoption)$/i;

function extractQuestions(els) {
  const byKey = new Map();
  const requiredHint = (raw, e) => !!(e && e.states && e.states.required) || REQUIRED_TEXT.test(raw);
  const listboxQuestions = [];
  const orphanOptions = [];
  for (const e of els || []) {
    if (!e.ref || isSecretField(e)) continue;
    if (e.role === "radio" || e.role === "checkbox") {
      const raw = e.ctx || e.name || "";
      if (!raw) continue;
      const key = "choice:" + raw;
      if (!byKey.has(key)) byKey.set(key, { key, label: cleanLabel(raw), kind: "choice", required: requiredHint(raw, e), options: [], y: e.rect ? e.rect.y : 0 });
      const q = byKey.get(key);
      q.required = q.required || requiredHint(raw, e);
      q.options.push({ ref: e.ref, name: e.name });
    } else if (e.role === "textbox" && !SKIP_TEXTBOX.test(e.name || "")) {
      const raw = e.name || "";
      if (!raw) continue;
      const key = "text:" + raw;
      if (!byKey.has(key)) byKey.set(key, { key, label: cleanLabel(raw), kind: "text", required: requiredHint(raw, e), textRef: e.ref, y: e.rect ? e.rect.y : 0 });
    } else if ((e.role === "listbox" || e.role === "combobox") && e.name) {
      const raw = e.name || "";
      const key = "list:" + raw;
      if (!byKey.has(key)) { const q = { key, label: cleanLabel(raw), kind: "listbox", required: requiredHint(raw, e), listRef: e.ref, options: [], y: e.rect ? e.rect.y : 0 }; byKey.set(key, q); listboxQuestions.push(q); }
    } else if (OPTION_ROLE.test(e.role) && !PLACEHOLDER_OPTION.test((e.name || "").trim())) {
      const owner = listboxQuestions.find((q) => q.label && e.ctx === q.label) || null;
      if (owner) owner.options.push({ ref: e.ref, name: e.name });
      else orphanOptions.push(e);
    }
  }
  // An option whose `ctx` did not name its own dropdown (common for a native <select>'s popup, which is not always
  // exposed as a labelled group) goes to the one listbox question that still has none - never guessed beyond that.
  if (orphanOptions.length && listboxQuestions.length === 1 && !listboxQuestions[0].options.length) {
    listboxQuestions[0].options.push(...orphanOptions.map((e) => ({ ref: e.ref, name: e.name })));
  }
  return [...byKey.values()].sort((a, b) => a.y - b.y);
}

// --------------------------------------------------------------------------------------------- is this a form task?

/** Does the page currently look like a multi-question form worth this module's attention? */
function looksLikeAForm(els) {
  return extractQuestions(els).length >= MIN_QUESTIONS_TO_START;
}

// Button labels that commonly finish a form, across very different sites - not just Google's literal "Submit".
const SUBMIT_LABEL = /^(submit|register|send|continue|next|finish|done|save|apply|confirm|sign\s*up|create\s+account|complete|subscribe|place\s+order|book\s+now|submit\s+(?:form|response|application))\b/i;

/**
 * Was this really submitted? Two independent kinds of evidence, because neither alone is trustworthy: (a) the submit
 * click's OWN result was verified ok (Noah's normal action verification - the click had SOME effect), and (b) the
 * page now shows genuine evidence of that: either the tracked questions are gone (most sites navigate away or replace
 * the form, e.g. Google Forms), or a live/status region's text now reads like a confirmation (a form that stays in
 * place and only reveals a result line, like Noah/bench/fixtures.cjs's own `/form` page: "Registered: {...}"), or the
 * URL changed. Conservative on purpose: if neither shows up, this is NOT reported as submitted - an honest "I could
 * not confirm it went through" beats a false "done" (see models/completion-guard.cjs for the same principle applied
 * to the model's own self-reported completion).
 */
const CONFIRMATION_TEXT = /\bthank(?:s| you)\b|\bregistered\b|\bsubmitted\b|\bsuccessfully\b|\bresponse (?:has been )?record|\bwe(?:'ve| have)? received\b|\byour (?:response|submission|registration|application)\b|\bconfirmation\b|\bsuccess\b/i;
function looksSubmitted({ obs, urlBefore, hadQuestions }) {
  const url = String(obs.url || "");
  if (/\/formResponse\b/i.test(url)) return true; // Google Forms' own confirmation path
  const urlChanged = urlBefore && url && url !== urlBefore;
  const text = `${obs.title || ""} ${(obs.pageText && (obs.pageText.viewport || obs.pageText.content)) || ""}`;
  const hasConfirmationText = CONFIRMATION_TEXT.test(text);
  const questionsGoneNow = hadQuestions && !looksLikeAForm(obs.elements);
  return urlChanged || hasConfirmationText || questionsGoneNow;
}

// A real reported case was a 30-question homework page ("Find the exact value of the improper integral...") -
// the old wording ("a short, under 20 words, genuinely positive answer") was written for a feedback-form blurb
// and forced exactly the wrong shape onto a question asking to "show every step". This is deliberately
// content-neutral: it does not assume a feedback form OR a homework page, and lets the question itself decide
// how long or short a correct answer actually is.
const GENERATE_PROMPT = (label) => `Answer this question completely and accurately: "${label}"\nIf it asks for steps, working, or a derivation, show all of them in full before the final answer. If it is a short, simple question, a short answer is fine - do not pad it. Reply with only the answer itself: no "Sure, here is...", no restating the question, no extra commentary.`;

class FormFiller {
  constructor() {
    this._s = new Map(); // taskId -> state
  }

  /**
   * @param {object} c { taskId, goal, obs, els, recent, generate }
   * @returns {null | object} null = not (or no longer) a form task, hand the step back to the model
   */
  async next({ taskId, goal, obs, els, recent, generate }) {
    let st = this._s.get(taskId);
    if (!st) {
      // Only START on a page that both looks like a form AND was actually asked for - a single unrelated text field
      // (a search box, a chat input) must never be swept into this.
      if (!looksLikeFormTask(goal) && !/\bform\b/i.test(String(goal || ""))) return null;
      if (!looksLikeAForm(els)) return null;
      st = { answered: new Set(), identity: identityFrom(goal), generated: 0, scrolls: 0, submitWaits: 0, pending: null, submitTried: false, failures: 0, hadQuestions: true, startUrl: obs.url, log: [] };
      this._s.set(taskId, st);
      if (this._s.size > 20) this._s.delete(this._s.keys().next().value);
    }
    if (st.dead) return null;

    // 1) settle what the last action did.
    //
    // Root cause of a real, reported failure: a [click, ctrl+a, type] BATCH with no `target` on the type action never
    // gave Noah's verifier a field to directly read - `agent/action-executor.cjs` only calls `browser.readValue(ref)`
    // (a genuine, live DOM property read: `this.value` / `this.innerText` on the real node, via CDP - NOT the
    // accessibility tree, which a custom-styled field can leave stale) when the action itself carries a `target`.
    // Without it, "did the type work" fell back to a generic DOM-diff heuristic that does not reliably fire for a
    // custom text input, so a type that genuinely landed was reported as "no effect" and retried from scratch. A
    // SINGLE `type` action WITH `target: {ref}` fixes both problems at once: `_do_type` clicks the field itself (so
    // there is no multi-action batch for the agent loop's own "page changed, stop the rest of the batch" guard to
    // truncate), and its result is checked against a real, live read of that exact field - the technique Anthropic's
    // and OpenAI's own computer-use guidance calls for ("verify the actual outcome", not the model's belief about
    // it), applied at the accessibility-tree layer (see docs/RESEARCH.md section 2/3: Noah's perception ladder is
    // "text first, screenshot only where text-level signals cannot answer the question" - this was a case where a
    // *better text-level signal* was available and simply was not being asked for).
    if (st.pending) {
      const last = recent[recent.length - 1];
      const ok = !!last && last.ok !== false;
      if (ok) {
        if (st.pending === "__submit__") st.submitTried = true;
        else st.answered.add(st.pending);
      } else if (++st.failures > 4) {
        st.dead = true; // stop fighting the page: hand back to the model rather than loop on a broken action
        st.pending = null;
        return null;
      }
      st.pending = null;
    }

    // 2) really submitted? verified from the page itself, never asserted from "I clicked something labelled Submit"
    if (st.submitTried && looksSubmitted({ obs, urlBefore: st.startUrl, hadQuestions: st.hadQuestions })) {
      st.dead = true;
      return { status: "done", summary: "Submitted the form", result: `Submitted the form (${st.answered.size} question${st.answered.size === 1 ? "" : "s"} answered).` };
    }

    // 3) the next unanswered question on screen
    const questions = extractQuestions(els).filter((q) => !st.answered.has(q.key));
    if (questions.length) {
      const q = questions[0];
      if (q.kind === "text") {
        let value = valueFor(q, st.identity);
        if (!value) {
          if (!q.required) {
            // an optional, open-ended question with nothing to say: leave it and move on rather than invent filler
            st.answered.add(q.key);
            return { status: "continue", summary: `Skipping the optional question "${q.label}"`, method: "browser", actions: [{ action: "wait", ms: 50 }] };
          }
          if (st.generated >= MAX_GENERATED) {
            st.dead = true;
            return { status: "give_up", summary: `The form has more open-ended required questions than I can answer ("${q.label}"). Please answer the rest yourself, or tell me what to say.` };
          }
          st.generated++;
          try {
            // 300 chars was sized for a feedback blurb; a worked derivation ("show every step") genuinely needs
            // room. 4000 is a generous multi-paragraph answer while still bounding a truly runaway response.
            value = String((await generate(GENERATE_PROMPT(q.label))) || "").replace(/^["'“”]+|["'“”]+$/g, "").trim().slice(0, 4000);
          } catch (_) {
            value = "";
          }
          if (!value) {
            st.dead = true;
            return { status: "give_up", summary: `I could not come up with an answer for the required question "${q.label}". Please answer it yourself, or tell me what to say.` };
          }
        }
        st.pending = q.key;
        st.log.push(`answered "${q.label}"`);
        return { status: "continue", summary: `Answering "${q.label}"`, method: "ax", actions: [{ action: "type", target: { ref: q.textRef }, text: value, clear: true }] };
      }
      if (q.kind === "listbox") {
        // A dropdown's real value is set directly (`form_input`, verified the same way as a `type` - against the
        // control's own live DOM value), never by clicking it open then guessing at a second click: a native
        // <select>'s popup is OS-rendered in real Chrome and not reliably clickable by coordinate/ref at all, and the
        // options were already read straight from the accessibility tree above.
        if (!q.options.length) {
          if (!q.required) {
            st.answered.add(q.key);
            return { status: "continue", summary: `Skipping the optional question "${q.label}" (could not read its options)`, method: "browser", actions: [{ action: "wait", ms: 50 }] };
          }
          st.dead = true;
          return { status: "give_up", summary: `The dropdown "${q.label}" is required but I could not read its options. Please choose one yourself.` };
        }
        const opt = q.options[0];
        st.pending = q.key;
        st.log.push(`answered "${q.label}"`);
        return { status: "continue", summary: `Answering "${q.label}"`, method: "ax", actions: [{ action: "form_input", target: { ref: q.listRef }, value: opt.name }] };
      }
      // radio/checkbox: no preference was stated, so the first, safest, most neutral option is chosen - never invented
      // beyond what is actually on the page.
      const opt = q.options[0];
      st.pending = q.key;
      st.log.push(`answered "${q.label}"`);
      return { status: "continue", summary: `Answering "${q.label}"`, method: "ax", actions: [{ action: "click", target: { ref: opt.ref } }] };
    }

    // 4) nothing unanswered on screen: is there more form below, or is it time to submit?
    const submitBtn = (els || []).find((e) => e.ref && e.role === "button" && SUBMIT_LABEL.test(String(e.name || "").trim()));
    if (submitBtn) {
      const stillRequired = extractQuestions(els).some((q) => q.required && !st.answered.has(q.key));
      if (!stillRequired && !st.submitTried) {
        st.pending = "__submit__";
        return { status: "continue", summary: "Submitting the form", method: "ax", actions: [{ action: "click", target: { ref: submitBtn.ref } }] };
      }
    }
    if (st.submitTried) {
      // the submit click landed but nothing yet confirms it (a slow page, an async save): give it a moment, do not
      // silently claim success and do not silently retype answered questions either.
      if (st.submitWaits++ < 3) return { status: "continue", summary: "Waiting to see if the form was submitted", method: "browser", actions: [{ action: "wait", ms: 800 }] };
      st.dead = true;
      return { status: "give_up", summary: `I clicked "${submitBtn ? submitBtn.name : "submit"}" but could not confirm the form actually went through. Please check the page.` };
    }
    if (st.scrolls++ < MAX_SCROLLS) {
      return { status: "continue", summary: "Scrolling to see the rest of the form", method: "browser", actions: [{ action: "scroll", direction: "down", amount: 500 }] };
    }
    st.dead = true;
    return { status: "give_up", summary: `I answered ${st.answered.size} question${st.answered.size === 1 ? "" : "s"} but could not find a way to finish the form (no submit button found after scrolling). Please check the page.` };
  }
}

module.exports = { FormFiller, identityFrom, valueFor, extractQuestions, looksLikeAForm, looksSubmitted, cleanLabel, isSecretField, SUBMIT_LABEL };
