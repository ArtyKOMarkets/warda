"""
The toolbar icon, drawn rather than shrunk.

    python3 ops/icon.py        ->  public/icon/{16,32,48,96,128}.png

The real mark — `site/assets/warda-mark.png` — is a silver W inside a teal
shield with a four-point star. It is beautiful at 128px and gone at 16: the
strokes are one pixel of light grey, and because the artwork is
white-on-transparent it very nearly vanishes on Brave's LIGHT toolbar, which is
where the icon has to live. Shrinking the real logo was the first attempt and
it produced an invisible icon on half of all toolbars.

So this draws the same mark simplified, on a filled dark tile: the tile is what
makes the contrast independent of whatever is behind it. It lives in code
rather than as five PNGs somebody exported once, so the next person who wants
the star a little bigger can have it.

16px gets its own art — see `render(small=True)`.
"""
from pathlib import Path
from PIL import Image, ImageDraw

S = 1024  # drawn big, downsampled once
TEAL = (0x14, 0xD7, 0xC1, 255)
BRIGHT = (0x38, 0xF9, 0xE9, 255)
GROUND = (0x0A, 0x10, 0x14, 255)
EDGE = (0x1E, 0x2E, 0x37, 255)
SILVER = (0xE8, 0xEC, 0xEE, 255)


def shield(d, cx, cy, w, h, width, outline=TEAL):
    """The mark's shield: shallow centre peak, straight shoulders, a point."""
    x0, x1 = cx - w / 2, cx + w / 2
    y0, y1 = cy - h / 2, cy + h / 2
    peak = h * 0.10
    pts = [
        (cx, y0),
        (x1, y0 + peak),
        (x1, y0 + h * 0.52),
        (cx, y1),
        (x0, y0 + h * 0.52),
        (x0, y0 + peak),
    ]
    # Closed by repeating the first TWO points: `joint="curve"` only applies
    # between segments of one line(), so without the second the closing vertex
    # shows a notch that is very visible at 128px.
    d.line(pts + [pts[0], pts[1]], fill=outline, width=width, joint="curve")


def star(d, cx, cy, r, waist=0.16, fill=TEAL):
    """The concave four-point diamond at the top of the mark."""
    w = r * waist
    d.polygon(
        [(cx, cy - r), (cx + w, cy - w), (cx + r, cy), (cx + w, cy + w),
         (cx, cy + r), (cx - w, cy + w), (cx - r, cy), (cx - w, cy - w)],
        fill=fill,
    )


def wing(d, cx, cy, w, h, width):
    """The W, as two strokes — not the logo's ribbon, its shadow."""
    top, bot = cy - h / 2, cy + h / 2
    dx, r = w / 2, width / 2
    left = [(cx - dx, top), (cx - dx * 0.44, bot), (cx, top + h * 0.28)]
    right = [(cx, top + h * 0.28), (cx + dx * 0.44, bot), (cx + dx, top)]
    for path in (left, right):
        d.line(path, fill=SILVER, width=width, joint="curve")
    # PIL draws butt caps, and these strokes end in mid-air.
    for x, y in (left[0], left[1], right[1], right[2]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=SILVER)


def render(small=False):
    """`small` drops the W.

    At 16px its two strokes land on the same three grey pixels and read as a
    smudge across the shield, which is worse than not drawing it. That size
    gets a shield and a star, larger — different art for a different size is
    what icon sets are for.
    """
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=GROUND)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), outline=EDGE, width=int(S * 0.012))
    cx = S / 2
    if small:
        shield(d, cx, S * 0.50, S * 0.62, S * 0.72, int(S * 0.085))
        star(d, cx, S * 0.475, S * 0.175, fill=BRIGHT)
        return img
    shield(d, cx, S * 0.50, S * 0.56, S * 0.66, int(S * 0.055))
    star(d, cx, S * 0.395, S * 0.125, fill=BRIGHT)
    wing(d, cx, S * 0.615, S * 0.345, S * 0.215, int(S * 0.055))
    return img


if __name__ == "__main__":
    out = Path(__file__).resolve().parent.parent / "public" / "icon"
    out.mkdir(parents=True, exist_ok=True)
    master = render()
    for n in (128, 96, 48, 32):
        master.resize((n, n), Image.LANCZOS).save(out / f"{n}.png")
    render(small=True).resize((16, 16), Image.LANCZOS).save(out / "16.png")
    print(f"wrote {', '.join(str(n) for n in (16, 32, 48, 96, 128))} into {out}")
