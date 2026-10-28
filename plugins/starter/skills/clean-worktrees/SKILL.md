---
name: clean-worktrees
description: List this repository's git worktrees and local branches, then remove the clean, merged ones safely (links inside a worktree are unlinked first, so nothing outside it is deleted). Use when worktrees or merged branches have piled up, or after a fan-out.
disable-model-invocation: true
argument-hint: "[all-merged]"
---

Run every command from the repository root. The script is `${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs`; run it with `node`.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs" list`.
2. Show two short tables:
   - Worktrees: path, branch, merged into the default branch, uncommitted files, locked, missing.
   - Branches: how many are merged and could be deleted (list them), and how many are not merged (count only).
3. Propose removing every worktree that is merged and has 0 uncommitted files, and deleting every merged branch. Leave out anything dirty or unmerged and say why. A locked worktree may belong to a running session or agent: list it separately and propose it only if the user confirms nothing is using it.
4. Ask with AskUserQuestion: remove the proposed worktrees and branches / only the worktrees / nothing. If `$ARGUMENTS` is `all-merged`, the user has already asked for the first option: skip the question.
5. Remove worktrees first (a branch checked out in a worktree can't be deleted), in one call: `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs" remove <path> <path> ...`. Windows is slow to delete large checkouts; run it in the background if there are many.
6. Then `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs" delete-branches <name> <name> ...`. The script deletes only branches merged into the default branch.
7. Report what was removed and what was skipped, with the script's reason for each skip.
