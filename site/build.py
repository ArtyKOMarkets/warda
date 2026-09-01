"""Injects the logo data URIs into the page sources.

The pages are written with {{LOCKUP}} / {{MARK}} placeholders rather than
half-megabyte base64 blobs inline, so they stay readable and diffable in the
repo. This substitutes them at build time.
"""
import sys, pathlib
here = pathlib.Path(__file__).parent
lockup = (here / "assets" / "lockup.uri").read_text().strip()
mark = (here / "assets" / "mark.uri").read_text().strip()
for name in sys.argv[1:]:
    src = here / "src" / name
    out = here / name
    html = src.read_text().replace("{{LOCKUP}}", lockup).replace("{{MARK}}", mark)
    out.write_text(html)
    print(f"{name}: {len(html)/1024:.0f} KB")
