// wake-core.js  (classic script + CommonJS: `window.JonahWake` in the shell, `require` in tests)
//
// The wake-word engine: pure logic, no microphone, no DOM, no clock. It is fed 16 kHz mono audio and is driven entirely by AUDIO time
// (samples received), so its behaviour is deterministic and unit-testable. The microphone adapter is wake-listener.js.
//
// HOW "NOAH" IS HEARD (nothing leaves the device):
//   1. A noise-adaptive voice detector splits the stream into utterances. It tracks the room's noise floor, needs ~80 ms of
//      sustained energy to start (so a keyboard click or a cough is not speech), and ends an utterance after a short pause.
//   2. Only the START of an utterance (its first ~2.4 s) is sent to the local speech recogniser - once per utterance, and at most
//      ~25 times a minute - and the wake word must be at the START of what was said ("Noah, what time is it"), as with Alexa, so
//      a conversation that merely mentions the name does not wake it. Anything that does not start with the wake word is
//      dropped and never kept, never sent anywhere.
//   3. On a hit the engine keeps listening to the same utterance (so "Noah, open YouTube" works in one breath) or, if only the
//      name was said, waits up to 7 s for the request.
//
// FOCUSING ON THE PERSON WHO SAID IT. True speaker separation needs a neural model; what this does, honestly, is near-field gating:
// the loudness of the wake word anchors "the person at the microphone". While the request is captured, sound well below that
// level (a TV or another room's voices) neither keeps the recording open nor counts toward the end of the request, and is
// attenuated in the audio that is transcribed. Echo/noise suppression from the browser's audio processing sits under this.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JonahWake = Object.assign(root.JonahWake || {}, factory());
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ------------------------------------------------------------------ the wake phrase

  // What a recogniser writes for a spoken "Noah". Deliberately short: plain "no" / "now" / "nah" are NOT here (they are among the
  // most common words in a room and would wake it constantly).
  const WAKE_RE = /^[\s"'“”‘’(\-–—.,!?…]*(?:(?:hey|hi|hello|ok|okay|yo|hay)[\s,.!\-–—]+)?(?:noah|noa|noha|noaa|knoah|noh|no[\s,.\-]+ah|know[\s,.\-]+ah)(?![\p{L}\p{N}])(?!['’]s(?![\p{L}\p{N}]))[\s,.:;!?\-–—"”'…]*/iu; // (?!'s): "Noah's ark is..." is about the man, not a call

  /** @returns {{ hit: boolean, rest: string }} `rest` = what was said after the wake word */
  function matchWake(text) {
    const s = String(text || "");
    const m = WAKE_RE.exec(s);
    if (!m) return { hit: false, rest: s.trim() };
    return { hit: true, rest: s.slice(m[0].length).trim() };
  }

  /** A request needs a couple of real characters ("Noah." alone, or "Noah, uh" is just the name). */
  function hasRequest(rest) {
    const words = (String(rest).match(/[\p{L}\p{N}]+/gu) || []).filter((w) => !/^(uh|um|uhh|umm|hmm|mm|ah|oh|er|eh)$/i.test(w));
    return words.join("").length >= 2;
  }

  // ------------------------------------------------------------------ audio helpers

  function rmsOf(f32) {
    let s = 0;
    for (let i = 0; i < f32.length; i++) s += f32[i] * f32[i];
    return Math.sqrt(s / Math.max(1, f32.length));
  }
  function concat(chunks, total) {
    const n = total != null ? total : chunks.reduce((a, c) => a + c.length, 0);
    const out = new Float32Array(n);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
  function median(a) {
    if (!a.length) return 0;
    const b = a.slice().sort((x, y) => x - y);
    return b[Math.floor(b.length / 2)];
  }

  /**
   * Scale a clip so its loudest sample is ~0.5. The microphone's own gain varies from room to room and moment to moment, and the
   * recogniser was measured to do better on evenly-loud audio. Near-silence is left alone (amplifying it would turn room noise into
   * something the recogniser tries to read), and the gain is capped.
   */
  function normalizePeak(f32, target = 0.5, maxGain = 8) {
    let peak = 0;
    for (let i = 0; i < f32.length; i++) {
      const a = Math.abs(f32[i]);
      if (a > peak) peak = a;
    }
    if (peak < 0.005) return f32;
    const g = Math.min(maxGain, target / peak);
    if (Math.abs(g - 1) < 0.05) return f32;
    const out = new Float32Array(f32.length);
    for (let i = 0; i < f32.length; i++) out[i] = Math.max(-1, Math.min(1, f32[i] * g));
    return out;
  }

  /**
   * Linear-interpolation resampler with a box low-pass when downsampling (only used when the browser cannot give the microphone
   * graph a 16 kHz context directly).
   */
  function resampleTo(input, fromRate, toRate) {
    if (fromRate === toRate || !input.length) return input;
    const ratio = fromRate / toRate;
    const outLen = Math.max(1, Math.floor(input.length / ratio));
    const out = new Float32Array(outLen);
    if (ratio > 1) {
      for (let i = 0; i < outLen; i++) {
        const a = Math.floor(i * ratio), b = Math.min(input.length, Math.floor((i + 1) * ratio));
        let sum = 0;
        for (let k = a; k < b; k++) sum += input[k];
        out[i] = sum / Math.max(1, b - a);
      }
    } else {
      for (let i = 0; i < outLen; i++) {
        const p = i * ratio, l = Math.floor(p), r = Math.min(input.length - 1, l + 1), f = p - l;
        out[i] = input[l] * (1 - f) + input[r] * f;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ the engine

  const DEFAULTS = {
    sampleRate: 16000,
    windowMs: 20,
    absOn: 0.011, // never call anything below this speech, however quiet the room
    absOff: 0.007,
    onFactor: 3.2, // speech starts at floor * this
    offFactor: 2.0,
    onsetMs: 80, // sustained energy needed to start an utterance (rejects clicks, key taps, coughs)
    minSpeechMs: 260, // total voiced time an utterance needs to count at all
    hangoverMs: 650, // pause that ends an utterance
    preRollMs: 300, // audio kept from before the onset (the first syllable is already under way when energy is detected)
    idleMaxMs: 12000, // an utterance longer than this is a conversation, not a command: dropped without a further look
    checkAtMs: 1500, // check a still-running utterance's start once this much has been heard
    earlyPauseMs: 500, // a pause this long after a short utterance ("Noah.") is checked at once. NOT shorter: a comma's pause (~300 ms) would cut "Noah, what time is it?" down to a bare, badly-recognised "Noah"
    earlyMinVoicedMs: 300,
    prefixMs: 2400, // how much of the start is transcribed for the wake word
    queryMaxMs: 20000,
    awaitQueryMs: 7000, // after "Noah" alone: how long to wait for the request
    maxChecksPerMin: 25, // recogniser budget: a noisy room cannot keep the CPU busy
    backoffMs: 30000,
    backoffFactor: 1.5,
    gateFraction: 0.3, // request audio below this fraction of the wake word's level is treated as background
    gateHoldMs: 240,
    gateAttenuation: 0.2,
    keepSegments: 3,
    floorWindows: 150, // 3 s of 20 ms windows
  };

  /**
   * @param {object} deps
   * @param {(pcm16k: Float32Array) => Promise<string>} deps.transcribe local speech-to-text
   * @param {() => boolean} [deps.isBusy]   true while the app is speaking / recording / the user is typing: audio is ignored
   * @param {(info:{prefix:string}) => void} [deps.onWake]    "Noah" heard (fires at once, before the request ends)
   * @param {(text:string, info:{pcm:Float32Array}) => void} [deps.onQuery]  the request, wake word removed
   * @param {(s:{phase:string}) => void} [deps.onState]       idle | capturing
   * @param {() => void} [deps.onTimeout]   "Noah" was said, no request followed
   * @param {object} [deps.options] overrides for DEFAULTS
   */
  class WakeEngine {
    constructor(deps) {
      this.d = Object.assign({ isBusy: () => false, onWake() {}, onQuery() {}, onState() {}, onTimeout() {} }, deps);
      this.o = Object.assign({}, DEFAULTS, deps.options || {});
      this.win = Math.round((this.o.sampleRate * this.o.windowMs) / 1000);
      this.t = 0; // audio time, ms
      this.floor = 0.004;
      this.hist = []; // recent window levels; their minimum is the room's noise floor
      this.pre = []; // ring of recent windows { f, rms, t }
      this.carry = new Float32Array(0);
      this.seg = null; // the open segment
      this.segments = []; // recent segments (open and ended), oldest first
      this.segSeq = 0;
      this.phase = "idle"; // idle | capturing | await-query
      this.speakerLevel = 0;
      this.awaitDeadline = 0;
      this.holdoffUntil = 0;
      this.checkTimes = [];
      this.backoffUntil = 0;
      this.onCount = 0; // consecutive above-threshold windows
      this.env = []; // recent window levels, for the near-field gate
      this.stats = { checks: 0, wakes: 0, queries: 0, dropped: 0, windows: 0 };
      this._working = Promise.resolve();
      this._closed = false;
    }

    get state() {
      return { phase: this.phase, t: this.t, floor: this.floor, speakerLevel: this.speakerLevel };
    }

    /** Resolves when everything already fed has been fully handled (tests; also handy for clean shutdown). */
    idle() {
      return this._working;
    }

    close() {
      this._closed = true;
      this._reset(true);
    }

    /** Feed any amount of 16 kHz mono audio. Synchronous; recogniser work runs in the background. */
    pushFrame(samples) {
      if (this._closed || !samples || !samples.length) return;
      let buf = samples;
      if (this.carry.length) {
        buf = concat([this.carry, samples]);
        this.carry = new Float32Array(0);
      }
      let off = 0;
      while (off + this.win <= buf.length) {
        this._window(buf.subarray(off, off + this.win));
        off += this.win;
      }
      if (off < buf.length) this.carry = buf.slice(off);
    }

    // ---- per window
    _window(w) {
      const o = this.o;
      this.t += o.windowMs;
      this.stats.windows++;
      const rms = rmsOf(w);

      if (this.d.isBusy() || this.t < this.holdoffUntil) {
        // the app is talking / listening / the user is typing: nothing heard now is for us, and nothing half-heard may survive
        if (this.seg || this.phase !== "idle" || this.segments.length) this._reset(false);
        if (this.d.isBusy()) this.holdoffUntil = this.t + 700; // let the tail of our own speech die away
        this.pre.length = 0;
        this.onCount = 0;
        return;
      }

      // The room's noise floor is the SMALLEST level seen in the last few seconds. Speech is full of closures and pauses, so its
      // minimum stays at the room level (it does not creep up while someone talks), yet a steady noise that starts (a fan, an
      // air conditioner) raises the minimum within seconds and stops counting as speech.
      this.hist.push(rms);
      if (this.hist.length > o.floorWindows) this.hist.shift();
      let mn = Infinity;
      for (let i = 0; i < this.hist.length; i++) if (this.hist[i] < mn) mn = this.hist[i];
      const seen = Math.max(mn, 0.0004);
      // ...but not while an utterance that MATTERS is in progress (still being judged, recognised as the wake word, or the request
      // itself): a long stretch of continuous speech would otherwise drag the floor up to the speech level, and the person would
      // seem to have stopped talking. The floor may still fall then, and it adapts freely again once the utterance is over - or
      // has been judged "not for us", after which a steady noise stops counting as speech within seconds.
      const holding = this.seg && (this.seg.query || this.seg.checked !== "miss");
      this.floor = holding && seen > this.floor ? this.floor : this.floor * 0.9 + seen * 0.1;

      const backoff = this.t < this.backoffUntil ? o.backoffFactor : 1;
      const speaking = !!this.seg;
      const on = Math.max(o.absOn, this.floor * o.onFactor) * backoff;
      const off = Math.max(o.absOff, this.floor * o.offFactor) * backoff;
      // near-field gate while a request is being captured
      const gated = this._gateActive() ? this._gatedOut(rms) : false;
      const loud = rms >= (speaking ? off : on) && !gated;
      const startLoud = rms >= on && !gated; // while waiting for the request, background well below the wake word's level cannot start it

      if (!speaking) {
        this.pre.push({ f: w, rms, t: this.t });
        const maxPre = Math.ceil((o.preRollMs + o.onsetMs) / o.windowMs) + 1;
        if (this.pre.length > maxPre) this.pre.shift();
        this.onCount = startLoud ? this.onCount + 1 : 0;
        if (this.onCount * o.windowMs >= o.onsetMs) this._openSegment();
        this._tickAwait();
        return;
      }

      // inside an utterance
      const seg = this.seg;
      seg.windows.push(w);
      seg.gate.push(gated);
      if (loud) {
        seg.lastVoiced = this.t;
        seg.voicedMs += o.windowMs;
        if (!gated) seg.voicedRms.push(rms);
      }
      const len = seg.windows.length * o.windowMs;
      const sinceVoice = this.t - seg.lastVoiced;
      const cap = seg.query ? o.queryMaxMs : o.idleMaxMs;
      if (!seg.checkQueued && seg.checked === false && (len >= o.checkAtMs || (sinceVoice >= o.earlyPauseMs && seg.voicedMs >= o.earlyMinVoicedMs))) this._queueCheck(seg);
      if (sinceVoice >= o.hangoverMs || len >= cap) this._closeSegment(len >= cap && sinceVoice < o.hangoverMs);
    }

    _gateActive() {
      return this.speakerLevel > 0 && (this.phase === "capturing" || this.phase === "await-query");
    }
    _gatedOut(rms) {
      // a 240 ms max-hold envelope so quiet consonants inside real speech are not cut
      this.env.push(rms);
      const n = Math.ceil(this.o.gateHoldMs / this.o.windowMs);
      if (this.env.length > n) this.env.shift();
      let m = 0;
      for (let i = 0; i < this.env.length; i++) if (this.env[i] > m) m = this.env[i];
      return m < this.speakerLevel * this.o.gateFraction;
    }

    _openSegment() {
      const preWins = this.pre.slice();
      this.pre.length = 0;
      const seg = {
        id: ++this.segSeq,
        windows: preWins.map((p) => p.f),
        gate: preWins.map(() => false),
        voicedRms: [],
        voicedMs: this.onCount * this.o.windowMs,
        startT: preWins.length ? preWins[0].t : this.t,
        lastVoiced: this.t,
        endT: null,
        checked: false, // false | "pending" | "hit" | "miss" | "query"
        checkQueued: false,
        query: false,
        done: false,
        closed: false,
      };
      seg.voicedRms.push(...preWins.slice(-this.onCount).map((p) => p.rms));
      this.seg = seg;
      this.segments.push(seg);
      while (this.segments.length > this.o.keepSegments) this.segments.shift();
      this.onCount = 0;
      // a request that follows a bare "Noah": this utterance IS the request
      if (this.phase === "await-query") {
        seg.query = true;
        seg.checked = "query";
        this.d.onState({ phase: "capturing" });
      }
    }

    _closeSegment(overlong) {
      const seg = this.seg;
      this.seg = null;
      seg.closed = true;
      seg.endT = this.t;
      this.onCount = 0;
      this.env.length = 0;
      if (overlong && !seg.query) {
        // a long stretch of talk with no wake word in its first seconds: conversation, not a command
        if (seg.checked === false) seg.checked = "miss";
        this.stats.dropped++;
      }
      if (seg.voicedMs < this.o.minSpeechMs && !seg.query) {
        if (seg.checked === false) seg.checked = "miss";
        this.stats.dropped++;
        return;
      }
      // enqueue the (async) decision for this segment behind whatever is already being decided
      this._working = this._working.then(() => this._decide(seg)).catch(() => {});
    }

    // ---- wake check on the start of a still-running utterance
    _queueCheck(seg) {
      seg.checkQueued = true;
      this._working = this._working.then(() => this._check(seg)).catch(() => {});
    }

    async _transcribeRange(seg, maxMs, gate) {
      const per = this.o.windowMs;
      const n = maxMs ? Math.min(seg.windows.length, Math.ceil(maxMs / per)) : seg.windows.length;
      const parts = [];
      for (let i = 0; i < n; i++) {
        if (gate && seg.gate[i]) {
          const q = new Float32Array(seg.windows[i].length);
          for (let k = 0; k < q.length; k++) q[k] = seg.windows[i][k] * this.o.gateAttenuation;
          parts.push(q);
        } else parts.push(seg.windows[i]);
      }
      return String((await this.d.transcribe(concat(parts))) || "");
    }

    _overBudget() {
      const cutoff = this.t - 60000;
      this.checkTimes = this.checkTimes.filter((x) => x >= cutoff);
      if (this.checkTimes.length >= this.o.maxChecksPerMin) {
        this.backoffUntil = this.t + this.o.backoffMs; // a noisy room: be less trigger-happy for a while
        return true;
      }
      return false;
    }

    async _check(seg) {
      if (seg.checked !== false || this._closed) return;
      if (this._overBudget()) {
        seg.checked = "miss";
        return;
      }
      seg.checked = "pending";
      this.checkTimes.push(this.t);
      this.stats.checks++;
      const lastVoicedThen = seg.lastVoiced;
      const truncated = seg.windows.length * this.o.windowMs > this.o.prefixMs;
      let text = "";
      try {
        text = await this._transcribeRange(seg, this.o.prefixMs, false);
      } catch (_) {
        seg.checked = "miss";
        return;
      }
      const m = matchWake(text);
      if (!m.hit) {
        seg.checked = "miss";
        return;
      }
      seg.checked = "hit";
      // Remember what this read covered. If, when the utterance ends, nothing more has been voiced since and the read was not cut
      // short, it IS the full transcript and a second read is skipped (the common "Noah." case). Compared at the END, not now:
      // the person usually keeps talking after the check ("Noah, open YouTube" in one breath).
      seg.checkText = text;
      seg.checkVoicedAt = lastVoicedThen;
      seg.checkTruncated = truncated;
      this._onWake(seg, text);
    }

    _onWake(seg, text) {
      this.stats.wakes++;
      this.phase = "capturing";
      // the wake word's own loudness anchors the near-field gate
      this.speakerLevel = Math.max(this.o.absOn, median(seg.voicedRms));
      this.env.length = 0;
      this.d.onState({ phase: "capturing" });
      this.d.onWake({ prefix: text });
    }

    // ---- a finished utterance: was it the wake word, the request, or neither?
    async _decide(seg) {
      if (this._closed) return;
      if (seg.query) return this._finishRequest(seg, false);
      if (seg.checked === false) await this._check(seg); // shorter than the early-check window: decide now
      if (seg.checked !== "hit") return;
      if (this.phase !== "capturing") return; // reset (busy) while we were deciding
      await this._finishRequest(seg, true);
    }

    async _finishRequest(seg, hasWake) {
      if (seg.done) return; // a request that arrives on the heels of the name can be reached twice (its own turn, and from the name's): answer once
      seg.done = true;
      let text = "";
      try {
        const covered = hasWake && seg.checkText != null && !seg.checkTruncated && seg.lastVoiced === seg.checkVoicedAt;
        text = covered ? seg.checkText : await this._transcribeRange(seg, 0, true);
      } catch (_) {
        return this._toIdle();
      }
      let rest = text.trim();
      const m = matchWake(text);
      if (m.hit) rest = m.rest; // if the full read lost the name, the whole utterance is still the request
      if (hasRequest(rest)) {
        const pcm = concat(seg.windows);
        this.stats.queries++;
        this._toIdle();
        this.holdoffUntil = this.t + 500;
        this.d.onQuery(rest, { pcm });
        return;
      }
      if (hasWake) {
        // only the name: the request should follow
        this.phase = "await-query";
        this.awaitDeadline = seg.endT + this.o.awaitQueryMs;
        // a request may already be in progress or finished (spoken right on the heels of the name, before this was decided)
        const later = this.segments.find((s) => s.id > seg.id && !s.query);
        if (later) {
          later.query = true;
          later.checked = "query";
          if (later.closed) return this._finishRequest(later, false);
        }
        return;
      }
      // a request segment that came back empty (mumble, TV): keep waiting for a real one until the deadline
      if (this.phase === "capturing" || this.phase === "await-query") {
        this.phase = "await-query";
        this.awaitDeadline = Math.max(this.awaitDeadline, this.t + 2500);
      }
    }

    _tickAwait() {
      if (this.phase === "await-query" && this.t > this.awaitDeadline) {
        this._toIdle();
        this.d.onTimeout();
      }
    }

    _toIdle() {
      const was = this.phase;
      this.phase = "idle";
      this.speakerLevel = 0;
      this.env.length = 0;
      if (was !== "idle") this.d.onState({ phase: "idle" });
    }

    _reset(silent) {
      const was = this.phase;
      this.seg = null;
      this.segments.length = 0;
      this.onCount = 0;
      this.env.length = 0;
      this.phase = "idle";
      this.speakerLevel = 0;
      if (was !== "idle" && !silent) this.d.onState({ phase: "idle" });
    }
  }

  return { WakeEngine, matchWake, hasRequest, resampleTo, normalizePeak, rmsOf, DEFAULTS };
});
