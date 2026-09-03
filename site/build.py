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
import base64, json, pathlib, re, sys

here = pathlib.Path(__file__).parent
PAGES = ["index.html", "build.html", "verify.html"]

# The attack page publishes a live grant's key and terms, so it can only be
# built when there IS one. src/demo-grant.json is written by
# sdk/tools/demo-card.ts, which derives every field from the grant and refuses
# if they disagree. Without it the page is skipped rather than built with
# placeholders — a page that says {{DEMO_ADDRESS}} to a stranger is worse than
# no page.
DEMO = here / "src" / "demo-grant.json"
if DEMO.exists():
    PAGES.append("attack.html")

def data_uri(p):
    return "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()

# blake2b, hex helpers and the address/splice code, shared by attack.html and
# verify.html. Injected rather than duplicated: both pages exist to be checked
# by strangers, and a second copy of a hash function is a second thing that can
# quietly disagree with the SDK.
CRYPTO = (here / "src" / "_crypto.js").read_text()
VERIFY_CORE = (here / "src" / "verify-core.js").read_text()

# The covenant template, so a browser can derive a grant's address with no node
# and no server. It carries its own address vectors, which the page re-derives
# on load and reports on — a verifier nobody can check is not a verifier.
TEMPLATE = json.dumps(
    json.loads((here.parent / "sdk" / "covenant-template.json").read_text()),
    separators=(",", ":"),
)

lockup_png = here / "assets" / "lockup-hero.png"
mark_png = here / "assets" / "mark-200.png"

flavours = {
    # self-contained, for artifact publishing
    ".": {"{{LOCKUP}}": data_uri(lockup_png), "{{MARK}}": data_uri(mark_png)},
    # file-referencing, for a real host
    "web": {"{{LOCKUP}}": "assets/lockup-hero.png", "{{MARK}}": "assets/mark-200.png"},
}
for _f in flavours.values():
    _f["{{CRYPTO}}"] = CRYPTO
    _f["{{VERIFY_CORE}}"] = VERIFY_CORE
    _f["{{COVENANT_TEMPLATE}}"] = TEMPLATE

# Files copied through untouched. They carry no placeholders, but they are
# part of what gets deployed, and a discovery document that only exists in
# src/ is a discovery document nobody fetches.
COPIES = [
    "llms.txt",
    ".well-known/mcp-manifest.json",
    ".well-known/mcp/server-card.json",
    # Deployed from web/, so the config has to BE in web/. Left one level up it
    # is simply not found, and the rewrite that serves /.well-known/mcp and the
    # content-type headers vanish without an error.
    "vercel.json",
    ".vercelignore",
    # A missing robots.txt is not neutral: a robots-respecting fetcher treats
    # a failed fetch as "disallowed" and reads nothing. For a site whose whole
    # argument is that agents can find this protocol, that is a bad way to lose.
    "robots.txt",
    "sitemap.xml",
]

# Written by sdk/tools/demo-state.ts, refreshed on a schedule. Optional by
# design: the attack page fetches it at load and stays silent when it is
# missing, so a page built without a snapshot says less rather than something
# wrong. Copied only when it exists, because a build that dies over a missing
# optional file is a build that stops shipping the pages that were fine.
STATE = here / "src" / "demo-state.json"
SRC_INDEX = here / "src" / "index.html"
if STATE.exists():
    COPIES.append("demo-state.json")


def manifest_matches(card):
    """Whether src/demo-manifest.json describes the grant on the card."""
    try:
        m = json.loads((here / "src" / "demo-manifest.json").read_text())
    except (ValueError, OSError):
        return False
    return m.get("agent") == card["agent"] and m.get("recipients_root") == card["root"]


def recipients_match(card):
    """Whether the published list is the list the card was derived from.

    Not a root check — build.py has no blake2b and no business growing one.
    demo-card.ts already hashed this list and refused if it disagreed with the
    grant; this only confirms the file on disk is that same list.
    """
    try:
        lines = (here / "src" / "demo-recipients.txt").read_text().splitlines()
    except OSError:
        return False
    members = [l.strip().lower() for l in lines if l.strip() and not l.startswith("#")]
    return members == [r.lower() for r in card["recipients"]]


def snapshot_matches(card):
    """Whether src/demo-state.json describes the grant on the card.

    A snapshot is a set of numbers with no visible owner: "3 payments, 0.3 KAS"
    reads as true of whatever address happens to be printed above it. Left over
    from an earlier grant, or hand-written to see the layout, it renders exactly
    like a real reading. So the snapshot names its grant and this checks the
    name, and a snapshot that fails the check is dropped from the build rather
    than published beside an address it never described.

    Dropped, not fatal: a stale reading should cost the page one section, not
    stop the site from shipping.
    """
    try:
        snap = json.loads(STATE.read_text())
    except (ValueError, OSError) as e:
        print(f"! src/demo-state.json unreadable ({e}); not publishing it")
        return False
    if snap.get("grant") != card["address"] or snap.get("vendor") != card["vendor"]:
        print("! src/demo-state.json does not name this grant; not publishing it.")
        print("  Take a real reading:  cd sdk && node --experimental-strip-types \\")
        print("                          tools/demo-state.ts ../site/src/demo-grant.json \\")
        print("                          --resolver \"$WARDA_RESOLVER\" > ../site/src/demo-state.json")
        return False

    # And whether the page can READ it.
    #
    # The challenge section renders only when the snapshot carries the field
    # its guard tests, and stays hidden otherwise — the right failure, because
    # a wrong number on that section is worse than no section. It is also a
    # SILENT failure: the page ships, looks fine, and the button that scrolls
    # to the challenge does nothing at all, because its target is hidden.
    #
    # That is not hypothetical. Renaming paidToVendor to spentByThisGrant in
    # the snapshot did exactly this, and the symptom reported was "the try the
    # challenge button is not working".
    guard = re.search(r'typeof st\.(\w+) !== "string"', SRC_INDEX.read_text())
    if guard and not isinstance(snap.get(guard.group(1)), str):
        print(f"! the page renders the challenge only when the snapshot has a string")
        print(f"  `{guard.group(1)}`, and src/demo-state.json does not. The section would be")
        print(f"  hidden and every link to #challenge would scroll nowhere.")
        print(f"  The field names in src/index.html and sdk/tools/demo-state.ts move together.")
        return False
    return True

# The sources are written as artifact bodies: they start at <title> and carry
# no <!doctype>, <html>, <head> or <body>, because the artifact host supplies
# those. A real web server supplies nothing — and the missing tag that matters
# is the VIEWPORT META. Without it a phone lays the page out at 980px and
# scales the result down, so every breakpoint in the CSS is present and never
# fires. The page looked responsive in a resized desktop window and was not
# responsive on a phone.
HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
"""

def as_document(html: str) -> str:
    """Wrap an artifact body in the document skeleton a web host does not add."""
    cut = html.rindex("</style>") + len("</style>")
    return HEAD + html[:cut] + "\n</head>\n<body>\n" + html[cut:] + "\n</body>\n</html>\n"

if DEMO.exists():
    # A failed `demo-card.ts > src/demo-grant.json` still leaves the file: the
    # shell creates it before the command runs. So an empty or truncated card
    # is the NORMAL result of the previous step failing, and it should say that
    # rather than raise a JSON traceback from inside the build.
    try:
        card = json.loads(DEMO.read_text())
    except (ValueError, UnicodeDecodeError) as e:
        sys.exit(
            f"src/demo-grant.json is not valid JSON ({e}).\n"
            "It is written by sdk/tools/demo-card.ts — if that command failed, this file is the "
            "empty one your shell left behind. Delete it to build without the attack page."
        )
    # This page hands strangers a private key and tells them what it controls.
    # A placeholder shipped here is not a cosmetic bug: it invites people to
    # test a claim about a grant that does not exist, and the first one who
    # checks is right to conclude the rest is theatre too.
    bad = [k for k, v in card.items()
           if isinstance(v, str) and ("SAMPLE" in v or "{{" in v)]
    if bad or not card.get("address", "").startswith(("kaspa:", "kaspatest:")):
        sys.exit(
            "refusing to build attack.html: src/demo-grant.json is not a real grant"
            + (f" (placeholder in {', '.join(bad)})" if bad else "")
            + ".\nGenerate it with sdk/tools/demo-card.ts, which derives every field from the"
            + " grant and refuses if they disagree."
        )
    demo_subs = {
        "{{DEMO_AGENT_SECRET}}": card["secret"],
        "{{DEMO_ADDRESS}}": card["address"],
        "{{DEMO_VENDOR}}": card["vendor"],
        "{{DEMO_BUDGET}}": card["budget"],
        "{{DEMO_MAX_PER_SPEND}}": card["maxPerSpend"],
        "{{DEMO_EPOCH_LIMIT}}": card["epochLimit"],
        "{{DEMO_EPOCH_LENGTH}}": card["epochLength"],
        "{{DEMO_COVENANT}}": card["covenant"],
        "{{DEMO_ROOT}}": card["root"],
        "{{DEMO_RECIPIENTS}}": json.dumps(card["recipients"]),
    }
    for k, v in demo_subs.items():
        flavours["."][k] = v
        flavours["web"][k] = v

    if STATE.exists() and not snapshot_matches(card):
        COPIES.remove("demo-state.json")

    # What a stranger needs to construct a spend: the grant's public manifest
    # and the allowlist behind its committed root. Without them the page
    # invites an attack nobody can mount — neither is on the page, and neither
    # is recoverable from chain, because P2SH reveals a redeem script only when
    # it is SPENT and this grant never has been.
    #
    # Both are checked against the card. A manifest for a different grant is
    # worse than none: the tooling would fail against the published address
    # with an error blaming the recipient list.
    for name, matches in (
        ("demo-grant.json", lambda c: True),
        ("demo-manifest.json", manifest_matches),
        ("demo-recipients.txt", recipients_match),
    ):
        if not (here / "src" / name).exists():
            print(f"! src/{name} missing — the page invites an attack nobody can attempt.")
            print("  Regenerate with:  demo-card.ts \u2026 --emit ../site/src")
        elif matches(card):
            COPIES.append(name)
        else:
            print(f"! src/{name} does not match this grant; not publishing it")

for outdir, subs in flavours.items():
    d = here / outdir
    d.mkdir(exist_ok=True)
    for name in PAGES:
        html = (here / "src" / name).read_text()
        for k, v in subs.items():
            html = html.replace(k, v)
        # Only the web flavour. The artifact host wraps the body itself, and a
        # second <html> inside its skeleton is a malformed document.
        if outdir == "web":
            html = as_document(html)
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
