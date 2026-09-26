"use strict";
// Tier A scenarios (forms): what the agent PERCEIVES on a multiple-choice quiz / survey, in several independently-built markups.
// Deterministic (no model). The reported bug: on a quiz the model answered "option 1" for every question. Before asking whether a model
// can answer, check whether the agent even tells it which options belong to which question - that is what these scenarios pin down.
// (Whether the right option then gets CHOSEN is covered by test/unit/form-fill.test.cjs and the live quiz run.)

const { renderObservation } = require("../../agent/context.cjs");
const { extractQuestions } = require("../../models/form-fill.cjs");

const EXPECT = [
  ["6 × 7", ["36", "42", "48", "54"]],
  ["72 ÷ 8", ["7", "8", "9", "10"]],
  ["15 × 6", ["80", "90", "100", "110"]],
  ["9 + 8", ["14", "15", "16", "17"]],
  ["12 × 12", ["124", "132", "144", "156"]],
];

const QUIZ = [
  ["plain", "/quiz"],
  ["fieldset", "/quiz-fieldset"],
  ["aria", "/quiz-aria"],
  ["flat", "/quiz-flat"],
].map(([variant, path]) => ({
  id: "F-" + variant,
  category: "forms",
  name: `quiz (${variant} markup): every option is tied to its question`,
  async run(ctx) {
    await ctx.open(path);
    const obs = await ctx.observe({});
    const radios = obs.elements.filter((e) => e.role === "radio");
    const questions = extractQuestions(obs.elements);
    const seen = renderObservation({ observation: obs, nonce: "N" }).text;
    if (process.env.NOAH_PROBE) {
      console.log(`\n===== ${variant} =====`);
      console.log(seen.split("\n").filter((l) => /^e\d+ (radio|button|heading)/.test(l)).slice(0, 14).join("\n"));
      console.log("questions:", JSON.stringify(questions.map((q) => ({ label: q.label, options: q.options.map((o) => o.name) }))));
    }
    const grouped = radios.length === 20 && radios.every((r) => r.ctx && /^\d\. What is/.test(r.ctx));
    // 5 questions, each labelled with its own text, each with exactly its own 4 options - by name, in order (a bare "radio" fails this)
    const clean =
      questions.length === 5 &&
      questions.every((q, i) => q.label === `${i + 1}. What is ${EXPECT[i][0]}?` && JSON.stringify(q.options.map((o) => o.name)) === JSON.stringify(EXPECT[i][1]));
    return { pass: grouped && clean, details: `radios=${radios.length}, with question text=${radios.filter((r) => r.ctx).length}, questions found=${questions.length}; options: ${questions.map((q) => JSON.stringify(q.options.map((o) => o.name))).join(" ")}` };
  },
}));

const SURVEY = {
  id: "F-survey",
  category: "forms",
  name: "survey: identical Yes/No options and separately-named checkboxes keep their own question",
  async run(ctx) {
    await ctx.open("/survey");
    const obs = await ctx.observe({});
    const seen = renderObservation({ observation: obs, nonce: "N" }).text;
    const questions = extractQuestions(obs.elements);
    if (process.env.NOAH_PROBE) {
      console.log("\n===== survey =====");
      console.log(seen.split("\n").filter((l) => /^e\d+ (radio|checkbox|button)/.test(l)).join("\n"));
      console.log("questions:", JSON.stringify(questions.map((q) => ({ label: q.label, options: q.options.map((o) => o.name) }))));
    }
    // three questions all offering "Yes" and "No": each must still be its own line for the model (not "(+2 identical)")
    const yesLines = seen.split("\n").filter((l) => /^e\d+ radio "Yes"/.test(l));
    const collapsed = /identical/.test(seen);
    const ok =
      yesLines.length === 3 &&
      !collapsed &&
      questions.length === 4 &&
      questions.slice(0, 3).every((q) => q.options.length === 2) &&
      questions[3].options.length === 3 &&
      /Which languages/.test(questions[3].label);
    return { pass: ok, details: `"Yes" lines shown=${yesLines.length}, collapsed=${collapsed}, questions=${questions.length} (options: ${questions.map((q) => q.options.length).join(",")}), last="${questions[3] && questions[3].label}"` };
  },
};

// After the last answer and Submit, does the agent SEE the page's own confirmation? (A live run answered 5/5 correctly, then reported
// "could not confirm the form went through" although the page said "Thank you! Your score: 5/5".)
const SUBMIT = {
  id: "F-submit-seen",
  category: "forms",
  name: "quiz: after Submit the agent's observation shows the page's confirmation, and looksSubmitted agrees",
  async run(ctx) {
    const { looksSubmitted } = require("../../models/form-fill.cjs");
    await ctx.open("/quiz");
    const first = await ctx.observe({});
    const startUrl = first.url;
    // answer by clicking the right option of each question, by ref, the way the agent does
    const want = ["42", "9", "90", "17", "144"];
    for (let i = 0; i < 5; i++) {
      const obs = await ctx.observe({});
      const el = obs.elements.find((e) => e.role === "radio" && e.name === want[i]);
      if (!el) return { pass: false, details: `no radio "${want[i]}" for question ${i + 1}` };
      const r = await ctx.act({ action: "click", target: { type: "ref", ref: el.ref } });
      if (!r.ok) return { pass: false, details: `click on "${want[i]}" failed: ${r.message}` };
    }
    const before = await ctx.observe({});
    const submit = before.elements.find((e) => e.role === "button" && /^Submit$/i.test(e.name));
    const r = await ctx.act({ action: "click", target: { type: "ref", ref: submit.ref } });
    await ctx.sleep(400);
    const after = await ctx.observe({});
    // the confirmation is BELOW the visible area of this tall page, so it lives in the full page text, not the viewport text
    const shown = `${(after.pageText && after.pageText.viewport) || ""} ${(after.pageText && after.pageText.content) || ""}`;
    const seen = /thank you/i.test(shown);
    const submitted = looksSubmitted({ obs: after, urlBefore: startUrl, hadQuestions: true });
    if (process.env.NOAH_PROBE) console.log("submit click:", r.ok, r.message, "| viewport text tail:", JSON.stringify((after.pageText.viewport || "").slice(-160)), "| content tail:", JSON.stringify((after.pageText.content || "").slice(-120)), "| viewport", JSON.stringify(after.viewport));
    const score = await ctx.page("window.__score");
    return { pass: r.ok && seen && submitted && score === 5, details: `click ok=${r.ok} (${r.message}); confirmation visible to the agent=${seen}; looksSubmitted=${submitted}; page score=${score}` };
  },
};

// A native <select>: can the agent read its options? (The registration form's Country dropdown was skipped as "could not read its options".)
const SELECT = {
  id: "F-select",
  category: "forms",
  name: "registration form: a native <select> exposes its options to the agent",
  async run(ctx) {
    await ctx.open("/form");
    const obs = await ctx.observe({});
    const cands = obs.elements.filter((e) => /combobox|listbox|option|menulistoption|popupbutton/i.test(e.role) || /country/i.test(e.name || ""));
    if (process.env.NOAH_PROBE) console.log("select-ish elements:", JSON.stringify(cands.map((e) => ({ ref: e.ref, role: e.role, name: e.name, ctx: e.ctx, value: e.value, rect: !!e.rect }))));
    const q = extractQuestions(obs.elements).find((x) => x.kind === "listbox");
    return { pass: !!q && q.options.length >= 2, details: `listbox question=${q ? JSON.stringify(q.label) : "none"}, options read=${q ? q.options.length : 0} (${q ? q.options.map((o) => o.name).join(", ") : ""}); select-ish elements: ${cands.map((e) => e.role + ":" + (e.name || "")).join(" | ")}` };
  },
};

// A page of written-solution problems: each big answer box is named only by an identical placeholder. Reported: Noah typed a chat
// reply ("Please provide the list of thirty questions") into box 1 - it had never been shown the problem - and left the other 29 empty.
const WRITTEN = {
  id: "F-written",
  category: "forms",
  name: "written solutions: each answer box is tied to ITS OWN problem (not one merged question)",
  async run(ctx) {
    await ctx.open("/written");
    const obs = await ctx.observe({});
    const boxes = obs.elements.filter((e) => e.role === "textbox");
    const questions = extractQuestions(obs.elements);
    if (process.env.NOAH_PROBE) {
      console.log("\n===== written =====");
      console.log(renderObservation({ observation: obs, nonce: "N" }).text.split("\n").filter((l) => /^e\d+ (textbox|button)/.test(l)).join("\n"));
      console.log("questions:", JSON.stringify(questions.map((q) => ({ label: q.label.slice(0, 70), hint: q.hint, kind: q.kind }))));
    }
    const ok =
      boxes.length === 5 &&
      questions.length === 5 &&
      questions.every((q, i) => q.kind === "text" && new RegExp(`^${i + 1}\\. `).test(q.label)) &&
      /improper integral/.test(questions[0].label) && /L’Hôpital/.test(questions[1].label);
    return { pass: ok, details: `text boxes=${boxes.length}, questions found=${questions.length}: ${questions.map((q) => JSON.stringify(q.label.slice(0, 40))).join(" ")}` };
  },
};

// After a failed run is retried, the boxes already answered must be recognised as answered (the accessibility tree reports a typed box's
// value), so the retry carries on at the first EMPTY one instead of redoing - and re-generating - everything.
const RESUME = {
  id: "F-written-resume",
  category: "forms",
  name: "written solutions: boxes already holding text are recognised as answered, the next empty one is next",
  async run(ctx) {
    await ctx.open("/written");
    const first = await ctx.observe({});
    const boxes = first.elements.filter((e) => e.role === "textbox");
    for (const b of boxes.slice(0, 2)) {
      const r = await ctx.act({ action: "type", target: { type: "ref", ref: b.ref }, text: "An earlier answer that was already typed.", clear: true });
      if (!r.ok) return { pass: false, details: `typing setup failed: ${r.message}` };
    }
    const obs = await ctx.observe({});
    const qs = extractQuestions(obs.elements);
    const filled = qs.map((q) => q.filled);
    const { FormFiller } = require("../../models/form-fill.cjs");
    const asked = [];
    const step = await new FormFiller().next({ taskId: "resume", goal: "solve all these questions", obs, els: obs.elements, recent: [], generate: async (p) => { asked.push(p); return "Since 1/n² ≤ 1/(n(n−1)) = 1/(n−1) − 1/n, the partial sums are bounded by 2, so the series converges; its sum is π²/6."; } });
    const target = step && step.actions && step.actions[0] && step.actions[0].target && step.actions[0].target.ref;
    const third = obs.elements.filter((e) => e.role === "textbox")[2];
    const ok = JSON.stringify(filled) === JSON.stringify([true, true, false, false, false]) && asked.length === 1 && /Prove that the series/.test(asked[0]) && target === third.ref;
    return { pass: ok, details: `filled flags=${JSON.stringify(filled)}; first step targets ${target} (third box is ${third.ref}); model asked ${asked.length}x about: ${asked[0] ? JSON.stringify(asked[0].slice(40, 90)) : "-"}` };
  },
};

// A saved copy of the page from the reported run (30 problems, tall answer boxes, the injected "Powered by Netlify" iframe). Reported: Noah
// answered five problems, then typed the generic placeholder's "answer" into box 6 and pressed Submit with 24 boxes empty. Cause: every
// typed answer added ~90 text-fragment "interactive elements", the page passed the 380 whose position is measured, and the boxes below lost
// their geometry - and with it the problem they belong to. So: after long answers, the tree must stay small and every box keep its problem.
const TYPED = {
  id: "F-typed-answers",
  category: "forms",
  name: "30-problem page: after long answers are typed, the tree stays small and every box still knows its own problem",
  async run(ctx) {
    await ctx.open("/real-quiz");
    const LONG = "Step 1. State the definition and set up the problem carefully.\n".repeat(22);
    let last = null;
    for (let k = 0; k < 7; k++) {
      const o = await ctx.observe({});
      const boxes = o.elements.filter((e) => e.role === "textbox");
      const missing = boxes.filter((e) => !e.question).length;
      const looksLikeThePage = o.viewport.width > 400 && (o.pageText.content || "").length > 1000; // an embedded 197x64 badge frame is not the page
      last = `before box ${k + 1}: boxes=${boxes.length}, without a problem=${missing}, elements=${o.elements.length}, viewport=${o.viewport.width}x${o.viewport.height}, pageText=${(o.pageText.content || "").length} chars, questions=${extractQuestions(o.elements).length}`;
      if (boxes.length !== 30 || missing || !looksLikeThePage || o.elements.length > 90 || extractQuestions(o.elements).length !== 30) return { pass: false, details: last };
      const r = await ctx.act({ action: "type", target: { type: "ref", ref: boxes[k].ref }, text: LONG, clear: true });
      if (!r.ok) return { pass: false, details: `typing into box ${k + 1} failed: ${r.message}` };
    }
    return { pass: true, details: `7 long answers typed; ${last}` };
  },
};

// Diagnostic only (runs when NOAH_PROBE_URL is set): what the agent sees on a REAL page, box by box.
const REAL = {
  id: "F-real-url",
  category: "forms",
  name: "diagnostic: every text box of NOAH_PROBE_URL is tied to its own question",
  async run(ctx) {
    await ctx.open(process.env.NOAH_PROBE_URL);
    if (process.env.NOAH_PROBE_FAST) {
      // what the agent sees the instant navigation finishes, and how that settles
      for (let k = 0; k < 6; k++) {
        const o = await ctx.observe({});
        const b = o.elements.filter((e) => e.role === "textbox");
        console.log(`[real] t+${k * 400}ms loading=${o.loading} ready=${o.readyState} textboxes=${b.length} withQuestion=${b.filter((e) => e.question).length} questions=${extractQuestions(o.elements).length} viewportText=${JSON.stringify((o.pageText.viewport || "").slice(0, 70))} contentLen=${(o.pageText.content || "").length} scroll=${o.viewport.scrollY}/${o.viewport.scrollHeight}`);
        await ctx.sleep(400);
      }
    }
    if (process.env.NOAH_PROBE_TYPE) {
      // what the agent does: type a long answer into box N, observe straight away, then box N+1 ... and watch whether any box loses its question
      const LONG = "Step 1. State the definition and set up the problem carefully.\n".repeat(22);
      for (let k = 0; k < 7; k++) {
        const o = await ctx.observe({});
        const boxes = o.elements.filter((e) => e.role === "textbox");
        const missing = boxes.filter((e) => !e.question).map((e) => e.ref);
        const target = boxes[k];
        const dom = await ctx.page(`(() => { const t = document.querySelectorAll('textarea')[${k}]; const r = t.getBoundingClientRect(); return { scrollY: Math.round(scrollY), domY: Math.round(r.top), h: Math.round(r.height) }; })()`);
        const roles = {};
        for (const e of o.elements) roles[e.role] = (roles[e.role] || 0) + 1;
        console.log(`[real] tree: elements=${o.elements.length} withRect=${o.elements.filter((e) => e.rect).length} interactive=${o.elements.filter((e) => e.interactive).length} accessibilityTree=${JSON.stringify(o.accessibilityTree)} roles=${JSON.stringify(roles)}`);
        console.log(`[real] before typing box ${k + 1}: boxes=${boxes.length} withoutQuestion=${JSON.stringify(missing)} questions=${extractQuestions(o.elements).length} | target AX y=${target && target.rect ? Math.round(target.rect.y) : "-"} vs DOM y=${dom.domY} (scrollY=${dom.scrollY})`);
        const r = await ctx.act({ action: "type", target: { type: "ref", ref: target.ref }, text: LONG, clear: true });
        if (!r.ok) console.log("[real] type failed:", r.message);
      }
    }
    await ctx.sleep(1200);
    // scroll through the page the way the agent does, observing as it goes: a page can only be judged by what it exposes when scrolled
    const seen = new Map();
    for (let pass = 0; pass < 14; pass++) {
      const obs = await ctx.observe({});
      for (const e of obs.elements) if (e.role === "textbox") seen.set(e.ref, { ref: e.ref, name: (e.name || "").slice(0, 40), question: e.question ? e.question.slice(0, 60) : null, y: Math.round(e.rect ? e.rect.y + obs.viewport.scrollY : -1) });
      await ctx.act({ action: "scroll", direction: "down", amount: 600 }).catch(() => {});
      await ctx.sleep(150);
    }
    const obs = await ctx.observe({});
    const boxes = obs.elements.filter((e) => e.role === "textbox");
    const qs = extractQuestions(obs.elements);
    console.log(`\n[real] textboxes in the final observation: ${boxes.length}; with a question attached: ${boxes.filter((e) => e.question).length}; questions found: ${qs.length}; distinct refs seen while scrolling: ${seen.size}`);
    console.log("[real] boxes WITHOUT a question:", JSON.stringify(boxes.filter((e) => !e.question).map((e) => ({ ref: e.ref, name: (e.name || "").slice(0, 30), rect: e.rect && { y: Math.round(e.rect.y) } }))).slice(0, 700));
    console.log("[real] questions:", qs.map((q, i) => `${i + 1}:${q.label.slice(0, 26)}${q.filled ? " (filled)" : ""}`).join(" | ").slice(0, 900));
    return { pass: boxes.length > 0 && boxes.every((e) => e.question) && qs.length === boxes.length, details: `boxes=${boxes.length}, with question=${boxes.filter((e) => e.question).length}, questions=${qs.length}` };
  },
};

module.exports = [...QUIZ, SURVEY, SUBMIT, SELECT, WRITTEN, RESUME, TYPED, ...(process.env.NOAH_PROBE_URL ? [REAL] : [])];
