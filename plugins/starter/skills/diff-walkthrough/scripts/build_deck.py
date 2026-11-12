#!/usr/bin/env python3
"""Storyboard JSON -> video deck HTML for visual-explainer-video.

Every scene is a <section data-say>. Sentence N of a scene is beat N; the deck CSS reacts to
[data-beat~="N"]. Scene content (code, diagrams, cards) is generated from the storyboard, and code is
read from git refs, never pasted, so the video shows the real change.

Usage: build_deck.py storyboard.json out.html
"""
import html
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
HERE = Path(__file__).resolve().parent
SPLIT = re.compile(r"(?<=[.!?])\s+")  # the renderer's sentence splitter (video/driver.js)
MAX_BEATS = 16

# ------------------------------------------------------------------ helpers


def esc(s):
    return html.escape(str(s), quote=True)


def die(msg):
    sys.exit(f"build_deck: {msg}")


class Ctx:
    def __init__(self, board, board_path):
        self.board = board
        self.base_dir = board_path.parent
        self.repos = board.get("repos", {})
        self.default_repo = board.get("default_repo") or (next(iter(self.repos)) if self.repos else None)
        self.sid = 0
        self.chapter = ""
        self.css = []          # per-scene rules (camera moves) appended to the page
        self._graph = None

    @property
    def graph(self):
        """who-uses-whom over the changed files of every repo (codegraph.build_multi), built once."""
        if self._graph is None:
            import codegraph
            g = self.board.get("graph", {})
            self._graph = codegraph.build_multi(self.repos, include=g.get("include"), exclude=g.get("exclude"),
                                                hubs=g.get("hubs"), test_globs=g.get("test_globs"))
            self._graph["out"], self._graph["inc"] = {}, {}
            for a, b in self._graph["edges"]:
                self._graph["out"].setdefault(a, []).append(b)
                self._graph["inc"].setdefault(b, []).append(a)
        return self._graph

    def node_for(self, alias, path):
        alias = alias or self.default_repo
        for n in self.graph["nodes"].values():
            if n["repo"] == alias and path in n["paths"]:
                return n
        return None

    def repo(self, alias):
        alias = alias or self.default_repo
        if alias not in self.repos:
            die(f"unknown repo alias {alias!r}; define it under 'repos'")
        return self.repos[alias]


def git(path, *args):
    r = subprocess.run(["git", "-C", path, *args], capture_output=True, text=True)
    if r.returncode != 0:
        die(f"git {' '.join(args)} failed in {path}: {r.stderr.strip()}")
    return r.stdout


def resolve_ref(repo, ref):
    if ref in (None, "head"):
        return repo["head"]
    if ref == "base":
        return repo["base"]
    return ref


def read_file(ctx, spec):
    """Returns (lines, original_numbers, added_set, ref_label)."""
    repo = ctx.repo(spec.get("repo"))
    ref = resolve_ref(repo, spec.get("ref"))
    if ref == "worktree":
        text = (Path(repo["path"]) / spec["file"]).read_text(encoding="utf-8-sig")
    else:
        text = git(repo["path"], "show", f"{ref}:{spec['file']}")
    text = text.lstrip("﻿")
    for pat in spec.get("strip", ctx.board.get("strip", [])):
        text = re.sub(pat, "", text)
    raw = text.split("\n")
    lines, nums = [], []
    drops = [re.compile(p) for p in spec.get("drop_lines", ctx.board.get("drop_lines", []))]
    for i, ln in enumerate(raw, start=1):
        if any(d.search(ln) for d in drops):
            # a dropped continuation line keeps the statement terminator on the line before it
            if ln.rstrip().endswith(";") and lines and not lines[-1].rstrip().endswith(";"):
                lines[-1] = lines[-1].rstrip() + ";"
            continue
        lines.append(ln)
        nums.append(i)
    added = set()
    if spec.get("diff_gutter", ref == repo["head"]) and ref not in ("worktree",):
        out = git(repo["path"], "diff", "-U0", repo["base"], ref, "--", spec["file"])
        for m in re.finditer(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", out, re.M):
            start, count = int(m.group(1)), int(m.group(2) or 1)
            added.update(range(start, start + count))
    return lines, nums, added


COMMENT = {
    ".cs": r"^\s*//", ".java": r"^\s*(//|\*|/\*)", ".ts": r"^\s*(//|\*|/\*)", ".tsx": r"^\s*(//|\*|/\*)",
    ".js": r"^\s*(//|\*|/\*)", ".kt": r"^\s*(//|\*|/\*)", ".go": r"^\s*//", ".py": r"^\s*#", ".sql": r"^\s*--",
    ".yaml": r"^\s*#", ".yml": r"^\s*#", ".sh": r"^\s*#", ".rb": r"^\s*#",
}
DOC = {".cs": r"^\s*///", ".java": r"^\s*(/\*\*|\*)", ".ts": r"^\s*(/\*\*|\*)", ".js": r"^\s*(/\*\*|\*)", ".kt": r"^\s*(/\*\*|\*)"}


def find(lines, sub, frm, file):
    for i in range(frm, len(lines)):
        if sub in lines[i]:
            return i
    die(f"anchor {sub!r} not found in {file} after excerpt line {frm}")


def extract(ctx, spec):
    lines, nums, added = read_file(ctx, spec)
    ext = Path(spec["file"]).suffix.lower()
    doc_re = re.compile(DOC[ext]) if ext in DOC else None
    com_re = re.compile(COMMENT[ext]) if ext in COMMENT else None
    rows, pos = [], 0  # rows: (text, is_line, is_added)
    for seg in spec.get("segments") or [{"start": lines[0] if lines else ""}]:
        if isinstance(seg, str):
            seg = {"start": seg}
        if "lines" in seg:  # explicit original line range "a-b"
            a_n, b_n = (int(x) for x in str(seg["lines"]).split("-"))
            idx = [i for i, n in enumerate(nums) if a_n <= n <= b_n]
            if not idx:
                die(f"lines {seg['lines']} empty in {spec['file']}")
            a0, b0 = idx[0], idx[-1]
        else:
            if seg.get("after"):
                pos = find(lines, seg["after"], pos, spec["file"])
            a = find(lines, seg["start"], pos, spec["file"])
            b = find(lines, seg["end"], a, spec["file"]) if seg.get("end") else a
            a0, b0 = max(0, a - seg.get("back", 0)), min(len(lines) - 1, b + seg.get("extra", 0))
        if rows:
            rows.append(("", False, False))
        for i in range(a0, b0 + 1):
            ln = lines[i]
            s = ln.strip()
            if not s:
                continue
            if doc_re and doc_re.search(ln) and not seg.get("keep_docs"):
                continue
            if com_re and com_re.search(ln) and not seg.get("keep_comments"):
                continue
            rows.append((ln.rstrip(), True, nums[i] in added))
        pos = b0 + 1
    real = [r for r, ok, _ in rows if ok]
    ind = min((len(r) - len(r.lstrip(" ")) for r in real), default=0)
    return [((r[ind:] if ok else r), ok, add) for r, ok, add in rows]


# ------------------------------------------------------------------ syntax highlight

try:
    from pygments.lexers import get_lexer_for_filename, TextLexer
    from pygments.token import Token
except ImportError:  # pragma: no cover
    get_lexer_for_filename = None


def tok_class(tt):
    from pygments.token import Comment, Keyword, Name, Number, Operator, String, Literal
    if tt in Comment or tt in Token.Comment:
        return "c"
    if tt in String or tt in Literal.String:
        return "s"
    if tt in Number:
        return "n"
    if tt in Keyword:
        return "k"
    if tt in Name.Class or tt in Name.Builtin or tt in Keyword.Type:
        return "t"
    if tt in Name.Function:
        return "f"
    if tt in Name.Attribute or tt in Name.Property:
        return "p"
    if tt in Operator:
        return "o"
    return ""


def highlight(texts, filename):
    """texts: list of code lines -> list of HTML strings, one per line."""
    if get_lexer_for_filename is None:
        return [esc(t) for t in texts]
    try:
        lexer = get_lexer_for_filename(filename, stripnl=False, ensurenl=False)
    except Exception:
        lexer = TextLexer()
    src = "\n".join(texts)
    out, cur = [], []
    for tt, val in lexer.get_tokens(src):
        cls = tok_class(tt)
        if cls == "" and tt in Token.Name and val[:1].isupper():
            cls = "t"
        parts = val.split("\n")
        for j, part in enumerate(parts):
            if j > 0:
                out.append("".join(cur))
                cur = []
            if part:
                cur.append(f'<i class="{cls}">{esc(part)}</i>' if cls else esc(part))
    out.append("".join(cur))
    while len(out) < len(texts):
        out.append("")
    return out[: len(texts)]


# ------------------------------------------------------------------ beats


def beats_of(scene):
    beats = scene.get("beats") or []
    for b in beats:
        parts = [p for p in SPLIT.split(b["say"].strip()) if p]
        if len(parts) != 1:
            die(f"beat must be exactly one sentence for the renderer, got {len(parts)}: {b['say']!r}")
    if len(beats) >= MAX_BEATS:
        die(f"scene has {len(beats)} beats; split it (max {MAX_BEATS - 1})")
    return beats


def appear_focus(beats, key="show"):
    """element id -> (first beat it is shown, set of beats where it is in focus)."""
    first, focus = {}, {}
    for n, b in enumerate(beats, start=1):
        for item in b.get(key, []):
            k = item if isinstance(item, str) else json.dumps(item)
            first.setdefault(k, n)
            focus.setdefault(k, set()).add(n)
    return first, focus


def cls_for(eid, first, focus, base=False):
    c = []
    if eid in first and not base:
        c.append(f"ap{first[eid]}")
    c += [f"f{b}" for b in sorted(focus.get(eid, ()))]
    return " ".join(c)


def has_classes(beats, key="show"):
    return " ".join(f"has{n}" for n, b in enumerate(beats, start=1) if b.get(key))


def say_attr(beats):
    return esc(" ".join(b["say"].strip() for b in beats))


# ------------------------------------------------------------------ icons (simple line glyphs, 24x24)

ICONS = {
    "db": '<ellipse cx="12" cy="5.5" rx="7" ry="2.8"/><path d="M5 5.5v13c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8v-13"/><path d="M5 12c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8"/>',
    "table": '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
    "service": '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M5.5 18.5l2.1-2.1M16.4 7.6l2.1-2.1"/>',
    "timer": '<circle cx="12" cy="13" r="8"/><path d="M12 13V8.5M9.5 2.5h5M12 13l3 2"/>',
    "queue": '<rect x="3" y="6" width="5" height="12" rx="1.5"/><rect x="9.5" y="6" width="5" height="12" rx="1.5"/><rect x="16" y="6" width="5" height="12" rx="1.5"/>',
    "user": '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20.5c1.2-4 4.1-6 7.5-6s6.3 2 7.5 6"/>',
    "api": '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5S14.5 17.9 12 20.5M12 3.5C9.5 6.1 8.4 8.9 8.4 12s1.1 5.9 3.6 8.5"/>',
    "file": '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    "shield": '<path d="M12 3l7 3v5.5c0 4.5-3 8-7 9.5-4-1.5-7-5-7-9.5V6z"/><path d="M9 12l2 2 4-4"/>',
    "bolt": '<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z"/>',
    "lock": '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 018 0v3"/>',
    "filter": '<path d="M3.5 5h17l-6.5 7.5v6l-4 2v-8z"/>',
    "clock": '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
    "alert": '<path d="M12 3.5l9 16H3z"/><path d="M12 10v4.5M12 17.2v.3"/>',
    "check": '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.3l2.8 2.7L16 9.5"/>',
    "x": '<circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6M15 9l-6 6"/>',
    "box": '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
    "cloud": '<path d="M7 18.5h10.5a4 4 0 00.6-8 6 6 0 00-11.4 1.6A3.3 3.3 0 007 18.5z"/>',
    "settings": '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    "branch": '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="8.5" r="2"/><path d="M6.5 7.5v9M17.5 10.5c0 4-11 3-11 6"/>',
    "heart": '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
    "trash": '<path d="M4.5 6.5h15M9.5 6.5V4h5v2.5M6.5 6.5l1 14h9l1-14"/>',
}


def icon(name, size=22):
    if not name:
        return ""
    g = ICONS.get(name, ICONS["box"])
    return (f'<svg class="ic" viewBox="0 0 24 24" width="{size}" height="{size}" fill="none" stroke="currentColor" '
            f'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">{g}</svg>')


# ------------------------------------------------------------------ chrome


def window(title, body, chips="", cls="", subtitle=""):
    sub = f'<span class="wsub">{esc(subtitle)}</span>' if subtitle else ""
    return (f'<div class="win {cls}"><div class="tbar"><span class="lights"><i></i><i></i><i></i></span>'
            f'<span class="wtitle">{esc(title)}{sub}</span><span class="wchips">{chips}</span></div>'
            f'<div class="wbody">{body}</div></div>')


def panel(heading, body, cls="", kicker=""):
    """A diagram on the open canvas: a small heading, no window chrome. Windows are for code only."""
    k = f'<span class="pk">{esc(kicker)}</span>' if kicker else ""
    return f'<div class="panel {cls}"><div class="phead">{k}<h3>{esc(heading)}</h3></div><div class="pbody">{body}</div></div>'


def chip(text, tone=""):
    return f'<span class="chip {tone}">{esc(text)}</span>'


def section(ctx, scene, inner, beats, extra_cls="", key="show"):
    ctx.sid += 1
    ctx.chapter = scene.get("chapter", ctx.chapter)
    hold = scene.get("hold", 1.2)
    return (f'<section id="s{ctx.sid}" class="scene {scene["type"]} {extra_cls} {has_classes(beats, key)}" '
            f'data-say="{say_attr(beats)}" data-hold="{hold}" data-chapter="{esc(ctx.chapter)}">'
            f'{inner}</section>\n')


# ------------------------------------------------------------------ scene types


def scene_title(ctx, sc):
    beats = beats_of(sc)
    first, focus = appear_focus(beats)
    chips = "".join(
        f'<span class="tchip dimmable {cls_for(c.get("id", c["text"]), first, focus)}">{icon(c.get("icon"), 18)}{esc(c["text"])}</span>'
        for c in sc.get("chips", []))
    verdict = ""
    if sc.get("verdict"):
        v = sc["verdict"]
        verdict = (f'<div class="verdict {v.get("tone", "warn")} {cls_for("verdict", first, focus)}">'
                   f'{icon(v.get("icon", "alert"), 22)}<span>{esc(v["text"])}</span></div>')
    inner = (f'<div class="hero"><p class="kicker">{esc(sc.get("kicker", ""))}</p>'
             f'<h1>{esc(sc["title"])}</h1><p class="lede">{esc(sc.get("subtitle", ""))}</p>'
             f'<div class="tchips">{chips}</div>{verdict}</div>')
    return section(ctx, sc, inner, beats)


def scene_chapter(ctx, sc):
    beats = beats_of(sc)
    inner = (f'<div class="chap"><span class="cnum">{esc(sc.get("number", ""))}</span>'
             f'<div><h2>{esc(sc["title"])}</h2><p>{esc(sc.get("blurb", ""))}</p></div></div>')
    return section(ctx, sc, inner, beats)


FLOW_W, FLOW_H = 1188, 486


def soft(text):
    """escape, then allow line breaks after _ and . so long identifiers wrap at word joints"""
    return re.sub(r"([_.])", r"\1<wbr>", esc(text))


def node_box(n):
    cols, rows = 12, 5
    w, h = n.get("w", 236), n.get("h", 78)
    cx = 30 + (FLOW_W - 60) * (n["col"] + 0.5) / cols
    cy = 34 + (FLOW_H - 68) * (n["row"] + 0.5) / rows
    return cx, cy, w, h


def clip_to_box(cx, cy, w, h, tx, ty):
    dx, dy = tx - cx, ty - cy
    if dx == 0 and dy == 0:
        return cx, cy
    sx = (w / 2 + 6) / abs(dx) if dx else 1e9
    sy = (h / 2 + 6) / abs(dy) if dy else 1e9
    s = min(sx, sy)
    return cx + dx * s, cy + dy * s


def scene_flow(ctx, sc):
    beats = beats_of(sc)
    first, focus = appear_focus(beats)
    nodes = {n["id"]: n for n in sc["nodes"]}
    svg, html_nodes, labels = [], [], []
    # groups: a dashed frame around member nodes
    for g in sc.get("groups", []):
        boxes = [node_box(nodes[m]) for m in g["nodes"]]
        x0 = min(cx - w / 2 for cx, cy, w, h in boxes) - 18
        y0 = min(cy - h / 2 for cx, cy, w, h in boxes) - 34
        x1 = max(cx + w / 2 for cx, cy, w, h in boxes) + 18
        y1 = max(cy + h / 2 for cx, cy, w, h in boxes) + 18
        gid = g.get("id", g["label"])
        svg.append(f'<g class="grp {cls_for(gid, first, focus, g.get("base", True))}"><rect x="{x0:.0f}" y="{y0:.0f}" '
                   f'width="{x1 - x0:.0f}" height="{y1 - y0:.0f}" rx="16"/><text x="{x0 + 16:.0f}" y="{y0 + 22:.0f}">{esc(g["label"])}</text></g>')
    for i, e in enumerate(sc.get("edges", [])):
        eid = e.get("id", f'{e["from"]}>{e["to"]}')
        a, b = nodes[e["from"]], nodes[e["to"]]
        ax, ay, aw, ah = node_box(a)
        bx, by, bw, bh = node_box(b)
        bend = e.get("bend", 0)
        mx, my = (ax + bx) / 2, (ay + by) / 2
        if bend:
            # control point perpendicular to the chord
            dx, dy = bx - ax, by - ay
            ln = max(1, (dx * dx + dy * dy) ** 0.5)
            qx, qy = mx - dy / ln * bend, my + dx / ln * bend
            sx, sy = clip_to_box(ax, ay, aw, ah, qx, qy)
            tx, ty = clip_to_box(bx, by, bw, bh, qx, qy)
            d = f"M{sx:.1f} {sy:.1f}Q{qx:.1f} {qy:.1f} {tx:.1f} {ty:.1f}"
            lx, ly = 0.25 * sx + 0.5 * qx + 0.25 * tx, 0.25 * sy + 0.5 * qy + 0.25 * ty
        else:
            sx, sy = clip_to_box(ax, ay, aw, ah, bx, by)
            tx, ty = clip_to_box(bx, by, bw, bh, ax, ay)
            d = f"M{sx:.1f} {sy:.1f}L{tx:.1f} {ty:.1f}"
            lx, ly = (sx + tx) / 2, (sy + ty) / 2
        c = cls_for(eid, first, focus, e.get("base", False))
        tone = e.get("tone", "")
        dash = " dashed" if e.get("dashed") else ""
        svg.append(f'<g class="edge dimmable {tone}{dash} {c}"><path class="ln" d="{d}" pathLength="1" marker-end="url(#ah{ctx.sid + 1})"/>'
                   f'<circle class="dot" r="4.5" style="offset-path:path(\'{d}\')"/></g>')
        if e.get("label"):
            labels.append(f'<span class="elabel dimmable {tone} {c}" style="left:{lx:.0f}px;top:{ly:.0f}px">{esc(e["label"])}</span>')
    for n in sc["nodes"]:
        cx, cy, w, h = node_box(n)
        c = cls_for(n["id"], first, focus, n.get("base", False))
        html_nodes.append(
            f'<div class="node dimmable {n.get("tone", "")} {c}" style="left:{cx - w / 2:.0f}px;top:{cy - h / 2:.0f}px;width:{w}px;height:{h}px">'
            f'<span class="nic">{icon(n.get("icon", "box"), 22)}</span><span class="ntx"><b>{soft(n["label"])}</b>'
            f'{"<small>" + soft(n["sub"]) + "</small>" if n.get("sub") else ""}'
            f'{"<code>" + icon("file", 12) + soft(n["code"]) + "</code>" if n.get("code") else ""}</span></div>')
    canvas = (f'<div class="canvas" style="width:{FLOW_W}px;height:{FLOW_H}px">'
              f'<svg class="edges" viewBox="0 0 {FLOW_W} {FLOW_H}" width="{FLOW_W}" height="{FLOW_H}">'
              f'<defs><marker id="ah{ctx.sid + 1}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
              f'<path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>{"".join(svg)}</svg>'
              f'{"".join(html_nodes)}{"".join(labels)}</div>')
    inner = panel(sc.get("window", "Architecture"), canvas, cls="flowpanel", kicker=sc.get("kicker", "diagram"))
    return section(ctx, sc, inner, beats)


def scene_sequence(ctx, sc):
    beats = beats_of(sc)
    first, focus = appear_focus(beats)
    actors = sc["actors"]
    n = len(actors)
    W, H = FLOW_W, FLOW_H
    xs = {a["id"]: 115 + (W - 230) * (i / max(1, n - 1)) for i, a in enumerate(actors)}
    msgs = sc["messages"]
    step = min(48, (H - 110) / max(1, len(msgs)))
    parts, heads = [], []
    for a in actors:
        x = xs[a["id"]]
        parts.append(f'<line class="life" x1="{x:.0f}" y1="70" x2="{x:.0f}" y2="{H - 10}"/>')
        heads.append(f'<div class="actor" style="left:{x - 95:.0f}px">{icon(a.get("icon", "box"), 20)}<b>{esc(a["label"])}</b></div>')
    for i, m in enumerate(msgs):
        y = 100 + i * step
        x1, x2 = xs[m["from"]], xs[m["to"]]
        c = cls_for(m["id"], first, focus, m.get("base", False))
        tone = m.get("tone", "")
        if x1 == x2:  # self call
            d = f"M{x1:.0f} {y - 8:.0f}h46v18h-42"
            lx = x1 + 52
            anchor = "start"
        else:
            sgn = 1 if x2 > x1 else -1
            d = f"M{x1 + 6 * sgn:.0f} {y:.0f}L{x2 - 8 * sgn:.0f} {y:.0f}"
            lx = (x1 + x2) / 2
            anchor = "middle"
        dash = " dashed" if m.get("reply") else ""
        parts.append(f'<g class="msg dimmable {tone}{dash} {c}"><path class="ln" d="{d}" pathLength="1" marker-end="url(#sq{ctx.sid + 1})"/>'
                     f'<circle class="dot" r="4.5" style="offset-path:path(\'{d}\')"/>'
                     f'<text x="{lx:.0f}" y="{y - 9:.0f}" text-anchor="{anchor}">{esc(m["label"])}</text></g>')
    canvas = (f'<div class="canvas seq" style="width:{W}px;height:{H}px">{"".join(heads)}'
              f'<svg viewBox="0 0 {W} {H}" width="{W}" height="{H}"><defs><marker id="sq{ctx.sid + 1}" viewBox="0 0 10 10" refX="8.5" refY="5" '
              f'markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>'
              f'{"".join(parts)}</svg></div>')
    inner = panel(sc.get("window", "Sequence"), canvas, cls="flowpanel", kicker=sc.get("kicker", "sequence"))
    return section(ctx, sc, inner, beats)


def fit_font(texts, width_px, height_px, top=22, low=12):
    for size in range(top, low - 1, -1):
        cols = max(20, int(width_px / (0.602 * size)))
        vis = sum(max(1, -(-len(t) // cols)) for t in texts)
        if vis * size * 1.5 <= height_px:
            return size
    return low


def code_block(ctx, spec, beats, marks_key="show", width=1130, height=400, top=22):
    rows = extract(ctx, spec)
    texts = [t for t, ok, _ in rows]
    lit = highlight([t if ok else "" for t, ok, _ in rows], spec["file"])
    hl = {}
    for n, b in enumerate(beats, start=1):
        idx = set()
        for mk in b.get(marks_key, []):
            s0, e0 = (mk, None) if isinstance(mk, str) else (mk[0], mk[1] if len(mk) > 1 else None)
            a = next((i for i, t in enumerate(texts) if s0 in t), None)
            if a is None:
                die(f"highlight {s0!r} not in the excerpt of {spec['file']}")
            z = a
            if e0:
                z = next((i for i in range(a, len(texts)) if e0 in texts[i]), None)
                if z is None:
                    die(f"highlight end {e0!r} not in the excerpt of {spec['file']}")
            idx.update(range(a, z + 1))
        hl[n] = idx
    size = fit_font(texts, width - 70, height, top=top)
    if size < 14:
        print(f"  ! {spec['file']}: font {size}px — trim the excerpt", file=sys.stderr)
    out = []
    for i, (t, ok, add) in enumerate(rows):
        cls = ["ln"] + [f"f{n}" for n, idx in hl.items() if i in idx]
        if not ok:
            cls.append("gap")
        if add:
            cls.append("add")
        body = lit[i] if ok else "⋯"
        out.append(f'<span class="{" ".join(cls)}"><u></u>{body or " "}</span>')
    n_add = sum(1 for _, ok, add in rows if ok and add)
    return f'<pre class="code" style="font-size:{size}px"><code>{"".join(out)}</code></pre>', n_add


def inspector(beats):
    items = [b for b in beats if b.get("note")]
    if not items:
        return ""
    lis = []
    k = 0
    for n, b in enumerate(beats, start=1):
        if not b.get("note"):
            continue
        k += 1
        lis.append(f'<li class="ap{n} f{n}"><span class="k">{k}</span><span>{esc(b["note"])}</span></li>')
    return f'<aside class="insp"><h4>Walkthrough</h4><ol>{"".join(lis)}</ol></aside>'


def side_html(ctx, side, beats, key, width):
    if side.get("file"):
        block, _ = code_block(ctx, side, beats, marks_key=key, width=width, height=side.get("height", 360))
        return block
    first, focus = appear_focus(beats, key)
    lis = "".join(
        f'<li class="dimmable {cls_for(it.get("id", it["text"]), first, focus, it.get("base", True))}">{icon(it.get("icon", side.get("icon")), 20)}<span>{esc(it["text"])}</span></li>'
        for it in side.get("items", []))
    return f'<ul class="bul">{lis}</ul>'


def scene_compare(ctx, sc):
    beats = beats_of(sc)
    # a pane is in focus whenever one of its items is: lift item ids to the pane key
    owned = {k: {it.get("id", it["text"]) for it in sc[k].get("items", [])} for k in ("left", "right")}
    lifted = [dict(b, show=list(b.get("show", [])) + [k for k, ids in owned.items() if ids & set(map(str, b.get("show", [])))])
              for b in beats]
    first, focus = appear_focus(lifted, "show")
    panes = []
    for key, side in (("left", sc["left"]), ("right", sc["right"])):
        c = cls_for(key, first, focus, side.get("base", key == "left"))
        body = side_html(ctx, side, beats, f"{key}_marks", 540)
        tag = chip(side.get("tag", ""), side.get("tone", "")) if side.get("tag") else ""
        if side.get("file"):  # real code keeps its window
            panes.append(window(side.get("label", key), body, chips=tag, cls=f"pane codewin dimmable {side.get('tone', '')} {c}"))
        else:
            panes.append(f'<div class="pane dimmable {side.get("tone", "")} {c}"><div class="ptitle">{icon(side.get("icon"), 20)}'
                         f'{esc(side.get("label", key))}{tag}</div>{body}</div>')
    arrow = f'<div class="cmp-arrow">{icon("bolt", 26)}</div>' if sc.get("arrow", True) else ""
    inner = f'<div class="cmp">{panes[0]}{arrow}{panes[1]}</div>'
    return section(ctx, sc, inner, beats)


def scene_cards(ctx, sc):
    beats = beats_of(sc)
    first, focus = appear_focus(beats)
    cols = sc.get("columns", 3)
    cards = []
    for it in sc["items"]:
        c = cls_for(it["id"], first, focus, it.get("base", False))
        tag = f'<span class="ctag {it.get("tone", "")}">{esc(it["tag"])}</span>' if it.get("tag") else ""
        cards.append(f'<div class="card dimmable {it.get("tone", "")} {c}"><div class="chead"><span class="cic">{icon(it.get("icon", "box"), 22)}</span>'
                     f'<b>{esc(it["title"])}</b>{tag}</div><p>{esc(it.get("body", ""))}</p></div>')
    head = f'<h3 class="ctitle">{esc(sc["heading"])}</h3>' if sc.get("heading") else ""
    inner = f'<div class="cards-wrap">{head}<div class="cards" style="grid-template-columns:repeat({cols},1fr)">{"".join(cards)}</div></div>'
    return section(ctx, sc, inner, beats)


def glob_match(path, pats):
    from fnmatch import fnmatch
    return any(fnmatch(path, p) for p in pats)


def scene_files(ctx, sc):
    beats = beats_of(sc)
    first, focus = appear_focus(beats)
    repo = ctx.repo(sc.get("repo"))
    status = {}
    for line in git(repo["path"], "diff", "--name-status", repo["base"], repo["head"]).splitlines():
        p = line.split("\t")
        status[p[-1]] = p[0][0]
    num = {}
    for line in git(repo["path"], "diff", "--numstat", repo["base"], repo["head"]).splitlines():
        a, d, p = line.split("\t")
        if " => " in p:
            p = p.split(" => ")[-1].strip("}")
        num[p] = (int(a) if a != "-" else 0, int(d) if d != "-" else 0)
    groups = sc["groups"]
    rows, used = [], set()
    for g in groups:
        files = [f for f in num if f not in used and glob_match(f, g["match"])]
        used.update(files)
        add = sum(num[f][0] for f in files)
        dele = sum(num[f][1] for f in files)
        A = sum(1 for f in files if status.get(f) == "A")
        M = sum(1 for f in files if status.get(f) == "M")
        D = sum(1 for f in files if status.get(f) == "D")
        rows.append((g, len(files), add, dele, A, M, D))
    rest = [f for f in num if f not in used]
    if rest and sc.get("other", True):
        rows.append(({"id": "other", "label": "Other", "icon": "file"}, len(rest), sum(num[f][0] for f in rest),
                     sum(num[f][1] for f in rest), sum(1 for f in rest if status.get(f) == "A"),
                     sum(1 for f in rest if status.get(f) == "M"), sum(1 for f in rest if status.get(f) == "D")))
    peak = max((r[2] + r[3] for r in rows), default=1) or 1
    tot_add = sum(v[0] for v in num.values())
    tot_del = sum(v[1] for v in num.values())
    out = []
    for g, n, add, dele, A, M, D in rows:
        gid = g.get("id", g["label"])
        c = cls_for(gid, first, focus, g.get("base", False))
        wa, wd = 100 * add / peak, 100 * dele / peak
        out.append(f'<div class="frow dimmable {c}"><span class="flabel">{icon(g.get("icon", "file"), 20)}<b>{esc(g["label"])}</b>'
                   f'<small>{n} files</small></span><span class="fbar"><i class="a" style="width:{wa:.1f}%"></i><i class="d" style="width:{wd:.1f}%"></i></span>'
                   f'<span class="fnum"><em class="g">+{add}</em> <em class="r">−{dele}</em></span>'
                   f'<span class="fstat">{chip(f"{A} new", "green") if A else ""}{chip(f"{M} mod", "blue") if M else ""}{chip(f"{D} del", "red") if D else ""}</span></div>')
    chips = chip(f"{len(num)} files") + chip(f"+{tot_add}", "green") + chip(f"−{tot_del}", "red")
    inner = panel(sc.get("window", f'{repo.get("name", "")} · {repo["base"][:7]}…{repo["head"].split("/")[-1]}'),
                  f'<div class="files">{"".join(out)}</div>', kicker="what changed")
    return section(ctx, sc, inner, beats)


# ------------------------------------------------------------------ atlas: file map, call trace, code in context

STAGE_W, STAGE_H = 1188, 540


def expand_show(item, lanes_of=None):
    """'A>B>C' -> nodes A, B, C and edges A>B, B>C; a lane id -> its nodes; anything else as is."""
    if lanes_of and item in lanes_of:
        return list(lanes_of[item])
    if ">" in item:
        parts = item.split(">")
        return parts + [f"{a}>{b}" for a, b in zip(parts, parts[1:])]
    return [item]


def scene_map(ctx, sc):
    """The files of the change as a graph: lanes by layer, edges = 'uses a type declared in'."""
    beats = beats_of(sc)
    g = ctx.graph
    sid = ctx.sid + 1
    lanes = sc["lanes"]
    placed, lane_nodes = {}, {}
    for li, lane in enumerate(lanes):
        ids = []
        for nid, n in g["nodes"].items():
            if nid in placed or nid == "wiring":
                continue
            hit = nid in lane.get("nodes", []) or any(
                fnmatch_any(f'{n["repo"]}:{p}', lane.get("match", [])) for p in n["paths"])
            if hit:
                ids.append(nid)
                placed[nid] = li
        lane_nodes[lane["id"]] = ids
    left_out = [k for k in g["nodes"] if k not in placed and k != "wiring"]
    if left_out:
        print(f"  map: {len(left_out)} files in no lane: {', '.join(sorted(left_out)[:8])}{'…' if len(left_out) > 8 else ''}", file=sys.stderr)
    edges = [(a, b) for a, b in g["edges"] if a in placed and b in placed]
    # order each lane by the mean position of its neighbours (a few passes cut most crossings)
    order = {nid: i for lane in lanes for i, nid in enumerate(lane_nodes[lane["id"]])}
    nbr = {}
    for a, b in edges:
        nbr.setdefault(a, []).append(b)
        nbr.setdefault(b, []).append(a)
    for _ in range(6):
        for lane in lanes:
            ids = lane_nodes[lane["id"]]
            if not ids:
                continue
            def bary(n):
                ns = [order[m] / max(1, len(lane_nodes[lanes[placed[m]]["id"]])) for m in nbr.get(n, []) if placed[m] != placed[n]]
                return sum(ns) / len(ns) if ns else order[n] / max(1, len(ids))
            ids.sort(key=bary)
            for i, nid in enumerate(ids):
                order[nid] = i
    W, H = STAGE_W, 470
    lw = W / len(lanes)
    most = max((len(v) for v in lane_nodes.values()), default=1)
    gap = min(40, (H - 46) / max(1, most))
    nh = min(30, gap - 6)
    pos = {}
    for li, lane in enumerate(lanes):
        ids = lane_nodes[lane["id"]]
        y0 = 46 + (H - 46 - gap * len(ids)) / 2
        for i, nid in enumerate(ids):
            pos[nid] = (li * lw + 14, y0 + i * gap, lw - 28, nh)
    lanes_of = {lane["id"]: lane_nodes[lane["id"]] for lane in lanes}
    shows = []
    for b in beats:
        items = []
        for it in b.get("show", []):
            items += expand_show(it, lanes_of)
        shows.append(items)
    xbeats = [dict(b, show=s) for b, s in zip(beats, shows)]
    first, focus = appear_focus(xbeats)
    # an edge lights up whenever both of its files are in focus
    for n, items in enumerate(shows, start=1):
        on = set(items)
        for a, b in edges:
            if a in on and b in on:
                focus.setdefault(f"{a}>{b}", set()).add(n)
    svg, html_nodes = [], []
    for a, b in edges:
        ax, ay, aw, ah = pos[a]
        bx, by, bw, bh = pos[b]
        la, lb = placed[a], placed[b]
        if la < lb:
            sx, sy, tx, ty = ax + aw, ay + ah / 2, bx, by + bh / 2
            k = (tx - sx) * .45
            d = f"M{sx:.1f} {sy:.1f}C{sx + k:.1f} {sy:.1f} {tx - k:.1f} {ty:.1f} {tx:.1f} {ty:.1f}"
        elif la > lb:
            sx, sy, tx, ty = ax, ay + ah / 2, bx + bw, by + bh / 2
            k = (sx - tx) * .45
            d = f"M{sx:.1f} {sy:.1f}C{sx - k:.1f} {sy:.1f} {tx + k:.1f} {ty:.1f} {tx:.1f} {ty:.1f}"
        else:
            sx, sy, tx, ty = ax + aw, ay + ah / 2, bx + bw, by + bh / 2
            k = 26 + abs(ty - sy) * .25
            d = f"M{sx:.1f} {sy:.1f}C{sx + k:.1f} {sy:.1f} {tx + k:.1f} {ty:.1f} {tx:.1f} {ty:.1f}"
        c = cls_for(f"{a}>{b}", {}, focus)
        svg.append(f'<g class="fedge {c}"><path class="ln" d="{d}" marker-end="url(#fm{sid})"/>'
                   f'<circle class="dot" r="3.2" style="offset-path:path(\'{d}\')"/></g>')
    for li, lane in enumerate(lanes):
        c = cls_for(lane["id"], first, focus, True)
        html_nodes.append(f'<div class="lane {c}" style="left:{li * lw + 6:.0f}px;width:{lw - 12:.0f}px">'
                          f'<b>{esc(lane["label"])}</b><small>{len(lane_nodes[lane["id"]])} files</small></div>')
    for nid, (x, y, w, h) in pos.items():
        n = g["nodes"][nid]
        c = cls_for(nid, first, focus, True)
        st = {"A": "new", "M": "mod", "R": "mod"}.get(n["status"], "mod")
        t = f'<i class="tb" title="tests">{icon("check", 11)}{n["tests"]}</i>' if n.get("tests") else ""
        fs = max(9.5, min(11.5, (w - (44 if t else 26)) / (0.61 * len(nid))))
        html_nodes.append(f'<div class="fnode dimmable {st} {c}" style="left:{x:.0f}px;top:{y:.0f}px;width:{w:.0f}px;height:{h:.0f}px;--fs:{fs:.1f}px">'
                          f'<em></em><span>{soft(nid)}</span>{t}</div>')
    # camera: zoom onto the files in focus when a beat asks for it
    cam = sc.get("camera", False)
    for n, b in enumerate(beats, start=1):
        want = b.get("zoom", cam)
        ids = [i for i in shows[n - 1] if i in pos]
        if not want or not ids:
            continue
        x0 = min(pos[i][0] for i in ids) - 40
        y0 = min(pos[i][1] for i in ids) - 50
        x1 = max(pos[i][0] + pos[i][2] for i in ids) + 40
        y1 = max(pos[i][1] + pos[i][3] for i in ids) + 40
        s = min(W / (x1 - x0), H / (y1 - y0), 1.8)
        if s < 1.25:
            continue
        tx, ty = W / 2 - s * (x0 + x1) / 2, H / 2 - s * (y0 + y1) / 2
        tx, ty = min(0, max(W - W * s, tx)), min(0, max(H - H * s, ty))
        ctx.css.append(f'#s{sid}[data-beat~="{n}"]:not([data-beat~="{n + 1}"]) .mapcam{{transform:translate({tx:.0f}px,{ty:.0f}px) scale({s:.3f})}}')
    legend = (f'<div class="legend"><span><em class="new"></em>new file</span><span><em class="mod"></em>changed file</span>'
              f'<span>{icon("check", 12)} test files that use it</span><span class="arr">A → B : A uses a type from B</span></div>')
    canvas = (f'<div class="mapview" style="width:{W}px;height:{H}px"><div class="mapcam">'
              f'<svg viewBox="0 0 {W} {H}" width="{W}" height="{H}"><defs><marker id="fm{sid}" viewBox="0 0 10 10" refX="9" refY="5" '
              f'markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>{"".join(svg)}</svg>'
              f'{"".join(html_nodes)}</div></div>{legend}')
    inner = panel(sc.get("heading", "How the changed files connect"), canvas, cls="mappanel", kicker=sc.get("kicker", "file map"))
    return section(ctx, sc, inner, xbeats)


def fnmatch_any(path, pats):
    from fnmatch import fnmatch
    return any(fnmatch(path, p) for p in pats)


def connection_strip(ctx, spec):
    """'used by → THIS FILE → uses', taken from the file graph, so every snippet shows where it sits."""
    node = ctx.node_for(spec.get("repo"), spec["file"])
    repo = ctx.repo(spec.get("repo"))
    path = spec["file"]
    folder = "/".join(path.split("/")[:-1])
    name = path.split("/")[-1]
    pill = lambda nid: f'<span class="cp">{soft(nid)}</span>'
    def lst(ids, cap):
        ids = sorted(ids)
        more = f'<span class="cp more">+{len(ids) - cap}</span>' if len(ids) > cap else ""
        return "".join(pill(i) for i in ids[:cap]) + more
    inc = ctx.graph["inc"].get(node["id"], []) if node else []
    out = ctx.graph["out"].get(node["id"], []) if node else []
    tests = node.get("tests", 0) if node else 0
    st = ""
    if node:
        st = '<span class="st new">new</span>' if node["status"] == "A" else '<span class="st mod">changed</span>'
    left = f'<div class="cside"><small>used by</small><div>{lst(inc, 2) or "<span class=none>nothing in this change</span>"}</div></div>'
    right = f'<div class="cside"><small>uses</small><div>{lst(out, 2) or "<span class=none>nothing in this change</span>"}</div></div>'
    t = f'<span class="tests">{icon("check", 13)}{tests} test file{"s" if tests != 1 else ""}</span>' if tests else ""
    me = (f'<div class="cme">{icon("file", 16)}<div><b>{esc(name)}</b><small>{esc(repo.get("name", spec.get("repo") or ctx.default_repo))} · {esc(folder)}</small></div>{st}{t}</div>')
    return f'<div class="conn">{left}<span class="carr"></span>{me}<span class="carr"></span>{right}</div>'


def scene_code(ctx, sc):
    beats = beats_of(sc)
    has_notes = any(b.get("note") for b in beats)
    width = 880 if has_notes else 1180
    block, n_add = code_block(ctx, sc, beats, width=width, height=sc.get("height", 420))
    repo = ctx.repo(sc.get("repo"))
    ref = sc.get("ref") or "head"
    chips = ""
    if ref == "base":
        chips += chip("before this change", "red")
    elif n_add:
        chips += chip(f"+{n_add} lines in this PR", "green")
    chips += "".join(chip(c) for c in sc.get("chips", []))
    title = sc.get("title") or Path(sc["file"]).name
    subtitle = sc.get("symbol", "")
    win = window(title, block, chips=chips, cls="codewin", subtitle=(" — " + subtitle) if subtitle else "")
    notes = ""
    if has_notes:
        total = sum(1 for b in beats if b.get("note"))
        k = 0
        items = []
        for n, b in enumerate(beats, start=1):
            if b.get("note"):
                k += 1
                items.append(f'<div class="note nt{n}"><span class="nk">{k}<i>/{total}</i></span><p>{esc(b["note"])}</p></div>')
        notes = f'<div class="notes">{"".join(items)}</div>'
    strip = connection_strip(ctx, sc) if sc.get("context", True) and ctx.repos else ""
    inner = f'<div class="codestage{" withnotes" if has_notes else ""}">{strip}<div class="coderow">{win}{notes}</div></div>'
    return section(ctx, sc, inner, beats)


def scene_trace(ctx, sc):
    """Follow one execution across files: each hop is the real call line in its own code window."""
    hops = sc["hops"]
    beats = beats_of(sc)
    sid = ctx.sid + 1
    n = len(hops)
    if n > 6:
        die("trace: at most 6 hops")
    rows = [hops] if n <= 4 else [hops[: (n + 1) // 2], hops[(n + 1) // 2:]]
    gapx = 46
    H = STAGE_H - 40
    rh = H if len(rows) == 1 else (H - 40) / 2
    # which beat focuses which hop: beat k -> hop k unless the beat says "hop": i
    hop_beat = {}
    for k, b in enumerate(beats, start=1):
        h = b.get("hop", k if k <= n else None)
        if h:
            hop_beat.setdefault(h, set()).add(k)
    boxes, wins = [], []
    idx = 0
    for r, row in enumerate(rows):
        cols = len(rows[0])
        w = (STAGE_W - gapx * (cols - 1)) / cols
        for j, hop in enumerate(row):
            idx += 1
            x, y = j * (w + gapx), r * (rh + 40)
            boxes.append((x, y, w, rh))
            fb = [{} for _ in beats]
            for k in hop_beat.get(idx, ()):
                fb[k - 1] = {"show": [hop.get("mark", hop["segments"][0].get("start") if hop.get("segments") else "")]}
            spec = dict(hop)
            if "segments" not in spec:
                spec["segments"] = [{"start": hop["anchor"], "back": hop.get("back", 1), "extra": hop.get("extra", 2)}]
            if "anchor" in hop:
                fb = [({"show": [hop["anchor"]]} if (k + 1) in hop_beat.get(idx, ()) else {}) for k in range(len(beats))]
            block, _ = code_block(ctx, spec, fb, width=w - 10, height=rh - 92, top=15)
            first_beat = min(hop_beat.get(idx, {1}))
            c = f"ap{first_beat}" if first_beat > 1 else ""
            c += "".join(f" f{k}" for k in sorted(hop_beat.get(idx, ())))
            head = (f'<div class="hophead"><span class="hn">{idx}</span><div><b>{esc(hop.get("title", Path(hop["file"]).stem))}</b>'
                     f'<small>{esc(hop.get("say", ""))}</small></div></div>')
            win = window(Path(hop["file"]).name, block, cls="codewin small")
            wins.append(f'<div class="hop dimmable {c}" style="left:{x:.0f}px;top:{y:.0f}px;width:{w:.0f}px;height:{rh:.0f}px">{head}{win}</div>')
    svg, labels = [], []
    for i in range(n - 1):
        ax, ay, aw, ah = boxes[i]
        bx, by, bw, bh = boxes[i + 1]
        if abs(ay - by) < 1:
            sx, sy, tx, ty = ax + aw + 4, ay + 56 + (ah - 56) / 2, bx - 4, by + 56 + (bh - 56) / 2
            d = f"M{sx:.0f} {sy:.0f}L{tx:.0f} {ty:.0f}"
            lx, ly = (sx + tx) / 2, sy - 14
        else:
            sx, sy, tx, ty = ax + aw / 2, ay + ah + 4, bx + bw / 2, by - 4
            d = f"M{sx:.0f} {sy:.0f}C{sx:.0f} {sy + 30:.0f} {tx:.0f} {ty - 30:.0f} {tx:.0f} {ty:.0f}"
            lx, ly = (sx + tx) / 2, (sy + ty) / 2
        ks = sorted(hop_beat.get(i + 2, ()))
        c = (f"ap{ks[0]} " if ks and ks[0] > 1 else "") + " ".join(f"f{k}" for k in ks)
        svg.append(f'<g class="tedge {c}"><path class="ln" d="{d}" marker-end="url(#tm{sid})"/>'
                   f'<circle class="dot" r="4.5" style="offset-path:path(\'{d}\')"/></g>')
        if hops[i].get("via"):
            labels.append(f'<span class="tlabel {c}" style="left:{lx:.0f}px;top:{ly:.0f}px">{esc(hops[i]["via"])}</span>')
    canvas = (f'<div class="trace" style="width:{STAGE_W}px;height:{H}px">{"".join(wins)}'
              f'<svg viewBox="0 0 {STAGE_W} {H}" width="{STAGE_W}" height="{H}"><defs><marker id="tm{sid}" viewBox="0 0 10 10" refX="8.5" refY="5" '
              f'markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>{"".join(svg)}</svg>'
              f'{"".join(labels)}</div>')
    inner = panel(sc.get("heading", "Follow the call"), canvas, cls="tracepanel", kicker=sc.get("kicker", "call path"))
    return section(ctx, sc, inner, beats)



# ------------------------------------------------------------------ teaching: predict, state


def scene_predict(ctx, sc):
    """Active recall: ask before telling. Beat 1 poses the question; the next beat reveals the answer.

    The reader stops on beat 1 and commits to an option; the code excerpt (optional) is the evidence, and its
    marks appear only with the answer, so the question cannot be answered by reading the highlight."""
    beats = beats_of(sc)
    if len(beats) < 2:
        die("predict: needs at least 2 beats (question, answer)")
    opts = sc["options"]
    if sum(1 for o in opts if o.get("correct")) != 1:
        die("predict: exactly one option needs \"correct\": true")
    letters = "ABCD"
    lis = []
    for i, o in enumerate(opts):
        ok = o.get("correct")
        why = f'<small class="why ap2">{esc(o.get("why", ""))}</small>' if o.get("why") else ""
        lis.append(f'<li class="opt {"right" if ok else "wrong"}"><span class="ol">{letters[i]}</span>'
                   f'<div><b>{esc(o["text"])}</b>{why}</div><span class="verdictmark ap2">{icon("check" if ok else "x", 20)}</span></li>')
    card = (f'<div class="qcard"><span class="pk">predict</span><h3>{esc(sc["question"])}</h3>'
            f'<ol class="opts">{"".join(lis)}</ol><p class="think ap1">Decide before you press →</p></div>')
    left = ""
    if sc.get("file"):
        block, _ = code_block(ctx, sc, beats, width=560, height=sc.get("height", 400), top=17)
        title = Path(sc["file"]).name
        left = window(title, block, cls="codewin", subtitle=(" — " + sc["symbol"]) if sc.get("symbol") else "")
    inner = f'<div class="predict{" withcode" if left else ""}">{left}{card}</div>'
    return section(ctx, sc, inner, beats)


def scene_state(ctx, sc):
    """A concrete table row (or rows) changing step by step: the data the code moves, made visible.

    table: {name, columns}; rows: the starting rows; each beat may carry `action` (who does what), `code`
    (the statement, one line), `set` {"row.column": value} applied cumulatively, and `outcome`."""
    beats = beats_of(sc)
    cols = sc["table"]["columns"]
    rows = [list(map(str, r)) for r in sc["rows"]]
    states, changed = [], []
    for b in beats:
        ch = set()
        for k, v in (b.get("set") or {}).items():
            r, _, c = k.partition(".")
            ci = cols.index(c) if c in cols else die(f"state: unknown column {c!r}")
            rows[int(r)][ci] = str(v)
            ch.add((int(r), ci))
        states.append([list(r) for r in rows])
        changed.append(ch)
    frames = []
    for n, (st, ch) in enumerate(zip(states, changed), start=1):
        b = beats[n - 1]
        head = "".join(f"<th>{esc(c)}</th>" for c in cols)
        body = "".join("<tr>" + "".join(
            f'<td class="{"chg" if (ri, ci) in ch else ""}{" null" if v in ("null", "NULL", "") else ""}">{esc(v or "null")}</td>'
            for ci, v in enumerate(r)) + "</tr>" for ri, r in enumerate(st))
        act = (f'<div class="act">{icon(b.get("icon", "bolt"), 18)}<b>{esc(b.get("action", ""))}</b></div>' if b.get("action") else "")
        code = f'<pre class="stmt">{esc(b["code"])}</pre>' if b.get("code") else ""
        out = (f'<div class="outcome {b.get("tone", "")}">{esc(b["outcome"])}</div>' if b.get("outcome") else "")
        past = "".join(f'<li class="{x.get("tone", "")}"><span>{i}</span><b>{esc(x.get("action", ""))}</b><em>{esc(x.get("outcome", ""))}</em></li>'
                       for i, x in enumerate(beats[: n - 1], start=1) if x.get("action"))
        log = f'<ol class="slog"><small>so far</small>{past}</ol>' if past else ""
        frames.append(f'<div class="sframe sf{n}">{act}{code}<table class="dt"><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>{out}{log}</div>')
    steps = "".join(f'<span class="sstep sd{n}">{n}</span>' for n in range(1, len(beats) + 1))
    inner = panel(sc.get("heading", sc["table"]["name"]),
                  f'<div class="state"><div class="tname">{icon("table", 18)}<b>{esc(sc["table"]["name"])}</b><span class="steps">{steps}</span></div>'
                  f'<div class="sframes">{"".join(frames)}</div></div>', kicker=sc.get("kicker", "data walk"))
    return section(ctx, sc, inner, beats)


SCENES = {"title": scene_title, "chapter": scene_chapter, "flow": scene_flow, "sequence": scene_sequence,
          "code": scene_code, "compare": scene_compare, "cards": scene_cards, "files": scene_files,
          "map": scene_map, "trace": scene_trace,
          "predict": scene_predict, "state": scene_state}


# ------------------------------------------------------------------ page


def beat_css():
    out = []
    for b in range(1, MAX_BEATS):
        cur = f'section[data-beat~="{b}"]:not([data-beat~="{b + 1}"])'
        out.append(f'section[data-beat]:not([data-beat~="{b}"]) .ap{b}{{opacity:0!important;transform:translateY(10px)}}')
        out.append(f'{cur}.has{b} .dimmable:not(.f{b}){{opacity:.34}}')
        out.append(f'{cur} .f{b}{{--on:1}}')
        out.append(f'{cur} .ln.f{b}{{background:var(--hl);box-shadow:inset 3px 0 0 var(--accent)}}')
        out.append(f'{cur} .insp li.f{b}{{background:var(--accent-soft);color:var(--text)}}{cur} .insp li.f{b} .k{{background:var(--accent);color:#fff}}')
        out.append(f'{cur}.has{b} .ln:not(.f{b}){{opacity:.42}}')
        out.append(f'{cur} .note.nt{b}{{opacity:1;transform:none}}')
        out.append(f'{cur} .sframe.sf{b}{{opacity:1;transform:none}}{cur} .sstep.sd{b}{{background:var(--accent);color:var(--bg)}}')
    return "\n".join(out)


def main():
    if len(sys.argv) != 3:
        die("usage: build_deck.py storyboard.json out.html")
    board_path = Path(sys.argv[1]).resolve()
    board = json.loads(board_path.read_text(encoding="utf-8"))
    ctx = Ctx(board, board_path)
    parts = []
    for sc in board["scenes"]:
        fn = SCENES.get(sc["type"])
        if not fn:
            die(f"unknown scene type {sc['type']!r}; one of {sorted(SCENES)}")
        parts.append(fn(ctx, sc))
    css = (HERE.parent / "assets" / "deck.css").read_text(encoding="utf-8")
    menubar = board.get("menubar", {})
    # chapters in order of first appearance, sized by their sentence count, for the timeline
    chaps, cur = [], ""
    for sc in board["scenes"]:
        cur = sc.get("chapter", cur)
        if not chaps or chaps[-1][0] != cur:
            chaps.append([cur, 0])
        chaps[-1][1] += len(sc.get("beats", []))
    timeline = "".join(f'<span style="flex:{n}" data-chap="{esc(c)}"><i></i><b>{esc(c)}</b></span>' for c, n in chaps)
    page = f'''<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>{esc(board.get("title", "Diff review"))}</title>
<style>
{css}
{beat_css()}
{chr(10).join(ctx.css)}
</style></head>
<body>
<div class="ground"></div>
<header class="hud"><span class="hchap"><b id="chn"></b><span id="chapter"></span></span>
<span class="hright">{esc(menubar.get("right", ""))}</span></header>
<nav class="timeline">{timeline}</nav>
{"".join(parts)}
<script>
// HUD: chapter number and name; timeline: chapters before the current one are full, the current one fills by scene.
const scenes=[...document.querySelectorAll('section[data-say]')];
const segs=[...document.querySelectorAll('.timeline span')];
const names=segs.map(s=>s.dataset.chap);
addEventListener('ve:beat',e=>{{const s=e.target;const i=scenes.indexOf(s);const c=s.dataset.chapter||'';const ci=names.indexOf(c);
document.getElementById('chapter').textContent=c;document.getElementById('chn').textContent=String(ci+1).padStart(2,'0');
const same=scenes.filter(x=>x.dataset.chapter===c);const k=same.indexOf(s);
segs.forEach((g,j)=>{{g.classList.toggle('on',j===ci);g.querySelector('i').style.width=(j<ci?100:j>ci?0:((k+1)/same.length*100))+'%';}});
// code callout: park the note for this sentence next to the first highlighted line
const b=e.detail&&e.detail.beat;const note=s.querySelector('.note.nt'+b);
if(note){{const stage=s.querySelector('.coderow');const ln=s.querySelector('.ln.f'+b);
const sr=stage.getBoundingClientRect(),k=sr.height/stage.offsetHeight||1;const top=ln?(ln.getBoundingClientRect().top-sr.top)/k+ln.offsetHeight/2:40;
const max=stage.clientHeight-note.offsetHeight-6;note.style.top=Math.max(6,Math.min(max,top-note.offsetHeight/2))+'px';
note.style.setProperty('--py',(top-Math.max(6,Math.min(max,top-note.offsetHeight/2)))+'px');}}
}});
</script>
<script>
// Stepper: opened in a browser (not by the video renderer), the deck plays itself one sentence at a time.
// → / space / click: next sentence · ←: back · ↓ / ↑: next / previous scene · Home / End.
addEventListener('load',()=>{{ if(window.__ve) return;
const S=[...document.querySelectorAll('section[data-say]')];
const L=S.map(s=>s.dataset.say.trim().split(/(?<=[.!?])\s+/).filter(Boolean));
let si=0,bi=1,prev=null;
const cap=document.body.appendChild(Object.assign(document.createElement('p'),{{className:'ve-caption'}}));
const pos=document.body.appendChild(Object.assign(document.createElement('div'),{{className:'stepper-pos'}}));
const fit=()=>{{const k=Math.min(innerWidth/1280,innerHeight/720);document.body.style.transform=`translate(${{(innerWidth-1280*k)/2}}px,${{(innerHeight-720*k)/2}}px) scale(${{k}})`;}};
document.documentElement.classList.add('stepper');fit();addEventListener('resize',fit);
const show=()=>{{const s=S[si];
  if(prev&&prev!==s){{S.forEach(x=>x.removeAttribute('data-was'));prev.removeAttribute('data-beat');prev.setAttribute('data-was','');}}
  s.removeAttribute('data-was');s.setAttribute('data-beat',Array.from({{length:bi+1}},(_,n)=>n).join(' '));prev=s;
  s.dispatchEvent(new CustomEvent('ve:beat',{{bubbles:true,detail:{{scene:si,beat:bi}}}}));
  cap.textContent=L[si][bi-1]||'';pos.textContent=`${{si+1}} / ${{S.length}}  ·  ${{bi}} / ${{L[si].length}}`;}};
const go=(d)=>{{ if(d>0){{ if(bi<L[si].length) bi++; else if(si<S.length-1){{si++;bi=1;}} }}
  else {{ if(bi>1) bi--; else if(si>0){{si--;bi=L[si].length;}} }} show(); }};
const scene=(d)=>{{si=Math.max(0,Math.min(S.length-1,si+d));bi=1;show();}};
addEventListener('keydown',e=>{{const k=e.key;
  if(k==='ArrowRight'||k===' '||k==='PageDown'){{e.preventDefault();go(1);}} else if(k==='ArrowLeft'||k==='PageUp'){{e.preventDefault();go(-1);}}
  else if(k==='ArrowDown'){{e.preventDefault();scene(1);}} else if(k==='ArrowUp'){{e.preventDefault();scene(-1);}}
  else if(k==='Home'){{si=0;bi=1;show();}} else if(k==='End'){{si=S.length-1;bi=1;show();}} }});
const toc=document.body.appendChild(Object.assign(document.createElement('div'),{{className:'toc'}}));
const chapters=[];S.forEach((s,i)=>{{const c=s.dataset.chapter||'';if(!chapters.length||chapters[chapters.length-1].c!==c)chapters.push({{c,i}});}});
toc.innerHTML='<b>Chapters</b>'+chapters.map((x,j)=>`<a data-i="${{x.i}}"><em>${{String(j+1).padStart(2,'0')}}</em>${{x.c}}</a>`).join('')+'<small>T to close · click a chapter</small>';
toc.addEventListener('click',e=>{{const a=e.target.closest('a');if(a){{si=+a.dataset.i;bi=1;show();}}toc.classList.remove('open');e.stopPropagation();}});
addEventListener('keydown',e=>{{if(e.key==='t'||e.key==='T')toc.classList.toggle('open');}});
addEventListener('click',e=>{{ if(toc.classList.contains('open')) return; if(e.clientX<innerWidth/3) go(-1); else go(1); }});
show(); }});
</script>
</body></html>'''
    out = Path(sys.argv[2])
    out.write_text(page, encoding="utf-8")
    n_beats = sum(len(s.get("beats", [])) for s in board["scenes"])
    print(f"wrote {out} ({len(board['scenes'])} scenes, {n_beats} sentences)")


if __name__ == "__main__":
    main()
