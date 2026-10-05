// Noah/experience/index.cjs - the one object the rest of Noah talks to.
"use strict";

const { ExperienceStore } = require("./store.cjs");
const { attachLearner, isCorrection } = require("./learner.cjs");
const { VOICE_GUIDE, experienceNote } = require("./guidance.cjs");
const { AREAS } = require("./advice.cjs");

const AREA_NAMES = { computer: "the Computer agent", web: "the Web agent", project: "project tasks", user: "how you react" };

/**
 * @param {object} o
 * @param {string} o.dir
 * @param {{ subscribe: Function }} o.bus
 * @param {() => (string|null)} [o.getAccountId]
 * @param {() => boolean} [o.isEnabled]
 */
function createExperience({ dir, bus, getAccountId, isEnabled, now }) {
  const store = new ExperienceStore({ dir, getAccountId, isEnabled, now });
  const detach = bus ? attachLearner({ bus, store }) : () => {};

  /** "What have you learned about me?": counts and the lessons, in plain words, and how to switch it off or forget it. */
  function describe() {
    const s = store.summary();
    const lines = [];
    if (!s.enabled) lines.push("Learning is switched off, so Noah is not adding anything now (the tick \"Learn from my tasks\" turns it on).");
    const tasks = AREAS.map((a) => ({ a, o: s.outcomes[a] })).filter((x) => x.o && (x.o.succeeded || x.o.other));
    if (!s.lessons.length && !tasks.length) lines.push("Nothing yet. Noah learns only from how its own tasks go (which known slips happened, and how tasks ended), never from what you write or what is on your screen.");
    else {
      if (tasks.length) lines.push("How tasks have ended: " + tasks.map((x) => `${AREA_NAMES[x.a]}: ${x.o.succeeded} finished, ${x.o.other} not`).join("; ") + ".");
      if (s.lessons.length) lines.push("Slips it has learned to avoid:\n" + s.lessons.map((l) => `- ${l.advice} (${l.n}x, ${AREA_NAMES[l.area]})`).join("\n"));
    }
    lines.push("All of this stays on this computer, belongs to your account only, and holds counts, never the things you wrote or opened. Say \"forget what you learned\" to erase it.");
    return lines.join("\n\n");
  }

  /** A message from the user, right after a task: if it corrects what Noah just did, count it. The words are looked at for yes or no and are never kept. */
  function hear(text) {
    try { if (isCorrection(text)) store.recordPitfall("user", "corrected"); } catch (_) { /* never breaks a command */ }
  }

  return {
    store,
    hear,
    /** The lessons block for a task in `area` (computer | web | project), or "". */
    note: (area) => experienceNote(store, area),
    voiceGuide: VOICE_GUIDE,
    describe,
    forget: () => store.forget(),
    detach,
  };
}

module.exports = { createExperience, VOICE_GUIDE, experienceNote };
