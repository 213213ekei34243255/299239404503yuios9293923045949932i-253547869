// Noah/agent/command-router.cjs
//
// THE command router. Voice transcripts, typed messages and UI commands all arrive here, and here they are turned into
// one of three things: a control on the running session (continue / stop / pause), an instruction for the agent session
// (with the session's context when it is a follow-up), or plain chat.
//
//   Text  ---+
//            +--> CommandRouter --> AgentSession --> NoahAgent (runs) --> BrowserController
//   Voice ---+
//
// There is exactly one router and one session, so "continue writing the story" spoken to the microphone reaches the same
// task, tab and page as the same words typed into the panel. Nothing here needs the user to activate anything first.

"use strict";

const { slog } = require("./lifecycle-log.cjs");
const { looksLikePageQuestion, looksLikeBrowserTask, looksLikeMissionTask, looksLikeDesktopTask, controlOf, isFollowUp, stripAgentModePhrase, stripAddress } = require("./intent.cjs");
const { COMPUTER_AGENT_UNAVAILABLE } = require("../autonomy/no-model.cjs");

// What Noah has learned from its own tasks (see Noah/experience): asked about and erased in plain words, answered here and never sent to a model.
const FORGET_LEARNED = /\b(forget|erase|clear|reset|delete|wipe)\b[^.?!]{0,40}\b(you(?:'ve| have)?\s+(?:learn(?:ed|t)|remember(?:ed)?)|your\s+(?:memory|experience|lessons))\b/i;
const SHOW_LEARNED = /\bwhat\b[^.?!]{0,25}\b(?:have|did)\s+you\s+(?:\w+\s+)?learn(?:ed|t)?\b|\bwhat\s+do\s+you\s+(?:remember|know)\s+about\s+me\b/i;

/** Words that say "the thing we were just doing" (so an otherwise self-contained command still continues the task). */
const REFERS_BACK = /\b(continue|next|more|again|longer|shorter|rest|the story|the text|it|that|same)\b/i;

class CommandRouter {
  /**
   * @param {object} o
   * @param {import('./session.cjs').AgentSession} o.session
   * @param {{ submit: Function, resume: Function, pause: Function, stop: Function }} o.agent
   * @param {import("../autonomy/service.cjs").MissionService} [o.missions]  long jobs on the user's own project (files, commands, tests); absent = none
   */
  constructor({ session, agent, missions = null, log = () => {}, experience = null }) {
    this.experience = experience;
    this.session = session;
    this.agent = agent;
    this.missions = missions;
    this.log = log;
  }

  /**
   * @param {string} input   what the user said or typed
   * @param {{ source?: 'voice'|'text'|'ui', mode?: 'auto'|'chat'|'web'|'computer'|'agent' }} [opts]
   *   mode is the user's explicit choice in the assistant panel: 'chat' = never act (just talk), 'web' = every message is a task in
   *   Jonah's browser, 'computer' = every message is a task on the apps of this computer, 'auto' (default) = the classifier below decides.
   *   ('agent' is the old name of 'web'.) The two agents are never mixed up: a web task is never sent to the computer agent, and the reverse. "stop"/"continue" controls work in
   *   every mode - they act on a session that is already running and never start anything.
   * @returns {{ handled: boolean, kind: 'agent'|'control'|'chat', id?: string, followUp?: boolean, control?: string, reply?: string }}
   */
  route(input, { source = "text", mode = "auto", ticket } = {}) {
    const raw = String(input || "").trim();
    slog(source === "voice" ? "VOICE_COMMAND_RECEIVED" : "TEXT_COMMAND_RECEIVED", { text: raw.slice(0, 120) });
    const { text: noMode, hadPhrase } = stripAgentModePhrase(stripAddress(raw));
    const text = noMode.trim();
    const session = this.session;

    if (!text) {
      // "turn on agentic mode" and nothing else: there is nothing to turn on
      return hadPhrase ? { handled: true, kind: "control", control: "noop", reply: "The agent is already on. Just tell me what to do." } : { handled: false, kind: "chat" };
    }

    if (this.experience) {
      if (FORGET_LEARNED.test(text)) { this.experience.forget(); return { handled: true, kind: "control", control: "memory", reply: "Done. I have forgotten what I had learned from your earlier tasks." }; }
      if (SHOW_LEARNED.test(text)) return { handled: true, kind: "control", control: "memory", reply: this.experience.describe() };
    }

    const recent = session.hasRecentTask();
    if (recent && this.experience) this.experience.hear(text); // a correction right after a task is something to learn from (only a yes or no is kept, never the words)

    // ---- controls: "continue", "stop", "pause" on their own
    const control = controlOf(text);
    const missions = this.missions;
    if (control && (session.isActive || recent || (missions && (missions.isRunning() || missions.canResume())))) return this._control(control, source); // stop must work whenever a project task runs, whatever the session thinks

    // ---- the user chose "Chat": talk, never act
    if (mode === "chat") return { handled: false, kind: "chat" };

    // ---- a job on the user's own project (files, commands, tests, git): a MISSION, not a browser task and not chat. A message that is
    // the ANSWER to a question the mission asked goes back to that mission. (Starting one asks the user for a folder first.)
    if (missions) {
      if (missions.awaitingAnswer() && !looksLikeMissionTask(text) && !looksLikeDesktopTask(text)) {
        const r = missions.answer(text, { source });
        return r.ok ? { handled: true, kind: "mission", id: r.id, followUp: true } : { handled: true, kind: "control", control: "answer", reply: r.reply };
      }
      if (missions.isAvailable() && looksLikeMissionTask(text)) {
        const r = missions.start(text, { source, ticket });
        return r.ok ? { handled: true, kind: "mission", id: r.id } : { handled: true, kind: "control", control: "mission", reply: r.reply };
      }
    }

    // ---- the user's own choice of agent. Web = a browser task, Computer = a task on this computer's apps. ("agent" is the old name of Web.)
    // The first real try of the computer agent, "open notepad on my Windows" in the old single Agent mode, was answered "I am a browser agent": one mode for two
    // different agents is what got mixed up, so each now has its own, and neither is ever chosen for the user once they have picked.
    // ---- a READ-ONLY question about the open page ("summarize this page", "what is this about"): chat answers it from the page's text - one read, no plan, no clicks.
    // (Web / Computer mode are the user's explicit choice of an agent and are left alone.)
    if (mode !== "web" && mode !== "agent" && mode !== "computer" && looksLikePageQuestion(text)) return { handled: false, kind: "chat" };

    const webMode = mode === "web" || mode === "agent";
    const computerMode = mode === "computer";
    const desktopReady = !!(missions && missions.isDesktopAvailable && missions.isDesktopAvailable());
    if (computerMode && !desktopReady) return { handled: true, kind: "control", control: "mission", reply: (missions && missions.desktop === false ? "The computer agent is not available on this system: it works on Windows and on macOS (Intel and Apple silicon)." : missions && typeof missions.requestModelAccess === "function" ? missions.requestModelAccess().reply : COMPUTER_AGENT_UNAVAILABLE) };
    if (webMode && desktopReady && looksLikeDesktopTask(text, { webChosen: true })) return { handled: true, kind: "control", control: "mode", reply: "That sounds like a job on an app on your computer, and the Web agent only works inside Jonah's browser. Switch to Computer agent (or Auto) and send it again." };

    // ---- a job on the apps of this computer ("open Notepad and write...", "in Excel make a table"): a computer task, with no folder to pick. In Computer mode every message is one.
    if (desktopReady && (computerMode || (!webMode && looksLikeDesktopTask(text)))) {
      const r = missions.start(text, { source, ticket, kind: "desktop" });
      return r.ok ? { handled: true, kind: "mission", id: r.id } : { handled: true, kind: "control", control: "mission", reply: r.reply };
    }

    // ---- instructions for the agent (a new task, or a follow-up to the one in front of us)
    const browsy = webMode || looksLikeBrowserTask(text);
    const follow = recent && isFollowUp(text);
    if (!browsy && !follow) return { handled: false, kind: "chat" };

    const followUp = recent && (follow || REFERS_BACK.test(text));
    const context = recent ? session.contextFor() : null;
    const id = this.agent.submit(text, { source, followUp, context });
    return { handled: true, kind: "agent", id, followUp };
  }

  _control(control, source) {
    const s = this.session;
    const missions = this.missions;
    if (control === "stop") {
      if (missions) missions.stop(); // a running task is stopped, a paused one is cancelled for good
      this.agent.stop();
      return { handled: true, kind: "control", control: "stop", reply: "Stopped." };
    }
    if (control === "pause") {
      // a project task cannot freeze mid-command: pausing it stops the running command and keeps the task, ready to continue
      if (missions && missions.isRunning()) {
        missions.pause();
        return { handled: true, kind: "control", control: "pause", reply: 'Pausing the project task: its progress is saved. Say "continue" to carry on.' };
      }
      if (s.isActive) this.agent.pause();
      return { handled: true, kind: "control", control: "pause", reply: "Paused." };
    }
    // resume / continue: a project task that is waiting (or saved from before a restart) comes first
    if (missions && !missions.isRunning() && missions.canResume()) {
      const r = missions.resume({ source });
      return { handled: true, kind: "control", control: "resume", reply: r.ok ? "Continuing the project task." : r.reply };
    }
    if (missions && missions.isRunning()) return { handled: true, kind: "control", control: "resume", reply: "Already working on it." };
    if (s.executionState === "paused" || s.executionState === "waiting_for_user") {
      const r = this.agent.resume();
      if (r && r.reason === "needs_confirmation") return { handled: true, kind: "control", control: "resume", reply: "That needs your OK on the confirmation card. I will not approve it for you." };
      return { handled: true, kind: "control", control: "resume", reply: "Continuing." };
    }
    if (s.isActive) return { handled: true, kind: "control", control: "resume", reply: "Already working on it." };
    // nothing is running: "continue" means "carry on with what we were doing", as a new run inside this same session
    const text = s.task && s.task.goal ? `Continue with what we were doing: ${s.task.goal}` : "continue with the previous task";
    const id = this.agent.submit(text, { source, followUp: true, context: s.contextFor() });
    return { handled: true, kind: "agent", id, followUp: true };
  }
}

module.exports = { CommandRouter };
