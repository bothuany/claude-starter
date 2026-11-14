---
name: setup
description: Configure claude-starter's pieces that a plugin can't ship itself - the worktree base setting for fan-out, the optional context7 and obscura MCP servers and the optional i-have-adhd and ponytail plugins - and turn the working rules or the review gate on or off, after showing exactly what will change. Also removes the old copy of the rules that versions before 0.8 wrote into ~/.claude/CLAUDE.md. Run with "check" to only report the current state, or with "skip" / "unskip" to stop or resume the per-project reminders about REVIEW.md and claude-code-setup.
disable-model-invocation: true
argument-hint: "[check | skip review-md|project-setup | unskip review-md|project-setup]"
---

The scripts live in `${CLAUDE_PLUGIN_ROOT}/scripts`. Run them with `node`. Nothing here may change a file before the user has seen the change and agreed.

## 0. Project reminders

At session start the plugin reminds, once a day per project, when the project has no `REVIEW.md` (`/starter:review-setup` drafts it) or hasn't run the separate `claude-code-setup` plugin (`/claude-code-setup:claude-automation-recommender`; only mentioned when that plugin is installed). If `$ARGUMENTS` is `skip review-md`, `skip project-setup`, `unskip review-md` or `unskip project-setup`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" <skip|unskip> <review-md|project-setup> --data "${CLAUDE_PLUGIN_DATA}"`, repeat its one-line answer, and stop. `skip` stops the reminder for the current project only; `unskip` brings it back.

## 1. Check

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" check --data "${CLAUDE_PLUGIN_DATA}"` and summarize it in one short table: Node version, rules (on / off), old rules block in CLAUDE.md (none / present / broken), `worktree.baseRef` (user, project, project local, and the effective value for the current folder), context7 registered, obscura (binary found, MCP registered), i-have-adhd installed, ponytail installed, review gate on or off, and the two project reminders (`projectReminders`: `review-md` and `project-setup`, each unknown / done / declined for this project, plus whether claude-code-setup is installed).

If `$ARGUMENTS` is `check`, stop here.

## 2. Show the plan

- **Rules** (on by default). The plugin's SessionStart hook puts `${CLAUDE_PLUGIN_ROOT}/rules.md` into every session's context (about 600 tokens); nothing is written to CLAUDE.md. Show the text when the user asks or when they are off. If the user's own CLAUDE.md already says the same things, point out the overlap: they may prefer to turn the rules off or trim their own lines.
- **Old rules block.** When it is **present**, the hook holds the rules back so they don't load twice: offer to remove it. Only the marked block goes, the rest of CLAUDE.md stays, and the old file is kept as a timestamped `CLAUDE.md.<time>.starter-backup`. When it is **broken** (unbalanced or out-of-order markers), the script won't touch the file: show the user the marker lines and ask them to delete the old block by hand.
- **Worktree base for fan-out.** Subagents with `isolation: worktree` (such as the fan-out workflow's workers) branch from the remote default branch unless `worktree.baseRef` is `"head"`, so with the default they don't see the fan-out contract commit. Offer it **for this project** (the `project` path from step 1): it goes into that project's `.claude/settings.local.json`, which is personal and usually gitignored. Setting it for every project (user settings) is the alternative; its cost is that `claude --worktree` sessions everywhere start from your current HEAD instead of a clean `main`. Skip this when the current folder isn't the project the user means to fan out in.
- **context7** (optional). An MCP server with current library documentation ([upstash/context7](https://github.com/upstash/context7)), keyless, added at user scope. It sends library names and topics to context7.com: on a work machine, check that this is allowed. Offer it only if no `context7` server is registered yet.
- **obscura** (optional). A local headless browser with an MCP server ([h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura)). If the binary was found, offer to register it at user scope. If not, say how to get it: download the normal build for the OS from its releases page (not a `-stealth` build: that one is made to evade bot detection) and put it on PATH, then run `/starter:setup` again. Without it, WebSearch and WebFetch are used.
- **Review gate** (on by default). A `Stop` hook: when this session changed 2+ hand-written code files (15+ lines) or 50+ such lines since the last review and `code-review` hasn't run, it asks Claude once to run it before stopping. Tests, docs, lockfiles, build output, pure renames and whitespace don't count. It adds a turn and some cost on larger changes; Sonnet skipped the review rule without it. Offer to turn it off only if the user asks or prefers fewer stops; `CLAUDE_STARTER_REVIEW_GATE=off` in settings `env` also works.
- **i-have-adhd** (optional, third party: [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd), MIT, pinned to v0.4.1). Output shaping: answers lead with the next action, numbered steps, no tangents. It adds its own skill and a SessionStart hook that puts its instructions into every session. Offer it only if it isn't installed.
- **ponytail** (optional, third party: [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail), MIT, pinned to v5.3.3). "Lazy senior dev" mode: reuse what the repo already has, standard library first, the smallest code that works, never cutting validation, security or tests. Say plainly what it adds:
  - its instructions in every session, through its own hooks;
  - `/ponytail-review` and `/ponytail-audit` commands;
  - a cost and token band above the prompt;
  - after every turn, a row with the task's cost, tokens and tests written to `~/.config/ponytail/band/`. That stays local unless the user sets a webhook in its plugin settings.

  The review gate counts only the bundled `code-review`, so a `/ponytail-review` alone doesn't satisfy it. Offer ponytail only if it isn't installed from any marketplace.

## 3. Ask

Use AskUserQuestion, one question per item that would change something (skip items already in place; at most 4 questions in one call, so ask the rest in a second call):

1. Old rules block: remove (only when present).
2. `worktree.baseRef: "head"`: this project (recommended) / every project / leave as is.
3. context7: register / skip.
4. obscura: register / skip (only when the binary was found).
5. i-have-adhd: install / skip.
6. ponytail: install / skip.
7. Rules: keep on / turn off (only if the user raised it, or they are off: then turn on / keep off).
8. Review gate: keep on / turn off (only if the user raised it, or it is currently off: then turn on / keep off).

## 4. Apply

Build one command with a flag for each answer, and run it when there is at least one flag (`--scope user` only for "every project"):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply [--remove-old-rules] [--rules on|off] [--base-ref head [--scope user]] [--context7] [--obscura] [--review-gate on|off] --data "${CLAUDE_PLUGIN_DATA}"
```

For i-have-adhd, run `claude plugin install i-have-adhd@claude-starter`. For ponytail, run `claude plugin install ponytail@claude-starter`; it takes effect in the next session.

Then run `check` again and report the new state. Say that rule changes take effect in the next session, and that a newly registered MCP server shows up after a restart.
