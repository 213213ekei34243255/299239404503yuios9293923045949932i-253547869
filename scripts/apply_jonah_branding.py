"""Apply Jonah branding to a Chromium checkout (C:\\src\\chromium\\src).

Honest branding only:
  * Product name "Jonah" by CogniAI Studios, Jonah icons.
  * The browser stays honest about its engine: the user agent keeps the normal
    Chromium form ("... Chrome/156.0.0.0 Safari/537.36") and ADDS "Jonah/<ver>"
    (same pattern Edge "Edg/" and Opera "OPR/" use). Client hints list
    "Chromium" and "Jonah". Nothing claims to be "Google Chrome".
  * chrome/VERSION is NOT changed: it is the real engine version and feeds the UA.
  * No Google API keys are added; only the "API keys missing" info bar is hidden.
  * Credits to The Chromium Authors are kept.

Run:  python -I apply_jonah_branding.py <chromium src dir> <jonah assets dir>
Safe to run more than once. Every edit must match exactly, or the script stops.
"""
import io
import re
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

JONAH_VERSION = "1.5.5"
COMPANY = "CogniAI Studios"

src = Path(sys.argv[1])
assets = Path(sys.argv[2])
changed = []


def edit(rel, old, new, count=1):
    p = src / rel
    text = p.read_text(encoding="utf-8")
    if new in text and old not in text:
        print(f"  already applied: {rel}")
        return
    n = text.count(old)
    if n != count:
        sys.exit(f"ERROR {rel}: expected {count} match(es), found {n}:\n{old}")
    p.write_text(text.replace(old, new), encoding="utf-8", newline="")
    changed.append(rel)
    print(f"  edited: {rel}")


# 1. BRANDING (product/company names used for exe version info, about page, etc.)
print("1. BRANDING")
p = src / "chrome/app/theme/chromium/BRANDING"
p.write_text(
    f"COMPANY_FULLNAME={COMPANY}\n"
    f"COMPANY_SHORTNAME={COMPANY}\n"
    "PRODUCT_FULLNAME=Jonah\n"
    "PRODUCT_SHORTNAME=Jonah\n"
    "PRODUCT_INSTALLER_FULLNAME=Jonah Installer\n"
    "PRODUCT_INSTALLER_SHORTNAME=Jonah Installer\n"
    f"COPYRIGHT=Copyright 2026 {COMPANY}. Includes software Copyright The Chromium Authors.\n"
    "MAC_BUNDLE_ID=com.jonah.browser\n"
    "MAC_CREATOR_CODE=Jnah\n"
    "MAC_TEAM_ID=\n",
    encoding="utf-8", newline="\n")
changed.append("chrome/app/theme/chromium/BRANDING")

# 2. UI strings: "Chromium" -> "Jonah" in message text only (not ChromiumOS, not credits).
print("2. chromium_strings.grd")
rel = "chrome/app/chromium_strings.grd"
p = src / rel
text = p.read_text(encoding="utf-8")
text = text.replace(
    "            The Chromium Authors\n          </message>",
    f"            {COMPANY}\n          </message>", 1)
text = text.replace(
    "</ph> The Chromium Authors. All rights reserved.",
    f"</ph> {COMPANY}. Includes software Copyright The Chromium Authors.", 1)
n_total = 0


def fix_body(m):
    global n_total
    body, k = re.subn(r"\bChromium\b(?!OS| OS| Authors| open source| project)", "Jonah", m.group(2))
    n_total += k
    return m.group(1) + body + m.group(3)


text = re.sub(r"(<message\b[^>]*>)(.*?)(</message>)", fix_body, text, flags=re.S)
p.write_text(text, encoding="utf-8", newline="")
changed.append(rel)
print(f"  replaced {n_total} product-name mentions")

# 2b. Same for the shared component strings ("Chromium didn't shut down correctly.", ...).
print("2b. components_chromium_strings.grd")
rel = "components/components_chromium_strings.grd"
p = src / rel
text = p.read_text(encoding="utf-8")
n_total = 0
text = re.sub(r"(<message\b[^>]*>)(.*?)(</message>)", fix_body, text, flags=re.S)
p.write_text(text, encoding="utf-8", newline="")
changed.append(rel)
print(f"  replaced {n_total} product-name mentions")

# 3. Own profile / install folder and Windows registration names (no clash with real Chromium).
print("3. install_static")
h = "chrome/install_static/chromium_install_modes.h"
edit(h, 'kCompanyPathName[] = L"";', 'kCompanyPathName[] = L"CogniAI";')
edit(h, 'kProductPathName[] = L"Chromium";', 'kProductPathName[] = L"Jonah";')
edit(h, '.base_app_name = L"Chromium",', '.base_app_name = L"Jonah",')
edit(h, '.base_app_id = L"Chromium",', '.base_app_id = L"Jonah",')
edit(h, '.browser_prog_id_prefix = L"ChromiumHTM",', '.browser_prog_id_prefix = L"JonahHTM",')
edit(h, 'L"Chromium HTML Document",', 'L"Jonah HTML Document",')
edit(h, '.pdf_prog_id_prefix = L"ChromiumPDF",', '.pdf_prog_id_prefix = L"JonahPDF",')
edit(h, 'L"Chromium PDF Document",', 'L"Jonah PDF Document",')

# 4. Honest identity: add "Jonah" to the UA string and to the client-hint brands.
print("4. user agent")
ua = "components/embedder_support/user_agent_utils.cc"
edit(ua,
     "#if !BUILDFLAG(CHROMIUM_BRANDING)\n  brand = version_info::GetProductName();\n#endif\n",
     "  // Jonah: name the browser honestly in Sec-CH-UA / navigator.userAgentData\n"
     "  // next to \"Chromium\" (as Brave, Edge and Opera do with their own names).\n"
     "  brand = version_info::GetProductName();\n")
edit(ua,
     "  return ShouldSendUserAgentUnifiedPlatform()\n"
     "             ? BuildUnifiedPlatformUserAgentFromProduct(product)\n"
     "             : BuildUserAgentFromProduct(product);\n}",
     "  std::string user_agent =\n"
     "      ShouldSendUserAgentUnifiedPlatform()\n"
     "          ? BuildUnifiedPlatformUserAgentFromProduct(product)\n"
     "          : BuildUserAgentFromProduct(product);\n"
     "  // Jonah: identify honestly as Jonah on top of Chromium, the same way Edge\n"
     "  // (\"Edg/\") and Opera (\"OPR/\") add their own product token.\n"
     f"  user_agent += \" Jonah/{JONAH_VERSION}\";\n"
     "  return user_agent;\n}")

# 5. No Google API keys by design: do not nag about them.
print("5. API keys info bar")
edit("chrome/browser/ui/startup/infobar_utils.cc",
     "  if (!google_apis::HasAPIKeyConfigured()) {",
     "  // Jonah ships without Google API keys on purpose; skip the warning bar.\n"
     "  if (/* DISABLES CODE */ (false) && !google_apis::HasAPIKeyConfigured()) {")

# 6. Icons from the Jonah logo.
print("6. icons")
logo = Image.open(assets / "Jonah.png").convert("RGBA")
theme = src / "chrome/app/theme"


def save_png(path, size):
    img = logo.resize((size, size), Image.LANCZOS)
    img.save(path, "PNG", optimize=True)
    changed.append(str(path.relative_to(src)))


for s in (16, 24, 48, 64, 128, 256):
    save_png(theme / f"chromium/product_logo_{s}.png", s)
for s in (24, 48, 64, 128, 256):
    save_png(theme / f"chromium/linux/product_logo_{s}.png", s)
for scale, folder in ((1, "default_100_percent"), (2, "default_200_percent")):
    save_png(theme / f"{folder}/chromium/product_logo_16.png", 16 * scale)
    save_png(theme / f"{folder}/chromium/product_logo_32.png", 32 * scale)
save_png(theme / "chromium/win/tiles/Logo.png", 600)
save_png(theme / "chromium/win/tiles/SmallLogo.png", 176)

# Windows app icon: the owner's multi-size Jonah.ico (16..256 px).
shutil.copyfile(assets / "Jonah.ico", theme / "chromium/win/chromium.ico")
changed.append("chrome/app/theme/chromium/win/chromium.ico")

# SVG logo (used by some WebUI pages): wrap a 256 px PNG.
import base64
buf = io.BytesIO()
logo.resize((256, 256), Image.LANCZOS).save(buf, "PNG", optimize=True)
b64 = base64.b64encode(buf.getvalue()).decode()
(theme / "chromium/product_logo.svg").write_text(
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
    'width="256" height="256" viewBox="0 0 256 256">'
    f'<image width="256" height="256" xlink:href="data:image/png;base64,{b64}"/></svg>\n',
    encoding="utf-8", newline="\n")
changed.append("chrome/app/theme/chromium/product_logo.svg")

# Word mark "Jonah" (replaces the "Chromium" word mark images, same sizes).
font_path = Path(r"C:\Windows\Fonts\seguisb.ttf")
if not font_path.exists():
    font_path = Path(r"C:\Windows\Fonts\segoeui.ttf")
for scale, folder in ((1, "default_100_percent"), (2, "default_200_percent")):
    for suffix, colour in (("", (95, 99, 104, 255)), ("_white", (255, 255, 255, 255))):
        w, h = 97 * scale, 22 * scale
        img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        font = ImageFont.truetype(str(font_path), 18 * scale)
        box = d.textbbox((0, 0), "Jonah", font=font)
        d.text((0 - box[0], (h - (box[3] - box[1])) // 2 - box[1]), "Jonah", font=font, fill=colour)
        out = theme / f"{folder}/chromium/product_logo_name_22{suffix}.png"
        img.save(out, "PNG", optimize=True)
        changed.append(str(out.relative_to(src)))

print(f"\nDone: {len(changed)} files changed.")
