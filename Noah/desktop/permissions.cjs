// Noah/desktop/permissions.cjs
//
// On a Mac, an app may not read or operate other apps until the USER allows it (System Settings > Privacy & Security). Without that every operation fails in a confusing
// way, so before a computer task starts Noah checks the one permission nothing works without (Accessibility), asks macOS to show its own prompt, and tells the user exactly
// where to switch Jonah on. The other two (Screen Recording for screenshots, Automation > System Events for typing) are reported by the helper itself, with the same
// kind of instruction, at the moment an operation needs them: many tasks need neither.
//
// On Windows nothing is needed, so the check always says yes. Electron's systemPreferences is injected, so this is tested with a stand-in.

"use strict";

const ACCESSIBILITY_REPLY =
  "Before I can work on your Mac, you need to allow Jonah to control it. I have asked macOS to show its permission prompt. " +
  "Open System Settings > Privacy & Security > Accessibility and turn Jonah on. For screenshots, also turn Jonah on under Screen Recording. " +
  "Then ask me again. (Jonah has to be restarted after you switch Screen Recording on.)";

/**
 * @param {{ systemPreferences?: { isTrustedAccessibilityClient?: (prompt: boolean) => boolean }, platform?: string, log?: (m: string) => void }} o
 * @returns {() => { ok: boolean, reply?: string }}
 */
function createPermissionCheck({ systemPreferences, platform = process.platform, log = () => {} } = {}) {
  if (platform !== "darwin") return () => ({ ok: true });
  return () => {
    try {
      if (!systemPreferences || typeof systemPreferences.isTrustedAccessibilityClient !== "function") return { ok: true }; // cannot ask: let the helper say what is missing
      if (systemPreferences.isTrustedAccessibilityClient(false)) return { ok: true };
      try { systemPreferences.isTrustedAccessibilityClient(true); } catch (_) { /* the prompt could not be shown: the instruction below still tells the user */ }
      log("computer agent: Accessibility permission is missing; the user was told how to grant it");
      return { ok: false, reply: ACCESSIBILITY_REPLY };
    } catch (e) {
      log(`computer agent: could not check permissions: ${e && e.message}`);
      return { ok: true };
    }
  };
}

module.exports = { createPermissionCheck, ACCESSIBILITY_REPLY };
