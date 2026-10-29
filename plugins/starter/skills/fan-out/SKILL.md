---
name: fan-out
description: Run an approved plan's independent parts as parallel implementer subagents (Sonnet, each in its own git worktree), merge them in the main session, then have one reviewer subagent review the merged result. Use when an approved plan has 3 or more parts that share no files and don't need each other's results, and the parts are large (see the scope check in step 1); or when the user asks to split a plan across subagents. For a plan of small parts, implement it in the main session instead.
argument-hint: "[plan file or the parts to run]"
---

You are the orchestrator. You keep the design, the shared contract, the merge and the verification; `starter:implementer` subagents only build their part. Read their diffs, not just their reports.

## 1. Split

Take the plan from `$ARGUMENTS`, the plan file it names, or the plan approved in this conversation. List each part with the files it will create or change. A part qualifies only when no other part touches its files and it needs no other part's result, only the shared contract.

Shared files are what usually break this: type or interface definitions, a route or command registry, a package manifest, a central config, a schema. A part that needs one of them either gets its piece of the contract in step 2 or stays in the main session.

**Scope check, before anything else.** Fan-out costs about twice the tokens of one session doing the same work. It pays only when each part needs much more reading and editing than the main session spends on merging and verifying it. In a pilot, a plan of 4 parts of about 100 to 150 lines each gained nothing: same result, 2x the cost, about the same time, and no smaller main context.

A part is **large** when its non-test code is expected to be more than about 200 lines, or it changes 3 or more non-test files, or it needs reading code that no other part reads. Tests don't count toward either number.

Write this line first, filled in:

`Scope: <n> qualifying parts; estimated non-test lines per part: <a, b, c, ...>; large parts: <k> -> <fan-out | main session>`

- Fan out only when n is 3 or more **and** k is 2 or more.
- Otherwise implement the plan in the main session and stop following this skill.
- If the user explicitly asked for fan-out, write the line anyway, then fan out.

The 200-line mark is a rough guide, not a measured threshold.

More than 5 parts: spawn 5 in one message and start the next as one finishes.

Show the split as a short table (part, files owned, contract it uses) and ask for the go-ahead with AskUserQuestion. Settle every open design question now: workers can't ask the user.

## 2. Contract and preconditions

- Note the current branch and its commit (`git rev-parse --abbrev-ref HEAD`, `git rev-parse HEAD`) before you change anything: the review in step 5 covers everything since that commit, and cleanup checks merges into that branch.
- Write the shared pieces yourself in the main session (types, interfaces, ids, manifest entries; a stub implementation is fine), run the project's checks, and commit on the current branch.
- Workers branch from the local HEAD when the effective `worktree.baseRef` is `"head"`, or when the repository has no remote. The effective value is the first one set in this order: the project's `.claude/settings.local.json`, the project's `.claude/settings.json`, then the user's `~/.claude/settings.json`. Otherwise workers start from the remote default branch and won't see the contract: stop and say so, and offer to set it for this project only (`/starter:setup` does that in the project's `.claude/settings.local.json`, so other projects keep starting `claude --worktree` sessions from a clean default branch).
- A worktree is a fresh checkout without installed dependencies. Decide how workers run checks before spawning: the project's `.worktreeinclude` or `worktree.symlinkDirectories` setting, an install command that is cheap enough to run per worker, or checks that need no install. Put the answer in every brief.

## 3. Spawn

Spawn the parts (up to 5) in one message as `starter:implementer` subagents in the background. Each brief is self-contained, since the worker sees nothing of this conversation:

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

As each worker reports, note its worktree path and branch from the agent's result (you need both for cleanup), read its branch's diff against the base (`git diff HEAD...<branch>`), check it stayed in its files and kept the contract, then `git merge --no-ff <branch>`. Merge one at a time and run the project's fast checks after each, so a break points at one part. A worker that reports a missing contract piece or a question: fix the contract, commit, and spawn a fresh worker for that part, or answer it with SendMessage.

## 5. Verify and clean up

After the last merge, run the checks that cover everything that changed. Then spawn **one** `starter:reviewer` subagent for the whole merged result (not one per part), and wait for its report. Its brief gives the commit from step 2, the plan (file path or text), the parts with the files each owned, and the check commands. It runs the `code-review` skill at high effort on `<commit>..HEAD` and checks the result against the plan.

Fix what it finds in the main session and re-run the checks; don't spawn a second review for the fixes. Report one line per part (merged or not, branch, checks), then the review's findings and what you fixed.

Then remove the worktrees and branches of the workers you merged, and only those, with the starter's safe script (never a plain `git worktree remove --force`: a worktree may hold links into the main checkout). `--into` is the branch you merged into, from step 2: the merges aren't pushed, so the script must not compare against `origin/...`.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs" remove <worker worktree paths>
node "${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs" delete-branches --into <branch from step 2> <worker branches>
```

If `remove` skips a worker because it holds gitignored files, look at the list it prints. Build output, caches and copies made by `.worktreeinclude` are safe to lose in a merged worker: run `remove --include-ignored` for that worker and say so in the report. Anything else, ask first. Leave unmerged workers' worktrees in place and name them in the report. If `.claude/worktrees/` shows up as untracked in `git status`, suggest adding it to `.gitignore`. Don't push or open a PR unless asked.
