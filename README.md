# claude-starter

A small user-level setup for [Claude Code](https://code.claude.com). It does a few things that most setups leave to the user typing them every time, and leaves out the generic "senior engineer" agents and coding/review skills that the model already does well without them.

- **Asks before it assumes.** When a request is ambiguous in a way that changes the result, Claude asks with multiple-choice questions before writing code, and doesn't ask what it can look up.
- **Keeps the main context clean.** Wide searches go to a subagent. An approved plan with 3+ independent parts runs as parallel Sonnet workers, each in its own git worktree, merged and checked by the main session.
- **Checks the docs, not its memory.** The context7 MCP is included, and the rules tell Claude to use it before writing against a third-party API.
- **Verifies before saying done.** It runs the project's checks and the bundled `/code-review`, and says what it didn't verify.
- **Cleans up after itself.** A safe worktree and branch cleanup that never deletes through links into your main checkout.

## Install

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
- set `worktree.baseRef: "head"`;
- register obscura;
- install i-have-adhd.

`/starter:setup check` only reports the current state. When a plugin update changes the rules, a one-line notice at session start tells you to run it again. That notice is shown to you only and adds nothing to Claude's context.

## What's inside

| Piece | Kind | What it does |
|---|---|---|
| Working rules | `~/.claude/CLAUDE.md` block (about 500 tokens, via `/starter:setup`) | Ask before assuming, docs first, web research routing, when to delegate and when not to, verify before done. Read them in [`plugins/starter/rules.md`](plugins/starter/rules.md) |
| `fan-out` | Skill (Claude may use it on its own) | Split an approved plan into independent parts, commit the shared contract, run `implementer` workers in parallel, then read each diff, merge one at a time, check, and review |
| `implementer` | Subagent (Sonnet, `isolation: worktree`) | Builds one part inside the files it owns, commits, and reports in 10 lines |
| `clean-worktrees` | Skill (you run it) | Lists worktrees and branches, then removes the clean, merged ones after you confirm |
| `setup` | Skill (you run it) | Installs and updates the pieces above that a plugin can't ship |
| context7 | MCP server (HTTP, no key needed) | Current library documentation. Add an API key yourself for higher rate limits ([context7](https://github.com/upstash/context7)) |

**Context cost, measured.** The rules are about 500 tokens. The plugin's skill and agent descriptions add about 290 more (`claude plugin details starter`). context7's tool schemas come on top, and Claude Code loads them on demand. The SessionStart hook adds nothing to the context. If you already have a context7 server of your own, you'll now have two: remove one.

Optional:

- **obscura** ([h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura)) is a local headless browser with an MCP server, used first for web research when it's present. Install the normal build from its releases page, not a `-stealth` build: that build is made to evade bot detection. Put it on PATH and run `/starter:setup`. Without it, WebSearch and WebFetch are used.
- **i-have-adhd** ([ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd), MIT, third party) shapes output for an ADHD reader: the next action first, numbered steps, no tangents. It's listed in this marketplace, pinned to v0.4.1. Unlike the starter, it injects its instructions through a SessionStart hook, so it adds context to every session. Install it with `claude plugin install i-have-adhd@claude-starter`, or through `/starter:setup`.

## Design choices

- **Few pieces, each one doing something the model doesn't do by default.** No generic coder, architect or reviewer agents: they add context at every session and little behaviour.
- **No separate reviewer agent.** The bundled `/code-review` already runs as its own forked subagent; wrapping it in another agent only adds a layer.
- **Rules live in CLAUDE.md, not in a SessionStart hook.** You can read and edit them, their cost is fixed and small, and nothing forces skill use on every message.
- **Questions come from the main session.** Subagents can't use AskUserQuestion, so the rules and `fan-out` settle open questions before delegating.
- **Parallel only when it pays.** Coding parallelizes less than research ([Anthropic's multi-agent write-up](https://www.anthropic.com/engineering/multi-agent-research-system) reports about 15× the tokens of a chat for multi-agent runs). `fan-out` needs 3+ parts that share no files, and stops otherwise.

## Limits to know

- **Worker dependencies.** A worktree is a fresh checkout without installed dependencies. Before spawning workers, `fan-out` decides how they will run checks: the project's `.worktreeinclude`, the `worktree.symlinkDirectories` setting, a cheap install, or checks that need none. For a big project, set this up once per repository.
- **`worktree.baseRef: "head"`** also makes `claude --worktree` sessions start from your current HEAD instead of a clean default branch.
- **Rule effects are probabilistic.** The rules make the behaviour likely, not guaranteed. If you need a guarantee, use a hook in that project.

## Pairs well with

- [`feature-dev`](https://github.com/anthropics/claude-plugins-official) from Anthropic's official marketplace: a guided flow of explore, clarify, architect, build and review for larger features.
- [superpowers](https://github.com/obra/superpowers): a much more prescriptive workflow. Several ideas here come from it: verify before claiming done, and keep the review separate from the implementation. This starter deliberately doesn't inject instructions at every session start.

## Privacy

- The context7 server sends your documentation queries (library names, topics) to [context7.com](https://context7.com).
- obscura runs locally.
- Nothing in this repository collects data.

## Uninstall

```bash
claude plugin uninstall starter@claude-starter
```

Then delete the block between `claude-starter:begin` and `claude-starter:end` in `~/.claude/CLAUDE.md`.

## License

MIT
