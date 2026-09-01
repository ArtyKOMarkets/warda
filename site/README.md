# site

Two pages, one identity.

    src/index.html   the front page — what Warda is, and one link onward
    src/build.html   the developer guide — install, code, lifecycle, limits

## Why there is a build step

The logo is embedded as a base64 `data:` URI rather than fetched, because the
pages are published as self-contained artifacts where external image hosts are
blocked. A half-megabyte blob pasted inline would make the sources unreadable
and undiffable, so they carry `{{LOCKUP}}` and `{{MARK}}` placeholders instead:

    python3 build.py index.html build.html

writes the finished pages beside the sources. Edit `src/`, never the output.

## The assets

`assets/` holds the keyed logo. The supplied transparent PNG could not be used:
it had 1,038 fully opaque pixels against 567,383 partial-alpha ones — an
automatic cut-out with halos that show on any ground. These were keyed from the
black master instead, using the fact that glow artwork on black composites
additively, so a pixel's brightness *is* its coverage:

    alpha = (max(R,G,B) - floor) / (255 - floor)

with the floor at 6, measured from the corners of the source. That drops true
black completely while keeping the teal and chrome fully opaque.

## One deliberate constraint

Both pages are single-theme. The identity is chrome-and-glow on near-black and
it does not survive a light ground — the chrome wordmark disappears into paper,
and the glow reads as grey haze. So there is no theme switch to fall through,
and every colour is painted explicitly.
