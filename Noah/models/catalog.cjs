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
const ROLES = ["planner", "browser", "vision", "fast", "local"];

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
};

// Per-model hints used for routing decisions (vision? coordinate space? price?).
// Unknown models fall back to conservative defaults (vision:true, image_px).
const MODEL_INFO = {
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
    { provider: "google", model: "gemini-3.8-flash", trusted: true },
    { provider: "anthropic", model: "claude-sonnet-5", trusted: true },
    { provider: "openai", model: "gpt-5.4", trusted: true },
    { provider: "qwen", model: "qwen3.8-27b" },
  ],
  vision: [
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
};

// Last-resort, text-only chain used when NO vision-capable provider is configured.
const LEGACY_CANDIDATE = { provider: "rexy", model: "rexy-render", legacy: true };

function modelInfo(model) {
  return { ...FALLBACK_INFO, ...(MODEL_INFO[model] || {}) };
}

module.exports = { ROLES, DEFAULT_PROVIDERS, DEFAULT_ROLES, MODEL_INFO, LEGACY_CANDIDATE, modelInfo, FALLBACK_INFO };
