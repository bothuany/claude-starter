# Storyboard reference

A storyboard is one JSON file. `build_deck.py` turns it into a step-through page. Every visual is
generated from the JSON. Code is
read from git refs at build time, so the page always shows the real change.

## Contents
1. Top level
2. Beats: the one rule that drives everything
3. Scene types (map, trace, state, predict, title, chapter, flow, sequence, code, compare, cards, files)
4. Code excerpts: segments and marks
5. Icons and tones
6. Layout limits and how to stay inside them
7. Minimal example

## 1. Top level

```json
{
  "title": "Background jobs, now run from the database",
  "menubar": {"app": "Diff Review", "right": "repo-a #57 · repo-b #36"},
  "repos": {
    "api":    {"name": "repo-b", "path": "/abs/path/repo-b", "base": "c397c9c", "head": "origin/feature/x"},
    "shared": {"name": "repo-a", "path": "/abs/path/repo-a", "base": "306f80ab6", "head": "origin/feature/x"}
  },
  "default_repo": "api",
  "strip": ["\\.ConfigureAwait\\(false\\)"],
  "drop_lines": ["^\\s*;\\s*$"],
  "graph": {"include": {"api": ["src/*.cs"], "shared": ["lib/*.cs"]}, "hubs": ["*/Configuration/*"]},
  "scenes": [ ... ]
}
```

- `repos`: one entry per repository in the review. `base` and `head` are any git refs. Use the
  **remote** ref (`origin/...`) for a PR head when the local branch may be stale.
- `strip`: regexes removed from every line before display. Use it for noise that hides the idea
  (`ConfigureAwait(false)`, logging boilerplate).
- `drop_lines`: regexes for whole lines to hide. A dropped line that ended a statement moves its `;`
  to the line before.
- `graph`: which files the file map and the code context strip use. `include` / `exclude` are globs per
  repo alias (production code only; tests are detected and shown as badges). `hubs` adds files to fold into a
  single "wiring" node (DI registration, startup; `*ServiceCollectionExtensions*`, `Startup.*`, `Program.*`
  are folded by default) — they reference everything and would hide the real structure. Check the graph with
  `scripts/codegraph.py <repo> <base> <head> [glob]` before relying on it: it matches type names, so a very
  generic name can add a false edge.


## 2. Beats: the one rule that drives everything

Every scene has `beats`. Each beat is **exactly one sentence** (`say`, shown as the caption) and the change
on screen that goes with it (`show`, plus `note` on code scenes).

```json
{"say": "The lease is a single conditional update, with no lock table.",
 "show": ["var affected = await db.Schedules"], "note": "One UPDATE, no locks"}
```

- One sentence: the page splits text on `. ! ?` followed by a space. A second sentence in one
  beat shifts every later highlight by one. The builder rejects such beats. Use a colon or semicolon
  to join clauses: "Zero rows means someone else handled it; nothing runs."
- Avoid `e.g.`, `i.e.`, version numbers like `v2. Then` and other `.`+space inside a sentence.
- `show` lists what is in focus during this beat. Everything else in the scene dims. An element first
  appears on the first beat that shows it, unless it is part of the base picture (see `base`).
- An empty `show` (`[]`) means "show everything, focus nothing". Use it for summary beats.
- `hold` (scene level, seconds, default 1.2): extra silence after the last beat.

## 3. Scene types

All scenes take `type`, `chapter` (the label in the menubar; carries over until changed), `beats`.

### map (how the changed files connect)
`heading`, `lanes: [{id, label, match: ["alias:glob", ...]}]`, `camera?`. Nodes are the graph's files; a
file goes into the first lane whose glob matches; files in no lane are reported at build time. Edges are
"A uses a type declared in B". Green dot = new file, violet = changed; `✓N` = test files that use it.

- `show` takes file ids (file stem, `alias:stem` when two repos share a stem), lane ids, and chains
  `"A>B>C"` (lights the files and the edges between them). An edge lights up whenever both ends are shown.
- `zoom: true` on a beat (or `camera: true` on the scene) moves the camera onto the shown files.
- Five lanes and ~60 files fit; more than ~15 files in a lane gets small — split lanes or narrow `include`.

### trace (follow one execution across files)
`heading`, `hops: [{file, repo?, title, say, anchor | segments, back?, extra?, mark?, via?}]`, 2–6 hops.
Each hop is a small code window with the real call line highlighted. `anchor` picks one line (with `back` /
`extra` lines around it); `segments` + `mark` picks a longer excerpt. `via` labels the arrow to the next hop
(the call: `ClearTriggerAsync`). `say` is a 2–5 word subtitle under the hop title. Beat *k* focuses hop *k*
and reveals it; write one beat per hop. Keep each hop to 3–8 short lines.

### state (a data walk: one example row changing)
`heading`, `table: {name, columns}`, `rows` (the starting rows, `"null"` for empty), and per beat:
`action` (who does what, shown as the step title), `icon`, `code` (the statement, short), `set`
`{"<row index>.<column>": value}` applied cumulatively, `outcome` and `tone` (`orange`/`red` for a refused or
failed step). Changed cells light up; earlier steps stay listed under "so far". Use real column names and
plausible values; 1–3 rows and 3–6 columns read best.

### predict (ask, then reveal)
`question`, `options: [{text, why, correct?}]` (exactly one `correct`, 3 options), and optionally a code
excerpt (`file`, `segments`, `symbol`) shown as evidence beside the question. Beat 1 asks; beat 2 reveals:
the right option turns green, every option shows its `why`. Put code `show` marks only on beat 2, so the
highlight does not give the answer away. Base wrong options on real misconceptions.

### title
`kicker`, `title`, `subtitle`, `chips: [{id, text, icon}]`, `verdict: {text, tone: ok|warn|bad, icon}`.
`show` ids: chip ids and `"verdict"`.

### chapter
`number`, `title`, `blurb`. One beat is enough. Use 4–8 chapters per walkthrough.

### flow (architecture, data flow, state machine)
`window` (title bar text), `nodes`, `edges`, optional `groups`.

- Node: `{id, label, sub, code?, icon, col, row, w?, h?, tone?, base?}`. `code` names the class or file
  that implements the box; use it on every box that has one, so the jump from diagram to code is visible. The canvas is a 12 × 5 grid
  (1176 × 470 px); `col` 0–11 and `row` 0–4 place the node centre and may be fractional. Default size
  236 × 78. Long `SNAKE_CASE` labels wrap at `_`.
- Edge: `{from, to, label?, dashed?, bend?, tone?: red|green, base?}`. Its show id is `"from>to"`.
  `bend` (px) curves the edge; use it when an edge would cross a node.
- The focused edge gets a dot that travels from source to target. Show the edge together with its
  target node when the narration says "A writes to B".
- `base: true` keeps an element visible from the first beat (dimmed until focused). Without it, the
  element appears on the first beat that shows it. Build the picture up beat by beat; that is the
  teaching effect.

### sequence (one request or one cycle over time)
`window`, `actors: [{id, label, icon}]`, `messages: [{id, from, to, label, reply?, tone?}]`.
`from == to` draws a self-call. Up to 6 actors and 9 messages fit. `show` uses message ids.

### code (the walkthrough)
`repo?`, `ref?` (`head` default, `base`, `worktree`, or any ref), `file`, `segments`, `symbol` (shown
after the file name in the title bar), `chips?`, `height?`.

- Lines added by the PR get a green gutter bar; the title bar shows "+N lines in this PR".
- A strip above the window shows "used by → this file → uses" from the file graph, the file's status and its
  test count. `context: false` hides it.
- Beats use `show` for **highlight marks** (see section 4) and `note` for a callout that sits next to the
  first highlighted line. Write the note as a 2–5 word headline ("Clear first = at most once").
- Line numbers are never shown. The viewer follows the highlight, not numbers.

### compare (before/after)
`left` and `right`. Each side is either a code spec (`repo`, `ref`, `file`, `segments`, `height`) or a
list `items: [{id, text, icon?, base?}]`, plus `label`, `tag`, `tone` (`red` for before, `green` for
after), `icon` (item bullet). `arrow: false` hides the bolt between panes.

- `show: ["left"]` / `["right"]` focuses a pane. Showing an item id also focuses its pane.
- Code sides take marks from `left_marks` / `right_marks` on the beat.
- The left pane is visible from the start; the right pane appears on its first beat. Set
  `"base": true` on the right side to show both from the start.

### cards (failure modes, risks, release checklist)
`heading`, `columns` (2–3), `items: [{id, title, body, tag, tone, icon}]`. Tones: `red` blocker,
`orange` risk/config, `purple` follow-up, `green` done. Keep `body` under ~25 words. Six cards fit.

### files (what changed, by area)
`repo`, `window`, `groups: [{id, label, icon, match: [glob, ...]}]`, `other: false` to hide the
leftover group. Counts come from `git diff --numstat base head`. The first matching group wins, so
put narrow globs first (for example `Tests` before `*`).

## 4. Code excerpts: segments and marks

`segments` selects the lines to show, in file order. Excerpts read better than whole files: show the
5–25 lines that carry the idea. Gaps between segments render as `⋯`.

| Segment form | Meaning |
|---|---|
| `{"start": "text"}` | the first line at or after the cursor that contains `text` |
| `{"start": "a", "end": "b"}` | from the line containing `a` to the next line containing `b` |
| `{"after": "x", "start": "a", ...}` | jump to `x` first, then search for `a` (to pick the right overload) |
| `"extra": n` / `"back": n` | add `n` lines after the end / before the start (for closing braces) |
| `{"lines": "40-58"}` | an original line range; prefer anchors, which survive rebases |
| `keep_comments` / `keep_docs` | keep comment / doc-comment lines (removed by default) |

Anchors are plain substrings, searched **after the previous segment**. Every lookup that fails stops
the build with the file and anchor, so typos never reach the page. `strip` runs before matching:
anchor on text that remains after stripping.

Marks in a beat's `show` (or `left_marks` / `right_marks`):
- `"text"` highlights the first excerpt line containing `text`;
- `["from", "to"]` highlights from the first line containing `from` to the next line containing `to`.

The current marks get an accent bar and background; other lines dim to 42 %.

## 5. Icons and tones

Icons: `db table service timer queue user api file shield bolt lock filter clock alert check x box
cloud settings branch heart trash`.

Node tones: default blue, `green teal orange purple red gray`. Use one meaning per tone in a walkthrough:
for example, gray for people and inputs, purple for the scheduler, orange for the run path, blue for
tables.

## 6. Layout limits and how to stay inside them

- Code font size fits the excerpt to the box (wrapping included). The builder warns at
  `font 12px — trim the excerpt`: under 14 px is hard to read. Split the excerpt into two
  scenes, or drop lines with `strip` and narrower segments.
- A code scene with notes is ~880 px wide for code; without notes ~1180 px. About 24 short lines fit.
- Flow: up to ~9 nodes. Sequence: up to 6 actors, 9 messages. Cards: up to 6.
- Captions sit in a glass pill at the bottom. Keep each sentence ≤ ~22 words so it fits two lines.

## 7. Minimal example

(The page also supports `map`, `trace`, `state` and `predict`; see section 3.)

```json
{
  "title": "Retry on 429",
  "menubar": {"app": "Diff Review", "right": "api #12"},
  "repos": {"api": {"path": "/abs/repo", "base": "origin/main", "head": "origin/feature/retry"}},
  "default_repo": "api",
  "scenes": [
    {"type": "title", "chapter": "Overview", "kicker": "Code review · api #12", "title": "Retry on 429",
     "subtitle": "Rate-limited calls now back off and retry.", "verdict": {"text": "Ready to merge", "tone": "ok", "icon": "check"},
     "beats": [{"say": "This change makes the client retry when the server says it is too busy.", "show": []},
               {"say": "It is ready to merge.", "show": ["verdict"]}]},
    {"type": "flow", "chapter": "Behavior", "window": "Request path",
     "nodes": [{"id": "c", "label": "Client", "icon": "api", "col": 1, "row": 2},
               {"id": "r", "label": "RetryHandler", "sub": "max 3, jitter", "icon": "timer", "col": 5, "row": 2, "tone": "purple"},
               {"id": "s", "label": "Server", "icon": "cloud", "col": 9, "row": 2, "tone": "gray"}],
     "edges": [{"from": "c", "to": "r", "label": "sends"}, {"from": "r", "to": "s", "label": "calls"},
               {"from": "s", "to": "r", "label": "429", "tone": "red", "bend": 50}],
     "beats": [{"say": "Every request now passes through a retry handler.", "show": ["c", "r", "c>r"]},
               {"say": "When the server answers 429, the handler waits and calls again.", "show": ["s", "r>s", "s>r"]}]},
    {"type": "code", "chapter": "Behavior", "file": "src/RetryHandler.cs", "symbol": "SendAsync",
     "segments": [{"start": "protected override async Task<HttpResponseMessage> SendAsync", "end": "return response;", "extra": 1}],
     "beats": [{"say": "The loop tries at most three times.", "show": ["for (var attempt"], "note": "At most 3 tries"},
               {"say": "The wait doubles on each try, with random jitter.", "show": [["var delay", "await Task.Delay"]], "note": "Exponential + jitter"}]}
  ]
}
```
