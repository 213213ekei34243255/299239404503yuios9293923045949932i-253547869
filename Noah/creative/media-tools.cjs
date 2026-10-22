// Noah/creative/media-tools.cjs - the ffmpeg_run and media_probe tools (the registry's `t` gives the workspace and the shell tool).
"use strict";

const fs = require("fs");
const path = require("path");
const locate = require("./locate.cjs");
const findTool = (...a) => locate.findTool(...a); // looked up at call time
const { buildFfmpegCommand, inspect, verify } = require("./media.cjs");

/**
 * Run FFmpeg through the mission's shell tool (same environment scrubbing, timeout and process-tree kill as any command), then read the output back.
 * @param {{ shell: object, workspace: object, ffmpegPath?: string|null }} t
 */
async function runFfmpeg(t, { args, output, cwd, timeoutMs, width, height, minDurationSec, audio }, { signal } = {}) {
  let found = t.ffmpegPath !== undefined ? (t.ffmpegPath ? { path: t.ffmpegPath } : null) : findTool("ffmpeg");
  if (!found && t.ffmpegPath === undefined) { // not installed: get it (Noah/creative/deps.cjs), then carry on
    const got = await require("./deps.cjs").ensureProgram(t, "ffmpeg", { signal, why: "Noah needs FFmpeg for this video task and it is not installed." });
    if (!got.ok) return { ok: false, code: got.code === "user_denied" ? "user_denied" : "ffmpeg_not_found", message: got.message };
    found = findTool("ffmpeg") || { path: got.path };
  }
  const built = buildFfmpegCommand({ exe: found && found.path, args });
  if (built.error) return { ok: false, code: found ? "invalid_arguments" : "ffmpeg_not_found", message: built.error };
  const real = t.workspace.resolve(cwd || ".");
  const expected = output ? path.resolve(real, output) : null;
  let before = null;
  if (expected) { try { before = fs.statSync(expected).mtimeMs; } catch (_) { /* did not exist */ } }
  const r = await t.shell.run({ cmd: built.cmd, cwd, timeoutMs: timeoutMs || 600_000, retry: false }, { signal });
  if (!r.ok) return { ...r, ffmpeg: found.path };
  const result = { ...r, ffmpeg: found.path };
  if (expected) {
    let st = null;
    try { st = fs.statSync(expected); } catch (_) { /* reported below */ }
    if (!st) return { ...result, ok: false, code: "output_missing", message: `FFmpeg finished (exit 0) but ${output} was not created` };
    if (before !== null && st.mtimeMs === before) return { ...result, ok: false, code: "output_stale", message: `FFmpeg finished but ${output} was not written (it is the same file as before)` };
    const expect = {};
    if (width) expect.width = width;
    if (height) expect.height = height;
    if (minDurationSec !== undefined && minDurationSec !== null) expect.minDurationSec = minDurationSec;
    if (audio === true || audio === false) expect.audio = audio;
    const isVideoLike = /\.(mp4|mov|mkv|webm|avi|m4v|gif|mp3|wav|aac|flac|ogg|m4a|png|jpg|jpeg|webp)$/i.test(output);
    if (isVideoLike) {
      const v = verify(expected, expect, {});
      result.media = { bytes: v.bytes, container: v.container, durationSec: v.durationSec, video: v.video, audio: v.audio };
      if (!v.ok) return { ...result, ok: false, code: "output_invalid", message: `FFmpeg finished but the output is not right: ${v.problems.join("; ")}`, problems: v.problems };
    } else result.media = { bytes: st.size };
  }
  return result;
}

async function probeMedia(t, { path: file, cwd, decode }) {
  const real = t.workspace.resolve(cwd || ".");
  const abs = path.resolve(real, file);
  let exe = t.ffmpegPath !== undefined ? t.ffmpegPath : (findTool("ffmpeg") || {}).path;
  let probe = (findTool("ffprobe") || {}).path;
  if ((!probe || !exe) && t.ffmpegPath === undefined) {
    const got = await require("./deps.cjs").ensureProgram(t, "ffprobe", { why: "Noah needs ffprobe to read media files and it is not installed." });
    if (got.ok) { probe = (findTool("ffprobe") || {}).path || got.path; exe = exe || (findTool("ffmpeg") || {}).path; }
  }
  if (!probe) return { ok: false, code: "ffprobe_not_found", message: "ffprobe was not found (it ships with FFmpeg): install FFmpeg, for example with: winget install Gyan.FFmpeg" };
  const v = verify(abs, {}, { ffprobe: probe, ffmpeg: exe, decode: decode !== false });
  const { problems, ...info } = v;
  return problems.length ? { ...info, ok: false, code: v.code || "media_problem", message: problems.join("; "), problems } : { ...info, ok: true };
}

module.exports = { runFfmpeg, probeMedia };
