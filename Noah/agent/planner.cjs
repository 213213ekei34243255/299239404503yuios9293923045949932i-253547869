// Noah/agent/planner.cjs
//
// Task analysis + plan (spec §9/§14). Two stages:
//   1. triage(goal): free, instant heuristics classify the goal (trivial navigation vs multi-step;
//      sensitive; likely visual). Trivial goals skip the planner model entirely (latency + cost).
//   2. plan(goal): a single call to the `planner` role model returns a short structured plan.
// A failed planner call is never fatal: Noah proceeds with a one-step plan and the browser model
// plans as it goes.

"use strict";

const { PLANNER_SYSTEM, PLAN_TOOL } = require("./prompts.cjs");

const SENSITIVE = /\b(buy|purchase|order|pay|payment|checkout|check out|book|reserve|subscribe|donat\w*|transfer|wire|login|log in|log into|sign in|sign into|password|bank\w*|credit card|card number|send (an? )?(e-?mail|message|dm)|reply|post|publish|tweet|delete|remove|cancel|invoice|refund|account settings|unsubscribe)\b/i;
const VISUAL = /\b(google docs?|docs\.google|google sheets?|sheets\.google|google slides?|slides\.google|spreadsheet|slide deck|presentation|figma|canva|whiteboard|miro|excalidraw|photoshop|draw|drawing|design (file|tool)|canvas|drag (and|&) drop|move the .* (to|onto)|resize|game|map)\b/i;
const TRIVIAL = /^\s*(please\s+)?(go to|goto|open|visit|navigate to|take me to|search( for| google for)?|google)\b/i;
const MULTI = /\b(and then|then|after that|compare|cheapest|best|list|summar\w+|research|find (me )?(the|a|an|all)|under|below|between|at least|sort|filter|log ?in|fill|download|upload|save|update|create)\b/i;

function triage(goal) {
  const g = String(goal || "").trim();
  const trivial = g.length <= 90 && TRIVIAL.test(g) && !MULTI.test(g);
  return { trivial, sensitive: SENSITIVE.test(g), needsVisual: VISUAL.test(g), complexity: trivial ? "trivial" : g.length > 160 || MULTI.test(g) ? "complex" : "simple" };
}

class Planner {
  constructor({ router, log = () => {} }) {
    this.router = router;
    this.log = log;
  }

  async plan(goal, { signal, sensitive = false } = {}) {
    const t = triage(goal);
    if (t.trivial) {
      return { plan: { objective: goal, complexity: "trivial", steps: [goal], success_criteria: [], sensitive: t.sensitive, needs_visual: false, sites: [], source: "heuristic" }, usage: null, calls: 0 };
    }
    try {
      const res = await this.router.call(
        "planner",
        {
          system: PLANNER_SYSTEM,
          messages: [{ role: "user", content: [{ type: "text", text: `<user_task>\n${goal}\n</user_task>\nCall noah_plan.` }] }],
          tools: [PLAN_TOOL],
          toolChoice: "noah_plan",
          maxTokens: 700,
          signal,
          timeoutMs: 45_000,
          meta: { goal, kind: "plan" },
        },
        { sensitive, signal }
      );
      const call = res.toolCalls.find((c) => c.name === "noah_plan") || res.toolCalls[0];
      const a = call?.args || {};
      const plan = {
        objective: String(a.objective || goal).slice(0, 300),
        complexity: ["trivial", "simple", "complex"].includes(a.complexity) ? a.complexity : t.complexity,
        steps: Array.isArray(a.steps) ? a.steps.map((s) => String(s).slice(0, 200)).slice(0, 8) : [],
        success_criteria: Array.isArray(a.success_criteria) ? a.success_criteria.map((s) => String(s).slice(0, 200)).slice(0, 3) : [],
        sensitive: !!a.sensitive || t.sensitive,
        needs_visual: !!a.needs_visual || t.needsVisual,
        sites: Array.isArray(a.sites) ? a.sites.map((s) => String(s).slice(0, 80)).slice(0, 5) : [],
        source: `${res.provider}:${res.modelId}`,
      };
      return { plan, usage: res.usage, calls: 1 };
    } catch (err) {
      if (err.code === "aborted") throw err;
      this.log("planner failed, continuing with a one-step plan:", err.message);
      return { plan: { objective: goal, complexity: t.complexity, steps: [goal], success_criteria: [], sensitive: t.sensitive, needs_visual: t.needsVisual, sites: [], source: "fallback" }, usage: null, calls: 0, error: err.message };
    }
  }
}

module.exports = { Planner, triage };
