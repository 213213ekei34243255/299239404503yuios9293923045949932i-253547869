// browser-identity.cjs - how Jonah introduces itself to websites.
//
// Jonah used to send a FIXED "Chrome/122" identity on every request. That identity did not match the real engine (so the client hints, TLS and script features all disagreed with it), and
// bot protection (Akamai, for one: sites such as sephora.com.au answered "Access Denied") reads exactly that kind of mismatch as a bot. The honest identity is the engine's own: it
// says what Chromium it really is, in the same shape Chrome sends it. Two things differ between a bare Electron engine and a real Chrome, and both are fixed here:
//   - the user agent carries two product tokens no normal browser sends ("Electron/x.y.z" and the app's own "Jonah/x.y.z"), and the FULL build number (Chrome sends only "Chrome/156.0.0.0");
//   - the engine sends one language ("en-US"), where a browser sends the person's whole language list with weights ("en-GB,en-US;q=0.9,en;q=0.8").
"use strict";

/** The engine's own user agent in the shape Chrome sends it: no Electron / application token, and the reduced version ("Chrome/156.0.0.0"). */
function cleanUserAgent(ua, appName = "") {
  let out = String(ua || "").replace(/\sElectron\/\S+/gi, "");
  const names = [...new Set([appName, "Jonah"].filter((n) => n && /^[\w .-]+$/.test(n)))];
  for (const n of names) out = out.replace(new RegExp(`\\s${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[ _]")}\\/\\S+`, "gi"), "");
  return out.replace(/\bChrome\/(\d+)\.\d+\.\d+\.\d+/, "Chrome/$1.0.0.0").replace(/\s{2,}/g, " ").trim();
}

/**
 * The Accept-Language value a browser sends for the languages the person has set: each language in order, with the plain language (en) after its regional forms (en-GB, en-US), and weights falling by 0.1.
 * ["en-GB", "en-US", "hi"] -> "en-GB,en-US;q=0.9,en;q=0.8,hi;q=0.7". Nothing to go on (no list) -> "en-US,en;q=0.9".
 */
function acceptLanguagesFor(languages) {
  const list = languageList(languages);
  if (!list.length) return "en-US,en;q=0.9";
  return list.map((l, i) => (i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`)).join(",");
}

/** The person's languages as an ordered list, with the plain language after its regional forms (["en-GB","en-US","hi"] -> ["en-GB","en-US","en","hi"]); at most 8. Chromium adds the weights itself, so THIS is what is handed to it. */
function languageList(languages) {
  const given = (Array.isArray(languages) ? languages : []).map((l) => String(l || "").trim()).filter((l) => /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(l));
  const list = [];
  for (const l of given) {
    if (!list.some((x) => x.toLowerCase() === l.toLowerCase())) list.push(l);
  }
  // the base language goes after the last regional form of it, unless it is listed already
  const withBase = [];
  const bases = new Set(list.filter((l) => !l.includes("-")).map((l) => l.toLowerCase()));
  list.forEach((l, i) => {
    withBase.push(l);
    const base = l.split("-")[0].toLowerCase();
    const laterSame = list.slice(i + 1).some((x) => x.split("-")[0].toLowerCase() === base && x.includes("-"));
    if (l.includes("-") && !laterSame && !bases.has(base)) { withBase.push(base); bases.add(base); }
  });
  return withBase.slice(0, 8);
}

module.exports = { cleanUserAgent, acceptLanguagesFor, languageList };
