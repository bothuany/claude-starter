# claude-starter

A small user-level setup for [Claude Code](https://code.claude.com). It does a few things that most setups leave to the user typing them every time, and leaves out the generic "senior engineer" agents and coding/review skills that the model already does well without them.

- **Asks before it assumes.** When a request is ambiguous in a way that changes the result, Claude asks with multiple-choice questions before writing code, and doesn't ask what it can look up.
- **Delegates wide searches; fans out only big plans.** Wide searches go to a subagent. An approved plan with 3+ independent parts, at least 2 of them large, can run as parallel Sonnet workers in their own git worktrees, merged by the main session and reviewed once. Automatic fan-out is an unmeasured bet: in the pilot below, on small parts, it cost 2x and did not shrink the main session's context.
- **Checks the docs, not its memory.** The rules tell Claude to look up a third-party API before writing against it, with the context7 MCP when you add it (`/starter:setup` offers it) or the official docs.
- **Verifies before saying done.** It runs the project's checks, calls the bundled `/code-review` for changes past a size threshold (2+ non-test files with 15+ lines, 50+ non-test lines, or security, data or concurrency code; a `Stop` hook enforces the size part), and says what it didn't verify.
- **Cleans up after itself.** A safe worktree and branch cleanup that never deletes through links into your main checkout.

## Install

Needs Node.js 18 or later on PATH: the session-start check and the setup, cleanup and review scripts run with `node`. Claude Code's native installer doesn't include Node; without it the session-start hook fails with a hook error at each start.

```bash
claude plugin marketplace add bothuany/claude-starter
claude plugin install starter@claude-starter
```

Then, in a session:

```
/starter:setup
```

`/starter:setup` shows what it will change and asks before each item. It can:

- write the working rules into `~/.claude/CLAUDE.md`, between markers, keeping a backup;
- set `worktree.baseRef: "head"` for the project you fan out in (or for every project);
- register context7;
- register obscura;
- install i-have-adhd.

`/starter:setup check` only reports the current state. While the rules are not installed, or a plugin update changed them, a one-line notice at session start tells you to run it. If you skip the rules in setup, that notice stays quiet until you apply them. The notice is shown to you only and adds nothing to Claude's context. Setup never rewrites a CLAUDE.md whose starter markers are unbalanced; it tells you to remove the old block by hand, and the notice reports it until you do. Each file it changes is backed up first as `<file>.<time>.starter-backup`.

## What's inside

| Piece | Kind | What it does |
|---|---|---|
| Working rules | `~/.claude/CLAUDE.md` block (about 500 tokens, via `/starter:setup`) | Ask before assuming, docs first, web research routing, when to delegate and when not to, verify before done. Read them in [`plugins/starter/rules.md`](plugins/starter/rules.md) |
| `fan-out` | Skill (Claude may use it on its own) | Split an approved plan into independent parts, commit the shared contract, run `implementer` workers in parallel, then read each diff, merge one at a time, check, then run `code-review` at high effort once on the merged result, verify its findings and check the result against the plan. Only for plans with large parts; small plans stay in the main session |
| `implementer` | Subagent (Sonnet, `isolation: worktree`) | Builds one part inside the files it owns, commits, and reports in 10 lines |
| Review gate | `Stop` hook (plus a `SessionStart` snapshot), **on by default** | When the session changed 2+ non-test files (15+ lines) or 50+ non-test lines since the last review (tests and docs not counted, committed changes included) and `code-review` hasn't run, it asks Claude once to run it before stopping. Claude may decline in one line for docs, renames, formatting, changes it didn't make or a fan-out still in progress. Each change set is asked about once; pulls, merges and checkouts reset the base. Turn it off with `/starter:setup` or `CLAUDE_STARTER_REVIEW_GATE=off` in settings `env`. Each check runs `git add -A` into a private index, so very large untracked files or Git LFS clean filters slow it down |
| `clean-worktrees` | Skill (you run it) | Lists worktrees and branches, then removes the clean, merged ones after you confirm. It refuses anything with uncommitted or untracked files, an unreadable git status, or commits that no branch holds |
| `setup` | Skill (you run it) | Installs and updates the pieces above that a plugin can't ship |
| `monthly-review` | Skill (you run it) plus a session-start reminder | Runs `/insights`, checks its suggestions against your setup, applies at most two after you choose, and prunes auto memory. The reminder appears once a day when the review is due |
| context7 | Optional MCP server (HTTP, no key needed), added by `/starter:setup` | Current library documentation. Add an API key yourself for higher rate limits ([context7](https://github.com/upstash/context7)) |

**Context cost, measured.** The rules are about 500 tokens. `claude plugin details starter` estimates about 480 more for the skill and agent descriptions, but it counts all four skills. `setup`, `clean-worktrees` and `monthly-review` are user-only (`disable-model-invocation`), so their descriptions don't load; what Claude sees is `fan-out` and `implementer`, about 240 tokens. If you add context7, its tool schemas come on top, and Claude Code loads them on demand; setup doesn't add a second one when you already have yours. The SessionStart hooks add nothing to the context; the review gate adds one short instruction only on a stop it blocks.

Optional:

- **obscura** ([h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura)) is a local headless browser with an MCP server, used first for web research when it's present. Install the normal build from its releases page, not a `-stealth` build: that build is made to evade bot detection. Put it on PATH and run `/starter:setup`. Without it, WebSearch and WebFetch are used.
- **i-have-adhd** (third party, not part of the starter: [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd), MIT) shapes output for an ADHD reader: the next action first, numbered steps, no tangents. It's listed in this marketplace, pinned to v0.4.1. Unlike the starter, it injects its instructions through a SessionStart hook, so it adds context to every session. Install it with `claude plugin install i-have-adhd@claude-starter`, or through `/starter:setup`.

## Design choices

- **Few pieces, each one doing something the model doesn't do by default.** No generic coder, architect or reviewer agents: they add context at every session and little behaviour.
- **One review after a fan-out, from the main session.** `fan-out` calls the bundled `/code-review` at high effort once on the merged result, never once per worker. That skill already runs in its own forked context and sees only the diff, so a separate reviewer agent would add a layer and a second read of the plan and diffs without a fresher view. At high effort the review favours recall and doesn't verify its findings, so the main session, which knows the plan, verifies each finding before fixing it and checks the result against the plan.
- **Rules live in CLAUDE.md, not in a SessionStart hook.** You can read and edit them, their cost is fixed and small, and nothing forces skill use on every message.
- **Questions come from the main session.** Subagents can't use AskUserQuestion, so the rules and `fan-out` settle open questions before delegating.
- **Parallel only when it pays.** Coding parallelizes less than research ([Anthropic's multi-agent write-up](https://www.anthropic.com/engineering/multi-agent-research-system) reports about 15× the tokens of a chat for multi-agent runs). `fan-out` needs 3+ parts that share no files, at least 2 of them large (more than about 200 non-test lines or 3+ non-test files), and implements the plan in one session otherwise. That threshold is a guess; only the low end is measured.

## Limits to know

- **Worker dependencies.** A worktree is a fresh checkout without installed dependencies. Before spawning workers, `fan-out` decides how they will run checks: the project's `.worktreeinclude`, the `worktree.symlinkDirectories` setting, a cheap install, or checks that need none. For a big project, set this up once per repository.
- **`worktree.baseRef: "head"`** also makes `claude --worktree` sessions start from your current HEAD instead of a clean default branch. That is why setup offers it per project, in the project's `.claude/settings.local.json`.
- **Rule effects are probabilistic.** The rules make the behaviour likely, not guaranteed; Sonnet in long sessions skipped the review rule most of the time. That's why the review has a `Stop` hook. For other rules you need guaranteed, use a hook in that project.

## Pilot results

A small pilot (Harbor, Claude Code 2.1.312, Opus 5.5 main session, Sonnet workers, 3 repeats per cell, small Node repos with hidden tests, October 2026). Read the numbers as a direction, not an effect size.

- **Rules vs none** (4 tasks × 3 each).
  - Same success: 9/12 in both arms; the misses were the same unasked contract bug on one task.
  - The rules ran `code-review` in 12/12 trials, against 0/12 without them.
  - The review led to no code change in any trial. Cost was about 2× ($0.25 vs $0.13 per task) and agent time 1.8×. These tasks were already right or wrong in ways the review also missed, so this doesn't show the review is useless, only that it is costly on small changes. Since 0.4.0 the rules skip it below a size threshold.
  - Headless runs can't show the "ask first" effect: Claude can't ask in `claude -p`.
- **Fan-out vs one session** (an approved 4-part plan × 3 each).
  - Same success: 3/3, 44/44 hidden tests.
  - With the plugin installed, Claude chose `fan-out` on its own every time.
  - Fan-out cost about 2× ($2.3–2.5 vs $1.2) for about the same wall-clock time.
  - It did **not** shrink the main session's context: the peak was 58–62k tokens vs 52k. Merging and re-testing four parts cost about as much as writing them.
  - Fan-out should pay off when each part needs much more reading and editing than this. For plans of a few small parts, one session is cheaper.

## Keep improving it: a monthly review

The starter doesn't create skills or memories on its own. Tools that do (such as Hermes Agent's background skill writer) tend to pile up narrow, near-duplicate skills, and auto-written context has no evidence of helping coding agents. Instead it reminds you, and does the legwork when you say so:

- **Reminder.** At session start, a one-line notice appears when your newest `/insights` report is 30 days old or older (or there is none: Claude Code deletes reports after `cleanupPeriodDays`), or when a project's memory index is over 150 lines or 20KB. You see it at most once a day, and it adds nothing to Claude's context. `/starter:monthly-review off` stops it, and `on` brings it back.
- **`/starter:monthly-review`** runs the steps below. It uses a report from the last 7 days if there is one, and asks before every change.

The steps, if you'd rather do them by hand:

1. **Run `/insights`.** It reads your recent sessions and writes an HTML report: where things went wrong, suggested CLAUDE.md lines, skills and hooks. In our runs it took about a minute and cost about $1.50 for 130 sessions; its cost grows with the number of new sessions it reads (up to 200 per run).
2. **Check each suggestion before you use it.** The report doesn't know your existing skills or project CLAUDE.md files, and its advice can be wrong for your setup. For example, it may suggest `git worktree remove --force` on Windows, which follows junctions into your main checkout. Drop what you already have, and drop what you can't confirm.
3. **Apply at most two.** Pick the ones that fix your most expensive repeated mistake. A CLAUDE.md line goes in the project that needs it. A skill goes through the `skill-creator` skill, with a with-and-without eval before you keep it.
4. **Look at memory with `/memory`.** Claude Code's auto memory is on by default and loads each project's `MEMORY.md` index (the first 200 lines or 25KB) at session start. Keep entries that the code can't tell Claude: your preferences, corrections you've made twice, decisions that aren't in the repo, and pointers to outside resources. Delete the rest. The starter doesn't add a memory server: none has evidence of helping coding tasks, and irrelevant memory measurably hurts.
5. **Check skill cost with `/skill-doctor`** (Claude Code v2.1.252 or later) and remove skills you don't use.

Transcripts are deleted after `cleanupPeriodDays` (30 by default). Set it higher in `~/.claude/settings.json` if you want reviews to reach further back.

## Pairs well with

- [`feature-dev`](https://github.com/anthropics/claude-plugins-official) from Anthropic's official marketplace: a guided flow of explore, clarify, architect, build and review for larger features.
- [superpowers](https://github.com/obra/superpowers): a much more prescriptive workflow. Several ideas here come from it: verify before claiming done, and keep the review separate from the implementation. This starter deliberately doesn't inject instructions at every session start.

## Privacy

- If you add context7, it sends your documentation queries (library names, topics) to [context7.com](https://context7.com). Check that this is allowed on a work machine.
- obscura runs locally.
- Nothing in this repository collects data.

## Uninstall

```bash
claude plugin uninstall starter@claude-starter
```

Then undo what `/starter:setup` wrote, if you no longer want it:

- delete the block between `claude-starter:begin` and `claude-starter:end` in `~/.claude/CLAUDE.md`;
- remove `worktree.baseRef` from the project's `.claude/settings.local.json` (or from `~/.claude/settings.json` if you set it for every project);
- `claude mcp remove --scope user obscura` and `claude mcp remove --scope user context7`, if setup registered them;
- delete the `*.starter-backup` files next to those two files once you don't need them.

## Tests

`node --test test/scripts.test.mjs` runs the scripts against throwaway repositories and config directories; it never touches your own `~/.claude`.

## License

MIT
