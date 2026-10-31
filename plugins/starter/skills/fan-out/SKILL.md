---
name: fan-out
description: Carry out an approved multi-part plan through the plugin's fan-out-run workflow, outside the main session. One Sonnet builder carries out most plans itself; large plans go to parallel Sonnet workers in git worktrees and one integrator. One fresh reviewer then runs code-review and settles every finding with evidence. Use when a plan with 3 or more independent parts has been approved, or when the user asks to fan a plan out.
argument-hint: "[plan file or the plan to carry out]"
---

You hand an approved plan to the `fan-out-run` workflow and report what it did. The workflow does the splitting, building, merging, review and cleanup in its own agents, so your context and your model's cost stay out of the coordination. Its models are fixed by design.

Why it is built this way: in our measurements one plain Sonnet session solved both benchmark plans (4 parts of about 100 and about 250 lines) at the lowest cost: 40–46% of a plain Opus session. Parallel workers never beat it on cost or success. Earlier fan-out designs lost most money to the main session coordinating merges, and to each extra agent's start-up.

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

The workflow uses as few agents as the job allows, because each one pays its own start-up:
1. **Build.** One Sonnet agent splits the plan and writes the scope line. For most plans it builds the whole plan itself and commits. It fans out only for 3 or more independent parts with at least 2 large ones (more than about 200 non-test lines, 3 or more files, or their own reading), or for 2 or more parts when `forceFanOut` is true. Then it commits the shared contract and writes one brief per part.
2. **Fan out** (large plans only). One Sonnet worker per part, each in its own worktree, at an effort that matches the part's tier. Then one Sonnet integrator merges the branches one at a time, checking that each stayed in its files, runs the checks, and removes the merged worktrees with the safe script.
3. **Review.** One fresh agent that wrote none of the code runs `code-review` at high effort on `base..HEAD`. For each finding it either fixes it after reproducing it, dismisses it with evidence, or reports it as unverified. It also builds the plan table (item, file:line, test).

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
