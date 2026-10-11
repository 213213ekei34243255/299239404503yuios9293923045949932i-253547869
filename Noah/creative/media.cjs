// Noah/creative/media.cjs - FFmpeg and ffprobe, and the PROOF a media file is what it should be.
//
// An exit code of 0 is not evidence: an encode can produce an empty, truncated or wrongly sized file. `inspect` reads the file back with ffprobe
// (container, codecs, size, frame rate, duration, audio) and `decodeCheck` decodes every frame to nothing (ffmpeg -f null) and reports any error it sees.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { findTool } = require("./locate.cjs");

const TOKEN_OK = /^[^\0\r\n"`$!]+$/; // a token with & | < > ^ or a space is put in double quotes, where those are plain characters
const PERCENT_OK = /%(?!\d*d)/; // %04d (an image sequence pattern) is fine, %PATH% is not

/** Split an argument string like a command line does (double and single quotes group words). */
function tokenize(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || "")))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

/** The ffmpeg command line for the shell tool, or { error }. Every token is checked; a token with a space is quoted. */
function buildFfmpegCommand({ exe, args }) {
  if (!exe) return { error: "FFmpeg was not found (looked on PATH, in the usual install places and for FFMPEG_PATH). Install it, for example with: winget install Gyan.FFmpeg" };
  const tokens = Array.isArray(args) ? args.map(String) : tokenize(args);
  if (!tokens.length) return { error: "args is empty: give the ffmpeg arguments, for example: -y -i in.mp4 -c:v libx264 out.mp4" };
  for (const t of tokens) {
    if (!TOKEN_OK.test(t) || PERCENT_OK.test(t)) return { error: `the argument "${t.slice(0, 40)}" contains a character that is not allowed (a double quote, a backtick, $, ! or a % that is not a frame pattern like %04d)` };
  }
  if (/^[^\0\r\n"%`$!;]+$/.test(exe) === false) return { error: "the ffmpeg path contains a character that is not allowed" };
  const q = (s) => (/[\s;,()\[\]=&|<>^']/.test(s) ? `"${s}"` : s);
  return { cmd: [`"${exe}"`, "-hide_banner", "-nostdin", ...tokens.map(q)].join(" "), tokens };
}

/** ffprobe -> a small, flat description. Returns { ok:false, ... } for a file that cannot be read as media. */
function inspect(file, { ffprobe = null, spawn = spawnSync } = {}) {
  const probe = ffprobe || (findTool("ffprobe") || {}).path;
  if (!probe) return { ok: false, code: "ffprobe_not_found", message: "ffprobe was not found next to FFmpeg" };
  let st;
  try { st = fs.statSync(file); } catch (_) { return { ok: false, code: "missing", message: `${file} does not exist` }; }
  if (!st.size) return { ok: false, code: "empty", message: `${file} is empty (0 bytes)`, bytes: 0 };
  const r = spawn(probe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { encoding: "utf8", timeout: 60_000, windowsHide: true });
  if (r.error || r.status !== 0) return { ok: false, code: "unreadable", message: `ffprobe could not read ${file}: ${String(r.stderr || (r.error && r.error.message) || "").trim().slice(0, 300)}`, bytes: st.size };
  let j;
  try { j = JSON.parse(r.stdout); } catch (_) { return { ok: false, code: "unreadable", message: "ffprobe gave no usable answer", bytes: st.size }; }
  const v = (j.streams || []).find((s) => s.codec_type === "video");
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  const rate = v && v.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate.split("/").map(Number) : null;
  return {
    ok: true,
    bytes: st.size,
    container: j.format && j.format.format_name,
    durationSec: j.format && j.format.duration !== undefined ? Number(j.format.duration) : null,
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: rate && rate[1] ? Math.round((rate[0] / rate[1]) * 100) / 100 : null, frames: v.nb_frames ? Number(v.nb_frames) : null, pixFmt: v.pix_fmt } : null,
    audio: a ? { codec: a.codec_name, channels: a.channels, sampleRate: a.sample_rate ? Number(a.sample_rate) : null } : null,
  };
}

/** Decode the whole file to nowhere: any error ffmpeg reports means the file is not clean. */
function decodeCheck(file, { ffmpeg = null, spawn = spawnSync } = {}) {
  const exe = ffmpeg || (findTool("ffmpeg") || {}).path;
  if (!exe) return { ok: false, code: "ffmpeg_not_found", message: "FFmpeg was not found" };
  const r = spawn(exe, ["-v", "error", "-nostdin", "-i", file, "-f", "null", "-"], { encoding: "utf8", timeout: 10 * 60_000, windowsHide: true });
  const err = String(r.stderr || "").trim();
  if (r.error || r.status !== 0 || err) return { ok: false, code: "decode_errors", message: `decoding ${path.basename(file)} reported: ${(err || (r.error && r.error.message) || `exit ${r.status}`).slice(0, 400)}` };
  return { ok: true };
}

/** Compare what was made with what was asked for. `expect`: { width, height, minDurationSec, maxDurationSec, videoCodec, audio:true|false, fps }. */
function verify(file, expect = {}, opts = {}) {
  const info = inspect(file, opts);
  if (!info.ok) return { ...info, problems: [info.message] };
  const problems = [];
  if (expect.width && (!info.video || info.video.width !== expect.width)) problems.push(`width is ${info.video ? info.video.width : "none"}, expected ${expect.width}`);
  if (expect.height && (!info.video || info.video.height !== expect.height)) problems.push(`height is ${info.video ? info.video.height : "none"}, expected ${expect.height}`);
  if (expect.videoCodec && (!info.video || info.video.codec !== expect.videoCodec)) problems.push(`video codec is ${info.video ? info.video.codec : "none"}, expected ${expect.videoCodec}`);
  if (expect.fps && (!info.video || Math.abs((info.video.fps || 0) - expect.fps) > 0.1)) problems.push(`frame rate is ${info.video ? info.video.fps : "none"}, expected ${expect.fps}`);
  if (expect.minDurationSec !== undefined && !(info.durationSec >= expect.minDurationSec)) problems.push(`duration is ${info.durationSec}s, expected at least ${expect.minDurationSec}s`);
  if (expect.maxDurationSec !== undefined && !(info.durationSec <= expect.maxDurationSec)) problems.push(`duration is ${info.durationSec}s, expected at most ${expect.maxDurationSec}s`);
  if (expect.audio === true && !info.audio) problems.push("there is no audio stream");
  if (expect.audio === false && info.audio) problems.push("there is an audio stream but none was wanted");
  if (opts.decode !== false) {
    const d = decodeCheck(file, opts);
    if (!d.ok) problems.push(d.message);
  }
  return { ...info, ok: problems.length === 0, problems };
}

module.exports = { tokenize, buildFfmpegCommand, inspect, decodeCheck, verify };
