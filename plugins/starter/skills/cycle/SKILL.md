---
name: cycle
description: Run one piece of work as a cycle - gather, plan, plan review, build, code review, probe - handing off through a plan file so the build and the reviews start in a clean context. With a description it starts a cycle, with no argument it resumes the open one, with "off" it stops it. Use only when the user types /starter:cycle.
argument-hint: "[work | off]"
disable-model-invocation: true
---

A cycle is for one piece of work, started by the user. Questions and one-line fixes that come up during a cycle are answered directly, outside it. `$ARGUMENTS` decides what to do:

- **A description of the work:** start a cycle. Pick a short slug, create the work branch `cycle/<slug>` from the current branch, and write `docs/plans/<slug>.md` as the contract below says.
- **Nothing:** resume. Read the plans in `docs/plans/` that have a `cycle:` key; the one whose `phase` is not `done` is the open cycle (ask which when there are several; say there is none when there are none). Continue at its `phase`. This is how a new session picks a cycle up.
- **`off`:** stop. Set `phase: done` and add the log line `- off: stopped at <phase>`.

## Phases

The lead is this session. It re-reads the plan file at the start of every phase and works from the file, not from memory.

1. **gather** (lead). Settle what the work is for and its decisions with the user, a few questions at a time (`/starter:grill` is the same interview). Wide reading goes to `reader`.
2. **plan** (lead). Write the plan file: why, decisions, items, each with a check. The `visual-plan` skill can render it as a page; the file stays the source of truth.
3. **plan-review** (`reviewer`, once). Start it as the named role `reviewer` on the plan file. The lead settles each finding in the plan, then sets `waiting: user` and asks the user to approve. It stays until the user answers.
4. **build** (`writer`). Start the named role `writer` with the plan file as its brief, on the work branch. It builds the items in order and ticks each after its check passes. Run a second `writer` after the first only for a separate part of the plan. The lead commits on the work branch after each phase that changed files, and never pushes or merges unless asked.
5. **code-review** (`reviewer`). It reviews the diff against the plan and `REVIEW.md`, with the `code-review` skill. Send the findings to the writer that built the change (continue that same agent, so it keeps its context). Re-review only the new diff; after three rounds, ask the user.
6. **probe** (lead). Run every item's check and show the output. For a change `REVIEW.md` puts in its highest tier, or that touches the network, permissions or stored data, have the `reviewer` try to break it too. Then `done`.

Start `writer` and `reviewer` as named roles, never as a fork: a fork inherits the lead's context, which is what the cycle avoids.

## The plan file

`docs/plans/<slug>.md`, at most about 150 lines. The pane and the writer read it by these rules.

- **Front matter:** `cycle` (the slug; a file without it is not a cycle plan), `phase`, `branch`, and `waiting: user`. Only the lead edits it.
- **`phase`** is one of `gather`, `plan`, `plan-review`, `build`, `code-review`, `probe`, `done`. The pane shows the first six as stations and `n/6`, where n is the position of the current phase; `done` shows 6/6, all filled.
- **`waiting: user`** sits on the current phase while it cannot finish without the user's answer: after the reviewer's pass in `plan-review`, or wherever a decision is needed. The lead sets it, and removes it once the user has answered.
- **`## Items`:** one line `- [ ] N. <text>` per item; the text may continue on indented lines. The item's check is the first indented line that starts with `check:` before the next item. The command is what follows `check:`, with one pair of surrounding backticks removed. It runs in bash from the repository root and passes when it exits 0.
- **Ticks:** `- [x]` and `- [X]` both count. The writer ticks an item only after its check passes. CRLF line ends and a BOM are tolerated.
- **`## Log`:** the lead adds one line `- <phase>: <evidence>` each time it moves `phase` on.

Lines inside a fenced code block are not items, sections or log lines.

At each phase change the lead moves `phase:`, sets or clears `waiting: user`, and writes the log line.
