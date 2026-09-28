// Noah/bench/integration/wake-e2e-check.cjs
//
// The wake word, end to end, with nothing important faked:
//   * REAL speech - Windows' own text-to-speech (David and Zira) says the test phrases, assembled into one audio file with pauses;
//   * REAL microphone path - Chromium's fake capture device plays that file into getUserMedia, so wake-listener.js's actual audio
//     graph (echo/noise suppression, 16 kHz context, filters, AudioWorklet) runs;
//   * REAL recogniser - the Moonshine model, downloaded and run in the page by transformers.js, exactly as the orb does;
//   * REAL UI - the actual assistant panel (its "Wake word" checkbox) and voice-orb.js, in test/wake-harness.html.
// Only the app BACKEND is stubbed: window.rexy.goal (where a request would go) and window.api.kokoroSpeak (the TTS server).
//
// NOT covered, because it cannot be from here: a human voice, a real microphone's hardware/room, macOS permission prompts.
// Needs internet the first time (the speech model). About 3-6 minutes.
//
//   npx electron Noah/bench/integration/wake-e2e-check.cjs
"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");
const { app, BrowserWindow, session } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "jonah-wake-e2e-"));
const SR = 16000;
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 1) real speech, assembled into one timeline
const PS1 = path.join(TMP, "say.ps1");
fs.writeFileSync(
  PS1,
  [
    "param([string]$Out, [string]$Text, [string]$Voice)",
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$s.SelectVoice($Voice)",
    "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
    "$s.SetOutputToWaveFile($Out, $fmt)",
    "$s.Speak($Text)",
    "$s.Dispose()",
  ].join("\r\n")
);
function say(text, voice) {
  const out = path.join(TMP, `say-${Math.abs(hash(text + voice))}.wav`);
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PS1, "-Out", out, "-Text", text, "-Voice", voice], { stdio: "pipe" });
  return readWav(out);
}
const hash = (s) => [...s].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12;
  while (p + 8 <= b.length) {
    const id = b.toString("latin1", p, p + 4), len = b.readUInt32LE(p + 4);
    if (id === "data") {
      const n = Math.floor(Math.min(len, b.length - p - 8) / 2), out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(p + 8 + i * 2) / 32768;
      return out;
    }
    p += 8 + len + (len % 2);
  }
  throw new Error("no data chunk in " + file);
}
const pad = (ms) => new Float32Array(Math.round((SR * ms) / 1000));
function writeWav(file, f32) {
  const b = Buffer.alloc(44 + f32.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + f32.length * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(f32.length * 2, 40);
  for (let i = 0; i < f32.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, b);
}

const ZIRA = "Microsoft Zira Desktop", DAVID = "Microsoft David Desktop";
const scenes = []; // { name, from, to (ms in the audio timeline), expect }
let timeline = [pad(6000)]; // warm-up: the audio graph needs a moment before it hears anything
let cursor = 6000;
function add(name, parts, tailMs, expect) {
  const from = cursor;
  for (const p of parts) {
    timeline.push(p);
    cursor += (p.length / SR) * 1000;
  }
  const speechEnd = cursor;
  timeline.push(pad(tailMs));
  cursor += tailMs;
  scenes.push({ name, from, speechEnd, to: cursor, expect });
}
console.log("synthesizing test speech with Windows voices...");
add("wake, pause, then the request", [say("Noah", ZIRA), pad(1100), say("What is two plus two?", ZIRA)], 9000, { goal: /(two plus two|2 ?\+ ?2|2 plus 2)/i });
add("one breath: 'Noah, what time is it?'", [say("Noah, what time is it?", DAVID)], 9000, { goal: /what time is it/i });
add("'Noah's ark...' and ordinary talk (must NOT wake)", [say("Noah's ark is very old.", ZIRA), pad(1500), say("Hello, how are you doing today?", DAVID)], 6000, { goal: null });
add("spoken while the user is typing (must NOT wake)", [say("Noah, what is the capital of France?", DAVID)], 9000, { goal: null, typing: true });
add("after typing stops: works again", [say("Noah, what is the capital of Italy?", ZIRA)], 9000, { goal: /capital of italy/i });
const WAV = path.join(TMP, "timeline.wav");
const speech = Float32Array.from(timeline.flatMap((t) => Array.from(t)));
let seed = 12345;
const roomTone = (i) => { seed = (seed * 1664525 + 1013904223) >>> 0; return ((seed / 4294967296) - 0.5) * 0.010 + 0.0012 * Math.sin((2 * Math.PI * 50 * i) / SR); };
for (let i = 0; i < speech.length; i++) speech[i] += roomTone(i);
writeWav(WAV, speech);
const TOTAL_MS = cursor;
console.log(`timeline: ${(TOTAL_MS / 1000).toFixed(1)} s; scenes: ${scenes.map((s) => `${s.name} @${(s.from / 1000).toFixed(1)}s`).join(" | ")}`);

// ------------------------------------------------------------------ 2) Chromium plays the file as the microphone
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("use-file-for-fake-audio-capture", WAV + "%noloop");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.on("window-all-closed", () => {});

async function main() {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);
  const win = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { backgroundThrottling: false, contextIsolation: true } });
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2 && !/fonts.googleapis|Autofill|Electron Security Warning/.test(message)) console.log("   [page]", message.slice(0, 200));
  });
  const query = { ns: process.env.WAKE_NS || "1", agc: process.env.WAKE_AGC || "1" };
  console.log(`browser audio processing: noiseSuppression=${query.ns === "1"} autoGainControl=${query.agc === "1"}`);
  await win.loadFile(path.join(__dirname, "wake-harness.html"), { query });
  const ev = (js) => win.webContents.executeJavaScript(js, true);
  for (let i = 0; i < 40 && !(await ev("!!document.getElementById('jonah-voice-orb')")); i++) await sleep(250);
  check("the real voice orb mounted in the page", await ev("!!document.getElementById('jonah-voice-orb')"));

  let frame = null;
  for (let i = 0; i < 40 && !frame; i++) {
    frame = win.webContents.mainFrame.frames.find((f) => /ai-panel\.html/.test(f.url));
    if (!frame) await sleep(250);
  }
  check("the real assistant panel loaded in its iframe", !!frame);
  const panel = (js) => frame.executeJavaScript(js, true);
  await sleep(800);
  check("the panel has a 'Wake word' switch, off by default", (await panel("document.getElementById('noahWake') && document.getElementById('noahWake').checked === false")) === true);

  // ---- switch it on, exactly as a user does; the reported bug was: it stays on "loading the voice model..." forever
  const t0 = Date.now();
  await panel("document.getElementById('noahWake').click(); true");
  const phases = [];
  const sample = setInterval(async () => {
    try {
      const s = await panel("document.getElementById('wakeState').dataset.phase + '|' + document.getElementById('wakeState').textContent");
      if (phases[phases.length - 1] !== s) phases.push(s);
    } catch (_) { /* frame busy */ }
  }, 150);
  let listening = false;
  for (let i = 0; i < 1500 && !listening; i++) {
    await sleep(200);
    listening = (await panel("document.getElementById('wakeState').dataset.phase")) === "listening" && !!(await ev("window.__micOpenedAt"));
  }
  check("switching it on gets past 'loading the voice model…' to 'listening' (the reported bug)", listening, `${((Date.now() - t0) / 1000).toFixed(0)} s; panel said: ${JSON.stringify(phases)}`);
  if (!listening) {
    console.log("   heard so far:", JSON.stringify(await ev("window.__heard")));
    return finish(win, sample);
  }
  check("the orb shows the open-microphone dot", await ev("document.getElementById('jonah-voice-orb').classList.contains('wake-on')"));
  const micAt = await ev("window.__micOpenedAt");
  const audioT = () => Date.now() - micAt;

  // ---- play the timeline; ping 'typing' from the real panel during the typing scene
  console.log("listening; the fake microphone is playing the timeline...");
  const typing = scenes.find((s) => s.expect && s.expect.typing);
  const orbStates = new Set();
  while (audioT() < TOTAL_MS + 6000) {
    // The fake microphone starts playing the file ~2.3 s BEFORE getUserMedia resolves (measured from the engine trace), so wall time since
    // the microphone opened runs behind the file position. The keystrokes span the whole utterance with margin on both sides.
    if (typing && audioT() > typing.from - 4500 && audioT() < typing.speechEnd + 500) await panel("document.getElementById('input').dispatchEvent(new Event('input')); true").catch(() => {});
    const cls = await ev("document.getElementById('jonah-voice-orb').className");
    for (const c of cls.split(" ")) if (c.startsWith("state-")) orbStates.add(c);
    await sleep(250);
  }
  clearInterval(sample);

  const goals = await ev("window.__goals");
  const heard = await ev("window.__heard");
  const speech = await ev("window.__speech");
  const lag = await ev("window.__lag");
  const typingMsgs = await ev("window.__typingMsgs");
  console.log(`   main-thread freeze (50 ms heartbeat): worst gap ${lag.max} ms; ${lag.over300} gaps > 0.3 s; ${lag.over1000} gaps > 1 s`);
  console.log(`   typing signals reached the shell at (ms after mic opened): ${typingMsgs.slice(0, 4).join(", ")}${typingMsgs.length > 4 ? ", ..., " + typingMsgs[typingMsgs.length - 1] : ""} (${typingMsgs.length} total)`);
  const trace = await ev("window.__trace");
  fs.mkdirSync(path.join(ROOT, "Noah", "bench", "results"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "Noah", "bench", "results", "wake-e2e-trace.json"), JSON.stringify({ scenes, micOpenedAt: micAt, trace }));
  console.log("   engine events (audio ms):", trace.events.map((e) => `${e.ev}@${e.t}${e.voicedMs != null ? `(voiced ${e.voicedMs})` : ""}${e.result ? `=${e.result}` : ""}`).join(" "));
  console.log("   what the recogniser heard:", JSON.stringify(heard.map((h) => `${h.text} (${h.ms}ms)`)));
  console.log("   requests submitted:", JSON.stringify(goals.map((g) => g.text)));
  // Which scene does a request belong to? Not by wall-clock windows (the fake microphone starts playing before getUserMedia resolves, and
  // recognition speed varies, so requests drift across any fixed window) but by WHERE IN THE AUDIO the engine was when it was submitted:
  // engine time -> file position via the first utterance the engine opened (scene 1's first word).
  const firstOpen = trace.events.find((e) => e.ev === "open");
  const offset0 = firstOpen ? scenes[0].from + 80 - firstOpen.t : 0;
  const fileT = (g) => (g.engineT != null ? g.engineT + offset0 : g.at - micAt);
  for (const s of scenes) {
    const next = scenes[scenes.indexOf(s) + 1];
    const inScene = goals.filter((g) => fileT(g) >= s.from && fileT(g) < (next ? next.from : Infinity));
    if (s.expect.goal) {
      check(`${s.name}: exactly one request, spoken source, wake word stripped`, inScene.length === 1 && inScene[0].source === "voice" && s.expect.goal.test(inScene[0].text) && !/noah/i.test(inScene[0].text), JSON.stringify(inScene.map((g) => g.text)));
    } else {
      check(`${s.name}: no request submitted`, inScene.length === 0, JSON.stringify(inScene.map((g) => g.text)));
    }
  }
  check("the orb showed it was listening during a capture", orbStates.has("state-listening"), [...orbStates].join(","));
  check("each spoken request was answered ALOUD (3 of 3)", speech.filter((t) => /^Reply to:/.test(t)).length === 3, JSON.stringify(speech));
  const sawCapturing = phases.some((p) => p.startsWith("capturing"));
  check("the panel reflected the capture ('listening to you…')", sawCapturing, JSON.stringify(phases));

  // a TYPED chat is never read aloud
  const speechBefore = speech.length;
  await ev("window.__cbs.completed.forEach((cb) => cb({ reason: 'a typed reply', source: 'text' })); true");
  await sleep(1500);
  check("a typed chat's reply is NOT spoken", (await ev("window.__speech.length")) === speechBefore);

  // ---- switching off releases the microphone
  await panel("document.getElementById('noahWake').click(); true");
  await sleep(1200);
  const tracks = await ev("window.__tracks.map((t) => t.readyState)");
  check("switching it off closes every microphone track (the OS indicator goes out)", tracks.length > 0 && tracks.every((s) => s === "ended"), JSON.stringify(tracks));
  check("and the orb's dot goes out", !(await ev("document.getElementById('jonah-voice-orb').classList.contains('wake-on')")));
  check("the panel shows it is off", (await panel("document.getElementById('noahWake').checked")) === false);
  return finish(win, sample);
}

function finish(win, sample) {
  clearInterval(sample);
  console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
  try { win.destroy(); } catch (_) { /* gone */ }
  app.exit(checks.every(Boolean) ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error("E2E FAILED:", e && e.stack);
    app.exit(1);
  })
);
