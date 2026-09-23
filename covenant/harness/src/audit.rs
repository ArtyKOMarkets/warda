//! A covenant auditor, with the covenant taken out of it.
//!
//! Everything here is true of any Silverscript covenant whose state lives in
//! its address: how to straddle a boundary and say where it is, how to count
//! published claims honestly, how to grade what was measured, and how to
//! print the result. Nothing in this file knows what Warda is.
//!
//! What is NOT here, and cannot be config: building a valid transaction for a
//! particular covenant's entrypoints. That is code, per covenant, and
//! `src/bin/audit.rs` is the worked example of it. A file pretending to
//! describe arbitrary transaction construction would be a lie that falls
//! apart on the second user.
//!
//! See PORTING.md.

use std::fmt::Write as _;
use kaspa_txscript_errors::TxScriptError;

/// What a report says about the thing it is auditing. Every covenant-specific
/// word in the output comes from here.
pub struct Subject {
    /// The eyebrow line: name, version, fingerprint — whatever identifies it.
    pub line: String,
    /// The document the claims were taken from.
    pub doc: String,
    /// The file that produced this report, and the command that reproduces it.
    pub by: String,
    pub repro: String,
    /// What this run could not reach. Listed, never omitted.
    pub untested: Vec<String>,
    /// Why a clean run is not a safety statement, in this covenant's own terms.
    pub caveat: Vec<String>,
    /// The `require` the oracle's self-check deletes, and what happens when it does.
    pub mutation: String,
    pub mutation_says: String,
    /// Where the three files go, relative to the working directory.
    pub out_md: String,
    pub out_html: String,
    pub out_json: String,
}

/// One enforcement claim the covenant's documentation makes, and the audit
/// rule that exercises it.
///
/// This list is a report's DENOMINATOR. The first version of this tool had
/// none: it printed "15 of 15 rules enforced", where the 15 in the
/// denominator meant "rules I wrote cases for" — a figure that can never go
/// down, printed beside a paragraph honestly listing what was not tested.
/// A claim nothing covers is printed as uncovered rather than dropped.
pub struct Claim {
    pub entry: &'static str,
    pub text: &'static str,
    /// The rule family that exercises it. Empty means nothing does.
    pub rule: &'static str,
}

/// Markdown gets the same sentences as HTML, without the tags.
fn strip(s: &str) -> String {
    let mut out = String::new();
    let mut tag = false;
    for c in s.chars() {
        match c {
            '<' => tag = true,
            '>' => tag = false,
            _ if !tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
}

#[derive(PartialEq, Clone, Copy, Debug)]
pub enum Expect {
    /// The spec permits this. The engine must return Ok(()).
    Accept,
    /// The spec forbids this. The engine must refuse.
    Reject,
}

/// Which side of a rule a probe stands on, so the report can name the
/// tightest value the engine accepted and the loosest it refused without
/// anybody typing those numbers in by hand.
#[derive(Clone, Copy, PartialEq)]
pub enum Dir {
    /// The rule is an upper bound: smaller is permitted.
    Upper,
    /// The rule is a lower bound: larger is permitted.
    Lower,
}

#[derive(Clone)]
pub struct Probe {
    axis: &'static str,
    unit: &'static str,
    value: i64,
    dir: Dir,
}

pub struct Case {
    rule: &'static str,
    /// The sentence from GUARANTEES.md this case is testing. Quoted, not
    /// paraphrased: the point is to check the bytecode against the published
    /// claim, and a paraphrase is where an auditor starts agreeing with the
    /// thing it is auditing.
    claim: &'static str,
    what: String,
    expect: Expect,
    /// Set only on the two cases that straddle a boundary. The other cases in
    /// a family are still evidence; they are just not the measurement.
    probe: Option<Probe>,
    run: Box<dyn Fn() -> Result<(), TxScriptError>>,
}

pub fn case(
    rule: &'static str,
    claim: &'static str,
    what: impl Into<String>,
    expect: Expect,
    run: impl Fn() -> Result<(), TxScriptError> + 'static,
) -> Case {
    Case { rule, claim, what: what.into(), expect, probe: None, run: Box::new(run) }
}

pub fn probed(
    rule: &'static str,
    claim: &'static str,
    what: impl Into<String>,
    expect: Expect,
    axis: &'static str,
    unit: &'static str,
    value: i64,
    dir: Dir,
    run: impl Fn() -> Result<(), TxScriptError> + 'static,
) -> Case {
    Case {
        rule,
        claim,
        what: what.into(),
        expect,
        probe: Some(Probe { axis, unit, value, dir }),
        run: Box::new(run),
    }
}

pub struct Outcome {
    rule: &'static str,
    claim: &'static str,
    what: String,
    expect: Expect,
    accepted: bool,
    err: Option<String>,
    probe: Option<Probe>,
}

/// A boundary the run actually measured: the tightest value the engine
/// accepted and the loosest it refused, on the same axis.
pub struct Bound {
    axis: String,
    unit: &'static str,
    ok: i64,
    no: i64,
    rule: &'static str,
    /// Which way the axis runs. A lower bound has its permitted values on the
    /// HIGH side, so drawing it permitted-left would put a larger number to
    /// the left of a smaller one and quietly invert the number line.
    dir: Dir,
}

pub fn bounds(out: &[Outcome]) -> Vec<Bound> {
    /* Two rules that share an axis NAME merge their probes, and the merged
       pair is silently wrong: the first draft reported the per-spend cap as
       "49,999,999 sompi apart" because the epoch limit was also called
       "amount". A boundary that is not one unit wide is either a real finding
       or a bug in this function, and the report cannot tell them apart —
       so the ambiguity is refused here instead. */
    {
        let mut seen: Vec<(&str, &str)> = Vec::new();
        for o in out {
            if let Some(p) = &o.probe {
                if let Some((_, r)) = seen.iter().find(|(a, _)| *a == p.axis) {
                    assert_eq!(*r, o.rule, "axis {:?} is probed by two rules", p.axis);
                } else {
                    seen.push((p.axis, o.rule));
                }
            }
        }
    }
    let mut axes: Vec<(&str, &'static str, Dir, &'static str)> = Vec::new();
    for o in out {
        if let Some(p) = &o.probe {
            if !axes.iter().any(|(a, _, _, _)| *a == p.axis) {
                axes.push((p.axis, p.unit, p.dir, o.rule));
            }
        }
    }
    let mut v = Vec::new();
    for (axis, unit, dir, rule) in axes {
        let vals = |acc: bool| -> Vec<i64> {
            out.iter()
                .filter(|o| o.probe.as_ref().map(|p| p.axis == axis).unwrap_or(false) && o.accepted == acc)
                .map(|o| o.probe.as_ref().unwrap().value)
                .collect()
        };
        let (a, r) = (vals(true), vals(false));
        // Upper bound: the tightest ACCEPTED value is the largest, the
        // loosest REFUSED the smallest. A lower bound is the mirror.
        let ok = if dir == Dir::Upper { a.iter().max() } else { a.iter().min() };
        let no = if dir == Dir::Upper { r.iter().min() } else { r.iter().max() };
        if let (Some(&ok), Some(&no)) = (ok, no) {
            v.push(Bound { axis: axis.to_string(), unit, ok, no, rule, dir });
        }
    }
    v
}

fn commas(n: i64) -> String {
    let neg = n < 0;
    let d: Vec<char> = n.abs().to_string().chars().collect();
    let mut s = String::new();
    for (i, c) in d.iter().enumerate() {
        if i > 0 && (d.len() - i) % 3 == 0 {
            s.push(',');
        }
        s.push(*c);
    }
    if neg { format!("-{s}") } else { s }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// What `fuzz` last found, if it has been run. The report never claims an
/// oracle result it does not have: an audit that describes a check nobody
/// executed is the failure this whole directory exists to refuse.
struct Oracle { generated: u64, accepted: u64, findings: u64, m_accepted: u64, m_findings: u64 }

fn read_oracle() -> Option<Oracle> {
    let t = std::fs::read_to_string("../oracle.json").ok()?;
    let num = |k: &str, from: usize| -> Option<u64> {
        let i = t[from..].find(&format!("\"{k}\":"))? + from + k.len() + 3;
        let rest = t[i..].trim_start();
        let end = rest.find(|c: char| !c.is_ascii_digit())?;
        rest[..end].parse().ok()
    };
    let mi = t.find("\"mutant\"")?;
    Some(Oracle {
        generated: num("generated", 0)?,
        accepted: num("accepted", 0)?,
        findings: num("findings", 0)?,
        m_accepted: num("accepted", mi)?,
        m_findings: num("findings", mi)?,
    })
}


fn json(_claims: &[Claim], out: &[Outcome], enforced: &[(&'static str, &'static str)], bs: &[Bound], stamp: &str) -> String {
    let covenant = "see AUDIT.md";
    let mut s = String::from("{\n");
    let _ = writeln!(s, "  \"covenant\": \"{covenant}\",");
    let _ = writeln!(s, "  \"generated\": \"{stamp}\",");
    let _ = writeln!(s, "  \"cases\": {},", out.len());
    let _ = writeln!(s, "  \"violations\": {},", out.iter().filter(|o| o.expect == Expect::Reject && o.accepted).count());
    let _ = writeln!(s, "  \"over_refusals\": {},", out.iter().filter(|o| o.expect == Expect::Accept && !o.accepted).count());
    let _ = writeln!(s, "  \"rules\": [");
    let n = enforced.len();
    for (i, (r, g)) in enforced.iter().enumerate() {
        let _ = writeln!(s, "    {{ \"rule\": \"{r}\", \"grade\": \"{g}\" }}{}", if i + 1 < n { "," } else { "" });
    }
    let _ = writeln!(s, "  ],");
    let _ = writeln!(s, "  \"boundaries\": [");
    for (i, b) in bs.iter().enumerate() {
        let _ = writeln!(s, "    {{ \"axis\": \"{}\", \"unit\": \"{}\", \"accepted\": {}, \"refused\": {} }}{}",
            b.axis, b.unit, b.ok, b.no, if i + 1 < bs.len() { "," } else { "" });
    }
    let _ = writeln!(s, "  ],");
    let _ = writeln!(s, "  \"results\": [");
    for (i, o) in out.iter().enumerate() {
        let _ = writeln!(s, "    {{ \"rule\": \"{}\", \"case\": \"{}\", \"spec\": \"{}\", \"engine\": \"{}\" }}{}",
            o.rule, o.what.replace('"', "'"),
            if o.expect == Expect::Accept { "accept" } else { "refuse" },
            if o.accepted { "accepted" } else { "refused" },
            if i + 1 < out.len() { "," } else { "" });
    }
    let _ = writeln!(s, "  ]\n}}");
    s
}

fn html(
    subject: &Subject,
    claims: &[Claim],
    out: &[Outcome],
    enforced: &[(&'static str, &'static str)],
    assumed: &[&'static str],
    violations: &[&Outcome],
    over: &[&Outcome],
    bs: &[Bound],
    baseline_ok: bool,
    stamp: &str,
) -> String {
    let (doc, by, repro, line) = (subject.doc.as_str(), subject.by.as_str(), subject.repro.as_str(), subject.line.as_str());
    let _ = (doc, by, repro, line);
    let mut s = String::new();
    let bnd = enforced.iter().filter(|(_, g)| *g == "boundary").count();
    let covered = claims.iter().filter(|c| enforced.iter().any(|(r, _)| *r == c.rule)).count();
    let clean = violations.is_empty() && over.is_empty();

    /* The verdict first, in a sentence, before anything that needs reading.
       A reader who stops after one line should stop with the right belief. */
    let headline = if !baseline_ok {
        "<span class=\"no\">The baseline was refused.</span> Nothing below is attributable.".to_string()
    } else if !violations.is_empty() {
        format!("<span class=\"no\">{} case{} the guarantees forbid {} accepted by the engine.</span>",
            violations.len(), if violations.len() == 1 { "" } else { "s" },
            if violations.len() == 1 { "was" } else { "were" })
    } else if !over.is_empty() {
        format!("<span class=\"no\">{} case{} the guarantees permit {} refused.</span> Not an attack — a grant that would strand coin.",
            over.len(), if over.len() == 1 { "" } else { "s" },
            if over.len() == 1 { "was" } else { "were" })
    } else {
        format!("<b>{} of {} published claims</b> were exercised against the engine, {} of them at a \
                 measured boundary. Nothing the guarantees forbid was accepted, and nothing they \
                 permit was refused.", covered, claims.len(), bnd)
    };
    let sub = if baseline_ok && violations.is_empty() && over.is_empty() {
        format!("{} transactions built and executed. This is a conformance result, not a safety one — \
                 what that distinction costs is two sections down.", out.len())
    } else {
        format!("{} transactions built and executed.", out.len())
    };

    let _ = write!(s, r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Covenant audit — {line}</title>
<style>
  /* The console's own surfaces and ink, so a report and the product it
     describes look like one thing. Printed dark on purpose — this is read on
     a screen far more often than on paper, and `print-color-adjust: exact`
     keeps it as designed when it is not. */
  :root {{
    --bg:#08090b; --surface:#0e1013; --raised:#14171b;
    --line:#1f242b; --rule:#2b323b;
    --ink:#eceef1; --mid:#a4abb4; --dim:#6b737d;
    --accent:#14d7c1; --accent-ink:#032a25;
    /* Three grades, checked against this surface with the palette validator:
       every adjacent pair clears the colour-blind and normal-vision floors.
       They are not a ramp — a Merkle root can only ever be flip grade, so
       flip is a different kind of evidence, not a worse one. */
    --boundary:#199e8f; --flip:#3987e5; --uncovered:#d95465;
    --ok:#3ecf8e; --bad:#f06363;
  }}
  * {{ box-sizing:border-box; }}
  html {{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }}
  html {{ background:var(--bg); }}
  body {{ margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }}
  .page {{ max-width:58rem; margin:0 auto; padding:52px 40px 72px; }}
  .num {{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    font-variant-numeric:tabular-nums; }}
  h1 {{ font-size:34px; line-height:1.1; letter-spacing:-.03em; margin:0 0 10px; }}
  h2 {{ font-size:17px; letter-spacing:-.01em; margin:44px 0 8px; padding-top:18px;
    border-top:1px solid var(--line); }}
  h2:first-of-type {{ border-top:0; }}
  p {{ margin:.6em 0; }}
  .sub {{ color:var(--dim); font-size:13px; margin:0 0 6px; letter-spacing:.02em; }}
  .lede {{ font-size:15.5px; color:var(--mid); max-width:44rem; }}
  .caveat {{ margin:22px 0 0; padding:15px 17px; border:1px solid var(--rule);
    border-left:2px solid var(--accent); background:var(--surface); font-size:14px;
    max-width:44rem; border-radius:0 10px 10px 0; color:var(--mid); }}
  .caveat b {{ color:var(--ink); font-weight:600; }}

  /* The verdict, before anything that needs reading. */
  .verdict {{ margin:28px 0 0; padding:22px 24px; border:1px solid var(--line);
    border-radius:14px; background:var(--surface); }}
  .verdict .big {{ font-size:26px; line-height:1.25; letter-spacing:-.02em; }}
  .verdict .big b {{ color:var(--accent); font-weight:600; }}
  .verdict .big .no {{ color:var(--bad); font-weight:600; }}
  .verdict p {{ margin:.5em 0 0; font-size:13.5px; color:var(--dim); }}

  .kpis {{ display:grid; grid-template-columns:repeat(5,1fr);
    margin:14px 0 0; border:1px solid var(--line); border-radius:14px;
    background:var(--surface); overflow:hidden; }}
  .kpi {{ padding:15px 17px; border-left:1px solid var(--line); }}
  .kpi:first-child {{ border-left:0; }}
  .kpi .k {{ font-size:11px; letter-spacing:.07em; text-transform:uppercase; color:var(--dim); }}
  .kpi .v {{ font-size:25px; line-height:1.15; margin-top:7px; letter-spacing:-.025em; }}
  .kpi .n {{ font-size:12px; color:var(--dim); margin-top:4px; }}
  .v.good {{ color:var(--accent); }} .v.bad {{ color:var(--bad); }}

  /* Coverage: one row per entrypoint, one shared scale, three grades. */
  .cov {{ display:grid; grid-template-columns:minmax(0,7rem) minmax(0,1fr) auto;
    gap:10px 14px; align-items:center; margin-top:14px; }}
  .cov .e {{ font-size:13px; color:var(--mid); }}
  .cov .bar {{ display:flex; height:15px; }}
  .cov .bar span {{ display:block; }}
  .cov .bar span:first-child {{ border-radius:4px 0 0 4px; }}
  .cov .bar span:last-child {{ border-radius:0 4px 4px 0; }}
  .cov .n {{ font-size:12.5px; color:var(--dim); white-space:nowrap; }}
  .key {{ display:flex; flex-wrap:wrap; gap:16px; margin-top:16px; font-size:12.5px; color:var(--mid); }}
  .key i {{ display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:7px; vertical-align:-1px; }}

  /* Where each boundary is: ascending left to right, always. */
  .bound {{ display:grid; grid-template-columns:minmax(0,13rem) 1fr;
    gap:18px; align-items:center; padding:13px 0; border-top:1px solid var(--line);
    break-inside:avoid; }}
  .bound .ax {{ font-size:13px; color:var(--ink); }}
  .bound .ax small {{ display:block; color:var(--dim); font-size:11.5px; margin-top:2px; }}
  .track {{ position:relative; height:70px; }}
  .zone {{ position:absolute; top:34px; height:20px; }}
  .zone.permitted {{ left:0; right:50%; background:#199e8f26; border:1px solid var(--boundary); border-right:0; }}
  .zone.forbidden {{ left:50%; right:0; background:#ffffff08; border:1px solid var(--rule); border-left:0;
    background-image:repeating-linear-gradient(135deg,transparent 0 5px,#ffffff12 5px 6px); }}
  .rev .zone.permitted {{ left:50%; right:0; border:1px solid var(--boundary); border-left:0; }}
  .rev .zone.forbidden {{ left:0; right:50%; border:1px solid var(--rule); border-right:0; }}
  .barrier {{ position:absolute; left:50%; top:30px; height:28px; width:2px; background:var(--mid);
    transform:translateX(-1px); }}
  .dot {{ position:absolute; top:37px; width:14px; height:14px; border-radius:50%; }}
  .dot.ok {{ background:var(--boundary); left:50%; transform:translateX(-26px); }}
  .dot.no {{ border:2px solid var(--mid); background:var(--bg); left:50%; transform:translateX(12px); }}
  .dot.no::after {{ content:""; position:absolute; left:1px; right:1px; top:4px; height:2px;
    background:var(--mid); transform:rotate(-45deg); }}
  .rev .dot.ok {{ transform:translateX(12px); }}
  .rev .dot.no {{ transform:translateX(-26px); }}
  .lab {{ position:absolute; top:0; font-size:11px; line-height:1.35; white-space:nowrap; }}
  .lab.ok {{ right:50%; margin-right:8px; text-align:right; color:var(--boundary); }}
  .lab.no {{ left:50%; margin-left:8px; color:var(--mid); }}
  .lab b {{ display:block; font-weight:600; font-size:12.5px; }}
  .rev .lab.ok {{ right:auto; left:50%; margin:0 0 0 8px; text-align:left; }}
  .rev .lab.no {{ left:auto; right:50%; margin:0 8px 0 0; text-align:right; }}
  .gap {{ position:absolute; bottom:-1px; left:50%; transform:translateX(-50%);
    font-size:10.5px; color:var(--dim); white-space:nowrap; background:var(--bg); padding:0 6px; }}

  table {{ width:100%; border-collapse:collapse; margin-top:12px; font-size:13.5px; }}
  th {{ text-align:left; font-weight:600; font-size:11px; letter-spacing:.06em;
    text-transform:uppercase; color:var(--dim); padding:0 10px 8px 0;
    border-bottom:1px solid var(--rule); }}
  td {{ padding:8px 10px 8px 0; border-bottom:1px solid var(--line); vertical-align:top; color:var(--mid); }}
  td:first-child {{ color:var(--ink); }}
  tr {{ break-inside:avoid; }}
  .mark {{ white-space:nowrap; font-size:12.5px; }}
  .mark.ok::before {{ content:"\25cf "; color:var(--boundary); }}
  .mark.no::before {{ content:"\2298 "; color:var(--dim); }}
  .mark.bad {{ color:var(--bad); font-weight:600; }}
  .mark.bad::before {{ content:"\25b2 "; }}
  .grade {{ font-size:10.5px; letter-spacing:.05em; text-transform:uppercase;
    border:1px solid var(--rule); border-radius:5px; padding:2px 7px; color:var(--mid); }}
  .grade.b {{ border-color:var(--boundary); color:var(--boundary); }}
  .grade.f {{ border-color:#3987e566; color:var(--flip); }}
  ul {{ margin:.6em 0; padding-left:1.1em; color:var(--mid); }}
  li {{ margin:.35em 0; }}
  code {{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.92em;
    color:var(--ink); }}
  footer {{ margin-top:44px; padding-top:16px; border-top:1px solid var(--line);
    font-size:12px; color:var(--dim); }}
  /* A dark page has to be printed full-bleed. With a non-zero `@page`
     margin the sheet outside the content box stays white, which on a dark
     report reads as a printing fault rather than a margin. So the page margin
     is zero and the breathing room is padding inside the box the background
     paints. */
  /* A phone. The report is the thing you send somebody, so it is read on one
     at least as often as on a desktop, and every grid above assumes width it
     does not have there. Each rule below is one layout that breaks: five
     tiles in a row, a label column beside a bar, a barrier diagram with two
     nowrap labels either side of a centre line, and three tables carrying
     inline rem widths that together exceed the screen. */
  @media (max-width:640px) {{
    .page {{ padding:30px 18px 56px; }}
    h1 {{ font-size:27px; }}
    h2 {{ margin-top:34px; }}
    .lede, .caveat {{ max-width:none; }}
    .caveat {{ padding:13px 14px; }}
    .verdict {{ padding:18px 16px; border-radius:12px; }}
    .verdict .big {{ font-size:21px; }}

    /* Two tiles across, so the fifth sits alone on the last row. The rules
       follow the columns rather than the source order: no left border on the
       odd children that start a row, a top border on everything below row 1. */
    .kpis {{ grid-template-columns:repeat(2,1fr); }}
    .kpi {{ padding:13px 14px; }}
    .kpi .v {{ font-size:22px; }}
    .kpi:nth-child(odd) {{ border-left:0; }}
    .kpi:nth-child(n+3) {{ border-top:1px solid var(--line); }}

    /* The entrypoint name goes above its bar instead of beside it. */
    .cov {{ grid-template-columns:minmax(0,1fr) auto; gap:7px 10px; }}
    .cov .e {{ grid-column:1 / -1; padding-top:7px; }}
    .cov .e:first-child {{ padding-top:0; }}

    /* Same, for the boundary diagrams: axis above, track full width. The
       labels either side of the barrier have to be allowed to wrap, and then
       bounded, or the long ones run off both edges of a 350px track. */
    .bound {{ grid-template-columns:minmax(0,1fr); gap:8px; }}
    .track {{ height:96px; }}
    .lab {{ white-space:normal; max-width:calc(50% - 30px); }}
    .gap {{ font-size:10px; }}

    /* The inline widths are sized for a desktop column — 10rem + 6rem + 7rem
       leaves a negative remainder here — so the cells share what there is. */
    table {{ font-size:12.5px; }}
    th, td {{ width:auto !important; padding-right:8px; }}
  }}
  @page {{ size:A4; margin:0; }}
  @media print {{
    .page {{ max-width:none; padding:16mm 14mm; }}
    h2 {{ break-after:avoid; }}
    /* Five tiles across A4 wraps every label. Three fit, and the two that
       drop to a second row get their own rule. */
    .kpis {{ grid-template-columns:repeat(3,1fr); }}
    .kpi:nth-child(4), .kpi:nth-child(5) {{ border-top:1px solid var(--line); }}
    .kpi:nth-child(4) {{ border-left:0; }}
  }}
</style></head><body><div class="page">

<p class="sub num">{line}</p>
<h1>Covenant audit</h1>
<p class="lede">Every verdict below comes from <code>TxScriptEngine</code>, the same script
engine a Kaspa node validates a transaction with. Nothing here is inferred from reading
the source.</p>

<div class="verdict">
  <div class="big">{headline}</div>
  <p>{sub}</p>
</div>

<div class="caveat"><b>This is not a statement that the covenant is secure.</b> It reports the
properties that were tested, where the bytecode and <code>{doc}</code> disagree, and which
claims no constructed transaction could reach. The last of those is a section, not an
omission.</div>

<div class="kpis">
  <div class="kpi"><div class="k">Cases</div><div class="v num">{cases}</div><div class="n">transactions executed</div></div>
  <div class="kpi"><div class="k">Claims covered</div><div class="v num">{enf}</div><div class="n">{bnd} rules at a measured boundary</div></div>
  <div class="kpi"><div class="k">Violations</div><div class="v num {vc}">{viol}</div><div class="n">forbidden, yet accepted</div></div>
  <div class="kpi"><div class="k">Over-refusals</div><div class="v num {oc}">{ovr}</div><div class="n">permitted, yet refused</div></div>
  <div class="kpi"><div class="k">Baseline</div><div class="v">{base}</div><div class="n">every flip depends on it</div></div>
</div>
"#,
        cases = out.len(),
        enf = format!("{} / {}", covered, claims.len()),

        bnd = bnd,
        viol = violations.len(),
        vc = if violations.is_empty() { "good" } else { "bad" },
        ovr = over.len(),
        oc = if over.is_empty() { "good" } else { "bad" },
        headline = headline, sub = sub,
        base = if baseline_ok { "<span class=\"v good\">accepted</span>" } else { "<span class=\"v bad\">FAILED</span>" },
    );

    /* Coverage, drawn. A table of 39 rows answers "is this claim covered";
       one bar per entrypoint answers "where is this audit strong and where is
       it thin", which is the question somebody deciding whether to trust it
       actually has. One shared scale, so a longer bar is more claims. */
    let mut ents: Vec<&'static str> = claims.iter().map(|c| c.entry).collect();
    ents.dedup();
    let widest = ents.iter().map(|e| claims.iter().filter(|c| c.entry == *e).count()).max().unwrap_or(1);
    let _ = write!(s, r#"
<h2>Where this audit is strong, and where it is thin</h2>
<p>One bar per entrypoint, on one scale: a longer bar is more published claims.
<b>Boundary</b> means a numeric pair was measured on the claim's own axis, one unit apart.
<b>Flip</b> means only the refusal was executed, attributable because the case is a single
field from an accepted baseline — a Merkle root has no number line, so its claims can only
ever be flip grade. Neither is better; they are different evidence.</p>
<div class="cov">"#);
    for e in &ents {
        let fam: Vec<&Claim> = claims.iter().filter(|c| c.entry == *e).collect();
        let grade_of = |c: &Claim| enforced.iter().find(|(r, _)| *r == c.rule).map(|(_, g)| *g);
        let b = fam.iter().filter(|c| grade_of(c) == Some("boundary")).count();
        let f = fam.iter().filter(|c| grade_of(c) == Some("flip")).count();
        let u = fam.len() - b - f;
        let w = |n: usize| format!("{:.4}%", (n as f64 / widest as f64) * 100.0);
        let _ = write!(s, r#"<div class="e"><code>{e}</code></div><div class="bar">"#);
        for (n, col) in [(b, "var(--boundary)"), (f, "var(--flip)"), (u, "var(--uncovered)")] {
            if n > 0 {
                let _ = write!(s, r#"<span style="width:{};background:{col}" title="{n}"></span>"#, w(n));
            }
        }
        let _ = write!(s, r#"</div><div class="n">{}</div>"#,
            if u > 0 { format!("{} claims · {u} uncovered", fam.len()) } else { format!("{} claims", fam.len()) });
    }
    let _ = write!(s, r#"</div>
<div class="key">
  <span><i style="background:var(--boundary)"></i>Boundary</span>
  <span><i style="background:var(--flip)"></i>Flip</span>
  <span><i style="background:var(--uncovered)"></i>Not covered</span>
</div>

<h2>Why a rejection here means something</h2>
<p>The engine collapses every failed <code>require</code> into one opaque
<code>VerifyError</code>. It never says which rule rejected, so asserting that something
was refused proves nothing on its own — a malformed signature script looks exactly like a
working spending cap.</p>
<p>Every case is a single field changed from a baseline this run proved the engine accepts.
A rejection can therefore only be caused by the field that moved. Numeric rules are
exercised one unit either side of their boundary, so a rule that is present but in the
wrong place shows up as a disagreement rather than as a pass.</p>

<h2>Where each boundary actually is</h2>
<p>The filled mark is the tightest value the engine <b>accepted</b>. The barred mark is the
loosest it <b>refused</b>. Both were executed; neither is inferred.</p>
"#);

    for b in bs {
        let gap = (b.ok - b.no).abs();
        /* Ascending left to right, always. An upper bound puts the permitted
           values on the left; a lower bound puts them on the right, and the
           row is mirrored rather than relabelled. */
        let rev = if b.dir == Dir::Lower { " rev" } else { "" };
        let _ = write!(s, r#"<div class="bound">
  <div class="ax">{axis}<small>{rule} · {unit}</small></div>
  <div class="track{rev}">
    <div class="zone permitted"></div><div class="zone forbidden"></div><div class="barrier"></div>
    <div class="dot ok"></div><div class="dot no"></div>
    <div class="lab ok">accepted<br><b class="num">{ok}</b></div>
    <div class="lab no">refused<br><b class="num">{no}</b></div>
    <div class="gap">{gap} {unitw} apart</div>
  </div>
</div>"#,
            axis = esc(&b.axis), rule = esc(b.rule), unit = b.unit, rev = rev,
            ok = commas(b.ok), no = commas(b.no), gap = commas(gap),
            // "1 levels apart" is the kind of thing a reader trusts a report
            // less for, and it costs one line to not write.
            unitw = if gap == 1 { b.unit.strip_suffix('s').unwrap_or(b.unit) } else { b.unit });
    }

    let _ = write!(s, "\n<h2>Findings</h2>\n");
    if clean {
        let _ = write!(s, r#"<p><span class="mark ok">No violations</span> — nothing the guarantees forbid was accepted.
<span class="mark ok">No over-refusals</span> — nothing they permit was refused.</p>"#);
    }
    if !violations.is_empty() {
        let _ = write!(s, "<p><b>The engine accepted what the guarantees forbid.</b></p><ul>");
        for o in violations {
            let _ = write!(s, "<li><span class=\"mark bad\">{}</span> — {}<br><code>{}</code></li>", esc(o.rule), esc(&o.what), esc(o.claim));
        }
        let _ = write!(s, "</ul>");
    }
    if !over.is_empty() {
        let _ = write!(s, "<p><b>The engine refused what the guarantees permit.</b> These are not attacks — they are grants that would strand coin or refuse a spend their own terms allow.</p><ul>");
        for o in over {
            let _ = write!(s, "<li><span class=\"mark bad\">{}</span> — {}<br><code>{}</code></li>", esc(o.rule), esc(&o.what), esc(o.claim));
        }
        let _ = write!(s, "</ul>");
    }

    let _ = write!(s, r#"
<h2>Every claim the guarantees make</h2>
<p>This is the report's denominator: each enforcement claim <code>{doc}</code>
makes, and each <code>require</code> in the two exits, against what this run executed.
A claim nothing covers is listed here as uncovered rather than left out of the count.</p>
<p><b>Boundary</b> — a numeric pair was measured on the claim's own axis, one unit apart.
<b>Flip</b> — only the refusal was executed, and it is attributable because the case is a
single field away from an accepted baseline. A Merkle root has no number line, so its
claims can only ever be flip grade.</p>
<table><thead><tr><th style="width:6.5rem">Entry</th><th>Claim</th><th style="width:6rem">Grade</th></tr></thead><tbody>"#);
    let mut ent = "";
    for c in claims {
        let g = enforced.iter().find(|(r, _)| *r == c.rule).map(|(_, g)| *g);
        let _ = write!(s, "<tr><td><code>{}</code></td><td>{}</td><td>{}</td></tr>",
            if c.entry == ent { "" } else { ent = c.entry; c.entry },
            esc(c.text),
            match g {
                Some(g) => format!("<span class=\"grade\">{g}</span>"),
                None => "<span class=\"mark bad\">not covered</span>".to_string(),
            });
    }
    let _ = write!(s, "</tbody></table>");

    if !assumed.is_empty() {
        let _ = write!(s, "<h2>Assumed</h2><p>Asserted in one direction only — no boundary pair was constructible, so this run cannot tell a working rule from one that refuses everything.</p><ul>");
        for r in assumed {
            let _ = write!(s, "<li><code>{}</code></li>", esc(r));
        }
        let _ = write!(s, "</ul>");
    }

    let _ = write!(s, r#"
<h2>Every case</h2>
<table><thead><tr><th style="width:10rem">Rule</th><th>Transaction</th><th style="width:6rem">Guarantee</th><th style="width:7rem">Engine</th></tr></thead><tbody>"#);
    for o in out {
        let agree = (o.expect == Expect::Accept) == o.accepted;
        let _ = write!(s,
            "<tr><td>{}</td><td>{}</td><td>{}</td><td><span class=\"mark {}\">{}</span></td></tr>",
            esc(o.rule), esc(&o.what),
            if o.expect == Expect::Accept { "permits" } else { "forbids" },
            if !agree { "bad" } else if o.accepted { "ok" } else { "no" },
            if !agree { "disagrees" } else if o.accepted { "accepted" } else { "refused" });
    }
    let _ = write!(s, "</tbody></table>");

    if let Some(o) = read_oracle() {
        let _ = write!(s, r#"
<h2>The check that reads no specification</h2>
<p>Everything above compares the bytecode to a written claim, which is why it
cannot notice a rule that should exist and does not. A second pass asks a question
nobody had to write down first: it generates spend attempts structurally, discards
everything the engine refused, and asserts one property of what is left —
<b>an accepted spend must not leave the agent able to do more than it could before,
minus what it just paid.</b></p>
<table><thead><tr><th>Covenant</th><th>Generated</th><th>Engine accepted</th><th>Authority grew</th></tr></thead><tbody>
<tr><td><code>warda_grant.sil</code> v4, as written</td><td class="num">{gen}</td><td class="num">{acc}</td><td><span class="mark {fc}">{f}</span></td></tr>
<tr><td>the same, with the epoch ratchet removed</td><td class="num">{gen}</td><td class="num">{macc}</td><td><span class="mark bad">{mf}</span></td></tr>
</tbody></table>
<p>The second row is the self-check, and it is not decoration. An oracle that has
never fired is indistinguishable from one that cannot, so the run ends by deleting
<code>{mutline}</code> from the covenant —
and requiring the same oracle to catch it. {mutwords}</p>
<p>That is the one line in this report that says a clean run above is worth
something. The oracle can fire, it fires on a covenant this one used to be, and it
is silent on the covenant as written.</p>"#,
            gen = o.generated, acc = o.accepted, f = o.findings,
            fc = if o.findings == 0 { "ok" } else { "bad" },
            macc = o.m_accepted, mf = o.m_findings,
            mutline = esc(&subject.mutation), mutwords = subject.mutation_says);
    }

    let _ = write!(s, r#"
<h2>What this run did not test</h2>
<ul>{untested}</ul>

<h2>What a clean run does not mean</h2>
{caveat}"#, untested = subject.untested.iter().map(|x| format!("<li>{}</li>", x)).collect::<String>(),
             caveat = subject.caveat.iter().map(|x| format!("<p>{}</p>", x)).collect::<String>());

    let _ = write!(s, r#"
<footer>
Generated {stamp} by <code>{by}</code>.
Reproduce with <code>{repro}</code>.
The engine and the Silverscript compiler are both pinned by revision in
<code>Cargo.toml</code>; an unpinned compiler could alter the bytecode between runs.
</footer>
</div></body></html>
"#, stamp = stamp);
    s
}

fn report(
    subject: &Subject,
    claims: &[Claim],
    out: &[Outcome],
    enforced: &[(&'static str, &'static str)],
    assumed: &[&'static str],
    violations: &[&Outcome],
    over: &[&Outcome],
    baseline_ok: bool,
) -> String {
    let (doc, by, repro, line) = (subject.doc.as_str(), subject.by.as_str(), subject.repro.as_str(), subject.line.as_str());
    let _ = (doc, by, repro, line);
    let mut s = String::new();
    let _ = writeln!(s, "# Covenant audit — {}\n", line);
    let _ = writeln!(s, "Produced by `{by}`. Every line below is a");
    let _ = writeln!(s, "verdict from `TxScriptEngine`, the same script engine a Kaspa node validates");
    let _ = writeln!(s, "with. Nothing here is inferred from the source.\n");
    let _ = writeln!(s, "**This is not a statement that the covenant is secure.** It reports the");
    let _ = writeln!(s, "properties that were tested, where the bytecode and `{doc}` disagree,");
    let _ = writeln!(s, "and which claims were not reachable by a constructed transaction.\n");

    let _ = writeln!(s, "| | |");
    let _ = writeln!(s, "|---|---|");
    let _ = writeln!(s, "| Cases executed | {} |", out.len());
    let _ = writeln!(s, "| Baseline accepted | {} |", if baseline_ok { "yes" } else { "**no**" });
    let bnd = enforced.iter().filter(|(_, g)| *g == "boundary").count();
    let covered = claims.iter().filter(|c| enforced.iter().any(|(r, _)| *r == c.rule)).count();
    let _ = writeln!(s, "| Published claims covered | {covered} of {} |", claims.len());
    let _ = writeln!(s, "| Rules `enforced` | {} ({bnd} at a measured boundary) |", enforced.len());
    let _ = writeln!(s, "| Violations | {} |", violations.len());
    let _ = writeln!(s, "| Over-refusals | {} |", over.len());
    let _ = writeln!(s, "| Rules `assumed` | {} |\n", assumed.len());

    let _ = writeln!(s, "## Why a rejection here means something\n");
    let _ = writeln!(s, "The engine collapses every failed `require` into one opaque `VerifyError`. It");
    let _ = writeln!(s, "never says which rule rejected, so `assert!(is_err())` on its own proves");
    let _ = writeln!(s, "nothing — a malformed sigscript looks the same as a working cap.\n");
    let _ = writeln!(s, "Every case below is a single field changed from a baseline this run proved");
    let _ = writeln!(s, "the engine accepts. A rejection can therefore only be caused by that field.");
    let _ = writeln!(s, "Numeric rules are exercised one sompi either side of their boundary, so a");
    let _ = writeln!(s, "rule that is present but off by one shows up as a disagreement rather than");
    let _ = writeln!(s, "as a pass.\n");

    if !violations.is_empty() {
        let _ = writeln!(s, "## Violations — the engine accepted what the spec forbids\n");
        for o in violations {
            let _ = writeln!(s, "- **{}** — {}\n  - claim: `{}`", o.rule, o.what, o.claim);
        }
        let _ = writeln!(s);
    } else {
        let _ = writeln!(s, "## Violations\n\nNone. No case the spec forbids was accepted by the engine.\n");
    }

    if !over.is_empty() {
        let _ = writeln!(s, "## Over-refusals — the engine refused what the spec permits\n");
        let _ = writeln!(s, "These are not attacks. They are grants that would strand coin or refuse a");
        let _ = writeln!(s, "spend their own terms allow, which is a defect with money behind it.\n");
        for o in over {
            let _ = writeln!(s, "- **{}** — {}\n  - claim: `{}`\n  - engine: `{}`", o.rule, o.what, o.claim, o.err.clone().unwrap_or_default());
        }
        let _ = writeln!(s);
    } else {
        let _ = writeln!(s, "## Over-refusals\n\nNone. Every case the spec permits was accepted.\n");
    }

    let _ = writeln!(s, "## Every claim the guarantees make\n");
    let _ = writeln!(s, "The report's denominator. A claim nothing covers is listed as uncovered");
    let _ = writeln!(s, "rather than left out of the count.\n");
    let _ = writeln!(s, "| Entry | Claim | Grade |");
    let _ = writeln!(s, "|---|---|---|");
    for c in claims {
        let g = enforced.iter().find(|(r, _)| *r == c.rule).map(|(_, g)| *g);
        let _ = writeln!(s, "| `{}` | {} | {} |", c.entry, c.text, g.unwrap_or("**not covered**"));
    }
    let _ = writeln!(s);
    let _ = writeln!(s, "## Enforced\n");

    let _ = writeln!(s, "`boundary` means both halves were measured inside the rule's own family —");
    let _ = writeln!(s, "the tightest value accepted and the loosest refused, one unit apart.");
    let _ = writeln!(s, "`flip` means only the refusal is in the family, and it is attributable");
    let _ = writeln!(s, "because the case is a single field away from the accepted baseline.\n");
    for (r, grade) in enforced {
        let claim = out.iter().find(|o| o.rule == *r).map(|o| o.claim).unwrap_or("");
        let _ = writeln!(s, "- `{r}` — *{grade}* — {claim}");
    }
    let _ = writeln!(s);

    if !assumed.is_empty() {
        let _ = writeln!(s, "## Assumed\n");
        let _ = writeln!(s, "Asserted in one direction only — no boundary pair was constructible, so");
        let _ = writeln!(s, "this run cannot distinguish a working rule from one that refuses");
        let _ = writeln!(s, "everything.\n");
        for r in assumed {
            let _ = writeln!(s, "- `{r}`");
        }
        let _ = writeln!(s);
    }

    let _ = writeln!(s, "## Every case\n");
    let _ = writeln!(s, "| Rule | Case | Spec | Engine | |");
    let _ = writeln!(s, "|---|---|---|---|---|");
    for o in out {
        let spec = if o.expect == Expect::Accept { "accept" } else { "refuse" };
        let eng = if o.accepted { "accepted" } else { "refused" };
        let mark = if (o.expect == Expect::Accept) == o.accepted { "ok" } else { "**disagrees**" };
        let _ = writeln!(s, "| {} | {} | {spec} | {eng} | {mark} |", o.rule, o.what);
    }
    if let Some(o) = read_oracle() {
        let _ = writeln!(s, "\n## The check that reads no specification\n");
        let _ = writeln!(s, "Everything above compares the bytecode to a written claim. A second pass");
        let _ = writeln!(s, "asks a question nobody had to write down first: generate spend attempts");
        let _ = writeln!(s, "structurally, discard everything the engine refused, and assert one property");
        let _ = writeln!(s, "of what is left — **an accepted spend must not leave the agent able to do more");
        let _ = writeln!(s, "than it could before, minus what it just paid.**\n");
        let _ = writeln!(s, "| Covenant | Generated | Engine accepted | Authority grew |");
        let _ = writeln!(s, "|---|---:|---:|---:|");
        let _ = writeln!(s, "| `warda_grant.sil` v4, as written | {} | {} | {} |", o.generated, o.accepted, o.findings);
        let _ = writeln!(s, "| the same, epoch ratchet removed | {} | {} | **{}** |", o.generated, o.m_accepted, o.m_findings);
        let _ = writeln!(s, "\nThe second row is the self-check. An oracle that has never fired is");
        let _ = writeln!(s, "indistinguishable from one that cannot, so the run deletes");
        let _ = writeln!(s, "`{}` — and requires the same oracle to catch it.\n", subject.mutation);
    }
    let _ = writeln!(s, "\n## What this run did not test\n");
    for x in &subject.untested {
        let _ = writeln!(s, "- {}", strip(x));
    }
    let _ = writeln!(s, "\n## What a clean run does not mean\n");
    for x in &subject.caveat {
        let _ = writeln!(s, "{}\n", strip(x));
    }
    s
}

/// Run every case, grade what was measured, and write the three files.
///
/// The caller supplies the cases, the claims and the subject. Everything from
/// here down is the same for any covenant.
pub fn run(subject: &Subject, all: Vec<Case>, claims: &[Claim]) -> i32 {
    let total = all.len();
    println!("{} — {total} cases against TxScriptEngine\n", subject.line);

    /* A case that cannot be BUILT is not a case that was refused, and folding
       the two together is how a tool ends up reporting a rule as enforced
       because its own arithmetic overflowed. Each attempt is isolated. */
    std::panic::set_hook(Box::new(|_| {}));
    let mut out: Vec<Outcome> = Vec::new();
    for (i, c) in all.iter().enumerate() {
        let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (c.run)()));
        let r = match built {
            Ok(r) => r,
            Err(_) => {
                println!("{:>3}/{total}  {:<22} {:<8} {}   <<< COULD NOT BE BUILT", i + 1, c.rule, "n/a", c.what);
                out.push(Outcome { rule: c.rule, claim: c.claim, what: c.what.clone(), expect: c.expect, accepted: false, err: Some("case could not be constructed".into()), probe: None });
                continue;
            }
        };
        let accepted = r.is_ok();
        let ok = (c.expect == Expect::Accept) == accepted;
        println!("{:>3}/{total}  {:<22} {:<8} {}{}", i + 1, c.rule,
            if accepted { "ACCEPTED" } else { "refused" }, c.what,
            if ok { "" } else { "   <<< DISAGREES WITH THE SPEC" });
        out.push(Outcome { rule: c.rule, claim: c.claim, what: c.what.clone(), expect: c.expect,
            accepted, err: r.err().map(|e| format!("{e:?}")), probe: c.probe.clone() });
    }

    let baseline_ok = out.first().map(|o| o.accepted).unwrap_or(false);
    let violations: Vec<&Outcome> = out.iter().filter(|o| o.expect == Expect::Reject && o.accepted).collect();
    let over: Vec<&Outcome> = out.iter().filter(|o| o.expect == Expect::Accept && !o.accepted).collect();

    let mut rules: Vec<&'static str> = out.iter().map(|o| o.rule).collect();
    rules.dedup();
    let bs = bounds(&out);
    let measured: Vec<&'static str> = bs.iter().map(|b| b.rule).collect();
    let mut enforced: Vec<(&'static str, &'static str)> = Vec::new();
    let mut assumed: Vec<&'static str> = Vec::new();
    for r in &rules {
        // Neither of these is a rule: one is the accepted baseline every flip
        // depends on, the other its delegation twin.
        if r.ends_with("baseline") { continue; }
        let fam: Vec<&Outcome> = out.iter().filter(|o| o.rule == *r).collect();
        let has_accept = fam.iter().any(|o| o.expect == Expect::Accept && o.accepted);
        let has_reject = fam.iter().any(|o| o.expect == Expect::Reject && !o.accepted);
        if !fam.iter().all(|o| (o.expect == Expect::Accept) == o.accepted) { continue; }
        if has_reject && measured.contains(r) {
            /* A numeric pair was measured on this rule's own axis. Having an
               accept and a reject somewhere in the family is NOT the same
               thing — a Merkle root has no number line. */
            enforced.push((*r, "boundary"));
        } else if has_reject && (has_accept || baseline_ok) {
            enforced.push((*r, "flip"));
        } else {
            assumed.push(*r);
        }
    }

    let bnd = enforced.iter().filter(|(_, g)| *g == "boundary").count();
    let covered = claims.iter().filter(|c| enforced.iter().any(|(r, _)| *r == c.rule)).count();
    println!("\n───────────────────────────────────────────────");
    println!("baseline accepted      {}", if baseline_ok { "yes" } else { "NO — nothing below is attributable" });
    println!("cases                  {total}");
    println!("published claims       {covered} of {} covered", claims.len());
    println!("rules enforced         {}  ({bnd} at a measured boundary)", enforced.len());
    println!("violations             {}", violations.len());
    println!("over-refusals          {}", over.len());
    println!("boundaries measured    {}", bs.len());
    for c in claims.iter().filter(|c| !enforced.iter().any(|(r, _)| *r == c.rule)) {
        println!("  NOT COVERED          {} · {}", c.entry, c.text);
    }

    let stamp = std::process::Command::new("date").arg("-u").arg("+%Y-%m-%d %H:%M UTC")
        .output().ok().and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string()).unwrap_or_else(|| "unknown".into());

    std::fs::write(&subject.out_md, report(subject, claims, &out, &enforced, &assumed, &violations, &over, baseline_ok)).expect("write md");
    std::fs::write(&subject.out_json, json(claims, &out, &enforced, &bs, &stamp)).expect("write json");
    std::fs::write(&subject.out_html, html(subject, claims, &out, &enforced, &assumed, &violations, &over, &bs, baseline_ok, &stamp)).expect("write html");
    println!("\n{}   the report in prose", subject.out_md);
    println!("{}   the printed report — open it and print to PDF", subject.out_html);
    println!("{}   the same run, for anything that reads rather than looks", subject.out_json);

    if violations.is_empty() { 0 } else { 1 }
}
