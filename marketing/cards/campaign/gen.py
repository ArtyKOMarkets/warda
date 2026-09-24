import io, json

HEAD = """<!-- Campaign cards, 1600x900, rendered at 2x with Playwright.
     Same system as cards.html: same palette, same type, same 1600x900.
     One change: the small uppercase labels use --dim rather than --faint.
     #5D6B73 on #06090C is 3.63:1, under AA for text that size; #8D989E is
     6.76:1. Measured, not guessed.
     Every figure here comes from a published reading, a grant manifest or a
     transaction id. A card that cannot be regenerated goes stale the first
     time one of them changes.
       npm i @fontsource/barlow @fontsource/chakra-petch @fontsource/jetbrains-mono
       node shoot.mjs -->
<!doctype html><meta charset="utf-8">
<style>
@font-face{font-family:CP;src:url("node_modules/@fontsource/chakra-petch/files/chakra-petch-latin-700-normal.woff2")format("woff2");font-weight:700}
@font-face{font-family:BA;src:url("node_modules/@fontsource/barlow/files/barlow-latin-400-normal.woff2")format("woff2");font-weight:400}
@font-face{font-family:BA;src:url("node_modules/@fontsource/barlow/files/barlow-latin-600-normal.woff2")format("woff2");font-weight:600}
@font-face{font-family:JB;src:url("node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2")format("woff2");font-weight:400}
@font-face{font-family:JB;src:url("node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2")format("woff2");font-weight:700}
:root{--void:#06090C;--ground:#0A1014;--edge:#1E2E37;--edgeb:#2C4350;
--chrome:#DDE0E2;--dim:#8D989E;--teal:#14D7C1;--teald:#06BBA1;--refuse:#FF6B5A;--amber:#E8B23A}
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000}
.card{width:1600px;height:900px;background:var(--void);color:var(--chrome);
 font-family:BA,sans-serif;padding:74px 86px;position:relative;overflow:hidden;
 display:flex;flex-direction:column}
.card::after{content:"";position:absolute;inset:auto -300px -420px auto;width:900px;height:900px;
 border-radius:50%;background:radial-gradient(circle,rgba(20,215,193,.055),transparent 62%)}
.eye{font-family:JB,monospace;font-size:19px;letter-spacing:.17em;text-transform:uppercase;
 color:var(--teal);display:flex;align-items:center;gap:16px;position:relative;z-index:1}
.eye::before{content:"";width:38px;height:2px;background:var(--teald)}
h1{font-family:CP,sans-serif;font-weight:700;font-size:62px;line-height:1.06;letter-spacing:-.025em;
 margin-top:26px;max-width:24ch;position:relative;z-index:1}
h1 .t{color:var(--teal)}
h1 .r{color:var(--refuse)}
.body{flex:1;display:flex;align-items:center;margin-top:36px;position:relative;z-index:1}
.foot{display:flex;align-items:flex-end;justify-content:space-between;position:relative;z-index:1;
 font-family:JB,monospace;font-size:18px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.foot .wm{font-family:CP,sans-serif;font-weight:700;font-size:26px;letter-spacing:.02em;
 text-transform:none;color:var(--chrome)}
.foot .wm b{color:var(--teal);font-weight:700}
.pane{background:var(--ground);border:1px solid var(--edge);border-radius:14px;padding:30px 34px;width:100%}
.pane.no{border-color:rgba(255,107,90,.42)}
.quote{font-family:JB,monospace;font-size:27px;line-height:1.55;color:var(--chrome)}
.quote .hl{color:var(--refuse)}
.rows{width:100%;display:flex;flex-direction:column;gap:14px}
.row{display:flex;align-items:center;gap:26px;background:var(--ground);border:1px solid var(--edge);
 border-radius:12px;padding:20px 28px}
.row .k{font-family:JB,monospace;font-size:26px;color:var(--chrome);flex:1;letter-spacing:-.01em}
.row .v{font-family:JB,monospace;font-size:26px;color:var(--dim)}
.tag{font-family:JB,monospace;font-size:17px;letter-spacing:.14em;text-transform:uppercase;
 padding:6px 14px;border:1px solid var(--edgeb);color:var(--dim);border-radius:5px;white-space:nowrap}
.tag.ok{border-color:var(--teald);color:var(--teal)}
.tag.no{border-color:var(--refuse);color:var(--refuse)}
.terms{display:grid;grid-template-columns:1fr 1fr;gap:16px 26px;width:100%}
.term{display:flex;align-items:baseline;justify-content:space-between;gap:20px;
 border-bottom:1px solid var(--edge);padding-bottom:14px}
.term .k{font-size:27px;color:var(--dim)}
.term .v{font-family:JB,monospace;font-size:29px;color:var(--chrome)}
.stat{display:flex;align-items:baseline;gap:34px;width:100%}
.stat .n{font-family:JB,monospace;font-weight:700;font-size:150px;line-height:1;letter-spacing:-.04em}
.stat .n.t{color:var(--teal)} .stat .n.r{color:var(--refuse)}
.stat .s{font-size:30px;color:var(--dim);line-height:1.4;max-width:20ch}
.lede{font-size:31px;color:var(--dim);line-height:1.46;max-width:34ch}
.foot .credit{text-transform:none;letter-spacing:.01em;font-size:21px;color:var(--dim)}
</style><body>
"""

def card(i, eye, h1, body, foot_left):
    return f"""<div class="card" id="c{i}">
  <div class="eye">{eye}</div>
  <h1>{h1}</h1>
  <div class="body">{body}</div>
  <div class="foot"><span>{foot_left}</span><span class="wm">warda<b>protocol</b>.com</span></div>
</div>
"""

def rows(items):
    out = ['<div class="rows">']
    for k, v, tag, cls in items:
        out.append(f'<div class="row"><span class="k">{k}</span><span class="v">{v}</span>'
                   f'<span class="tag {cls}">{tag}</span></div>')
    out.append("</div>")
    return "".join(out)

def stat(n, cls, s):
    return f'<div class="stat"><span class="n {cls}">{n}</span><span class="s">{s}</span></div>'

def lede(t): return f'<p class="lede">{t}</p>'


def dag(seed=11):
    """The epoch strip: Kaspa blocks as the covenant's only unit of time.

    Three lanes rather than one chain, because Kaspa's blocks are a DAG and a
    single-file chain drawn here would be a picture of a different network.
    Two blocks carry the two payments this grant's epoch limit allows. The
    block COUNT is not to scale -- 1,000 will not fit and the bracket says so
    -- but the lanes, the pitch and the parallel edges are the shape of it.
    """
    import random
    rnd = random.Random(seed)
    W = 1428
    PITCH, BW, BH = 24, 16, 16
    LANES = [92, 128, 164]
    OFF = [0, 11, 5]
    n = (W - BW) // PITCH + 1
    paid = (14, 41)                      # bottom lane, so the pins hang clear
    o = ['<svg width="%d" height="310" viewBox="0 0 %d 310" fill="none" '
         'xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Three lanes '
         'of Kaspa blocks. A bracket across all of them is labelled one epoch, '
         '1,000 blocks. Two blocks are marked as the two payments the grant '
         'allows inside it, about 100 seconds at ten blocks a second.">' % (W, W)]

    # Edges first, so the blocks sit on top. Adjacent lanes only: every block
    # joined to every other is a hairball, not a DAG.
    for li, y in enumerate(LANES):
        for i in range(n - 1):
            x = i * PITCH + OFF[li]
            for lj, y2 in enumerate(LANES):
                if abs(lj - li) != 1 or rnd.random() > 0.36:
                    continue
                x2 = (i + 1) * PITCH + OFF[lj]
                if x2 + BW > W:
                    continue
                o.append('<path d="M%d %d L%d %d" stroke="#25404F" stroke-width="1"/>'
                         % (x + BW, y + BH / 2, x2, y2 + BH / 2))

    for li, y in enumerate(LANES):
        for i in range(n):
            x = i * PITCH + OFF[li]
            if x + BW > W:
                continue
            hit = li == 2 and i in paid
            if hit:
                o.append('<rect x="%d" y="%d" width="%d" height="%d" rx="9" '
                         'fill="#14D7C1" opacity="0.16"/>'
                         % (x - 9, y - 9, BW + 18, BH + 18))
            o.append('<rect x="%d" y="%d" width="%d" height="%d" rx="3" fill="%s" '
                     'stroke="%s" stroke-width="%s"/>'
                     % (x, y, BW, BH, "#14D7C1" if hit else "#14222B",
                        "#14D7C1" if hit else "#273C48", "2" if hit else "1"))

    # The epoch bracket, broken around its own label rather than knocked out.
    LX, RX = 512, 916          # the bracket breaks WIDE of its own label
    o.append('<path d="M1 66 L1 44 L%d 44" stroke="#06BBA1" stroke-width="2" '
             'stroke-linecap="square"/>' % LX)
    o.append('<path d="M%d 44 L1427 44 L1427 66" stroke="#06BBA1" stroke-width="2" '
             'stroke-linecap="square"/>' % RX)
    o.append('<text x="714" y="52" text-anchor="middle" fill="#14D7C1" '
             'font-family="JB, monospace" font-size="20" letter-spacing="2.6">'
             '1,000 BLOCKS = ONE EPOCH</text>')

    # What the two lit blocks are.
    for k, i in enumerate(paid):
        x = i * PITCH + OFF[2] + BW / 2
        o.append('<path d="M%s %d L%s %d" stroke="#06BBA1" stroke-width="2"/>'
                 % (x, LANES[2] + BH + 6, x, 224))
        o.append('<text x="%s" y="252" text-anchor="middle" fill="#14D7C1" '
                 'font-family="JB, monospace" font-size="18" letter-spacing="1.6">'
                 'PAYMENT %d</text>' % (x, k + 1))

    o.append('<text x="714" y="300" text-anchor="middle" fill="#8D989E" '
             'font-family="JB, monospace" font-size="20" letter-spacing="1.8">'
             'AT 10 BLOCKS A SECOND, THAT IS ~100 SECONDS</text>')
    o.append("</svg>")
    return "".join(o)


C = []
C.append(card(1, "Bring your agent", 'We fund it.<br>Then you <span class="r">try to break it</span>.',
  '<div class="terms">' + "".join(
    f'<div class="term"><span class="k">{k}</span><span class="v">{v}</span></div>'
    for k,v in [("Budget","5 testnet KAS"),("Max per payment","0.5 KAS"),
                ("Rate limit","2 per ~100s"),("Allowlist","fixed at genesis"),
                ("Term","30 days"),("Your secret","never leaves you")]) + "</div>",
  "If you break it, we publish it"))

C.append(card(2, "Live on testnet-10", 'The private key is<br><span class="t">published on the site</span>.',
  lede("Not a hash of it. The key. It has held funded testnet money since 2 September and anyone can take it &mdash; all it can buy is one vendor&rsquo;s API, 0.1 KAS at a time."),
  "wardaprotocol.com/attack"))

# Card 3 was "The network said no", quoting a refusal the network never saw:
# that message is thrown client-side by payNow() in the SDK, before anything is
# built or broadcast. The audit is the enforcement evidence that actually
# survives the question "who decided?" — every verdict in it comes from
# TxScriptEngine, the engine a Kaspa node validates with. Figures from
# covenant/audit.json (118 cases, 0 violations, 0 over-refusals).
C.append(card(3, "Covenant audit &middot; v4", 'We didn&rsquo;t grade this.<br><span class="t">The node&rsquo;s engine did</span>.',
  rows([("Transactions executed","118","TxScriptEngine",""),
        ("Forbidden, but accepted","0","violations","ok"),
        ("Permitted, but refused","0","over-refusals","ok")]),
  "Not a statement that it is secure"))

C.append(card(4, "Agent #005", 'A vendor that has<br>never heard of us.',
  rows([("demo.kaspa-x402.org","0.2 KAS &times; 6","served","ok"),
        ("attempts","9","3 did not","no"),
        ("who runs it","not us","third party","")]),
  "Unattended, every morning"))

C.append(card(5, "18 September 2026", 'Paid, and<br><span class="r">never served</span>.',
  rows([("285057ed7d6b63e5&hellip;","0.2 KAS","settled","ok"),
        ("what came back","nothing","not served","no"),
        ("where it is published","/agent-005","beside the wins","")]),
  "The receipts include the failures"))

C.append(card(6, "Agent #004", 'Hired by an agent,<br>not by a person.',
  rows([("hired by","agent #003","parent","ok"),
        ("authority","could only shrink","never grow",""),
        ("spent, then settled back","0.04 KAS","returned","ok")]),
  "Delegation the chain enforces"))

C.append(card(7, "Agent #011", 'A key no machine<br>of ours has held.',
  rows([("created in","a signing enclave","never exported","ok"),
        ("first purchase","fa5dfe7282d87fe3&hellip;","served","ok"),
        ("what the custodian cannot do","exceed the grant","","no")]),
  "The bound is not ours to relax"))

C.append(card(8, "Agent #002", 'Refused by its<br>own <span class="r">start time</span>.',
  lede("Twice, before it could spend anything. Not a scheduler and not a feature flag &mdash; a transaction the network would not count as valid yet."),
  "notBefore, enforced by consensus"))

C.append(card(9, "The audit", stat("118","t","transactions run through the same script engine a Kaspa node validates with"),
  '<div class="terms">' + "".join(
    f'<div class="term"><span class="k">{k}</span><span class="v">{v}</span></div>'
    for k,v in [("Claims exercised","38 of 39"),("Violations","0"),
                ("Over-refusals","0"),("The 39th","named, uncovered")]) + "</div>",
  "wardaprotocol.com/audit"))

C.append(card(10, "What our own tool cannot find", 'It would have caught<br><span class="r">zero of five</span>.',
  lede("We built a tool that checks a covenant against its own claims, then checked it against the five real vulnerabilities we have found in ours. A claims test cannot find the rule you never wrote."),
  "So we built a different one"))

C.append(card(11, "The limit we cannot enforce", 'The allowlist stops<br>at the relay hop.',
  lede("x402&rsquo;s exact scheme cannot take a covenant spend, so agent #005 pays a single-use key and that key pays the vendor. Budget, cap and rate limit still hold. The allowlist does not reach past it."),
  "Stated on the page, not discovered"))

C.append(card(12, "Every Monday", 'An agent hires<br>an agent.',
  rows([("given a budget","agent #009","orchestrator","ok"),
        ("hired with part of it","agent #010","scout","ok"),
        ("unspent, taken back","then revoked","ends itself","")]),
  "Nobody presses anything"))

C.append(card(13, "What your agent gets", 'Limits it cannot<br>argue with.',
  '<div class="terms">' + "".join(
    f'<div class="term"><span class="k">{k}</span><span class="v">{v}</span></div>'
    for k,v in [("Total budget","5 KAS"),("Per payment","0.5 KAS max"),
                ("Rate","2 per ~100s"),("Payees","allowlist, fixed"),
                ("Expiry","30 days"),("Enforced by","every Kaspa node")]) + "</div>",
  "wardaprotocol.com/grant"))

C.append(card(14, "Why we are asking", 'No third party<br>has audited this.',
  lede("It has never held real money. Which is exactly why we would rather your agent attacked it than ours kept proving it works. Bring one. We will fund it. If you break it, we publish it."),
  "wardaprotocol.com/grant"))

# Card 15 is not part of the fourteen: it is the credit post, inserted into the
# run whenever it is posted. Figures: `wc -l covenant/warda_grant.sil` and the
# deployed size DEPLOYED.md records for testnet-10 (3,036 bytes, rusty-kaspa
# v2.0.1). Handles verified before use \u2014 @OriNewman designed Silverscript,
# @MichaelSuttonIL wrote the Toccata covenants outlook, @hashdag is Kaspa's
# founder. A mistagged credit post is worse than no credit post.
C.append(card(15, "Built on Kaspa &middot; testnet-10", 'Our rate limit<br><span class="t">has no clock</span>.',
  dag(),
  '<span class="credit">@OriNewman &middot; @MichaelSuttonIL &middot; @hashdag</span>'))

io.open("cards.html","w",encoding="utf-8").write(HEAD + "\n".join(C) + "\n</body>\n")
print("wrote", len(C), "cards")
