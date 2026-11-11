---
name: review-setup
description: Draft a short REVIEW.md for this repository, so every code review knows what failure looks like here, which changes are risky and what to skip. Use when the user types /starter:review-setup, or asks to set up or tune review for a project.
argument-hint: "[check]"
disable-model-invocation: true
---

You draft `REVIEW.md` at the repository root, show it, and write it only after the user agrees. With `check`, only report what an existing `REVIEW.md` covers and what it lacks.

A review reads this file first, so keep it under about 40 lines. It says what a reviewer can't see from the diff.

## 1. Read the project (send a read-only subagent for the wide reading)

- What the project is and its rules: `CLAUDE.md`, `AGENTS.md`, `README`, `CONTRIBUTING`.
- What already blocks a bad change: CI config, hooks, linters, architecture tests. A reviewer shouldn't repeat these.
- Where it has broken before: `git log` for reverts and fix commits (`revert`, `fix`, `hotfix`) in the last few months, and which paths they touch most.
- Where a mistake is expensive: auth, payments, data writes and migrations, concurrency, release and CI files, public contracts.
- What is generated, vendored or mirrored.

## 2. Draft these sections, each a few lines

1. **What failure looks like here.** Three to six concrete kinds, in this project's words (for docs "it lies", for config "it misroutes"), each with the evidence that shows it.
2. **Risk tiers.** High: paths and kinds of change that get a deep review and a person who reads it. Medium: the default. Low: what needs no more than the automated checks. Set by the change, not by who wrote it.
3. **Skip.** Generated, vendored and mirrored paths.
4. **Don't report.** What CI, hooks or tests already enforce; style nits beyond a small cap.
5. **How to report.** A file and line for every finding, never a guess from a name; bugs the change didn't introduce marked pre-existing; a summary that starts with a count and says plainly when there is nothing to fix.

Put a fact in the draft only if you saw it in the repository. Where the reading didn't settle something (which paths are high risk, say), ask the user with AskUserQuestion, at most 2 questions per call, instead of guessing.

## 3. Show, then write

Show the draft and ask before writing. If a `REVIEW.md` exists, show the difference and keep what the owners wrote. Don't commit. Say that the file works best when a repeated review comment is turned into one line in it.
