// Noah/agent/perception-policy.cjs
//
// Hybrid perception selection (spec §8/§31): the agent does NOT always use screenshots and is not
// DOM-only. Per step it decides how much of each layer to gather:
//
//   text    AX element list + visible text          cheapest, deterministic       (default)
//   hybrid  + screenshot                            when semantic info is not enough
//   vision  screenshot-first, deep scan of clickables   canvas/drawn UIs
//
//   DOM available and reliable?  -> text.   Not enough?  -> screenshot.   Nothing usable? -> scroll/ask.
//
// Inputs are all observable facts (previous observation hints, last results, model's own request),
// never a model call, so this decision costs nothing.

"use strict";

function choose({ configMode = "auto", previousObs, lastAssessment, needVisual, pendingZoom, forceVisualOnce, step }) {
  if (configMode === "text") return { screenshot: false, deep: false, reason: "configured: text only" };
  if (configMode === "hybrid" || configMode === "vision") return { screenshot: true, deep: configMode === "vision", reason: `configured: ${configMode}` };

  const reasons = [];
  if (step <= 1 && previousObs?.hints?.preferVision) reasons.push("page looks drawn/canvas-based");
  if (previousObs?.hints?.preferVision) reasons.push(...previousObs.hints.reasons.slice(0, 1));
  if (needVisual) reasons.push("model requested a screenshot");
  if (forceVisualOnce) reasons.push("recovering from a failed/no-effect action");
  if (lastAssessment?.forceVisual) reasons.push("last action needs visual confirmation");
  if (pendingZoom) reasons.push("zoom requested");

  if (reasons.length) {
    const drawn = !!previousObs?.hints?.preferVision;
    return { screenshot: true, deep: drawn || !!lastAssessment?.forceVisual, reason: [...new Set(reasons)].join("; ") };
  }
  return { screenshot: false, deep: false, reason: "semantic (AX) info is sufficient" };
}

module.exports = { choose };
