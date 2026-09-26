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

const { looksLikeFormTask, looksLikeQuizTask } = require("./goal-script.cjs");
const { looksLikeNonAnswer } = require("./completion-guard.cjs");
const { toPlainMath } = require("./math-text.cjs");
const { looksLikeQuestionText } = require("../perception/ax.cjs");

const MAX_SCROLLS = 8;
// Bound on how many "which option?" questions are put to the model per task (a long quiz is legitimately many; this only stops a runaway page).
const MAX_CHOICE_ASKS = 120;
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
  // A box's own name ("Full name") when the problem/question beside it was attached separately; else the label itself. Never the text of
  // a long problem statement, which can contain "name" or "number" without asking for one.
  const l = String(question.hint || question.label).toLowerCase();
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
  const dupes = new Map();
  for (const e of els || []) {
    if (!e.ref || isSecretField(e)) continue;
    if (e.role === "radio" || e.role === "checkbox") {
      // `question` is the full text the observer read off the page for this control's group; `ctx` is the accessibility tree's own
      // (possibly shortened) group name. A RADIO that belongs to no identifiable question is never turned into a one-option "question" of
      // its own - that made twenty unlabeled options look like twenty questions, each "answered" by clicking its only choice.
      const raw = e.question || e.ctx || (e.role === "checkbox" ? e.name : "") || "";
      if (!raw) continue;
      const key = "choice:" + raw;
      if (!byKey.has(key)) byKey.set(key, { key, label: cleanLabel(raw), kind: "choice", multi: e.role === "checkbox", required: requiredHint(raw, e), options: [], y: e.rect ? e.rect.y : 0 });
      const q = byKey.get(key);
      q.required = q.required || requiredHint(raw, e);
      q.options.push({ ref: e.ref, name: e.name, checked: !!(e.states && e.states.checked && e.states.checked !== "false") });
    } else if (e.role === "textbox" && !SKIP_TEXTBOX.test(e.name || "")) {
      // `question` is the problem/question the observer found beside a box whose own name is generic (an identical placeholder on every
      // box of a 30-problem page, which used to merge all 30 into ONE question). The box's own name is kept as `hint`.
      const raw = e.question || e.name || "";
      if (!raw) continue;
      const key = "text:" + raw;
      if (!e.question) dupes.set(key, (dupes.get(key) || 0) + 1); // boxes sharing this name with no problem attached to them
      // `filled`: the box already holds text (typed earlier in this run, or before a failed run was retried). Re-typing it would redo -
      // and re-generate - every answer already given.
      if (!byKey.has(key)) byKey.set(key, { key, label: cleanLabel(raw), hint: e.question ? e.name || "" : undefined, kind: "text", required: requiredHint(raw, e), textRef: e.ref, filled: String(e.value == null ? "" : e.value).trim().length > 0, y: e.rect ? e.rect.y : 0 });
    } else if ((e.role === "listbox" || e.role === "combobox") && e.name) {
      const raw = e.name || "";
      const key = "list:" + raw;
      if (!byKey.has(key)) {
        const q = { key, label: cleanLabel(raw), kind: "listbox", required: requiredHint(raw, e), listRef: e.ref, options: [], y: e.rect ? e.rect.y : 0 };
        // The observer reads a native <select>'s real <option>s from the page (the accessibility tree lists a closed dropdown as one
        // combobox with only its current value). "Choose..." style placeholders and disabled options are never answers.
        if (Array.isArray(e.options)) {
          q.options = e.options.filter((o) => o && o.name && !o.disabled && !PLACEHOLDER_OPTION.test(String(o.name).trim())).map((o) => ({ ref: e.ref, name: o.name, checked: !!o.selected }));
        }
        byKey.set(key, q);
        listboxQuestions.push(q);
      }
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
  // Several boxes with the SAME generic name and no problem attached to any of them cannot be told apart: they were merged into one
  // "question" whose text is the placeholder. Flag it, so nothing is generated for (or typed into) the wrong box.
  for (const [key, n] of dupes) if (n > 1 && byKey.get(key)) byKey.get(key).ambiguous = true;
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
// ALL the page's text, not just what is on screen: after Submit a tall form's confirmation ("Thank you! Your score: 5/5") is often
// BELOW the visible area, and reading only the visible text turned a successful submit into "could not confirm it went through".
const fullPageText = (obs) => `${obs.title || ""} ${(obs.pageText && obs.pageText.viewport) || ""} ${(obs.pageText && obs.pageText.content) || ""}`;
const CONFIRMATION_G = new RegExp(CONFIRMATION_TEXT.source, "gi");
/** Confirmation wording that is on the page NOW but was not before the submit click (a footer's "Thanks for visiting" proves nothing). */
function newConfirmation(now, before) {
  const had = new Set(before === undefined ? [] : (String(before).match(CONFIRMATION_G) || []).map((s) => s.toLowerCase()));
  return (String(now).match(CONFIRMATION_G) || []).some((s) => !had.has(s.toLowerCase()));
}
function looksSubmitted({ obs, urlBefore, hadQuestions, textBefore }) {
  const url = String(obs.url || "");
  if (/\/formResponse\b/i.test(url)) return true; // Google Forms' own confirmation path
  const urlChanged = urlBefore && url && url !== urlBefore;
  const hasConfirmationText = textBefore === undefined ? CONFIRMATION_TEXT.test(fullPageText(obs)) : newConfirmation(fullPageText(obs), textBefore);
  const questionsGoneNow = hadQuestions && !looksLikeAForm(obs.elements);
  return urlChanged || hasConfirmationText || questionsGoneNow;
}

// A real reported case was a 30-question homework page ("Find the exact value of the improper integral...") -
// the old wording ("a short, under 20 words, genuinely positive answer") was written for a feedback-form blurb
// and forced exactly the wrong shape onto a question asking to "show every step". This is deliberately
// content-neutral: it does not assume a feedback form OR a homework page, and lets the question itself decide
// how long or short a correct answer actually is.
// The answer is typed into a box and read by a PERSON: plain text, maths written the way it is written by hand (∫ ∑ √ π ∞ ± × ÷ ≤ ≥ ≠ → ² ³),
// never LaTeX source (the reported answers came out as "$\frac{1}{4\sqrt{2}}$ ... \int_{-\infty}^{\infty}"). toPlainMath() converts whatever LaTeX still slips through.
const GENERATE_PROMPT = (label, retry) => `Answer this question completely and accurately: "${label}"\nThe whole question is quoted above - it is all you need.${retry ? " Do NOT ask me for the question or for more information and do not say you cannot see it: answer it now." : ""}\nIf it asks for steps, working, or a derivation, show all of them in full before the final answer. If it is a short, simple question, a short answer is fine - do not pad it. Write it the way a person writes it by hand on paper: plain text with ordinary maths symbols (∫ ∑ √ π ∞ ± × ÷ ≤ ≥ ≠ → and superscripts like x², eⁿ), fractions as a/b or (a+b)/(c+d). Do NOT use LaTeX, dollar signs, backslash commands (\\frac, \\int, \\sum, \\sqrt) or markdown. Reply with only the answer itself: no "Sure, here is...", no restating the question, no extra commentary.`;

// ------------------------------------------------------------------------------------------ answering a choice question

// The model is asked to reply with the option's TEXT, not a letter or a number. Measured against the hosted model: asked for a
// letter it worked out "15 × 6 = 90" correctly and then wrote the letter of a different option (a mapping slip that has nothing
// to do with the maths); the text it just computed is the answer, with no mapping step left to get wrong.
const CHOICE_PROMPT = (q, opts, retry) => {
  const list = opts.map((o) => `- ${o.name}`).join("\n");
  const how = q.multi ? "Choose EVERY option that is correct or applies." : "Choose exactly one option.";
  const rules = `If the question has a correct answer (a quiz, a test, a maths or general-knowledge question), work it out and choose the correct option. If it only asks for a preference or a personal detail that nobody has told you, choose the most neutral option ("Prefer not to say", "Other", "No preference" or similar), otherwise the first.`;
  const what = q.multi ? "the exact text of each chosen option, separated by semicolons" : "the exact text of your chosen option";
  const ending = retry
    ? `Reply with ONLY ${what}. Nothing else.`
    : `Work it out in at most a few short lines, then finish with a final line exactly like: ANSWER: <${what}>`;
  return `A multiple-choice question from a web page.\nQuestion: "${q.label}"\nOptions:\n${list}\n${how} ${rules}\n${ending}`;
};

const normText = (s) => String(s || "").toLowerCase().replace(/[.,;:!?"'()*_`#]+/g, " ").replace(/\s+/g, " ").trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The option indexes a model's reply picked, or null when it did not clearly pick any. Strict on purpose: an unreadable reply must
 * never turn into "the first option" (that is exactly the bug this replaces - every question answered with option 1).
 * Accepts, in order: a final "ANSWER: <option text>" line (several separated by ";" for a multi-select); a reply that IS one option's
 * text; the text of exactly one option appearing in the reply (several for a multi-select).
 */
function parseChoiceReply(reply, options, multi) {
  const opts = options || [];
  const text = String(reply || "").trim();
  if (!opts.length || !text) return null;
  const norm = opts.map((o) => normText(o.name));
  const uniq = (arr) => [...new Set(arr.filter((i) => i >= 0))];
  const settle = (idx) => (idx.length && (multi || idx.length === 1) ? idx : null);
  const equal = (s) => {
    const t = normText(s);
    const hits = t ? norm.map((n, i) => (n === t ? i : -1)).filter((i) => i >= 0) : [];
    return hits.length === 1 ? hits[0] : -1;
  };
  const mentioned = (s) => {
    const flat = normText(s);
    return uniq(norm.map((n, i) => (n && new RegExp(`(^|[^a-z0-9.])${escapeRe(n)}($|[^a-z0-9.])`).test(flat) ? i : -1)));
  };

  // 1) an explicit final answer line
  const finals = [...text.matchAll(/(?:ANSWER|Answer|answer)s?\s*[:=]\s*(.+)$/gm)];
  if (finals.length) {
    const payload = finals[finals.length - 1][1].trim();
    const parts = multi ? payload.split(/\s*;\s*|\s*\|\s*/).filter(Boolean) : [payload];
    const direct = uniq(parts.map(equal));
    if (direct.length === parts.length) {
      const got = settle(direct);
      if (got) return got;
    }
    const got = settle(mentioned(payload));
    if (got) return got;
  }
  // 2) the whole reply is one option's text ("9", "Prefer not to say")
  const whole = equal(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || "");
  if (whole >= 0 && !text.includes("\n")) return [whole];
  // 3) the reply mentions exactly one option (all of them, for a multi-select)
  return settle(mentioned(text));
}

// ---- pure-arithmetic questions ("What is 72 ÷ 8?") are worked out here, exactly, rather than trusted to a model that, measured, gets
// "9 + 8" wrong. A small recursive-descent parser: no eval, digits and + - × ÷ ^ ( ) only; anything else is "not arithmetic" (null).

function evalArithmetic(src) {
  const s = String(src).replace(/\s+/g, "");
  if (!s || !/^[\d.+\-*/^()]+$/.test(s)) return null;
  let i = 0;
  const fail = () => { throw new Error("no"); };
  const number = () => {
    const m = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(s.slice(i));
    if (!m) fail();
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const factor = () => {
    if (s[i] === "-") { i++; return -factor(); }
    if (s[i] === "+") { i++; return factor(); }
    if (s[i] === "(") { i++; const v = expr(); if (s[i] !== ")") fail(); i++; return v; }
    return number();
  };
  const power = () => { const b = factor(); if (s[i] === "^") { i++; return Math.pow(b, power()); } return b; };
  const term = () => {
    let v = power();
    for (;;) {
      if (s[i] === "*") { i++; v *= power(); }
      else if (s[i] === "/") { i++; const d = power(); if (d === 0) fail(); v /= d; }
      else return v;
    }
  };
  const expr = () => {
    let v = term();
    for (;;) {
      if (s[i] === "+") { i++; v += term(); }
      else if (s[i] === "-") { i++; v -= term(); }
      else return v;
    }
  };
  try {
    const v = expr();
    return i === s.length && Number.isFinite(v) ? v : null;
  } catch (_) {
    return null;
  }
}

/** "2. What is 72 ÷ 8?" -> { expr: "72 / 8", value: 9 }; null unless the WHOLE question is one arithmetic expression. */
function arithmeticFromQuestion(label) {
  let t = String(label || "").trim()
    .replace(/^(?:q(?:uestion)?\s*)?\d{1,3}\s*[.):]\s+/i, "") // "2. " / "Q2) " numbering (needs the space: "3.5 x 2" is a number)
    .replace(/^(?:what\s+is|what's|calculate|compute|evaluate|find|solve|simplify|work\s+out)\b\s*[:,]?\s*/i, "")
    .replace(/^(?:the\s+)?(?:value|result|answer|product|sum|difference|quotient)\s+of\s+/i, "")
    .replace(/\s*(?:=\s*\?*|\?+)\s*$/, "")
    .trim();
  if (!t || !/\d/.test(t)) return null;
  t = t.replace(/(\d),(?=\d{3}(?!\d))/g, "$1") // 1,000 -> 1000
    .replace(/(\d)\s*[xX]\s*(?=[\d(])/g, "$1*").replace(/[×·]/g, "*").replace(/÷/g, "/").replace(/[−–]/g, "-").replace(/\*\*/g, "^");
  if (!/^[\d\s.+\-*/^()]+$/.test(t) || !/[+\-*/^]/.test(t.replace(/^\s*-/, ""))) return null;
  const value = evalArithmetic(t);
  return value === null ? null : { expr: t.replace(/\*/g, " × ").replace(/\//g, " ÷ ").replace(/\s+/g, " ").trim(), value };
}

function optionNumber(name) {
  const t = String(name || "").trim().replace(/^[$€£₹]\s*/, "").replace(/[−–]/g, "-").replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  if (/^[-+]?\d+(?:\.\d+)?$/.test(t)) return parseFloat(t);
  const f = /^(-?\d+)\s*\/\s*(\d+)$/.exec(t);
  return f && +f[2] !== 0 ? +f[1] / +f[2] : null;
}

/** For a choose-one question that is pure arithmetic: the option whose number equals the result, if exactly one does. */
function arithmeticChoice(q, opts) {
  if (q.multi) return null;
  const a = arithmeticFromQuestion(q.label);
  if (!a) return null;
  const hits = opts.map((o, i) => [i, optionNumber(o.name)]).filter(([, n]) => n !== null && Math.abs(n - a.value) <= 1e-9 * Math.max(1, Math.abs(a.value)));
  return hits.length === 1 ? { index: hits[0][0], expr: a.expr, value: a.value } : null;
}

// A "neutral" choice for a preference/personal question the model could not answer, when the goal did not ask for CORRECT answers.
const NEUTRAL_OPTION = /^(?:prefer not|no preference|not applicable|n\/a|none|other|neither|decline|skip|don'?t know|not sure)\b/i;

/**
 * Which option(s) answer this question - for a radio group, a checkbox group and a dropdown alike.
 *   1. pure arithmetic is calculated here (exact, no model call);
 *   2. otherwise the question and its options are put to the model (`generate`), retried once with a stricter prompt;
 *   3. an unreadable answer is NEVER turned into "the first option": a goal that asks for correct answers (a quiz) stops honestly,
 *      any other form falls back to the most neutral option and says so.
 * @returns {{ chosen: object[], how: string } | { stop: object }}  `stop` is a step envelope to return as-is (give_up)
 */
async function chooseOptions(q, { st, goal, obs, generate }) {
  const opts = q.options;
  const calc = arithmeticChoice(q, opts);
  let picked = calc ? [calc.index] : null;
  if (!picked) {
    if (st.asked >= MAX_CHOICE_ASKS) {
      st.dead = true;
      return { stop: { status: "give_up", summary: `There are more questions than I can answer in one go (stopped at "${q.label}"). Please finish the rest yourself.` } };
    }
    st.asked++;
    const page = obs.title ? `A web page titled "${String(obs.title).slice(0, 80)}" with a list of questions to answer.` : "A web page with a list of questions to answer.";
    for (let attempt = 0; attempt < 2 && !picked; attempt++) {
      let reply = "";
      try {
        reply = String((await generate(CHOICE_PROMPT(q, opts, attempt > 0), page)) || "");
      } catch (_) {
        reply = "";
      }
      picked = parseChoiceReply(reply, opts, q.multi);
    }
  }
  if (picked) return { chosen: picked.map((i) => opts[i]), how: calc ? ` (${calc.expr} = ${calc.value})` : "" };
  if (looksLikeQuizTask(goal)) {
    st.dead = true;
    return { stop: { status: "give_up", summary: `I could not work out the answer to "${q.label}", so I have stopped rather than guess. Please choose it yourself, or tell me which one to pick.` } };
  }
  return { chosen: [opts.find((o) => NEUTRAL_OPTION.test(String(o.name || "").trim())) || opts[0]], how: " (no clear answer, so the most neutral option)" };
}

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
      st = { answered: new Set(), identity: identityFrom(goal), generated: 0, asked: 0, ambiguousWaits: 0, scrolls: 0, submitWaits: 0, pending: null, submitTried: false, failures: 0, hadQuestions: true, startUrl: obs.url, log: [] };
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
    if (st.submitTried && looksSubmitted({ obs, urlBefore: st.startUrl, hadQuestions: st.hadQuestions, textBefore: st.textBeforeSubmit })) {
      st.dead = true;
      return { status: "done", summary: "Submitted the form", result: `Submitted the form (${st.answered.size} question${st.answered.size === 1 ? "" : "s"} answered).` };
    }

    // 3) the next unanswered question on screen
    const questions = extractQuestions(els).filter((q) => !st.answered.has(q.key));
    if (questions.length) {
      const q = questions[0];
      if (q.kind === "text") {
        let value = valueFor(q, st.identity);
        // Several boxes share one generic name and none was tied to its own problem: they were merged into ONE "question" whose text is the
        // placeholder. Answering it types generic text into the wrong box (reported: study advice in box 6), and - because the merged
        // question looks already filled - skipping it leaves "nothing left to do", so the form gets SUBMITTED with the rest empty.
        // Look again (the link is usually missing from a single observation only); never guess. Short optional fields (two "Notes"
        // boxes) are not worth stopping for.
        if (!value && q.ambiguous && (q.required || looksLikeQuizTask(goal) || looksLikeQuestionText(q.label))) {
          if (st.ambiguousWaits++ < 3) return { status: "continue", summary: "Looking at the page again to match each answer box to its problem", method: "browser", actions: [{ action: "wait", ms: 600 }] };
          st.dead = true;
          return { status: "give_up", summary: "I could not tell which problem each answer box belongs to, so I stopped instead of typing answers into the wrong boxes. Please try again in a moment." };
        }
        if (!value && q.filled) {
          // already answered (this run, or before a failed run was retried): leave it and go on. A value the GOAL supplies ("my name
          // is X") still overwrites, so this never keeps stale personal details.
          st.answered.add(q.key);
          return this.next({ taskId, goal, obs, els, recent, generate });
        }
        if (!value) {
          // An optional open-ended field with nothing to say ("Notes", "Suggestions") is left alone rather than filled with invented
          // filler - but NOT a problem the person asked to be solved: a quiz/homework page rarely marks its boxes "required", and
          // skipping them would submit an empty page.
          if (!q.required && !looksLikeQuizTask(goal) && !looksLikeQuestionText(q.label)) {
            st.answered.add(q.key);
            return { status: "continue", summary: `Skipping the optional question "${q.label}"`, method: "browser", actions: [{ action: "wait", ms: 50 }] };
          }
          if (st.generated >= MAX_GENERATED) {
            st.dead = true;
            return { status: "give_up", summary: `The form has more open-ended required questions than I can answer ("${q.label}"). Please answer the rest yourself, or tell me what to say.` };
          }
          st.generated++;
          const page = obs.title ? `A web page titled "${String(obs.title).slice(0, 80)}" with a list of questions to answer. The complete question is in the message.` : "A web page with a list of questions to answer. The complete question is in the message.";
          // Never type something that is not an answer (a request for the question, a refusal, the placeholder echoed back): retry once
          // with a firmer prompt, then stop honestly.
          for (let attempt = 0; attempt < 2 && !value; attempt++) {
            let got = "";
            try {
              // 300 chars was sized for a feedback blurb; a worked derivation ("show every step") genuinely needs
              // room. 4000 is a generous multi-paragraph answer while still bounding a truly runaway response.
              got = String((await generate(GENERATE_PROMPT(q.label, attempt > 0), page)) || "").replace(/^["'“”]+|["'“”]+$/g, "").trim().slice(0, 4000);
            } catch (_) {
              got = "";
            }
            // LaTeX -> plain maths BEFORE the check and before typing: a person reads this box, not a renderer
            const plain = got ? toPlainMath(got) : "";
            if (plain && !looksLikeNonAnswer(plain, { question: q.label, hint: q.hint })) value = plain;
          }
          if (!value) {
            st.dead = true;
            return { status: "give_up", summary: `I could not get a real answer for "${q.label.slice(0, 90)}", so I have stopped rather than type something that is not one. Please answer it yourself, or tell me what to write.` };
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
        // This used to take `options[0]` too - the same "always the first one" bug, in a dropdown. Same choosing path as radios.
        const pick = await chooseOptions(q, { st, goal, obs, generate });
        if (pick.stop) return pick.stop;
        const opt = pick.chosen[0];
        if (opt.checked) {
          st.answered.add(q.key); // already set to it
          return this.next({ taskId, goal, obs, els, recent, generate });
        }
        st.pending = q.key;
        st.log.push(`answered "${q.label}"`);
        return { status: "continue", summary: `Answering "${q.label}": ${opt.name}${pick.how}`, method: "ax", actions: [{ action: "form_input", target: { ref: q.listRef }, value: opt.name }] };
      }
      // radio/checkbox.
      //
      // A lone checkbox ("I agree to the terms") has nothing to choose between: tick it unless it already is.
      if (q.options.length === 1) {
        const only = q.options[0];
        if (only.checked) {
          st.answered.add(q.key);
          return this.next({ taskId, goal, obs, els, recent, generate });
        }
        st.pending = q.key;
        st.log.push(`answered "${q.label}"`);
        return { status: "continue", summary: `Answering "${q.label}"`, method: "ax", actions: [{ action: "click", target: { ref: only.ref } }] };
      }
      // A real choice. This used to click `options[0]` for every question ("no preference was stated") - which on a quiz answers
      // every question with option A and scores whatever chance gives. The question and its options are worked out instead (see
      // chooseOptions); an unreadable answer is never quietly turned into "the first one".
      const pick = await chooseOptions(q, { st, goal, obs, generate });
      if (pick.stop) return pick.stop;
      const { chosen, how } = pick;
      const toClick = chosen.filter((o) => !o.checked);
      if (!toClick.length) {
        // already selected: clicking it again changes nothing, which the verifier reports as a failed click ("no observable change")
        st.answered.add(q.key);
        return this.next({ taskId, goal, obs, els, recent, generate });
      }
      st.pending = q.key;
      st.log.push(`answered "${q.label}"`);
      return { status: "continue", summary: `Answering "${q.label}": ${chosen.map((o) => o.name).join(", ")}${how}`, method: "ax", actions: toClick.slice(0, 5).map((o) => ({ action: "click", target: { ref: o.ref } })) };
    }

    // 4) nothing unanswered on screen: is there more form below, or is it time to submit?
    const submitBtn = (els || []).find((e) => e.ref && e.role === "button" && SUBMIT_LABEL.test(String(e.name || "").trim()));
    if (submitBtn) {
      const stillRequired = extractQuestions(els).some((q) => q.required && !st.answered.has(q.key));
      if (!stillRequired && !st.submitTried) {
        st.pending = "__submit__";
        st.textBeforeSubmit = fullPageText(obs); // what the page already said, so only NEW confirmation wording counts afterwards
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

module.exports = { FormFiller, identityFrom, valueFor, extractQuestions, looksLikeAForm, looksSubmitted, cleanLabel, isSecretField, SUBMIT_LABEL, newConfirmation, parseChoiceReply, CHOICE_PROMPT, arithmeticFromQuestion, arithmeticChoice, evalArithmetic };
