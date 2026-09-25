/**
 * voice-orb.js
 * -----------------------------------------------------------------------
 * A floating, always-on-screen voice assistant button for Jonah.
 *
 * Drop this file next to index.html and add, right before </body>:
 *
 *     <script type="module" src="voice-orb.js"></script>
 *
 * Only needs to go in index.html. index.html is the OUTER app window —
 * the <webview id="browser"> (which is what actually loads home.html and
 * every site you visit) is just one element inside that window's DOM. An
 * orb fixed-positioned in index.html with a very high z-index already
 * renders on top of the webview, so it's visible no matter what page —
 * home.html included — is showing inside the tab. You do not need (and
 * should not) load this a second time inside home.html itself.
 *
 * WHAT IT DOES
 *   - Small circular button (favicon.png), fixed position, draggable,
 *     re-inserts itself if anything ever removes it from the DOM.
 *   - Click once  -> starts listening (ring turns GREEN), mic captured
 *     straight from getUserMedia.
 *   - Auto-stops on ~1.1s of silence (or click again to force-stop).
 *   - Transcribes locally in the renderer with Moonshine-tiny
 *     (Hugging Face, via transformers.js / onnxruntime-web — no server
 *     round trip).
 *   - Sends the transcript straight into the SAME agent pipeline the
 *     chat panel uses: window.rexy.goal(text) — so anything you can type
 *     in chat, you can now say out loud.
 *   - Listens to window.rexy.onGoalStep / onGoalCompleted / onGoalPaused
 *     / onGoalError (already exposed by preload.cjs) to get the agent's
 *     reply text back.
 *   - Speaks the reply with Kokoro-82M (female voice "af_bella" by
 *     default). Ring turns ORANGE while audio is playing.
 *   - Ring returns to its resting state when done — ready for the next
 *     tap. Every tap repeats the same green -> (thinking) -> orange ->
 *     idle cycle.
 *
 * MODELS
 *   Both models are loaded through @huggingface/transformers (which is
 *   also what kokoro-js is built on) so there's only one WASM/WebGPU
 *   runtime in memory.
 *
 *   By default both load ONLINE straight from the Hugging Face Hub the
 *   first time the orb is used, then are cached by the browser's Cache
 *   Storage, so every run after the first is fully offline.
 *
 *   If you'd rather point at the local Kokoro-82M files you already have
 *   on disk instead of fetching from HF: Chromium's fetch() can't read
 *   file:// paths reliably, so the files need to be served over http.
 *   The easiest way, since main.cjs already `require()`s express, is to
 *   serve your local model folder as a tiny static route — see the
 *   "OPTIONAL: serve local Kokoro files" snippet at the bottom of this
 *   file's comments, then set LOCAL_KOKORO_BASE_URL below to that URL.
 * -----------------------------------------------------------------------
 */

// ---------------------------------------------------------------------
// CONFIG — the only things you should need to touch
// ---------------------------------------------------------------------
const CONFIG = {
  ICON_SRC: "assets/logo.png",

  // Moonshine STT still runs locally.
  STT_MODEL_ID: "onnx-community/moonshine-tiny-ONNX",

  // Kokoro now runs on Render.
  TTS_VOICE: "af_heart",

  SILENCE_STOP_MS: 1100,
  SILENCE_RMS_THRESHOLD: 0.012,
  MAX_RECORD_MS: 20000,

  STARTING_POSITION: {
    right: 28,
    bottom: 28
  },
};

// ---------------------------------------------------------------------
// STYLES
// ---------------------------------------------------------------------
function injectStyles() {
  if (document.getElementById("jonah-voice-orb-style")) return;
  const style = document.createElement("style");
  style.id = "jonah-voice-orb-style";
  style.textContent = `
    #jonah-voice-orb {
      position: fixed;
      width: 64px;
      height: 64px;
      border-radius: 50%;
      z-index: 2147483647; /* stay above everything, including <webview> */
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(18,14,28,0.85);
      border: 2px solid rgba(168,139,250,0.45);
      box-shadow:
        0 8px 26px rgba(0,0,0,0.55),
        0 0 22px rgba(139,92,246,0.35),
        inset 0 1px 0 rgba(216,201,255,0.15);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      transition: box-shadow .25s ease, border-color .25s ease, transform .15s ease;
      user-select: none;
      touch-action: none;
    }
    #jonah-voice-orb:hover { transform: scale(1.05); }
    #jonah-voice-orb:active { transform: scale(0.96); }

    #jonah-voice-orb img,
    #jonah-voice-orb svg {
      width: 30px;
      height: 30px;
      object-fit: contain;
      pointer-events: none;
    }

    #jonah-voice-orb.state-listening {
      border-color: #22ff8c;
      box-shadow:
        0 8px 26px rgba(0,0,0,0.55),
        0 0 10px rgba(34,255,140,0.9),
        0 0 34px rgba(34,255,140,0.55),
        inset 0 1px 0 rgba(216,201,255,0.15);
      animation: jonahOrbPulseGreen 1.1s ease-in-out infinite;
    }

    #jonah-voice-orb.state-thinking {
      border-color: #a78bfa;
      animation: jonahOrbPulseViolet 1s ease-in-out infinite;
    }

    #jonah-voice-orb.state-speaking {
      border-color: #ff9d3b;
      box-shadow:
        0 8px 26px rgba(0,0,0,0.55),
        0 0 10px rgba(255,157,59,0.9),
        0 0 34px rgba(255,157,59,0.55),
        inset 0 1px 0 rgba(216,201,255,0.15);
      animation: jonahOrbPulseOrange 0.85s ease-in-out infinite;
    }

    @keyframes jonahOrbPulseGreen {
      0%,100% { box-shadow:0 8px 26px rgba(0,0,0,.55),0 0 10px rgba(34,255,140,.9),0 0 30px rgba(34,255,140,.5),inset 0 1px 0 rgba(216,201,255,.15); }
      50%     { box-shadow:0 8px 26px rgba(0,0,0,.55),0 0 16px rgba(34,255,140,1),0 0 48px rgba(34,255,140,.75),inset 0 1px 0 rgba(216,201,255,.15); }
    }
    @keyframes jonahOrbPulseOrange {
      0%,100% { box-shadow:0 8px 26px rgba(0,0,0,.55),0 0 10px rgba(255,157,59,.9),0 0 30px rgba(255,157,59,.5),inset 0 1px 0 rgba(216,201,255,.15); }
      50%     { box-shadow:0 8px 26px rgba(0,0,0,.55),0 0 16px rgba(255,157,59,1),0 0 48px rgba(255,157,59,.75),inset 0 1px 0 rgba(216,201,255,.15); }
    }
    @keyframes jonahOrbPulseViolet {
      0%,100% { opacity: 1; }
      50%     { opacity: .55; }
    }

    #jonah-voice-orb .jonah-orb-badge {
      position: absolute;
      bottom: -22px;
      left: 50%;
      transform: translateX(-50%);
      font-family: 'Inter', sans-serif;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 1px;
      color: rgba(235,232,245,0.75);
      background: rgba(10,8,16,0.8);
      padding: 2px 8px;
      border-radius: 8px;
      white-space: nowrap;
      opacity: 0;
      transition: opacity .2s ease;
      pointer-events: none;
    }
    #jonah-voice-orb.show-badge .jonah-orb-badge { opacity: 1; }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------
// ORB ELEMENT (icon + drag + "never vanish")
// ---------------------------------------------------------------------
function createOrb() {
  injectStyles();

  let orb = document.getElementById("jonah-voice-orb");
  if (orb) return orb;

  orb = document.createElement("div");
  orb.id = "jonah-voice-orb";
  orb.style.right = `${CONFIG.STARTING_POSITION.right}px`;
  orb.style.bottom = `${CONFIG.STARTING_POSITION.bottom}px`;

  const img = document.createElement("img");
  img.src = CONFIG.ICON_SRC;
  img.alt = "Jonah voice assistant";
  img.onerror = () => {
    // Fallback mic glyph if favicon.png isn't there yet.
    img.replaceWith(fallbackMicSvg());
  };
  orb.appendChild(img);

  const badge = document.createElement("div");
  badge.className = "jonah-orb-badge";
  badge.textContent = "Listening…";
  orb.appendChild(badge);
  orb._badge = badge;

  document.body.appendChild(orb);
  makeDraggable(orb);
  keepAlive(orb);

  return orb;
}

function fallbackMicSvg() {
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" stroke="#e4dbff" stroke-width="1.6"/>
      <path d="M19 11a7 7 0 0 1-14 0M12 18v3" stroke="#e4dbff" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`;
  return wrap.firstElementChild;
}

// Drag to reposition; a real drag (>6px movement) suppresses the click
// that would otherwise fire on release.
function makeDraggable(orb) {
  let startX, startY, origRight, origBottom, dragging = false, moved = false;

  const onDown = (e) => {
    const p = e.touches ? e.touches[0] : e;
    dragging = true; moved = false;
    startX = p.clientX; startY = p.clientY;
    const rect = orb.getBoundingClientRect();
    origRight = window.innerWidth - rect.right;
    origBottom = window.innerHeight - rect.bottom;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
  };
  const onMove = (e) => {
    if (!dragging) return;
    const p = e.touches ? e.touches[0] : e;
    const dx = p.clientX - startX;
    const dy = p.clientY - startY;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
    if (moved) e.preventDefault?.();
    orb.style.right = `${Math.max(4, origRight - dx)}px`;
    orb.style.bottom = `${Math.max(4, origBottom - dy)}px`;
  };
  const onUp = () => {
    dragging = false;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("touchend", onUp);
    // stash the last non-dragged click state on the element itself
    orb._justDragged = moved;
  };

  orb.addEventListener("mousedown", onDown);
  orb.addEventListener("touchstart", onDown, { passive: true });
}

// If something ever removes the orb from the DOM (e.g. a stray
// innerHTML reset somewhere in the app), put it right back.
function keepAlive(orb) {
  const observer = new MutationObserver(() => {
    if (!document.body.contains(orb)) {
      document.body.appendChild(orb);
    }
  });
  observer.observe(document.body, { childList: true });

  // Belt-and-braces poll, cheap and catches anything a MutationObserver
  // on document.body alone might miss (e.g. body itself being replaced).
  setInterval(() => {
    if (!document.getElementById("jonah-voice-orb")) {
      document.body.appendChild(orb);
    }
  }, 4000);
}

// ---------------------------------------------------------------------
// STATE MACHINE
// ---------------------------------------------------------------------
const STATE = { IDLE: "idle", LISTENING: "listening", THINKING: "thinking", SPEAKING: "speaking" };

function setOrbState(orb, state, label) {
  orb.classList.remove("state-listening", "state-thinking", "state-speaking", "show-badge");
  if (state === STATE.LISTENING) orb.classList.add("state-listening", "show-badge");
  if (state === STATE.THINKING) orb.classList.add("state-thinking", "show-badge");
  if (state === STATE.SPEAKING) orb.classList.add("state-speaking", "show-badge");
  if (label && orb._badge) orb._badge.textContent = label;
}

// ---------------------------------------------------------------------
// MIC CAPTURE (raw 16kHz mono float32, what Moonshine/whisper-style
// ASR pipelines expect) + simple silence-based auto-stop
// ---------------------------------------------------------------------
class MicRecorder {
  constructor({ onSilenceStop, silenceMs, rmsThreshold, maxMs }) {
    this.onSilenceStop = onSilenceStop;
    this.silenceMs = silenceMs;
    this.rmsThreshold = rmsThreshold;
    this.maxMs = maxMs;

    this._chunks = [];
    this._stream = null;
    this._ctx = null;
    this._source = null;
    this._processor = null;
    this._silenceStart = null;
    this._startedAt = 0;
    this._stopped = false;
  }

  async start() {
    this._chunks = [];
    this._silenceStart = null;
    this._startedAt = Date.now();
    this._stopped = false;

    console.log("========== MIC DEBUG ==========");
    console.log("isSecureContext:", window.isSecureContext);
    console.log("protocol:", window.location.protocol);
    console.log("mediaDevices:", !!navigator.mediaDevices);
    console.log(
      "getUserMedia:",
      !!navigator.mediaDevices?.getUserMedia
    );

    try {
      const permission = await navigator.permissions.query({
        name: "microphone"
      });

      console.log(
        "microphone permission:",
        permission.state
      );
    } catch (e) {
      console.log(
        "microphone permission query failed:",
        e.message
      );
    }

    try {
      const devices =
        await navigator.mediaDevices.enumerateDevices();

      console.log(
        "audio devices:",
        devices
          .filter(d => d.kind === "audioinput")
          .map(d => ({
            deviceId: d.deviceId,
            label: d.label,
            groupId: d.groupId
          }))
      );
    } catch (e) {
      console.error(
        "enumerateDevices failed:",
        e
      );
    }

    console.log("==============================");

    // --------------------------------------------------
    // 1. GET MICROPHONE
    // --------------------------------------------------

    this._stream =
      await navigator.mediaDevices.getUserMedia({
        audio: true
      });

    console.log(
      "🎤 MICROPHONE CAPTURE SUCCESS"
    );

    // --------------------------------------------------
    // 2. AUDIO CONTEXT
    // --------------------------------------------------

    const AudioContextClass =
      window.AudioContext ||
      window.webkitAudioContext;

    this._ctx =
      new AudioContextClass();

    if (this._ctx.state === "suspended") {
      await this._ctx.resume();
    }

    console.log(
      "[voice-orb] AudioContext:",
      this._ctx.state,
      "sampleRate:",
      this._ctx.sampleRate
    );

    // --------------------------------------------------
    // 3. LOAD AUDIO WORKLET
    // --------------------------------------------------

    const workletURL =
      new URL(
        "./mic-processor.js",
        window.location.href
      ).href;

    console.log(
      "[voice-orb] Loading AudioWorklet:",
      workletURL
    );

    await this._ctx.audioWorklet.addModule(
      workletURL
    );

    // --------------------------------------------------
    // 4. MICROPHONE SOURCE
    // --------------------------------------------------

    this._source =
      this._ctx.createMediaStreamSource(
        this._stream
      );

    // --------------------------------------------------
    // 5. AUDIO WORKLET
    // --------------------------------------------------

    this._processor =
      new AudioWorkletNode(
        this._ctx,
        "mic-processor",
        {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
          channelCountMode: "explicit",
          channelInterpretation: "speakers"
        }
      );

    // --------------------------------------------------
    // 6. RECEIVE PCM FROM WORKLET
    // --------------------------------------------------

    this._processor.port.onmessage =
      (event) => {

        if (this._stopped) {
          return;
        }

        const input = event.data;

        if (
          !input ||
          input.length === 0
        ) {
          return;
        }

        const samples =
          new Float32Array(input);

        this._chunks.push(samples);

        // ----------------------------------------------
        // RMS / SILENCE DETECTION
        // ----------------------------------------------

        let sumSquares = 0;

        for (
          let i = 0;
          i < samples.length;
          i++
        ) {
          sumSquares +=
            samples[i] *
            samples[i];
        }

        const rms =
          Math.sqrt(
            sumSquares /
            samples.length
          );

        const now = Date.now();

        if (
          rms <
          this.rmsThreshold
        ) {

          if (
            this._silenceStart === null
          ) {
            this._silenceStart =
              now;
          } else if (
            now -
            this._silenceStart >
            this.silenceMs &&
            now -
            this._startedAt >
            400
          ) {

            this.onSilenceStop?.();
          }

        } else {

          this._silenceStart =
            null;
        }

        // ----------------------------------------------
        // MAX RECORDING TIME
        // ----------------------------------------------

        if (
          now -
          this._startedAt >
          this.maxMs
        ) {
          this.onSilenceStop?.();
        }
      };

    // --------------------------------------------------
    // 7. CONNECT MIC → WORKLET
    // --------------------------------------------------

    this._source.connect(
      this._processor
    );

    console.log(
      "🎤 AudioWorklet microphone pipeline ready"
    );
  }

  async stop() {
    if (this._stopped) {
      return mergeFloat32(this._chunks);
    }

    this._stopped = true;

    // Give the AudioWorklet a moment to deliver
    // any PCM messages already queued.
    await new Promise(resolve => setTimeout(resolve, 50));

    try {
      this._processor?.port.close();
    } catch {}

    try {
      this._processor?.disconnect();
    } catch {}

    try {
      this._source?.disconnect();
    } catch {}

    try {
      this._stream
        ?.getTracks()
        .forEach(track => track.stop());
    } catch {}

    try {
      await this._ctx?.close();
    } catch {}

    const pcm = mergeFloat32(this._chunks);

    this._processor = null;
    this._source = null;
    this._stream = null;
    this._ctx = null;

    console.log(
      "[voice-orb] captured PCM samples:",
      pcm.length
    );

    return pcm;
  }
}

function mergeFloat32(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
function resampleAudio(
  input,
  inputSampleRate,
  outputSampleRate
) {
  if (
    inputSampleRate === outputSampleRate
  ) {
    return input;
  }

  if (!input.length) {
    return new Float32Array(0);
  }

  const ratio =
    inputSampleRate /
    outputSampleRate;

  const outputLength =
    Math.round(
      input.length / ratio
    );

  const output =
    new Float32Array(
      outputLength
    );

  for (
    let i = 0;
    i < outputLength;
    i++
  ) {

    const position =
      i * ratio;

    const left =
      Math.floor(position);

    const right =
      Math.min(
        left + 1,
        input.length - 1
      );

    const fraction =
      position - left;

    output[i] =
      input[left] *
        (1 - fraction) +
      input[right] *
        fraction;
  }

  return output;
}
// ---------------------------------------------------------------------
// LAZY MODEL LOADING (transformers.js for STT, kokoro-js for TTS)
// Loaded from CDN as ES modules so no bundler step is required. If you
// already bundle the renderer (webpack/vite), replace these dynamic
// imports with a plain top-of-file
//   import { pipeline } from "@huggingface/transformers";
//   import { KokoroTTS } from "kokoro-js";
// after `npm install @huggingface/transformers kokoro-js`.
// ---------------------------------------------------------------------
let _sttPipelinePromise = null;


async function getSTT(onProgress) {
    if (!_sttPipelinePromise) {
        _sttPipelinePromise = (async () => {

            const { pipeline } =
                await import(
                    "https://esm.sh/@huggingface/transformers@3"
                );

            return pipeline(
                "automatic-speech-recognition",
                CONFIG.STT_MODEL_ID,
                {
                    progress_callback: onProgress
                }
            );
        })();
    }

    return _sttPipelinePromise;
}



// ---------------------------------------------------------------------
// WAV encoding fallback, in case a given kokoro-js build doesn't expose
// RawAudio.toBlob(). Encodes mono Float32 PCM -> a playable WAV Blob.
// ---------------------------------------------------------------------


async function speak(orb, text) {

    if (!text || !text.trim()) {
        return;
    }

    let audio = null;
    let url = null;

    try {

        setOrbState(
            orb,
            STATE.THINKING,
            "Generating voice…"
        );

        console.log(
            "[voice-orb] Sending text to remote Kokoro:",
            text
        );

        const result =
            await window.api.kokoroSpeak(
                text,
                {
                    voice: CONFIG.TTS_VOICE,
                    speed: 1
                }
            );

        if (!result?.success) {
            throw new Error(
                result?.error ||
                "Remote Kokoro generation failed"
            );
        }

        console.log(
            "[voice-orb] Remote Kokoro audio received"
        );

        // Render returns base64 encoded WAV audio.
        const binary =
            atob(result.audioBase64);

        const bytes =
            new Uint8Array(
                binary.length
            );

        for (
            let i = 0;
            i < binary.length;
            i++
        ) {
            bytes[i] =
                binary.charCodeAt(i);
        }

        const blob =
            new Blob(
                [bytes],
                {
                    type:
                        result.mimeType ||
                        "audio/wav"
                }
            );

        url =
            URL.createObjectURL(blob);

        audio =
            new Audio(url);

        audio.volume = 1.0;

        setOrbState(
            orb,
            STATE.SPEAKING,
            "Speaking…"
        );

        await new Promise(
            (resolve, reject) => {

                audio.onended =
                    resolve;

                audio.onerror =
                    () => {
                        reject(
                            new Error(
                                "Remote Kokoro audio playback failed"
                            )
                        );
                    };

                audio.play()
                    .then(() => {

                        console.log(
                            "[voice-orb] 🔊 Remote Kokoro playback started"
                        );

                    })
                    .catch(reject);
            }
        );

        console.log(
            "[voice-orb] 🔊 Remote Kokoro playback finished"
        );

    } catch (error) {

        console.error(
            "[voice-orb] Remote Kokoro speech error:",
            error
        );

        throw error;

    } finally {

        try {
            audio?.pause();
        } catch {}

        if (url) {
            URL.revokeObjectURL(url);
        }
    }
}

// ---------------------------------------------------------------------
// AGENT WIRING — talks to window.rexy directly (same bridge ai-panel.html
// uses), no chat UI needed in the loop.
// ---------------------------------------------------------------------
// One set of listeners for the whole app session (registered once in initVoiceOrb, never per utterance: registering per
// utterance leaked five listeners every time the user spoke). Two kinds of thing come back:
//   * a chat / control reply ("Continuing.") for the utterance just submitted -> resolves `pendingReply`
//   * the outcome of an agent run (tagged `agent: true`)                      -> spoken when the orb is free
function createAgentBridge({ onOutcome }) {
  let pending = null;

  const settle = (text) => {
    if (!pending) return false;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    p.resolve(text);
    return true;
  };
  // A message the user TYPED is answered in text only - the assistant panel prints it, and nothing is read aloud (before
  // this, every typed reply had "nobody waiting", fell through to the outcome path below and was spoken). Only what
  // answers something the user SPOKE is voiced. Untagged events with nobody waiting (the legacy fallback loop) still count.
  const reply = (data, text) => {
    if (data && data.source === "text") return;
    if (data && data.agent) return onOutcome(text);
    if (!settle(text)) onOutcome(text);
  };

  window.rexy.onGoalCompleted((d) => reply(d, d?.reason || "Done."));
  window.rexy.onGoalPaused((d) => reply(d, d?.result?.message || "I need more information."));
  window.rexy.onGoalError((d) => reply(d, d?.error ? `Something went wrong: ${d.error}` : "Something went wrong."));
  window.rexy.onGoalBlocked((d) => reply(d, "That action isn't permitted."));

  return {
    /** Resolves with the reply text (bounded, so a silent runtime cannot hold the orb forever). */
    expectReply(ms = 45000) {
      settle(null);
      return new Promise((resolve) => {
        pending = { resolve, timer: setTimeout(() => settle(null), ms) };
      });
    },
    cancelExpect() {
      settle(null);
    },
  };
}

// ---------------------------------------------------------------------
// MAIN FLOW
// ---------------------------------------------------------------------
function initVoiceOrb() {
  if (!window.rexy || typeof window.rexy.goal !== "function") {
    console.warn("[voice-orb] window.rexy is not available — is bridge.cjs's contextBridge exposed in this window?");
  }

  const orb = createOrb();
  let recorder = null;
  let isRecording = false;
  let busy = false; // true only while we are transcribing / submitting / speaking a chat reply: NOT while an agent run works
  const outcomes = [];

  // Outcomes of agent runs are spoken as soon as the orb is free, never over the user or over another reply.
  const drainOutcomes = async () => {
    if (busy || isRecording || !outcomes.length) return;
    busy = true;
    try {
      while (outcomes.length && !isRecording) {
        setOrbState(orb, STATE.SPEAKING, "Speaking…");
        await speak(orb, outcomes.shift());
      }
    } catch (err) {
      console.error("[voice-orb] could not speak an outcome:", err);
    } finally {
      busy = false;
      applySession(lastSession);
    }
  };
  const bridge = createAgentBridge({ onOutcome: (text) => { if (text) { outcomes.push(text); drainOutcomes(); } } });

  // The orb mirrors the agent session while it is otherwise idle, so a long task looks like a long task.
  let lastSession = null;
  const applySession = (s) => {
    lastSession = s;
    if (busy || isRecording) return;
    const st = s && s.state;
    if (st === "planning" || st === "executing") setOrbState(orb, STATE.THINKING, "Working…");
    else if (st === "paused") setOrbState(orb, STATE.THINKING, "Paused");
    else if (st === "waiting_for_user") setOrbState(orb, STATE.THINKING, "Waiting for you");
    else setOrbState(orb, STATE.IDLE, "");
  };
  if (window.noah && typeof window.noah.onEvent === "function") {
    window.noah.onEvent((evt) => {
      if (evt && evt.event === "session_state") applySession(evt);
    });
  }

  const stopAndProcess = async () => {
    if (!isRecording) return;
    isRecording = false;
    const pcm = await recorder.stop();
          console.log(
        "[voice-orb] PCM length:",
        pcm.length
      );

      if (!pcm || pcm.length === 0) {
        console.error(
          "[voice-orb] No microphone samples captured."
        );

        setOrbState(
          orb,
          STATE.IDLE,
          ""
        );

        busy = false;
        return;
      }
    recorder = null;

    setOrbState(orb, STATE.THINKING, "Transcribing…");
    busy = true;
    try {
      const stt = await getSTT();
      const audio16k = resampleAudio(
        pcm,
        44100,
        16000
      );

      console.log(
        "[voice-orb] Sending to Moonshine:",
        audio16k.length,
        "samples @ 16000 Hz"
      );

      const result = await stt(audio16k);
      const transcript = (result?.text || "").trim();

      if (!transcript) {
        setOrbState(orb, STATE.IDLE, "");
        busy = false;
        return;
      }

      console.log("[voice-orb] heard:", transcript);
      setOrbState(orb, STATE.THINKING, "Working…");

      // Voice and typed messages take the same road (window.rexy.goal -> the command router -> the one agent session).
      const replyPromise = bridge.expectReply();
      const submission = await window.rexy.goal(transcript, { source: "voice" });
      if (!submission?.success) {
        bridge.cancelExpect();
        await speak(orb, submission?.error ? `I couldn't start that: ${submission.error}` : "I couldn't start that.");
      } else if (submission.kind === "agent") {
        // The agent works on its own from here. Release the orb NOW so "stop", "continue" or the next instruction can be
        // spoken while it works; the outcome is spoken by the persistent listener when the run ends.
        bridge.cancelExpect();
      } else {
        const reply = await replyPromise;
        await speak(orb, reply || "I did not get an answer. Please try again.");
      }
    } catch (err) {
      console.error("[voice-orb] error:", err);
      try { await speak(orb, "Sorry, something went wrong."); } catch (_) {}
    } finally {
      busy = false;
      applySession(lastSession);
      drainOutcomes();
    }
  };

  orb.addEventListener("click", async () => {
    if (orb._justDragged) { orb._justDragged = false; return; }
    if (busy) return;

    if (isRecording) {
      stopAndProcess();
      return;
    }

    try {
      recorder = new MicRecorder({
        onSilenceStop: () => stopAndProcess(),
        silenceMs: CONFIG.SILENCE_STOP_MS,
        rmsThreshold: CONFIG.SILENCE_RMS_THRESHOLD,
        maxMs: CONFIG.MAX_RECORD_MS,
      });
      await recorder.start();
      isRecording = true;
      setOrbState(orb, STATE.LISTENING, "Listening…");

      // Warm the STT model in the background while the user talks, so
      // transcription starts the instant recording stops.
      getSTT().catch((e) => console.warn("[voice-orb] STT warm-up failed:", e));
    } catch (err) {
      console.error("[voice-orb] mic permission / capture failed:", err);
      setOrbState(orb, STATE.IDLE, "");
      alert("Jonah couldn't access the microphone. Check that mic permission is granted to the app.");
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initVoiceOrb);
} else {
  initVoiceOrb();
}
