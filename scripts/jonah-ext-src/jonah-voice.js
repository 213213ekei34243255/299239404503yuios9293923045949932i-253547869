// jonah-voice.js - what Electron Jonah's preload gave its voice orb (voice-orb.js, wake-core.js, wake-listener.js, mic-processor.js -
// all unchanged), provided in Noah's panel, where the orb lives in Jonah on Chromium:
//   window.rexy.goal(text) + onGoalCompleted/Paused/Error/Blocked/Step : a spoken request goes the same road as a typed one
//                                                                        (the panel's "rexy:submit-goal"), and its answer comes back
//   window.noah.onEvent(cb) : Noah's agent events (the orb speaks a task's outcome); stop/resume/confirm for the overlay's cards
//   window.api.kokoroSpeak  : the reply voice - Electron's remote Kokoro server (KOKORO_RENDER_URL), the same request
//   window.JonahSpeech.transcribe(pcm16k) : speech recognition - Moonshine-base in Noah's helper (noah-native), from the panel's
//                                            getSTT() (Electron loaded transformers.js from a CDN here; Jonah runs it locally in Node)
// Loaded before voice-orb.js.
(function () {
  "use strict";
  const KOKORO_URL = "https://kokoro-zt8u.onrender.com"; // Electron main.cjs KOKORO_RENDER_URL
  const listeners = { completed: [], paused: [], error: [], blocked: [], step: [], event: [] };
  const fire = (k, d) => listeners[k].forEach((f) => { try { f(d); } catch (e) { console.warn("[voice]", e); } });
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data || {};
    switch (d.type) {
      case "rexy:goal-completed": fire("completed", d.payload || {}); break;
      case "rexy:goal-paused": fire("paused", d.payload || {}); break;
      case "rexy:goal-error": fire("error", d.payload || {}); break;
      case "rexy:goal-blocked": fire("blocked", d.payload || {}); break;
      case "rexy:goal-step": fire("step", d.payload || {}); break;
      case "noah:event": fire("event", d.payload || {}); break;
      default: break;
    }
  });

  window.rexy = Object.assign(window.rexy || {}, {
    /** A spoken request: the same message the panel's Send button posts; resolves with the panel's answer to it ({ success, kind, error }). */
    goal(text, opts) {
      return new Promise((resolve) => {
        const done = (e) => {
          if (e.source !== window || !e.data || e.data.type !== "rexy:goal-submitted") return;
          window.removeEventListener("message", done);
          clearTimeout(t);
          resolve(e.data.payload || { success: false });
        };
        const t = setTimeout(() => { window.removeEventListener("message", done); resolve({ success: false, error: "No answer from Noah." }); }, 120000);
        window.addEventListener("message", done);
        window.postMessage({ type: "rexy:submit-goal", goal: String(text || ""), mode: "auto", source: (opts && opts.source) || "voice" }, "*");
      });
    },
    onGoalCompleted: (f) => listeners.completed.push(f),
    onGoalPaused: (f) => listeners.paused.push(f),
    onGoalError: (f) => listeners.error.push(f),
    onGoalBlocked: (f) => listeners.blocked.push(f),
    onGoalStep: (f) => listeners.step.push(f),
  });

  const cmd = (c, extra) => window.postMessage(Object.assign({ type: "noah:cmd", cmd: c }, extra || {}), "*");
  window.noah = Object.assign(window.noah || {}, {
    onEvent: (f) => listeners.event.push(f),
    stop: () => cmd("stop"),
    resume: () => cmd("resume"),
    confirm: (id, allow) => cmd("confirm", { id: String(id), allow: allow === true }),
  });

  const toBase64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  window.api = Object.assign(window.api || {}, {
    /** Electron main "kokoro:speak": POST /tts to the Kokoro server, WAV back as base64. */
    async kokoroSpeak(text, options) {
      const o = options || {};
      try {
        const r = await fetch(KOKORO_URL + "/tts", {
          method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit",
          body: JSON.stringify({ text: String(text || ""), voice: o.voice || "af_heart", speed: Number(o.speed) || 1 }),
        });
        if (!r.ok) return { success: false, error: "The voice server answered HTTP " + r.status };
        return { success: true, audioBase64: toBase64(await r.arrayBuffer()), mimeType: r.headers.get("content-type") || "audio/wav" };
      } catch (err) {
        return { success: false, error: "The voice server could not be reached (" + (err && err.message ? err.message : err) + ")" };
      }
    },
  });

  /** 16 kHz mono Float32 audio -> text, by Moonshine-base in Noah's helper. */
  window.JonahSpeech = {
    warm: () => window.JonahComputer._call("sttWarm", {}, 180000),
    async transcribe(pcm) {
      const a = pcm instanceof Float32Array ? pcm : new Float32Array(pcm || []);
      const out = new Int16Array(a.length);
      for (let i = 0; i < a.length; i++) { const v = Math.max(-1, Math.min(1, a[i])); out[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
      const r = await window.JonahComputer._call("transcribe", { pcm: toBase64(out.buffer) }, 60000);
      return { text: (r && r.text) || "" };
    },
  };

  // Voice orb on/off (Electron index.html): saved on this computer, default on; hidden with a CSS class because voice-orb.js re-adds
  // the button if it is ever removed. The wake word does not depend on the button being visible.
  const KEY = "jonahOrbVisible";
  const read = () => { try { return localStorage.getItem(KEY) !== "0"; } catch (_) { return true; } };
  const st = document.createElement("style");
  st.textContent = "html.jonah-orb-hidden #jonah-voice-orb { display: none !important; }";
  document.head.appendChild(st);
  const apply = (on) => document.documentElement.classList.toggle("jonah-orb-hidden", !on);
  apply(read());
  window.addEventListener("storage", (e) => { if (e.key === KEY) apply(read()); });
  window.JonahOrb = { isOn: read, set(on) { try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (_) {} apply(!!on); } };
})();
