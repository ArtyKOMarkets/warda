"""
Chrome Web Store screenshots: 1280x800, composed from the real popup.

    python3 ops/preview.mjs-equivalent first, then:
    python3 ops/store-shots.py        ->  ops/store/*.png

Composed rather than cropped. A 380px popup alone on a 1280x800 canvas is
mostly empty, and the store shows these as thumbnails first — at which size the
only thing that survives is the sentence beside it. So the sentence is the
screenshot and the popup is the evidence.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
G = "/usr/share/fonts/truetype/google-fonts/"
VOID, CHROME, DIM, EDGE, TEAL = (6, 9, 12), (0xDD, 0xE0, 0xE2), (0x8D, 0x98, 0x9E), (0x1E, 0x2E, 0x37), (0x14, 0xD7, 0xC1)

SHOTS = [
    ("3-grants", "Money it can spend.\nLimits it cannot.",
     "Every limit is compiled into the grant's address. An agent that tries to exceed one does "
     "not get refused by an app — there is no valid transaction to sign."),
    ("5-issue", "Fixed at creation.\nBy everyone.",
     "Budget, per-spend cap and the list of who it may pay. Unchangeable afterwards — not by the "
     "agent, not by this console, not by you."),
    ("6-handoff", "Its key leaves.\nYours never does.",
     "The agent's key is generated once, handed over, and stored nowhere. The key that can END "
     "the grant stays here, behind a passphrase."),
    ("4-revoke", "And you can stop it.",
     "Revoking is the principal's right at any moment. What is left comes back to you, and the "
     "agent cannot spend afterwards."),
]


def compose(src: Path, head: str, sub: str, dst: Path) -> None:
    bold = ImageFont.truetype(G + "Poppins-Bold.ttf", 52)
    body = ImageFont.truetype(G + "Poppins-Light.ttf", 21)
    tiny = ImageFont.truetype(G + "Poppins-Medium.ttf", 15)

    W, H = 1280, 800
    img = Image.new("RGB", (W, H), VOID)
    d = ImageDraw.Draw(img)

    shot = Image.open(src).convert("RGBA")
    shot = shot.resize((int(shot.width * 700 / shot.height), 700), Image.LANCZOS)
    x, y = W - shot.width - 90, (H - shot.height) // 2
    img.paste(shot, (x, y), shot)
    # A hairline, so the popup reads as a window rather than a floating slab.
    d.rectangle([x - 1, y - 1, x + shot.width, y + shot.height], outline=EDGE)

    tx = 88
    lines = head.split("\n")
    ty = (H - (len(lines) * 64 + 120)) // 2
    for line in lines:
        d.text((tx, ty), line, font=bold, fill=CHROME)
        ty += 64
    ty += 22
    line = ""
    for word in sub.split(" "):
        trial = f"{line} {word}".strip()
        if d.textlength(trial, font=body) > x - tx - 70:
            d.text((tx, ty), line, font=body, fill=DIM)
            ty += 33
            line = word
        else:
            line = trial
    if line:
        d.text((tx, ty), line, font=body, fill=DIM)

    d.text((tx, H - 88), "WARDA CONSOLE", font=tiny, fill=TEAL)
    img.save(dst)


if __name__ == "__main__":
    out = HERE / "store"
    out.mkdir(exist_ok=True)
    for i, (src, head, sub) in enumerate(SHOTS, start=1):
        name = out / f"{i}-{src.split('-', 1)[1]}.png"
        compose(HERE / "preview" / f"{src}.png", head, sub, name)
        print(name.relative_to(HERE.parent))
