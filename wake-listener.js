// wake-listener.js  (classic script, loaded after wake-core.js)
//
// The microphone side of the wake word: opens the mic, feeds wake-core.js's engine, and reopens it if the device drops. Kept thin on
// purpose - everything decidable lives in wake-core.js where it is unit-tested.
//
// Audio path:  getUserMedia (browser echo cancellation + noise suppression + auto gain)
//              -> AudioContext at 16 kHz (the browser resamples the mic for us; falls back to our own resampler)
//              -> high-pass 90 Hz (rumble, desk thumps) -> low-pass 6 kHz (hiss above the speech band)
//              -> AudioWorklet (mic-processor.js, the same one the voice orb uses) -> WakeEngine.pushFrame()
//
// The microphone stays open only while the wake word is switched ON; switching it off closes every track (the OS microphone
// indicator goes out).

(function (root) {
  "use strict";
  const W = root.JonahWake;

  /** A message a person can act on, per platform, for the errors getUserMedia actually produces. */
  function friendlyMicError(err) {
    const name = (err && err.name) || "";
    const mac = /Mac/i.test((root.navigator && root.navigator.platform) || "");
    const where = mac ? "System Settings → Privacy & Security → Microphone" : "Windows Settings → Privacy & security → Microphone";
    if (name === "NotAllowedError" || name === "SecurityError") return `Microphone access is blocked. Allow Jonah in ${where}, then switch this on again.`;
    if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Plug one in or pick one in your system sound settings.";
    if (name === "NotReadableError" || name === "AbortError") return "The microphone is busy or unavailable (another app may be using it).";
    return (err && err.message) || "The microphone could not be started.";
  }

  /**
   * @param {object} deps
   * @param {(pcm16k: Float32Array) => Promise<string>} deps.transcribe
   * @param {() => boolean} [deps.isBusy]
   * @param {(info) => void} [deps.onWake]
   * @param {(text: string, info) => void} [deps.onQuery]
   * @param {(s) => void} [deps.onState]
   * @param {() => void} [deps.onTimeout]
   * @param {(err: Error) => void} [deps.onError]   the microphone was lost and could not be recovered
   * @param {string} deps.workletUrl               absolute URL of mic-processor.js
   * @param {object} [deps.options]                 WakeEngine option overrides
   * @param {MediaDevices} [deps.mediaDevices]      (tests)
   */
  function createWakeListener(deps) {
    const md = deps.mediaDevices || (root.navigator && root.navigator.mediaDevices);
    let engine = null;
    let stream = null;
    let ctx = null;
    let nodes = [];
    let running = false;
    let restarts = 0;
    let restartTimer = null;

    async function openAudio() {
      if (!md || !md.getUserMedia) throw Object.assign(new Error("This app has no microphone access."), { name: "NotFoundError" });
      const constraints = Object.assign({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, W.audioConstraints || {}, deps.constraints || {});
      stream = await md.getUserMedia({ audio: constraints });
      const AC = root.AudioContext || root.webkitAudioContext;
      try {
        ctx = new AC({ sampleRate: 16000, latencyHint: "interactive" });
      } catch (_) {
        ctx = new AC({ latencyHint: "interactive" }); // a browser that will not run a context at 16 kHz: resample ourselves below
      }
      if (ctx.state === "suspended") await ctx.resume();
      const rate = ctx.sampleRate;
      await ctx.audioWorklet.addModule(deps.workletUrl);
      const source = ctx.createMediaStreamSource(stream);
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 90;
      hp.Q.value = 0.7;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = Math.min(6000, rate / 2 - 400);
      lp.Q.value = 0.7;
      const node = new root.AudioWorkletNode(ctx, "mic-processor", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers" });
      node.port.onmessage = (e) => {
        if (!engine || !e.data || !e.data.length) return;
        let f = new Float32Array(e.data);
        if (rate !== 16000) f = W.resampleTo(f, rate, 16000);
        engine.pushFrame(f);
      };
      source.connect(hp);
      hp.connect(lp);
      lp.connect(node);
      nodes = [source, hp, lp, node];
      const track = stream.getAudioTracks()[0];
      if (track) track.addEventListener("ended", onEnded);
    }

    function closeAudio() {
      for (const n of nodes) {
        try {
          if (n.port) n.port.close();
          n.disconnect();
        } catch (_) { /* already gone */ }
      }
      nodes = [];
      try {
        if (stream) stream.getTracks().forEach((t) => t.stop());
      } catch (_) { /* ignore */ }
      stream = null;
      try {
        if (ctx) ctx.close();
      } catch (_) { /* ignore */ }
      ctx = null;
    }

    // The device disappeared (unplugged, another app took it, sleep/wake): try to get it back a few times, then say so.
    function onEnded() {
      if (!running) return;
      closeAudio();
      if (restarts >= 4) {
        running = false;
        if (engine) engine.close();
        engine = null;
        if (deps.onError) deps.onError(Object.assign(new Error("The microphone stopped and could not be restarted."), { name: "NotReadableError" }));
        return;
      }
      restarts++;
      restartTimer = setTimeout(async () => {
        if (!running) return;
        try {
          await openAudio();
          restarts = 0;
        } catch (err) {
          onEnded();
        }
      }, 1500 * restarts);
    }

    return {
      get running() {
        return running;
      },
      get engine() {
        return engine;
      },
      async start() {
        if (running) return;
        engine = new W.WakeEngine({
          transcribe: deps.transcribe,
          isBusy: deps.isBusy,
          onWake: deps.onWake,
          onQuery: deps.onQuery,
          onState: deps.onState,
          onTimeout: deps.onTimeout,
          options: deps.options,
        });
        try {
          await openAudio();
        } catch (err) {
          closeAudio();
          engine.close();
          engine = null;
          throw err;
        }
        running = true;
        restarts = 0;
      },
      stop() {
        running = false;
        clearTimeout(restartTimer);
        closeAudio();
        if (engine) engine.close();
        engine = null;
      },
    };
  }

  root.JonahWake = Object.assign(root.JonahWake || {}, { createWakeListener, friendlyMicError });
})(typeof self !== "undefined" ? self : this);
