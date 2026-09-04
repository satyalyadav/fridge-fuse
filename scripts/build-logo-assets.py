#!/usr/bin/env python3
"""Derive the served logo assets from the committed artwork.

Run after replacing public/logo-source.jpg:  python3 scripts/build-logo-assets.py

The source is a flat two-tone JPEG — maroon artwork on a cream card — so alpha
is recovered from how dark each pixel is against that card, and the colour is
then repainted in the exact brand value. That keeps the edges smooth and lets
one drawing serve a maroon mark, a gold mark for the maroon top bar, and a
cream mark for the maroon hero, without three hand-made files drifting apart.
"""
from PIL import Image, ImageDraw
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "public" / "logo-source.jpg"
OUT = ROOT / "public"

MAROON = (140, 29, 64)
GOLD = (255, 198, 39)
CREAM = (255, 250, 244)

GLYPH_BOX = (474, 174, 934, 500)    # the fridge mark alone
LOCKUP_BOX = (440, 150, 970, 700)   # mark, wordmark and tagline


def silhouette(box):
    """Alpha from ink density, so any brand colour can be painted into it."""
    im = Image.open(SRC).convert("RGB").crop(box)
    grey = im.convert("L")
    # The card is ~248; the ink is ~60. Anything lighter than the card is empty.
    alpha = grey.point(lambda v: max(0, min(255, int((238 - v) * 255 / 178))))
    return alpha.crop(alpha.getbbox())


def painted(alpha, colour, pad=0):
    layer = Image.new("RGBA", alpha.size, colour + (0,))
    layer.putalpha(alpha)
    if not pad:
        return layer
    out = Image.new("RGBA", (alpha.width + pad * 2, alpha.height + pad * 2), (0, 0, 0, 0))
    out.paste(layer, (pad, pad), layer)
    return out


def save(image, name, width=None):
    if width:
        height = round(image.height * width / image.width)
        image = image.resize((width, height), Image.LANCZOS)
    # One flat colour over an alpha ramp: a small palette keeps the edges smooth
    # at a fraction of the bytes of full RGBA.
    image = image.quantize(colors=32, method=Image.FASTOCTREE)
    image.save(OUT / name, optimize=True)
    size_kb = (OUT / name).stat().st_size / 1024
    print(f"{name}: {image.width}x{image.height}, {size_kb:.1f} KB")


glyph = silhouette(GLYPH_BOX)
lockup = silhouette(LOCKUP_BOX)

save(painted(glyph, MAROON), "logo-mark.png", 256)
save(painted(glyph, GOLD), "logo-mark-gold.png", 256)
save(painted(lockup, CREAM), "logo-lockup-light.png", 560)
save(painted(lockup, MAROON), "logo-lockup.png", 560)

# Favicon: gold field, maroon mark — legible in a light or a dark tab strip.
for size, name in ((32, "favicon-32.png"), (180, "apple-touch-icon.png")):
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    radius = round(size * 0.22)
    ImageDraw.Draw(tile).rounded_rectangle([0, 0, size - 1, size - 1], radius, fill=GOLD + (255,))
    mark = painted(glyph, MAROON)
    inner = round(size * 0.66)
    mark = mark.resize((round(mark.width * inner / mark.height), inner), Image.LANCZOS)
    tile.paste(mark, ((size - mark.width) // 2, (size - inner) // 2), mark)
    tile.save(OUT / name, optimize=True)
    print(f"{name}: {size}x{size}, {(OUT / name).stat().st_size / 1024:.1f} KB")
