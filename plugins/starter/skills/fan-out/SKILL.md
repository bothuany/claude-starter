---
name: fan-out
description: Run an approved plan's independent parts as parallel implementer subagents (Sonnet, each in its own git worktree), then merge and verify in the main session. Use when an approved plan has 3 or more parts that share no files and don't need each other's results, or when the user asks to split a plan across subagents.
argument-hint: "[plan file or the parts to run]"
---

You are the orchestrator. You keep the design, the shared contract, the merge and the verification; `starter:implementer` subagents only build their part. Read their diffs, not just their reports.

## 1. Split

Take the plan from `$ARGUMENTS`, the plan file it names, or the plan approved in this conversation. List each part with the files it will create or change. A part qualifies only when no other part touches its files and it needs no other part's result, only the shared contract.

Shared files are what usually break this: type or interface definitions, a route or command registry, a package manifest, a central config, a schema. A part that needs one of them either gets its piece of the contract in step 2 or stays in the main session.

Fewer than 3 qualifying parts: say so and implement in the main session. More than 5: run 5 and start the next as one finishes.

Show the split as a short table (part, files owned, contract it uses) and ask for the go-ahead with AskUserQuestion. Settle every open design question now: workers can't ask the user.

## 2. Contract and preconditions

- Write the shared pieces yourself in the main session (types, interfaces, ids, manifest entries; a stub implementation is fine), run the project's checks, and commit on the current branch.
- Workers branch from the local HEAD when `worktree.baseRef` is `"head"` in any settings file (user `~/.claude/settings.json`, or the project's `.claude/settings.json` or `.claude/settings.local.json`; `/starter:setup` sets the user one), or when the repository has no remote. Otherwise they start from the remote default branch and won't see the contract: stop and say so, and offer to set `baseRef` for this project.
- A worktree is a fresh checkout without installed dependencies. Decide how workers run checks before spawning: the project's `.worktreeinclude` or `worktree.symlinkDirectories` setting, an install command that is cheap enough to run per worker, or checks that need no install. Put the answer in every brief.

## 3. Spawn

Spawn every part in one message as `starter:implementer` subagents in the background. Each brief is self-contained, since the worker sees nothing of this conversation:

```
Part: <one-line goal>
Files you own: <paths; create or change only these>
Contract (already committed): <what the part uses, with file paths>
Behaviour: <what it must do, edge cases>
Checks: <exact commands, and how dependencies are available>
Done when: <tests to add or pass>
Do not touch: <the other parts' files and the contract files>
```

## 4. Merge

As each worker reports, read its branch's diff against the base (`git diff HEAD...<branch>`), check it stayed in its files and kept the contract, then `git merge --no-ff <branch>`. Merge one at a time and run the project's fast checks after each, so a break points at one part. A worker that reports a missing contract piece or a question: fix the contract, commit, and spawn a fresh worker for that part, or answer it with SendMessage.

## 5. Verify and clean up

After the last merge, run the checks that cover everything that changed and the bundled `/code-review` on the combined diff. Report one line per part (merged or not, branch, checks), then what the review found.

Then remove the worktrees and branches of the workers you merged, and only those, with the starter's safe script (never a plain `git worktree remove --force`: a worktree may hold links into the main checkout):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs" remove <worker worktree paths>
node "${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs" delete-branches <worker branches>
```

Leave unmerged workers' worktrees in place and name them in the report. If `.claude/worktrees/` shows up as untracked in `git status`, suggest adding it to `.gitignore`. Don't push or open a PR unless asked.
