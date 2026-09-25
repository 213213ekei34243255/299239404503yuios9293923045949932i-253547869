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
const { looksLikeBrowserTask, controlOf, isFollowUp, stripAgentModePhrase, stripAddress } = require("./intent.cjs");

/** Words that say "the thing we were just doing" (so an otherwise self-contained command still continues the task). */
const REFERS_BACK = /\b(continue|next|more|again|longer|shorter|rest|the story|the text|it|that|same)\b/i;

class CommandRouter {
  /**
   * @param {object} o
   * @param {import('./session.cjs').AgentSession} o.session
   * @param {{ submit: Function, resume: Function, pause: Function, stop: Function }} o.agent
   */
  constructor({ session, agent, log = () => {} }) {
    this.session = session;
    this.agent = agent;
    this.log = log;
  }

  /**
   * @param {string} input   what the user said or typed
   * @param {{ source?: 'voice'|'text'|'ui', mode?: 'auto'|'chat'|'agent' }} [opts]
   *   mode is the user's explicit choice in the assistant panel: 'chat' = never touch the browser (just talk), 'agent' =
   *   every message is a browser task, 'auto' (default) = the classifier below decides. "stop"/"continue" controls work in
   *   every mode - they act on a session that is already running and never start anything.
   * @returns {{ handled: boolean, kind: 'agent'|'control'|'chat', id?: string, followUp?: boolean, control?: string, reply?: string }}
   */
  route(input, { source = "text", mode = "auto" } = {}) {
    const raw = String(input || "").trim();
    slog(source === "voice" ? "VOICE_COMMAND_RECEIVED" : "TEXT_COMMAND_RECEIVED", { text: raw.slice(0, 120) });
    const { text: noMode, hadPhrase } = stripAgentModePhrase(stripAddress(raw));
    const text = noMode.trim();
    const session = this.session;

    if (!text) {
      // "turn on agentic mode" and nothing else: there is nothing to turn on
      return hadPhrase ? { handled: true, kind: "control", control: "noop", reply: "The agent is already on. Just tell me what to do." } : { handled: false, kind: "chat" };
    }

    const recent = session.hasRecentTask();

    // ---- controls: "continue", "stop", "pause" on their own
    const control = controlOf(text);
    if (control && (session.isActive || recent)) return this._control(control, source);

    // ---- the user chose "Chat": talk, never act
    if (mode === "chat") return { handled: false, kind: "chat" };

    // ---- instructions for the agent (a new task, or a follow-up to the one in front of us)
    const browsy = mode === "agent" || looksLikeBrowserTask(text);
    const follow = recent && isFollowUp(text);
    if (!browsy && !follow) return { handled: false, kind: "chat" };

    const followUp = recent && (follow || REFERS_BACK.test(text));
    const context = recent ? session.contextFor() : null;
    const id = this.agent.submit(text, { source, followUp, context });
    return { handled: true, kind: "agent", id, followUp };
  }

  _control(control, source) {
    const s = this.session;
    if (control === "stop") {
      this.agent.stop();
      return { handled: true, kind: "control", control: "stop", reply: "Stopped." };
    }
    if (control === "pause") {
      if (s.isActive) this.agent.pause();
      return { handled: true, kind: "control", control: "pause", reply: "Paused." };
    }
    // resume / continue
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
