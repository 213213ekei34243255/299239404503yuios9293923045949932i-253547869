"""Counts the words Chrome / Chromium that a person can see in the browser's own text (UI strings), per file.
  python -I scan_chrome_words.py <chromium src>
Only translatable <message> text is counted; <ph> placeholders (links, code) are skipped.
"""
import collections
import os
import re
import sys

src = sys.argv[1]
ROOTS = ["chrome/app", "components", "ui/strings", "chrome/browser/resources", "extensions", "content/app", "device", "services",
         "third_party/blink/public/strings"]
SKIP = re.compile(r"[\\/](test|tests|android|ios)[\\/]")
MSG = re.compile(r"<message\b([^>]*)>(.*?)</message>", re.S)
WORD = re.compile(r"(?i)\bchrom(?:e|ium)\b")


def grd_files():
    for r in ROOTS:
        for dp, _dn, fn in os.walk(os.path.join(src, r)):
            if SKIP.search(dp + os.sep):
                continue
            for f in fn:
                if f.endswith((".grd", ".grdp")):
                    yield os.path.join(dp, f)


def visible_text(body):
    return re.sub(r"<ph\b.*?</ph>", "", body, flags=re.S)


if __name__ == "__main__":
    cnt = collections.Counter()
    samples = collections.Counter()
    files = list(grd_files())
    for p in files:
        s = open(p, encoding="utf-8", errors="ignore").read()
        for m in MSG.finditer(s):
            if 'translateable="false"' in m.group(1):
                continue
            for w in WORD.findall(visible_text(m.group(2))):
                cnt[os.path.relpath(p, src)] += 1
            for ctx in re.findall(r"(?i)(?:\w+\W+){0,1}\bchrom(?:e|ium)\b(?:\W+\w+){0,1}", visible_text(m.group(2))):
                samples[" ".join(ctx.split())] += 1
    print("grd files:", len(files), "mentions:", sum(cnt.values()))
    for p, n in cnt.most_common(20):
        print(f"{n:5d}  {p}")
    print("--- most common phrases")
    for s, n in samples.most_common(40):
        print(f"{n:5d}  {s}")
