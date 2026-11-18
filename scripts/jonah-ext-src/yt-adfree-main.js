// yt-adfree-main.js - Jonah's "No ads & trackers" for YouTube, the same idea Brave Shields and uBlock Origin use ("json-prune"):
// a YouTube video page and its player API answers carry the ad schedule INSIDE the video data (adPlacements, playerAds, adSlots).
// The player only plays ads it finds there, so this script deletes those fields before YouTube's own code reads them.
// Runs in the page's own JavaScript world at document_start on YouTube only, and only while "No ads & trackers" is on
// (background.js registers/unregisters it). It changes nothing else: no clicks, no skipping, nothing sent anywhere.
(function () {
  "use strict";
  if (window.__jonahYtAdfree) return;
  window.__jonahYtAdfree = true;

  const AD_KEYS = ["adPlacements", "playerAds", "adSlots", "adBreakHeartbeatParams"];
  // remove the ad fields from a player answer (also when it is wrapped: {playerResponse: {...}} on page navigation)
  function prune(o) {
    if (!o || typeof o !== "object") return o;
    try {
      for (const k of AD_KEYS) if (k in o) delete o[k];
      if (o.playerResponse && typeof o.playerResponse === "object") prune(o.playerResponse);
      if (Array.isArray(o)) for (const x of o) if (x && typeof x === "object" && x.playerResponse) prune(x.playerResponse);
    } catch (_) {}
    return o;
  }
  const hasAds = (o) => !!o && typeof o === "object" && (AD_KEYS.some((k) => k in o) || (!!o.playerResponse && typeof o.playerResponse === "object"));

  // 1) the first video's data is written by an inline <script>: "var ytInitialPlayerResponse = {...}"
  let initial;
  try {
    Object.defineProperty(window, "ytInitialPlayerResponse", {
      configurable: true,
      get() { return initial; },
      set(v) { initial = prune(v); },
    });
  } catch (_) {}

  // 2) every later video (clicking around YouTube) arrives as JSON from /youtubei/v1/player or /next and is parsed with JSON.parse
  const parse = JSON.parse;
  JSON.parse = function () {
    const r = parse.apply(this, arguments);
    return hasAds(r) ? prune(r) : r;
  };
  // 3) ...or with Response.json()
  const json = Response.prototype.json;
  Response.prototype.json = function () {
    return json.apply(this, arguments).then((r) => (hasAds(r) ? prune(r) : r));
  };
})();
