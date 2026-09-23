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

C = []
C.append(card(1, "Bring your agent", 'We fund it.<br>Then you <span class="r">try to break it</span>.',
  '<div class="terms">' + "".join(
    f'<div class="term"><span class="k">{k}</span><span class="v">{v}</span></div>'
    for k,v in [("Budget","5 testnet KAS"),("Max per payment","0.5 KAS"),
                ("Rate limit","2 per ~100s"),("Allowlist","fixed at genesis"),
                ("Term","30 days"),("Your secret","never leaves you")]) + "</div>",
  "If you break it, we publish it"))

C.append(card(2, "Live on testnet-10", 'The private key is<br><span class="t">published on the site</span>.',
  lede("Not a hash of it. The key. It holds funded testnet money, anyone can take it, and the most anyone has managed is buying one vendor&rsquo;s API a few more times."),
  "wardaprotocol.com/attack"))

C.append(card(3, "23 September 2026", 'The network<br><span class="r">said no</span>.',
  '<div class="pane no"><p class="quote">this invoice is 5000000 sompi and only <span class="hl">0 remains in the current epoch (0)</span>. The allowance refreshes as the chain advances &mdash; and cannot be refreshed by claiming an earlier epoch, which the covenant refuses.</p></div>',
  "No coin moved &middot; no fee"))

C.append(card(4, "Agent #005", 'A vendor that has<br>never heard of us.',
  rows([("demo.kaspa-x402.org","0.2 KAS &times; 5","served","ok"),
        ("attempts","8","3 did not","no"),
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

io.open("cards.html","w",encoding="utf-8").write(HEAD + "\n".join(C) + "\n</body>\n")
print("wrote", len(C), "cards")
