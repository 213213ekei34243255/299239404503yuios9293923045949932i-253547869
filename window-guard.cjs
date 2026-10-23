// window-guard.cjs - rules for what the app's own windows and the web pages inside them may do. Pure functions; main.cjs wires them to Electron's events.
//
//   * guestPreferences(prefs, appDir)   every <webview> (each site the user browses) is forced to the safe settings, whatever the page that created it asked for:
//                                       no Node, an isolated world, web security on, no insecure content, a sandboxed renderer, and ONLY Jonah's own small preload.
//   * guestSourceAllowed(src)           a <webview> may not be started on a javascript: / vbscript: address.
//   * hostNavigationAllowed(url, dir)   the app's OWN windows (the shell, the sign-in window, overlays) may only ever show files that ship with the app. A link, redirect or
//                                       script that tries to move one of them to a website is refused, so a website can never end up inside a window that has Jonah's privileges.
//   * certificateDecision()             an invalid HTTPS certificate is refused (it used to be accepted for every site, which let anyone on the network read and change pages).
"use strict";

const path = require("path");
const { fileURLToPath } = require("url");

const same = (a, b) => path.resolve(String(a || "")).toLowerCase() === path.resolve(String(b || "")).toLowerCase();

/** Forces the safe settings on a <webview>'s preferences (mutates and returns them). */
function guestPreferences(prefs, appDir) {
  const p = prefs || {};
  p.devTools = false;
  p.nodeIntegration = false;
  p.nodeIntegrationInSubFrames = false;
  p.nodeIntegrationInWorker = false;
  p.contextIsolation = true;
  p.webSecurity = true;
  p.allowRunningInsecureContent = false;
  p.sandbox = true;
  p.enableRemoteModule = false;
  p.experimentalFeatures = false;
  // the only preload a guest may have is Jonah's own; anything else a page asked for is dropped. (A <webview> hands its preload over as a file:// address, in preloadURL.)
  const own = path.join(appDir, "webview-preload.js");
  const isOwn = (v) => { try { return same(/^file:/i.test(String(v)) ? fileURLToPath(String(v)) : v, own); } catch (_) { return false; } };
  if (p.preload && !isOwn(p.preload)) delete p.preload;
  if (p.preloadURL && !isOwn(p.preloadURL)) delete p.preloadURL;
  return p;
}

function guestSourceAllowed(src) {
  return !/^\s*(javascript|vbscript):/i.test(String(src || ""));
}

/** May an app window of Jonah's own navigate to this address? Only a file that ships with the app (inside appDir), or about:blank. */
function hostNavigationAllowed(rawUrl, appDir) {
  const url = String(rawUrl || "");
  if (url === "about:blank") return true;
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (u.protocol !== "file:") return false;
  let file;
  try { file = fileURLToPath(u); } catch (_) { return false; }
  const root = path.resolve(appDir).toLowerCase();
  const target = path.resolve(file).toLowerCase();
  return target === root || target.startsWith(root + path.sep);
}

/** An invalid certificate is always refused. */
function certificateDecision() {
  return false;
}

module.exports = { guestPreferences, guestSourceAllowed, hostNavigationAllowed, certificateDecision };
