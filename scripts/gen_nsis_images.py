from PIL import Image, ImageDraw, ImageFont
import json

with open(f"package.json", "r", encoding="utf-8") as f:
    _pkg = json.load(f)
APP_VERSION = _pkg.get("version", "")
OUT_DIR = f"src-tauri/nsis/assets"

# Load source assets
dragon = Image.open(f"src-tauri/icons/128x128.png").convert("RGBA")
ora = Image.open(f"public/dragonfruit_assets/branding/open_resin_alliance_logo_darkmode.png").convert("RGBA")


def load_font(*paths, size):
    for path in paths:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


# Fonts
font_bold = load_font("C:/Windows/Fonts/segoeuib.ttf", size=16)
font_regular = load_font("C:/Windows/Fonts/segoeui.ttf", size=14)
font_small = load_font("C:/Windows/Fonts/segoeui.ttf", size=12)
font_footer = load_font(
    "C:/Windows/Fonts/seguisb.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    size=16,
)

# Colors
BG_DARK = (22, 22, 38)        # #161626
ACCENT = (186, 247, 46)        # #baf72e
WHITE = (255, 255, 255)
DIM = (160, 160, 180)
FOOTER = (214, 214, 230)


def paint_brand_gradient(draw, width, height):
    """Paint the shared DragonFruit installer gradient."""
    for y in range(height):
        t = y / height
        r = int(BG_DARK[0] * (1 - t) + 30 * t)
        g = int(BG_DARK[1] * (1 - t) + 12 * t)
        b = int(BG_DARK[2] * (1 - t) + 45 * t)
        draw.line([(0, y), (width, y)], fill=(r, g, b))


def paste_logo(canvas, logo, cx, cy, size):
    """Paste logo centered at (cx, cy) with given size."""
    logo_resized = logo.resize((size, size), Image.Resampling.LANCZOS)
    x = cx - size // 2
    y = cy - size // 2
    canvas.paste(logo_resized, (x, y), logo_resized)

# ── HEADER: 150 × 57 ─────────────────────────────────────────────────────────
W_H, H_H = 150, 57
header = Image.new("RGB", (W_H, H_H), BG_DARK)
draw = ImageDraw.Draw(header)

# Accent line at bottom edge
draw.line([(0, H_H - 1), (W_H, H_H - 1)], fill=ACCENT, width=2)

# Dragon logo on left, vertically centered
LOGO_SIZE = 38
paste_logo(header, dragon, LOGO_SIZE // 2 + 8, H_H // 2 - 1, LOGO_SIZE)

# "DragonFruit" + "Installer" text block, truly vertically centered
tx = LOGO_SIZE + 13  # Start of text block, with some padding after logo
title_text = "DragonFruit"
subtitle_text = f"Installer {APP_VERSION}" if APP_VERSION else "Installer"

title_bbox = draw.textbbox((0, 0), title_text, font=font_bold)
subtitle_bbox = draw.textbbox((0, 0), subtitle_text, font=font_regular)
title_h = title_bbox[3] - title_bbox[1]
subtitle_h = subtitle_bbox[3] - subtitle_bbox[1]
line_gap = 4

# Keep the text centered within the content region above the bottom accent line.
content_h = H_H - 14
text_block_h = title_h + line_gap + subtitle_h
text_block_top = max(0, (content_h - text_block_h) // 2)

draw.text((tx, text_block_top), title_text, font=font_bold, fill=WHITE)
draw.text((tx, text_block_top + title_h + line_gap), subtitle_text, font=font_regular, fill=ACCENT)

header.convert("RGB").save(f"{OUT_DIR}/header.bmp", format="BMP")
print(f"Header saved: {header.size}")

# ── SIDEBAR: 164 × 314 ───────────────────────────────────────────────────────
W_S, H_S = 164, 314

# Vertical gradient: dark navy at top, slightly deeper purple-dark at bottom
sidebar = Image.new("RGB", (W_S, H_S), BG_DARK)
draw = ImageDraw.Draw(sidebar)

paint_brand_gradient(draw, W_S, H_S)

LOGO_SIZE_S = 90  # Both logos same size

# Dragon logo - upper area, centered
dragon_cy = H_S // 3 - 20
paste_logo(sidebar, dragon, W_S // 2, dragon_cy, LOGO_SIZE_S)

# ORA logo - lower area, centered, same visual size as dragon
ora_cy = (H_S * 2) // 3 + 20
paste_logo(sidebar, ora, W_S // 2, ora_cy, LOGO_SIZE_S)

# Accent line on right edge
# draw.line([(W_S - 2, 0), (W_S - 2, H_S)], fill=ACCENT, width=2)

sidebar.convert("RGB").save(f"{OUT_DIR}/sidebar.bmp", format="BMP")
print(f"Sidebar saved: {sidebar.size}")

# ── DMG BACKGROUND: 660 × 400 ────────────────────────────────────────────────
W_D, H_D = 660, 400
dmg_bg = Image.new("RGB", (W_D, H_D), BG_DARK)
draw = ImageDraw.Draw(dmg_bg)

paint_brand_gradient(draw, W_D, H_D)

footer_text = "Open Resin Alliance  -  AGPL-3.0-or-later"
footer_bbox = draw.textbbox((0, 0), footer_text, font=font_footer)
footer_w = footer_bbox[2] - footer_bbox[0]
footer_h = footer_bbox[3] - footer_bbox[1]
footer_x = (W_D - footer_w) // 2
footer_y = H_D - footer_h - 18

draw.text((footer_x, footer_y), footer_text, font=font_footer, fill=FOOTER)

dmg_bg.save(f"{OUT_DIR}/dmg-background.png", format="PNG")
print(f"DMG background saved: {dmg_bg.size}")

print("Done.")
