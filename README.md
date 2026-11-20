# claude-starter

A small Claude Code setup. It asks before it assumes, reviews risky changes, and gives a piece of work a named cycle: a plan file, a clean-context build, and reviews that start fresh.

[![version 0.11.2](https://img.shields.io/badge/version-0.11.2-555?style=flat-square)](plugins/starter/.claude-plugin/plugin.json) [![MIT](https://img.shields.io/badge/license-MIT-555?style=flat-square)](LICENSE)

```bash
claude plugin marketplace add bothuany/claude-starter
claude plugin install starter@claude-starter
```

Works from your next session. Nothing is written to your `CLAUDE.md`. Needs Node.js 18+.

## How to use

**Most days: do nothing.** Ask, fix and explore as you always do. The rules and the review gate work in the background.

**For real work, start a cycle:**

```
/starter:cycle add rate limiting to the public API
```

1. **It asks.** A few questions at a time, until the decisions are yours and not guesses.
2. **It writes the plan** to `docs/plans/rate-limiter.md`. Every item carries a command that proves it is done.
3. **A reviewer reads the plan, then you do.** Nothing is built until you approve.
4. **A writer builds it** in a clean context, on the branch `cycle/rate-limiter`, ticking each item when its check passes.
5. **A reviewer reads the code.** The writer fixes what it finds.
6. **The probe runs the change for real** (the request or command the plan names, against a running system) and logs what came back, then reruns every check. If it can't run here, it says so instead of calling the checks a probe.

**Watch it from the side** with `/phase`:

```
rate-limiter                             4/6

 ━━●━━━━━━━●━━━━━━━●━━━━━━━◉╌╌╌╌╌╌╌○╌╌╌╌╌╌╌○
 gather  plan   review   build  review probe

 ▍ Build                                4:12
 ▍ writer · Sonnet 5.5 · high
 ▍ ⠹ Edit limiter.ts
 ▍ checks ███████░░░░░░░░░ 3/7

 ✓ plan review  2 found, 2 settled
 ✓ plan         docs/plans/rate-limiter.md
 ✓ gather       3 decisions

 next: code review · probe
```

| You want to | Type |
|---|---|
| Start a piece of work | `/starter:cycle <what you want>` |
| Pick it up in a new session | `/starter:cycle` |
| See where it stands | `/phase` |
| Stop it | `/starter:cycle off` |
| Think an idea through first | `/starter:grill <the idea>` |
| Teach reviews what is risky here | `/starter:review-setup` |
| Teach the probe how to run this project | `/starter:probe-setup` |

The plan file is the memory, not the conversation: close the session, come back tomorrow, and the cycle continues from the phase the file says.

## The cycle

The cycle is off by default. You start it for one piece of work with `/starter:cycle <work>`; questions and small fixes never enter it. The session you talk to, the lead, moves the work through six phases and hands off through a plan file, `docs/plans/<slug>.md`, so the build and the reviews start in a clean context instead of the lead's long one.

![The cycle. Six phases on one line: gather (lead and you), plan (lead), plan review (reviewer, then you approve), build (writer), code review (reviewer, the writer fixes), probe (lead). Plan review, build and code review run in a clean context that starts from the plan file. Every phase reads and writes docs/plans/slug.md, which holds the phase, the items with their checks, and the log.](assets/cycle.svg)

- **The plan file is the contract.** It holds the decisions and a list of items, each with a check, a command that passes when the item is done. The writer ticks an item only after its check passes. The lead re-reads the file at every phase, so a new session can resume with `/starter:cycle`.
- **Roles are named, never forks.** `writer` builds from the plan file, `reviewer` reviews the plan, then the code against the plan and `REVIEW.md`, and `reader` does wide reading. By default (the `max` profile) the writer runs on Sonnet at high effort, the reviewer on Opus at medium and the reader on Sonnet at medium; the `profile` row of `/config` changes them. A fork would inherit the lead's whole context, which is what the cycle avoids.
- **Work stays on a branch.** The lead creates `cycle/<slug>` and commits there after each phase; nothing is pushed or merged unless you ask.

## Always on

Two things work in every session, with no cycle started:

- **The rules**, about 410 words injected at session start: ask before assuming, check the docs, delegate wide reading to `reader`, and verify before saying done. A failing test or command comes before a bug fix, every review finding needs evidence, and after three review rounds on one change the lead asks you whether the approach is right. [Read them](plugins/starter/rules.md).
- **The review gate**, a `Stop` hook. If the session changed enough code and no review ran, it asks for one, once. When the change is not risky (no network, permissions or stored data), Claude says so in one line and stops.

## What's inside

| Piece | What it does |
|---|---|
| Working rules | The always-on rules above |
| Review gate | The `Stop` hook above |
| `/starter:cycle` | `/starter:cycle <work>` starts a cycle and writes its plan file; with no argument it resumes the open one; `off` stops it |
| Role agents | `reader` (Sonnet, medium) reads and reports, `writer` (Sonnet, high) changes files, `reviewer` (Opus, medium) checks a plan or a change with a fresh context. Those are the defaults; `/config` changes them |
| `/phase` | Opens a side pane: the main session's model, effort, context, rate limits and current tool, with or without a cycle; during a cycle also its phase, the running agent and the plan's finished items. It opens by itself when a cycle's plan file is first written, and in a later session if it was open; `/phase` opens and closes it, and a pane you closed stays closed for that plan |
| `visual-plan` | Writes a plan in the plan-file format first; an optional visual page of it shows diagrams, the API contract, the data model, items with their checks and open questions |
| `/starter:grill` | Interviews you about a loose idea, two question cards at a time, until every choice is made |
| `/starter:review-setup` | Reads your repo and drafts a short `REVIEW.md`: what failure looks like here, what is risky, what to skip |
| `/starter:probe-setup` | Reads your repo and drafts a short `PROBE.md`: what runs here (API, UI, app, CLI), how to start it and sign in, how to check each kind of change, and what a probe must never touch |
| `/starter:clean-worktrees` | Removes clean, merged worktrees and branches, never through a symlink into your checkout |
| `/starter:monthly-review` | Checks `/insights` against your setup, applies at most two changes, prunes stale memory |
| `/starter:setup` | Optional add-ons (context7, i-have-adhd, ponytail) and turning the rules or the gate off, each shown first. The plugin also reminds you, once a day per project, that it has no `REVIEW.md` or `PROBE.md` or hasn't run claude-code-setup, until you run them or `skip review-md` / `skip probe-md` / `skip project-setup` |

## Pick the agents' model and effort

The roles start on the `max` profile (reader Sonnet medium, writer Sonnet high, reviewer Opus medium). To spend less, choose `balanced` or `light` in the `profile` row of `/config` (or at install, or with `/plugin configure`); each role's model and effort has its own row there too. A role field set to anything but `profile` wins over the profile. The profiles and the exact rules are in [the details](docs/DETAILS.md#agent-model-and-effort).

## Turn things off

- **The cycle:** type nothing. It only runs when you start it, and `/starter:cycle off` stops the open one.
- **The rules and the review gate:** run `/starter:setup`, or drop the gate in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_STARTER_REVIEW_GATE": "off" } }
```

---

[Details and evidence](docs/DETAILS.md) · [The rules, verbatim](plugins/starter/rules.md) · Tests: `node --test test/scripts.test.mjs` and `claude plugin test plugins/starter` · MIT
