// Rexy/permissions.cjs
//
// Permissions is Noah's last line of defense before anything actually
// touches the browser or the system. Runtime should only ever call one
// method on this module: validate(plan).

"use strict";

class Permissions {
  // =====================================================================
  // 1. Constructor
  // =====================================================================

  constructor(options = {}) {
    this.approvedDomains = options.approvedDomains || [
      "google.com",
      "youtube.com",
      "github.com",
    ];

    this.blockedDomains = options.blockedDomains || [
      "javascript:",
      "file:",
      "data:",
    ];

    this.dangerousActions = options.dangerousActions || [
      "deleteFile",
      "shutdown",
      "terminal",
      "powershell",
      "registry",
    ];

    this.approvalActions = options.approvalActions || [
      "download",
      "upload",
      "payment",
      "login",
    ];

    this.settings = {
      logDecisions: true,
      strictDomainCheck: false, // if true, navigate targets must be in approvedDomains
      ...options.settings,
    };
  }

  // =====================================================================
  // 2. Public API — runtime should only ever call this
  // =====================================================================

  /**
   * @param {object|object[]} plan  a single action, or a plan containing
   *        multiple actions (either an array, or an object with an
   *        `actions` array).
   * @returns {boolean} true only if every action in the plan is allowed.
   */
  validate(plan) {
    const actions = this._normalize(plan);

    if (actions.length === 0) {
      this.logDecision({ type: "unknown" }, false);
      return false;
    }

    for (const action of actions) {
      if (!this.validateAction(action)) {
        return false;
      }
    }

    return true;
  }

  _normalize(plan) {
    if (!plan) return [];
    if (Array.isArray(plan)) return plan;
    if (Array.isArray(plan.actions)) return plan.actions;
    return [plan];
  }

  // =====================================================================
  // 4. validateAction(action)
  // =====================================================================

  validateAction(action) {
    if (!action || typeof action !== "object" || !action.type) {
      this.logDecision(action, false);
      return false;
    }

    // Dangerous actions are never allowed, full stop.
    if (this.isDangerous(action)) {
      this.logDecision(action, false);
      return false;
    }

    // URL-bearing actions must point somewhere safe.
    if (action.url && !this.isSafeURL(action.url)) {
      this.logDecision(action, false);
      return false;
    }

    // Actions that require explicit approval must get it.
    if (this.requiresApproval(action)) {
      const approved = this.requestApproval(action);
      if (!approved) {
        this.logDecision(action, false);
        return false;
      }
    }

    this.logDecision(action, true);
    return true;
  }

  // =====================================================================
  // 5. URL Validator
  // =====================================================================

  isSafeURL(url) {
    if (typeof url !== "string" || url.trim() === "") return false;
    const value = url.trim().toLowerCase();

    for (const blocked of this.blockedDomains) {
      if (value.startsWith(blocked)) return false;
    }

    if (value.startsWith("about:") || value.startsWith("chrome:")) return false;

    if (!value.startsWith("http://") && !value.startsWith("https://")) return false;

    if (this.settings.strictDomainCheck) {
      try {
        const host = new URL(value).hostname.toLowerCase();
        const allowed = this.approvedDomains.some(
          (domain) => host === domain || host.endsWith(`.${domain}`)
        );
        if (!allowed) return false;
      } catch (_) {
        return false;
      }
    }

    return true;
  }

  // =====================================================================
  // 6. Dangerous Action Checker
  // =====================================================================

  isDangerous(action) {
    const type = String(action?.type || "").toLowerCase();
    const denylist = [
      "terminal",
      "cmd",
      "powershell",
      "shutdown",
      "restart",
      "registry",
      "filesystemdelete",
      ...this.dangerousActions.map((a) => a.toLowerCase()),
    ];
    return denylist.some((d) => type === d.toLowerCase() || type.includes(d.toLowerCase()));
  }

  // =====================================================================
  // 7. Approval Checker
  // =====================================================================

  requiresApproval(action) {
    const type = String(action?.type || "").toLowerCase();
    const list = [
      "download",
      "upload",
      "payment",
      "checkout",
      "camera",
      "microphone",
      "clipboardwrite",
      ...this.approvalActions.map((a) => a.toLowerCase()),
    ];
    return list.includes(type);
  }

  // =====================================================================
  // 8. Approval UI (placeholder)
  // =====================================================================

  requestApproval(action) {
    // Later: show a real approval popup in Jonah Browser and return the
    // user's decision instead of auto-approving.
    return true;
  }

  // =====================================================================
  // 9. Logging
  // =====================================================================

  logDecision(action, allowed) {
    if (!this.settings.logDecisions) return;

    const label = allowed ? "Allowed" : "Denied";
    const detail = action?.url || action?.selector || action?.type || "unknown";

    console.log(`[Permissions] ${label}`);
    console.log(`  ${action?.type || "unknown"}`);
    if (action?.url) console.log(`  ${detail}`);
  }
}

module.exports = Permissions;
