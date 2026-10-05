// Noah/experience/learner.cjs
//
// Learns from the events Noah's own tasks already publish: it listens on the app's event bus and counts known slips (a failed call with a code from advice.cjs) and how
// tasks ended. It reads ONLY tool names, error codes and end statuses; it never looks at arguments, results, page text, goals, answers or anything the user or a page wrote.
// Adding it changes nothing else: if it is switched off, or fails, tasks run exactly as before.
"use strict";

const { isKnown } = require("./advice.cjs");

/**
 * Does this message correct what Noah just did ("no, I meant...", "that's wrong", "I said...")? Read only to SAY YES OR NO: the words are never kept. A heuristic, so it only looks at how a
 * message BEGINS, in English and Hinglish, and leaves out "no problem" and "no worries".
 */
const CORRECTION = /^\s*(?:no\b(?!\s+(?:problem|worries|rush|need|thanks|thank))|nope\b|nah\b|wrong\b|incorrect\b|that(?:'s| is| was) (?:not|wrong|incorrect)\b|not (?:that|what)\b|you (?:misunderstood|got (?:it|that) wrong|didn'?t|did not)\b|i (?:said|meant|asked|told you)\b|galat\b|nahi\b|nahin\b)/i;
const isCorrection = (text) => typeof text === "string" && text.length <= 2000 && CORRECTION.test(text);

/**
 * @param {{ subscribe: (fn: (evt: any) => void) => () => void }} bus
 * @param {import("./store.cjs").ExperienceStore} store
 * @returns {() => void} detach
 */
function attachLearner({ bus, store }) {
  let missionArea = "project"; // what the running mission is: set when it starts
  const slip = (area, code) => { try { if (isKnown(area, code)) store.recordPitfall(area, code); } catch (_) { /* never breaks a task */ } };
  const ended = (area, ok) => { try { store.recordOutcome(area, ok); } catch (_) { /* never breaks a task */ } };

  return bus.subscribe((evt) => {
    try {
      if (!evt || typeof evt.event !== "string") return;
      switch (evt.event) {
        // ---- a mission (the Computer agent, or a project task)
        case "mission_started": missionArea = evt.desktop ? "computer" : "project"; break;
        case "mission_round":
          for (const c of Array.isArray(evt.calls) ? evt.calls : []) {
            if (!c || c.ok || typeof c.code !== "string") continue;
            slip(typeof c.tool === "string" && c.tool.startsWith("desktop_") ? "computer" : missionArea, c.code);
          }
          break;
        case "mission_result": // (the sign-in notices use this event too: they are not a task)
          if (evt.missionId !== "sign-in" && typeof evt.status === "string") ended(missionArea, evt.status === "succeeded");
          if (evt.missionId !== "sign-in" && evt.status === "cancelled" && evt.text === "Stopped.") slip("user", "stopped"); // the user pressed Stop (or said stop)
          break;
        // ---- the browser agent
        case "action_result":
          if (evt.ok === false && typeof evt.code === "string") slip("web", evt.code);
          else if (evt.verdict === "no_effect") slip("web", "no_effect");
          break;
        case "task_finished":
          if (!evt.superseded && typeof evt.status === "string" && evt.status !== "cancelled") ended("web", evt.status === "completed");
          if (!evt.superseded && evt.status === "cancelled") slip("user", "stopped");
          break;
        default: break;
      }
    } catch (_) { /* never breaks a task */ }
  });
}

module.exports = { attachLearner, isCorrection };
