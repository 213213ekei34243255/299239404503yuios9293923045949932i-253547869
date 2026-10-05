// Noah/desktop/permissions.cjs
//
// On a Mac, an app may not read or operate other apps until the USER allows it (System Settings, or System Preferences on macOS 12 and older). Without that every operation
// fails in a confusing way, so before a computer task starts Noah checks the one permission nothing works without (Accessibility), asks macOS to show its own prompt, and tells
// the user exactly where to switch Jonah on. Screen Recording (to see a page) is checked too, but does not stop the task from starting: many tasks only read apps. The helper
// itself reports the third one (Automation > System Events, for typing) at the moment an operation needs it.
//
// Two traps found on a real Mac:
//   * Jonah is not signed with an Apple certificate, so macOS ties its permissions to the EXACT build: after an update the old tick in the list is stale (it looks ticked, does not
//     count, and macOS never asks again because the entry exists). The remedy is to remove Jonah from the list and let macOS ask again: the messages say so.
//   * macOS lists an app under Screen Recording only after the app has TRIED to capture the screen, so Jonah never appeared in the list until it asked (requestScreen).
//
// On Windows nothing is needed, so the check always says yes. Electron's systemPreferences is injected, so this is tested with a stand-in.

"use strict";

// macOS 12 and older call it System Preferences > Security & Privacy; macOS 13 and newer, System Settings > Privacy & Security
const WHERE = "System Settings (System Preferences on older Macs) > Privacy & Security (Security & Privacy)";

const ACCESSIBILITY_REPLY =
  "Before I can work on your Mac, you need to allow Jonah to control it. I have asked macOS to show its permission prompt. " +
  `Open ${WHERE} > Accessibility and turn Jonah on. For screenshots, also turn Jonah on under Screen Recording (it is further down the list). ` +
  "If Jonah is already ticked but this message keeps coming back (it happens after Jonah is updated), select Jonah in that list, press the minus (-) button to remove it, quit Jonah, open it again and say yes when macOS asks. " +
  "Then ask me again. (Jonah has to be restarted after you switch Screen Recording on.)";

/** Said once, when a task starts and Screen Recording is not allowed yet. Does not stop the task. */
function screenNotice(status) {
  return (
    "Heads-up: Jonah also needs Screen Recording permission to see what is on your screen, and it does not have it yet. " +
    (status === "not-determined"
      ? "I have asked macOS to show its prompt: allow it. "
      : `Open ${WHERE} > Screen Recording (it is further down the list, below Accessibility) and turn Jonah on; if Jonah is already ticked, remove it with the minus (-) button and let macOS ask again. `) +
    "Then quit Jonah, open it again and ask me again. Until then I can only read apps through their accessibility information, and some pages will look empty to me."
  );
}

/**
 * @param {{ systemPreferences?: { isTrustedAccessibilityClient?: (prompt: boolean) => boolean, getMediaAccessStatus?: (kind: string) => string }, platform?: string, log?: (m: string) => void, requestScreen?: (() => any) | null }} o
 *   requestScreen: makes macOS show its Screen Recording prompt (and list Jonah) by trying to capture the screen once
 * @returns {() => { ok: boolean, reply?: string, notice?: string }}
 */
function createPermissionCheck({ systemPreferences, platform = process.platform, log = () => {}, requestScreen = null } = {}) {
  if (platform !== "darwin") return () => ({ ok: true });
  let screenTold = false; // once per run: the helper's own error says it again if a screenshot is really needed
  return () => {
    try {
      if (!systemPreferences || typeof systemPreferences.isTrustedAccessibilityClient !== "function") return { ok: true }; // cannot ask: let the helper say what is missing
      if (!systemPreferences.isTrustedAccessibilityClient(false)) {
        try { systemPreferences.isTrustedAccessibilityClient(true); } catch (_) { /* the prompt could not be shown: the instruction below still tells the user */ }
        log("computer agent: Accessibility permission is missing; the user was told how to grant it");
        return { ok: false, reply: ACCESSIBILITY_REPLY };
      }
      let status = "granted";
      try { if (typeof systemPreferences.getMediaAccessStatus === "function") status = String(systemPreferences.getMediaAccessStatus("screen")); } catch (_) { /* cannot tell: assume it is fine */ }
      if (status !== "granted" && !screenTold) {
        screenTold = true;
        if (status === "not-determined" && typeof requestScreen === "function") {
          try { Promise.resolve(requestScreen()).catch(() => {}); } catch (_) { /* the prompt could not be shown: the notice still tells the user */ }
        }
        log(`computer agent: Screen Recording is not allowed yet (${status}); the user was told`);
        return { ok: true, notice: screenNotice(status) };
      }
      return { ok: true };
    } catch (e) {
      log(`computer agent: could not check permissions: ${e && e.message}`);
      return { ok: true };
    }
  };
}

module.exports = { createPermissionCheck, ACCESSIBILITY_REPLY, screenNotice, WHERE };
