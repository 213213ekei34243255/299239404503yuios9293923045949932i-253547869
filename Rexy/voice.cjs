// Rexy/voice.cjs
//
// Voice gives Noah a spoken output channel. It runs in the Electron main
// process, so it never calls speechSynthesis itself — that API only
// exists in a renderer. Instead it drives the app's own renderer window
// via executeJavaScript, the same way bridge.js drives the browsed page.
//
//   Runtime -> Voice -> Renderer -> speechSynthesis
//
// speak() injects a small async script into mainWindow's renderer that
// creates a SpeechSynthesisUtterance and resolves a Promise on
// end/error/cancel — executeJavaScript awaits that Promise directly, so
// voice.cjs doesn't need a separate IPC round trip just to know when
// speech finished.

"use strict";

const Logger = require("./logger.cjs");

// Preference order used when no explicit voice has been set. Checked as
// case-insensitive substrings against each available voice's name, so
// this works whether the OS exposes "Microsoft Aria Online (Natural) -
// English (United States)" or a plain "Aria".
const PREFERRED_NAME_HINTS = ["Aria", "Jenny", "Samantha", "Google US English"];

class Voice {
  /**
   * @param {import('electron').BrowserWindow} mainWindow
   * @param {object} [options]
   */
  constructor(mainWindow, options = {}) {
    this.mainWindow = mainWindow;
    this.enabled = false;
    this.speaking = false;
    this.currentVoice = options.voice || null; // voice name, resolved lazily
    this.rate = options.rate ?? 1.0;
    this.pitch = options.pitch ?? 1.0;
    this.volume = options.volume ?? 1.0;

    this.log = new Logger({ scope: "voice", level: options.logLevel || "info" });

    this._voices = [];
    this._activeSpeakToken = 0;
  }

  // ===================================================================
  // Lifecycle
  // ===================================================================

  /** Loads the available voices from the renderer and picks a default. */
  async initialize() {
    this._voices = await this.listVoices();
    if (!this.currentVoice) {
      const picked = this._pickDefaultVoice(this._voices);
      this.currentVoice = picked?.name || null;
      this.log.info(`Selected voice: ${this.currentVoice || "(browser default)"}`);
    }
    this.enabled = true;
    this.log.info("Voice initialized");
  }

  // ===================================================================
  // Speaking
  // ===================================================================

  /**
   * Speaks `text` and resolves once speech finishes (or is cancelled).
   * @param {string} text
   * @param {object} [opts] per-call overrides for voice/rate/pitch/volume
   * @returns {Promise<{completed:boolean, error?:string}>}
   */
  async speak(text, opts = {}) {
    if (!this.enabled) {
      this.log.warn("speak() called before initialize(); proceeding anyway");
    }
    if (!text || !String(text).trim()) return { completed: false, error: "empty text" };

    const token = ++this._activeSpeakToken;
    this.speaking = true;

    const voiceName = opts.voice ?? this.currentVoice;
    const rate = opts.rate ?? this.rate;
    const pitch = opts.pitch ?? this.pitch;
    const volume = opts.volume ?? this.volume;

    const script = `(() => new Promise((resolve) => {
      try {
        const utter = new SpeechSynthesisUtterance(${JSON.stringify(String(text))});
        const voices = speechSynthesis.getVoices();
        const wanted = ${JSON.stringify(voiceName)};
        if (wanted) {
          const match = voices.find((v) => v.name === wanted);
          if (match) utter.voice = match;
        }
        utter.rate = ${Number(rate)};
        utter.pitch = ${Number(pitch)};
        utter.volume = ${Number(volume)};
        utter.onend = () => resolve({ completed: true });
        utter.onerror = (e) => resolve({ completed: false, error: (e && e.error) || "speech error" });
        speechSynthesis.speak(utter);
      } catch (err) {
        resolve({ completed: false, error: err.message });
      }
    }))();`;

    try {
      const result = await this._wc().executeJavaScript(script, true);
      if (token === this._activeSpeakToken) this.speaking = false;
      return result;
    } catch (err) {
      if (token === this._activeSpeakToken) this.speaking = false;
      this.log.error("speak() failed:", err.message);
      return { completed: false, error: err.message };
    }
  }

  /** Stops speaking immediately. */
  stop() {
    this.speaking = false;
    this._activeSpeakToken++; // any in-flight speak()'s resolution is now stale
    this._fireAndForget(`speechSynthesis.cancel()`);
  }

  /** Pauses speech (can be resumed). */
  pause() {
    this._fireAndForget(`speechSynthesis.pause()`);
  }

  /** Resumes previously paused speech. */
  resume() {
    this._fireAndForget(`speechSynthesis.resume()`);
  }

  isSpeaking() {
    return this.speaking;
  }

  // ===================================================================
  // Voice / rate / pitch / volume configuration
  // ===================================================================

  /**
   * @param {string} name  exact voice name as reported by listVoices()
   */
  setVoice(name) {
    this.currentVoice = name;
  }

  setRate(rate) {
    this.rate = this._clamp(rate, 0.1, 10);
  }

  setPitch(pitch) {
    this.pitch = this._clamp(pitch, 0, 2);
  }

  setVolume(volume) {
    this.volume = this._clamp(volume, 0, 1);
  }

  _clamp(value, min, max) {
    const n = Number(value);
    if (Number.isNaN(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  // ===================================================================
  // Voice discovery
  // ===================================================================

  /**
   * @returns {Promise<{name:string, lang:string, localService:boolean, default:boolean}[]>}
   */
  async listVoices() {
    // getVoices() can return an empty list on the very first call before
    // the browser has finished loading its voice list, so wait for the
    // 'voiceschanged' event once if needed.
    const script = `(() => new Promise((resolve) => {
      const map = (voices) => voices.map((v) => ({
        name: v.name,
        lang: v.lang,
        localService: v.localService,
        default: v.default,
      }));
      const existing = speechSynthesis.getVoices();
      if (existing.length > 0) {
        resolve(map(existing));
        return;
      }
      const onChange = () => {
        speechSynthesis.removeEventListener("voiceschanged", onChange);
        resolve(map(speechSynthesis.getVoices()));
      };
      speechSynthesis.addEventListener("voiceschanged", onChange);
      // Fall back to whatever's available after a short wait in case
      // 'voiceschanged' never fires on this platform.
      setTimeout(() => {
        speechSynthesis.removeEventListener("voiceschanged", onChange);
        resolve(map(speechSynthesis.getVoices()));
      }, 1000);
    }))();`;

    try {
      const voices = await this._wc().executeJavaScript(script, true);
      this._voices = voices || [];
      return this._voices;
    } catch (err) {
      this.log.warn("listVoices() failed:", err.message);
      return [];
    }
  }

  // ===================================================================
  // Default voice selection — OS-independent
  // ===================================================================

  _pickDefaultVoice(voices) {
    if (!voices || voices.length === 0) return null;

    // 1. Prefer en-US voices.
    const enUS = voices.filter((v) => (v.lang || "").toLowerCase() === "en-us");
    const pool = enUS.length > 0 ? enUS : voices;

    // 2. Within that pool, prefer known natural-sounding names.
    for (const hint of PREFERRED_NAME_HINTS) {
      const match = pool.find((v) => v.name.toLowerCase().includes(hint.toLowerCase()));
      if (match) return match;
    }

    // 3. Fall back to the platform's marked default, or just the first
    // en-US voice, or the very first voice available.
    return pool.find((v) => v.default) || pool[0] || voices[0];
  }

  // ===================================================================
  // internal
  // ===================================================================

  _wc() {
    const wc = this.mainWindow?.webContents;
    if (!wc || wc.isDestroyed()) throw new Error("Voice: no active webContents to speak through");
    return wc;
  }

  _fireAndForget(script) {
    try {
      this._wc().executeJavaScript(script, true).catch((err) => this.log.warn(`"${script}" failed:`, err.message));
    } catch (err) {
      this.log.warn(`"${script}" failed:`, err.message);
    }
  }
}

module.exports = Voice;
