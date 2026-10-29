export const meta = {
  name: 'fan-out-run',
  description: 'Carry out an approved plan outside the main session: a Sonnet planner splits it and commits the shared contract, then either one Sonnet session builds it (small plans) or parallel Sonnet workers do (large plans); one integrator merges, one Opus review, one Sonnet verifier, cleanup',
  whenToUse: 'Started by the starter:fan-out skill with an approved plan. Not for direct use.',
  phases: [
    { title: 'Plan', detail: 'split the plan, decide one session or fan-out, commit the shared contract', model: 'sonnet' },
    { title: 'Implement', detail: 'one Sonnet session, or one Sonnet worker per part in its own worktree', model: 'sonnet' },
    { title: 'Integrate', detail: 'merge the worker branches one at a time and run the checks', model: 'sonnet' },
    { title: 'Review', detail: 'code-review at high effort on base..HEAD in a fresh context', model: 'opus' },
    { title: 'Verify', detail: 'reproduce, fix or dismiss each finding with evidence; plan table', model: 'sonnet' },
    { title: 'Clean up', detail: 'remove merged worktrees and branches with the safe script', model: 'haiku' },
  ],
}

// args from the fan-out skill: { plan, checks, deps, pluginRoot, forceFanOut }
//   plan: plan file path or text; checks: exact check commands; deps: how a fresh worktree gets dependencies;
//   pluginRoot: CLAUDE_PLUGIN_ROOT; forceFanOut: true when the user asked for fan-out explicitly.
// Models are fixed here by design. Sonnet builds; effort, not a bigger model, handles the harder parts; Opus only
// reviews. Measured on a 4-part plan: one Sonnet session solved it at about 40% of one Opus session's cost, and the
// main session's coordination, not the workers, made earlier fan-out designs expensive.
const A = typeof args === 'string' ? JSON.parse(args) : args
if (!A || !A.plan || !A.checks || !A.pluginRoot) {
  throw new Error('fan-out-run needs args { plan, checks, deps, pluginRoot, forceFanOut }')
}
const EFFORT = { mechanical: 'low', standard: 'medium', hard: 'high' }

const PLAN = {
  type: 'object',
  properties: {
    base: { type: 'string', description: 'HEAD before you changed anything' },
    branch: { type: 'string' },
    mode: { type: 'string', enum: ['fan-out', 'one-session'] },
    scope: { type: 'string', description: 'Scope: <n> qualifying parts; estimated non-test lines per part: <a, b, ...>; large parts: <k> -> <mode>' },
    contract: { type: 'string', description: 'what you committed as the shared contract, with paths; empty for one-session' },
    parts: { type: 'array', items: { type: 'object', properties: {
      goal: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
      behaviour: { type: 'string' }, done: { type: 'string' }, tier: { type: 'string', enum: ['mechanical', 'standard', 'hard'] },
    }, required: ['goal', 'files', 'behaviour', 'done', 'tier'] } },
    blocker: { type: 'string', description: 'why the plan cannot be carried out as written; empty if none' },
  },
  required: ['base', 'branch', 'mode', 'scope', 'contract', 'parts', 'blocker'],
}
const WORK = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, worktree: { type: 'string' }, commit: { type: 'string' },
    checksPassed: { type: 'boolean' }, checkOutput: { type: 'string' }, blocker: { type: 'string' },
  },
  required: ['branch', 'worktree', 'commit', 'checksPassed', 'checkOutput', 'blocker'],
}
const INTEGRATION = {
  type: 'object',
  properties: {
    merged: { type: 'array', items: { type: 'object', properties: { branch: { type: 'string' }, ok: { type: 'boolean' }, note: { type: 'string' } }, required: ['branch', 'ok', 'note'] } },
    checksPassed: { type: 'boolean' }, checkOutput: { type: 'string' },
  },
  required: ['merged', 'checksPassed', 'checkOutput'],
}
const FINDINGS = {
  type: 'object',
  properties: { findings: { type: 'array', items: { type: 'object', properties: {
    file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, scenario: { type: 'string' },
  }, required: ['file', 'summary'] } } },
  required: ['findings'],
}
const VERDICT = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: {
      summary: { type: 'string' }, outcome: { type: 'string', enum: ['fixed', 'dismissed', 'unverified'] }, evidence: { type: 'string' },
    }, required: ['summary', 'outcome', 'evidence'] } },
    planTable: { type: 'array', items: { type: 'object', properties: {
      item: { type: 'string' }, location: { type: 'string' }, test: { type: 'string' },
    }, required: ['item', 'location', 'test'] } },
    missing: { type: 'array', items: { type: 'string' } },
    checksPassed: { type: 'boolean' }, checkOutput: { type: 'string' },
  },
  required: ['findings', 'planTable', 'missing', 'checksPassed', 'checkOutput'],
}

phase('Plan')
const plan = await agent(`You prepare an approved plan for implementation. Don't implement the parts.

Plan: ${A.plan}
Checks: ${A.checks}

1. Record the current branch and HEAD (\`git rev-parse --abbrev-ref HEAD\`, \`git rev-parse HEAD\`) before changing anything.
2. Split the plan into parts. A part qualifies only when no other part touches its files and it needs no other part's result, only a shared contract. Shared files (type or interface definitions, a registry or index, a manifest, a central config) belong to the contract, not to a part.
3. Estimate each part's non-test lines. A part is large when it is more than about 200 non-test lines, or 3 or more non-test files, or it needs reading code no other part reads. Choose:
   - "fan-out" when there are 3 or more qualifying parts and at least 2 are large${A.forceFanOut ? ', or since the user asked for fan-out explicitly, whenever there are at least 2 qualifying parts' : ''};
   - otherwise "one-session".
   Write the scope line.
4. For fan-out only: write the shared contract (exports, types, stubs that make the checks pass), run the checks, and commit it on the current branch. For one-session, commit nothing.
5. For each part, write a self-contained brief: goal, files it owns, behaviour with edge cases and error handling, and done (the tests to add). Pick its tier:
   - mechanical: boilerplate, wiring, following a spelled-out pattern;
   - standard: the default;
   - hard: algorithm-heavy or judgment the plan doesn't settle.
   For one-session, return the whole plan as a single part.
6. If the plan can't be carried out as written, say why in blocker.`, { label: 'plan', phase: 'Plan', model: 'sonnet', effort: 'high', schema: PLAN })
if (!plan || plan.blocker) {
  return { stopped: plan ? plan.blocker : 'the planner failed', plan }
}
log(plan.scope)

const workerPrompt = p => `You implement ${plan.mode === 'fan-out' ? 'one part of an approved plan, in your own git worktree; other workers build the other parts in parallel and are merged later' : 'an approved plan'}.

Goal: ${p.goal}
Files you own (create or change only these): ${p.files.join(', ')}
${plan.contract ? `Contract, already committed: ${plan.contract}\n` : ''}Behaviour: ${p.behaviour}
Done when: ${p.done}
Checks: ${A.checks}
Dependencies: ${A.deps || 'none needed'}
Plan, for context: ${A.plan}

- Read the existing code your part uses before writing. If something you need is missing from the contract, or the part needs a file you don't own, stop and report it as the blocker.
- Write it with tests, in the style of the code around it. Run the checks. Commit on the current branch. Don't push, merge or switch branches. Don't run code-review: the result is reviewed once at the end.`

phase('Implement')
let work
if (plan.mode === 'fan-out') {
  work = await parallel(plan.parts.map((p, i) => () => agent(workerPrompt(p), {
    label: `part ${i + 1} (${p.tier})`, phase: 'Implement', model: 'sonnet', effort: EFFORT[p.tier] || 'medium', isolation: 'worktree', schema: WORK,
  })))
} else {
  const p = plan.parts[0] || { goal: 'the whole plan', files: ['as the plan says'], behaviour: 'as the plan says', done: 'as the plan says', tier: 'standard' }
  work = [await agent(workerPrompt(p), { label: 'one session', phase: 'Implement', model: 'sonnet', effort: EFFORT[p.tier] || 'medium', schema: WORK })]
}
// Results keep the order of plan.parts, so parts are matched by position, never by ids the agents report.
const parts = plan.parts.map((p, i) => ({ ...p, n: i + 1, result: work[i] }))
const ready = parts.filter(p => p.result && p.result.commit && !p.result.blocker)
log(`${ready.length}/${parts.length} built`)

let integration = null
if (plan.mode === 'fan-out' && ready.length) {
  phase('Integrate')
  integration = await agent(`Merge finished worker branches into the current branch (${plan.branch}) of this repository, one at a time, in this order, and run the checks after each merge:
${ready.map(p => `- part ${p.n}: branch ${p.result.branch}; it may change only: ${p.files.join(', ')}`).join('\n')}

For each branch:
1. \`git diff --name-only HEAD...<branch>\`: if it touches a file outside its list, don't merge it; report why.
2. \`git merge --no-ff <branch>\`. On a conflict, \`git merge --abort\` and report it; don't resolve conflicts by guessing.
3. Run: ${A.checks}. If they fail, report the failing output for that branch.
Don't edit source files, push or delete branches. Report every branch by its exact name.`, { label: 'integrate', phase: 'Integrate', model: 'sonnet', schema: INTEGRATION })
}
const mergedBranches = integration ? integration.merged.filter(m => m.ok).map(m => m.branch) : []
const landed = plan.mode === 'fan-out' ? mergedBranches.length > 0 : ready.length > 0

let review = null
let verified = null
if (landed) {
  phase('Review')
  review = await agent(`Call the code-review skill with the Skill tool, args \`high ${plan.base}..HEAD\`, wait for its findings and return them unchanged as structured data. Don't edit anything.`, { label: 'code-review high', phase: 'Review', model: 'opus', schema: FINDINGS })

  phase('Verify')
  verified = await agent(`You verify a change you didn't write. Plan: ${A.plan}
Checks: ${A.checks}
Code-review findings:
${JSON.stringify(review ? review.findings : [], null, 1)}

1. Give each finding one outcome, with evidence:
   - fixed: first reproduce it with a command or a throwaway test (not committed), then fix it and add a regression test;
   - dismissed: only with evidence that it's wrong (the line you read, or a command you ran and its output);
   - unverified: only when checking would take more than a few minutes or needs the user's decision (a gap or conflict in the plan).
   "The plan's examples pass" and "it was like that before" are not evidence. When in doubt, it's unverified.
2. Plan table: every item in the plan, with the file:line that implements it and the name of the test that covers it. An item without both goes in "missing"; don't implement it.
3. Run the checks, commit your fixes on the current branch as "fan-out: review fixes" (if any), and report.`, { label: 'verify', phase: 'Verify', model: 'sonnet', schema: VERDICT })
}

let cleanup = 'no worktrees'
if (plan.mode === 'fan-out') {
  phase('Clean up')
  const trees = parts.filter(p => p.result && mergedBranches.includes(p.result.branch)).map(p => p.result.worktree)
  cleanup = trees.length ? await agent(`Run these two commands in this repository and return their output verbatim, nothing else:
node "${A.pluginRoot}/scripts/worktrees.mjs" remove --include-ignored ${trees.map(t => `"${t}"`).join(' ')}
node "${A.pluginRoot}/scripts/worktrees.mjs" delete-branches --into ${plan.branch} ${mergedBranches.join(' ')}`, { label: 'cleanup', phase: 'Clean up', model: 'haiku' }) : 'nothing merged, nothing removed'
}

return {
  mode: plan.mode,
  scope: plan.scope,
  base: plan.base,
  parts: parts.map(p => ({
    part: p.n, goal: p.goal, tier: p.tier, branch: p.result ? p.result.branch : null,
    built: Boolean(p.result && p.result.commit && !p.result.blocker), blocker: p.result ? p.result.blocker : 'worker failed',
    merged: plan.mode === 'fan-out' ? Boolean(p.result && mergedBranches.includes(p.result.branch)) : null,
  })),
  integration: integration ? integration.merged : null,
  review: verified ? verified.findings : (review ? review.findings : []),
  planTable: verified ? verified.planTable : [],
  missing: verified ? verified.missing : [],
  finalChecks: verified ? { passed: verified.checksPassed, output: verified.checkOutput } : null,
  unmergedWorktrees: parts.filter(p => p.result && p.result.worktree && !mergedBranches.includes(p.result.branch)).map(p => p.result.worktree),
  cleanup,
}
