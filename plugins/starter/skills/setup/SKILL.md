---
name: setup
description: Install or update claude-starter's user-level pieces that a plugin can't ship itself - the working rules in ~/.claude/CLAUDE.md, the worktree base setting, the optional obscura MCP and the optional i-have-adhd plugin - after showing exactly what will change. Run with "check" to only report the current state.
disable-model-invocation: true
argument-hint: "[check]"
---

The scripts live in `${CLAUDE_PLUGIN_ROOT}/scripts`. Run them with `node`. Nothing here may change a file before the user has seen the change and agreed.

## 1. Check

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" check --data "${CLAUDE_PLUGIN_DATA}"` and summarize it in one short table: Node version, rules (missing / outdated / current / broken, and whether the user skipped them before), `worktree.baseRef`, obscura (binary found, MCP registered), i-have-adhd installed.

If `$ARGUMENTS` is `check`, stop here.

## 2. Show the plan

- **Rules.** Show the full text of `${CLAUDE_PLUGIN_ROOT}/rules.md`; it is short. Say it goes into the CLAUDE.md in the config dir from step 1, between `claude-starter:begin` / `claude-starter:end` markers, that nothing else in that file changes, and that the old file is kept as a timestamped `CLAUDE.md.<time>.starter-backup`. When the rules are outdated, show what changed: read the current block from that CLAUDE.md and compare. When they are **broken** (unbalanced or out-of-order markers), the script won't touch the file: show the user the marker lines and ask them to remove the old block by hand, then run setup again.
- **Worktree base.** Subagents with `isolation: worktree` (such as `starter:implementer`) branch from the remote default branch unless `worktree.baseRef` is `"head"`. With the default they don't see local commits, so the fan-out contract commit would be missing. `"head"` is the right value for fan-out; the cost is that `claude --worktree` sessions also start from your current HEAD instead of a clean `main`.
- **obscura** (optional). A local headless browser with an MCP server ([h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura)). If the binary was found, offer to register it at user scope. If not, say how to get it: download the normal build for the OS from its releases page (not a `-stealth` build: that one is made to evade bot detection) and put it on PATH, then run `/starter:setup` again. Without it, WebSearch and WebFetch are used.
- **i-have-adhd** (optional). Output shaping plugin ([ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd)): answers lead with the next action, numbered steps, no tangents. It adds its own skill and a SessionStart hook. Offer it only if it isn't installed.

## 3. Ask

Use AskUserQuestion, one question per item that would change something (skip items already in place):

1. Rules: apply / skip. Skipping is remembered: the session-start notice about missing or outdated rules stops until the user applies them here (unbalanced markers are still reported).
2. `worktree.baseRef`: `head` (recommended when using fan-out) / leave as is.
3. obscura: register / skip (only when the binary was found).
4. i-have-adhd: install / skip.

## 4. Apply

Build one command with a flag for each answer, and run it when there is at least one flag (`--skip-rules` when the user skipped the rules):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply [--rules | --skip-rules] [--base-ref head] [--obscura] --data "${CLAUDE_PLUGIN_DATA}"
```

For i-have-adhd, run `claude plugin install i-have-adhd@claude-starter`.

Then run `check` again and report the new state. Say that new rules take effect in the next session, and that a newly registered MCP server shows up after a restart.
