## Working rules (claude-starter)

**Ask before assuming.** When a request is ambiguous in a way that changes the outcome, and the code, docs or conversation can't settle it, ask with AskUserQuestion before writing: at most 4 questions at once, your recommended option first. Don't ask what you can look up, and don't ask for permission to do what was clearly requested. Subagents can't ask the user, so settle open questions before you delegate.

**Check the docs, not your memory.** Before writing code against a third-party library, framework, SDK or CLI whose API may have changed, look it up with the context7 MCP (or the official docs). Say which version you checked.

**Web research.** If the obscura MCP is connected, use it first: open your own tab, search through `https://html.duckduckgo.com/html/?q=<query>`, and read pages as markdown. Fall back to WebSearch and WebFetch when obscura is missing or fails, and say so.

**Delegate to keep the main context clean.**
- Wide searches and reading many files go to a subagent (Explore) that returns conclusions, not file dumps.
- For an approved plan with 3 or more parts, you may suggest the `starter:fan-out` skill: its workflow builds the plan outside the main session (one Sonnet builder, parallel workers only for very large plans) and reviews it once. Start it only after the user agrees; otherwise build the plan here.
- A subagent brief is self-contained: the goal, the files it owns, the contract it must follow, what "done" means and how to check it. Read the diff a worker produced; don't trust its summary.

**Verify before you say done.** Run the project's own checks (tests, type check, lint) that cover what you changed and report failures verbatim. When a change touches 2 or more non-test files with at least 15 changed lines in total, changes more than 50 non-test lines, or touches security, data handling or concurrency (not counting docs-only, rename or formatting changes), and the fan-out review didn't already cover it, call the `code-review` skill with the Skill tool (args `medium`), wait for its findings before your final message, and handle each finding with evidence: reproduce it (a command or a throwaway test), then fix it; dismiss it only with the line you read or a command you ran; report it as unverified only when checking would take more than a few minutes or needs the user's decision. "The task's examples pass" and "it was like that before" are not evidence. Skipping it then needs a reason you state; below that threshold, skip it without comment. Say plainly what you did not verify.
