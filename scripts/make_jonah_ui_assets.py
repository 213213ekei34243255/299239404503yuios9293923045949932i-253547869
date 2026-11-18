"""Images for Jonah's own toolbar and tab strip, made from the Electron project's assets (only read).

  python -I make_jonah_ui_assets.py <electron jonah dir> <chromium src dir>

Writes chrome/app/theme/default_{100,200}_percent/jonah/*.png (1x and 2x). They are listed in
chrome/app/theme/theme_resources.grd as IDR_JONAH_*.
"""
import sys
from pathlib import Path

from PIL import Image

electron, src = Path(sys.argv[1]), Path(sys.argv[2])
theme = src / "chrome/app/theme"

# name -> (Electron asset, height in DIP at 1x, recolour to white?)
IMAGES = {
    "cogni_logo": ("assets/ss.png", 34, False),   # CogniAI Studios logo next to the clock (Electron: .cogni-logo)
    "ref_icon": ("assets/ref.png", 24, True),      # book button (Electron: .cite-icon, shown white)
}

# ---- Chromium logo pictures used by Chromium's own pages, replaced with Jonah's
import base64
import io

from PIL import ImageDraw, ImageFont

app_icon = Image.open(electron / "assets/Jonah.png").convert("RGBA")       # coloured app icon (rounded square)
line_art = Image.open(electron / "assets/logo.png").convert("RGBA")         # white whale line drawing
line_art = line_art.crop(line_art.getbbox())
font_path = Path(r"C:\Windows\Fonts\seguisb.ttf")


def wordmark(size, text_colour):
    """Jonah icon + the word 'Jonah' (replaces the Chromium logo + word, e.g. on jonah://version and error pages)."""
    w, h = size
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    img.alpha_composite(app_icon.resize((h, h), Image.LANCZOS), (0, 0))
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(str(font_path), int(h * 0.62))
    box = d.textbbox((0, 0), "Jonah", font=font)
    d.text((int(h * 1.25) - box[0], (h - (box[3] - box[1])) // 2 - box[1]), "Jonah", font=font, fill=text_colour)
    return img


for scale, folder in ((1, "default_100_percent"), (2, "default_200_percent")):
    base = src / "components/resources" / folder / "chromium"
    wordmark((171 * scale, 32 * scale), (95, 99, 104, 255)).save(base / "product_logo.png", "PNG", optimize=True)
    wordmark((171 * scale, 32 * scale), (255, 255, 255, 255)).save(base / "product_logo_white.png", "PNG", optimize=True)
    print("wrote", base / "product_logo.png", "and product_logo_white.png")

mono = line_art.resize((20, round(20 * line_art.height / line_art.width)), Image.LANCZOS)
m22 = Image.new("RGBA", (22, 22), (0, 0, 0, 0)); m22.alpha_composite(mono, (1, (22 - mono.height) // 2))
m22.save(src / "chrome/app/theme/chromium/product_logo_22_mono.png", "PNG", optimize=True)


def svg_of(img, size):
    buf = io.BytesIO(); img.resize((size * 2, size * 2), Image.LANCZOS).save(buf, "PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode()
    return (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{size}" height="{size}" '
            f'viewBox="0 0 {size} {size}"><image width="{size}" height="{size}" xlink:href="data:image/png;base64,{b64}"/></svg>\n')


# the Chromium logo used by the Extensions page and side drawers of Jonah's settings pages
(src / "ui/webui/resources/images/chrome_logo_dark.svg").write_text(svg_of(app_icon, 24), encoding="utf-8", newline="\n")
# the animated Chromium logo (What's new / first run): Jonah's icon, not animated
(src / "chrome/app/theme/chromium/product_logo_animation.svg").write_text(svg_of(app_icon, 160), encoding="utf-8", newline="\n")
print("wrote product_logo_22_mono.png, chrome_logo_dark.svg, product_logo_animation.svg")

for name, (rel, height, white) in IMAGES.items():
    img = Image.open(electron / rel).convert("RGBA")
    img = img.crop(img.getbbox())
    if white:
        alpha = img.getchannel("A")
        img = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img.putalpha(alpha)
    for scale, folder in ((1, "default_100_percent"), (2, "default_200_percent")):
        h = height * scale
        w = round(img.width * h / img.height)
        out = theme / folder / "jonah" / f"{name}.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        img.resize((w, h), Image.LANCZOS).save(out, "PNG", optimize=True)
        print(out, (w, h))
