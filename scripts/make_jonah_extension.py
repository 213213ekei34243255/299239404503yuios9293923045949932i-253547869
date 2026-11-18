"""Build Jonah's built-in extension (start page) from the Electron Jonah project.

  python -I make_jonah_extension.py <electron jonah dir> <npm downloads dir> <public key b64 file> <output dir>

The Electron project is only READ. The output dir is (re)created from scratch every run, so this can be re-run
whenever home.html changes in the Electron project.

What it does to home.html (design and behaviour stay the same):
  * Chromium does not let its built-in pages run inline <script> code or onclick="..." attributes, so every inline
    script is moved into js/inline-N.js and each onclick="fn('arg')" becomes data-jonah-click / data-jonah-arg,
    handled by js/jonah-handlers.js (calls the same function).
  * Libraries that were loaded from CDNs are shipped inside Jonah (vendor/), at pinned versions.
  * window.api.getNews (Electron's bridge) is provided by js/jonah-api.js using the same Jonah news server.
    No secret keys are put into the extension.
"""
import base64
import json
import re
import shutil
import sys
from pathlib import Path

from PIL import Image

electron, npm, keyfile, out = (Path(a) for a in sys.argv[1:5])
VERSION = json.loads((electron / "package.json").read_text(encoding="utf-8"))["version"]

if out.exists():
    shutil.rmtree(out)
(out / "js").mkdir(parents=True)


def need(cond, msg):
    if not cond:
        sys.exit("ERROR: " + msg)


def sub_exact(text, old, new, count=None):
    n = text.count(old)
    need(n >= 1 and (count is None or n == count), f"expected {count or '>=1'} of {old[:80]!r}, found {n}")
    return text.replace(old, new)


html = (electron / "home.html").read_text(encoding="utf-8")

# 1. CDN libraries -> files shipped inside Jonah (pinned versions downloaded with the owner's approval).
html = sub_exact(html, '<script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>',
                 '<script src="vendor/hls.js-1.7.4/hls.min.js"></script>', 2)
# the page loaded hls.js twice; keep only the first copy
first = html.index('vendor/hls.js-1.7.4/hls.min.js')
second = html.index('<script src="vendor/hls.js-1.7.4/hls.min.js"></script>', first + 10)
html = html[:second] + html[second:].replace('<script src="vendor/hls.js-1.7.4/hls.min.js"></script>', "", 1)
html = sub_exact(html, '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>',
                 '<script src="vendor/chart.js-4.6.1/chart.umd.min.js"></script>', 1)
html = sub_exact(html, "<link href='https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css' rel='stylesheet'>",
                 '<link href="vendor/boxicons-2.1.4/css/boxicons.min.css" rel="stylesheet">', 1)

# 2. Jonah bridges, loaded before any page script.
html = sub_exact(html, '<script src="theme-core.js"></script>',
                 '<script src="theme-core.js"></script>\n<script src="js/jonah-api.js"></script>\n'
                 '<script src="js/jonah-handlers.js"></script>', 1)

# (inside an inline script's HTML template, so it is changed before the scripts are moved out)
html = sub_exact(html, "onerror=\"this.style.display='none'\"", "data-jonah-hide-on-error", 1)

# 3. Inline scripts -> files.
blocks = list(re.finditer(r"<script>(.*?)</script>", html, flags=re.S))
need(len(blocks) == 4, f"expected 4 inline scripts, found {len(blocks)}")
for i, m in enumerate(reversed(blocks)):
    n = len(blocks) - i
    (out / f"js/inline-{n}.js").write_text(m.group(1).strip("\n") + "\n", encoding="utf-8", newline="\n")
    html = html[:m.start()] + f'<script src="js/inline-{n}.js"></script>' + html[m.end():]
need("<script>" not in html, "inline script left")

# 4. Inline event handlers -> data attributes (js/jonah-handlers.js calls the same functions).
def handler(m):
    fn, arg = m.group(1), m.group(2)
    return f' data-jonah-click="{fn}"' + (f' data-jonah-arg="{arg}"' if arg is not None else "")


html, k = re.subn(r""" onclick="(\w+)\((?:'([^'"]*)')?\)\"""", handler, html)
need(k == 9, f"expected 9 onclick handlers, converted {k}")
need(not re.search(r"""\son[a-z]+\s*=\s*["']""", html), "an inline event handler is left")

# The owner's whale (a white whale, transparent background: D:/Jonah-Chromium/downloads/jonah-logo-white.png) is the new tab's TAB icon
# (the small picture in the tab strip). The big Jonah artwork at the top of the page stays as it is (assets/IO.png).
html = sub_exact(html, "<title>Jonah</title>", '<title>Jonah</title>\n<link rel="icon" type="image/png" href="assets/jonah-whale.png">', 1)
(out / "newtab.html").write_text(html, encoding="utf-8", newline="\n")

# 5. Files the page uses.
for f in ("theme-defaults.css", "theme-tokens.js", "theme-core.js"):
    shutil.copyfile(electron / f, out / f)
(out / "assets").mkdir()
for f in ("IO.png", "favicon.png"):
    shutil.copyfile(electron / "assets" / f, out / "assets" / f)
OWNER_LOGO = Path(__file__).parent.parent / "downloads" / "jonah-logo-white.png"  # given by the owner (2026-11-18)
need(OWNER_LOGO.is_file(), f"{OWNER_LOGO} missing")
shutil.copyfile(OWNER_LOGO, out / "assets" / "jonah-whale.png")
# market-keys.js is the owner's private file (never committed); ship the empty example instead: boards that need a key stay empty.
shutil.copyfile(electron / "market-keys.example.js", out / "market-keys.js")
shutil.copytree(npm, out / "vendor")

# 6. Bridges.
(out / "js/jonah-api.js").write_text(r"""// jonah-api.js - what Electron's preload (window.api) and the window around the page gave home.html, for Jonah on Chromium.
//   getNews(page): the Trending News grid. Electron main 'get-news' asked jonahbrowser.store's /news/headlines with the owner's server
//     key, which never reaches a web page; here Noah's helper does the same (Electron's search-proxy.cjs fetchNews), through Jonah's
//     background (jonah-trust.js "jonah:news"). Without the key the grid stays empty, as Electron did without its .env.
//   the side dock (Game Hub / Creator Studio / Aesthetic Lab) sends "jonah-open-hub": Electron's window opened the hub; here the hub
//     opens in Jonah's side panel (the same way the menu opens it).
(function () {
  "use strict";
  async function getNews(page) {
    try {
      const d = await chrome.runtime.sendMessage({ type: "jonah:news", page: Math.min(Math.max(parseInt(page, 10) || 1, 1), 100) });
      return d && typeof d === "object" && !d.error ? d : null;
    } catch (_) {
      return null;
    }
  }
  window.api = Object.freeze({ getNews });

  let windowId = null;
  chrome.windows.getCurrent().then((w) => { windowId = w.id; }).catch(() => {});
  window.addEventListener("jonah-open-hub", (e) => {
    const hub = String((e && e.detail) || "");
    if (!/^(game|creator|aesthetic)$/.test(hub)) return;
    // open() first, inside the click: Chromium opens the side panel only straight from a user action
    if (windowId != null) chrome.sidePanel.open({ windowId }).catch(() => {});
    chrome.storage.session.set({ jonahOpen: { view: "hub:" + hub, t: Date.now() } }).catch(() => {});
  });
})();
""", encoding="utf-8", newline="\n")

(out / "js/jonah-handlers.js").write_text(r"""// jonah-handlers.js - Chromium's built-in pages may not use onclick="..." attributes, so the start page marks those
// elements with data-jonah-click="functionName" (and data-jonah-arg) and this calls the same page function on click.
(function () {
  "use strict";
  // data-jonah-click / -input / -change / -keydown="functionName" (+ data-jonah-arg): calls functionName(arg, element, event),
  // or functionName(element, event) when there is no argument.
  for (const [type, attr] of [["click", "jonahClick"], ["input", "jonahInput"], ["change", "jonahChange"], ["keydown", "jonahKeydown"]]) {
    const sel = "[data-" + attr.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()) + "]";
    document.addEventListener(type, (e) => {
      const el = e.target && e.target.closest ? e.target.closest(sel) : null;
      if (!el) return;
      const fn = window[el.dataset[attr]];
      if (typeof fn !== "function") return;
      if ("jonahArg" in el.dataset) fn(el.dataset.jonahArg, el, e); else fn(el, e);
    });
  }
  // <img data-jonah-hide-on-error> hides itself when the picture cannot load (was onerror="this.style.display='none'")
  document.addEventListener("error", (e) => {
    const t = e.target;
    if (t && t.tagName === "IMG" && t.hasAttribute("data-jonah-hide-on-error")) t.style.display = "none";
  }, true);
})();
""", encoding="utf-8", newline="\n")

# 6b. Noah's panel (ai-panel.html) -> noah.html, shown in Chromium's side panel. Same design and code; js/noah-host.js does
#     what Electron's browser window did for it (see that file).
panel = (electron / "ai-panel.html").read_text(encoding="utf-8")
panel = sub_exact(panel, '<script src="theme-core.js"></script>',
                  '<script src="theme-core.js"></script>\n<script src="js/jonah-handlers.js"></script>\n'
                  '<script src="js/noah-host.js"></script>', 1)
panel = sub_exact(panel,
                  'function closePanel() {\n    const panel = window.parent.document.getElementById("aiPanel");\n'
                  '    if (panel) panel.classList.add("ai-hidden");\n}',
                  "function closePanel() { window.jonahClosePanel(); }", 1)
pblocks = list(re.finditer(r"<script>(.*?)</script>", panel, flags=re.S))
need(len(pblocks) == 2, f"expected 2 inline scripts in ai-panel.html, found {len(pblocks)}")
for i, m in enumerate(reversed(pblocks)):
    n = len(pblocks) - i
    (out / f"js/noah-inline-{n}.js").write_text(m.group(1).strip("\n") + "\n", encoding="utf-8", newline="\n")
    panel = panel[:m.start()] + f'<script src="js/noah-inline-{n}.js"></script>' + panel[m.end():]
panel, k = re.subn(r""" onclick="(\w+)\((?:'([^'"]*)')?\)\"""", handler, panel)
need(k == 2, f"expected 2 onclick handlers in ai-panel.html, converted {k}")
need("<script>" not in panel and not re.search(r"""\son[a-z]+\s*=\s*["']""", panel), "inline code left in noah.html")
(out / "noah.html").write_text(panel, encoding="utf-8", newline="\n")
shutil.copyfile(electron / "chat-render.js", out / "chat-render.js")
for f in ("marked.umd.js", "purify.min.js", "highlight.min.js", "highlight-extra.min.js", "THIRD-PARTY-LICENSES.txt"):
    shutil.copyfile(electron / "vendor" / f, out / "vendor" / f)
shutil.copyfile(Path(__file__).parent / "jonah-ext-src" / "noah-host.js", out / "js/noah-host.js")

# 6c. Tools, hubs and study tools (book menu) and the ⋮ menu's panels, opened over Noah's chat in the side panel.
SRC = Path(__file__).parent / "jonah-ext-src"
index = (electron / "index.html").read_text(encoding="utf-8")
# the tool panels' styles (index.html: .jonah-tool-panel ...) + how they fill Chromium's side panel
css_start = index.index("    .jonah-tool-panel {")
css_end = index.index("    .browser-menu .menu-divider {")
(out / "css").mkdir(exist_ok=True)
(out / "css/tools.css").write_text(
    "/* From Jonah on Electron (index.html), the tool panels' look. */\n" + index[css_start:css_end]
    + (SRC / "tools-extra.css").read_text(encoding="utf-8"), encoding="utf-8", newline="\n")
# the tools' code (index.html: book-icon menu, tool panel shell, calculator, abacus, formula reference, research notes)
t_start = index.index("// ===== Book-icon menu: Citation + study tools")
t_end = index.index("</script>", t_start)
tools = index[t_start:t_end]
TOOL_HANDLERS = [
    ("""onclick="closeToolPanel('${id}')\"""", 'data-jonah-click="closeToolPanel" data-jonah-arg="${id}"'),
    ("""onclick="calcPress('${k.replace(/'/g, "\\\\'")}')\"""", 'data-jonah-click="calcPress" data-jonah-arg="${k.replace(/"/g, "&quot;")}"'),
    ('''oninput="calcExpr=this.value"''', 'data-jonah-input="jonahCalcInput"'),
    ('''onkeydown="if(event.key==='Enter'){calcEvaluate();event.preventDefault();}"''', 'data-jonah-keydown="jonahCalcKey"'),
    ('onclick="abacusReset()"', 'data-jonah-click="abacusReset"'),
    ('oninput="renderFormulaList()"', 'data-jonah-input="renderFormulaList"'),
    ('onclick="calcMolarMass()"', 'data-jonah-click="calcMolarMass"'),
    ("""onclick="formulaActiveTab='${t}';renderFormulaList();refreshFormulaTabs();\"""", 'data-jonah-click="jonahFormulaTab" data-jonah-arg="${t}"'),
    ('onchange="rnSave()"', 'data-jonah-change="rnSave"'),
    ('onclick="rnAddCurrentPage()"', 'data-jonah-click="rnAddCurrentPage"'),
    ('onclick="rnCopyAll()"', 'data-jonah-click="rnCopyAll"'),
    ('onclick="rnClear()"', 'data-jonah-click="rnClear"'),
    ('onclick="rnRemove(${idx})"', 'data-jonah-click="rnRemove" data-jonah-arg="${idx}"'),
]
for old, new in TOOL_HANDLERS:
    tools = sub_exact(tools, old, new, 1)
need(not re.search(r"""\son[a-z]+=["']""", tools), "an inline handler is left in the tools code: " +
     str(re.findall(r"""\son[a-z]+=["'][^"']{0,40}""", tools)[:3]))
tools += """
// ---- Jonah on Chromium: what the converted onclick/oninput/onkeydown attributes above did (js/jonah-handlers.js calls these)
function jonahCalcInput(el) { calcExpr = el.value; }
function jonahCalcKey(el, event) { if (event.key === "Enter") { calcEvaluate(); event.preventDefault(); } }
function jonahFormulaTab(t) { formulaActiveTab = t; renderFormulaList(); refreshFormulaTabs(); }
"""
(out / "js/tools.js").write_text("// From Jonah on Electron (index.html): the book menu's tools.\n" + tools, encoding="utf-8", newline="\n")
# hub and study code, unchanged
for f in ("internal-pages.js", "hub-core.js", "hub-ui.js", "study-core.js", "study-ui.js", "downloads-core.js", "downloads-ui.js"):
    shutil.copyfile(electron / f, out / "js" / f)
# the hubs' main-process helpers (pure parsers + fetch) as browser modules
mods = ["// From Jonah on Electron (hubs/*.cjs), wrapped so they run in a page. Only their pure parts are used (see jonah-shell.js).\n"]
for name in ("feeds", "system", "images"):
    mods.append(
        "(function () {\n  const module = { exports: {} }; const exports = module.exports;\n"
        "  const require = () => ({}); const process = { platform: \"win32\", env: {} };\n"
        + (electron / "hubs" / f"{name}.cjs").read_text(encoding="utf-8")
        + f"\n  window.JonahHubModules = window.JonahHubModules || {{}}; window.JonahHubModules[{name!r}] = module.exports;\n}})();\n")
(out / "js/hub-modules.js").write_text("".join(mods), encoding="utf-8", newline="\n")
# Noah's web agent: Electron Jonah's Noah/ code bundled unchanged (scripts/bundle_noah.py), loaded by noah-host.js only when used
import subprocess
subprocess.run([sys.executable, "-I", str(Path(__file__).parent / "bundle_noah.py"), str(electron), str(out / "js/noah-bundle.js")], check=True)
for f in ("jonah-shell.js", "jonah-features.js", "background.js", "menu.js", "theme-apply.js", "jonah-calc.js", "jonah-history.js",
          "noah-builtins.js", "noah-boot.js", "jonah-models.js", "jonah-account.js", "noah-overlay-page.js", "yt-adfree-main.js", "noah-computer.js", "jonah-voice.js",
          "jonah-google-search.js", "jonah-trust.js", "jonah-trust-card.js"):
    shutil.copyfile(SRC / f, out / "js" / f)
(out / "css").mkdir(exist_ok=True)
shutil.copyfile(SRC / "yt-adfree.css", out / "css/yt-adfree.css")  # YouTube ad boxes (background.js registers it while ads are blocked)
for f in ("menu.html", "book.html"):
    shutil.copyfile(SRC / f, out / f)
# Focus Mode's page (Electron focus-blocked.html), its inline script moved to a file
fb = (electron / "focus-blocked.html").read_text(encoding="utf-8")
fb = sub_exact(fb, '<button onclick="history.back()">Go back</button>', '<button id="goBack">Go back</button>', 1)
m = re.search(r"<script>(.*?)</script>", fb, flags=re.S)
need(m is not None, "focus-blocked.html script not found")
(out / "js/focus-blocked.js").write_text(m.group(1).strip() + '\ndocument.getElementById("goBack").addEventListener("click", () => history.back());\n',
                                          encoding="utf-8", newline="\n")
fb = fb[:m.start()] + '<script src="js/focus-blocked.js"></script>' + fb[m.end():]
(out / "focus-blocked.html").write_text(fb, encoding="utf-8", newline="\n")
# load it all into Noah's panel page
panel = (out / "noah.html").read_text(encoding="utf-8")
# Administrator access on Jonah for Chromium elevates ONLY Noah's computer helper (noah-native\noah-elevated-host.ps1), never the browser:
# the switch's words say so (Electron's said the whole app restarts as administrator).
panel = sub_exact(panel, 'title="Windows only. Lets Noah see and operate programs that run as administrator (installers, Task Manager...), which Windows otherwise hides from it. Jonah restarts with Windows\' own permission prompt, and while it is on the whole of Jonah, web pages included, runs with administrator rights: turn it on only if you need that. Off by default; turning it off takes effect the next time you open Jonah."',
                  'title="Windows only. Lets Noah see and operate programs that run as administrator (installers, Task Manager...), which Windows otherwise hides from it. Windows asks for permission when Noah next works on your computer; then Noah\'s computer helper (not the browser, not web pages) runs with administrator rights, and so do the programs Noah opens. Off by default; turning it off takes effect with Noah\'s next computer task."', 1)
_pj = (out / "js/noah-inline-2.js").read_text(encoding="utf-8")
_pj = sub_exact(_pj, 'Turn on administrator access?\\n\\nWindows will ask for your permission and Jonah will restart. While it is on, the whole of Jonah (web pages included) runs with administrator rights, and Noah can see and operate programs that run as administrator.\\n\\nTurn it on only if you need that.',
                  'Turn on administrator access?\\n\\nWindows will ask for your permission the next time Noah works on your computer. While it is on, Noah\\\'s computer helper (not the browser and not web pages) runs with administrator rights, so Noah can see and operate programs that run as administrator, and the programs it opens run as administrator too.\\n\\nTurn it on only if you need that.', 1)
# a confirmation can be for a computer task (its card is in this panel) as well as a web page: say it neutrally
_pj = sub_exact(_pj, '"Waiting for your OK on the page: "', '"Noah needs your OK: "', 1)
(out / "js/noah-inline-2.js").write_text(_pj, encoding="utf-8", newline="\n")
panel = sub_exact(panel, '<script src="js/noah-host.js"></script>',
                  '<script src="js/noah-host.js"></script>\n<link rel="stylesheet" href="css/tools.css">\n'
                  '<link rel="stylesheet" href="css/jonah-glass.css">\n'
                  '<script src="js/internal-pages.js"></script>\n<script src="js/hub-modules.js"></script>\n'
                  '<script src="js/jonah-shell.js"></script>\n<script src="js/jonah-features.js"></script>', 1)
panel = sub_exact(panel, "</body>",
                  '<script src="js/tools.js"></script>\n<script src="js/hub-core.js"></script>\n<script src="js/hub-ui.js"></script>\n'
                  '<script src="js/study-core.js"></script>\n<script src="js/study-ui.js"></script>\n'
                  '<script src="js/downloads-core.js"></script>\n<script src="js/downloads-ui.js"></script>\n'
                  '<script src="js/jonah-calc.js"></script>\n<script src="js/jonah-history.js"></script>\n'
                  '<script src="js/jonah-account.js"></script>\n<script src="js/jonah-models.js"></script>\n<script src="js/noah-computer.js"></script>\n'
                  '<script src="js/google-results.js"></script>\n<script src="js/jonah-google-search.js"></script>\n<script src="js/jonah-voice.js"></script>\n'
                  '<script src="js/wake-core.js"></script>\n<script src="js/wake-listener.js"></script>\n<script type="module" src="js/voice-orb.js"></script>\n</body>', 1)
(out / "noah.html").write_text(panel, encoding="utf-8", newline="\n")

# ---- Electron Jonah's voice (the round voice orb + the wake word "Noah"), in Noah's panel. Unchanged files, except in voice-orb.js:
#   * the speech recogniser: Electron imported transformers.js from a CDN (esm.sh) at run time and downloaded Moonshine from Hugging Face;
#     Jonah runs the same Moonshine model locally in Noah's helper (noah-native, copied from Electron Jonah's own cache): getSTT() asks it
#   * the panel: Electron's orb lived in the window AROUND the panel's iframe; here it lives in the panel page itself
#   * the icon: Jonah's own
for f in ("wake-core.js", "wake-listener.js", "mic-processor.js"):
    shutil.copyfile(electron / f, out / "js" / f)
shutil.copyfile(electron / "mic-processor.js", out / "mic-processor.js")  # the orb's recorder loads it next to the page
orb = (electron / "voice-orb.js").read_text(encoding="utf-8")
m = re.search(r"async function getSTT\(onProgress\) \{.*?\n    return _sttPipelinePromise;\n\}\n", orb, flags=re.S)
need(m is not None, "voice-orb.js getSTT() not found")
orb = orb[:m.start()] + """async function getSTT(onProgress) {
    // Jonah on Chromium: Moonshine-base runs in Noah's helper (noah-native) - no CDN, no download (js/jonah-voice.js)
    if (!_sttPipelinePromise) {
        _sttPipelinePromise = window.JonahSpeech.warm().then(() => (pcm) => window.JonahSpeech.transcribe(pcm));
        _sttPipelinePromise.catch(() => { _sttPipelinePromise = null; });
    }
    return _sttPipelinePromise;
}
""" + orb[m.end():]
orb = sub_exact(orb, """  const panelWindow = () => {
    const f = document.querySelector("#aiPanel iframe");
    return f && f.contentWindow;
  };""", """  const panelWindow = () => window; // Jonah on Chromium: the orb lives in Noah's panel page itself""", 1)
orb = sub_exact(orb, 'ICON_SRC: "assets/logo.png",', 'ICON_SRC: "assets/jonah-whale.png",', 1)  # the owner's whale
# in Noah's panel the bottom-right corner is the Send button: the orb starts above the chat's mode buttons (it can still be dragged)
orb = sub_exact(orb, """  STARTING_POSITION: {
    right: 28,
    bottom: 28
  },""", """  STARTING_POSITION: {
    right: 18,
    bottom: 126
  },""", 1)
(out / "js/voice-orb.js").write_text(orb, encoding="utf-8", newline="\n")

# ---- Electron Jonah's Google results reader (google-serp.cjs readResultsPage, unchanged): the chat's web search runs it in the page
serp = (electron / "google-serp.cjs").read_text(encoding="utf-8")
m = re.search(r"\nfunction readResultsPage\(\) \{.*?\n\}\n", serp, flags=re.S)
need(m is not None, "google-serp.cjs readResultsPage() not found")
(out / "js/google-results.js").write_text(
    "// google-results.js - Electron Jonah's google-serp.cjs readResultsPage(), unchanged: reads Google's results page the way it is shown\n"
    "// (organic results only; ads and Google's own links skipped; reports the robot check / cookie page). Run in that page by noah-computer.js.\n"
    "self.JonahReadGoogleResults = " + m.group(0).strip() + ";\n", encoding="utf-8", newline="\n")
# Noah's overlay (purple cursor, status, STOP), Electron files unchanged; injected into the page while Noah works
shutil.copyfile(electron / "noah-overlay.js", out / "js/noah-overlay.js")
shutil.copyfile(electron / "noah-overlay.css", out / "css/noah-overlay.css")
# iPhone-style glass look for every tool panel
shutil.copyfile(SRC / "jonah-glass.css", out / "css/jonah-glass.css")

# 7. Icons and manifest.
logo = Image.open(Path(__file__).parent.parent / "downloads" / "jonah-app-icon.png").convert("RGBA")  # the owner's app icon (2026-11-18), same as the Windows/Mac app
(out / "icons").mkdir()
for s in (16, 32, 48, 128):
    logo.resize((s, s), Image.LANCZOS).save(out / f"icons/jonah-{s}.png", "PNG", optimize=True)

# The 4th version number comes from the extension's contents. Chromium keeps an extension's background service worker cached
# until the extension's VERSION changes, so with a fixed "1.5.5" an existing profile kept running the old js/background.js
# (2026-11-17: YouTube ad blocking and the rule fix never reached the owner's profile). Any change to the files -> new version.
import hashlib
_h = hashlib.sha256()
for _p in sorted(p for p in out.rglob("*") if p.is_file() and p.name not in ("manifest.json", "BUILD.gn")):
    _h.update(_p.relative_to(out).as_posix().encode()); _h.update(_p.read_bytes())
BUILD_NO = int(_h.hexdigest()[:8], 16) % 65000 + 1
EXT_VERSION = f"{VERSION}.{BUILD_NO}"
need(VERSION.count(".") == 2, "package.json version is not x.y.z")

manifest = {
    "manifest_version": 3,
    "name": "Jonah",
    "description": "Jonah's own start page and features, built into the Jonah browser by CogniAI Studios.",
    "version": EXT_VERSION,
    "version_name": VERSION,
    "key": keyfile.read_text().strip(),
    "icons": {str(s): f"icons/jonah-{s}.png" for s in (16, 32, 48, 128)},
    "chrome_url_overrides": {"newtab": "newtab.html"},
    # Noah's chat panel, opened by the "Chat" button in the toolbar.
    "side_panel": {"default_path": "noah.html"},
    # Background part: Focus Mode, ads & trackers, read aloud, notifications (see js/background.js).
    "background": {"service_worker": "js/background.js"},
    # tabs + scripting + <all_urls>: the page is read ONLY when asked (a chat message about the page, Cite this page,
    # Read page aloud, the tools' "add this page"). declarativeNetRequest: Focus Mode, ads, trackers.
    # system.cpu/memory: the Game Hub's PC readings. tts: Read page aloud.
    "permissions": ["storage", "sidePanel", "tabs", "scripting", "declarativeNetRequest", "declarativeNetRequestFeedback",
                    "alarms", "notifications", "tts", "system.cpu", "system.memory", "downloads", "downloads.open", "history", "favicon",
                    # Noah's web agent works in a tab through the Chrome DevTools Protocol (as in Electron). Jonah shows no
                    # "debugging this browser" bar for THIS built-in extension only (debugger_api.cc); Noah's purple cursor,
                    # status and STOP button show on the page while it works.
                    "debugger",
                    # Noah's computer agent (Electron's mission code in Node, in the noah-native folder next to jonah's exe,
                    # scripts/make_noah_native.py): the only native messaging host Jonah talks to is its own, com.cogniai.jonah.noah.
                    "nativeMessaging"],
    # Focus Mode sends blocked sites to this page.
    "web_accessible_resources": [{"resources": ["focus-blocked.html", "js/focus-blocked.js"], "matches": ["<all_urls>"]}],
    # The start page reads these public services directly (news, search suggestions, radio, markets);
    # Noah's chat uses www.noahai.live (the same server as Electron Jonah).
    "host_permissions": [
        "<all_urls>",
        "https://www.noahai.live/*",
        "https://www.jonahbrowser.store/*",
        "https://duckduckgo.com/*",
        "https://*.api.radio-browser.info/*",
        "https://api.twelvedata.com/*",
        "https://api.coingecko.com/*",
        "https://api.frankfurter.app/*",
    ],
}
manifest_text = json.dumps(manifest, indent=2) + "\n"
(out / "manifest.json").write_text(manifest_text, encoding="utf-8", newline="\n")
# The browser reads the manifest from this compiled-in copy, so startup never has to read a file from disk for it.
need(")JSON\"" not in manifest_text, "manifest text cannot be embedded")
_header = out.parents[1] / "extensions" / "jonah_extension_manifest.h"
_old_header = _header.read_text(encoding="utf-8") if _header.is_file() else ""
(out.parents[1] / "extensions" / "jonah_extension_manifest.h").write_text(
    "// Generated by D:/Jonah-Chromium/scripts/make_jonah_extension.py - do not edit by hand.\n"
    "#ifndef CHROME_BROWSER_EXTENSIONS_JONAH_EXTENSION_MANIFEST_H_\n"
    "#define CHROME_BROWSER_EXTENSIONS_JONAH_EXTENSION_MANIFEST_H_\n\n"
    "// Manifest of Jonah's built-in extension (files in <exe dir>/resources/jonah).\n"
    f'inline constexpr char kJonahExtensionManifest[] = R"JSON({manifest_text})JSON";\n\n'
    "#endif  // CHROME_BROWSER_EXTENSIONS_JONAH_EXTENSION_MANIFEST_H_\n",
    encoding="utf-8", newline="\n")

# 8. GN target: copy the extension next to the browser (out/<dir>/resources/jonah/...).
files = sorted(p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file())
(out / "BUILD.gn").write_text(
    "# Generated by D:/Jonah-Chromium/scripts/make_jonah_extension.py - do not edit by hand.\n"
    "# Jonah's built-in extension, copied to <out>/resources/jonah and loaded by\n"
    "# ComponentLoader::AddJonahExtension().\n\n"
    'copy("jonah_extension") {\n  sources = [\n'
    + "".join(f'    "{f}",\n' for f in files)
    + '  ]\n  outputs = [ "$root_out_dir/resources/jonah/{{source_target_relative}}" ]\n}\n\n'
    "# Mac: the same files inside the framework bundle (Resources/jonah), added to chrome_framework_resources.\n"
    'bundle_data("jonah_extension_bundle_data") {\n  sources = [\n'
    + "".join(f'    "{f}",\n' for f in files)
    + '  ]\n  outputs = [ "{{bundle_resources_dir}}/jonah/{{source_target_relative}}" ]\n}\n',
    encoding="utf-8", newline="\n")
print(f"Jonah extension {EXT_VERSION}: {len(files)} files in {out}")
# The manifest (and so the extension's version) is COMPILED INTO chrome.dll. Copying only the files is not enough: an existing profile
# keeps running the old background script until Jonah itself reports the new version (2026-11-18: the Trust Engine did not start).
if _header.read_text(encoding="utf-8") != _old_header:
    print("NOTE: the extension's manifest/version changed -> rebuild Jonah (chrome.dll) before installing, or existing profiles keep the old background script")
