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
PAGES = ["index.html", "build.html", "verify.html", "agents.html", "start.html", "agent-001.html"]

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
# The palette and layout both agent pages share. One file, injected into
# both, because two inline copies drift the first time a colour changes.
AGENT_CSS = (here / "src" / "_agent.css").read_text()

# The four-agent diagram and the hero's live line. One implementation, injected
# into /agents and the landing page both — it was written for one and wanted on
# the other within the hour, and a second copy of a diagram is a second diagram.
GRAPH_HTML = (here / "src" / "_graph.html").read_text()
GRAPH_CSS = (here / "src" / "_graph.css").read_text()
GRAPH_JS = (here / "src" / "_graph.js").read_text()

# The site nav. Injected per page so the current one can be marked in the
# markup rather than guessed by a script at load — these are static files and
# this loop knows exactly which one it is writing.
WALLET_HTML = (here / "src" / "_wallet.html").read_text()
WALLET_CSS = (here / "src" / "_wallet.css").read_text()
WALLET_JS = (here / "src" / "_wallet.js").read_text()

QS_HTML = (here / "src" / "_quickstart.html").read_text()
QS_CSS = (here / "src" / "_quickstart.css").read_text()

NAV_HTML = (here / "src" / "_nav.html").read_text()
NAV_CSS = (here / "src" / "_nav.css").read_text()


def nav_for(page_name):
    return NAV_HTML.replace(f'data-nv="{page_name}"', f'data-nv="{page_name}" aria-current="page"')

# The timelock panel. Every grant has a notBefore, so every agent page shows
# one — but each page introduces it with its own argument, so the markup is
# injected into the per-agent intro rather than fixed above or below it.
LOCK = """  <div class="lock" id="b-lock">
    <p class="state" id="b-lockstate"><i></i><span>&mdash;</span></p>
    <p class="big" id="b-lockbig">&mdash;</p>
    <p class="sub" id="b-locksub"></p>
    <div class="track"><i id="b-lockfill"></i></div>
    <p class="ends">
      <span id="b-lockfrom">created</span>
      <span id="b-lockto">may first spend</span>
    </p>
  </div>"""

# One shell for #002, #003 and #004. They are not three pages: they are one
# grant, reported, with a different argument at the top and whichever lineage
# section its data carries. Two more copies of a 650-line page is two more
# places for a colour, a caveat or a rendering fix to land in one and not the
# others — which is the same reason the CSS came out of agent-001.html.
AGENT_TEMPLATE = (here / "src" / "agent.html").read_text()
AGENT_PAGES = {
    "002": "An agent that buys another agent's work over HTTP 402, from a grant that may pay "
           "exactly one address and could not pay it at all until a start time the network enforces.",
    "003": "An agent that replaced another one: a new key, a grant published before it could be "
           "used, and a predecessor ended by a key that was not its own.",
    "004": "A sub-agent hired by another agent rather than issued by a person, holding a bounded "
           "piece of its parent's authority that can only ever shrink and settles back when it is done.",
}

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
    _f["{{AGENT_CSS}}"] = AGENT_CSS
    _f["{{AGENT_GRAPH}}"] = GRAPH_HTML
    _f["{{AGENT_GRAPH_CSS}}"] = GRAPH_CSS
    _f["{{AGENT_GRAPH_JS}}"] = GRAPH_JS
    _f["{{NAV_CSS}}"] = NAV_CSS
    _f["{{WALLET}}"] = WALLET_HTML
    _f["{{WALLET_CSS}}"] = WALLET_CSS
    _f["{{WALLET_JS}}"] = WALLET_JS
    _f["{{QUICKSTART}}"] = QS_HTML
    _f["{{QUICKSTART_CSS}}"] = QS_CSS
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
AGENTS = [
    # (data, page, the command that writes the data)
    ("agent-001.json", "agent-001.html",
     "cd agent && node --experimental-strip-types tools/dashboard.ts \\\n"
     "    ../x402/demo/kaspa-x402-grant.json \\\n"
     "    --recipients ../x402/demo/kaspa-x402-recipients.txt > ../site/src/agent-001.json"),
    ("agent-002.json", "agent-002.html",
     "node --experimental-strip-types agents/tools/dashboard.ts \\\n"
     "    x402/demo/agent-002-grant.json --id WARDA-002 \\\n"
     "    --recipients x402/demo/agent-002-recipients.txt \\\n"
     "    --purchases agent-002/purchases > site/src/agent-002.json"),
    ("agent-003.json", "agent-003.html",
     "node --experimental-strip-types agents/tools/dashboard.ts \\\n"
     "    x402/demo/agent-003-grant.json --id WARDA-003 \\\n"
     "    --recipients x402/demo/agent-003-recipients.txt \\\n"
     "    --purchases agent-003/purchases \\\n"
     "    --succeeds x402/demo/agent-002-grant.json --succeeds-id WARDA-002 \\\n"
     "    > site/src/agent-003.json"),
    ("agent-004.json", "agent-004.html",
     "node --experimental-strip-types agents/tools/dashboard.ts \\\n"
     "    x402/demo/agent-004-grant.json --id WARDA-004 \\\n"
     "    --recipients x402/demo/agent-004-recipients.txt \\\n"
     "    --purchases agent-004/purchases \\\n"
     "    --parent x402/demo/agent-003-grant.json --parent-id WARDA-003 \\\n"
     "    > site/src/agent-004.json"),
]


def agent_publishable(data_name, page_name, how):
    """Whether an agent's JSON is something its page can render.

    The page hides itself when the data is absent or incomplete, which is the
    right failure and a silent one — it ships looking finished with one link
    that leads to an empty screen. That exact shape has now bitten this site
    twice, so the build checks each page's own requirements instead of trusting
    them: every key the renderer refuses to proceed without must be present.

    The requirements are read OUT OF THE PAGE rather than listed here, so a
    renderer that starts needing a new field starts needing it in the build on
    the same commit.

    Dropped, not fatal. A missing reading should cost one page, not the site.
    """
    data = here / "src" / data_name
    page = here / "src" / page_name
    if not data.exists():
        print(f"! src/{data_name} missing — /{page_name[:-5]} would render nothing.")
        for line in how.splitlines():
            print("  " + line)
        return False
    try:
        d = json.loads(data.read_text())
    except (ValueError, OSError) as e:
        print(f"! src/{data_name} unreadable ({e}); not publishing it")
        return False

    guard = re.search(r"if \(!d \|\| ([^)]+)\) return;", page.read_text())
    needed = re.findall(r"d\.(\w+)", guard.group(1)) if guard else []
    missing = [k for k in needed if not d.get(k)]
    if missing:
        print(f"! src/{data_name} is missing {', '.join(missing)} — the page would hide itself.")
        return False
    if not d.get("refusals"):
        print(f"! src/{data_name} carries no refusals, which are the point of the page.")
        return False
    return True


STATE = here / "src" / "demo-state.json"
SRC_INDEX = here / "src" / "index.html"
if STATE.exists():
    COPIES.append("demo-state.json")

def generate_agent_pages():
    """Write src/agent-00N.html from the one shell and each agent's intro.

    Into src/ rather than straight into the outputs, because everything after
    this — the placeholder substitution, the document wrapper, the renderer's
    own required-fields guard, which is read OUT OF THE PAGE — expects to find
    a page in src/ like any other. Generated files, in a directory whose rule
    is "edit src/, never web/"; the header in each says so.
    """
    made = []
    for n, desc in AGENT_PAGES.items():
        intro = (here / "src" / f"agent-{n}.intro.html").read_text().replace("{{LOCK}}", LOCK)
        page = (AGENT_TEMPLATE
                .replace("{{AGENT_INTRO}}", intro)
                .replace("{{AGENT_DESC}}", desc)
                .replace("{{AGENT_N}}", n))
        (here / "src" / f"agent-{n}.html").write_text(
            f"<!-- GENERATED by build.py from src/agent.html + src/agent-{n}.intro.html.\n"
            f"     Edit those two, not this file: it is overwritten on every build. -->\n"
            + page
        )
        made.append(f"agent-{n}.html")
    print(f"generated: {', '.join(made)}")
    return [f"agent-{n}.html" for n in AGENT_PAGES]



PAGES += generate_agent_pages()

for _data, _page, _how in AGENTS:
    if agent_publishable(_data, _page, _how):
        COPIES.append(_data)
    else:
        PAGES.remove(_page)


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
        # Per page, after the shared substitutions, so the active item is right.
        html = html.replace("{{NAV}}", nav_for(name))
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
