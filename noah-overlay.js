// noah-overlay.js  (classic script)
//
// Noah's visible interaction layer: the purple virtual cursor, click ripple,
// target highlight, drag trail, typing focus ring, agent status, confirmation
// card, takeover banner and STOP control.
//
// It is a pure CONSUMER of the agent's event stream (mouse_action, keyboard_action,
// scroll_action, agent_status, action_result, confirm_request, safety, ...). It
// never drives the browser, and the agent never waits for it (unless the user
// chose cursor.mode = "lead"), so the visuals cannot drift from - or slow down -
// what really happens. It draws nothing that did not happen: typing activity
// lasts exactly as long as the real keyboard_action (start..end) did.
//
// It lives in the shell window as a fixed, pointer-events:none layer above the
// <webview>, so it never touches page DOM and cannot be seen or clicked by pages.

(function () {
  "use strict";

  const STATE_HOLD = { CLICKING: 460, DOUBLE_CLICKING: 620, RIGHT_CLICKING: 460, SUCCESS: 650, ERROR: 950 };
  const PHASE_TEXT = {
    thinking: "Analyzing page…", planning: "Planning the task…", observing: "Reading the page…",
    deciding: "Choosing interaction method…", verifying: "Verifying result…", recovering: "Recovering from failed action…",
    waiting: "Waiting…", finding: "Finding target…", executing: "Working…",
  };
  const $ = (tag, cls, html) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (html !== undefined) el.innerHTML = html;
    return el;
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function mount(bridge) {
    if (document.getElementById("noahOverlay")) return window.NoahOverlay._instance;

    const root = $("div");
    root.id = "noahOverlay";
    root.setAttribute("data-state", "IDLE");
    root.setAttribute("aria-hidden", "false");
    root.hidden = true;

    const trail = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    trail.setAttribute("class", "noah-trail");
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    trail.appendChild(poly);

    const target = $("div", "noah-target");
    const focus = $("div", "noah-focus");
    const cursor = $("div", "noah-cursor");
    cursor.innerHTML =
      '<div class="noah-halo"></div>' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="noah-arrow" d="M3 2 L3 19 L8 14.6 L11.4 22 L14.4 20.7 L11 13.4 L18 13.2 Z"/></svg>' +
      '<div class="noah-tag">NOAH</div>';

    const status = $("div", "noah-status");
    status.innerHTML = '<span class="noah-dot"></span><b>NOAH</b><span class="noah-text"></span>';
    const statusText = status.querySelector(".noah-text");

    const stopBtn = $("button", "noah-stop noah-interactive", 'STOP NOAH <kbd>Esc</kbd>');
    stopBtn.type = "button";
    stopBtn.addEventListener("click", () => window.noah && window.noah.stop());

    const confirmCard = $("div", "noah-confirm noah-interactive");
    confirmCard.setAttribute("role", "alertdialog");
    confirmCard.setAttribute("aria-label", "Noah needs your confirmation");
    const takeover = $("div", "noah-takeover noah-interactive");
    takeover.setAttribute("role", "alert");
    const sr = $("div", "noah-sr");
    sr.setAttribute("aria-live", "polite");
    sr.setAttribute("role", "status");

    root.append(trail, target, focus, cursor, status, stopBtn, confirmCard, takeover, sr);
    document.body.appendChild(root);

    // ---------------------------------------------------------------- state
    const S = {
      pos: null, anim: 0, state: "IDLE", stateTimer: 0, hideTimer: 0, targetTimer: 0,
      cfg: { cursor: {} }, taskActive: false, typingUntilEnd: false,
      dragPts: [], lastZoom: 1, reduced: false,
    };
    const mq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const reduced = () => (mq && mq.matches) || !!(S.cfg.cursor && S.cfg.cursor.reducedMotion);

    function setState(name, holdMs) {
      clearTimeout(S.stateTimer);
      S.state = name;
      root.setAttribute("data-state", name);
      const hold = holdMs !== undefined ? holdMs : STATE_HOLD[name];
      if (hold) S.stateTimer = setTimeout(() => setState(S.taskActive ? "THINKING" : "IDLE"), hold);
    }

    function setStatus(text) {
      if (!text) return;
      statusText.textContent = text;
      sr.textContent = "Noah: " + text;
    }

    function show() {
      clearTimeout(S.hideTimer);
      root.hidden = false;
      root.classList.toggle("noah-reduced-motion", reduced());
    }

    function scheduleHide(ms) {
      clearTimeout(S.hideTimer);
      S.hideTimer = setTimeout(() => {
        cursor.classList.remove("noah-visible");
        status.classList.remove("noah-visible");
        stopBtn.classList.remove("noah-visible");
        target.classList.remove("noah-visible");
        focus.classList.remove("noah-visible");
        clearTrail();
        setState("IDLE", 0);
        if (!confirmCard.classList.contains("noah-visible") && !takeover.classList.contains("noah-visible")) root.hidden = true;
      }, ms);
    }

    // ------------------------------------------------------------ geometry
    // Cursor overlay lives in shell space; agent events carry CSS-viewport points.
    function toShell(x, y, zoom) {
      const r = bridge && bridge.webviewRect ? bridge.webviewRect() : null;
      const z = zoom || S.lastZoom || 1;
      S.lastZoom = z;
      if (!r) return { x, y };
      return { x: r.x + x * z, y: r.y + y * z };
    }
    function rectToShell(rc, zoom) {
      if (!rc) return null;
      const a = toShell(rc.x, rc.y, zoom);
      const z = zoom || S.lastZoom || 1;
      return { x: a.x, y: a.y, width: rc.width * z, height: rc.height * z };
    }
    function place(el, r, pad) {
      const p = pad || 0;
      el.style.transform = `translate(${r.x - p}px, ${r.y - p}px)`;
      el.style.left = "0"; el.style.top = "0";
      el.style.width = `${Math.max(4, r.width + p * 2)}px`;
      el.style.height = `${Math.max(4, r.height + p * 2)}px`;
    }

    function setCursor(x, y) {
      cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      S.pos = { x, y };
    }

    // Natural pointer path: quadratic Bezier with a small perpendicular bow and
    // minimum-jerk easing. Duration comes from the agent (distance-scaled, capped).
    function moveTo(x, y, ms) {
      cancelAnimationFrame(S.anim);
      cursor.classList.add("noah-visible");
      if (!S.pos || reduced() || !(ms > 0)) return setCursor(x, y);
      const from = S.pos;
      const dx = x - from.x, dy = y - from.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 2) return setCursor(x, y);
      const bow = Math.min(60, dist * 0.12) * (Math.random() < 0.5 ? -1 : 1);
      const cx = from.x + dx / 2 + (-dy / dist) * bow;
      const cy = from.y + dy / 2 + (dx / dist) * bow;
      const t0 = performance.now();
      const ease = (t) => t * t * t * (t * (t * 6 - 15) + 10);
      (function frame(now) {
        const t = Math.min(1, (now - t0) / ms);
        const e = ease(t);
        const px = (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * cx + e * e * x;
        const py = (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * cy + e * e * y;
        setCursor(px, py);
        if (t < 1) S.anim = requestAnimationFrame(frame);
      })(t0);
    }

    function ripple(x, y, kind) {
      const el = $("div", "noah-ripple" + (kind === "right" ? " noah-right" : "") + (kind === "double" ? " noah-double" : ""));
      el.style.left = x + "px";
      el.style.top = y + "px";
      root.appendChild(el);
      setTimeout(() => el.remove(), 900);
    }

    function highlight(rc, ms) {
      if (!rc) return;
      place(target, rc, 3);
      target.classList.add("noah-visible");
      clearTimeout(S.targetTimer);
      S.targetTimer = setTimeout(() => target.classList.remove("noah-visible"), ms || 900);
    }

    function clearTrail() {
      S.dragPts = [];
      poly.setAttribute("points", "");
    }

    // -------------------------------------------------------- event handling
    function onMouse(evt) {
      show();
      status.classList.add("noah-visible");
      const p = toShell(evt.x, evt.y, evt.zoomFactor);
      const travel = evt.travelMs || 0;
      const rc = rectToShell(evt.target && evt.target.rect, evt.zoomFactor);
      switch (evt.action) {
        case "drag_move":
          setCursor(p.x, p.y);
          S.dragPts.push(p.x + "," + p.y);
          if (S.dragPts.length > 240) S.dragPts.shift();
          poly.setAttribute("points", S.dragPts.join(" "));
          return;
        case "drag_start": {
          setState("DRAGGING", 0);
          setStatus("Dragging…");
          if (rc) highlight(rc, 700);
          clearTrail();
          moveTo(p.x, p.y, travel);
          S.dragPts.push(p.x + "," + p.y);
          return;
        }
        case "drag_end":
          setCursor(p.x, p.y);
          ripple(p.x, p.y);
          setTimeout(clearTrail, 600);
          setState("SUCCESS");
          return;
        case "move": setState("MOVING", 0); setStatus("Moving pointer"); moveTo(p.x, p.y, travel); setTimeout(() => S.state === "MOVING" && setState("THINKING", 0), travel + 60); return;
        case "hover": setState("HOVERING", 0); setStatus("Hovering"); if (rc) highlight(rc, 1200); moveTo(p.x, p.y, travel); return;
        case "mouse_down": setState("DRAGGING", 0); moveTo(p.x, p.y, travel); return;
        case "mouse_up": setState("SUCCESS"); ripple(p.x, p.y); return;
        case "click":
        case "double_click":
        case "right_click": {
          const st = evt.action === "click" ? "CLICKING" : evt.action === "double_click" ? "DOUBLE_CLICKING" : "RIGHT_CLICKING";
          setStatus(evt.target && evt.target.label ? "Clicking “" + evt.target.label + "”" : "Clicking");
          if (rc) highlight(rc, 900);
          setState("MOVING", 0);
          moveTo(p.x, p.y, travel);
          // The ripple marks arrival; the real click has already been dispatched (decoupled).
          setTimeout(() => {
            setState(st);
            ripple(p.x, p.y, evt.action === "right_click" ? "right" : evt.action === "double_click" ? "double" : "");
          }, reduced() ? 0 : travel);
          return;
        }
        default:
          moveTo(p.x, p.y, travel);
      }
    }

    function onKeyboard(evt) {
      show();
      status.classList.add("noah-visible");
      if (evt.phase === "start") {
        setState("TYPING", 0);
        setStatus(evt.action === "type" ? "Typing…" : "Pressing " + (evt.key || "key"));
        const rc = rectToShell(evt.focusRect);
        if (rc) { place(focus, rc, 2); focus.classList.add("noah-visible"); }
      } else {
        // end/error: typing activity lasted exactly durationMs of REAL keyboard time
        setTimeout(() => focus.classList.remove("noah-visible"), 350);
        setState(evt.phase === "error" ? "ERROR" : S.taskActive ? "THINKING" : "IDLE", evt.phase === "error" ? undefined : 0);
      }
    }

    function onScroll(evt) {
      show();
      const p = toShell(evt.x, evt.y, evt.zoomFactor);
      setState("SCROLLING", 500);
      setStatus("Scrolling");
      moveTo(p.x, p.y, 0); // anchored where the wheel actually turned; never wanders
    }

    function onAgentStatus(evt) {
      show();
      status.classList.add("noah-visible");
      stopBtn.classList.add("noah-visible");
      setStatus(evt.text || PHASE_TEXT[evt.phase] || "Working…");
      if (["thinking", "planning", "observing", "deciding", "verifying", "recovering"].includes(evt.phase)) setState("THINKING", 0);
      else if (evt.phase === "waiting") setState("WAITING", 0);
    }

    function showConfirm(evt) {
      show();
      const r = evt.risk || {};
      confirmCard.innerHTML =
        `<h4>NOAH NEEDS YOUR OK <span class="noah-risk" data-level="${esc(r.level)}">${esc(r.level || "review")}</span></h4>` +
        `<p><b>${esc(evt.summary)}</b></p>` +
        (evt.origin ? `<p class="noah-why">Site: ${esc(evt.origin)}</p>` : "") +
        (evt.why ? `<p class="noah-why">${esc(evt.why)}</p>` : "") +
        `<div class="noah-buttons"><button type="button" class="noah-cancel">Cancel</button><button type="button" class="noah-allow">Allow</button></div>`;
      const respond = (allow) => { window.noah && window.noah.confirm(evt.id, allow); confirmCard.classList.remove("noah-visible"); };
      confirmCard.querySelector(".noah-cancel").addEventListener("click", () => respond(false));
      confirmCard.querySelector(".noah-allow").addEventListener("click", () => respond(true));
      confirmCard.classList.add("noah-visible");
      confirmCard.dataset.id = evt.id;
      setState("WAITING", 0); // cursor stops while a decision is pending
      setStatus("Confirmation required");
      confirmCard.querySelector(".noah-cancel").focus(); // safe default
    }

    function showTakeover(reason, kind) {
      show();
      takeover.innerHTML =
        `<h4>${kind === "ask_user" ? "WAITING FOR YOU" : "PAUSED"}</h4><p>${esc(reason || "You took control.")}</p><p class="noah-why" style="color:#c9bfe8;font-size:12px">Noah will re-read the page before continuing.</p>` +
        `<div class="noah-buttons"><button type="button" class="noah-stop-btn">Stop task</button><button type="button" class="noah-resume">Continue</button></div>`;
      takeover.querySelector(".noah-stop-btn").addEventListener("click", () => window.noah && window.noah.stop());
      takeover.querySelector(".noah-resume").addEventListener("click", () => { window.noah && window.noah.resume(); takeover.classList.remove("noah-visible"); });
      takeover.classList.add("noah-visible");
      setState("WAITING", 0);
      setStatus(kind === "ask_user" ? "Waiting for you" : "Paused");
    }

    function handle(evt) {
      if (!evt || !evt.event) return;
      switch (evt.event) {
        case "task_started": {
          S.taskActive = true;
          show(); status.classList.add("noah-visible"); stopBtn.classList.add("noah-visible");
          setStatus("Working…"); setState("THINKING", 0);
          // Be visibly present from the first moment: park the cursor in the middle of the page (pulsing while Noah thinks)
          // instead of appearing only when the first click happens, which can be many seconds and a confirmation away.
          const r = bridge && bridge.webviewRect ? bridge.webviewRect() : null;
          if (r) moveTo(r.x + r.width / 2, r.y + r.height / 2, 350);
          break;
        }
        case "step": {
          // Navigation has no mouse event, so the pointer would sit still while the page changes. Glide to the address bar
          // to show where Noah is working.
          const a = evt.actions && evt.actions[0] && evt.actions[0].action;
          if (["navigate", "new_tab", "back", "forward", "reload"].includes(a)) {
            const bar = document.getElementById("urlBar");
            const br = bar && bar.getBoundingClientRect();
            if (br && br.width > 0) { show(); moveTo(br.left + Math.min(br.width * 0.35, 260), br.top + br.height / 2, 450); }
          }
          break;
        }
        case "session_state":
          // the one status source: where the agent stands, in words a person would use
          if (evt.state === "planning" || evt.state === "executing") { status.classList.add("noah-visible"); setStatus(evt.text || "Working…"); }
          else if (evt.state === "waiting_for_user") setStatus("Waiting for you");
          else if (evt.state === "paused") setStatus("Paused");
          break;
        case "ask_user": S.question = evt.question; break;
        case "task_finished":
          if (evt.superseded) break; // the next instruction's run starts straight away
          S.taskActive = false; stopBtn.classList.remove("noah-visible");
          confirmCard.classList.remove("noah-visible");
          setStatus(evt.status === "completed" ? "Done" : evt.status === "cancelled" ? "Stopped" : "Task ended");
          setState(evt.status === "completed" ? "SUCCESS" : evt.status === "cancelled" ? "IDLE" : "ERROR");
          scheduleHide(1800); break;
        case "agent_status": onAgentStatus(evt); break;
        case "cursor_state": show(); setState(evt.state, evt.holdMs); break;
        case "mouse_action": onMouse(evt); break;
        case "scroll_action": onScroll(evt); break;
        case "keyboard_action": onKeyboard(evt); break;
        case "action_result":
          if (evt.diagnostics) S.diag = evt.diagnostics;
          if (evt.ok === false) { setState("ERROR"); setStatus(evt.message || "Action failed"); }
          else if (evt.ok) setState("SUCCESS");
          break;
        case "confirm_request": showConfirm(evt); break;
        case "confirm_resolved": confirmCard.classList.remove("noah-visible"); if (S.taskActive) setState("THINKING", 0); break;
        case "safety":
          if (evt.level === "pause" && evt.reason) showTakeover(evt.reason === "takeover" ? "You took control of the browser." : evt.reason === "ask_user" ? (S.question || "Noah is waiting for you.") : "Paused.", evt.reason);
          else if (evt.level === "resume") { takeover.classList.remove("noah-visible"); setState("THINKING", 0); }
          else if (evt.level === "stop" && evt.reason === "superseded") { takeover.classList.remove("noah-visible"); confirmCard.classList.remove("noah-visible"); }
          else if (evt.level === "stop") { setStatus("Stopped"); setState("IDLE", 0); takeover.classList.remove("noah-visible"); confirmCard.classList.remove("noah-visible"); }
          break;
        default: break;
      }
    }

    function applyTheme(theme) {
      if (!theme || !theme.variables) return;
      for (const [k, v] of Object.entries(theme.variables)) root.style.setProperty(k, v);
    }

    function applyConfig(cfg) {
      S.cfg = cfg || S.cfg;
      // cursor.mode "off" (the panel's "Purple cursor" switch) hides the pointer, ripples and highlights; the status
      // pill and the STOP button always stay so the user can see and stop what Noah is doing.
      root.classList.toggle("noah-cursor-off", !!(S.cfg.cursor && S.cfg.cursor.mode === "off"));
      root.classList.toggle("noah-reduced-motion", reduced());
    }

    const api = { handle, applyTheme, applyConfig, _state: S, root };
    window.NoahOverlay._instance = api;
    return api;
  }

  window.NoahOverlay = { mount };
})();
