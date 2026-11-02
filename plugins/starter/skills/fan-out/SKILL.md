---
name: fan-out
description: Carry out an approved multi-part plan through the plugin's fan-out-run workflow, outside the main session, on its own work branch. One Sonnet builder carries out the plan; only for a very large plan, and only after the user approves the cost, parallel Sonnet workers in git worktrees and one integrator. One fresh reviewer then runs code-review and settles every finding with evidence. Use when the user asks to fan a plan out, or agreed when you suggested it for an approved plan with 3 or more parts; never start it on your own.
argument-hint: "[plan file or the plan to carry out]"
---

You hand an approved plan to the `fan-out-run` workflow and report what it did. The workflow does the building, merging, review and cleanup in its own agents, so your context and your model's cost stay out of the coordination. Its models are fixed by design.

Why it is built this way: in our measurements one plain Sonnet session solved both benchmark plans (4 parts of about 100 and about 250 lines) at the lowest cost: 40–46% of a plain Opus session, and the workflow costs about as much as plain Opus. What the workflow buys is a nearly empty main context and a fresh review. Parallel workers only pay off when the parts together don't fit in one session's context: in a real 10-part run, four workers each reached 480–650k tokens of context for a single part.

## 1. Before you start

- The plan must be approved, and the user must have asked for fan-out or agreed to your suggestion. Otherwise show the plan and ask with AskUserQuestion. Settle every open design question now, since the workflow's agents can't ask the user.
- The working tree must be clean (`git status --porcelain` prints nothing). If it isn't, stop and ask the user to commit or stash; don't do it for them.
- Compose `checks` from what CI runs: read `.github/workflows/*.yml` (and any other CI config) and include every job that the change can break, such as a site build or another package's type check. Checks that miss a CI job let the PR fail after it is opened.
- **Parallel or not.** Estimate the plan's total non-test lines and how much code it needs read. Run it in parallel only when the total is above about 1500 non-test lines, or the plan clearly won't fit one session's context, and it has 2 or more parts that touch separate files. Then ask once with AskUserQuestion, with the estimate in the question: about one agent per part plus three (builder, integrator, reviewer), each starting with about 70k tokens of context before it does anything; the real 10-part run took about 2.9M tokens and 1 h 50 min. Options: parallel workers, or one builder (recommended unless the plan won't fit one session). Below the threshold, don't ask: `parallel` is false.
- With parallel workers only:
  - Workers branch from the local HEAD only when the effective `worktree.baseRef` is `"head"`, or when the repository has no remote. The effective value is the first one set in this order: the project's `.claude/settings.local.json`, the project's `.claude/settings.json`, then the user's `~/.claude/settings.json`. Otherwise the workers would start from the remote default branch and miss the contract commit: stop and say so, and offer to set it for this project only with `/starter:setup`.
  - Decide how a fresh worktree gets its dependencies: the project's `.worktreeinclude` or `worktree.symlinkDirectories`, a cheap install command, or checks that need none.
  - Pick `fastChecks`: a quick subset of `checks` (type check, lint, architecture rules) that the integrator runs after each merge. The full `checks` run once at the end. Leave it empty when every check is slow.
- Last, once nothing above stopped you: note the current branch (`git branch --show-current`), then create the work branch from HEAD with `git switch -c fan-out/<short-slug-of-the-plan>` and read `git rev-parse HEAD`: that sha is `base`. The workflow commits only on this branch, so whatever its integrator resets or reverts, the branch the user was on stays as it was.

## 2. Run the workflow

Start it with the Workflow tool, `name: "starter:fan-out-run"`, and `args` as a JSON object (not a string):

```
{
  "plan": "<plan file path, or the plan text>",
  "checks": "<exact check commands, e.g. npm test>",
  "fastChecks": "<quick subset run after each merge, e.g. npm run typecheck, or empty>",
  "deps": "<how a fresh worktree gets its dependencies, or 'none needed'>",
  "pluginRoot": "${CLAUDE_PLUGIN_ROOT}",
  "base": "<the sha from git rev-parse HEAD on the work branch>",
  "parallel": <true only if the user approved parallel workers, else false>
}
```

The workflow uses as few agents as the job allows, because each one pays its own start-up:
1. **Build.** One Sonnet agent builds the whole plan, with tests, and commits. With `parallel`, it instead commits the shared contract and writes one brief per part (it still builds the plan itself when fewer than 2 parts are independent).
2. **Fan out** (`parallel` only). One Sonnet worker per part, each in its own worktree, at an effort that matches the part's tier. Each first checks that its worktree holds the contract commit. Then one Sonnet integrator merges the branches one at a time with `fastChecks` after each merge. A file outside a part's list is a warning: the integrator reads the hunk and accepts it when it serves the part's goal. A small check failure it fixes itself. Otherwise it rolls back only that merge. It runs the full `checks` once at the end, then removes the merged worktrees with the safe script.
3. **Review.** One fresh agent that wrote none of the code runs `code-review` at high effort on `base..HEAD`. It gets the list of parts that didn't land, so it reports them as missing, not as findings. For each finding it either fixes it after reproducing it, dismisses it with evidence, marks it needs-decision, or marks it not-checked. It also builds the plan table (item, file:line, test). A build whose checks failed or that committed nothing isn't reviewed.

If the Workflow tool isn't available in this session, say so and implement the plan in the main session instead.

## 3. Report

From the workflow's result, report:
- `status`, the work branch, the scope line and the mode. `done` means built, reviewed, and the final checks pass; `partial`: some parts didn't land; `checks-failing`: the final checks fail after the review; `review-failed`: the reviewer didn't finish, so nothing is reviewed; `integration-failed`: the integrator died, so the work branch may hold some merges and must be inspected; `not-landed`: nothing to review; `stopped`: see `stopped` for why;
- `ciGaps`: CI jobs the checks didn't cover, which the user should run before opening a PR;
- one line per part: built, merged, or why not (from `dropped`), plus any worker notes;
- the final checks, verbatim if they fail;
- the review findings by outcome: fixed with its reproduction, dismissed with its evidence, needs-decision for the user to decide, and not-checked with what to run;
- plan items without code or a test;
- worktrees left in place.

Then check it yourself with `git log --oneline <base>..HEAD` and `git diff --stat <base>..HEAD`, and run the checks once. You don't need the full diff: the review has read it. The review gate may then ask for a review of the same changes: answer in one line that the workflow reviewed them. If `.claude/worktrees/` shows up as untracked in `git status`, suggest adding it to `.gitignore`. Don't merge the work branch, push or open a PR unless asked. Tell the user how to get back: `git switch <the branch you noted>`; when nothing landed, they may also delete the work branch with `git branch -D fan-out/<slug>`.
