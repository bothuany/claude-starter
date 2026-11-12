#!/usr/bin/env python3
"""Who-uses-whom between the files of a change, read from git.

For each file it collects the type names the file declares, then adds an edge A -> B when file A mentions
a type declared in file B (comments and strings removed, whole words only). It is a heuristic, not a
compiler: good enough to draw how files connect, and printed so a human can spot-check it.

Languages: C#, Java, Kotlin, TypeScript/JavaScript, Python, Go. Other files are nodes without edges.

Usage (spot-check):  codegraph.py <repo> <base> <head> [glob ...]
"""
import re
import subprocess
import sys
from fnmatch import fnmatch
from pathlib import PurePosixPath

DECL = {
    ".cs": r"\b(?:class|record|interface|struct|enum)\s+([A-Z]\w+)",
    ".java": r"\b(?:class|interface|enum|record)\s+([A-Z]\w+)",
    ".kt": r"\b(?:class|interface|object)\s+([A-Z]\w+)",
    ".ts": r"\bexport\s+(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum|function|const)\s+([A-Za-z_]\w+)",
    ".tsx": r"\bexport\s+(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum|function|const)\s+([A-Za-z_]\w+)",
    ".js": r"\bexport\s+(?:default\s+)?(?:class|function|const)\s+([A-Za-z_]\w+)",
    ".mjs": r"\bexport\s+(?:default\s+)?(?:class|function|const)\s+([A-Za-z_]\w+)",
    ".py": r"^(?:class|def)\s+([A-Za-z_]\w+)",
    ".go": r"^(?:type|func)\s+(?:\([^)]*\)\s*)?([A-Z]\w+)",
}
C_LIKE = {".cs", ".java", ".kt", ".ts", ".tsx", ".js", ".mjs", ".go"}
# names too generic to prove a link, or that collide with framework types
GENERIC = {"Program", "Startup", "Constants", "Extensions", "Helper", "Helpers", "Utils", "Result", "Item", "Entry",
           "Options", "Settings", "Context", "Base", "Model", "Models", "Request", "Response", "Service", "Status",
           "Summary", "Handler", "Config", "Configuration", "Error", "State", "Data", "Value", "Values", "Key", "Type"}
TEST_GLOBS = ["*Test*/*", "*Tests/*", "*/test/*", "*/tests/*", "*Tests.cs", "*Test.cs", "*.spec.*", "*.test.*", "test_*.py"]


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, check=True).stdout


def strip_noise(text, ext):
    if ext in C_LIKE:
        text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
        text = re.sub(r"//[^\n]*", " ", text)
        text = re.sub(r'@?\$?"(?:[^"\\\n]|\\.)*"', '""', text)
    elif ext == ".py":
        text = re.sub(r"#[^\n]*", " ", text)
        text = re.sub(r'"""(?:.|\n)*?"""|\'\'\'(?:.|\n)*?\'\'\'', " ", text)
    return text


def changed_files(repo, base, head):
    """path -> (status letter, added, deleted) for files present at head."""
    st = {}
    for line in git(repo, "diff", "--name-status", base, head).splitlines():
        p = line.split("\t")
        st[p[-1]] = p[0][0]
    out = {}
    for line in git(repo, "diff", "--numstat", base, head).splitlines():
        a, d, p = line.split("\t")
        if " => " in p:
            pre, _, rest = p.partition("{")
            old_new, _, post = rest.partition("}")
            p = pre + old_new.split(" => ")[-1] + post if rest else p.split(" => ")[-1]
        if st.get(p) == "D":
            continue
        out[p] = (st.get(p, "M"), int(a) if a != "-" else 0, int(d) if d != "-" else 0)
    return out


def is_test(path, globs=TEST_GLOBS):
    return any(fnmatch(path, g) for g in globs)


def build(repo, base, head, include=None, exclude=None, test_globs=None):
    """Returns dict(nodes={path: info}, edges=set((a, b)), tests={path: n_test_files_using_it})."""
    files = changed_files(repo, base, head)
    test_globs = test_globs or TEST_GLOBS
    texts, decl = {}, {}
    for p in files:
        ext = PurePosixPath(p).suffix.lower()
        if ext not in DECL:
            continue
        try:
            raw = git(repo, "show", f"{head}:{p}")
        except subprocess.CalledProcessError:
            continue
        body = strip_noise(raw, ext)
        texts[p] = body
        names = {n for n in re.findall(DECL[ext], body, flags=re.M) if len(n) >= 4 and n not in GENERIC}
        decl[p] = names
    owner = {}
    for p, names in decl.items():
        for n in names:
            owner.setdefault(n, set()).add(p)
    words = {p: set(re.findall(r"\b[A-Za-z_]\w{3,}\b", t)) for p, t in texts.items()}
    prod = [p for p in texts if not is_test(p, test_globs)
            and (not include or any(fnmatch(p, g) for g in include))
            and not (exclude and any(fnmatch(p, g) for g in exclude))]
    edges = set()
    for a in prod:
        for n in words[a] & owner.keys():
            for b in owner[n]:
                if b != a and b in prod:
                    edges.add((a, b))
    tests = {}
    for t in (p for p in texts if is_test(p, test_globs)):
        for n in words[t] & owner.keys():
            for b in owner[n]:
                if b in prod:
                    tests.setdefault(b, set()).add(t)
    nodes = {p: {"status": files[p][0], "added": files[p][1], "deleted": files[p][2], "types": sorted(decl.get(p, ()))}
             for p in prod}
    return {"nodes": nodes, "edges": edges, "tests": {k: len(v) for k, v in tests.items()}}


HUB_GLOBS = ["*ServiceCollectionExtensions*", "*/Startup.*", "*/Program.*", "*Module.*", "*/main.*"]


def build_multi(repos, include=None, exclude=None, hubs=None, test_globs=None):
    """One graph over several repos. repos: {alias: {path, base, head}}; include/exclude: {alias: [globs]}.

    Node ids are file stems ("JobTriggerHandler"); a stem that occurs in two repos gets "alias:" in front.
    Interface files (IFoo next to Foo) fold into Foo. Hub files (DI wiring, startup) fold into one
    "wiring" node whose edges are dropped, because they reference everything and hide the real structure.
    """
    include, exclude = include or {}, exclude or {}
    hubs = HUB_GLOBS + list(hubs or [])
    test_globs = test_globs or TEST_GLOBS
    files, texts, decl = {}, {}, {}
    for alias, r in repos.items():
        for p, info in changed_files(r["path"], r["base"], r["head"]).items():
            key = (alias, p)
            if is_test(p, test_globs):
                files[key] = ("test",) + info
            elif include.get(alias) is not None and not any(fnmatch(p, g) for g in include[alias]):
                continue
            elif exclude.get(alias) and any(fnmatch(p, g) for g in exclude[alias]):
                continue
            else:
                files[key] = ("prod",) + info
            ext = PurePosixPath(p).suffix.lower()
            if ext not in DECL:
                continue
            try:
                body = strip_noise(git(r["path"], "show", f"{r['head']}:{p}"), ext)
            except subprocess.CalledProcessError:
                continue
            texts[key] = body
            decl[key] = {n for n in re.findall(DECL[ext], body, flags=re.M) if len(n) >= 4 and n not in GENERIC}
    prod = [k for k, v in files.items() if v[0] == "prod"]
    stems = {}
    for a, p in prod:
        stems.setdefault(PurePosixPath(p).stem, []).append((a, p))
    nid = {}
    for stem, keys in stems.items():
        for k in keys:
            nid[k] = stem if len(keys) == 1 else f"{k[0]}:{stem}"
    # fold IFoo into Foo when both are in the change
    for k in prod:
        st = PurePosixPath(k[1]).stem
        if re.fullmatch(r"I[A-Z]\w+", st) and st[1:] in stems and len(stems[st[1:]]) == 1:
            nid[k] = nid[stems[st[1:]][0]]
    for k in prod:
        if any(fnmatch(k[1], g) for g in hubs):
            nid[k] = "wiring"
    owner = {}
    for k, names in decl.items():
        for n in names:
            owner.setdefault(n, set()).add(k)
    words = {k: set(re.findall(r"\b[A-Za-z_]\w{3,}\b", t)) for k, t in texts.items()}
    edges, tested = set(), {}
    for k in texts:
        for n in words[k] & owner.keys():
            for b in owner[n]:
                if b not in nid or b == k:
                    continue
                if files[k][0] == "test":
                    tested.setdefault(nid[b], set()).add(k)
                elif k in nid and nid[k] != nid[b] and "wiring" not in (nid[k], nid[b]):
                    edges.add((nid[k], nid[b]))
    nodes = {}
    for k in prod:
        i = nid[k]
        _, st, add, dele = files[k]
        n = nodes.setdefault(i, {"id": i, "repo": k[0], "paths": [], "status": st, "added": 0, "deleted": 0})
        n["paths"].append(k[1])
        n["added"] += add
        n["deleted"] += dele
        if st == "A" and n["status"] != "A" and k[1].endswith(PurePosixPath(k[1]).stem + PurePosixPath(k[1]).suffix):
            pass
    for i, n in nodes.items():
        n["tests"] = len(tested.get(i, ()))
        n["path"] = sorted(n["paths"], key=lambda p: PurePosixPath(p).stem.startswith("I"))[0]
    return {"nodes": nodes, "edges": sorted(edges)}


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    repo, base, head, *globs = sys.argv[1:]
    g = build(repo, base, head, include=globs or None)
    stem = lambda p: PurePosixPath(p).stem
    print(f"{len(g['nodes'])} files, {len(g['edges'])} edges")
    for a, b in sorted(g["edges"]):
        print(f"  {stem(a)} -> {stem(b)}")
    print("tests:", {stem(k): v for k, v in sorted(g["tests"].items())})


if __name__ == "__main__":
    main()
