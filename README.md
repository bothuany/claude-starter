# claude-starter

A small Claude Code setup. It asks before it assumes, reviews what it changed, and cleans up after itself. Every piece that changes how Claude works was measured before it shipped.

[![version 0.9.1](https://img.shields.io/badge/version-0.9.1-555?style=flat-square)](plugins/starter/.claude-plugin/plugin.json) [![MIT](https://img.shields.io/badge/license-MIT-555?style=flat-square)](LICENSE)

```bash
claude plugin marketplace add bothuany/claude-starter
claude plugin install starter@claude-starter
```

Works from your next session. Nothing is written to your `CLAUDE.md`. Needs Node.js 18+.

## How it works

![How claude-starter works: hooks load the rules at session start and run the review gate at stop. You shape an idea with /grill, visual-plan and /review-setup. The lead writes no code: reading goes to locator, Explore and web research in parallel; one writer or the /fan-out workflow builds; a fresh reviewer checks the diff against REVIEW.md and sends findings back. diff-walkthrough, /clean-worktrees and /monthly-review come after.](assets/loop.svg)

You talk to one session, the lead. It asks what it can't look up, plans, and hands the work out. It never writes code itself, so its context stays free for decisions.

- **Reading fans out.** A Haiku `locator` finds and lists files, Explore does wide reading, and web research goes through obscura or WebSearch. Only conclusions come back.
- **Writing stays single.** One writer per repository builds and tests. Parallel agents writing the same code fail at the merge ([ParallACT](https://arxiv.org/abs/2611.00314): 62% → 16% on conflicting tasks).
- **Checking starts fresh.** A reviewer that didn't write the code reads the diff, and `REVIEW.md` first if your project has one. A clean context catches what the writer can't see ([Cognition, 2026](https://cognition.com/blog/multi-agents-working)).

## What's inside

| Piece | What it does |
|---|---|
| Working rules | About 1,000 tokens at session start: ask before assuming, check the docs, delegate, verify before saying done |
| Review gate | A `Stop` hook. If the session changed enough code and no review ran, it asks for one, once |
| `locator` agent | Read-only, on Haiku. Found 151 of 151 files in our tests at about 1/33 of Opus's cost |
| `/starter:fan-out` | Hands an approved plan to a workflow outside your session: one builder, then one fresh reviewer |
| `/starter:grill` | Interviews you about a loose idea, two question cards at a time, until every choice is made |
| `visual-plan` | Turns a plan into a visual contract: diagrams, API contract, data model, open questions |
| `/starter:review-setup` | Reads your repo and drafts a short `REVIEW.md`: what failure looks like here, what is risky, what to skip |
| `diff-walkthrough` | Turns a diff into a slide-style tour you step through until you know the change. Needs `uv` |
| `/starter:clean-worktrees` | Removes clean, merged worktrees and branches, never through a symlink into your checkout |
| `/starter:monthly-review` | Checks `/insights` against your setup, applies at most two changes, prunes stale memory |
| `/starter:setup` | Optional add-ons (context7, obscura, i-have-adhd, ponytail) and turning pieces off, each shown first |

## When fan-out runs

Never on its own. For an approved plan of three or more parts, the lead may suggest it; it starts only when you agree or type `/starter:fan-out`. The workflow then runs one builder and one reviewer. Parallel workers are offered only for a plan too big for one context, or when you ask for them and the parts are unrelated modules, and always with a cost estimate first. Parts that touch the same file are merged into one worker by the script, not by a model.

## Review that converges

An agent writer and an agent reviewer can keep each other busy all night. The rules stop that:

- Depth follows the risk tier in `REVIEW.md`. Low risk needs only your checks; high risk gets a deep review and is flagged for a person.
- From the second round on, only the new diff is reviewed, and a settled finding is never raised again.
- One instance found means every instance of that bug in the change is fixed.
- A bug the change didn't introduce is reported as pre-existing and left alone.
- After three rounds, the lead stops and asks you whether the approach is right.

## Measured

| | |
|---|---|
| Sonnet runs the review rule on its own | 4 of 12 sessions; with the gate, 6 of 6 |
| Bugs the fan-out review reproduced and fixed | 16, across 3 runs |
| Opus main-session cost on a large plan | $1.02–1.50, then $0.11–0.24 once coordination moved into a workflow |

Small samples: read them as a direction. Method, more numbers and what isn't measured yet are in [docs/DETAILS.md](docs/DETAILS.md).

## Turn things off

Run `/starter:setup`, or drop the review gate in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_STARTER_REVIEW_GATE": "off" } }
```

---

[Details and evidence](docs/DETAILS.md) · [The rules, verbatim](plugins/starter/rules.md) · Tests: `node --test test/*.mjs` · MIT
