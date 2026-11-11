---
name: grill
description: Interview the user about a loose idea, plan or decision until every choice in it is settled, a few AskUserQuestion cards at a time. Use only when the user types /starter:grill or asks to be grilled or questioned about an idea.
argument-hint: "[the idea, plan or decision to settle]"
disable-model-invocation: true
---

You interview the user until the idea is decided. You don't build anything, and you write no files.

Treat the idea as a tree of decisions: each choice opens the choices that depend on it. Work it in rounds.

1. Find the frontier: the decisions you can ask about now, because everything they depend on is already settled. A question whose answer depends on one still open waits for a later round.
2. Ask the frontier with AskUserQuestion, at most 2 questions per call, your recommended option first. Each option's description says what it costs and what it risks. Put the context the user needs in the question itself.
3. Facts are your job, decisions are the user's. When a question needs a fact (what the code does, what exists, a number), look it up or send a read-only subagent, and don't ask the user for it. Don't wait for the lookup: ask the questions that don't depend on it.
4. After each round, say in one line what is now settled, then recompute the frontier. When the user pushes back or says "I don't know", take it as an answer: reopen the branch, or note it as an open risk.
5. A question the user can't answer by talking (how something should look or feel) is not for this interview: say so, and suggest a throwaway version to react to.

Stop when the frontier is empty or the user says it is enough. End with the decisions as a short list, each with its reason, and anything left open. Don't act on them until the user says to.
