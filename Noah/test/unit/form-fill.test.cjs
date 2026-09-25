// Noah/test/unit/form-fill.test.cjs
//
// Reported bug (round 1): "go to this website and then answer all the questions on the google form scroll and check
// and then submit it as well my name is Shaun Sunil and email id is ..." reached the real form, filled in two fields,
// then got confused and started re-navigating to the same form URL in a loop, never answering the rest or submitting.
//
// Reported bug (round 2, user feedback after the fix): "now u only made for google this model will fail when it
// comes to other forms clearly it will everyone knows that" - correct. The first version hard-coded Google's own
// markup (its URL, its "Required question" text, its confirmation page). This file proves the rewritten module
// (models/form-fill.cjs) is NOT Google-specific: it is tested against TWO independently-shaped forms -
//   FORM A: a real Google Form's accessibility tree (radiogroup/textbox names, "Required question" suffix,
//            "Submit" button, navigates to a distinct confirmation page)
//   FORM B: a plain hand-written HTML form (Noah/bench/fixtures.cjs `/form`): a <fieldset><legend> radio group, a
//            <select> dropdown, a lone checkbox, NO explicit "required" marking at all, a button literally labelled
//            "Register" (not "Submit"), a password field that must never be touched, and a confirmation that is a
//            result LINE APPEARING ON THE SAME PAGE (the form itself never disappears) - deliberately as different
//            from Google's shape as a real second form is likely to be.
// The SAME module, with no per-site code, handles both.

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { FormFiller, identityFrom, extractQuestions, looksLikeAForm, looksSubmitted, isSecretField, SUBMIT_LABEL } = require("../../models/form-fill.cjs");

const GOAL = "Go to this website and then answer all the questions on the google form scroll and check and then submit it as well my name is Shaun Sunil and email id is abrahamshaunsunil@gmail.com";

const radio = (ref, name, ctx, y, states) => ({ ref, role: "radio", name, ctx, states, rect: { x: 0, y, width: 20, height: 20 } });
const checkbox = (ref, name, ctx, y, states) => ({ ref, role: "checkbox", name, ctx, states, rect: { x: 0, y, width: 20, height: 20 } });
const textbox = (ref, name, y, states) => ({ ref, role: "textbox", name, states, rect: { x: 0, y, width: 400, height: 30 } });
const combobox = (ref, name, y) => ({ ref, role: "combobox", name, rect: { x: 0, y, width: 200, height: 30 } });
const button = (ref, name, y) => ({ ref, role: "button", name, rect: { x: 0, y, width: 100, height: 30 } });
const obsAt = (url, elements, extra = {}) => ({ url, title: "Form", elements, pageText: { viewport: "" }, ...extra });

// ================================================================================================== FORM A: Google

const FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSc9MrvjWOr-iNrVmoiwfVvpuxDL9qj4n2LuCwt4jZaeBrbH5w/viewform";
const A_SCREEN_1 = [
  ...["Comments", "Questions", "Bug Reports", "Feature Request"].map((n, i) => radio(`r${i}`, n, "Feedback Type", 100 + i * 30)),
  textbox("t1", "Feedback Required question", 260),
];
const A_SCREEN_2 = [
  textbox("t2", "Suggestions for improvement", 300),
  ...["1", "2", "3", "4", "5"].map((n, i) => radio(`s${i}`, n, "Will you recommend Jonah to a friend? Required question", 400 + i * 30)),
  textbox("t3", "Name", 600),
  textbox("t4", "Email", 640),
];
const A_SUBMIT = button("b1", "Submit", 700);

// ============================================================================================ FORM B: plain HTML

// Mirrors Noah/bench/fixtures.cjs `/form`: name, email, a <select> country dropdown, a lone checkbox, a
// <fieldset><legend>Plan</legend> radio group (Basic/Pro), a Notes textarea, a password field, "Register" button.
const B_URL = "http://127.0.0.1:5999/form";
// Verified live: Chromium exposes a native <select>'s own <option>s in the accessibility tree even while it is
// closed - as "MenuListOption" children, not always carrying the combobox's own name as their `ctx`.
const B_COUNTRY_OPTIONS = [
  { ref: "co0", role: "MenuListOption", name: "Choose…", rect: { x: 0, y: 140, width: 200, height: 20 } },
  { ref: "co1", role: "MenuListOption", name: "India", rect: { x: 0, y: 140, width: 200, height: 20 } },
  { ref: "co2", role: "MenuListOption", name: "Spain", rect: { x: 0, y: 140, width: 200, height: 20 } },
];
const B_ELEMENTS = [
  textbox("n1", "Full name", 60),
  textbox("n2", "Email", 100),
  combobox("n3", "Country", 140),
  ...B_COUNTRY_OPTIONS,
  checkbox("n4", "I agree to the terms", "I agree to the terms", 180),
  ...["Basic", "Pro"].map((n, i) => radio(`p${i}`, n, "Plan", 220 + i * 30)),
  textbox("n5", "Notes", 300),
  { ref: "pw1", role: "textbox", name: "Password", secret: true, rect: { x: 0, y: 340, width: 200, height: 30 } },
];
const B_SUBMIT = button("reg1", "Register", 400);

test("identityFrom pulls name/email out of a casual sentence", () => {
  const id = identityFrom(GOAL);
  assert.equal(id.name, "Shaun Sunil");
  assert.equal(id.email, "abrahamshaunsunil@gmail.com");
});

test("required-ness comes from the REAL accessibility state first (works on any standards-built form), Google's text suffix and a trailing '*' as fallbacks for sites that only mark it visually", () => {
  const viaState = extractQuestions([textbox("x1", "Full name", 10, { required: true })]);
  assert.equal(viaState[0].required, true);
  assert.equal(viaState[0].label, "Full name", "the state, not text, carried the signal - label has no suffix to strip");

  const viaGoogleText = extractQuestions([textbox("x2", "Feedback Required question", 10)]);
  assert.equal(viaGoogleText[0].required, true);
  assert.equal(viaGoogleText[0].label, "Feedback");

  const viaAsterisk = extractQuestions([textbox("x3", "Full name *", 10)]);
  assert.equal(viaAsterisk[0].required, true);
  assert.equal(viaAsterisk[0].label, "Full name");

  const notRequired = extractQuestions([textbox("x4", "Notes", 10)]);
  assert.equal(notRequired[0].required, false);
});

test("a password/secret field is never extracted as a question to answer, on either form", () => {
  assert.equal(isSecretField({ role: "textbox", name: "Password", secret: true }), true);
  const qs = extractQuestions(B_ELEMENTS);
  assert.ok(!qs.some((q) => /password/i.test(q.label)), "the password field must not appear as an answerable question");
});

test("SUBMIT_LABEL recognises common finishing buttons across different sites, not only the literal word 'Submit'", () => {
  for (const label of ["Submit", "Register", "Send", "Continue", "Finish", "Sign up", "Create account", "Submit response"]) {
    assert.equal(SUBMIT_LABEL.test(label), true, label);
  }
  assert.equal(SUBMIT_LABEL.test("Clear form"), false);
  assert.equal(SUBMIT_LABEL.test("Learn more"), false);
});

test("looksLikeAForm requires more than one lone field (a bare search box is not a form)", () => {
  assert.equal(looksLikeAForm([textbox("s1", "Search", 10)]), false);
  assert.equal(looksLikeAForm(B_ELEMENTS), true);
  assert.equal(looksLikeAForm(A_SCREEN_1), true);
});

test("looksSubmitted: Google's own confirmation URL, OR a same-page result line (form B's shape), OR a changed URL - but NOT a bare, ambiguous page with the form still fully present", () => {
  assert.equal(looksSubmitted({ obs: { url: FORM_URL.replace("viewform", "formResponse"), title: "", pageText: {} }, urlBefore: FORM_URL, hadQuestions: true }), true);
  assert.equal(looksSubmitted({ obs: { url: B_URL, title: "Form", pageText: { viewport: "Registered: {\"name\":\"Shaun\"}" } }, urlBefore: B_URL, hadQuestions: true }), true, "a same-page confirmation LINE, no navigation at all");
  assert.equal(looksSubmitted({ obs: { url: FORM_URL, title: "Feedback", pageText: { viewport: "Feedback Type" }, elements: A_SCREEN_1 }, urlBefore: FORM_URL, hadQuestions: true }), false, "the form is still fully there: not submitted");
});

test("a page that is not a form task, or does not look like a form, is left alone (returns null)", async () => {
  const filler = new FormFiller();
  assert.equal(await filler.next({ taskId: "x1", goal: "search for laptops", obs: obsAt("https://example.com/", B_ELEMENTS), els: B_ELEMENTS, recent: [], generate: async () => "" }), null, "the goal never asked for a form");
  assert.equal(await filler.next({ taskId: "x2", goal: GOAL, obs: obsAt("https://example.com/", [textbox("s1", "Search", 10)]), els: [textbox("s1", "Search", 10)], recent: [], generate: async () => "" }), null, "the page is not a form");
});

// ============================================================================================================ FORM A

test("FORM A (Google): the full reported scenario end to end - every question answered once, scrolls for the rest, submits only once nothing required is left, verified from the page's own confirmation", async () => {
  const filler = new FormFiller();
  const taskId = "formA";
  let obs = obsAt(FORM_URL, A_SCREEN_1);
  let recent = [];
  const order = [];
  const generate = async () => "Thanks, loving it so far!";
  let step;
  for (let guard = 0; guard < 40; guard++) {
    step = await filler.next({ taskId, goal: GOAL, obs, els: obs.elements, recent, generate });
    assert.ok(step, "keeps handling every step until truly done");
    if (step.status === "done") break;
    assert.notEqual(step.status, "give_up", step.summary);
    order.push(step.summary);
    const a = step.actions[step.actions.length - 1];
    recent = [{ text: `${a.action} -> ok`, ok: true }];
    if (a.action === "scroll") obs = obsAt(FORM_URL, [...A_SCREEN_1, ...A_SCREEN_2, A_SUBMIT]);
    else if (step.summary === "Submitting the form") obs = obsAt(FORM_URL.replace("viewform", "formResponse"), [], { pageText: { viewport: "Your response has been recorded." } });
  }
  assert.equal(step.status, "done");
  assert.match(step.result, /Submitted the form/);
  for (const label of ["Feedback Type", "Feedback", "recommend Jonah", "Name", "Email"]) assert.ok(order.some((s) => s.includes(label)), label);
  assert.ok(order.includes("Submitting the form"));
  const answers = order.filter((s) => s.startsWith("Answering"));
  assert.equal(new Set(answers).size, answers.length, "no question answered twice: " + JSON.stringify(order));
});

// ============================================================================================================ FORM B

test("FORM B (plain HTML, no Google markup at all): fills name/email from the goal, opens the dropdown, checks the lone checkbox, picks the first Plan option, SKIPS the optional Notes field, never touches Password, clicks 'Register' (not 'Submit'), and only reports done once the page's own result line appears", async () => {
  const filler = new FormFiller();
  const taskId = "formB";
  const goalB = "fill this form up for me email id - abrahamshaunsunil@gmail.com name - Shaun Sunil";
  let obs = obsAt(B_URL, [...B_ELEMENTS, B_SUBMIT]);
  let recent = [];
  const order = [];
  const generate = async () => { throw new Error("must not need to generate anything on this form"); };
  let step;
  for (let guard = 0; guard < 30; guard++) {
    step = await filler.next({ taskId, goal: goalB, obs, els: obs.elements, recent, generate });
    assert.ok(step, "keeps handling every step");
    if (step.status === "done") break;
    assert.notEqual(step.status, "give_up", step.summary);
    order.push({ summary: step.summary, action: step.actions[0] });
    const a = step.actions[step.actions.length - 1];
    recent = [{ text: `${a.action} -> ok`, ok: true }];
    if (step.summary === "Submitting the form") {
      // the form stays on the page; a result line appears - exactly form B's real behaviour, unlike Google's
      obs = obsAt(B_URL, [...B_ELEMENTS, B_SUBMIT], { pageText: { viewport: 'Registered: {"name":"Shaun Sunil"}' } });
    }
  }
  assert.equal(step.status, "done", step && step.summary);
  assert.match(step.result, /Submitted the form/);

  const answered = order.filter((o) => o.summary.startsWith("Answering")).map((o) => o.summary);
  assert.ok(answered.some((s) => s.includes("Full name")));
  assert.ok(answered.some((s) => s.includes("Email")));
  assert.ok(answered.some((s) => s.includes("I agree to the terms")), "the lone checkbox is a one-option question");
  assert.ok(answered.some((s) => s.includes("Plan")));
  const countryStep = order.find((o) => o.summary === 'Answering "Country"');
  assert.ok(countryStep, "the dropdown is actually answered, not just opened and abandoned");
  assert.equal(countryStep.action.action, "form_input", "a value is set directly, not clicked-open-and-guessed");
  assert.equal(countryStep.action.value, "India", "the real placeholder option ('Choose…') is never picked");
  assert.ok(order.some((o) => /Skipping the optional question "Notes"/.test(o.summary)), "an optional open-ended field with nothing to say is skipped, not invented");
  assert.ok(!order.some((o) => /password/i.test(o.summary)), "the password field is never touched");
  assert.ok(order.some((o) => o.summary === "Submitting the form" && o.action.target.ref === "reg1"), "clicked the button literally labelled 'Register', not one literally named 'Submit'");
});

test("FORM B: a submit click that has no confirming effect is NOT reported as done - it waits briefly, then gives an honest message", async () => {
  const filler = new FormFiller();
  const taskId = "formB-nosubmit";
  const answeredEls = [...B_ELEMENTS, B_SUBMIT];
  const goalB = "fill this form up for me name - Shaun Sunil email id - abrahamshaunsunil@gmail.com";
  // Prime: answer everything by pretending each step already succeeded, fast-forwarding straight to the submit click.
  let obs = obsAt(B_URL, answeredEls);
  let recent = [];
  let step;
  for (let i = 0; i < 20; i++) {
    step = await filler.next({ taskId, goal: goalB, obs, els: obs.elements, recent, generate: async () => "ok" });
    if (!step || step.summary === "Submitting the form") break;
    recent = [{ text: "ok", ok: true }];
  }
  assert.equal(step.summary, "Submitting the form");
  // The click "succeeds" (ok:true) but the page shows NOTHING that looks like a confirmation - must not claim success.
  let last;
  for (let i = 0; i < 6; i++) {
    last = await filler.next({ taskId, goal: goalB, obs, els: obs.elements, recent: [{ text: "click -> ok", ok: true }], generate: async () => "ok" });
    if (!last || last.status === "give_up") break;
  }
  assert.notEqual(last && last.status, "done", "no confirming evidence appeared, so it must not claim the form was submitted");
});
