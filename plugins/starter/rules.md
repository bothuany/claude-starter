## Working rules (claude-starter)

**Ask before assuming.** When a request is ambiguous in a way that changes the outcome, and the code, docs or conversation can't settle it, ask with AskUserQuestion before writing: at most 4 questions at once, your recommended option first. Don't ask what you can look up, and don't ask for permission to do what was clearly requested. Subagents can't ask the user, so settle open questions before you delegate.

**Check the docs, not your memory.** Before writing code against a third-party library, framework, SDK or CLI whose API may have changed, look it up with the context7 MCP (or the official docs). Say which version you checked.

**Web research.** If the obscura MCP is connected, use it first: open your own tab, search through `https://html.duckduckgo.com/html/?q=<query>`, and read pages as markdown. Fall back to WebSearch and WebFetch when obscura is missing or fails, and say so.

**Delegate to keep the main context clean.**
- Wide searches and reading many files go to a subagent (Explore) that returns conclusions, not file dumps.
- An approved plan with 3 or more independent parts (no shared files, none needs another's result) runs through the `starter:fan-out` skill. Everything else stays in the main session: parallel coding pays off less than it looks.
- A subagent brief is self-contained: the goal, the files it owns, the contract it must follow, what "done" means and how to check it. Read the diff a worker produced; don't trust its summary.

**Verify before you say done.** Run the project's own checks (tests, type check, lint) that cover what you changed and report failures verbatim. When you changed behaviour (anything beyond a typo, a rename or a one-line fix), call the `code-review` skill with the Skill tool (args `low` for a small change, `medium` otherwise), wait for its findings before your final message, and fix or report what it finds. Skipping it needs a reason you state. Say plainly what you did not verify.
