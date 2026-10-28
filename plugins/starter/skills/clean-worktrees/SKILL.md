---
name: clean-worktrees
description: List this repository's git worktrees and local branches, then remove the clean, merged ones safely (links inside a worktree are unlinked first, so nothing outside it is deleted). Use when worktrees or merged branches have piled up, or after a fan-out.
disable-model-invocation: true
argument-hint: "[all-merged] [--into <branch>]"
---

Run every command from the repository root. The script is `${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs`; run it with `node`. "Merged" means merged into the local default branch (`main`, `master`, or the local branch `origin/HEAD` names), unpushed merges included. If `$ARGUMENTS` has `--into <branch>`, pass it on to `list` and `delete-branches` to measure against that branch instead. If the script says it can't find the default branch, ask which branch to use and pass it as `--into`.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs" list [--into <branch>]`.
2. Show two short tables:
   - Worktrees: path, branch, merged into the merge target, uncommitted files, gitignored files (`ignoredFiles`: up to 10 paths, such as `.env.local`, build output or caches), locked, missing.
   - Branches: how many are merged and could be deleted (list them), and how many are not merged (count only).
3. Propose removing every worktree that is merged and has 0 uncommitted files, and every missing one (its folder is gone, so removing it only prunes git's record). Propose deleting every merged branch, plus the branch of each worktree you propose to remove when its `merged` is true (the branch lists leave out branches that are checked out in a worktree). Leave out the rest and say why: dirty, unmerged, `statusUnreadable` (git couldn't read its status) or `unreachableCommits` (detached, with commits on no branch). A locked worktree may belong to a running session or agent: list it separately and propose it only if the user confirms nothing is using it; then pass `--force-locked`. A worktree with gitignored files can't be recovered after removal: show those paths and propose it only if the user confirms they can go (build output and caches usually can; `.env*`, local configs and keys usually can't); then pass `--include-ignored`.
4. Ask with AskUserQuestion: remove the proposed worktrees and branches / only the worktrees / nothing. If `$ARGUMENTS` contains `all-merged`, the user has already asked for the first option: skip the question.
5. Remove worktrees first (a branch checked out in a worktree can't be deleted), in one call: `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs" remove <path> <path> ...`. Windows is slow to delete large checkouts; run it in the background if there are many.
6. Then `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs" delete-branches [--into <branch>] <name> <name> ...`. The script deletes only branches merged into the merge target.
7. Report what was removed and what was skipped, with the script's reason for each skip.
