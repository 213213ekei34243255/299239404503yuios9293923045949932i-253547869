"""Traces the Jonah whale (assets/logo.png) into Chromium's vector-icon format (.icon) and writes it over the product-logo
icons, so the default-browser bar, PDF bar, restore bar, notifications and the address bar show Jonah's whale instead of the
Chromium logo.

  python -I make_jonah_vector_icon.py <Jonah.png> <chromium src>

How: the logo's opaque area (alpha) is sampled on a grid, outlined with marching squares, simplified (Ramer-Douglas-Peucker)
and written as MOVE_TO / LINE_TO / CLOSE paths (even-odd fill, so holes stay holes), in Jonah violet. Each icon keeps its
original CANVAS_DIMENSIONS. Safe to run again.
"""
import re
import sys
from pathlib import Path

from PIL import Image

logo_path, src = Path(sys.argv[1]), Path(sys.argv[2])
ICONS = [
    "components/vector_icons/chromium/product.icon",
    "components/vector_icons/chromium/product_refresh.icon",
    "chrome/app/vector_icons/chrome_product.icon",
    "components/omnibox/browser/vector_icons/chrome_product.icon",
    "components/omnibox/browser/vector_icons/product_chrome_refresh_old.icon",
    "components/omnibox/browser/vector_icons/product_old.icon",
    "ui/message_center/vector_icons/chrome_product.icon",
    "ui/message_center/vector_icons/product_old.icon",
]
GRID = 128  # sampling grid (cells) across the logo


def load_mask():
    """Solid silhouette of the whale drawing (logo.png is line art on a transparent background): the drawn lines are
    thickened a little, then everything that cannot be reached from the edge (the inside of the whale) is filled."""
    from collections import deque
    from PIL import ImageFilter
    img = Image.open(logo_path).convert("RGBA")
    img = img.crop(img.getbbox())
    side = max(img.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    a = sq.getchannel("A").resize((GRID, GRID), Image.LANCZOS).point(lambda v: 255 if v >= 40 else 0).filter(ImageFilter.MaxFilter(3))
    px = a.load()
    lines = [[1 if px[x, y] else 0 for x in range(GRID)] for y in range(GRID)]
    outside = [[0] * GRID for _ in range(GRID)]
    q = deque((x, y) for x in range(GRID) for y in (0, GRID - 1)) + deque((x, y) for y in range(GRID) for x in (0, GRID - 1))
    while q:
        x, y = q.popleft()
        if 0 <= x < GRID and 0 <= y < GRID and not outside[y][x] and not lines[y][x]:
            outside[y][x] = 1
            q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return [[0 if outside[y][x] else 1 for x in range(GRID)] for y in range(GRID)]


def marching_squares(m):
    """Returns closed loops of points (in grid units) around the filled cells."""
    n = len(m)
    v = lambda x, y: m[y][x] if 0 <= x < n and 0 <= y < n else 0
    segs = {}
    for y in range(-1, n):
        for x in range(-1, n):
            a, b, c, d = v(x, y), v(x + 1, y), v(x + 1, y + 1), v(x, y + 1)
            code = a * 8 + b * 4 + c * 2 + d
            top, right, bottom, left = (x + 1, y + 0.5), (x + 1.5, y + 1), (x + 1, y + 1.5), (x + 0.5, y + 1)
            table = {
                1: [(bottom, left)], 2: [(right, bottom)], 3: [(right, left)], 4: [(top, right)],
                5: [(top, left), (bottom, right)], 6: [(top, bottom)], 7: [(top, left)], 8: [(left, top)],
                9: [(bottom, top)], 10: [(left, bottom), (right, top)], 11: [(right, top)], 12: [(left, right)],
                13: [(bottom, right)], 14: [(left, bottom)],
            }
            for p, q in table.get(code, []):
                segs.setdefault(p, []).append(q)
    loops = []
    while segs:
        start = next(iter(segs))
        loop, cur = [start], start
        while True:
            nxt = segs[cur].pop()
            if not segs[cur]:
                del segs[cur]
            if nxt == start:
                break
            loop.append(nxt)
            cur = nxt
            if cur not in segs:
                break
        if len(loop) >= 4:
            loops.append(loop)
    return loops


def rdp(points, eps):
    if len(points) < 3:
        return points
    (x1, y1), (x2, y2) = points[0], points[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = (dx * dx + dy * dy) ** 0.5 or 1e-9
    best, idx = 0, 0
    for i in range(1, len(points) - 1):
        x0, y0 = points[i]
        d = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / norm
        if d > best:
            best, idx = d, i
    if best > eps:
        return rdp(points[: idx + 1], eps)[:-1] + rdp(points[idx:], eps)
    return [points[0], points[-1]]


def area(loop):
    return abs(sum(loop[i][0] * loop[i - 1][1] - loop[i - 1][0] * loop[i][1] for i in range(len(loop)))) / 2


def icon_text(loops, canvas):
    scale = (canvas - 1) / GRID
    off = 0.5
    lines = [
        "// Jonah: the whale from Jonah's logo (traced from assets/Jonah.png by make_jonah_vector_icon.py).",
        "// Replaces the Chromium logo.",
        "",
        f"CANVAS_DIMENSIONS, {canvas},",
        "PATH_COLOR_ARGB, 0xFF, 0xA7, 0x8B, 0xFA,",
    ]
    for loop in loops:
        h = len(loop) // 2  # a closed loop is simplified as two open halves
        pts = rdp(loop[: h + 1], 0.55)[:-1] + rdp(loop[h:] + [loop[0]], 0.55)[:-1]
        if len(pts) < 3:
            continue
        f = lambda p: f"{p[0] * scale + off:.2f}, {p[1] * scale + off:.2f}"
        lines.append(f"MOVE_TO, {f(pts[0])},")
        lines += [f"LINE_TO, {f(p)}," for p in pts[1:]]
        lines.append("CLOSE,")
    return "\n".join(lines) + "\n"


mask = load_mask()
loops = [l for l in marching_squares(mask) if area(l) >= 6.0]
print(f"traced {len(loops)} outlines")
if len(sys.argv) > 3:  # preview: draw the traced outlines
    from PIL import ImageDraw
    prev = Image.new("RGB", (480, 480), (17, 14, 24)); d = ImageDraw.Draw(prev)
    for l in loops:
        h = len(l) // 2
        pts = rdp(l[: h + 1], 0.55)[:-1] + rdp(l[h:] + [l[0]], 0.55)[:-1]
        d.polygon([(x * 480 / GRID, y * 480 / GRID) for x, y in pts], fill=(167, 139, 250))
    prev.save(sys.argv[3]); print("preview", sys.argv[3])
for rel in ICONS:
    p = src / rel
    old = p.read_text(encoding="utf-8")
    m = re.search(r"CANVAS_DIMENSIONS,\s*(\d+)", old)
    canvas = int(m.group(1)) if m else 24
    header = "".join(l + "\n" for l in old.splitlines()[:3] if l.startswith("// Copyright") or l.startswith("// Use of") or l.startswith("// found in"))
    p.write_text(header + "\n" + icon_text(loops, canvas), encoding="utf-8", newline="\n")
    print("wrote", rel, "canvas", canvas)
