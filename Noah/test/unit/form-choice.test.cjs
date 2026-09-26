// Noah/test/unit/form-choice.test.cjs
//
// Regression tests for the reported bug: on a multiple-choice quiz the agent answered "option 1" for every question
// (refs e2, e6, e10, e14, e18 - the first radio of each group of four), so a page of maths questions was "answered" with whatever
// the first option happened to be. Root causes, each covered here:
//   1. models/form-fill.cjs picked `options[0]` for every radio/checkbox question without ever asking anything;
//   2. a goal like "solve this quiz" never started the form module at all (FORM_TASK only knew "answer the questions", "survey", ...);
//   3. clicking an option that was ALREADY selected changes nothing, which the verifier reports as "the click produced no observable
//      change" - the failure message in the report;
//   4. (perception/observer.cjs, covered by the tierA_forms harness scenarios) options were never tied to their question;
//   5. the payload sent to the hosted server dropped the question and the checked state.
// Measured against the hosted model afterwards: asked for a LETTER it computed 15 x 6 = 90 and then wrote the letter of another
// option, and it answered 9 + 8 = 15 outright. So: answers are requested as the option's TEXT, and pure arithmetic is calculated here.

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { FormFiller, extractQuestions, parseChoiceReply, CHOICE_PROMPT, arithmeticFromQuestion, arithmeticChoice, evalArithmetic } = require("../../models/form-fill.cjs");
const { looksLikeFormTask, looksLikeQuizTask } = require("../../models/goal-script.cjs");
const { choiceGroups } = require("../../models/rexy-legacy.cjs");

// ---------------------------------------------------------------------------------------------------------- the quizzes
const MATHS = [
  ["1. What is 6 × 7? *", ["36", "42", "48", "54"], "42"],
  ["2. What is 72 ÷ 8? *", ["7", "8", "9", "10"], "9"],
  ["3. What is 15 × 6? *", ["80", "90", "100", "110"], "90"],
  ["4. What is 9 + 8? *", ["14", "15", "16", "17"], "17"],
  ["5. What is 12 × 12? *", ["124", "132", "144", "156"], "144"],
];
const GENERAL = [
  ["1. What is the capital of France? *", ["Berlin", "Madrid", "Paris", "Rome"], "Paris"],
  ["2. Which planet is known as the Red Planet? *", ["Venus", "Mars", "Jupiter", "Saturn"], "Mars"],
  ["3. What is the chemical formula of water? *", ["O2", "H2O", "CO2", "NaCl"], "H2O"],
];
const SUBMIT = { ref: "b1", role: "button", name: "Submit", rect: { x: 0, y: 900, width: 90, height: 30 } };

/** The plain-markup quiz as the observer now describes it: every radio carries its question in `question`/`ctx`. */
function quizElements(quiz = MATHS, preselected = {}) {
  const els = [];
  let n = 1;
  quiz.forEach(([q, opts], qi) => {
    opts.forEach((name, oi) => {
      n++;
      els.push({ ref: `e${n}`, role: "radio", name, ctx: q, question: q, group: "g" + qi, states: preselected[`${qi}:${name}`] ? { checked: true } : {}, rect: { x: 50, y: 100 + qi * 200 + oi * 40, width: 13, height: 13 } });
    });
  });
  els.push(SUBMIT);
  return els;
}

/** A stand-in "model" that reads the prompt it is given (question + options) and answers it correctly, in the format it asked for. */
const solver = (quiz, calls = []) => async (prompt) => {
  calls.push(prompt);
  const q = /Question: "(.*)"/.exec(prompt)[1];
  const row = quiz.find((r) => r[0].replace(/\s*\*$/, "") === q);
  return `Working it out... it is ${row[2]}.\nANSWER: ${row[2]}`;
};

/** Drive the form module against a quiz, applying each click to the element states the way a real page would. */
async function runQuiz({ goal, generate, quiz = MATHS, els = quizElements(quiz) }) {
  const filler = new FormFiller();
  const clicked = [];
  const summaries = [];
  let recent = [];
  let step;
  for (let guard = 0; guard < 60; guard++) {
    step = await filler.next({ taskId: "quiz", goal, obs: { url: "http://q/", title: "Quiz", elements: els, pageText: { viewport: "" } }, els, recent, generate });
    if (!step || step.status === "done" || step.status === "give_up") break;
    summaries.push(step.summary);
    recent = [];
    for (const a of step.actions || []) {
      if (a.action === "click") {
        clicked.push(a.target.ref);
        const el = els.find((e) => e.ref === a.target.ref);
        if (el && el.role === "radio") {
          for (const o of els) if (o.group === el.group) o.states = {};
          el.states = { checked: true };
        }
      }
      recent.push({ text: `${a.action} ${a.target && a.target.ref} -> ok`, ok: true });
    }
    if (clicked.includes("b1")) {
      // the page's own confirmation once Submit was clicked
      step = await filler.next({ taskId: "quiz", goal, obs: { url: "http://q/", title: "Quiz", elements: els, pageText: { viewport: "Thank you! Your score" } }, els, recent, generate });
      break;
    }
  }
  const chosen = quiz.map((_, qi) => (els.filter((e) => e.group === "g" + qi).find((e) => e.states && e.states.checked) || {}).name || null);
  return { step, clicked, chosen, summaries };
}

const noModel = async () => { throw new Error("the model must not be asked for this"); };

// ---------------------------------------------------------------------------------------------------- the reply parser

test("parseChoiceReply: reads the final ANSWER line, a reply that is just the option, or exactly one option mentioned - and never guesses", () => {
  const opts = ["7", "8", "9", "10"].map((name) => ({ name }));
  assert.deepEqual(parseChoiceReply("ANSWER: 9", opts, false), [2]);
  assert.deepEqual(parseChoiceReply("72 / 8 is 9.\nANSWER: 9", opts, false), [2]);
  assert.deepEqual(parseChoiceReply("**ANSWER: 10**", opts, false), [3]);
  assert.deepEqual(parseChoiceReply("answer: 9.", opts, false), [2], "trailing punctuation");
  assert.deepEqual(parseChoiceReply("9", opts, false), [2], "the reply named the option itself");
  assert.deepEqual(parseChoiceReply("The answer is 9", opts, false), [2]);
  assert.deepEqual(parseChoiceReply("72 ÷ 8 = 9, not 8\nANSWER: 9", opts, false), [2], "the final line decides when the working mentions other options");
  // unreadable / ambiguous / not an option => null, so the caller can retry or stop - never "option A"
  assert.equal(parseChoiceReply("", opts, false), null);
  assert.equal(parseChoiceReply("I don't know", opts, false), null);
  assert.equal(parseChoiceReply("72 ÷ 8 = 9, not 8", opts, false), null, "two options mentioned and no final line: ambiguous");
  assert.equal(parseChoiceReply("ANSWER: 12", opts, false), null, "not one of the options");
  assert.equal(parseChoiceReply("ANSWER: 7; 9", opts, false), null, "two options for a choose-one question");
});

test("parseChoiceReply: an option whose text is a prefix of another is not confused with it (9 vs 90)", () => {
  const opts = ["9", "90", "99"].map((name) => ({ name }));
  assert.deepEqual(parseChoiceReply("ANSWER: 90", opts, false), [1]);
  assert.deepEqual(parseChoiceReply("The answer is 9", opts, false), [0]);
});

test("parseChoiceReply: multi-select takes every option named", () => {
  const opts = ["JavaScript", "Python", "Go"].map((name) => ({ name }));
  assert.deepEqual(parseChoiceReply("ANSWER: JavaScript; Go", opts, true), [0, 2]);
  assert.deepEqual(parseChoiceReply("JavaScript and Go", opts, true), [0, 2]);
  assert.deepEqual(parseChoiceReply("Python", opts, true), [1]);
});

test("CHOICE_PROMPT puts the question and the options in front of the model and asks for the option's TEXT (not a letter it can mis-map)", () => {
  const q = { label: "2. What is 72 ÷ 8?", multi: false };
  const p = CHOICE_PROMPT(q, ["7", "8", "9", "10"].map((name) => ({ name })), false);
  assert.match(p, /Question: "2\. What is 72 ÷ 8\?"/);
  for (const o of ["7", "8", "9", "10"]) assert.match(p, new RegExp(`^- ${o}$`, "m"));
  assert.match(p, /ANSWER: <the exact text of your chosen option>/);
  assert.doesNotMatch(p, /^[A-D]\) /m, "no letters to map to");
});

// ------------------------------------------------------------------------------------------------------- the calculator

test("evalArithmetic: correct precedence, parentheses, powers, decimals - and nothing that is not arithmetic", () => {
  assert.equal(evalArithmetic("2+3*4"), 14);
  assert.equal(evalArithmetic("(2+3)*4"), 20);
  assert.equal(evalArithmetic("72/8"), 9);
  assert.equal(evalArithmetic("2^3^2"), 512, "right-associative");
  assert.equal(evalArithmetic("-3+5"), 2);
  assert.ok(Math.abs(evalArithmetic("0.1+0.2") - 0.3) < 1e-12);
  assert.equal(evalArithmetic("7/0"), null);
  assert.equal(evalArithmetic("2+"), null);
  assert.equal(evalArithmetic("(2+3"), null);
  assert.equal(evalArithmetic("2**"), null);
  assert.equal(evalArithmetic("alert(1)"), null, "never evaluates code");
  assert.equal(evalArithmetic("process.exit()"), null);
});

test("arithmeticFromQuestion: only a question that IS one arithmetic expression", () => {
  const cases = [
    ["2. What is 72 ÷ 8?", 9],
    ["1. What is 6 × 7?", 42],
    ["Q3) What is 15 x 6?", 90],
    ["What is 1,000 + 250?", 1250],
    ["What is 3.5 × 2?", 7],
    ["Calculate 2 + 3 × 4", 14],
    ["What is (2 + 3)^2 ?", 25],
    ["What is 100 − 37 = ?", 63],
  ];
  for (const [label, want] of cases) {
    const got = arithmeticFromQuestion(label);
    assert.ok(got, label);
    assert.equal(got.value, want, label);
  }
  for (const label of ["What is the capital of France?", "Solve 2x + 3 = 7", "What is 7 ÷ 0?", "Which is bigger, 6 × 7 or 50?", "What year did 1990 + the war start?", "Find x if 3x = 12", "What is 5?", ""]) {
    assert.equal(arithmeticFromQuestion(label), null, label);
  }
});

test("arithmeticChoice: picks the option whose number equals the result; declines when none or several do", () => {
  const opts = (names) => names.map((name) => ({ name }));
  assert.equal(arithmeticChoice({ label: "What is 72 ÷ 8?" }, opts(["7", "8", "9", "10"])).index, 2);
  assert.equal(arithmeticChoice({ label: "What is 1,000 + 250?" }, opts(["1,250", "1,205", "$1250.00x"])).index, 0, "thousands separators in the option");
  assert.equal(arithmeticChoice({ label: "What is 1 ÷ 2?" }, opts(["1/2", "0.4", "2"])).index, 0, "a fraction option");
  assert.equal(arithmeticChoice({ label: "What is 72 ÷ 8?" }, opts(["7", "8", "10"])), null, "the right value is not offered: leave it to the model");
  assert.equal(arithmeticChoice({ label: "What is 72 ÷ 8?" }, opts(["9", "9.0", "10"])), null, "two options are equal: ambiguous");
  assert.equal(arithmeticChoice({ label: "What is 72 ÷ 8?", multi: true }, opts(["9", "8"])), null, "not for tick-all-that-apply");
});

// ------------------------------------------------------------------------------------------ the form module on a quiz

test("MATHS QUIZ: every answer is CORRECT and none needed the model - not the first option of every group (the reported bug)", async () => {
  const { step, clicked, chosen, summaries } = await runQuiz({ goal: "solve this quiz", generate: noModel });
  assert.deepEqual(chosen, ["42", "9", "90", "17", "144"]);
  assert.notDeepEqual(clicked.filter((r) => r !== "b1"), ["e2", "e6", "e10", "e14", "e18"], "the reported symptom: only the first option of each group was ever clicked");
  assert.match(summaries[1], /72 ÷ 8 = 9/, "the status line shows the working");
  assert.equal(step.status, "done");
  assert.match(step.result, /Submitted/);
});

test("GENERAL QUIZ: each question is put to the model with its options and the option it names is clicked", async () => {
  const calls = [];
  const { step, chosen } = await runQuiz({ goal: "solve this quiz", quiz: GENERAL, generate: solver(GENERAL, calls) });
  assert.equal(calls.length, 3, "one question to the model per question");
  assert.deepEqual(chosen, ["Paris", "Mars", "H2O"]);
  assert.match(calls[0], /capital of France/);
  for (const o of ["Berlin", "Madrid", "Paris", "Rome"]) assert.match(calls[0], new RegExp(`^- ${o}$`, "m"));
  assert.equal(step.status, "done");
});

test("QUIZ: an option that is already selected (and is the right one) is NOT clicked again - that click 'produces no observable change'", async () => {
  const els = quizElements(MATHS, { "1:9": true }); // question 2 already has the correct answer selected
  const { clicked, chosen } = await runQuiz({ goal: "solve this quiz", generate: noModel, els });
  const nine = els.find((e) => e.group === "g1" && e.name === "9");
  assert.ok(!clicked.includes(nine.ref), "no redundant click on the already-selected right answer");
  assert.deepEqual(chosen, ["42", "9", "90", "17", "144"]);
});

test("QUIZ: a wrong preselected option is changed to the right one", async () => {
  const els = quizElements(MATHS, { "1:7": true });
  const { chosen } = await runQuiz({ goal: "solve this quiz", generate: noModel, els });
  assert.equal(chosen[1], "9");
});

test("QUIZ: a goal that asks for CORRECT answers stops honestly when the model gives nothing usable - it never guesses the first option", async () => {
  const { step, clicked } = await runQuiz({ goal: "solve this quiz", quiz: GENERAL, generate: async () => "Sorry, I cannot help with that." });
  assert.equal(step.status, "give_up");
  assert.match(step.summary, /could not work out the answer/);
  assert.match(step.summary, /capital of France/);
  assert.equal(clicked.length, 0, "nothing was clicked on a guess");
});

test("a model that fails (throws) on every ask is handled like an unusable reply, not a crash", async () => {
  const { step, clicked } = await runQuiz({ goal: "solve this quiz", quiz: GENERAL, generate: async () => { throw new Error("network down"); } });
  assert.equal(step.status, "give_up");
  assert.equal(clicked.length, 0);
});

test("a first unusable reply is retried once with a stricter prompt before giving up", async () => {
  const prompts = [];
  let n = 0;
  const generate = async (p) => { prompts.push(p); return n++ % 2 === 0 ? "hmm" : "Paris"; };
  const els = quizElements(GENERAL);
  const step = await new FormFiller().next({ taskId: "retry", goal: "solve this quiz", obs: { url: "http://q/", title: "Quiz", elements: els, pageText: {} }, els, recent: [], generate });
  assert.equal(step.status, "continue");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Reply with ONLY the exact text of your chosen option/);
  assert.match(step.summary, /Paris/);
});

test("a SURVEY (no correct answers) with an unusable model reply falls back to the most neutral option and says so", async () => {
  const els = [
    ...["Yes", "No", "Prefer not to say"].map((name, i) => ({ ref: `y${i}`, role: "radio", name, ctx: "Do you work remotely?", question: "Do you work remotely?", group: "g0", states: {}, rect: { x: 0, y: 100 + i * 30, width: 13, height: 13 } })),
    ...["Yes", "No"].map((name, i) => ({ ref: `z${i}`, role: "radio", name, ctx: "Would you recommend us?", question: "Would you recommend us?", group: "g1", states: {}, rect: { x: 0, y: 300 + i * 30, width: 13, height: 13 } })),
  ];
  const step = await new FormFiller().next({ taskId: "svy", goal: "fill this form up for me", obs: { url: "http://s/", title: "Survey", elements: els, pageText: {} }, els, recent: [], generate: async () => "" });
  assert.equal(step.status, "continue");
  assert.equal(step.actions[0].target.ref, "y2", "'Prefer not to say' is the neutral option");
  assert.match(step.summary, /no clear answer/);
});

test("a lone checkbox (consent) is ticked without asking the model, unless it already is", async () => {
  const box = (checked) => [
    { ref: "c1", role: "checkbox", name: "I agree to the terms", ctx: "I agree to the terms", states: checked ? { checked: true } : {}, rect: { x: 0, y: 10, width: 13, height: 13 } },
    { ref: "t1", role: "textbox", name: "Full name", states: { required: true }, rect: { x: 0, y: 60, width: 200, height: 30 } },
  ];
  const s1 = await new FormFiller().next({ taskId: "c-a", goal: "fill this form, my name is Sam Lee", obs: { url: "http://f/", title: "F", elements: box(false), pageText: {} }, els: box(false), recent: [], generate: noModel });
  assert.deepEqual(s1.actions, [{ action: "click", target: { ref: "c1" } }]);
  const s2 = await new FormFiller().next({ taskId: "c-b", goal: "fill this form, my name is Sam Lee", obs: { url: "http://f/", title: "F", elements: box(true), pageText: {} }, els: box(true), recent: [], generate: noModel });
  assert.equal(s2.actions[0].action, "type", "already ticked: on to the next field");
});

// ------------------------------------------------------------------------------------------ recognising the submission

test("looksSubmitted: a confirmation BELOW the visible area (in the full page text) counts - a live run scored 5/5 and still reported failure", () => {
  const { looksSubmitted, newConfirmation } = require("../../models/form-fill.cjs");
  const obs = {
    url: "http://q/quiz", title: "Quiz plain",
    pageText: { viewport: "5. What is 12 × 12? *\n124\n132\n144\n156\nSubmit", content: "Math Quiz\n...\nSubmit\n\nThank you! Your score: 5/5" },
    elements: [{ ref: "e1", role: "radio", name: "x", ctx: "Q1", states: {}, rect: { x: 0, y: 0, width: 1, height: 1 } }, { ref: "e2", role: "radio", name: "y", ctx: "Q1", states: {}, rect: { x: 0, y: 0, width: 1, height: 1 } }],
  };
  assert.equal(looksSubmitted({ obs, urlBefore: "http://q/quiz", hadQuestions: true, textBefore: "Math Quiz\n...\nSubmit" }), true);
  assert.equal(newConfirmation("...Submit\n\nThank you! Your score: 5/5", "...Submit"), true);
});

test("looksSubmitted: confirmation wording that was ALREADY on the page before Submit (a footer) is not proof of submission", () => {
  const { looksSubmitted } = require("../../models/form-fill.cjs");
  const text = "Quiz\nSubmit\nThanks for visiting our site";
  const r = (ref, name, ctx) => ({ ref, role: "radio", name, ctx, states: {}, rect: { x: 0, y: 0, width: 1, height: 1 } });
  const els = [r("e1", "x", "Q1"), r("e2", "y", "Q1"), r("e3", "x", "Q2"), r("e4", "y", "Q2")]; // two questions: the form is still on the page
  const obs = { url: "http://q/quiz", title: "Quiz", pageText: { viewport: text, content: text }, elements: els };
  assert.equal(looksSubmitted({ obs, urlBefore: "http://q/quiz", hadQuestions: true, textBefore: text }), false, "same footer, nothing new, form still there");
  assert.equal(looksSubmitted({ obs, urlBefore: "http://q/quiz", hadQuestions: true }), true, "without a 'before' snapshot the old, looser rule still applies");
});

// ------------------------------------------------------------------------------------------------- dropdowns (<select>)

// The live shape: Chromium lists a closed native <select> as ONE combobox with only its current value; the observer reads the real
// options from the page and attaches them as `options`.
const dropdown = (ref, name, options, y = 50) => ({ ref, role: "combobox", name, value: "Choose…", options, states: {}, rect: { x: 0, y, width: 200, height: 30 } });
const COUNTRY = [{ name: "Choose…", selected: true, disabled: false }, { name: "India", selected: false, disabled: false }, { name: "Spain", selected: false, disabled: false }, { name: "United States", selected: false, disabled: false }];

test("a dropdown's real options (read from the page) become the question's options; the placeholder and disabled options are not answers", () => {
  const [q] = extractQuestions([dropdown("d1", "Country", [...COUNTRY, { name: "Antarctica", selected: false, disabled: true }])]);
  assert.equal(q.kind, "listbox");
  assert.deepEqual(q.options.map((o) => o.name), ["India", "Spain", "United States"]);
  assert.ok(q.options.every((o) => o.ref === "d1"), "the value is set on the <select> itself");
});

test("DROPDOWN: the model chooses the option (it used to be options[0]) and the value is set with form_input", async () => {
  const els = [
    dropdown("d1", "Which of these is a fruit?", [{ name: "Choose…", selected: true }, { name: "Carrot", selected: false }, { name: "Banana", selected: false }, { name: "Potato", selected: false }], 50),
    dropdown("d2", "Country", COUNTRY, 120),
  ];
  const prompts = [];
  const generate = async (p) => { prompts.push(p); return /fruit/.test(p) ? "A banana is a fruit.\nANSWER: Banana" : "ANSWER: Spain"; };
  const filler = new FormFiller();
  const s1 = await filler.next({ taskId: "dd", goal: "answer all the questions on this form", obs: { url: "http://d/", title: "T", elements: els, pageText: {} }, els, recent: [], generate });
  assert.equal(s1.actions[0].action, "form_input");
  assert.equal(s1.actions[0].value, "Banana", "not the first option (Carrot)");
  assert.match(prompts[0], /^- Banana$/m);
});

test("DROPDOWN: an arithmetic dropdown question is calculated; an already-selected right answer is not set again", async () => {
  const sel = (name, selected) => ({ name, selected, disabled: false });
  const els = [
    dropdown("d1", "What is 72 ÷ 8?", [sel("Choose…", false), sel("7", false), sel("8", false), sel("9", false)], 50),
    dropdown("d2", "What is 6 × 7?", [sel("36", false), sel("42", true), sel("48", false)], 120), // already on the right answer
  ];
  const filler = new FormFiller();
  const s1 = await filler.next({ taskId: "dd2", goal: "solve this quiz", obs: { url: "http://d/", title: "T", elements: els, pageText: {} }, els, recent: [], generate: noModel });
  assert.equal(s1.actions[0].value, "9");
  assert.match(s1.summary, /72 ÷ 8 = 9/);
  const s2 = await filler.next({ taskId: "dd2", goal: "solve this quiz", obs: { url: "http://d/", title: "T", elements: els, pageText: {} }, els, recent: [{ text: "form_input -> ok", ok: true }], generate: noModel });
  assert.notEqual(s2.actions && s2.actions[0] && s2.actions[0].action, "form_input", "question 2 was already on 42: no redundant form_input");
});

// ------------------------------------------------------------------------------------- written solutions (text boxes)
//
// Reported (screenshot): a "Written Solution Challenge" page - 30 problems, each with a big answer box named only by the SAME placeholder.
// Noah typed "Please provide the list of thirty questions you need me to solve ... I cannot see the questions in the empty notepad you
// have attached." into box 1 and left the other 29 empty ("1 / 30 answered"): the 30 boxes were merged into one "question" whose text was
// the placeholder, so the model was never shown a problem; and the reply was typed without any check that it was an answer.

const { looksLikeNonAnswer } = require("../../models/completion-guard.cjs");
const { looksLikeQuestionText } = require("../../perception/ax.cjs");

const PROBLEMS = [
  "1. Find the exact value of the improper integral from 0 to infinity of x²/(1+x⁴) dx. Show every substitution, convergence argument, and simplification, then give the final answer.",
  "2. Evaluate lim(x→0) [e^x − 1 − x − x²/2 − x³/6]/x⁴ using a rigorous expansion or repeated L’Hôpital differentiation.",
  "3. Prove that the series Σ 1/n² converges, and state its sum.",
];
const PLACEHOLDER = "Write your complete solution here…";
const writtenElements = (values = {}) => PROBLEMS.map((p, i) => ({ ref: `e${i * 2 + 2}`, role: "textbox", name: PLACEHOLDER, question: p, ctx: p.slice(0, 90), value: values[i], states: {}, rect: { x: 0, y: 200 + i * 170, width: 1000, height: 90 } }));
const REPORTED_JUNK = "Please provide the list of thirty questions you need me to solve. I am ready to work through the derivations, step-by-step calculations, and final answers for you immediately, but I cannot see the questions in the empty notepad you have attached. Once you paste the content of those problems into the text box or provide them here, I will generate the complete, detailed solutions.";

/** Drive the form module on the written page; `reply(prompt)` plays the model. Returns what was typed into which box. */
async function runWritten({ goal = "solve all these questions", reply, els = writtenElements() }) {
  const filler = new FormFiller();
  const typed = {};
  const prompts = [];
  const pages = [];
  let recent = [];
  let step;
  for (let guard = 0; guard < 30; guard++) {
    step = await filler.next({ taskId: "written", goal, obs: { url: "http://w/", title: "Written Solution Challenge", elements: els, pageText: { viewport: "" } }, els, recent, generate: async (p, page) => { prompts.push(p); pages.push(page); return reply(p, prompts.length); } });
    if (!step || step.status === "done" || step.status === "give_up") break;
    recent = [];
    for (const a of step.actions || []) {
      if (a.action === "type") { typed[a.target.ref] = a.text; const el = els.find((e) => e.ref === a.target.ref); if (el) el.value = a.text; }
      recent.push({ text: `${a.action} ${a.target && a.target.ref} -> ok`, ok: true });
    }
    if (step.summary === "Scrolling to see the rest of the form" || /Submitting/.test(step.summary)) break;
  }
  return { typed, prompts, pages, step };
}

test("WRITTEN: identical placeholders no longer merge - every box is its own question carrying its own problem", () => {
  const qs = extractQuestions(writtenElements());
  assert.equal(qs.length, 3);
  assert.deepEqual(qs.map((q) => q.label.slice(0, 3)), ["1. ", "2. ", "3. "]);
  assert.ok(qs.every((q) => q.kind === "text" && q.hint === PLACEHOLDER));
  assert.match(qs[0].label, /improper integral/);
});

test("WRITTEN: each problem is put to the model IN FULL (not the placeholder) and its answer goes in its own box", async () => {
  const { typed, prompts, pages } = await runWritten({ reply: (_p, n) => `Solution ${n}: by the substitution u = x², 2I = π/√2, so I = π/(2√2).` });
  assert.equal(prompts.length, 3, "one generation per problem - all three, not just the first");
  assert.match(prompts[0], /improper integral/);
  assert.match(prompts[1], /L’Hôpital/);
  assert.match(prompts[2], /Σ 1\/n²/);
  for (const p of prompts) assert.doesNotMatch(p, /Write your complete solution here/, "the placeholder is never presented as the question");
  for (const pg of pages) assert.doesNotMatch(pg, /notepad/i, "the model is not told it is looking at an empty notepad");
  assert.deepEqual(Object.keys(typed), ["e2", "e4", "e6"]);
});

test("WRITTEN: problems that are not marked 'required' are still answered when the goal is to solve them (they used to be skipped as optional)", async () => {
  const { typed } = await runWritten({ goal: "solve all these questions", reply: () => "The value is π/(2√2) by the substitution u = x²." });
  assert.equal(Object.keys(typed).length, 3);
});

test("WRITTEN: a reply that is not an answer (the reported 'please provide the questions') is never typed - it is retried, then used only if real", async () => {
  const replies = [REPORTED_JUNK, "By symmetry and the substitution u = 1/x the integral equals π/(2√2)."];
  let n = 0;
  const { typed, prompts } = await runWritten({ reply: () => replies[Math.min(n++, 1)] });
  assert.equal(typed.e2, "By symmetry and the substitution u = 1/x the integral equals π/(2√2).");
  assert.doesNotMatch(prompts[0], /Do NOT ask me/, "the first prompt is the normal one");
  assert.match(prompts[1], /Do NOT ask me for the question/, "the retry says so firmly");
});

test("WRITTEN: if the model keeps answering with something that is not an answer, Noah stops honestly and types nothing", async () => {
  const { typed, step } = await runWritten({ reply: () => REPORTED_JUNK });
  assert.equal(step.status, "give_up");
  assert.match(step.summary, /could not get a real answer/);
  assert.match(step.summary, /improper integral/);
  assert.deepEqual(typed, {}, "nothing was typed into any box");
});

test("RESUME: boxes that already hold text are skipped (a retry after a failure does not redo them); the model is asked only about the first EMPTY one", async () => {
  const els = writtenElements({ 0: "An answer typed before the failure.", 1: "Another one." });
  const { typed, prompts } = await runWritten({ reply: () => "Using the ratio test, |aₙ₊₁/aₙ| → 1/2 < 1, so the series converges and its sum is π²/6.", els });
  assert.equal(prompts.length, 1, "only the third problem needed generating");
  assert.match(prompts[0], /Prove that the series/);
  assert.deepEqual(Object.keys(typed), ["e6"]);
  assert.equal(els[0].value, "An answer typed before the failure.", "existing answers are left untouched");
});

test("RESUME: a value the GOAL supplies still overwrites a filled box (never keeps stale personal details)", async () => {
  const els = [{ ref: "t1", role: "textbox", name: "Full name", value: "Old Name", states: { required: true }, rect: { x: 0, y: 10, width: 200, height: 30 } },
               { ref: "t2", role: "textbox", name: "Email", states: {}, rect: { x: 0, y: 60, width: 200, height: 30 } }];
  const s = await new FormFiller().next({ taskId: "ov", goal: "fill this form, my name is Sam Lee", obs: { url: "http://f/", title: "F", elements: els, pageText: {} }, els, recent: [], generate: noModel });
  assert.equal(s.actions[0].text, "Sam Lee");
});

test("an OPTIONAL short field on a plain form is still skipped rather than filled with invented text", async () => {
  const els = [
    { ref: "t1", role: "textbox", name: "Full name", states: { required: true }, rect: { x: 0, y: 10, width: 200, height: 30 } },
    { ref: "t2", role: "textbox", name: "Notes", states: {}, rect: { x: 0, y: 60, width: 200, height: 30 } },
  ];
  const filler = new FormFiller();
  const goal = "fill this form, my name is Sam Lee";
  const s1 = await filler.next({ taskId: "opt", goal, obs: { url: "http://f/", title: "F", elements: els, pageText: {} }, els, recent: [], generate: noModel });
  assert.equal(s1.actions[0].action, "type");
  const s2 = await filler.next({ taskId: "opt", goal, obs: { url: "http://f/", title: "F", elements: els, pageText: {} }, els, recent: [{ text: "type t1 -> ok", ok: true }], generate: noModel });
  assert.match(s2.summary, /Skipping the optional question "Notes"/);
});

test("identity from the goal still fills a box by ITS OWN name even when a question was attached beside it", async () => {
  const els = [
    { ref: "t1", role: "textbox", name: "Full name", question: "Tell us about yourself", states: {}, rect: { x: 0, y: 10, width: 300, height: 30 } },
    { ref: "t2", role: "textbox", name: "Full name", question: "Who referred you?", states: {}, rect: { x: 0, y: 60, width: 300, height: 30 } },
  ];
  const s = await new FormFiller().next({ taskId: "id", goal: "fill this form up, my name is Sam Lee", obs: { url: "http://f/", title: "F", elements: els, pageText: {} }, els, recent: [], generate: noModel });
  assert.deepEqual(s.actions[0].text, "Sam Lee");
});

test("looksLikeNonAnswer: the reported reply, refusals and echoes are not answers; real working - even with 'cannot' in it - is", () => {
  const q = { question: PROBLEMS[0], hint: PLACEHOLDER };
  for (const t of [REPORTED_JUNK, "Please provide the questions.", "I cannot see the questions you are referring to.", "Sorry, I can't see any content on the page.", "I'm ready when you are - just paste the problems.", "", " ", PLACEHOLDER, PROBLEMS[0], "As an AI I cannot solve this."]) {
    assert.equal(looksLikeNonAnswer(t, q), true, JSON.stringify(t.slice(0, 50)));
  }
  for (const t of [
    "Substitute u = 1/x. Then I = ∫₀^∞ 1/(1+u⁴) du, so 2I = ∫₀^∞ (1+x²)/(1+x⁴) dx = π/√2. Hence I = π/(2√2).",
    "We cannot find an elementary antiderivative directly, so we use the residue theorem: the poles in the upper half plane are e^{iπ/4} and e^{3iπ/4}.",
  ]) {
    assert.equal(looksLikeNonAnswer(t, q), false, JSON.stringify(t.slice(0, 50)));
  }
  // short factual answers are fine for a question that does not ask for working
  assert.equal(looksLikeNonAnswer("42", { question: "What is 6 × 7?" }), false);
  assert.equal(looksLikeNonAnswer("Paris", { question: "What is the capital of France?" }), false);
});

test("looksLikeNonAnswer: the generic advice reported in box 6 is not a solution; nor is prose with no maths for a 'show all steps' problem", () => {
  const problem = "6. Solve the initial-value problem y'' − 4y' + 13y = 0, y(0)=2, y'(0)=1. Show the characteristic equation, general solution, constants, and final solution.";
  const REPORTED_ADVICE = "When you arrive at the final answer, make sure to clearly state it and provide any necessary explanations or derivations. This will demonstrate a thorough understanding of the concepts involved and ensure that your response is complete and accurate. Remember to double-check your work and consider the possibility of any potential errors before submitting your final answer.\n\nTaking the University Mathematics — 30 Question MCQ seriously and engaging with the problems thoughtfully will help you build your skills in mathematical problem-solving and critical thinking. Good luck!";
  assert.equal(looksLikeNonAnswer(REPORTED_ADVICE, { question: problem, hint: PLACEHOLDER }), true);
  assert.equal(looksLikeNonAnswer("First we find the roots and then combine them with the initial values to get the answer for the problem.", { question: problem }), true, "no equations at all");
  assert.equal(looksLikeNonAnswer("Characteristic equation: r² − 4r + 13 = 0, so r = 2 ± 3i. Then y = e²ˣ(A cos 3x + B sin 3x); y(0)=2 gives A = 2 and y'(0)=1 gives B = −1.", { question: problem }), false);
});

test("AMBIGUOUS boxes: if, mid-run, the problems can no longer be matched to their boxes, nothing is typed and nothing is submitted (the reported junk in box 6 and premature Submit)", async () => {
  const good = writtenElements();
  const submit = { ref: "e99", role: "button", name: "Submit Quiz", rect: { x: 0, y: 1500, width: 800, height: 40 } };
  const filler = new FormFiller();
  const goal = "solve all these questions";
  const obsOf = (els) => ({ url: "http://w/", title: "Quiz", elements: els, pageText: {} });
  let asked = 0;
  const generate = async () => (asked++, "By the substitution u = x², 2I = π/√2, so I = π/(2√2).");
  // 1) a healthy observation: the run starts and types the first answer
  const s1 = await filler.next({ taskId: "amb", goal, obs: obsOf([...good, submit]), els: [...good, submit], recent: [], generate });
  assert.equal(s1.actions[0].action, "type");
  assert.equal(asked, 1);
  // 2) the next observation is degraded: every box lost its problem (box 1 now holds its answer), and only the placeholder name is left
  const degraded = good.map((e, i) => ({ ...e, question: undefined, ctx: undefined, value: i === 0 ? "By the substitution ..." : undefined }));
  const steps = [];
  for (let n = 0; n < 6; n++) {
    const s = await filler.next({ taskId: "amb", goal, obs: obsOf([...degraded, submit]), els: [...degraded, submit], recent: n === 0 ? [{ text: "type e2 -> ok", ok: true }] : [{ text: "wait -> ok", ok: true }], generate });
    steps.push(s);
    if (!s || s.status === "give_up") break;
  }
  assert.equal(asked, 1, "the placeholder is never presented to the model as a question");
  assert.ok(steps.every((s) => !s || !s.actions || s.actions.every((a) => a.action === "wait")), "it only waits and looks again - nothing typed, and Submit is NOT clicked");
  const last = steps[steps.length - 1];
  assert.equal(last.status, "give_up");
  assert.match(last.summary, /could not tell which problem/);
});

test("AMBIGUOUS is not raised for a short OPTIONAL field that merely appears twice (two 'Notes' boxes on a registration form)", async () => {
  const els = [
    { ref: "t1", role: "textbox", name: "Full name", states: { required: true }, rect: { x: 0, y: 10, width: 200, height: 30 } },
    { ref: "t2", role: "textbox", name: "Notes", states: {}, rect: { x: 0, y: 60, width: 200, height: 30 } },
    { ref: "t3", role: "textbox", name: "Notes", states: {}, rect: { x: 0, y: 110, width: 200, height: 30 } },
  ];
  const filler = new FormFiller();
  const goal = "fill this form, my name is Sam Lee";
  const s1 = await filler.next({ taskId: "dupe", goal, obs: { url: "http://f/", title: "F", elements: els, pageText: {} }, els, recent: [], generate: noModel });
  assert.equal(s1.actions[0].action, "type");
  const s2 = await filler.next({ taskId: "dupe", goal, obs: { url: "http://f/", title: "F", elements: els, pageText: {} }, els, recent: [{ text: "type t1 -> ok", ok: true }], generate: noModel });
  assert.match(s2.summary, /Skipping the optional question "Notes"/);
});

test("AMBIGUOUS is only for boxes with NO attached problem: once each box has its problem the same boxes are answered normally", async () => {
  const els = writtenElements();
  assert.ok(extractQuestions(els).every((q) => !q.ambiguous));
});

// ---------------------------------------------------------------------------------- maths written the way a person writes it

const { toPlainMath } = require("../../models/math-text.cjs");

test("toPlainMath: the LaTeX from the reported answers becomes plain maths a person reads", () => {
  const cases = [
    ["$\\sum \\text{Res} = \\frac{1}{4\\sqrt{2}} (1 - i - 1 - i) = \\frac{-2i}{4\\sqrt{2}}$", "∑ Res = 1/(4√2) (1 - i - 1 - i) = (-2i)/(4√2)"],
    ["$\\int_{-\\infty}^{\\infty} \\frac{x^2}{1+x^4} dx = 2\\pi i \\left( \\frac{-i}{2\\sqrt{2}} \\right) = \\frac{\\pi}{\\sqrt{2}}$", "∫₋∞^∞ x²/(1+x⁴) dx = 2π i ((-i)/(2√2)) = π/√2"],
    ["$L = \\lim_{x \\to 0} \\frac{e^x - 1 - x}{x^2}$", "L = lim (x → 0) (eˣ - 1 - x)/x²"],
    ["$r = \\frac{4 \\pm \\sqrt{16 - 52}}{2} = 2 \\pm 3i$ and $y = e^{2x}(C_1 \\cos 3x + C_2 \\sin 3x)$", "r = (4 ± √(16 - 52))/2 = 2 ± 3i and y = e²ˣ(C₁ cos 3x + C₂ sin 3x)"],
    ["Since $\\sum_{n=1}^{\\infty} \\frac{1}{n^2}$ converges, $\\int_1^\\infty \\frac{dx}{x^2} = 1$.", "Since ∑ₙ₌₁^∞ 1/n² converges, ∫₁^∞ dx/x² = 1."],
    ["For $x \\in \\mathbb{R}$ and $\\epsilon > 0$: $|f(x) - f(a)| \\leq \\epsilon$.", "For x ∈ ℝ and ε > 0: |f(x) - f(a)| ≤ ε."],
    ["**Step 1.** Let $u = x^2$.", "Step 1. Let u = x²."],
  ];
  for (const [latex, plain] of cases) assert.equal(toPlainMath(latex), plain, latex);
});

test("toPlainMath: a fraction never changes meaning - denominators are one token or in brackets (1/4√2 would read as (1/4)·√2)", () => {
  assert.equal(toPlainMath("$\\frac{1}{4\\sqrt{2}}$"), "1/(4√2)");
  assert.equal(toPlainMath("$\\frac{\\pi}{2\\sqrt{2}}$"), "π/(2√2)");
  assert.equal(toPlainMath("$\\frac{a+b}{c+d}$"), "(a+b)/(c+d)");
  assert.equal(toPlainMath("$\\frac{2\\pi}{3}$"), "2π/3");
  assert.equal(toPlainMath("$\\frac{x^2}{2}$"), "x²/2");
  assert.equal(toPlainMath("$\\frac{1}{x^2+1}$"), "1/(x²+1)");
  assert.equal(toPlainMath("$\\sqrt{2x}$ and $\\sqrt{2}$"), "√(2x) and √2");
});

test("toPlainMath: a matrix keeps its rows and columns", () => {
  const out = toPlainMath("$A = \\begin{pmatrix} 2 & 1 \\\\ 0 & 2 \\end{pmatrix}$");
  assert.match(out, /^A =\n⎛ 2   1 ⎞\n⎝ 0   2 ⎠$/);
  assert.match(toPlainMath("$\\begin{bmatrix} 1 & 2 \\end{bmatrix}$"), /\[ 1   2 \]/);
});

test("toPlainMath: text without LaTeX is returned exactly as it was (money, code, prose)", () => {
  for (const t of ["plain text: 2 + 2 = 4, and it costs $5 and $6.", "x = a**b  # python power", "C:\\Users\\me\\file.txt", "Step 1: expand (x+1)^2 = x^2 + 2x + 1", ""]) {
    assert.equal(toPlainMath(t), t, JSON.stringify(t));
  }
});

test("the generation prompt asks for plain maths, and what the model returns is converted before it is typed", async () => {
  const { GENERATE_PROMPT: _unused } = {};
  const els = writtenElements();
  const prompts = [];
  const { typed } = await runWritten({ els, reply: (p) => (prompts.push(p), "The integral is $\\int_0^\\infty \\frac{x^2}{1+x^4} dx = \\frac{\\pi}{2\\sqrt{2}}$.") });
  assert.match(prompts[0], /Do NOT use LaTeX/);
  assert.match(prompts[0], /∫ ∑ √ π/);
  assert.equal(typed.e2, "The integral is ∫₀^∞ x²/(1+x⁴) dx = π/(2√2).");
  assert.ok(Object.values(typed).every((v) => !/[\\$]/.test(v)), "no LaTeX left in anything typed");
});

test("looksLikeQuestionText: problems and questions yes; field labels and section headings no", () => {
  for (const t of ["1. Find the exact value of the improper integral", "What is your name", "Explain the difference between a list and a tuple", "Why did you apply?", "A field label that is long enough to be a real sentence about something"]) assert.equal(looksLikeQuestionText(t), true, t);
  for (const t of ["Email", "Full name", "Registration", "Notes", "Your answer", "Phone number"]) assert.equal(looksLikeQuestionText(t), false, t);
});

// -------------------------------------------------------------------------------------------- reading the questions

test("extractQuestions: radios with no identifiable question are NOT turned into one-option 'questions' of their own", () => {
  const orphans = [1, 2, 3, 4].map((i) => ({ ref: `e${i}`, role: "radio", name: String(i * 10), states: {}, rect: { x: 0, y: i * 30, width: 13, height: 13 } }));
  assert.equal(extractQuestions(orphans).length, 0);
});

test("extractQuestions: the full question text (`question`) wins over a shortened accessibility group name (`ctx`)", () => {
  const full = "Find the exact value of the improper integral from 0 to infinity of e^(-x) dx and show every step";
  const els = ["1", "2"].map((name, i) => ({ ref: `e${i}`, role: "radio", name, ctx: full.slice(0, 50) + "…", question: full, states: {}, rect: { x: 0, y: i * 30, width: 13, height: 13 } }));
  const [q] = extractQuestions(els);
  assert.equal(q.label, full);
  assert.equal(q.options.length, 2);
});

test("extractQuestions: records which option is already selected", () => {
  const [q] = extractQuestions(quizElements(MATHS, { "0:42": true }));
  assert.deepEqual(q.options.map((o) => o.checked), [false, true, false, false]);
});

// --------------------------------------------------------------------------------------- what starts the form module

test("goal wording: a quiz/test/homework goal is a form task and asks for CORRECT answers; a survey or plain 'answer the questions' does not", () => {
  for (const g of ["solve this quiz", "take the test on this page", "answer the quiz", "attempt this exam", "do my homework", "select the correct answers", "solve all the questions"]) {
    assert.equal(looksLikeFormTask(g), true, g);
    assert.equal(looksLikeQuizTask(g), true, g);
  }
  for (const g of ["answer all the questions and submit the form", "fill this form up for me", "fill out the survey"]) {
    assert.equal(looksLikeFormTask(g), true, g);
    assert.equal(looksLikeQuizTask(g), false, g);
  }
  for (const g of ["search for pub quiz music on youtube", "open youtube and play the quiz show theme", "find the cheapest laptop", "test the website speed"]) {
    assert.equal(looksLikeFormTask(g), false, g);
  }
});

test("the form module now starts on 'solve this quiz' (it used to leave that page to a model that was not told which option belonged to which question)", async () => {
  const els = quizElements();
  const step = await new FormFiller().next({ taskId: "start", goal: "solve this quiz", obs: { url: "http://q/", title: "Quiz", elements: els, pageText: {} }, els, recent: [], generate: noModel });
  assert.ok(step && step.status === "continue");
});

// ------------------------------------------------------------------------------------ what the hosted server is sent

test("choiceGroups: options reach the server grouped under their question, with which one is selected", () => {
  const groups = choiceGroups(quizElements(MATHS, { "1:9": true }));
  assert.equal(groups.length, 5);
  assert.equal(groups[1].question, "2. What is 72 ÷ 8? *");
  assert.equal(groups[1].type, "choose_one");
  assert.deepEqual(groups[1].options.map((o) => o.text), ["7", "8", "9", "10"]);
  assert.deepEqual(groups[1].options.map((o) => o.checked), [false, false, true, false]);
  assert.match(groups[1].options[2].selector, /^\[data-noah-ref="e\d+"\]$/);
  assert.equal(choiceGroups([{ ref: "e1", role: "radio", name: "x", states: {} }]).length, 0, "an option with no question is not invented one");
});
