"use strict";
// Tier A scenarios (part 1): deterministic, no model. Simple, intermediate, coordinate mapping.
//
// Each scenario plays the *decision layer* with hand-written logic that uses only what the agent's
// perception returns (refs, names, screenshots). Page state is read through the `ctx.page` oracle purely
// to ASSERT outcomes; the agent never gets that channel.

const fs = require("fs");
const path = require("path");
const has = (list, s) => list.some((x) => x.includes(s));
const interactive = (obs) => obs.elements.filter((e) => e.interactive).map((e) => `${e.role}:${e.name}`);

module.exports = [
  // ============================================================ SIMPLE
  {
    id: "S1", category: "simple", name: "navigate and observe the home page (AX tree + refs)",
    async run(ctx) {
      await ctx.open("/");
      const obs = await ctx.observe({});
      const el = interactive(obs);
      const ok = obs.title === "Fixture Home" && has(el, "textbox:Search products") && has(el, "button:Search") && el.length >= 6;
      return { pass: ok, details: `title=${obs.title} interactive=${JSON.stringify(el)}`, metrics: { observeMs: obs.timing.totalMs, axNodes: obs.accessibilityTree.nodeCount, interactive: el.length } };
    },
  },
  {
    id: "S2", category: "simple", name: "type into a field by text target and submit with Enter",
    async run(ctx) {
      await ctx.open("/");
      const r = await ctx.act({ action: "type", target: { text: "Search products" }, text: "laptop", submit: true });
      const url = await ctx.page("location.href");
      return { pass: r.ok && url.includes("/search?q=laptop"), details: `${r.message} | url=${url} | verdict=${r.verification && r.verification.verdict}` };
    },
  },
  {
    id: "S3", category: "simple", name: "click a search button, then a result link (ref targets)",
    async run(ctx) {
      await ctx.open("/");
      await ctx.act({ action: "type", target: { text: "Search products" }, text: "laptop" });
      const r1 = await ctx.act({ action: "click", target: { text: "Search" } });
      const r2 = await ctx.act({ action: "click", target: { text: "Acme Air 14" } });
      const url = await ctx.page("location.href");
      return { pass: r1.ok && r2.ok && url.endsWith("/product/1"), details: `${r1.message} / ${r2.message} / url=${url}` };
    },
  },
  {
    id: "S4", category: "simple", name: "scroll with the mouse wheel to the end of a long page",
    async run(ctx) {
      await ctx.open("/scroll");
      let last = 0;
      let steps = 0;
      let atEdge = false;
      for (let i = 0; i < 60; i++) {
        const r = await ctx.act({ action: "scroll", direction: "down", amount: "page" });
        steps++;
        const y = await ctx.page("window.scrollY");
        if (!r.ok) return { pass: false, details: r.message };
        if (y === last) {
          atEdge = r.verification && r.verification.verdict === "at_edge";
          break;
        }
        last = y;
      }
      const end = await ctx.page("document.getElementById('end').getBoundingClientRect().top < innerHeight");
      return { pass: last > 3000 && end && atEdge, details: `scrollY=${last} endVisible=${end} atEdgeReported=${atEdge} steps=${steps}`, metrics: { steps } };
    },
  },
  {
    id: "S5", category: "simple", name: "navigate, back, forward keep tab state consistent",
    async run(ctx) {
      await ctx.open("/");
      await ctx.act({ action: "navigate", url: ctx.server.url("/form") });
      const back = await ctx.act({ action: "back" });
      const u1 = await ctx.page("location.pathname");
      const fwd = await ctx.act({ action: "forward" });
      const u2 = await ctx.page("location.pathname");
      return { pass: back.ok && fwd.ok && u1 === "/" && u2 === "/form", details: `back->${u1} forward->${u2}` };
    },
  },

  // ============================================================ INTERMEDIATE
  {
    id: "I1", category: "intermediate", name: "read page text and extract product data (find information)",
    async run(ctx) {
      await ctx.open("/search?q=laptop");
      const r = await ctx.act({ action: "read_page", filter: "text" });
      const text = r.data.text;
      const prices = [...text.matchAll(/₹([\d,]+)\s*·\s*(\d+)GB/g)].map((m) => ({ price: +m[1].replace(/,/g, ""), ram: +m[2] }));
      const cheap16 = prices.filter((p) => p.ram === 16).sort((a, b) => a.price - b.price)[0];
      return { pass: r.ok && prices.length === 12 && cheap16 && cheap16.price === 61999, details: `parsed ${prices.length} products; cheapest 16GB = ${cheap16 && cheap16.price}` };
    },
  },
  {
    id: "I2", category: "intermediate", name: "fill a form: text, select, checkbox, radio, textarea, submit",
    async run(ctx) {
      await ctx.open("/form");
      const steps = [
        { action: "type", target: { text: "Full name" }, text: "Ada Lovelace" },
        { action: "type", target: { text: "Email" }, text: "ada@example.com" },
        { action: "form_input", target: { text: "Country" }, value: "Spain" },
        { action: "click", target: { text: "I agree to the terms" } },
        { action: "click", target: { text: "Pro" } },
        { action: "type", target: { text: "Notes" }, text: "Line one\nLine two" },
        { action: "click", target: { text: "Register" } },
      ];
      const results = [];
      for (const s of steps) {
        const r = await ctx.act(s);
        results.push(`${s.action}:${r.ok ? "ok" : r.message}`);
        if (!r.ok) return { pass: false, details: results.join(" | ") };
      }
      const sub = await ctx.page("window.__submitted");
      const ok = sub && sub.name === "Ada Lovelace" && sub.email === "ada@example.com" && sub.country === "es" && sub.agree === "on" && sub.plan === "pro" && sub.notes === "Line one\nLine two";
      return { pass: !!ok, details: JSON.stringify(sub), metrics: { actions: steps.length } };
    },
  },
  {
    id: "I3", category: "intermediate", name: "form validation error is observable, then corrected",
    async run(ctx) {
      await ctx.open("/form");
      await ctx.act({ action: "type", target: { text: "Email" }, text: "not-an-email" });
      const r = await ctx.act({ action: "click", target: { text: "Register" }, expect: { text_visible: "Invalid email" } });
      const err = await ctx.page("document.getElementById('email-err').textContent");
      await ctx.act({ action: "type", target: { text: "Email" }, text: "ok@example.com", clear: true });
      const r2 = await ctx.act({ action: "click", target: { text: "Register" }, expect: { text_visible: "Registered" } });
      return { pass: r.ok && err === "Invalid email" && r2.ok, details: `first=${r.message} err=${err} second=${r2.ok}` };
    },
  },
  {
    id: "I4", category: "intermediate", name: "multi-tab: new tab, switch by natural-language query, find tab",
    async run(ctx) {
      await ctx.open("/");
      const n = await ctx.act({ action: "new_tab", url: ctx.server.url("/product/2") });
      const tabs = await ctx.core.tabs.list(0);
      const s = await ctx.act({ action: "switch_tab", query: "the tab where I had the home page open" });
      const homeUrl = await ctx.page("location.pathname");
      const found = ctx.core.tabs.find("zenbook");
      const s2 = await ctx.act({ action: "switch_tab", query: "zenbook" });
      const prodUrl = await ctx.page("location.pathname");
      const closedOk = (await ctx.act({ action: "close_tab" })).message; // Noah opened it => owned => no confirmation
      return { pass: n.ok && tabs.length === 2 && s.ok && homeUrl === "/" && found.length === 1 && s2.ok && prodUrl === "/product/2", details: `tabs=${tabs.length} home=${homeUrl} product=${prodUrl} closed=${closedOk}` };
    },
  },
  {
    id: "I5", category: "intermediate", name: "download a file (allowed) and refuse an executable (blocked)",
    async run(ctx) {
      await ctx.open("/download");
      const r = await ctx.act({ action: "download_file", target: { text: "Download report" } });
      const file = path.join(ctx.dlDir, "report.pdf");
      const exists = fs.existsSync(file);
      const bad = await ctx.act({ action: "download_file", target: { text: "Download installer" } });
      const exe = fs.existsSync(path.join(ctx.dlDir, "setup.exe"));
      return { pass: r.ok && exists && !bad.ok && !exe && bad.code === "policy_blocked", details: `report ok=${r.ok} exists=${exists}; installer ok=${bad.ok} code=${bad.code} written=${exe} (${bad.message})` };
    },
  },
  {
    id: "I6", category: "intermediate", name: "file upload needs confirmation; protected paths are refused",
    async run(ctx) {
      await ctx.open("/upload");
      // Outside Jonah's own data dir (ctx.tmp), which is a protected location by design.
      const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "noah-up-"));
      const f = path.join(dir, "resume.txt");
      fs.writeFileSync(f, "hello resume");
      ctx.autoConfirm = "deny";
      const denied = await ctx.act({ action: "upload_file", target: { text: "Upload resume" }, path: f });
      const stillNone = await ctx.page("window.__upload");
      ctx.autoConfirm = "allow";
      const ok = await ctx.act({ action: "upload_file", target: { text: "Upload resume" }, path: f });
      const up = await ctx.page("window.__upload");
      const secret = path.join(dir, ".env");
      fs.writeFileSync(secret, "KEY=1");
      const prot = await ctx.act({ action: "upload_file", target: { text: "Upload resume" }, path: secret });
      return { pass: !denied.ok && !stillNone && ok.ok && up && up.name === "resume.txt" && !prot.ok && prot.code === "protected_path" && ctx.confirmations.length >= 2, details: `denied=${denied.code} allowed=${ok.ok} upload=${JSON.stringify(up)} protected=${prot.code} confirmations=${ctx.confirmations.length}` };
    },
  },
  {
    id: "I7", category: "intermediate", name: "iframes: click a control inside same-origin and cross-origin frames",
    async run(ctx) {
      await ctx.open("/frames");
      const obs = await ctx.observe({});
      const framed = obs.elements.filter((e) => e.frameKey);
      const r1 = await ctx.act({ action: "click", target: { text: "Inner Button same" } });
      const r2 = await ctx.act({ action: "click", target: { text: "Inner Button cross" } });
      const wc = await ctx.guest();
      const frames = wc.mainFrame.framesInSubtree.filter((f) => f !== wc.mainFrame);
      const titles = [];
      for (const f of frames) titles.push(await f.executeJavaScript("document.title").catch(() => "?"));
      const ok = titles.includes("frame-clicked-same") && titles.includes("frame-clicked-cross");
      return { pass: r1.ok && r2.ok && ok && obs.frames.some((f) => f.crossOrigin), details: `frame elements=${framed.map((e) => e.ref + ":" + e.name).join(",")} titles=${JSON.stringify(titles)} r1=${r1.message} r2=${r2.message}`, metrics: { frames: obs.frames.length } };
    },
  },
  {
    id: "I8", category: "intermediate", name: "hover menu, <select>, and right-click context menu",
    async run(ctx) {
      await ctx.open("/menu");
      const h = await ctx.act({ action: "hover", target: { text: "Products" }, expect: { text_visible: "Laptops menu item" } });
      const nav = await ctx.act({ action: "click", target: { text: "Laptops menu item" } });
      const onSearch = (await ctx.page("location.pathname")) === "/search";
      await ctx.open("/menu");
      const sel = await ctx.act({ action: "form_input", target: { text: "Sort by" }, value: "Price: low to high" });
      const out1 = await ctx.page("document.getElementById('out').textContent");
      const obs = await ctx.observe({ screenshot: true });
      const rc = await ctx.page("(()=>{const r=document.getElementById('ctx').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()");
      const m = ctx.toShot(rc.x, rc.y);
      const r = await ctx.act({ action: "right_click", target: { type: "coordinate", x: m.x, y: m.y }, expect: { text_visible: "Inspect item" } });
      const item = await ctx.act({ action: "click", target: { text: "Inspect item" } });
      const out2 = await ctx.page("document.getElementById('out').textContent");
      return { pass: h.ok && nav.ok && onSearch && sel.ok && out1 === "sort=pl" && r.ok && item.ok && out2 === "inspected", details: `hover=${h.ok} nav=${onSearch} select=${out1} ctx=${out2}` };
    },
  },
  {
    id: "I9", category: "intermediate", name: "dynamic UI: wait for a late element, then click it",
    async run(ctx) {
      await ctx.open("/dynamic?scenario=late");
      const early = (await ctx.core.browser.findElements("Late Button")).some((e) => e.role === "button");
      const w = await ctx.act({ action: "wait", until: { element: "Late Button" }, timeout_ms: 5000 });
      const c = await ctx.act({ action: "click", target: { text: "Late Button" } });
      const out = await ctx.page("document.getElementById('out').textContent");
      return { pass: !early && w.ok && c.ok && out === "late clicked", details: `early=${early} wait=${w.message} out=${out}` };
    },
  },

  // ============================================================ COORDINATES (mapping chain)
  {
    id: "C1", category: "coordinates", name: "screenshot coordinates -> CSS viewport: 12 clicks land within 1.5px",
    async run(ctx) {
      await ctx.open("/pointer");
      const obs = await ctx.observe({ screenshot: true });
      const g = obs.screenshot.geometry;
      const pts = [[10, 10], [200, 90], [640, 300], [900, 500], [55, 555], [777, 33], [431, 222], [300, 480], [1, 1], [500, 100], [720, 420], [333, 333]];
      let worst = 0;
      for (const [px, py] of pts) {
        const vx = Math.min(px, g.viewport.width - 2);
        const vy = Math.min(py, g.viewport.height - 2);
        const m = g.viewportToModel(vx, vy);
        const r = await ctx.act({ action: "click", target: { type: "coordinate", x: m.x, y: m.y }, expect: { no_effect_ok: true } });
        if (!r.ok) return { pass: false, details: `click failed: ${r.message}` };
        const clicks = await ctx.page("window.__clicks");
        const last = clicks[clicks.length - 1];
        worst = Math.max(worst, Math.hypot(last.x - vx, last.y - vy));
        ctx.core.browser.frame = { ...ctx.core.browser.frame, stale: false };
      }
      return { pass: worst <= 1.5, details: `worst error ${worst.toFixed(2)} css px; image ${g.image.width}x${g.image.height} viewport ${g.viewport.width}x${g.viewport.height} dpr~${g.devicePixelRatio.toFixed(2)} zoom ${g.zoomFactor}`, metrics: { worstErrorPx: +worst.toFixed(2) } };
    },
  },
  {
    id: "C4", category: "coordinates", name: "page WITH a scrollbar: clicks near the right edge still land within 1.5px (scrollbar gutter is part of the frame)",
    async run(ctx) {
      await ctx.open("/pointer-scroll");
      const obs = await ctx.observe({ screenshot: true });
      const g = obs.screenshot.geometry;
      const inner = await ctx.page("({iw: innerWidth, cw: document.documentElement.clientWidth})");
      let worst = 0;
      // the last point sits at the very edge of the CONTENT area (the scrollbar gutter beyond it is not page content)
      const pts = [[20, 30], [g.viewport.width / 2, 120], [inner.cw - 24, 80], [inner.cw - 3, 60], [inner.cw - 40, g.viewport.height - 20], [inner.cw - 2, 150]];
      for (const [px, py] of pts) {
        const vx = Math.min(px, g.viewport.width - 2);
        const vy = Math.min(py, g.viewport.height - 2);
        const m = g.viewportToModel(vx, vy);
        const r = await ctx.act({ action: "click", target: { type: "coordinate", x: m.x, y: m.y }, expect: { no_effect_ok: true } });
        if (!r.ok) return { pass: false, details: "click failed: " + r.message };
        const last = (await ctx.page("window.__clicks")).pop();
        worst = Math.max(worst, Math.hypot(last.x - vx, last.y - vy));
        ctx.core.browser.frame = { ...ctx.core.browser.frame, stale: false };
      }
      return { pass: worst <= 1.5 && g.viewport.width === inner.iw, details: `worst ${worst.toFixed(2)}px; frame viewport ${g.viewport.width} vs innerWidth ${inner.iw} (clientWidth ${inner.cw} excludes the scrollbar)`, metrics: { worstErrorPx: +worst.toFixed(2) } };
    },
  },
  {
    id: "C2", category: "coordinates", name: "aggressively downscaled screenshot (400px) still maps within 3px",
    async run(ctx) {
      await ctx.open("/pointer");
      const obs = await ctx.observe({ screenshot: true, screenshotOptions: { maxLongEdge: 400 } });
      const g = obs.screenshot.geometry;
      let worst = 0;
      for (const [px, py] of [[100, 100], [640, 300], [900, 480], [30, 400], [512, 64]]) {
        const vx = Math.min(px, g.viewport.width - 3);
        const vy = Math.min(py, g.viewport.height - 3);
        const m = g.viewportToModel(vx, vy);
        await ctx.act({ action: "click", target: { type: "coordinate", x: m.x, y: m.y }, expect: { no_effect_ok: true } });
        const last = (await ctx.page("window.__clicks")).pop();
        worst = Math.max(worst, Math.hypot(last.x - vx, last.y - vy));
        ctx.core.browser.frame = { ...ctx.core.browser.frame, stale: false };
      }
      return { pass: obs.screenshot.width <= 400 && worst <= 3, details: `image ${g.image.width}x${g.image.height}; worst ${worst.toFixed(2)}px (quantisation bound ${(g.viewport.width / g.image.width).toFixed(2)}px)`, metrics: { worstErrorPx: +worst.toFixed(2) } };
    },
  },
  {
    id: "C3", category: "coordinates", name: "normalized 0..999 (Gemini-style) coordinates map to the same points",
    async run(ctx) {
      await ctx.open("/pointer");
      const obs = await ctx.observe({ screenshot: true });
      const { FrameGeometry } = require("../../computer/coordinates.cjs");
      const g0 = obs.screenshot.geometry;
      const g = new FrameGeometry({ ...g0.toJSON(), coordinateSpace: "normalized_1000" });
      ctx.core.browser.frame = { ...ctx.core.browser.frame, geometry: g, stale: false };
      let worst = 0;
      for (const [nx, ny] of [[500, 500], [100, 900], [999, 10], [250, 750]]) {
        await ctx.act({ action: "click", target: { type: "coordinate", x: nx, y: ny }, expect: { no_effect_ok: true } });
        const last = (await ctx.page("window.__clicks")).pop();
        const want = g.modelToViewport(nx, ny);
        worst = Math.max(worst, Math.hypot(last.x - want.x, last.y - want.y));
        ctx.core.browser.frame = { ...ctx.core.browser.frame, stale: false };
      }
      return { pass: worst <= 1.5, details: `worst ${worst.toFixed(2)}px` };
    },
  },
];
