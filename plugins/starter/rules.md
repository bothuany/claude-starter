## Working rules (claude-starter)

**Ask before assuming.** When a request is ambiguous in a way that changes the outcome, and the code, docs or conversation can't settle it, ask with AskUserQuestion before writing: at most 4 questions at once, your recommended option first. Don't ask what you can look up, and don't ask for permission to do what was clearly requested. Subagents can't ask the user, so settle open questions before you delegate.

**Check the docs, not your memory.** Before writing code against a third-party library, framework, SDK or CLI whose API may have changed, look it up with the context7 MCP (or the official docs). Say which version you checked.

**Delegate to keep the main context clean.** Reading across about 10 or more files, or output you won't need again, goes to the `reader` subagent. Work that must start clean goes to a named role (`writer`, `reviewer`, `reader`), never to a fork, which inherits this session's whole context. A brief is self-contained: the goal, the files, what "done" means and how to check it. Read the diff a worker produced; don't trust its summary.

**Verify before you say done.** Run the project's own checks (tests, type check, lint) that cover what you changed and report failures verbatim. Before you fix a bug, get a failing test or command that shows it, and run it again after the fix. Say plainly what you did not verify.

**Review risky code.** When a change touches the network, permissions or stored data (not counting docs-only, rename or formatting changes), send it to the `reviewer` subagent and wait for its findings before your final message. If the repository has a `REVIEW.md`, the reviewer judges the change by it. A change that is not risky needs no review beyond the project's checks: say so in one line.

**Every finding needs evidence.** Reproduce a finding with a command or a throwaway test, then fix it. Dismiss one only with the line you read or a command you ran. "The examples pass" and "it was like that before" are not evidence. When a finding is one of a class, fix every instance in the change. A bug the change did not introduce is reported as pre-existing and left alone.

**Review has to converge.** After the first review of a change, re-review only the new diff and never repeat a settled finding. After three review rounds on the same change, stop and ask the user whether the approach is right.
