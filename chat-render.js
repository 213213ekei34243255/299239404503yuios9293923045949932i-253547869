// chat-render.js  (classic script; also `require`-able from Node for the pure helpers)
//
// Turns an assistant reply (Markdown text) into safe, styled DOM for the panel:
//
//   text --fenceLooseCode--> Markdown --marked--> HTML --DOMPurify--> safe fragment --enhance--> code blocks / tables / links
//
// SAFETY. Replies can contain text that came from web pages or attached files, so the HTML is treated as hostile:
//   * raw HTML in the reply is shown as text (marked's html renderer is overridden), then the result is sanitized anyway;
//   * a strict tag/attribute allow-list; only http(s) links; images are never fetched (alt text is shown instead) - a remote
//     image URL is a classic way to leak conversation text in its query string;
//   * `class` survives only as `language-xxx` on <code>, so reply text can never dress itself up as the panel's own buttons;
//   * links do not navigate the panel: the click is handed to `onOpenLink`, which opens a new tab.
//
// CODE. Every fenced block becomes a card: language label, Copy button (top-right), monospace, syntax highlighting (highlight.js),
// horizontal + vertical scrolling for long code. If the model forgot the fence, fenceLooseCode() finds an unmistakable run of
// code lines and fences it - deliberately conservative, so ordinary prose, bullet lists and tables are never wrapped.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.JonahChatRender = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LANG_LABELS = {
    js: "JavaScript", javascript: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JSX", ts: "TypeScript", typescript: "TypeScript", tsx: "TSX",
    py: "Python", python: "Python", java: "Java", c: "C", cpp: "C++", "c++": "C++", cc: "C++", cs: "C#", csharp: "C#", go: "Go", golang: "Go", rs: "Rust", rust: "Rust",
    rb: "Ruby", ruby: "Ruby", php: "PHP", swift: "Swift", kt: "Kotlin", kotlin: "Kotlin", dart: "Dart", scala: "Scala", hs: "Haskell", haskell: "Haskell", ex: "Elixir", elixir: "Elixir",
    sh: "Shell", bash: "Bash", zsh: "Shell", shell: "Shell", console: "Shell", ps1: "PowerShell", powershell: "PowerShell", pwsh: "PowerShell", bat: "Batch", cmd: "Batch",
    sql: "SQL", html: "HTML", xml: "XML", svg: "SVG", css: "CSS", scss: "SCSS", less: "Less", json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", ini: "INI",
    md: "Markdown", markdown: "Markdown", dockerfile: "Dockerfile", docker: "Dockerfile", nginx: "Nginx", http: "HTTP", diff: "Diff", graphql: "GraphQL", lua: "Lua",
    perl: "Perl", r: "R", objectivec: "Objective-C", "objective-c": "Objective-C", makefile: "Makefile", make: "Makefile", text: "Text", plaintext: "Text", txt: "Text",
    vbnet: "VB.NET", wasm: "WebAssembly", properties: "Properties", latex: "LaTeX", tex: "LaTeX",
  };
  // fence names highlight.js knows under another id
  const HLJS_ALIAS = { js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", sh: "bash", zsh: "bash", shell: "bash", console: "bash", ps1: "powershell", pwsh: "powershell", yml: "yaml", md: "markdown", html: "xml", svg: "xml", "c++": "cpp", cc: "cpp", cs: "csharp", rs: "rust", rb: "ruby", kt: "kotlin", golang: "go", docker: "dockerfile", txt: "plaintext", text: "plaintext", toml: "ini", make: "makefile", hs: "haskell", ex: "elixir" };
  const AUTO_SUBSET = ["javascript", "typescript", "python", "java", "c", "cpp", "csharp", "go", "rust", "php", "ruby", "swift", "kotlin", "bash", "powershell", "sql", "xml", "css", "json", "yaml", "dockerfile", "lua"];

  function prettyLang(id) {
    const k = String(id || "").toLowerCase();
    if (LANG_LABELS[k]) return LANG_LABELS[k];
    return k ? k.charAt(0).toUpperCase() + k.slice(1) : "Code";
  }

  // ------------------------------------------------------------------ unfenced code

  const CODE_KEYWORD = /^\s*(?:def |class |function[ (]|async function|import |from \S+ import |export |const |let |var |public |private |protected |static |void |int |float |double |boolean |String |#include|using |namespace |package |fn |func |return\b|if\s*\(|for\s*\(|while\s*\(|else\b|elif |try:|except\b|catch\s*\(|switch\s*\(|SELECT |INSERT |UPDATE |DELETE FROM|CREATE TABLE|<\/?[a-z][\w-]*(?:\s[^>]*)?>|@\w+|\$\w+\s*=|\w+\s*=\s*(?:new |require\()|console\.|System\.|print\(|printf\(|echo )/;
  const CODE_TAIL = /[;{}]\s*$|=>|[!=]==?|\+=|-=|::|->|\)\s*:$|^\s*[\w.$]+\([^)]*\)\s*;?\s*$/;
  const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

  function isStrongCodeLine(line) {
    if (LIST_ITEM.test(line) && !/[;{}]\s*$/.test(line)) return false;
    if (/^\s*\|.*\|\s*$/.test(line)) return false; // a Markdown table row
    return CODE_KEYWORD.test(line) || CODE_TAIL.test(line);
  }
  function isWeakCodeLine(line) {
    return !line.trim() || (/^(?: {2,}|\t)\S/.test(line) && !LIST_ITEM.test(line));
  }

  /**
   * Fence runs of unmistakable code that the model left as plain text. A run = at least 3 consecutive lines, each either
   * "strong" (a keyword/statement shape) or "weak" (blank or indented), with at least 3 strong lines and strong lines being
   * the majority of the non-blank ones. Text already inside a ``` fence is left exactly as is.
   */
  function fenceLooseCode(text) {
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let inFence = false;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        out.push(line);
        i++;
        continue;
      }
      if (inFence || !(isStrongCodeLine(line) || isWeakCodeLine(line)) || !isStrongCodeLine(line)) {
        out.push(line);
        i++;
        continue;
      }
      // a candidate run starts at a strong line
      let j = i;
      let strong = 0;
      let nonBlank = 0;
      let lastStrong = i;
      while (j < lines.length && !/^\s*(```|~~~)/.test(lines[j]) && (isStrongCodeLine(lines[j]) || isWeakCodeLine(lines[j]))) {
        if (isStrongCodeLine(lines[j])) {
          strong++;
          lastStrong = j;
        }
        if (lines[j].trim()) nonBlank++;
        j++;
      }
      const end = lastStrong + 1; // trailing blank/indented lines after the last real code line are not code
      const runNonBlank = lines.slice(i, end).filter((l) => l.trim()).length;
      const runStrong = lines.slice(i, end).filter(isStrongCodeLine).length;
      void nonBlank;
      void strong;
      if (end - i >= 3 && runStrong >= 3 && runStrong / Math.max(1, runNonBlank) >= 0.6) {
        out.push("```", ...lines.slice(i, end), "```");
        i = end;
      } else {
        out.push(line);
        i++;
      }
    }
    return out.join("\n");
  }

  // ------------------------------------------------------------------ DOM rendering

  const ALLOWED_TAGS = ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "del", "s", "code", "pre", "blockquote", "ul", "ol", "li", "a", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "sup", "sub", "kbd", "span"];
  const ALLOWED_ATTR = ["href", "title", "class", "align", "colspan", "rowspan", "start"];

  /**
   * @param {{ marked: object, DOMPurify: object, hljs?: object, doc?: Document, onOpenLink?: (url:string)=>void, copyText?: (text:string)=>Promise<boolean> }} deps
   */
  function createRenderer(deps) {
    const { marked, hljs } = deps;
    const doc = deps.doc || document;
    const purify = typeof deps.DOMPurify === "function" && !deps.DOMPurify.sanitize ? deps.DOMPurify(doc.defaultView) : deps.DOMPurify;
    const onOpenLink = deps.onOpenLink || (() => {});
    const copyText = deps.copyText || defaultCopy;

    const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
    const md = new marked.Marked({ gfm: true, breaks: true });
    md.use({
      renderer: {
        // raw HTML typed into a reply is text, not markup
        html(token) {
          return esc(token.text || token.raw || "");
        },
        // never fetch a remote image; show what the model said it was
        image(token) {
          return esc(token.text || "");
        },
        checkbox(token) {
          return token.checked ? "☑ " : "☐ ";
        },
      },
    });

    // `class` is only allowed as language-xxx on <code>: reply text must not be able to borrow the panel's own styles
    purify.addHook("uponSanitizeAttribute", (node, data) => {
      if (data.attrName === "class") {
        const ok = node.nodeName === "CODE" && /^language-[\w+#.-]{1,30}$/.test(data.attrValue);
        if (!ok) data.keepAttr = false;
      }
    });

    function sanitize(html) {
      // DOMPurify validates EVERY attribute value that is not on its "URI-safe" list against ALLOWED_URI_REGEXP; with the strict
      // http(s)-only pattern below, harmless values like align="right" or start="3" would be dropped as "not a URL" - so the
      // plain presentational ones are declared URI-safe. (href is still held to http(s).)
      return purify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ADD_URI_SAFE_ATTR: ["align", "colspan", "rowspan", "start"], ALLOWED_URI_REGEXP: /^https?:/i, KEEP_CONTENT: true, RETURN_DOM_FRAGMENT: true });
    }

    function highlightBlock(raw, lang) {
      if (!hljs) return { html: null, label: lang ? prettyLang(lang) : "Code", id: lang };
      const id = HLJS_ALIAS[String(lang).toLowerCase()] || String(lang).toLowerCase();
      try {
        if (lang && hljs.getLanguage(id)) {
          const r = hljs.highlight(raw, { language: id, ignoreIllegals: true });
          return { html: r.value, label: prettyLang(lang), id };
        }
        if (!lang && raw.length <= 8000) {
          const r = hljs.highlightAuto(raw, AUTO_SUBSET.filter((l) => hljs.getLanguage(l)));
          // a short snippet scores low even when the guess is right (a one-line SQL query scores exactly 5), so the bar is
          // "some real evidence AND clearly ahead of the runner-up", not a high absolute score - otherwise plain text
          // (which scores ~0-2 everywhere) stays unlabelled but real code does not.
          const second = r.secondBest ? r.secondBest.relevance : 0;
          if (r.language && r.relevance >= 5 && r.relevance > second) return { html: r.value, label: prettyLang(r.language), id: r.language };
        }
      } catch (_) {
        /* fall through to plain text */
      }
      return { html: null, label: lang ? prettyLang(lang) : "Code", id: lang };
    }

    function enhance(frag) {
      for (const pre of Array.from(frag.querySelectorAll("pre"))) {
        const code = pre.querySelector("code");
        const raw = (code || pre).textContent.replace(/\n$/, "");
        const lang = ((code && /(?:^|\s)language-([\w+#.-]+)/.exec(code.className)) || [])[1] || "";
        const { html, label } = highlightBlock(raw, lang);

        const card = doc.createElement("div");
        card.className = "codeblock";
        const head = doc.createElement("div");
        head.className = "codeblock-head";
        const tag = doc.createElement("span");
        tag.className = "codeblock-lang";
        tag.textContent = label;
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.className = "codeblock-copy";
        btn.textContent = "Copy";
        btn.setAttribute("aria-label", `Copy ${label} code`);
        btn.addEventListener("click", async () => {
          const ok = await copyText(raw);
          btn.textContent = ok ? "Copied!" : "Copy failed";
          btn.classList.toggle("copied", !!ok);
          setTimeout(() => {
            btn.textContent = "Copy";
            btn.classList.remove("copied");
          }, 1600);
        });
        head.append(tag, btn);

        const body = doc.createElement("pre");
        const inner = doc.createElement("code");
        inner.className = "hljs" + (lang ? ` language-${lang}` : "");
        if (html != null) inner.innerHTML = html; // highlight.js escapes the source; this is generated from textContent, never from reply HTML
        else inner.textContent = raw;
        body.appendChild(inner);
        card.append(head, body);
        pre.replaceWith(card);
      }
      for (const t of Array.from(frag.querySelectorAll("table"))) {
        const wrap = doc.createElement("div");
        wrap.className = "table-wrap";
        t.replaceWith(wrap);
        wrap.appendChild(t);
      }
      for (const a of Array.from(frag.querySelectorAll("a[href]"))) {
        a.setAttribute("rel", "noopener noreferrer");
        a.setAttribute("target", "_blank");
        a.addEventListener("click", (e) => {
          e.preventDefault();
          onOpenLink(a.href);
        });
      }
    }

    /** @returns {HTMLElement} a <div class="md"> ready to append */
    function render(text) {
      const root = doc.createElement("div");
      root.className = "md";
      const src = fenceLooseCode(String(text == null ? "" : text));
      let html;
      try {
        html = md.parse(src);
      } catch (_) {
        root.textContent = String(text);
        return root;
      }
      const frag = sanitize(html);
      enhance(frag);
      root.appendChild(frag);
      return root;
    }

    return { render };
  }

  function defaultCopy(text) {
    const legacy = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch (_) {
        return false;
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, () => legacy());
    return Promise.resolve(legacy());
  }

  return { createRenderer, fenceLooseCode, prettyLang, LANG_LABELS };
});
