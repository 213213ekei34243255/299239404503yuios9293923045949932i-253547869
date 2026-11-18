// jonah-calc.js - Jonah's Calculator in the style of Apple's iPhone calculator: big round keys, grey digits, orange operators,
// light-grey function row, the number in a large thin font. "Sci" shows the scientific keys (as the iPhone does when turned
// sideways). The maths is Electron Jonah's own safe evaluator (safeEvalMath in tools.js: no eval of what you type).
(function () {
  "use strict";
  const STYLE = `
    html body .jonah-tool-panel.jc-panel .jtp-body { padding: 0 14px 18px !important; display: flex; flex-direction: column; min-height: calc(100% - 70px); }
    .jc-screen { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: flex-end; padding: 12px 8px 14px; min-height: 150px; }
    .jc-expr { font-size: 20px; color: rgba(235,235,245,.55); min-height: 26px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: right; }
    .jc-expr bdi { direction: ltr; unicode-bidi: isolate; }
    html body .jonah-tool-panel .jc-key:focus, html body .jonah-tool-panel .jc-key:focus-visible { outline: none !important; box-shadow: none !important; }
    .jc-num { font-size: 76px; font-weight: 300; letter-spacing: -0.03em; line-height: 1.05; color: #fff; max-width: 100%; white-space: nowrap; overflow: hidden; text-align: right;
      font-family: -apple-system, "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", sans-serif; transition: font-size .12s; }
    .jc-keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
    .jc-sci { display: none; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 12px; }
    .jc-panel.sci .jc-sci { display: grid; }
    html body .jonah-tool-panel .jc-key {
      aspect-ratio: 1 / 1; width: 100%; padding: 0 !important; border-radius: 50% !important; border: 0 !important;
      font-family: -apple-system, "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", sans-serif !important;
      font-size: 30px !important; font-weight: 400 !important; color: #fff !important; background: #333333 !important; box-shadow: none !important;
      display: flex; align-items: center; justify-content: center; user-select: none; transition: filter .08s, background .2s, color .2s;
    }
    html body .jonah-tool-panel .jc-key:hover { filter: brightness(1.25); }
    html body .jonah-tool-panel .jc-key:active { filter: brightness(1.6); }
    html body .jonah-tool-panel .jc-key.fn { background: #a5a5a5 !important; color: #000 !important; font-size: 26px !important; font-weight: 500 !important; }
    html body .jonah-tool-panel .jc-key.op { background: #ff9f0a !important; font-size: 36px !important; }
    html body .jonah-tool-panel .jc-key.op.on { background: #fff !important; color: #ff9f0a !important; }
    html body .jonah-tool-panel .jc-key.zero { grid-column: span 2; aspect-ratio: auto; border-radius: 999px !important; justify-content: flex-start; padding-left: 12% !important; }
    html body .jonah-tool-panel .jc-key.sci { aspect-ratio: auto; height: 44px; border-radius: 999px !important; font-size: 16px !important; background: #1c1c1e !important; }
    html body .jonah-tool-panel .jc-mode { align-self: flex-start; margin: 8px 0 0 4px; padding: 5px 12px !important; font-size: 13px !important; background: rgba(118,118,128,.24) !important; box-shadow: none !important; }
    html body .jonah-tool-panel .jc-panel.sci .jc-mode { background: #ff9f0a !important; }
  `;

  // expr: the committed part ("12×3+"); entry: the number being typed (shown big); fresh: the next digit starts a new number;
  // closed: the last thing in expr is ")" (the operand is already in expr); shownExpr: the small line above the number.
  let expr = "", entry = "0", fresh = true, closed = false, done = false, shownExpr = "", ans = 0;
  let panel = null;

  const $ = (s) => panel && panel.querySelector(s);
  const raw = (e) => String(e).replace(/,/g, "");
  const fmt = (n) => {
    if (!Number.isFinite(n)) return "Error";
    const abs = Math.abs(n);
    if (abs !== 0 && (abs >= 1e15 || abs < 1e-9)) return n.toExponential(6).replace(/\.?0+e/, "e");
    return parseFloat(n.toPrecision(12)).toLocaleString("en-US", { maximumFractionDigits: 10 });
  };
  const toMath = (s) => s.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  const evaluate = (text) => window.safeEvalMath(toMath(text), ans);
  const lastIsOp = () => /[+−×÷^]$/.test(expr);

  function show() {
    const num = $(".jc-num"); if (!num) return;
    num.textContent = entry;
    num.style.fontSize = entry.length > 11 ? "40px" : entry.length > 8 ? "54px" : "76px";
    const ex = $(".jc-expr"); ex.textContent = ""; const bdi = document.createElement("bdi"); bdi.textContent = done ? shownExpr : expr + (fresh || closed ? "" : raw(entry)); ex.appendChild(bdi);
    panel.querySelectorAll(".jc-key.op").forEach((k) => k.classList.toggle("on", fresh && !done && expr.endsWith(k.dataset.k)));
    const ac = $('[data-k="AC"]'); if (ac) ac.textContent = !fresh || expr ? "C" : "AC";
  }

  function startOver() { if (done) { expr = ""; done = false; closed = false; } }

  function press(k) {
    try {
      if (/^[0-9]$/.test(k)) {
        startOver();
        if (closed) { expr += "×"; closed = false; }
        if (fresh) { entry = k; fresh = false; } else if (raw(entry).replace(/[-.]/g, "").length < 15) entry = raw(entry) === "0" ? k : raw(entry) + k;
      } else if (k === ".") {
        startOver();
        if (closed) { expr += "×"; closed = false; }
        if (fresh) { entry = "0."; fresh = false; } else if (!entry.includes(".")) entry = raw(entry) + ".";
      } else if (["+", "−", "×", "÷", "^"].includes(k)) {
        if (done) { expr = ""; done = false; fresh = false; }
        if (closed) { expr += k; closed = false; }
        else if (fresh && lastIsOp()) expr = expr.slice(0, -1) + k;
        else expr += raw(entry) + k;
        try { if (!/\(/.test(expr.replace(/\)/g, ""))) entry = fmt(evaluate(expr.slice(0, -1))); } catch (_) { /* incomplete */ }
        fresh = true;
      } else if (k === "=") {
        if (done) return;
        let text = closed ? expr : expr + raw(entry);
        text = text.replace(/[+−×÷^(]$/, "");
        const opens = (text.match(/\(/g) || []).length - (text.match(/\)/g) || []).length;
        text += ")".repeat(Math.max(0, opens));
        const v = evaluate(text);
        ans = v; shownExpr = text + " ="; entry = fmt(v); expr = ""; fresh = true; closed = false; done = true;
      } else if (k === "AC") {
        if (!fresh) { entry = "0"; fresh = true; }
        else { expr = ""; entry = "0"; fresh = true; closed = false; done = false; }
      } else if (k === "±") {
        if (done) { expr = ""; done = false; }
        const n = parseFloat(raw(entry)) || 0; entry = fmt(-n); fresh = false;
      } else if (k === "%") {
        if (done) { expr = ""; done = false; }
        entry = fmt((parseFloat(raw(entry)) || 0) / 100); fresh = false;
      } else if (k === "(") {
        startOver();
        if (closed || !fresh) { expr += (closed ? "" : raw(entry)) + "×("; closed = false; } else expr += "(";
        entry = "0"; fresh = true;
      } else if (k === ")") {
        const opens = (expr.match(/\(/g) || []).length - (expr.match(/\)/g) || []).length;
        if (opens > 0) { expr += (closed ? "" : raw(entry)) + ")"; closed = true; fresh = true; }
      } else {
        // scientific keys work on the number shown
        if (done) { expr = ""; done = false; }
        const cur = parseFloat(raw(entry)) || 0;
        const fn = { "x²": (x) => x * x, "√": Math.sqrt, "1/x": (x) => 1 / x, sin: Math.sin, cos: Math.cos, tan: Math.tan, ln: Math.log, log: Math.log10 }[k];
        const v = fn ? fn(cur) : k === "π" ? Math.PI : k === "e" ? Math.E : k === "Ans" ? ans : null;
        if (v === null) return;
        if (closed) { expr += "×"; closed = false; }
        entry = fmt(v); fresh = false;
      }
    } catch (_) {
      entry = "Error"; expr = ""; fresh = true; closed = false; done = true; shownExpr = "";
    }
    show();
  }

  function openCalculatorPanel() {
    if (!document.getElementById("jonah-calc-style")) { const s = document.createElement("style"); s.id = "jonah-calc-style"; s.textContent = STYLE; document.head.appendChild(s); }
    const key = (k, cls = "") => `<button class="jc-key ${cls}" data-k="${k}">${k === "AC" ? "AC" : k}</button>`;
    const sci = ["(", ")", "x²", "^", "√", "1/x", "π", "e", "sin", "cos", "tan", "ln", "log", "Ans"].map((k) => `<button class="jc-key sci" data-k="${k}">${k === "^" ? "xʸ" : k}</button>`).join("");
    panel = createToolPanel("calc", "Calculator", `
      <button class="jc-mode" type="button">Sci</button>
      <div class="jc-screen"><div class="jc-expr"></div><div class="jc-num">0</div></div>
      <div class="jc-sci">${sci}</div>
      <div class="jc-keys">
        ${key("AC", "fn")}${key("±", "fn")}${key("%", "fn")}${key("÷", "op")}
        ${key("7")}${key("8")}${key("9")}${key("×", "op")}
        ${key("4")}${key("5")}${key("6")}${key("−", "op")}
        ${key("1")}${key("2")}${key("3")}${key("+", "op")}
        ${key("0", "zero")}${key(".")}${key("=", "op")}
      </div>`);
    panel.classList.add("jc-panel");
    panel.querySelector(".jc-mode").addEventListener("click", () => panel.classList.toggle("sci"));
    panel.addEventListener("click", (e) => { const b = e.target.closest(".jc-key"); if (b) press(b.dataset.k); });
    panel.tabIndex = -1; panel.focus();
    panel.addEventListener("keydown", (e) => {
      const map = { "*": "×", "/": "÷", "-": "−", "+": "+", Enter: "=", "=": "=", Escape: "AC", Backspace: "AC", "%": "%", ".": ".", "^": "^", "(": "(", ")": ")" };
      const k = /^[0-9]$/.test(e.key) ? e.key : map[e.key];
      if (k) { e.preventDefault(); press(k); }
    });
    expr = ""; entry = "0"; fresh = true; closed = false; done = false;
    show();
  }
  window.openCalculatorPanel = openCalculatorPanel;
})();
