"""Markdown to HTML, for the subset the repo's own documents use.

A dependency would be the obvious answer and is the wrong one: `build.py` has
to run on whatever machine is deploying, and a build that works here and fails
there is worse than one that never worked. So this handles what AUTHORITY.md
actually contains and **raises on anything it does not recognise** rather than
dropping it silently. A converter that quietly omits a paragraph produces a
page that looks finished and is not, which is the worst way for a document to
be wrong.
"""
import html
import re


class Unhandled(Exception):
    """A construct this does not render. Louder than a missing paragraph."""


_INLINE = (
    (re.compile(r"`([^`]+)`"), lambda m: f"<code>{html.escape(m.group(1))}</code>"),
    (re.compile(r"\[([^\]]+)\]\(([^)]+)\)"),
     lambda m: f'<a href="{html.escape(m.group(2))}">{html.escape(m.group(1))}</a>'),
    (re.compile(r"\*\*([^*]+)\*\*"), lambda m: f"<strong>{html.escape(m.group(1))}</strong>"),
    (re.compile(r"(?<![*\w])\*([^*]+)\*(?!\w)"), lambda m: f"<em>{html.escape(m.group(1))}</em>"),
)


def inline(s):
    """Inline markup, escaping everything that is not markup.

    Tokenised rather than regex-replaced over escaped text, because escaping
    first turns `&` into `&amp;` inside code spans and replacing first lets a
    literal `<` through. Neither is acceptable in a document about honesty.
    """
    out, i = [], 0
    while i < len(s):
        best = None
        for pat, fn in _INLINE:
            m = pat.search(s, i)
            if m and (best is None or m.start() < best[0].start()):
                best = (m, fn)
        if best is None:
            out.append(html.escape(s[i:]))
            break
        m, fn = best
        out.append(html.escape(s[i:m.start()]))
        out.append(fn(m))
        i = m.end()
    return "".join(out).replace("--", "&mdash;")


def render(text):
    lines = text.split("\n")
    out, i = [], 0
    while i < len(lines):
        ln = lines[i]
        if not ln.strip():
            i += 1
        elif ln.startswith("# "):
            out.append(f"<h1>{inline(ln[2:])}</h1>"); i += 1
        elif ln.startswith("## "):
            out.append(f"<h2>{inline(ln[3:])}</h2>"); i += 1
        elif ln.startswith("### "):
            out.append(f"<h3>{inline(ln[4:])}</h3>"); i += 1
        elif ln.strip() == "---":
            out.append("<hr>"); i += 1
        elif ln.startswith("> "):
            body = []
            while i < len(lines) and lines[i].startswith(">"):
                body.append(lines[i].lstrip(">").strip()); i += 1
            out.append(f"<blockquote><p>{inline(' '.join(body))}</p></blockquote>")
        elif ln.startswith("| "):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")]); i += 1
            if len(rows) < 2 or not all(set(c) <= set("-: ") for c in rows[1]):
                raise Unhandled(f"a table without a header rule, at: {ln[:60]}")
            head = "".join(f"<th>{inline(c)}</th>" for c in rows[0])
            body = "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in rows[2:])
            out.append(f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>")
        elif ln.startswith("- "):
            items = []
            while i < len(lines) and (lines[i].startswith("- ") or (items and lines[i].startswith("  ") and lines[i].strip())):
                if lines[i].startswith("- "):
                    items.append(lines[i][2:].strip())
                else:
                    items[-1] += " " + lines[i].strip()
                i += 1
            out.append("<ul>" + "".join(f"<li>{inline(t)}</li>" for t in items) + "</ul>")
        elif re.match(r"^\d+\. ", ln):
            items = []
            while i < len(lines) and (re.match(r"^\d+\. ", lines[i]) or (items and lines[i].startswith("   ") and lines[i].strip())):
                if re.match(r"^\d+\. ", lines[i]):
                    items.append(re.sub(r"^\d+\. ", "", lines[i]).strip())
                else:
                    items[-1] += " " + lines[i].strip()
                i += 1
            out.append("<ol>" + "".join(f"<li>{inline(t)}</li>" for t in items) + "</ol>")
        elif ln.startswith("    ") or ln.startswith("\t"):
            body = []
            while i < len(lines) and (lines[i].startswith("    ") or not lines[i].strip()):
                if not lines[i].strip() and not (i + 1 < len(lines) and lines[i + 1].startswith("    ")):
                    break
                body.append(lines[i][4:]); i += 1
            out.append("<pre><code>" + html.escape("\n".join(body).strip("\n")) + "</code></pre>")
        elif ln.startswith("```"):
            raise Unhandled("fenced code blocks: use a four-space indent, which every reader renders")
        elif ln.startswith("#") or ln.startswith("* ") or ln.startswith("<"):
            # not `ln[0] in "#*_<"`: a paragraph may legitimately OPEN with
            # **bold**, and the first draft of this rule refused the document
            # it was written for on its second line. A heading deeper than h3,
            # an asterisk list, or raw HTML are the real gaps. 
            raise Unhandled(f"unrecognised construct: {ln[:60]}")
        else:
            body = []
            while i < len(lines) and lines[i].strip() and not lines[i][0] in "#>|" and not lines[i].startswith("- ") and not re.match(r"^\d+\. ", lines[i]) and not lines[i].startswith("    "):
                body.append(lines[i].strip()); i += 1
            out.append(f"<p>{inline(' '.join(body))}</p>")
    return "\n".join(out)
