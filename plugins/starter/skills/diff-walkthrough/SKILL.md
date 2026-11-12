---
name: diff-walkthrough
description: Turn a code change (PR, branch, commit range, or diff across one or more repos) into an interactive, slide-style code walkthrough that a reader steps through with the arrow keys until they master the code — a file map computed from git (which changed file uses which), call paths followed hop by hop across files with the real lines, code excerpts with "used by → this file → uses" context and callouts on the highlighted lines, data walks that show a table row changing step by step, predict-then-reveal questions, plus architecture, sequence and before/after diagrams. Use this whenever the user wants to understand, learn, review or present a change, a PR, a diff or a branch visually, or asks for a walkthrough, explainer, tour, slides or "video" of a code change — even if they only say "explain this PR", "walk me through this diff", "bu PR'ı anlat", "kod review" or "make a video of this PR".
---

# Diff walkthrough

Make a step-through page that leaves the reader able to explain the change, find their way around its files,
and predict how the code behaves. One sentence per step; the picture changes with every sentence; arrow keys
move. No audio, no render.

The look is an engineering canvas: diagrams sit flat on a blueprint grid; **only code gets a macOS window**,
so a window always means "this is the real file". A HUD names the chapter, a timeline shows progress, and
`T` opens a chapter list.

```
facts ──► storyboard.json ──► stills (look at every scene) ──► page
workflow    you write it         drv.sh stills                  drv.sh page
```

Everything after the storyboard is scripted. Your work is the facts and the teaching.

Needs `uv`, `git`, and `node`/`npx` (stills only). Behind TLS interception, `drv.sh` uses
`~/.config/jev/ca-bundle.pem` when it exists.

## 1. Gather the facts

Every claim must come from the code.

**Default: run the fact workflow.** It reads on cheaper models and checks every claim against the code, so
the main session only writes the story:

```
Workflow({scriptPath: "${CLAUDE_PLUGIN_ROOT}/skills/diff-walkthrough/scripts/gather-facts.workflow.js",
          args: {repos: {<alias>: {path, base, head}}, pr_text: "<PR descriptions, optional>", max_components: 4}})
```

| Stage | Model | Count |
|---|---|---|
| Inventory: stats, file groups, option defaults, tests, components | Haiku | 1 |
| Explain: 6–14 facts per component with `why` and an anchor, one diagram, undocumented changes | Sonnet | 1 per component |
| Check: anchor exists at head, code supports the claim | Haiku | 1 per component |
| Release: preconditions outside the code | Sonnet | 1 |

The result holds `inventory`, `components[].facts` (checked, sometimes with a `correction` — use the
corrected version), `components[].dropped` (failed the check, with the reason; read it, some are right with a
wrong anchor) and `release`. Use the facts' anchors directly as segments and marks.

Skip the workflow for a small change (under ~10 files) and read it yourself. Either way, cover:

1. `git diff --stat` and `--name-status` per repo between the exact refs. Use the remote PR head
   (`origin/feature/...`); a local branch may be behind.
2. The **full** changed files at head, not only hunks.
3. Who calls the new code, what it calls, options and their defaults, tests (they state intent), PR
   descriptions and commit messages.
4. What the diff changes that the PR text does not mention.
5. Release preconditions outside the code: tables, config rows, merge order, follow-ups.

Do not invent a rationale. If the "why" is unknown, describe the behavior.

## 2. Write the storyboard

Read `references/storyboard.md` for the schema, then write `<name>.storyboard.json` (default folder
`~/.agent/diagrams/`). Check the file graph first: `scripts/codegraph.py <repo> <base> <head> [glob]`
prints the edges the map will draw.

### What makes the reader master the code

Teach the way a senior engineer onboards a colleague: orient, follow one real path, open the code, then make
them predict.

1. **Orient before detail.** The `map` shows every changed file by layer and who uses whom. Each chapter
   starts by zooming onto its files, so the reader always knows where they are.
2. **Follow real execution, not file order.** A `trace` walks one call across files with the actual call
   line per hop. This is what "how do these files connect" means; use it in every chapter that spans files.
3. **Make data concrete.** When code moves rows or state, a `state` walk shows one example row changing
   step by step (with the statement that changes it). Abstract "the lease" becomes "OWNER = A, then B".
4. **Code for the decisions.** `code` scenes go to the blocks where order, guards or races matter. Each
   highlight gets a 2–5 word note; the narration says what breaks without that line.
5. **Ask before telling.** End each chapter with a `predict`: a concrete situation ("two pods run this at
   once — what happens?"), three plausible options, the answer and the reason on the next step. Wrong
   options must be real misconceptions, not jokes. This is where understanding is checked, not assumed.
6. **Close with consequences.** Failure behavior (`flow` as a state machine, or `cards`) and a release
   checklist.

### Arc

1. **Title**: what changed, size, one-line verdict.
2. **The idea**: before/after `compare`, the architecture `flow` (each box names its class in `code`),
   the `map`.
3. **One chapter per behavior**, in the order data flows: `chapter` card → map zoom → `flow`/`sequence` of
   the mechanism → `trace` → `state` (when data moves) → 1–3 `code` → `predict`.
4. **Failure behavior.**
5. **Before it ships**: `cards`.

### Sentence rules

- **One sentence per step, and every sentence changes the picture.** Nothing new to show: merge or cut.
- About 20 words or fewer, present tense, active voice, plain words.
- Say what the code does and why, not what it is called: "The clear runs before the trigger, so a failed
  write can never fire the job twice" beats "This calls ClearTriggerAsync".
- Reuse the diagram's words in the code notes and the trace titles, so the three views connect.
- No line numbers. The highlight shows where.

### Code excerpts

Show the 5–25 lines that carry the idea, with anchors, not whole files. When the build prints
`font 12px — trim the excerpt`, split the scene or cut lines: under 14 px is hard to read.

## 3. Look at every scene

```bash
${CLAUDE_PLUGIN_ROOT}/skills/diff-walkthrough/scripts/drv.sh stills <board>.json
```

Builds `<name>.html`, renders the last step of every scene to `<name>.stills/`, and tiles them into 2 × 2
contact sheets in `<name>.stills/sheets/`. **Read every sheet** and fix what you see:

- text cut off or overlapping; the caption covering content;
- the wrong line highlighted (an anchor matched an earlier line — use `after` or a longer anchor);
- a map lane with too many files, or files reported "in no lane" at build time;
- code too small to read.

Build errors name the file and anchor that failed. Fix the storyboard, not the generated HTML.

## 4. Open the page

```bash
${CLAUDE_PLUGIN_ROOT}/skills/diff-walkthrough/scripts/drv.sh page <board>.json
```

Keys: → / space / click = next sentence, ← = back, ↓ / ↑ = next / previous scene, `T` = chapters,
Home / End.

## 5. Deliver

Report the page path, the scene and chapter count, and the blockers or risks the walkthrough states, so the
user learns them without opening it. When the user has the `get-it` skill, offer its quiz after they have
stepped through: it measures whether the walkthrough taught the change.

## Files

- `scripts/drv.sh`: `page | build | stills`.
- `scripts/build_deck.py`: storyboard → page; reads code from git; validates anchors and steps.
- `scripts/codegraph.py`: the who-uses-whom file graph behind `map` and the code context strip.
- `scripts/gather-facts.workflow.js`: the fact workflow.
- `scripts/sheets.py`: contact sheets for stills review.
- `assets/deck.css`: the visual system.
- `references/storyboard.md`: schema, every scene type, segment and mark syntax, layout limits.
