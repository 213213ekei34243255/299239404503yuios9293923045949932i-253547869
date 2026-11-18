"""Replaces the words Chrome / Chromium in the text a person can SEE in Jonah (UI strings, every language) with Jonah.

  python -I debrand_strings.py <chromium src> [--dry-run]

What is changed: translatable <message> text in .grd/.grdp files and <translation> text in .xtb files. Placeholders (<ph>),
links and code inside them are never touched, nor are untranslatable messages (URLs, ids, switches).

What is kept on purpose (honesty and the Chromium licence):
  * "the Chromium open source project" and "The Chromium Authors" (the About page credit; chrome://credits keeps all licences)
  * names of other Google products that are not this browser are made generic instead of renamed to Jonah:
    "Chrome Web Store" -> "Web Store", "Chrome Remote Desktop" -> "Remote Desktop", "Chrome Enterprise" -> "Enterprise".
  * ChromeOS / Chrome OS / Chromebook / ChromeVox (other products, only shown on ChromeOS devices).
Safe to run more than once.
"""
import os
import re
import sys

src = sys.argv[1]
dry = "--dry-run" in sys.argv
ROOTS = ["chrome/app", "components", "ui/strings", "chrome/browser/resources", "extensions", "content/app", "device", "services",
         "third_party/blink/public/strings", "ui/chromeos/strings"]
SKIP = re.compile(r"[\\/](test|tests|android|ios)[\\/]")

RULES = [
    (re.compile(r"\bGoogle Chrome for Testing\b"), "Jonah"),
    (re.compile(r"\bGoogle Chrome\b"), "Jonah"),
    (re.compile(r"\bChrome Web Store\b"), "Web Store"),
    (re.compile(r"\bChrome Remote Desktop\b"), "Remote Desktop"),
    (re.compile(r"\bChrome Enterprise\b"), "Enterprise"),
    (re.compile(r"\bChromium\b(?!OS| OS| open source| Authors| project| Projekt)"), "Jonah"),
    (re.compile(r"\bChrome\b(?! ?OS\b|book|Vox)"), "Jonah"),
    (re.compile(r"\bchrome://"), "jonah://"),
]


def fix_text(text):
    n = 0
    for rx, rep in RULES:
        text, k = rx.subn(rep, text)
        n += k
    return text, n


def fix_outside(body, ph_rx):
    """Applies fix_text to the parts of `body` outside placeholders."""
    out, last, n = [], 0, 0
    for m in ph_rx.finditer(body):
        t, k = fix_text(body[last:m.start()])
        out.append(t); out.append(m.group(0)); n += k; last = m.end()
    t, k = fix_text(body[last:])
    out.append(t); n += k
    return "".join(out), n


GRD_MSG = re.compile(r"(<message\b([^>]*)>)(.*?)(</message>)", re.S)
GRD_PH = re.compile(r"<ph\b.*?</ph>", re.S)
XTB_TR = re.compile(r"(<translation\b[^>]*>)(.*?)(</translation>)", re.S)
XTB_PH = re.compile(r"<ph\b[^>]*/>")


def do_file(path):
    s = open(path, encoding="utf-8").read()
    total = 0
    if path.endswith(".xtb"):
        def rep(m):
            nonlocal total
            body, k = fix_outside(m.group(2), XTB_PH); total += k
            return m.group(1) + body + m.group(3)
        new = XTB_TR.sub(rep, s)
    else:
        def rep(m):
            nonlocal total
            if 'translateable="false"' in m.group(2):
                return m.group(0)
            body, k = fix_outside(m.group(3), GRD_PH); total += k
            return m.group(1) + body + m.group(4)
        new = GRD_MSG.sub(rep, s)
    if total and not dry:
        open(path, "w", encoding="utf-8", newline="").write(new)
    return total


grand, files = 0, 0
for r in ROOTS:
    for dp, _dn, fn in os.walk(os.path.join(src, r)):
        if SKIP.search(dp + os.sep):
            continue
        for f in fn:
            if f.endswith((".grd", ".grdp", ".xtb")):
                n = do_file(os.path.join(dp, f))
                if n:
                    grand += n; files += 1
print(("would change" if dry else "changed"), grand, "mentions in", files, "files")
