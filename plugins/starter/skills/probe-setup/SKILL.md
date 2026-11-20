---
name: probe-setup
description: Draft a short PROBE.md for this repository, so the cycle's probe knows how to run a change for real here - what kind of app it is, how to start it, which environment and login to use, what it must never touch, and what "it worked" looks like. Use when the user types /starter:probe-setup, or asks to set up probing or live testing for a project.
argument-hint: "[check]"
disable-model-invocation: true
---

You draft `PROBE.md` at the repository root, show it, and write it only after the user agrees. With `check`, only report what an existing `PROBE.md` covers, what it lacks and what in it no longer matches the repository.

The probe reads this file before it runs a change, so keep it under about 40 lines. It holds what can't be found out quickly and safely: how this project is run and checked by hand. Don't repeat what a general run tool already does (starting a dev server, opening a browser, a simulator); say only what it needs to know here.

## 1. Read the project (send a read-only subagent for the wide reading)

- What runs: an API, a web UI, a mobile or desktop app, a CLI, a library, jobs or workers, several of these. `README`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING`, package and build files, launch configs (`.claude/launch.json`, `.vscode/launch.json`, `docker-compose*`, `Procfile`), and the project's own skills and scripts for running or probing it.
- How it starts locally, what it needs (database, other services, secrets), and which ports or URLs it serves.
- Which environments exist (local, dev, staging), what each is connected to, and which are shared with other people or hold real users' data.
- How to sign in or get a token for a test user, without a real person's password.
- What a person checks by hand after a change: the request, page, screen or command, and what a good result looks like.

## 2. Draft these sections, each a few lines

1. **What runs.** The kinds of app here, each with its path or entry point.
2. **Start it.** The command or launch config per kind, what it must be connected to, and how to tell it is up. Name the project's own skill or script when there is one.
3. **Sign in.** How a probe gets a test login or token. Never write a real password, key or token into the file: name where it comes from.
4. **Probe by change.** For each kind of change (an endpoint, a page, a job, a migration), how to exercise it and what to compare: the expected status, rows, ids or screen.
5. **Never.** What a probe must not touch: production, shared data it can't undo, sending real mail or messages, paid calls. Say what to do instead.
6. **When it can't run.** What to report when the environment is missing, so the cycle logs `not run live` with the reason instead of guessing.

Put a fact in the draft only if you saw it in the repository. Where the reading didn't settle something (which environment a probe may write to, say), ask the user with AskUserQuestion, at most 2 questions per call, instead of guessing.

## 3. Show, then write

Show the draft and ask before writing. If a `PROBE.md` exists, show the difference and keep what the owners wrote. Don't commit. Say that the file works best when a probe that went wrong is turned into one line in it.
