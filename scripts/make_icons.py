"""Puts the owner's app icon (D:/Jonah-Chromium/downloads/jonah-app-icon.png, 1024x1024, given 2026-11-18) into every Chromium icon file
Jonah's Windows and Mac builds use.

  python make_icons.py <icon.png> <chromium src>

Windows: chrome/app/theme/chromium/win/chromium.ico (exe, taskbar, shortcuts: 16-256 px), win/tiles/Logo.png + SmallLogo.png (Start menu tile),
         product_logo_*.png (+ linux copies, the 22 px mono one), product_logo.svg (the PNG wrapped in an SVG).
Mac:     chrome/app/theme/chromium/mac/app.icns (16-1024 px), Assets.xcassets/AppIcon.appiconset/appicon_*.png, Icon.iconset/*.png.
         (Assets.car - the compiled form of Assets.xcassets the Mac app ships - can only be made by Apple's actool on a Mac:
          scripts/mac/build-jonah-mac.sh does it before building.)
"""
import base64, io, sys
from pathlib import Path
from PIL import Image

src, chromium = Path(sys.argv[1]), Path(sys.argv[2])
theme = chromium / "chrome/app/theme/chromium"
icon = Image.open(src).convert("RGBA")
assert icon.size[0] == icon.size[1] and icon.size[0] >= 512, icon.size


def tiny(n):
    """16 / 24 px: the whale's fine lines blur away inside the full tile, so zoom in on the whale (less empty tile) and sharpen a little."""
    from PIL import ImageDraw, ImageFilter
    x0, y0, x1, y1 = icon.split()[0].point(lambda v: 255 if v > 90 else 0).getbbox()  # the purple whale (the tile is black)
    s = max(x1 - x0, y1 - y0); cx, cy = (x0 + x1) // 2, (y0 + y1) // 2; pad = int(s * 0.06)
    crop = icon.crop((cx - s // 2 - pad, cy - s // 2 - pad, cx + s // 2 + pad, cy + s // 2 + pad))
    big = n * 8
    bg = Image.new("RGBA", (big, big), (0, 0, 0, 255))
    bg.alpha_composite(crop.resize((big, big), Image.LANCZOS))
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=int(big * 0.22), fill=255)
    tile = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    tile.paste(bg, (0, 0), mask)
    return tile.resize((n, n), Image.LANCZOS).filter(ImageFilter.UnsharpMask(radius=0.6, percent=120, threshold=1))


def sized(n):
    return tiny(n) if n <= 24 else icon.resize((n, n), Image.LANCZOS)


def save_png(path, n):
    sized(n).save(path, "PNG", optimize=True)
    print(f"{n:5} px  {path.relative_to(chromium)}")


# ---- Windows
ico_sizes = [16, 24, 32, 48, 64, 72, 96, 128, 256]
# each size drawn on its own (the small ones are the sharpened close-up), then written as one .ico
frames = [sized(n) for n in ico_sizes]
frames[-1].save(theme / "win/chromium.ico", format="ICO", sizes=[(n, n) for n in ico_sizes], append_images=frames[:-1])
print("  ico    chrome/app/theme/chromium/win/chromium.ico", ico_sizes)
save_png(theme / "win/tiles/Logo.png", 600)
save_png(theme / "win/tiles/SmallLogo.png", 176)
for n in (16, 24, 48, 64, 128, 256):
    save_png(theme / f"product_logo_{n}.png", n)
for n in (24, 48, 64, 128, 256):
    save_png(theme / f"linux/product_logo_{n}.png", n)
# the logo copies packed into the browser's resources (About page, Mac install dialog...): 100% and 200% screens
for scale, mult in (("default_100_percent", 1), ("default_200_percent", 2)):
    for n in (16, 32):
        save_png(chromium / f"chrome/app/theme/{scale}/chromium/product_logo_{n}.png", n * mult)
# 22 px monochrome (used where the system wants a single-colour mark): the whale's shape in white
mono = sized(22)
px = mono.load()
for y in range(22):
    for x in range(22):
        r, g, b, a = px[x, y]
        # the purple whale is the mark; the black tile and the transparent corners are not
        px[x, y] = (255, 255, 255, a if (r + b) > 180 and a > 0 else 0)
mono.save(theme / "product_logo_22_mono.png", "PNG", optimize=True)
print("   22 px  chrome/app/theme/chromium/product_logo_22_mono.png (mono)")
buf = io.BytesIO()
sized(256).save(buf, "PNG", optimize=True)
svg = ('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="256" height="256" viewBox="0 0 256 256">'
       f'<image width="256" height="256" xlink:href="data:image/png;base64,{base64.b64encode(buf.getvalue()).decode()}"/></svg>\n')
(theme / "product_logo.svg").write_text(svg, encoding="utf-8")
print("  svg    chrome/app/theme/chromium/product_logo.svg")

# ---- Mac. The icon is already a rounded tile; Apple's app-icon grid puts that tile at 824 of 1024 px with a margin, so it sits the same
# size as the other icons in the Dock and Finder (a full-bleed tile looks oversized there).
mac = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
mac.alpha_composite(icon.resize((824, 824), Image.LANCZOS), (100, 100))
mac.save(theme / "mac/app.icns", format="ICNS")
print("  icns   chrome/app/theme/chromium/mac/app.icns (16-1024, Apple grid)")
for n in (16, 32, 64, 128, 256, 512, 1024):
    p = theme / f"mac/Assets.xcassets/AppIcon.appiconset/appicon_{n}.png"
    mac.resize((n, n), Image.LANCZOS).save(p, "PNG", optimize=True)
    print(f"{n:5} px  {p.relative_to(chromium)}")
mac.resize((256, 256), Image.LANCZOS).save(theme / "mac/Assets.xcassets/Icon.iconset/icon_256x256.png", "PNG", optimize=True)
mac.resize((512, 512), Image.LANCZOS).save(theme / "mac/Assets.xcassets/Icon.iconset/icon_256x256@2x.png", "PNG", optimize=True)
print("  Icon.iconset 256 / 512")
print("done")
