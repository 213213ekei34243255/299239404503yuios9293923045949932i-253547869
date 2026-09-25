// Noah/models/code-compose.cjs
//
// "Write a program of palindromes on the page code snippet": the code half of models/compose.cjs.
//
// Two facts about code editors (measured on online-python.com, which uses Ace) shape everything here:
//   * typing code KEY BY KEY into them corrupts it: live autocomplete swallows Enter/Tab and auto-indent doubles the
//     indentation ("def is_palindrome(n)def    s = str(nsum ..."). One Input.insertText leaves the code exactly as written,
//     so code is always inserted in one go (type action, mode "insert").
//   * the editor is not in the accessibility tree (its input is a 1x1 hidden textarea), so perception adds it
//     (perception/observer.cjs _addCodeEditors) and the composer clicks that.

"use strict";

/** Code that fits in one `type` action (protocol MAX_TEXT is 5000). */
const MAX_CODE = 4800;

const CODE_NOUN = /\b(program|programme|code|snippet|function|class|algorithm|python|javascript|typescript|java|golang|rust|php|ruby|sql|html|css|bash)\b/i;
const PROSE_NOUN = /\b(story|essay|poem|letter|lyrics|blog|article|paragraphs?|summary|song)\b/i;

/** Is this a request for CODE (as opposed to prose)? */
function isCodeRequest(text) {
  const t = String(text || "");
  return CODE_NOUN.test(t) && !PROSE_NOUN.test(t);
}

const LANGUAGES = [
  ["javascript", "JavaScript"], ["typescript", "TypeScript"], ["python", "Python"], ["java", "Java"], ["c++", "C++"], ["c#", "C#"],
  ["golang", "Go"], ["rust", "Rust"], ["php", "PHP"], ["ruby", "Ruby"], ["sql", "SQL"], ["html", "HTML"], ["css", "CSS"], ["bash", "Bash"],
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The language: named in the request, else in the page (title / url: "Online Python"), else Python. */
function languageFor(...sources) {
  for (const src of sources) {
    const t = String(src || "").toLowerCase();
    if (!t) continue;
    for (const [key, label] of LANGUAGES) {
      if (new RegExp("(?:^|[^a-z0-9+#])" + escapeRe(key) + "(?![a-z0-9+#])").test(t)) return label;
    }
  }
  return "Python";
}

/** "do me a favour write a whole big program of X on the page code snippet" -> "X" */
function taskFrom(request) {
  let t = String(request || "");
  t = t.replace(/^\s*noah\s*[,:]\s*/i, "");
  t = t.replace(/\b(?:do me a favou?r|okay|ok|please|can you|you can|just)\b/gi, " ");
  t = t.replace(/\b(?:on|in|into|onto|at)\s+(?:this|the|that|my)\s+(?:page\s+)?(?:code\s+)?(?:snippet|editor|page|ide|compiler|playground|window|screen|tab)\b/gi, " ");
  t = t.replace(/^\s*(?:write|create|make|generate|type|code)\s+(?:me\s+)?(?:a|an|the|some)?\s*(?:(?:whole|big|complete|full|long|short|simple|small)\s+)*(?:program|programme|code|snippet|function|script)?\s*(?:of|for|to|that|which|about)?\s*/i, "");
  t = t.replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "");
  return t || String(request || "").trim().slice(0, 300);
}

const PLAIN = "Reply with only the code: no explanation, no text before or after it.";

/**
 * The requests for the code, best first: [{ message, page }]. Shaped like the ones measured against the live hosted model:
 * a plain "Write ..." message, the language named, the "page" a short description of an empty editor. (The hosted chat mode
 * answers a message that quotes a long passage with {"needs_web_search": true}, so nothing is quoted.)
 * For a continuation the code so far is the page.
 */
function codePromptsFor({ request, language, existing, continuation }) {
  const page = `An online ${language} code editor with an empty file.`;
  if (continuation) {
    const so_far = String(existing || "").trim().slice(-1500).replace(/^\S*\s/, "");
    return [
      { message: `Write more ${language} code to extend the program on this page. ${PLAIN}`, page: so_far || page },
      { message: `Write another ${language} function for the program on this page. ${PLAIN}`, page: so_far || page },
    ];
  }
  const task = taskFrom(request);
  return [
    { message: `Write a complete ${language} program: ${task}. ${PLAIN}`, page },
    { message: `Write ${language} code for this: ${task}. ${PLAIN}`, page },
  ];
}

/** What the chat model returned -> just the code (the model wraps it in a markdown fence even when told not to). */
function cleanGeneratedCode(raw) {
  let t = String(raw || "").replace(/\r/g, "");
  const fenced = /```[\w+#.-]*[ \t]*\n([\s\S]*?)(?:```|$)/.exec(t);
  if (fenced) t = fenced[1];
  else t = t.replace(/^(?:sure|certainly|of course|okay|ok|absolutely|here(?:'s| is| are))[^\n]*\n+/i, "");
  t = t.replace(/\s+$/, "");
  if (t.length > MAX_CODE) {
    // cut at a line boundary so the code does not end in the middle of a statement
    const cut = t.slice(0, MAX_CODE);
    t = cut.slice(0, Math.max(cut.lastIndexOf("\n"), 1));
  }
  return t;
}

/**
 * Does this look like real, usable code? Cheap checks aimed at the ways the small hosted model fails: a refusal or JSON
 * instead of code, prose, and (Python) a def/class line that is not even valid ("def is tribonacci(n)").
 */
function looksLikeCode(text, language) {
  const t = String(text || "");
  if (/needs_web_search|needs_page_content|search_query|"answer"\s*:/.test(t)) return false;
  const lines = t.split("\n").filter((l) => l.trim());
  if (lines.length < 3 || t.length < 60) return false;
  const codey = lines.filter((l) => /[=(){}[\]:;<>]|^\s*(?:def|class|import|from|function|const|let|var|public|int|for|while|if|return|print|#include)\b/.test(l)).length;
  if (codey / lines.length < 0.6) return false;
  if (language === "Python") {
    for (const l of lines) {
      if (/^\s*def\s/.test(l) && !/^\s*def\s+[A-Za-z_]\w*\s*\(.*\)\s*(?:->\s*[^:]+)?:\s*(?:#.*)?$/.test(l)) return false;
      if (/^\s*class\s/.test(l) && !/^\s*class\s+[A-Za-z_]\w*\s*(?:\(.*\))?\s*:/.test(l)) return false;
    }
  }
  return true;
}

module.exports = { MAX_CODE, isCodeRequest, languageFor, taskFrom, codePromptsFor, cleanGeneratedCode, looksLikeCode };
