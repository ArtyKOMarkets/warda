"""Builds the pages from src/, in two flavours.

The logo has to travel differently depending on where a page is served:

  artifact   published as a self-contained page where external image hosts are
             blocked by CSP, so the logo is inlined as a base64 data URI
  web        served from wardaprotocol.com, where a separate file is cacheable,
             parallel-downloadable, and keeps the HTML ~30x smaller

Sources carry {{LOCKUP}} / {{MARK}} placeholders so they stay readable and
diffable; this fills them in. Edit src/, never the output.

    python3 build.py            # both flavours
"""
import base64, pathlib, sys

here = pathlib.Path(__file__).parent
PAGES = ["index.html", "build.html"]

def data_uri(p):
    return "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()

lockup_png = here / "assets" / "lockup-hero.png"
mark_png = here / "assets" / "mark-200.png"

flavours = {
    # self-contained, for artifact publishing
    ".": {"{{LOCKUP}}": data_uri(lockup_png), "{{MARK}}": data_uri(mark_png)},
    # file-referencing, for a real host
    "web": {"{{LOCKUP}}": "assets/lockup-hero.png", "{{MARK}}": "assets/mark-200.png"},
}

# Files copied through untouched. They carry no placeholders, but they are
# part of what gets deployed, and a discovery document that only exists in
# src/ is a discovery document nobody fetches.
COPIES = [
    "llms.txt",
    ".well-known/mcp-manifest.json",
    ".well-known/mcp/server-card.json",
]

for outdir, subs in flavours.items():
    d = here / outdir
    d.mkdir(exist_ok=True)
    for name in PAGES:
        html = (here / "src" / name).read_text()
        for k, v in subs.items():
            html = html.replace(k, v)
        (d / name).write_text(html)
    for name in COPIES:
        src = here / "src" / name
        dst = d / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(src.read_bytes())
        print(f"{outdir}/{name}: {dst.stat().st_size/1024:>6.1f} KB")

# the web flavour needs the images beside it
web_assets = here / "web" / "assets"
web_assets.mkdir(parents=True, exist_ok=True)
for src in (lockup_png, mark_png):
    (web_assets / src.name).write_bytes(src.read_bytes())
print(f"web/assets: {', '.join(p.name for p in (lockup_png, mark_png))}")
