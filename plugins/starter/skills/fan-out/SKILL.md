---
name: fan-out
description: Carry out an approved multi-part plan through the plugin's fan-out-run workflow, outside the main session. A Sonnet planner splits it; small plans are built by one Sonnet session, large ones by parallel Sonnet workers in git worktrees; then one integrator merges, one Opus review and one Sonnet verifier check it. Use when a plan with 3 or more independent parts has been approved, or when the user asks to fan a plan out.
argument-hint: "[plan file or the plan to carry out]"
---

You hand an approved plan to the `fan-out-run` workflow and report what it did. The workflow does the splitting, building, merging, review and cleanup in its own agents, so your context and your model's cost stay out of the coordination. Its models are fixed by design: Sonnet builds, Opus reviews.

Why it is built this way: in our measurements one Sonnet session solved a 4-part plan at about 40% of one Opus session's cost, and earlier fan-out designs cost more than one session because the main session coordinated every merge. Large plans still need measuring.

## 1. Before you start

- The plan must be approved: by the user in this conversation, or stated as approved in the plan or the request. Otherwise show the plan and ask for the go-ahead with AskUserQuestion. Settle every open design question now, since the workflow's agents can't ask the user.
- Workers branch from the local HEAD only when the effective `worktree.baseRef` is `"head"`, or when the repository has no remote. The effective value is the first one set in this order: the project's `.claude/settings.local.json`, the project's `.claude/settings.json`, then the user's `~/.claude/settings.json`. Otherwise the workers would start from the remote default branch and miss the contract commit: stop and say so, and offer to set it for this project only with `/starter:setup`.
- Decide how a fresh worktree gets its dependencies: the project's `.worktreeinclude` or `worktree.symlinkDirectories`, a cheap install command, or checks that need none.
- Commit or stash unrelated changes first; the workflow commits on the current branch.

## 2. Run the workflow

Start it with the Workflow tool, `name: "starter:fan-out-run"`, and `args` as a JSON object (not a string):

```
{
  "plan": "<plan file path, or the plan text>",
  "checks": "<exact check commands, e.g. npm test>",
  "deps": "<how a fresh worktree gets its dependencies, or 'none needed'>",
  "pluginRoot": "${CLAUDE_PLUGIN_ROOT}",
  "forceFanOut": <true if the user typed /starter:fan-out or asked for fan-out in words, else false>
}
```

The workflow:
1. A Sonnet planner splits the plan and writes the scope line. It chooses fan-out only for 3 or more independent parts with at least 2 large ones (more than about 200 non-test lines, 3 or more files, or their own reading), or for 2 or more parts when `forceFanOut` is true. Otherwise it chooses one session. For fan-out it commits the shared contract.
2. Building happens either in one Sonnet session, or with one Sonnet worker per part in its own worktree, at an effort that matches the part's tier.
3. For fan-out, one Sonnet integrator merges the branches one at a time, checking that each stayed in its files, and runs the checks.
4. `code-review` runs at high effort on `base..HEAD` in a fresh context (Opus).
5. A Sonnet verifier who wrote none of the code goes through each finding:
   - fixes it only after reproducing it;
   - dismisses it only with evidence;
   - reports the rest as unverified;
   - builds the plan table (item, file:line, test).
6. The safe script removes the merged worktrees and branches.

If the Workflow tool isn't available in this session, say so and implement the plan in the main session instead.

## 3. Report

From the workflow's result, report:
- the scope line and the mode;
- one line per part: built, merged, or why not;
- the final checks, verbatim if they fail;
- the review findings by outcome: fixed with its reproduction, dismissed with its evidence, and unverified for the user to decide;
- plan items without code or a test;
- worktrees left in place.

Then check it yourself with `git log --oneline <base>..HEAD` and `git diff --stat <base>..HEAD`, and run the checks once. You don't need the full diff: the review has read it. If `.claude/worktrees/` shows up as untracked in `git status`, suggest adding it to `.gitignore`. Don't push or open a PR unless asked.
