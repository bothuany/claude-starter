---
name: cycle
description: Run one piece of work as a cycle - gather, plan, plan review, build, code review, probe - handing off through a plan file so the build and the reviews start in a clean context. With a description it starts a cycle, with no argument it resumes the open one, with "off" it stops it. Use only when the user types /starter:cycle.
argument-hint: "[work | off]"
disable-model-invocation: true
---

A cycle is for one piece of work, started by the user. Questions and one-line fixes that come up during a cycle are answered directly, outside it. `$ARGUMENTS` decides what to do:

- **A description of the work:** start a cycle. Pick a short slug, create the work branch `cycle/<slug>` from the current branch, and write `docs/plans/<slug>.md` as the contract below says, with one `author:` line set to the output of `git config user.email`. When that output is empty, stop and ask the user to set `user.email` first: a plan without an author is nobody's cycle.
- **Nothing:** resume. Run `git config user.email`, then read the plans in `docs/plans/` that have a `cycle:` key and an `author:` equal to it (ignoring letter case); the one whose `phase` is not `done` is the open cycle (ask which when there are several; say there is none when there are none). A plan with another author is a teammate's, one with no `author:` or with two `author:` lines is unmarked: neither is a cycle of yours, so do not resume it and never run its `check:` commands. Say in one line how many you skipped; if an unmarked plan is the user's own, add its `author:` line only after they say so. Continue at the open cycle's `phase`. This is how a new session picks a cycle up.
- **`off`:** stop. Set `phase: done` and add the log line `- off: stopped at <phase>`.

## Phases

The lead is this session. It re-reads the plan file at the start of every phase and works from the file, not from memory.

1. **gather** (lead). Settle what the work is for and its decisions with the user, a few questions at a time (`/starter:grill` is the same interview). Wide reading goes to `reader`. When the work holds business rules (a calculation, a validation, a state change, a quota, a date or time boundary, a permission), find each one's source in the code, the docs or the data, and ask the user where they disagree or are silent.
2. **plan** (lead). Write the plan file: why, decisions, the rules as cards under `## Rules` (or `none: <why>` when the work holds no business rule), items, each with a check, and a `## Probe` section: how the probe will run the change for real (start what it needs the way this project does, then the request, command or screen that exercises the change) and the result it expects. Find this project's way in this order: `PROBE.md` at the repository root, then the project's own run or probe skill, script or launch config, then a general run tool (the `run` skill, a browser or simulator tool). When none of them settles how or where to run it, ask the user in `gather`; never guess an environment. A change with no behaviour to run (docs, comments) writes `none: <why>` there. The `visual-plan` skill can render it as a page; the file stays the source of truth.
3. **plan-review** (`reviewer`, once). Start it as the named role `reviewer` on the plan file. The lead settles each finding in the plan, then sets `waiting: user` and asks the user to approve, with the rule cards summarized: the user's approval of the plan is the approval of its cards. It stays until the user answers.
4. **build** (`writer`). Start the named role `writer` with the plan file as its brief, on the work branch. It writes each P0/P1 card's test first and sees it fail, then builds the items in order and ticks each after its check passes. When it returns, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-check.mjs" <plan>`: it reruns every check and prints `PASS n/n` or `FAIL k/n: <items>`, plus `· rules n/m: <cards>` when a P0/P1 card has no test naming it, so a later item that broke an earlier one shows; send a FAIL back to the same writer. Run a second `writer` after the first only for a separate part of the plan. The lead commits on the work branch after each phase that changed files, and never pushes or merges unless asked.
5. **code-review** (`reviewer`). It reviews the diff against the plan and `REVIEW.md`, with the `code-review` skill. Send the findings to the writer that built the change (continue that same agent, so it keeps its context). Re-review only the new diff; after three rounds, ask the user.
6. **probe** (lead). Run the change for real as `## Probe` says, compare the result with the expected one, and log the command and what it returned. Checks that only build, grep or test against a stand-in (an in-memory database, a mock) are not a probe. When the change cannot run here (no environment, no access), log `- probe: not run live: <why>` and tell the user; never write a static check as a probe. Then run `plan-check.mjs` on the plan and show its output. For a change `REVIEW.md` puts in its highest tier, or that touches the network, permissions or stored data, have the `reviewer` try to break it too. Then `done`.

Start `writer` and `reviewer` as named roles, never as a fork: a fork inherits the lead's context, which is what the cycle avoids.

## The plan file

`docs/plans/<slug>.md`, at most about 150 lines. The pane and the writer read it by these rules.

- **Front matter:** `cycle` (the slug; a file without it is not a cycle plan), `author` (the git email of whoever started it: the cycle is theirs, and its checks run only for them), `phase`, `branch`, and `waiting: user`. Only the lead edits it.
- **`phase`** is one of `gather`, `plan`, `plan-review`, `build`, `code-review`, `probe`, `done`. The pane shows the first six as stations and `n/6`, where n is the position of the current phase; `done` shows 6/6, all filled.
- **`waiting: user`** sits on the current phase while it cannot finish without the user's answer: after the reviewer's pass in `plan-review`, or wherever a decision is needed. The lead sets it, and removes it once the user has answered.
- **`## Items`:** one line `- [ ] N. <text>` per item; the text may continue on indented lines. The item's check is the first indented line that starts with `check:` before the next item. The command is what follows `check:`, with one pair of surrounding backticks removed. It runs in bash from the repository root and passes when it exits 0.
- **Ticks:** `- [x]` and `- [X]` both count. The writer ticks an item only after its check passes. CRLF line ends and a BOM are tolerated.
- **`## Rules`:** one card per business rule, or the line `none: <why>`. A card is a `### RC<nn> <short name>` heading followed by:
  - `- **Priority:** P0 | P1 | P2`. P0: data integrity, money, a permission boundary, a contract-visible value; P1: any other business rule (the default when the line is missing); P2: display and formatting.
  - `- **Rule:** <one sentence>`.
  - `- **Source:** <file:line you opened, a document section, or a query and its result>`. Never invented.
  - `- **Examples:**` a table of concrete inputs and expected outcomes, with both sides of every boundary.
  - `- **Test:**` the name of the test that locks it, filled in by the writer once the test has failed; the `/phase` pane shows a card as covered when this line has a value.
  - IDs are never renumbered; a dropped card stays as `### ~~RC04~~ dropped: <why>`. Changing an approved card's Rule or Examples needs the user's approval again.
  - Every P0/P1 card needs a test whose name or tag contains `<cycle>/RC<nn>`; `plan-check.mjs` fails the plan while no file outside it names a card that way.
- **`## Probe`:** free text the lead writes in `plan` and follows in `probe`. Neither the pane nor `plan-check.mjs` reads it.
- **`## Log`:** the lead adds one line `- <phase>: <evidence>` each time it moves `phase` on.

Lines inside a fenced code block are not items, sections or log lines.

At each phase change the lead moves `phase:`, sets or clears `waiting: user`, and writes the log line.
