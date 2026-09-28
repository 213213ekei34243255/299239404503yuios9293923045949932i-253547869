// Noah/test/unit/wake-core.test.cjs
//
// The wake-word engine against synthetic audio. "Speech" is a tone (each frequency stands for a phrase), which lets the engine's
// real signal processing - noise floor, onset, pauses, near-field gating, timing - be exercised deterministically. A stand-in
// recogniser (fakeTranscribe) reads the phrase back from the audio, so a pause, a click or a background voice changes what it hears
// exactly as it would change what a real recogniser hears. The REAL recogniser on REAL synthesized speech is
// Noah/bench/integration/wake-e2e-check.cjs.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WakeEngine, matchWake, hasRequest, resampleTo, normalizePeak } = require("../../../wake-core.js");

const SR = 16000;
const tick = () => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------------ signal builders
function tone(freq, ms, amp = 0.15) {
  const n = Math.round((SR * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}
const silence = (ms) => new Float32Array(Math.round((SR * ms) / 1000));
function noise(ms, amp, seed = 1) {
  let s = seed;
  const out = new Float32Array(Math.round((SR * ms) / 1000));
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = amp * ((s / 4294967296) * 2 - 1);
  }
  return out;
}
function cat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function mix(a, b) {
  const n = Math.max(a.length, b.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (a[i] || 0) + (b[i] || 0);
  return out;
}
/** Push audio like a microphone does: in small chunks, letting the engine's background work run in between. */
async function feed(engine, pcm, chunkMs = 100) {
  const n = Math.round((SR * chunkMs) / 1000);
  for (let i = 0; i < pcm.length; i += n) {
    engine.pushFrame(pcm.subarray(i, Math.min(pcm.length, i + n)));
    await tick();
  }
}

// ------------------------------------------------------------------ the stand-in recogniser: frequency -> phrase
const PHRASES = [[300, "noah"], [500, "what is the weather"], [700, "hello how are you doing today"], [900, "open youtube"], [1100, "what time is it"]];
function makeTranscribe(log, delayMs = 0) {
  return async (pcm) => {
    log.push(pcm.length);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    // Like a real recogniser it follows the NEAR, LOUD speaker and hears nothing in quiet background: only 20 ms windows at
    // near-speaker level are read, 200 ms at a time, and a block needs most of its windows to be at that level to count.
    const win = 320;
    const per = 10;
    const words = [];
    for (let i = 0; i + win * per <= pcm.length; i += win * per) {
      let loud = 0, zc = 0;
      for (let w = 0; w < per; w++) {
        const b = pcm.subarray(i + w * win, i + (w + 1) * win);
        let e = 0;
        for (const x of b) e += x * x;
        if (Math.sqrt(e / b.length) < 0.05) continue;
        loud++;
        for (let k = 1; k < b.length; k++) if (b[k] > 0 !== b[k - 1] > 0) zc++;
      }
      if (loud < 6) continue;
      const f = zc / 2 / ((loud * win) / SR);
      const hit = PHRASES.find(([k]) => Math.abs(k - f) < 90);
      if (hit && words[words.length - 1] !== hit[1]) words.push(hit[1]);
    }
    return words.join(" ");
  };
}

function harness(opts = {}) {
  const log = { calls: [], wakes: [], queries: [], states: [], timeouts: 0 };
  let busy = false;
  const engine = new WakeEngine({
    transcribe: makeTranscribe(log.calls, opts.delayMs || 0),
    isBusy: () => busy,
    onWake: (i) => log.wakes.push({ ...i, t: engine.state.t }),
    onQuery: (text, info) => log.queries.push({ text, pcm: info.pcm, t: engine.state.t }),
    onState: (s) => log.states.push(s.phase),
    onTimeout: () => log.timeouts++,
    options: opts.options,
  });
  return { engine, log, setBusy: (v) => (busy = v) };
}

// ------------------------------------------------------------------ the wake phrase

test("matchWake: what counts as being called", () => {
  const hits = { "Noah": "", "Noah.": "", "noah, what time is it": "what time is it", "Hey Noah open YouTube": "open YouTube", "OK Noah, stop": "stop", "Hello, Noah!": "", "no ah what's up": "what's up", "Noa what's the weather": "what's the weather", "  \"Noah\" play music": "play music" };
  for (const [said, rest] of Object.entries(hits)) {
    const m = matchWake(said);
    assert.equal(m.hit, true, said);
    assert.equal(m.rest, rest, said);
  }
});

test("matchWake: ordinary speech that merely contains or resembles the name does NOT wake it - including 'Noahs ark'", () => {
  for (const said of ["no", "now what", "nah I don't think so", "Nova open the door", "I asked Noah yesterday", "the ark of Noah", "Noahs ark is a story", "so called Noah's ark", "Noah's ark is very old", "Noah’s ark was big", "know how to", "snow", "hey there", "", "no thanks", "No, ah well"]) {
    // "No, ah well" IS "no ah" said with a comma - that one is an accepted ambiguity, everything else must be a miss
    if (said === "No, ah well") continue;
    assert.equal(matchWake(said).hit, false, `should not wake: ${JSON.stringify(said)}`);
  }
});

test("hasRequest: a name plus a filler is not a request", () => {
  assert.equal(hasRequest("what time is it"), true);
  assert.equal(hasRequest("ok"), true);
  for (const s of ["", " ", "uh", "um, uh", "hmm", "...", "a"]) assert.equal(hasRequest(s), false, JSON.stringify(s));
});

test("resampleTo: 48 kHz -> 16 kHz keeps the length ratio and a speech-band tone", () => {
  const src = tone(440, 500, 0.5);
  const up = new Float32Array(src.length * 3);
  for (let i = 0; i < up.length; i++) up[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  const down = resampleTo(up, 48000, 16000);
  assert.ok(Math.abs(down.length - src.length) <= 1);
  let e = 0;
  for (let i = 100; i < down.length - 100; i++) e += (down[i] - src[i]) ** 2;
  assert.ok(Math.sqrt(e / down.length) < 0.06, "waveform preserved");
  assert.equal(resampleTo(src, 16000, 16000), src);
});

test("normalizePeak: quiet speech is brought up to an even level; near-silence, already-even audio and gain are handled sensibly", () => {
  const peakOf = (a) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  assert.ok(Math.abs(peakOf(normalizePeak(tone(300, 500, 0.1))) - 0.5) < 0.01, "0.1 -> 0.5");
  assert.ok(Math.abs(peakOf(normalizePeak(tone(300, 500, 0.9))) - 0.5) < 0.01, "0.9 -> 0.5");
  const even = tone(300, 500, 0.49);
  assert.equal(normalizePeak(even), even, "within 5% of the target: untouched (same array)");
  const hiss = noise(500, 0.003);
  assert.equal(normalizePeak(hiss), hiss, "room noise is never amplified into 'speech'");
  assert.ok(peakOf(normalizePeak(tone(300, 500, 0.02))) <= 0.02 * 8 + 1e-6, "gain is capped at 8x");
  assert.equal(normalizePeak(new Float32Array(0)).length, 0);
});

// ------------------------------------------------------------------ nothing to hear

test("silence and a quiet room: nothing is checked, nothing wakes", async () => {
  const { engine, log } = harness();
  await feed(engine, cat(noise(5000, 0.002)));
  await engine.idle();
  assert.equal(log.calls.length, 0);
  assert.equal(log.wakes.length, 0);
});

test("keyboard clicks are not speech: no utterance opens, the recogniser is never asked", async () => {
  const { engine, log } = harness();
  const parts = [];
  for (let i = 0; i < 12; i++) parts.push(silence(300), tone(2500, 3, 0.6)); // a 3 ms tap, twelve times
  await feed(engine, cat(...parts, silence(500)));
  await engine.idle();
  assert.equal(log.calls.length, 0, "no transcription for clicks");
});

test("a cough (150 ms burst) is too short to be speech", async () => {
  const { engine, log } = harness();
  await feed(engine, cat(silence(800), noise(150, 0.2, 7), silence(1500)));
  await engine.idle();
  assert.equal(log.calls.length, 0);
  assert.equal(log.wakes.length, 0);
});

test("ordinary conversation is checked once at its start, then ignored: no wake, no request", async () => {
  const { engine, log } = harness();
  await feed(engine, cat(silence(500), tone(700, 3000), silence(1500)));
  await engine.idle();
  assert.equal(log.calls.length, 1, "one look at the start of the utterance");
  assert.equal(log.wakes.length, 0);
  assert.equal(log.queries.length, 0);
});

test("a very long conversation cannot flood the recogniser (one check per stretch, never stuck)", async () => {
  const { engine, log } = harness();
  await feed(engine, cat(tone(700, 26000), silence(1500)));
  await engine.idle();
  assert.ok(log.calls.length <= 4, `checks: ${log.calls.length}`);
  assert.equal(log.wakes.length, 0);
});

// ------------------------------------------------------------------ waking it

test("'Noah', a pause, then the request: wakes at once, then delivers the request without the wake word", async () => {
  const { engine, log } = harness();
  await feed(engine, cat(silence(600), tone(300, 600), silence(900), tone(900, 1200), silence(1600)));
  await engine.idle();
  assert.equal(log.wakes.length, 1);
  assert.equal(log.queries.length, 1);
  assert.equal(log.queries[0].text, "open youtube");
  assert.ok(log.queries[0].pcm.length > SR, "the request audio is handed over too");
  assert.equal(log.states[0], "capturing");
  assert.equal(log.states[log.states.length - 1], "idle");
  assert.equal(engine.state.phase, "idle");
  assert.equal(log.calls.length, 2, "one look at 'Noah' (reused as its full read) + one for the request");
});

test("'Noah, what is the weather' in one breath: a single request, wake word stripped", async () => {
  const { engine, log } = harness();
  await feed(engine, cat(silence(600), tone(300, 500), tone(500, 1300), silence(1600)));
  await engine.idle();
  assert.equal(log.wakes.length, 1);
  assert.deepEqual(log.queries.map((q) => q.text), ["what is the weather"]);
});

test("the wake fires BEFORE the request ends (the orb can light up straight away)", async () => {
  const { engine, log } = harness();
  await feed(engine, cat(silence(600), tone(300, 500), tone(500, 4000), silence(1600)));
  await engine.idle();
  assert.equal(log.wakes.length, 1);
  assert.ok(log.queries[0].t - log.wakes[0].t > 3000, `wake at ${log.wakes[0].t} ms, request delivered at ${log.queries[0].t} ms`);
});

test("'Noah' alone, then nothing: times out after ~7 s, returns to idle, delivers no request", async () => {
  const { engine, log } = harness();
  await feed(engine, cat(silence(500), tone(300, 600), silence(9500)));
  await engine.idle();
  assert.equal(log.wakes.length, 1);
  assert.equal(log.timeouts, 1);
  assert.equal(log.queries.length, 0);
  assert.equal(engine.state.phase, "idle");
});

test("a request spoken right on the heels of 'Noah' while the recogniser is still slow is not lost or answered twice", async () => {
  const { engine, log } = harness({ delayMs: 40 });
  // 800 ms pause: just over the 650 ms utterance-ending pause, so 'Noah' and the request are separate utterances,
  // both fully heard before the (slow) recogniser has answered the first
  await feed(engine, cat(silence(500), tone(300, 600), silence(800), tone(900, 1200), silence(1800)), 200);
  await engine.idle();
  assert.equal(log.wakes.length, 1);
  assert.deepEqual(log.queries.map((q) => q.text), ["open youtube"]);
});

test("something that does not start with the name is never a request, even right after speech", async () => {
  const { engine, log } = harness();
  await feed(engine, cat(silence(500), tone(1100, 1200), silence(1200), tone(900, 1200), silence(1600)));
  await engine.idle();
  assert.equal(log.wakes.length, 0);
  assert.equal(log.queries.length, 0);
});

// ------------------------------------------------------------------ focusing on the person at the microphone

/** A distant voice: 400 ms bursts with 200 ms gaps (so the room's noise floor cannot simply absorb it), at ~13% of a near voice. */
function backgroundVoice(ms, freq = 1300, amp = 0.02) {
  const out = new Float32Array(Math.round((SR * ms) / 1000));
  const burst = tone(freq, 400, amp);
  for (let at = 0; at < out.length; at += Math.round(SR * 0.6)) out.set(burst.subarray(0, Math.min(burst.length, out.length - at)), at);
  return out;
}

test("a TV playing under the request does not keep it open: it ends shortly after the PERSON stops", async () => {
  const { engine, log } = harness();
  const tv = (ms) => backgroundVoice(ms);
  await feed(engine, cat(silence(500), mix(tone(300, 600), tv(600)), mix(silence(900), tv(900)), mix(tone(900, 1200), tv(1200)), tv(6000)));
  await engine.idle();
  assert.equal(log.wakes.length, 1);
  assert.deepEqual(log.queries.map((q) => q.text), ["open youtube"]);
  // the person stopped at ~3.2 s of audio; the request must be delivered soon after, not when the TV eventually stops
  assert.ok(log.queries[0].t < 3200 + 2500, `delivered at ${log.queries[0].t} ms`);
});

test("without the near-field gate the same TV WOULD hold the request open (the gate is what makes the difference)", async () => {
  const { engine, log } = harness({ options: { gateFraction: 0 } });
  const tv = (ms) => backgroundVoice(ms);
  await feed(engine, cat(silence(500), mix(tone(300, 600), tv(600)), mix(silence(900), tv(900)), mix(tone(900, 1200), tv(1200)), tv(6000)));
  await engine.idle();
  assert.ok(log.queries.length === 0 || log.queries[0].t > 3200 + 4000, "held open by the background sound");
});

test("a fan switching on (steady noise well above the old floor) stops counting as speech within seconds", async () => {
  const { engine, log } = harness();
  await feed(engine, cat(noise(3000, 0.004, 3), noise(12000, 0.06, 5), silence(500)));
  await engine.idle();
  assert.ok(log.calls.length <= 2, `checks while a fan runs: ${log.calls.length}`);
  assert.equal(log.wakes.length, 0);
  assert.equal(engine.state.phase, "idle");
});

// ------------------------------------------------------------------ the app is busy

test("while the app is speaking or the user is typing (isBusy), nothing heard counts; afterwards it works again", async () => {
  const { engine, log, setBusy } = harness();
  setBusy(true);
  await feed(engine, cat(silence(300), tone(300, 600), silence(900), tone(900, 1200), silence(1600)));
  await engine.idle();
  assert.equal(log.wakes.length, 0);
  assert.equal(log.calls.length, 0);
  setBusy(false);
  await feed(engine, cat(silence(1500), tone(300, 600), silence(900), tone(900, 1200), silence(1600)));
  await engine.idle();
  assert.equal(log.wakes.length, 1);
  assert.deepEqual(log.queries.map((q) => q.text), ["open youtube"]);
});

test("becoming busy in the middle of a capture abandons it cleanly (no half request is delivered)", async () => {
  const { engine, log, setBusy } = harness();
  await feed(engine, cat(silence(500), tone(300, 500), tone(500, 1500)));
  await engine.idle();
  assert.equal(log.wakes.length, 1);
  setBusy(true); // e.g. the user clicked the orb
  await feed(engine, cat(tone(500, 1000), silence(2000)));
  await engine.idle();
  assert.equal(log.queries.length, 0);
  assert.equal(engine.state.phase, "idle");
  assert.equal(log.states[log.states.length - 1], "idle");
});

// ------------------------------------------------------------------ budget and lifecycle

test("a noisy room cannot keep the recogniser busy: at most 25 checks a minute", async () => {
  const { engine, log } = harness();
  const parts = [];
  for (let i = 0; i < 34; i++) parts.push(tone(700, 700), silence(1000));
  await feed(engine, cat(...parts));
  await engine.idle();
  assert.ok(log.calls.length <= 25, `checks: ${log.calls.length}`);
  assert.ok(log.calls.length >= 20, "and it did keep listening up to the budget");
});

test("close() stops everything: later audio does nothing", async () => {
  const { engine, log } = harness();
  engine.close();
  await feed(engine, cat(tone(300, 600), silence(900), tone(900, 1200), silence(1600)));
  await engine.idle();
  assert.equal(log.wakes.length, 0);
  assert.equal(log.calls.length, 0);
});

test("audio may arrive in odd-sized pieces (not a whole number of 20 ms windows)", async () => {
  const { engine, log } = harness();
  const pcm = cat(silence(600), tone(300, 600), silence(900), tone(900, 1200), silence(1600));
  for (let i = 0; i < pcm.length; i += 777) {
    engine.pushFrame(pcm.subarray(i, Math.min(pcm.length, i + 777)));
    if (i % 7770 === 0) await tick();
  }
  await engine.idle();
  assert.equal(log.wakes.length, 1);
  assert.deepEqual(log.queries.map((q) => q.text), ["open youtube"]);
});
