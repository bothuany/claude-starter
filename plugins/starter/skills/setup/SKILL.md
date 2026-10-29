---
name: setup
description: Install or update claude-starter's pieces that a plugin can't ship itself - the working rules in ~/.claude/CLAUDE.md, the worktree base setting for fan-out, the optional context7 and obscura MCP servers and the optional i-have-adhd and ponytail plugins - after showing exactly what will change. Run with "check" to only report the current state.
disable-model-invocation: true
argument-hint: "[check]"
---

The scripts live in `${CLAUDE_PLUGIN_ROOT}/scripts`. Run them with `node`. Nothing here may change a file before the user has seen the change and agreed.

## 1. Check

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" check --data "${CLAUDE_PLUGIN_DATA}"` and summarize it in one short table: Node version, rules (missing / outdated / current / broken, and whether the user skipped them before), `worktree.baseRef` (user, project, project local, and the effective value for the current folder), context7 registered, obscura (binary found, MCP registered), i-have-adhd installed, ponytail installed, review gate on or off.

If `$ARGUMENTS` is `check`, stop here.

## 2. Show the plan

- **Rules.** Show the full text of `${CLAUDE_PLUGIN_ROOT}/rules.md`; it is short. Say it goes into the CLAUDE.md in the config dir from step 1, between `claude-starter:begin` / `claude-starter:end` markers, that nothing else in that file changes, and that the old file is kept as a timestamped `CLAUDE.md.<time>.starter-backup`. When the rules are outdated, show what changed: read the current block from that CLAUDE.md and compare. When they are **broken** (unbalanced or out-of-order markers), the script won't touch the file: show the user the marker lines and ask them to remove the old block by hand, then run setup again. If the user's CLAUDE.md already says the same things in their own words, point out the overlap: they may prefer to skip the rules or trim their own lines.
- **Worktree base for fan-out.** Subagents with `isolation: worktree` (such as `starter:implementer`) branch from the remote default branch unless `worktree.baseRef` is `"head"`, so with the default they don't see the fan-out contract commit. Offer it **for this project** (the `project` path from step 1): it goes into that project's `.claude/settings.local.json`, which is personal and usually gitignored. Setting it for every project (user settings) is the alternative; its cost is that `claude --worktree` sessions everywhere start from your current HEAD instead of a clean `main`. Skip this when the current folder isn't the project the user means to fan out in.
- **context7** (optional). An MCP server with current library documentation ([upstash/context7](https://github.com/upstash/context7)), keyless, added at user scope. It sends library names and topics to context7.com: on a work machine, check that this is allowed. Offer it only if no `context7` server is registered yet.
- **obscura** (optional). A local headless browser with an MCP server ([h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura)). If the binary was found, offer to register it at user scope. If not, say how to get it: download the normal build for the OS from its releases page (not a `-stealth` build: that one is made to evade bot detection) and put it on PATH, then run `/starter:setup` again. Without it, WebSearch and WebFetch are used.
- **Review gate** (on by default). A `Stop` hook: when this session changed 2+ non-test files (15+ lines) or 50+ non-test lines since the last review and `code-review` hasn't run, it asks Claude once to run it before stopping. It adds a turn and some cost on larger changes; Sonnet skipped the review rule without it. Offer to turn it off only if the user asks or prefers fewer stops; `CLAUDE_STARTER_REVIEW_GATE=off` in settings `env` also works.
- **i-have-adhd** (optional, third party: [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd), MIT, pinned to v0.4.1). Output shaping: answers lead with the next action, numbered steps, no tangents. It adds its own skill and a SessionStart hook that puts its instructions into every session. Offer it only if it isn't installed.
- **ponytail** (optional, third party: [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail), MIT, pinned to v5.3.3). "Lazy senior dev" mode: reuse what the repo already has, standard library first, the smallest code that works, never cutting validation, security or tests. Say plainly what it adds:
  - its instructions in every session, through its own hooks;
  - `/ponytail-review` and `/ponytail-audit` commands;
  - a cost and token band above the prompt;
  - after every turn, a row with the task's cost, tokens and tests written to `~/.config/ponytail/band/`. That stays local unless the user sets a webhook in its plugin settings.

  The review gate counts only the bundled `code-review`, so a `/ponytail-review` alone doesn't satisfy it. Offer ponytail only if it isn't installed from any marketplace.

## 3. Ask

Use AskUserQuestion, one question per item that would change something (skip items already in place; at most 4 questions in one call, so ask the rest in a second call):

1. Rules: apply / skip. Skipping is remembered: the session-start notice about missing or outdated rules stops until the user applies them here (unbalanced markers are still reported).
2. `worktree.baseRef: "head"`: this project (recommended) / every project / leave as is.
3. context7: register / skip.
4. obscura: register / skip (only when the binary was found).
5. i-have-adhd: install / skip.
6. ponytail: install / skip.
7. Review gate: keep on / turn off (only if the user raised it, or it is currently off: then turn on / keep off).

## 4. Apply

Build one command with a flag for each answer, and run it when there is at least one flag (`--skip-rules` when the user skipped the rules; `--scope user` only for "every project"):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply [--rules | --skip-rules] [--base-ref head [--scope user]] [--context7] [--obscura] [--review-gate on|off] --data "${CLAUDE_PLUGIN_DATA}"
```

For i-have-adhd, run `claude plugin install i-have-adhd@claude-starter`. For ponytail, run `claude plugin install ponytail@claude-starter`; it takes effect in the next session.

Then run `check` again and report the new state. Say that new rules take effect in the next session, and that a newly registered MCP server shows up after a restart.
