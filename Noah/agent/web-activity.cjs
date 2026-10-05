// Noah/agent/web-activity.cjs
//
// Step-by-step view of the WEB agent, in the same Activity view the computer agent uses. The browser agent already works in steps (look at the page, decide, act, wait for
// the page to settle, check); until now the panel showed none of it, only one status line. This turns the agent's own events into the plain lines the Activity view prints:
//
//     Step 1
//       Looked at the page: Google (212 elements)             <- observe
//       Took a screenshot of the page (1280x692)              <- observe (only when the agent really took one)
//       Opened example.com                                    <- navigate
//       Waited 0.8 s for the page to settle                   <- page_wait (only waits that were worth a line)
//       Clicked "Sign in"                                     <- click
//
// Every line comes from a REAL event (what the agent did and what happened), never from what the model says it did. The text of a typed secret is already masked by the
// protocol's redactAction, and a page's address is shown without its query string or fragment (those can hold tokens).
//
// The lines are published as `mission_activity` / `mission_started` / `mission_finished` events, the panel's existing Activity events, flagged `web: true`. The agent's
// final answer still reaches the chat through task_finished, as before: this adds nothing to the chat, only to the Activity view.

"use strict";

const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const secs = (ms) => `${Math.max(0.1, Math.round(ms / 100) / 10)} s`;
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const quote = (s) => `“${clip(s, 60)}”`;

/** A page address as the user should see it: host and path, no query string, no fragment, no credentials. */
function shortUrl(u) {
  try {
    const x = new URL(String(u));
    return clip(x.host + (x.pathname && x.pathname !== "/" ? x.pathname : ""), 70);
  } catch (_) {
    return clip(String(u ?? "").split(/[?#]/)[0], 70);
  }
}

/** The label of what an action is aimed at, in the words the page uses. */
function labelOf(a) {
  const t = (a && a.target) || {};
  const name = t.text || t.name || t.label || t.description || t.query || a.text_target || "";
  if (name) return quote(name);
  if (t.type === "coordinates" || (t.x != null && t.y != null)) return "a spot on the page";
  if (t.ref) return "an element";
  return "";
}

/**
 * What each browser action looks like as a line: kind (the icon), the words while it happens, the words once it worked, and the words if it did not.
 * @param {{ action?: string } & Record<string, any>} a  the REDACTED action
 */
function describeWebAction(a) {
  const act = String((a && a.action) || "");
  const label = labelOf(a || {});
  const on = label ? ` ${label}` : "";
  const into = label ? ` into ${label}` : "";
  switch (act) {
    case "navigate": { const h = shortUrl(a.url); return { kind: "go", doing: `Opening ${h}`, done: `Opened ${h}`, failed: `Could not open ${h}` }; }
    case "back": return { kind: "go", doing: "Going back", done: "Went back", failed: "Could not go back" };
    case "forward": return { kind: "go", doing: "Going forward", done: "Went forward", failed: "Could not go forward" };
    case "reload": return { kind: "go", doing: "Reloading the page", done: "Reloaded the page", failed: "Could not reload the page" };
    case "new_tab": return { kind: "tab", doing: "Opening a new tab", done: "Opened a new tab", failed: "Could not open a new tab" };
    case "close_tab": return { kind: "tab", doing: "Closing the tab", done: "Closed the tab", failed: "Could not close the tab" };
    case "switch_tab": return { kind: "tab", doing: "Switching tab", done: "Switched tab", failed: "Could not switch tab" };
    case "click": return { kind: "click", doing: `Clicking${on}`, done: `Clicked${on}`, failed: `Could not click${on}` };
    case "double_click": return { kind: "click", doing: `Double-clicking${on}`, done: `Double-clicked${on}`, failed: `Could not double-click${on}` };
    case "right_click": return { kind: "click", doing: `Right-clicking${on}`, done: `Right-clicked${on}`, failed: `Could not right-click${on}` };
    case "hover": case "move": return { kind: "click", doing: `Pointing at${on}`, done: `Pointed at${on}`, failed: `Could not point at${on}` };
    case "drag": case "mouse_down": case "mouse_up": return { kind: "click", doing: "Dragging", done: "Dragged", failed: "Could not drag" };
    case "scroll": case "scroll_to": {
      const down = a.direction ? String(a.direction).toLowerCase() !== "up" : !(Number(a.deltaY) < 0);
      const w = act === "scroll_to" ? `to${on || " an element"}` : down ? "down" : "up";
      return { kind: "scroll", doing: `Scrolling ${w}`, done: `Scrolled ${w}`, failed: `Could not scroll ${w}` };
    }
    case "type": {
      const n = typeof a.text === "string" ? a.text.length : 0;
      return { kind: "type", doing: `Typing${into}`, done: `Typed ${plural(n, "character")}${into}`, failed: `Could not type${into}`, detail: typeof a.text === "string" ? clip(a.text, 80) : "" };
    }
    case "form_input": return { kind: "type", doing: `Filling in${on || " a field"}`, done: `Filled in${on || " a field"}`, failed: `Could not fill in${on || " a field"}` };
    case "key_press": case "key_down": case "key_up": { const k = clip(a.key || a.keys || "a key", 30); return { kind: "key", doing: `Pressing ${k}`, done: `Pressed ${k}`, failed: `Could not press ${k}` }; }
    case "hotkey": { const k = clip(Array.isArray(a.keys) ? a.keys.join("+") : a.keys || a.key || "a shortcut", 30); return { kind: "key", doing: `Pressing ${k}`, done: `Pressed ${k}`, failed: `Could not press ${k}` }; }
    case "select_all": return { kind: "key", doing: "Selecting everything", done: "Selected everything", failed: "Could not select everything" };
    case "copy": return { kind: "key", doing: "Copying", done: "Copied", failed: "Could not copy" };
    case "paste": return { kind: "key", doing: "Pasting", done: "Pasted", failed: "Could not paste" };
    case "wait": { const w = Number(a.ms) > 0 ? ` ${secs(Number(a.ms))}` : Number(a.seconds) > 0 ? ` ${secs(Number(a.seconds) * 1000)}` : ""; return { kind: "wait", doing: `Waiting${w}`, done: `Waited${w}`, failed: "Could not wait" }; }
    case "screenshot": return { kind: "shot", doing: "Deciding to take a screenshot", done: "Decided to take a screenshot", failed: "Could not ask for a screenshot" }; // the picture itself is the next look at the page (its own line)
    case "read_page": return { kind: "read", doing: "Reading the page", done: "Read the page", failed: "Could not read the page" };
    case "find_element": { const q = clip((a.target && (a.target.text || a.target.query)) || a.query || "", 50); return { kind: "look", doing: `Looking for ${q ? quote(q) : "an element"}`, done: `Looked for ${q ? quote(q) : "an element"}`, failed: `Could not find ${q ? quote(q) : "the element"}` }; }
    case "upload_file": return { kind: "write", doing: "Uploading a file", done: "Uploaded a file", failed: "Could not upload the file" };
    case "download_file": return { kind: "write", doing: "Downloading a file", done: "Downloaded a file", failed: "Could not download the file" };
    case "handle_dialog": return { kind: "note", doing: "Answering a dialog", done: "Answered a dialog", failed: "Could not answer the dialog" };
    case "ask_user": return { kind: "ask", doing: "Asking you", done: "Asked you", failed: "Could not ask you" };
    default: { const w = clip(act.replace(/_/g, " ") || "an action", 40); return { kind: "note", doing: `Doing: ${w}`, done: `Did: ${w}`, failed: `Could not do: ${w}` }; }
  }
}

const REFUSED = /^(blocked|user_denied|policy_denied|needs_confirmation|denied)$/;
const END_STATUS = { completed: "web_done", failed: "web_failed", cancelled: "cancelled" };

/**
 * @param {{ subscribe: (fn: (e: any) => void) => () => void, publish: (event: string, payload: object) => any }} bus
 * @param {{ log?: (m: string) => void }} [o]
 * @returns {() => void} unsubscribe
 */
function attachWebActivity({ bus, log = () => {} }) {
  let active = false;
  let taskId = null;
  let step = 0;
  let n = 0; // a counter that keeps every line's id unique within the task
  let openAction = null; // the action line still waiting for its result
  let lookReason = "";

  const show = (id, item) => bus.publish("mission_activity", { missionId: taskId, id: `${step}.${id}`, iteration: step || 1, web: true, ...item });

  function handle(e) {
    switch (e.event) {
      case "task_started":
        active = true; taskId = e.taskId || null; step = 0; n = 0; openAction = null; lookReason = "";
        bus.publish("mission_started", { missionId: taskId, objective: e.goal, resumed: !!e.resumed, web: true });
        return;
      case "task_finished":
        if (e.superseded) { active = false; return; } // a newer instruction replaced it: its own task_started follows
        if (active) bus.publish("mission_finished", { missionId: taskId, status: END_STATUS[e.status] || "web_failed", web: true });
        active = false; openAction = null;
        return;
    }
    if (!active) return;
    switch (e.event) {
      case "plan": {
        const plan = e.plan || {};
        if (plan.complexity === "trivial") return;
        const steps = Array.isArray(plan.steps) ? plan.steps : [];
        if (!steps.length) return;
        const first = steps[0] && typeof steps[0] === "object" ? steps[0].text || steps[0].goal || steps[0].description || "" : steps[0];
        show(`plan${++n}`, { kind: "plan", level: "ok", text: `Made a plan (${plural(steps.length, "step")})`, detail: clip(`1. ${first}`, 140) });
        return;
      }
      case "observe":
        step = Number(e.step) || step;
        if (e.state === "start") {
          lookReason = e.reason ? clip(String(e.reason).replace(/_/g, " "), 80) : "";
          show("look", { kind: "look", level: "info", pending: true, text: "Looking at the page…", detail: e.screenshot ? "A screenshot will be taken too" : "" });
        } else {
          const where = [e.title ? clip(e.title, 60) : "", e.url ? shortUrl(e.url) : ""].filter(Boolean).join(" · ");
          show("look", { kind: "look", level: "ok", pending: false, text: `Looked at the page${Number.isFinite(e.elements) ? ` (${plural(e.elements, "element")})` : ""}`, detail: where + (e.loading ? " (still loading)" : "") });
          if (e.screenshot) show("shot", { kind: "shot", level: "ok", pending: false, text: "Took a screenshot of the page", detail: [e.screenshot.width && e.screenshot.height ? `${e.screenshot.width}×${e.screenshot.height}` : "", lookReason].filter(Boolean).join(" · ") });
        }
        return;
      case "step": {
        step = Number(e.n) || step;
        const summary = clip(e.summary, 200);
        if (summary) show("think", { kind: "idea", level: "info", pending: false, text: summary, detail: "" });
        return;
      }
      case "action_started": {
        const d = describeWebAction(e.detail || { action: e.action });
        openAction = { id: `a${++n}`, d };
        show(openAction.id, { kind: d.kind, level: "info", pending: true, text: `${d.doing}…`, detail: "" });
        return;
      }
      case "action_result": {
        const d = openAction ? openAction.d : describeWebAction({ action: e.action });
        const id = openAction ? openAction.id : `a${++n}`;
        openAction = null;
        if (e.ok) show(id, { kind: d.kind, level: "ok", pending: false, text: d.done, detail: e.verdict === "no_effect" ? "Nothing on the page seemed to change." : d.detail || "" });
        else show(id, { kind: d.kind, level: REFUSED.test(String(e.code || "")) ? "refused" : "fail", pending: false, text: d.failed, detail: clip(e.message || e.code, 200) });
        return;
      }
      case "page_wait": {
        const ms = Number(e.ms) || 0;
        if (e.dialog) { show(`w${++n}`, { kind: "wait", level: "info", pending: false, text: "A dialog opened, so the page is waiting for it", detail: "" }); return; }
        if (e.settled === false) { show(`w${++n}`, { kind: "wait", level: "info", pending: false, text: `Waited ${secs(ms)}: the page was still changing`, detail: "Carrying on with what is there." }); return; }
        if (ms >= 300) show(`w${++n}`, { kind: "wait", level: "ok", pending: false, text: `Waited ${secs(ms)} for the page to settle`, detail: "" }); // the many short settles are not worth a line each
        return;
      }
      case "recovery":
        show(`rec${++n}`, { kind: "note", level: "info", pending: false, text: `Trying another way: ${clip(String(e.failure || "that did not work").replace(/_/g, " "), 60)}`, detail: e.strategy ? `Next: ${clip(String(e.strategy).replace(/_/g, " "), 80)}` : "" });
        return;
      case "ask_user":
        show(`ask${++n}`, { kind: "ask", level: "info", pending: false, text: "Needs your help", detail: clip(e.question, 200) });
        return;
      default:
    }
  }

  return bus.subscribe((e) => {
    try { handle(e || {}); } catch (err) { log(`web activity: ${err && err.message}`); } // describing must never break the agent
  });
}

module.exports = { attachWebActivity, describeWebAction, shortUrl, labelOf };
