// Noah/models/catalog.cjs
//
// Default provider endpoints, role -> model preference lists, and per-model
// capability hints. This is DATA, not logic: model names and prices change
// monthly, so nothing else in Noah hard-codes a model. Every entry below was
// taken from public documentation on 2026-09-21 (see docs/RESEARCH.md) and is
// marked verified:false because none of these endpoints could be called live
// from the build environment (no cloud API credentials were available). Confirm
// the IDs against your account before relying on them, and edit them in
// Noah settings (noah-config.json) - nothing needs a code change.

"use strict";

// Roles (spec §12).
//   planner  task decomposition, replanning, long-horizon reasoning (called rarely)
//   browser  DOM/AX-text reasoning + element selection (the workhorse: most calls)
//   vision   screenshot grounding / computer-use (coordinates)
//   fast     cheap classification, extraction, summaries, short decisions
//   local    offline / private / low-latency fallback
const ROLES = ["planner", "browser", "vision", "fast", "local", "mission"];

const DEFAULT_PROVIDERS = {
  anthropic: { type: "anthropic", baseURL: "https://api.anthropic.com", keyEnv: ["ANTHROPIC_API_KEY"], enabled: true },
  openai: { type: "openai", baseURL: "https://api.openai.com/v1", keyEnv: ["OPENAI_API_KEY"], enabled: true, tokenParam: "max_completion_tokens" },
  google: { type: "google", baseURL: "https://generativelanguage.googleapis.com/v1beta", keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], enabled: true },
  // Qwen via Alibaba's OpenAI-compatible endpoint (international region).
  qwen: { type: "openai", baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", keyEnv: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"], enabled: true, tokenParam: "max_tokens" },
  // Local OpenAI-compatible server (Ollama / LM Studio / vLLM). No key needed.
  local: { type: "openai", baseURL: "http://127.0.0.1:11434/v1", keyEnv: [], enabled: true, tokenParam: "max_tokens", local: true, keyless: true },
  // Jonah's own hosted model (the old Render deployment is suspended). Text-only; no screenshots or tool contract.
  rexy: { type: "rexy", baseURL: "https://www.noahai.live/predict", keyEnv: ["REXY_LLM_API_KEY"], enabled: true, keyless: true, legacy: true },
  // Jonah's hosted brain: Gemini behind noahai.live's signed POST /api/llm/step. The app holds no key for it; it is ready only while the user is signed in.
  noahai: { type: "noahai", baseURL: "https://www.noahai.live", keyEnv: [], enabled: true, keyless: true, hosted: true },
};

// Per-model hints used for routing decisions (vision? coordinate space? price?).
// Unknown models fall back to conservative defaults (vision:true, image_px).
const MODEL_INFO = {
  // Jonah's hosted brain (noahai.live /api/llm/step): the candidate is named after the ROLE the server maps to a Gemini model. MEASURED on the real server (gemini-3.8-flash, 2026-10-23): images
  // reach Gemini unchanged, and asked where to click it answers on a 0-1000 grid (x / width * 1000); asked for pixels it did so only 2 of 3 times, so the grid is the contract.
  // "browser" maps to a flash-lite model whose image handling has NOT been verified, so it is text-only here: any step with a screenshot goes to "vision" / "mission" (gemini-3.8-flash).
  mission: { vision: true, tools: true, coordinateSpace: "normalized_1000", maxImageLongEdge: 1568, tier: "hosted" },
  vision: { vision: true, tools: true, coordinateSpace: "normalized_1000", maxImageLongEdge: 1568, tier: "hosted" },
  browser: { vision: false, tools: true, coordinateSpace: "normalized_1000", maxImageLongEdge: 1568, tier: "hosted" },
  "claude-opus-5": { vision: true, tools: true, contextTokens: 1_000_000, coordinateSpace: "image_px", maxImageLongEdge: 2576, priceIn: 5, priceOut: 25, tier: "frontier" },
  "claude-sonnet-5": { vision: true, tools: true, contextTokens: 1_000_000, coordinateSpace: "image_px", maxImageLongEdge: 2576, priceIn: 3, priceOut: 15, tier: "strong" },
  "claude-fable-5-1": { vision: true, tools: true, contextTokens: 1_000_000, coordinateSpace: "image_px", maxImageLongEdge: 2000, tier: "frontier" },
  "claude-haiku-4-5-20251001": { vision: true, tools: true, contextTokens: 200_000, coordinateSpace: "image_px", maxImageLongEdge: 1568, tier: "fast" },
  "gpt-5.4": { vision: true, tools: true, coordinateSpace: "image_px", maxImageLongEdge: 2048, tier: "strong" },
  "gemini-3.8-flash": { vision: true, tools: true, coordinateSpace: "normalized_1000", maxImageLongEdge: 1568, tier: "strong" },
  "gemini-3.7-flash": { vision: true, tools: true, coordinateSpace: "normalized_1000", maxImageLongEdge: 1568, tier: "strong" },
  "gemini-3.5-flash": { vision: true, tools: true, coordinateSpace: "normalized_1000", maxImageLongEdge: 1568, tier: "strong" },
  "gemini-3.5-flash-lite": { vision: true, tools: true, coordinateSpace: "normalized_1000", maxImageLongEdge: 1568, priceIn: 0.3, priceOut: 2.5, tier: "fast" },
  "gemini-3.1-pro": { vision: true, tools: true, coordinateSpace: "normalized_1000", maxImageLongEdge: 1568, priceIn: 2, priceOut: 12, tier: "frontier" },
  "qwen3-vl:8b": { vision: true, tools: true, coordinateSpace: "normalized_1000", maxImageLongEdge: 1280, tier: "local" },
  "qwen3.8-27b": { vision: true, tools: true, coordinateSpace: "normalized_1000", maxImageLongEdge: 1280, priceIn: 0.4, tier: "strong" },
};

const FALLBACK_INFO = { vision: true, tools: true, coordinateSpace: "image_px", maxImageLongEdge: 1280, tier: "unknown" };

// Preference lists: first candidate whose provider is configured wins; the rest are failover targets.
// `trusted:true` marks models allowed to continue SENSITIVE tasks after a failover (never silently downgrade).
const DEFAULT_ROLES = {
  planner: [
    { provider: "anthropic", model: "claude-sonnet-5", trusted: true },
    { provider: "google", model: "gemini-3.8-flash", trusted: true },
    { provider: "openai", model: "gpt-5.4", trusted: true },
  ],
  browser: [
    { provider: "noahai", model: "browser", trusted: true }, // the hosted brain first (no key in the app; only while the user is signed in), then the user's own keys
    { provider: "google", model: "gemini-3.8-flash", trusted: true },
    { provider: "anthropic", model: "claude-sonnet-5", trusted: true },
    { provider: "openai", model: "gpt-5.4", trusted: true },
    { provider: "qwen", model: "qwen3.8-27b" },
  ],
  vision: [
    { provider: "noahai", model: "vision", trusted: true },
    { provider: "google", model: "gemini-3.8-flash", trusted: true },
    { provider: "anthropic", model: "claude-sonnet-5", trusted: true },
    { provider: "openai", model: "gpt-5.4", trusted: true },
    { provider: "qwen", model: "qwen3.8-27b" },
  ],
  fast: [
    { provider: "google", model: "gemini-3.5-flash-lite" },
    { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  ],
  local: [{ provider: "local", model: "qwen3-vl:8b" }],
  // The long-horizon mission loop: the hosted brain first (no key in the app), then the user's own keys if they set any.
  mission: [
    { provider: "noahai", model: "mission", trusted: true },
    { provider: "anthropic", model: "claude-sonnet-5", trusted: true },
    { provider: "google", model: "gemini-3.8-flash", trusted: true },
    { provider: "openai", model: "gpt-5.4", trusted: true },
  ],
};

// Last-resort, text-only chain used when NO vision-capable provider is configured.
const LEGACY_CANDIDATE = { provider: "rexy", model: "rexy-render", legacy: true };

// A model name that is not in MODEL_INFO still belongs to a FAMILY, and the family decides how it points: Gemini and Qwen3 answer where-to-click questions on a 0-999 grid laid
// over the picture (not in pixels), Claude and GPT in the pixels of the picture, Qwen2.x-VL in absolute pixels. Treating an unknown "gemini-2.5-flash" as "pixels" made every
// click land ~28% off on a 1280-wide screenshot. Exact entries above always win; this only fills the gap for names the list does not know.
const FAMILY_INFO = [
  [/^(?:models[/])?gemini/i, { coordinateSpace: "normalized_1000", maxImageLongEdge: 1568 }],
  [/qwen-?3|qwen3|qvq/i, { coordinateSpace: "normalized_1000", maxImageLongEdge: 1280 }],
  [/^claude/i, { coordinateSpace: "image_px", maxImageLongEdge: 1568 }],
  [/^(?:gpt|o[0-9]|chatgpt)/i, { coordinateSpace: "image_px", maxImageLongEdge: 2048 }],
  [/qwen/i, { coordinateSpace: "image_px", maxImageLongEdge: 1280 }],
];

function modelInfo(model) {
  const exact = MODEL_INFO[model];
  if (exact) return { ...FALLBACK_INFO, ...exact };
  const name = String(model || "");
  const family = FAMILY_INFO.find(([re]) => re.test(name));
  return { ...FALLBACK_INFO, ...(family ? family[1] : {}) };
}

module.exports = { ROLES, DEFAULT_PROVIDERS, DEFAULT_ROLES, MODEL_INFO, LEGACY_CANDIDATE, modelInfo, FALLBACK_INFO };
