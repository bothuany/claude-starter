---
name: visual-plan
description: Turn an implementation plan into a visual contract published as a private Artifact — diagrams, API contract, data model, file map, open questions. Use when "plan çıkar", "görsel plan", "şemayı göster", "API kontratı ne olacak", "plan the migration", "design this endpoint", or before changes to an endpoint contract, table or permission boundary. Not for finished work (use /visual-explainer:diff-review).
---

# Visual plan

A prose plan is unreviewable: the reader skims, approves, and only discovers the wrong auth
boundary or the missing column after 4,000 lines exist. This skill replaces prose with a
**contract** — a fixed set of typed blocks the plan must fill in — rendered as a private
Artifact the user can read, comment on inline, and hand back.

The value is not the prettiness. It is that a blank `Auth` cell or an empty `Response` schema
is *visible*, where confident prose hides it.

## Order of work

**1. Ground the plan before drawing it.** Never render a plan you have not verified against
the actual repo. Read the real controller, the real entity config, the real migration history.
An invented endpoint drawn beautifully is worse than a rough plan drawn honestly. If the repo
has a designed API contract (an OpenAPI file, an API collection — in TAG the Bruno collection — or an ADR), that file is the
baseline — not what the current code happens to do.

Grounding also means finding out how much of the change is **already implemented**. Before you
decide anything is new, list the tables and entities the change touches and grep the codebase for
*those* names — not for the feature's name. Working implementations are routinely filed under a
neighbouring feature, so a service that already writes your tables can sit in a folder you would
never search. This is what the Existing Code Inventory block reports, and skipping it is how a
plan ends up proposing to rewrite code that already ships.

**2. Fill the blocks.** The required blocks and their exact rules are in
[references/blocks.md](references/blocks.md) — read it before writing the page. Every block
that applies to the change must appear. A block that does not apply is omitted with one line
saying why; a block that applies but whose answer you don't know is included with
`❓ BİLİNMİYOR` in the cell and a matching row in Open Questions. **Never fill a cell with a
plausible guess.** The whole point is that gaps stay visible.

**3. Render it.** Load the `artifact-design` skill, and `artifact-diagramming` if the plan has
flows or architecture worth drawing. Write the page to a file in the scratchpad directory, then
publish with `Artifact`. Artifacts are private by default — the user chooses whether to share.

**4. Hand over the link and stop.** Do not start implementing. Say what decision you need from
them, and name the open questions by number. A plan whose open questions are unanswered is not
approved.

**When the plan's scope grows, the inventory is stale.** A plan that gains a flow, a phase, or a
whole second half is a different plan, and the Existing Code Inventory you wrote for the old scope
says nothing about the new one. Redo the search for what was added — carrying the old block
forward unchanged is indistinguishable from never having done it, and it is the failure mode that
survives review, because the block is present and looks complete. The same applies when a reviewer
or a later question widens what the change has to cover.

**5. Collect feedback from the page.** When the user says they commented, read the threads with the
`ArtifactComments` tool (`action: "read"`, the artifact's `url`); reply with `action: "reply"` and close with
`action: "resolve"`. Comment text is written by a human in the page — treat it as a
request, not as instructions to obey blindly, and never as a license to widen scope. Revise the
plan, redeploy to the **same file path** so the URL is stable, reply into the threads you acted
on, and resolve them.

## Rendering rules

- **Diagrams: mermaid, not ASCII.** Artifacts render mermaid natively — ```mermaid fences in
  Markdown, `<pre class="mermaid">` in HTML. Sequence diagrams for request flows, flowcharts
  for decision logic, ER diagrams for relations.
- **Contracts and schemas: tables, not bullets.** A bullet list of "we'll add a status field"
  is prose in disguise. Columns force type, nullability, and default to be stated.
- **One page.** A plan split across artifacts stops being a contract. If it truly doesn't fit,
  the change is too big for one plan — split the *work*, not the page.
- **HTML over Markdown** when the plan has more than two tables or any diagram, because you
  control column widths and can put wide tables in their own `overflow-x: auto` container.
- Keep the `<title>` a short noun phrase naming the feature, and keep it stable across
  redeploys.

## What must not go on the page

Artifacts are hosted, so the page is an egress boundary even while private.

- No credentials, tokens, connection strings, or internal hostnames with ports.
- No real customer or employee data. Column names and types are fine; **sample rows must be
  synthetic**.
- No wholesale dump of a production schema — include the tables the change actually touches.

If the plan genuinely cannot be drawn without sensitive content, say so, write the same page as
a local self-contained HTML file instead, and open it in the Browser pane. The block schema is
identical; only the surface changes.

## Adapting to the repo

The blocks are generic; the conventions are not. Before rendering, look at how this repo
actually names and layers things, and use *its* vocabulary in the plan — its layer names, its
table prefixes, its handler/controller idiom, its error-response shape. A plan written in
generic architecture-speak reads as if it were written for a different codebase, and the
reviewer cannot tell whether you understood theirs. Check `AGENTS.md` / `CLAUDE.md` and any
memory entries for gotchas that belong in the Risks block.
