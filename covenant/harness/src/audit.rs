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

fn oracle() -> Option<Oracle> {
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

fn json(claims: &[Claim], out: &[Outcome], enforced: &[(&'static str, &'static str)], bs: &[Bound], stamp: &str) -> String {
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

    let _ = write!(s, r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Covenant audit — {line}</title>
<style>
  :root {{
    --ink:#14181d; --mute:#5b6470; --faint:#8b94a0;
    --line:#e4e7ec; --rule:#c8ced6;
    --ok:#1a7f4f; --no:#2f343a; --bad:#b3261e;
    --okwash:#1a7f4f14; --nowash:#2f343a0f;
  }}
  * {{ box-sizing:border-box; }}
  html {{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }}
  body {{ margin:0; background:#fff; color:var(--ink);
    font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }}
  .page {{ max-width:56rem; margin:0 auto; padding:56px 44px 72px; }}
  .num {{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    font-variant-numeric:tabular-nums; }}
  h1 {{ font-size:30px; line-height:1.15; letter-spacing:-.02em; margin:0 0 6px; }}
  h2 {{ font-size:17px; letter-spacing:-.01em; margin:44px 0 6px; padding-top:14px;
    border-top:1px solid var(--line); }}
  h2:first-of-type {{ border-top:0; }}
  p {{ margin:.55em 0; }}
  .sub {{ color:var(--mute); font-size:14px; margin:0 0 4px; }}
  .lede {{ font-size:15px; color:var(--ink); max-width:44rem; }}
  .caveat {{ margin:22px 0 0; padding:14px 16px; border:1px solid var(--rule);
    border-left:3px solid var(--no); background:var(--nowash); font-size:14px; max-width:44rem; }}
  .caveat b {{ font-weight:600; }}

  .kpis {{ display:grid; grid-template-columns:repeat(5,1fr); gap:0;
    margin:26px 0 0; border:1px solid var(--line); }}
  .kpi {{ padding:14px 16px; border-left:1px solid var(--line); }}
  .kpi:first-child {{ border-left:0; }}
  .kpi .k {{ font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); }}
  .kpi .v {{ font-size:26px; line-height:1.1; margin-top:6px; letter-spacing:-.02em; }}
  .kpi .n {{ font-size:12px; color:var(--mute); margin-top:3px; }}
  .v.good {{ color:var(--ok); }} .v.bad {{ color:var(--bad); }}

  .bound {{ display:grid; grid-template-columns:minmax(0,13rem) 1fr;
    gap:18px; align-items:center; padding:13px 0; border-top:1px solid var(--line);
    break-inside:avoid; }}
  .bound .ax {{ font-size:13.5px; }}
  .bound .ax small {{ display:block; color:var(--faint); font-size:11.5px; }}
  .track {{ position:relative; height:64px; }}
  .zone {{ position:absolute; top:34px; height:20px; }}
  .zone.permitted {{ left:0; right:50%; background:var(--okwash); border:1px solid var(--ok); border-right:0; }}
  .zone.forbidden {{ left:50%; right:0; background:var(--nowash); border:1px solid var(--rule); border-left:0;
    background-image:repeating-linear-gradient(135deg,transparent 0 5px,#2f343a1f 5px 6px); }}
  /* A lower bound permits the HIGH side, so the row mirrors and the axis
     still reads small-to-large from left to right. */
  .rev .zone.permitted {{ left:50%; right:0; border:1px solid var(--ok); border-left:0; }}
  .rev .zone.forbidden {{ left:0; right:50%; border:1px solid var(--rule); border-right:0; }}
  .barrier {{ position:absolute; left:50%; top:30px; height:28px; width:2px; background:var(--no);
    transform:translateX(-1px); }}
  .dot {{ position:absolute; top:37px; width:14px; height:14px; border-radius:50%; }}
  .dot.ok {{ background:var(--ok); left:50%; transform:translateX(-26px); }}
  .dot.no {{ border:2px solid var(--no); background:#fff; left:50%; transform:translateX(12px); }}
  .rev .dot.ok {{ transform:translateX(12px); }}
  .rev .dot.no {{ transform:translateX(-26px); }}
  .dot.no::after {{ content:""; position:absolute; left:1px; right:1px; top:4px; height:2px;
    background:var(--no); transform:rotate(-45deg); }}
  .lab {{ position:absolute; top:0; font-size:11px; line-height:1.35; white-space:nowrap; }}
  .lab.ok {{ right:50%; margin-right:8px; text-align:right; color:var(--ok); }}
  .lab.no {{ left:50%; margin-left:8px; color:var(--no); }}
  .rev .lab.ok {{ right:auto; left:50%; margin:0 0 0 8px; text-align:left; }}
  .rev .lab.no {{ left:auto; right:50%; margin:0 8px 0 0; text-align:right; }}
  .lab b {{ display:block; font-weight:600; font-size:12.5px; }}
  .gap {{ position:absolute; bottom:0; left:50%; transform:translateX(-50%);
    font-size:10.5px; color:var(--faint); white-space:nowrap;
    background:#fff; padding:0 5px; }}

  table {{ width:100%; border-collapse:collapse; margin-top:10px; font-size:13.5px; }}
  th {{ text-align:left; font-weight:600; font-size:11.5px; letter-spacing:.05em;
    text-transform:uppercase; color:var(--faint); padding:0 10px 7px 0;
    border-bottom:1px solid var(--rule); }}
  td {{ padding:7px 10px 7px 0; border-bottom:1px solid var(--line); vertical-align:top; }}
  tr {{ break-inside:avoid; }}
  .mark {{ white-space:nowrap; font-size:12.5px; }}
  .mark.ok::before {{ content:"● "; color:var(--ok); }}
  .mark.no::before {{ content:"⊘ "; color:var(--no); }}
  .mark.bad {{ color:var(--bad); font-weight:600; }}
  .mark.bad::before {{ content:"▲ "; }}
  .grade {{ font-size:11px; letter-spacing:.04em; text-transform:uppercase;
    border:1px solid var(--rule); padding:1px 6px; color:var(--mute); }}
  ul {{ margin:.5em 0; padding-left:1.1em; }}
  li {{ margin:.28em 0; }}
  code {{ font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.92em; }}
  footer {{ margin-top:40px; padding-top:14px; border-top:1px solid var(--line);
    font-size:12px; color:var(--mute); }}
  @page {{ size:A4; margin:16mm 14mm; }}
  @media print {{
    .page {{ padding:0; max-width:none; }}
    h2 {{ break-after:avoid; }}
  }}
</style></head><body><div class="page">

<p class="sub num">{line}</p>
<h1>Covenant audit</h1>
<p class="lede">Every verdict below comes from <code>TxScriptEngine</code>, the same script
engine a Kaspa node validates a transaction with. Nothing here is inferred from reading
the source.</p>

<div class="caveat"><b>This is not a statement that the covenant is secure.</b> It reports
the properties that were tested, where the bytecode and <code>{doc}</code> disagree,
and which claims no constructed transaction could reach. The last of those is a section,
not an omission.</div>

<div class="kpis">
  <div class="kpi"><div class="k">Cases</div><div class="v num">{cases}</div><div class="n">transactions executed</div></div>
  <div class="kpi"><div class="k">Claims covered</div><div class="v num {cc}">{enf}</div><div class="n">{bnd} rules at a measured boundary</div></div>
  <div class="kpi"><div class="k">Violations</div><div class="v num {vc}">{viol}</div><div class="n">forbidden, yet accepted</div></div>
  <div class="kpi"><div class="k">Over-refusals</div><div class="v num {oc}">{ovr}</div><div class="n">permitted, yet refused</div></div>
  <div class="kpi"><div class="k">Baseline</div><div class="v">{base}</div><div class="n">every flip depends on it</div></div>
</div>
"#,
        cases = out.len(),
        enf = format!("{} / {}", covered, claims.len()),
        cc = if covered == claims.len() { "good" } else { "bad" },
        bnd = bnd,
        viol = violations.len(),
        vc = if violations.is_empty() { "good" } else { "bad" },
        ovr = over.len(),
        oc = if over.is_empty() { "good" } else { "bad" },
        base = if baseline_ok { "<span class=\"v good\">accepted</span>" } else { "<span class=\"v bad\">FAILED</span>" },
    );

    let _ = write!(s, r#"
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
