// Noah/models/math-text.cjs
//
// Answers Noah types into a page are read by a PERSON, so maths must look like maths on paper - "∫₀^∞ x²/(1+x⁴) dx = π/(2√2)" - not
// LaTeX source ("$\int_{0}^{\infty} \frac{x^2}{1+x^4} dx = \frac{\pi}{2\sqrt{2}}$"), which is what a language model writes by default and
// what a plain answer box displays literally. toPlainMath() converts LaTeX (and the markdown a chat model wraps around it) into plain text
// with Unicode maths symbols, super/subscripts and readable fractions. Pure, no dependencies; text without LaTeX is returned untouched.

"use strict";

const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ", "′": "′", "'": "′" };
const SUB = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ" };

const SYMBOL = {
  // greek
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  // operators and relations
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓", ast: "*", star: "⋆", circ: "∘", bullet: "•", oplus: "⊕", otimes: "⊗",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡", sim: "∼", simeq: "≃", cong: "≅", propto: "∝", ll: "≪", gg: "≫",
  to: "→", rightarrow: "→", leftarrow: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔", implies: "⟹", iff: "⟺", mapsto: "↦", longrightarrow: "⟶",
  infty: "∞", partial: "∂", nabla: "∇", forall: "∀", exists: "∃", nexists: "∄", in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇", cup: "∪", cap: "∩", setminus: "∖", emptyset: "∅", varnothing: "∅",
  land: "∧", wedge: "∧", lor: "∨", vee: "∨", neg: "¬", lnot: "¬", therefore: "∴", because: "∵", angle: "∠", perp: "⊥", parallel: "∥", degree: "°", prime: "′", ell: "ℓ", hbar: "ℏ", Re: "ℜ", Im: "ℑ", aleph: "ℵ",
  ldots: "…", dots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱",
  sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮",
  langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", lvert: "|", rvert: "|", lVert: "‖", rVert: "‖", vert: "|", Vert: "‖",
  lbrace: "{", rbrace: "}", lbrack: "[", rbrack: "]",
  // spacing: dropped
  quad: " ", qquad: "  ", displaystyle: "", textstyle: "", limits: "", nolimits: "", big: "", Big: "", bigg: "", Bigg: "", bigl: "", bigr: "", Bigl: "", Bigr: "", biggl: "", biggr: "", hline: "", nonumber: "", notag: "", centering: "", label: "",
};
// functions that keep their name (\sin -> sin)
const FUNCTIONS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "coth", "ln", "log", "exp", "lim", "limsup", "liminf", "max", "min", "sup", "inf", "det", "dim", "ker", "gcd", "deg", "arg", "Pr", "mod", "bmod", "hom", "trace", "tr", "rank", "Res", "sgn"]);
const BLACKBOARD = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", P: "ℙ", E: "𝔼" };
const ACCENT = { bar: "̄", overline: "̄", vec: "⃗", hat: "̂", widehat: "̂", dot: "̇", ddot: "̈", tilde: "̃", widetilde: "̃", underline: "̲" };
const ENV_BRACKETS = { pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"], vmatrix: ["|", "|"], Vmatrix: ["‖", "‖"], matrix: ["", ""], smallmatrix: ["", ""] };
const ENV_INLINE = new Set(["align", "align*", "aligned", "alignedat", "equation", "equation*", "gather", "gather*", "gathered", "split", "eqnarray", "multline", "array", "math", "displaymath", "cases", "flalign", "flalign*", "center", "document", "itemize", "enumerate"]);

/** Does this text contain LaTeX (or the markdown a chat model wraps around it) worth converting? */
const LATEX_SIGNS = /\\(?:frac|dfrac|tfrac|sqrt|int|iint|oint|sum|prod|lim|cdot|times|left|right|begin|end|text|mathrm|mathbf|mathbb|operatorname|boxed|alpha|beta|gamma|delta|theta|lambda|mu|pi|sigma|omega|infty|leq|geq|neq|approx|to|rightarrow|Rightarrow|partial|nabla|pm|ldots|dots|cdots|quad|displaystyle|binom|overline|vec|hat|bar|in|subset|cup|cap|forall|exists)\b|\\[\[\]()]|\$\$|\$[^$\n]*[\\^_{}][^$\n]*\$|\*\*\S|^#{1,6}\s/m;
function looksLikeLatex(text) {
  return LATEX_SIGNS.test(String(text || ""));
}

// ----------------------------------------------------------------------------------------------------------- helpers

// Fractions: a denominator must be ONE token ("1/4√2" reads as (1/4)·√2 - wrong), a numerator may be a product such as 2π but not a sum.
const SUPSUB = "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿˣʸᶻ₀₁₂₃₄₅₆₇₈₉ₙᵢⱼ′'";
const isAtom = (s) => new RegExp("^√?(?:\\d+(?:\\.\\d+)?|[A-Za-zΑ-Ωα-ωϑφ∞ℝℕℤℚℂ])[" + SUPSUB + "]*$", "u").test(s) || /^[A-Za-z]+\([^()]*\)[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿˣʸᶻ]*$/.test(s);
const isTerm = (s) => new RegExp("^(?:\\d+(?:\\.\\d+)?|[A-Za-zΑ-Ωα-ω∞√])[A-Za-zΑ-Ωα-ω0-9.√" + SUPSUB + "]*$", "u").test(s);
const isWrapped = (s) => {
  if (s[0] !== "(" || s[s.length - 1] !== ")") return false;
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") d++;
    else if (s[i] === ")" && --d === 0 && i < s.length - 1) return false;
  }
  return d === 0;
};
const paren = (s) => (isWrapped(s) ? s : `(${s})`);
const isSimple = (s) => /^[A-Za-z0-9.'′π∞αβγδεθλμσφωΔΣΩ⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻ⁿˣʸ₀₁₂₃₄₅₆₇₈₉ₙᵢⱼ√]+$/.test(s) || /^\([^()]*\)$/.test(s) || /^\|[^|]+\|$/.test(s);

function mapAll(s, table) {
  let out = "";
  for (const ch of s) {
    if (!table[ch]) return null;
    out += table[ch];
  }
  return out;
}

/** x^{...}: real superscript characters when every character has one, else a readable ^(...) . */
function power(inner) {
  const t = inner.trim();
  if (!t) return "";
  const m = mapAll(t, SUP);
  if (m !== null) return m;
  return isSimple(t) ? `^${t}` : `^(${t})`;
}
function subscript(inner) {
  const t = inner.trim();
  if (!t) return "";
  const m = mapAll(t, SUB);
  if (m !== null) return m;
  // a short mix such as "-∞" or "n=∞": subscript what has a glyph and leave the symbol as it is (∫₋∞^∞)
  if (t.length <= 5 && /^[0-9a-z+\-−=()]*[∞πα-ω][0-9a-z+\-−=()]*$/.test(t)) return Array.from(t).map((c) => SUB[c] || c).join("");
  return isSimple(t) ? `_${t}` : `_(${t})`;
}

/** Index just past the balanced {...} group that starts at s[i] === "{"; -1 when unbalanced. */
function groupEnd(s, i) {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") { k++; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return k + 1;
  }
  return -1;
}

// ------------------------------------------------------------------------------------------------------- the converter

// Matrix rows with aligned columns and real bracket glyphs, e.g.
//   ⎛ 2ⁿ   n·2ⁿ⁻¹ ⎞
//   ⎝ 0    2ⁿ     ⎠
const PIECES = {
  pmatrix: ["(", "⎛", "⎜", "⎝", ")", "⎞", "⎟", "⎠"], bmatrix: ["[", "⎡", "⎢", "⎣", "]", "⎤", "⎥", "⎦"], Bmatrix: ["{", "{", "{", "{", "}", "}", "}", "}"],
  vmatrix: ["|", "│", "│", "│", "|", "│", "│", "│"], Vmatrix: ["‖", "‖", "‖", "‖", "‖", "‖", "‖", "‖"], matrix: ["", "", "", "", "", "", "", ""], smallmatrix: ["", "", "", "", "", "", "", ""],
};
function renderMatrix(grid, env) {
  const p = PIECES[env] || PIECES.matrix;
  const cols = Math.max(0, ...grid.map((r) => r.length));
  const width = Array.from({ length: cols }, (_, c) => Math.max(...grid.map((r) => (r[c] || "").length)));
  const inner = width.reduce((a, w) => a + w, 0) + 3 * Math.max(0, cols - 1);
  const n = grid.length;
  return grid
    .map((r, i) => {
      const cells = width.map((w, c) => (r[c] || "").padEnd(w)).join("   ");
      const [l, rr] = n === 1 ? [p[0], p[4]] : i === 0 ? [p[1], p[5]] : i === n - 1 ? [p[3], p[7]] : [p[2], p[6]];
      return l || rr ? `${l} ${cells.padEnd(inner)} ${rr}` : cells.trimEnd();
    })
    .join("\n");
}

/** Convert one LaTeX fragment (no surrounding $). */
function conv(s) {
  let out = "";
  let i = 0;
  // read one argument: a {group}, a \command (with its own arguments left for conv) or a single character
  const arg = () => {
    while (s[i] === " ") i++;
    if (s[i] === "{") {
      const end = groupEnd(s, i);
      if (end < 0) { const rest = s.slice(i + 1); i = s.length; return conv(rest); }
      const inner = s.slice(i + 1, end - 1);
      i = end;
      return conv(inner);
    }
    if (s[i] === "\\") {
      const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
      i += m[0].length;
      return conv(m[0]);
    }
    const ch = s[i] || "";
    i += ch ? 1 : 0;
    return ch;
  };
  const optArg = () => {
    if (s[i] === "[") { const end = s.indexOf("]", i); if (end > 0) { const v = s.slice(i + 1, end); i = end + 1; return conv(v); } }
    return null;
  };

  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const m = /^\\([A-Za-z]+\*?|.)/.exec(s.slice(i));
      const name = m[1];
      i += m[0].length;
      if (name === "\\") { out += "\n"; while (s[i] === " ") i++; continue; }            // line break
      if (/^[,;:! ]$/.test(name)) { out += name === "!" ? "" : " "; continue; }          // thin spaces
      if (/^[{}%$&#_]$/.test(name)) { out += name; continue; }                           // escaped literals
      if (name === "|") { out += "‖"; continue; }
      if (name === "/") continue;
      if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac") {
        const a = arg().trim();
        const b = arg().trim();
        out += `${isTerm(a) || isAtom(a) || isWrapped(a) ? a : paren(a)}/${isAtom(b) || isWrapped(b) ? b : paren(b)}`;
        continue;
      }
      if (name === "binom" || name === "dbinom") { const a = arg(); const b = arg(); out += `C(${a}, ${b})`; continue; }
      if (name === "sqrt") {
        const n = optArg();
        const a = arg().trim();
        const root = n === null ? "√" : n === "3" ? "∛" : n === "4" ? "∜" : `${power(n)}√`;
        out += `${root}${isAtom(a) || isWrapped(a) ? a : paren(a)}`;
        continue;
      }
      if (name === "text" || name === "textbf" || name === "textit" || name === "mathrm" || name === "mathbf" || name === "mathit" || name === "mathsf" || name === "mathtt" || name === "mathcal" || name === "mathscr" || name === "boldsymbol" || name === "operatorname" || name === "textrm" || name === "mbox" || name === "hbox" || name === "emph" || name === "bm") {
        out += arg();
        continue;
      }
      if (name === "mathbb") { const a = arg(); out += BLACKBOARD[a] || a; continue; }
      if (name === "boxed" || name === "fbox") { out += arg(); continue; }
      if (ACCENT[name]) {
        const a = arg();
        out += a.length === 1 ? a + ACCENT[name] : `${a}${name === "overline" || name === "bar" ? "̄" : ""}`;
        continue;
      }
      if (name === "left" || name === "right") {
        if (name === "right") out = out.replace(/[ \t]+$/, ""); // no padding spaces inside ( ... )
        while (s[i] === " ") i++;
        if (s[i] === ".") { i++; continue; }                                             // \left. / \right. : an invisible delimiter
        if (s[i] === "\\") { const d = /^\\([A-Za-z]+|.)/.exec(s.slice(i)); i += d[0].length; out += conv(d[0]); }
        else { out += s[i] || ""; i += s[i] ? 1 : 0; }
        if (name === "left") while (s[i] === " ") i++;                                     // no padding spaces inside ( ... )
        continue;
      }
      if (name === "begin") {
        const env = arg().trim();
        const endTag = `\\end{${env}}`;
        const stop = s.indexOf(endTag, i);
        const body = s.slice(i, stop < 0 ? s.length : stop);
        i = stop < 0 ? s.length : stop + endTag.length;
        if (ENV_BRACKETS[env]) {
          const grid = body.split(/\\\\/).map((r) => r.trim()).filter(Boolean).map((r) => r.split("&").map((cell) => conv(cell).trim()));
          out += "\n" + renderMatrix(grid, env) + "\n";
        } else if (env === "cases") {
          const rows = body.split(/\\\\/).map((r) => r.trim()).filter(Boolean).map((r) => "  " + r.split("&").map((cell) => conv(cell).trim()).join("   if "));
          out += "\n{\n" + rows.join("\n") + "\n";
        } else {
          out += conv(body.replace(/&/g, " "));
        }
        continue;
      }
      if (name === "end") { arg(); continue; }
      if (name === "lim" || name === "limsup" || name === "liminf" || name === "max" || name === "min" || name === "sup" || name === "inf") {
        // a limit's condition reads naturally in brackets under the word: lim (x→0)
        out += name;
        if (s[i] === "_") { i++; out += ` (${arg().trim()})`; }
        continue;
      }
      if (name === "sum" || name === "prod" || name === "coprod" || name === "int" || name === "iint" || name === "iiint" || name === "oint") {
        out += SYMBOL[name];
        continue;                                                                          // its ^ and _ are handled below
      }
      if (FUNCTIONS.has(name)) { out += name; continue; }
      if (name in SYMBOL) { out += SYMBOL[name]; continue; }
      out += name.length > 1 ? name : "";                                                  // unknown command: keep its name, drop the backslash
      continue;
    }
    if (c === "^" || c === "_") {
      i++;
      const a = arg();
      out += c === "^" ? power(a) : subscript(a);
      continue;
    }
    if (c === "{" || c === "}") { i++; continue; }                                         // bare grouping braces
    if (c === "~") { out += " "; i++; continue; }
    if (c === "&") { out += " "; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

/** Pull the maths out of $$..$$, $..$, \(..\), \[..\] and convert it; convert stray commands outside delimiters too. */
function convertDelimited(text) {
  let t = String(text);
  const wrap = (inner, display) => (display ? `\n${conv(inner).trim()}\n` : conv(inner).trim());
  t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => wrap(m, true));
  t = t.replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => wrap(m, true));
  t = t.replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => wrap(m, false));
  // a single-$ pair is maths unless it is money ("$5 and $6")
  t = t.replace(/(?<!\\)\$([^$\n]{1,400}?)(?<!\\)\$/g, (whole, m) => (/[\\^_{}=<>+*]|^\s*[A-Za-z]/.test(m) && !/^\s*\d[\d,.]*\s*$/.test(m) ? wrap(m, false) : whole));
  return t.replace(/\\[A-Za-z]+[\s\S]*?(?=\s\\?[A-Za-z]+\s|$)/g, (frag) => conv(frag));
}

/**
 * Convert LaTeX in an answer to plain text a person would write. Text with no LaTeX is returned as it was.
 * @param {string} text
 * @returns {string}
 */
function toPlainMath(text) {
  const original = String(text == null ? "" : text);
  if (!looksLikeLatex(original)) return original;
  let t = original.replace(/\r\n?/g, "\n");
  // fenced code / markdown wrappers a chat model adds around a solution
  t = t.replace(/```[a-zA-Z]*\n?/g, "");
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  t = t.replace(/\*\*([^*\n]+?)\*\*/g, "$1").replace(/__([^_\n]+?)__/g, "$1");
  t = convertDelimited(t);
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(); // (runs of spaces are kept: they are a matrix's column alignment)
  return t;
}

module.exports = { toPlainMath, looksLikeLatex, conv, power, subscript };
