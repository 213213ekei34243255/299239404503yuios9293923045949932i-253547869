"use strict";
// Tier A scenarios (part 2): difficult (canvas, drag-and-drop, hidden-input editors, modals) and recovery.
// SIMULATIONS: the canvas/editor pages imitate interaction patterns of Docs/Sheets/Figma-class apps.
// They are not those products; results say nothing about compatibility with the real applications.

const has = (s, sub) => String(s).includes(sub);

// The "vision model" oracle: emits screenshot-space coordinates for a page-space point, using the
// geometry of the frame it was shown. Everything after this goes through the real mapping chain.
const shotPt = (ctx, x, y) => ctx.toShot(x, y);

module.exports = [
  // ================================================================ DIFFICULT
  {
    id: "D1", category: "difficult", name: "canvas app: drag a shape into the drop zone by coordinates",
    async run(ctx) {
      await ctx.open("/canvas");
      const obs = await ctx.observe({ screenshot: true });
      const from = shotPt(ctx, 105, 85); // centre of shape A
      const to = shotPt(ctx, 495, 165); // centre of the drop zone
      const r = await ctx.act({ action: "drag", from: { type: "coordinate", x: from.x, y: from.y }, to: { type: "coordinate", x: to.x, y: to.y } });
      const s = await ctx.page("window.__canvas.shapes.find(s=>s.id==='A')");
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      const inZone = cx >= 400 && cx <= 590 && cy >= 110 && cy <= 220;
      return { pass: r.ok && inZone && obs.hints.preferVision, details: `drag ok=${r.ok} (${r.verification && r.verification.summary}); shape centre=(${Math.round(cx)},${Math.round(cy)}) inZone=${inZone}; visionHint=${obs.hints.preferVision} [${obs.hints.reasons.join("; ")}]`, metrics: { hint: obs.hints.preferVision } };
    },
  },
  {
    id: "D2", category: "difficult", name: "canvas app: double-click, right-click context menu drawn on canvas",
    async run(ctx) {
      await ctx.open("/canvas");
      await ctx.observe({ screenshot: true });
      const b = shotPt(ctx, 285, 85);
      const d = await ctx.act({ action: "double_click", target: { type: "coordinate", x: b.x, y: b.y } });
      const dbl = await ctx.page("window.__canvas.dblclicked");
      ctx.core.browser.frame = { ...ctx.core.browser.frame, stale: false };
      const c = shotPt(ctx, 110, 205);
      const rc = await ctx.act({ action: "right_click", target: { type: "coordinate", x: c.x, y: c.y } });
      const menu = await ctx.page("window.__canvas.menu");
      await ctx.observe({ screenshot: true });
      const dup = shotPt(ctx, menu.x + 30, menu.y + 22);
      const m = await ctx.act({ action: "click", target: { type: "coordinate", x: dup.x, y: dup.y } });
      const shapes = await ctx.page("window.__canvas.shapes.map(s=>s.id)");
      return { pass: d.ok && dbl.includes("B") && rc.ok && menu && m.ok && shapes.includes("C2"), details: `dbl=${JSON.stringify(dbl)} menu=${JSON.stringify(menu)} shapes=${shapes} verdicts=${d.verification && d.verification.verdict}/${rc.verification && rc.verification.verdict}/${m.verification && m.verification.verdict}` };
    },
  },
  {
    id: "D3", category: "difficult", name: "canvas app: select a shape, then move it with arrow keys",
    async run(ctx) {
      await ctx.open("/canvas");
      await ctx.observe({ screenshot: true });
      const p = shotPt(ctx, 285, 85);
      await ctx.act({ action: "click", target: { type: "coordinate", x: p.x, y: p.y } });
      const before = await ctx.page("window.__canvas.shapes.find(s=>s.id==='B').x");
      const k = await ctx.act({ action: "key_press", key: "ArrowRight", repeat: 3 });
      const after = await ctx.page("window.__canvas.shapes.find(s=>s.id==='B').x");
      return { pass: k.ok && after - before === 30, details: `x ${before} -> ${after}` };
    },
  },
  {
    id: "D4", category: "difficult", name: "Docs-like editor: type into a hidden-input canvas editor, select all, copy, paste, save via canvas menu",
    async run(ctx) {
      await ctx.open("/docs");
      const obs = await ctx.observe({ screenshot: true });
      const doc = shotPt(ctx, 300, 200);
      await ctx.act({ action: "click", target: { type: "coordinate", x: doc.x, y: doc.y }, expect: { no_effect_ok: true } });
      const t = await ctx.act({ action: "type", text: "Hello Noah" });
      const text1 = await ctx.page("window.__doc.getText()");
      const sel = await ctx.act({ action: "select_all" });
      const cp = await ctx.act({ action: "copy" });
      await ctx.act({ action: "key_press", key: "ArrowRight" });
      const ps = await ctx.act({ action: "paste" });
      const text2 = await ctx.page("window.__doc.getText()");
      // menus drawn on the canvas: File -> Save (all by coordinates)
      await ctx.observe({ screenshot: true });
      const file = shotPt(ctx, 30, 30);
      const f = await ctx.act({ action: "click", target: { type: "coordinate", x: file.x, y: file.y } });
      const open = await ctx.page("window.__doc.menuOpen");
      await ctx.observe({ screenshot: true });
      const save = shotPt(ctx, 40, 82);
      const sv = await ctx.act({ action: "click", target: { type: "coordinate", x: save.x, y: save.y } });
      const saved = await ctx.page("window.__doc.saved");
      // clear and multi-line
      await ctx.act({ action: "hotkey", keys: ["ctrl", "a"] });
      await ctx.act({ action: "key_press", key: "Backspace" });
      const cleared = await ctx.page("window.__doc.getText()");
      await ctx.act({ action: "type", text: "line1\nline2" });
      const multi = await ctx.page("window.__doc.getText()");
      const ok = t.ok && text1 === "Hello Noah" && cp.ok && ps.ok && text2 === "Hello NoahHello Noah" && f.ok && open === true && saved === true && cleared === "" && multi === "line1\nline2";
      return { pass: ok, details: `typed=${JSON.stringify(text1)} afterPaste=${JSON.stringify(text2)} menuOpen=${open} saved=${saved} cleared=${JSON.stringify(cleared)} multi=${JSON.stringify(multi)} vision=${obs.hints.preferVision}` };
    },
  },
  {
    id: "D5", category: "difficult", name: "Sheets-like grid: select cells by coordinates, enter values, Tab/Enter, save",
    async run(ctx) {
      await ctx.open("/sheet");
      await ctx.observe({ screenshot: true });
      const L = await ctx.page("window.__sheet.layout");
      const cell = (col, row) => shotPt(ctx, L.X0 + col * L.CW + L.CW / 2, L.Y0 + row * L.RH + L.RH / 2);
      const click = async (p) => ctx.act({ action: "click", target: { type: "coordinate", x: p.x, y: p.y }, expect: { no_effect_ok: true } });
      await click(cell(1, 1)); // B2
      await ctx.act({ action: "type", text: "42" });
      await ctx.act({ action: "key_press", key: "Enter" });
      ctx.core.browser.frame = { ...ctx.core.browser.frame, stale: false };
      await click(cell(2, 2)); // C3
      await ctx.act({ action: "type", text: "Total" });
      await ctx.act({ action: "key_press", key: "Tab" });
      await ctx.act({ action: "type", text: "99" });
      ctx.core.browser.frame = { ...ctx.core.browser.frame, stale: false };
      const w = await ctx.page("window.innerWidth");
      const save = shotPt(ctx, w - 65, 26);
      await click(save);
      const st = await ctx.page("({cells: window.__sheet.cells, saved: window.__sheet.saved})");
      return { pass: st.cells.B2 === "42" && st.cells.C3 === "Total" && st.cells.D3 === "99" && st.saved === true, details: JSON.stringify(st) };
    },
  },
  {
    id: "D6", category: "difficult", name: "HTML5 drag-and-drop between columns (text targets, no AX role)",
    async run(ctx) {
      await ctx.open("/dnd");
      const r = await ctx.act({ action: "drag", from: { text: "Task A" }, to: { text: "Done" } });
      const moved = await ctx.page("window.__dnd.moved");
      const inDone = await ctx.page("!!document.querySelector('#done #ta')");
      return { pass: r.ok && inDone && moved.includes("ta->done"), details: `${r.message} moved=${JSON.stringify(moved)}` };
    },
  },
  {
    id: "D7", category: "difficult", name: "modal dialog: only its contents are listed; controls behind it are refused",
    async run(ctx) {
      await ctx.open("/dynamic?scenario=modal");
      await ctx.act({ action: "click", target: { text: "Open settings" } });
      const obs = await ctx.observe({});
      const { selectForModel } = require("../../perception/ax.cjs");
      const sel = selectForModel(obs.elements, { viewport: obs.viewport });
      const listing = sel.lines.join("\n");
      // aria-modal alone does not physically block the page, so a click "behind" it is still deliverable;
      // what Noah guarantees is that the model is shown (and steered toward) the modal's own controls.
      const save = await ctx.act({ action: "click", target: { text: "Save settings" } });
      const out = await ctx.page("document.getElementById('out').textContent");
      return { pass: sel.hidden.modal && has(listing, "Save settings") && !has(listing, "Open settings") && save.ok && out === "saved", details: `modal=${sel.hidden.modal} listing=${JSON.stringify(sel.lines)} out=${out}` };
    },
  },
  {
    id: "D8", category: "difficult", name: "vision-mode hint: canvas pages prefer vision, normal pages do not",
    async run(ctx) {
      await ctx.open("/canvas");
      const a = await ctx.observe({});
      await ctx.open("/search?q=laptop");
      const b = await ctx.observe({});
      await ctx.open("/docs");
      const c = await ctx.observe({});
      return { pass: a.hints.preferVision && !b.hints.preferVision && c.hints.preferVision, details: `canvas=${a.hints.preferVision} [${a.hints.reasons}] shop=${b.hints.preferVision} docs=${c.hints.preferVision}` };
    },
  },
  {
    id: "D9", category: "difficult", name: "JS dialog: click opens confirm(); page is not hung; handle_dialog resolves it",
    async run(ctx) {
      await ctx.open("/dialog");
      const t0 = Date.now();
      const r = await ctx.act({ action: "click", target: { text: "Ask me" } });
      const took = Date.now() - t0;
      const obs = await ctx.observe({});
      const h = await ctx.act({ action: "handle_dialog", accept: true });
      await ctx.sleep(150);
      const out = await ctx.page("document.getElementById('out').textContent");
      return { pass: r.ok && took < 5000 && obs.dialog && obs.dialog.type === "confirm" && h.ok && out === "answer=true", details: `click ${took}ms dialog=${JSON.stringify(obs.dialog && obs.dialog.type)} out=${out}` };
    },
  },
  {
    id: "D10", category: "difficult", name: "login: Noah refuses to type a password; after the user types it, Noah continues and downloads the invoice",
    async run(ctx) {
      await ctx.open("/login");
      const u = await ctx.act({ action: "type", target: { text: "User" }, text: "demo" });
      const pw = await ctx.act({ action: "type", target: { text: "Password" }, text: "hunter2" });
      const pwLen = await ctx.page("document.querySelector('input[type=password]').value.length");
      // the human types the password themselves (real input into the page, outside Noah)
      const wc = await ctx.guest();
      await wc.executeJavaScript("document.querySelector('input[type=password]').focus()", true);
      wc.insertText("s3cret");
      await ctx.sleep(80);
      const login = await ctx.act({ action: "click", target: { text: "Sign in" } });
      let url = await ctx.page("location.pathname");
      for (let i = 0; i < 30 && url !== "/account"; i++) { // POST -> 302 -> GET can take a moment
        await ctx.sleep(100);
        url = await ctx.page("location.pathname");
      }
      const dl = await ctx.act({ action: "download_file", target: { text: "Invoice #1042" } });
      const fs = require("fs");
      const got = fs.existsSync(require("path").join(ctx.dlDir, "invoice-1042.pdf"));
      return { pass: u.ok && !pw.ok && pw.code === "policy_blocked" && pwLen === 0 && login.ok && url === "/account" && dl.ok && got, details: `password blocked=${pw.code} typedLen=${pwLen} afterLogin=${url} invoice=${got}` };
    },
  },

  // ================================================================ RECOVERY
  {
    id: "R1", category: "recovery", name: "element moved after the screenshot: stale click is detected; re-observe + ref click succeeds",
    async run(ctx) {
      await ctx.open("/dynamic?scenario=move");
      await ctx.observe({ screenshot: true });
      const old = await ctx.page("(()=>{const r=document.getElementById('mover').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()");
      await ctx.page("window.__move()"); // the layout shifts AFTER the model saw the screenshot
      await ctx.sleep(250);
      const p = shotPt(ctx, old.x, old.y);
      const stale = await ctx.act({ action: "click", target: { type: "coordinate", x: p.x, y: p.y } });
      const out1 = await ctx.page("document.getElementById('out').textContent");
      // recovery: fresh observation, ref-based click
      const obs = await ctx.observe({ screenshot: true });
      const ref = obs.elements.find((e) => e.name === "Move Me");
      const ok = await ctx.act({ action: "click", target: { ref: ref.ref } });
      const out2 = await ctx.page("document.getElementById('out').textContent");
      return { pass: !stale.ok && stale.code === "no_effect" && out1 === "idle" && ok.ok && out2 === "moved clicked", details: `stale click ok=${stale.ok} code=${stale.code} summary=${stale.verification && stale.verification.summary} old=(${Math.round(old.x)},${Math.round(old.y)}) -> after recovery: ${out2}` };
    },
  },
  {
    id: "R2", category: "recovery", name: "popup overlay appears and intercepts clicks: 'obscured' is reported; closing it unblocks",
    async run(ctx) {
      await ctx.open("/dynamic?scenario=popup");
      const first = await ctx.act({ action: "click", target: { text: "Click me" } });
      await ctx.sleep(1300); // overlay appears at 900ms
      const blocked = await ctx.act({ action: "click", target: { text: "Click me" } });
      const close = await ctx.act({ action: "click", target: { text: "Close" } });
      const again = await ctx.act({ action: "click", target: { text: "Click me" } });
      const out = await ctx.page("document.getElementById('out').textContent");
      return { pass: first.ok && !blocked.ok && blocked.code === "obscured" && close.ok && again.ok && out === "clicked 2", details: `blocked=${blocked.code}: ${blocked.message && blocked.message.slice(0, 120)} final=${out}` };
    },
  },
  {
    id: "R3", category: "recovery", name: "cookie banner covers a control: choose the privacy-preserving option, then continue",
    async run(ctx) {
      await ctx.open("/dynamic?scenario=banner");
      const blocked = await ctx.act({ action: "click", target: { text: "Continue" } });
      const rej = await ctx.act({ action: "click", target: { text: "Reject non-essential" } });
      const cont = await ctx.act({ action: "click", target: { text: "Continue" } });
      const out = await ctx.page("document.getElementById('out').textContent");
      return { pass: !blocked.ok && rej.ok && cont.ok && out === "continue clicked", details: `blocked=${blocked.code} reject=${rej.ok} out=${out}` };
    },
  },
  {
    id: "R4", category: "recovery", name: "stale ref after navigation: clear error telling the model to re-read; fresh refs work",
    async run(ctx) {
      await ctx.open("/");
      const obs = await ctx.observe({});
      const btn = obs.elements.find((e) => e.name === "Search" && e.role === "button");
      await ctx.open("/form");
      const stale = await ctx.act({ action: "click", target: { ref: btn.ref } });
      const obs2 = await ctx.observe({});
      const reg = obs2.elements.find((e) => e.name === "Register");
      const ok = await ctx.act({ action: "click", target: { ref: reg.ref }, expect: { no_effect_ok: true } });
      return { pass: !stale.ok && /unknown|stale/.test(stale.message) && /read_page/.test(stale.message) && ok.ok, details: `${stale.code}: ${stale.message}` };
    },
  },
  {
    id: "R5", category: "recovery", name: "network failure and slow page: net_error surfaced; timeout flagged; server 500 page still readable",
    async run(ctx) {
      const r = await ctx.act({ action: "navigate", url: ctx.server.url("/reset") });
      const e500 = await ctx.act({ action: "navigate", url: ctx.server.url("/status/500") });
      const title500 = await ctx.page("document.title");
      const slow = await ctx.core.browser.navigate(ctx.server.url("/slow"), { timeoutMs: 800 });
      await ctx.sleep(3200);
      const done = await ctx.page("document.title");
      const good = await ctx.act({ action: "navigate", url: ctx.server.url("/") });
      return { pass: !r.ok && r.code === "net_error" && e500.ok && has(title500, "Error") && slow.timedOut === true && done === "Slow page" && good.ok, details: `reset=${r.code}: ${r.message && r.message.slice(0, 90)} | 500 title=${title500} | slow timedOut=${slow.timedOut} later=${done} | recovered=${good.ok}` };
    },
  },
  {
    id: "R6", category: "recovery", name: "no-effect click ladder: pointer click does nothing, DOM click recovers",
    async run(ctx) {
      await ctx.open("/fragile");
      const r = await ctx.act({ action: "click", target: { text: "Styled Link" } });
      const out = await ctx.page("document.getElementById('out').textContent");
      return { pass: r.ok && r.method === "dom" && out === "dom-click-worked", details: `method=${r.method} out=${out} verdict=${r.verification && r.verification.verdict}` };
    },
  },
  {
    id: "R7", category: "recovery", name: "coordinate click after the page scrolled is refused as stale (blind batch protection)",
    async run(ctx) {
      await ctx.open("/scroll");
      await ctx.observe({ screenshot: true });
      const s = await ctx.act({ action: "scroll", direction: "down", amount: 400 });
      const p = shotPt(ctx, 300, 300); // uses the frame captured BEFORE the scroll
      const c = await ctx.act({ action: "click", target: { type: "coordinate", x: p.x, y: p.y } });
      return { pass: s.ok && !c.ok && c.code === "stale_frame", details: `scroll ok=${s.ok}; click code=${c.code}: ${c.message && c.message.slice(0, 100)}` };
    },
  },
  {
    id: "R8", category: "recovery", name: "coordinates without any screenshot are refused with guidance",
    async run(ctx) {
      await ctx.open("/pointer");
      const c = await ctx.act({ action: "click", target: { type: "coordinate", x: 100, y: 100 } });
      return { pass: !c.ok && c.code === "no_frame" && /screenshot/.test(c.message), details: `${c.code}: ${c.message}` };
    },
  },
  {
    id: "R9", category: "recovery", name: "ambiguous text target is reported with candidate refs instead of guessing",
    async run(ctx) {
      await ctx.open("/search?q=laptop");
      const r = await ctx.act({ action: "click", target: { text: "Add to cart" } });
      return { pass: !r.ok && r.code === "ambiguous" && r.candidates && r.candidates.length >= 2, details: `${r.code}: ${r.message}; candidates=${JSON.stringify((r.candidates || []).slice(0, 3))}` };
    },
  },
];
