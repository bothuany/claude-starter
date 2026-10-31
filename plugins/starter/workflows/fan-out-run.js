export const meta = {
  name: 'fan-out-run',
  description: 'Carry out an approved plan outside the main session with as few agents as possible: one Sonnet builder (or a Sonnet planner plus parallel Sonnet workers and an integrator for large plans), then one fresh reviewer that runs code-review and settles every finding with evidence',
  whenToUse: 'Started by the starter:fan-out skill with an approved plan. Not for direct use.',
  phases: [
    { title: 'Build', detail: 'one Sonnet agent splits the plan; it builds it itself, or commits the shared contract for fan-out', model: 'sonnet' },
    { title: 'Fan out', detail: 'large plans only: one Sonnet worker per part in its own worktree', model: 'sonnet' },
    { title: 'Integrate', detail: 'large plans only: merge the branches one at a time, run the checks, remove merged worktrees', model: 'sonnet' },
    { title: 'Review', detail: 'code-review at high effort on base..HEAD, then reproduce, fix or dismiss each finding with evidence; plan table' },
  ],
}

// args from the fan-out skill: { plan, checks, deps, pluginRoot, forceFanOut }
// Every workflow agent pays its own start-up (system prompt, tools, reading the repo), so this script uses as few as
// the job allows: 2 for most plans (builder, reviewer), 3 + one per part for large ones. Measured: one plain Sonnet
// session solved both benchmark plans (4 parts of ~100 and ~250 lines) at the lowest cost; parallel workers never
// beat it, and earlier designs lost most money to coordination and per-agent start-up.
const REVIEW_MODEL = 'sonnet'

const A = typeof args === 'string' ? JSON.parse(args) : args
if (!A || !A.plan || !A.checks || !A.pluginRoot) {
  throw new Error('fan-out-run needs args { plan, checks, deps, pluginRoot, forceFanOut }')
}
const EFFORT = { mechanical: 'low', standard: 'medium', hard: 'high' }

const BUILD = {
  type: 'object',
  properties: {
    base: { type: 'string', description: 'HEAD before you changed anything' },
    branch: { type: 'string' },
    mode: { type: 'string', enum: ['one-session', 'fan-out'] },
    scope: { type: 'string' },
    contract: { type: 'string', description: 'fan-out only: what you committed as the shared contract, with paths' },
    parts: { type: 'array', description: 'fan-out only', items: { type: 'object', properties: {
      goal: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
      behaviour: { type: 'string' }, done: { type: 'string' }, tier: { type: 'string', enum: ['mechanical', 'standard', 'hard'] },
    }, required: ['goal', 'files', 'behaviour', 'done', 'tier'] } },
    checksPassed: { type: 'boolean' }, checkOutput: { type: 'string' },
    blocker: { type: 'string', description: 'why the plan cannot be carried out as written; empty if none' },
  },
  required: ['base', 'branch', 'mode', 'scope', 'contract', 'parts', 'checksPassed', 'checkOutput', 'blocker'],
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
    checksPassed: { type: 'boolean' }, checkOutput: { type: 'string' }, cleanup: { type: 'string' },
  },
  required: ['merged', 'checksPassed', 'checkOutput', 'cleanup'],
}
const REVIEW = {
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

phase('Build')
const build = await agent(`You carry out an approved plan in this repository.
${A.forceFanOut ? 'The user asked for fan-out explicitly: choose "fan-out" whenever there are at least 2 qualifying parts, whatever their size.\n' : ''}
Plan: ${A.plan}
Checks: ${A.checks}

1. Record the current branch and HEAD (\`git rev-parse --abbrev-ref HEAD\`, \`git rev-parse HEAD\`) before changing anything.
2. Split the plan into parts. A part qualifies only when no other part touches its files and it needs no other part's result, only a shared contract (shared types, an index or registry, a manifest or central config belong to the contract).
3. Estimate each part's non-test lines. A part is large when it is more than about 200 non-test lines, or 3 or more non-test files, or it needs reading code no other part reads. Write the scope line: "Scope: <n> qualifying parts; estimated non-test lines per part: <...>; large parts: <k> -> <mode>".
   - Choose "fan-out" only when n is 3 or more and k is 2 or more${A.forceFanOut ? ' (or as the user asked, see above)' : ''}.
   - Otherwise choose "one-session".
4. one-session: implement the whole plan yourself now, with tests, in the style of the code around it. Run the checks and commit. Leave contract empty and parts as [].
5. fan-out: don't implement the parts. Write and commit the shared contract (exports, types, stubs that keep the checks passing). Then return one self-contained brief per part: goal, files it owns, behaviour with edge cases and error handling, done (the tests to add), and tier (mechanical, standard or hard).
6. Don't run code-review; the result is reviewed once at the end. If the plan can't be carried out as written, say why in blocker.`, { label: 'build', phase: 'Build', model: 'sonnet', effort: 'high', schema: BUILD })
if (!build || build.blocker) {
  return { stopped: build ? build.blocker : 'the builder failed', build }
}
log(build.scope)

let integration = null
let parts = []
if (build.mode === 'fan-out' && build.parts.length) {
  phase('Fan out')
  const work = await parallel(build.parts.map((p, i) => () => agent(`You implement one part of an approved plan, in your own git worktree. Other workers build the other parts in parallel and are merged later.

Goal: ${p.goal}
Files you own (create or change only these): ${p.files.join(', ')}
Contract, already committed: ${build.contract}
Behaviour: ${p.behaviour}
Done when: ${p.done}
Checks: ${A.checks}
Dependencies: ${A.deps || 'none needed'}
Plan, for context: ${A.plan}

- Read the existing code your part uses before writing. If something you need is missing from the contract, or the part needs a file you don't own, stop and report it as the blocker.
- Write it with tests, in the style of the code around it. Run the checks. Commit on the current branch. Don't push, merge or switch branches. Don't run code-review.`,
    { label: `part ${i + 1} (${p.tier})`, phase: 'Fan out', model: 'sonnet', effort: EFFORT[p.tier] || 'medium', isolation: 'worktree', schema: WORK })))
  // Results keep the order of build.parts, so parts are matched by position, never by ids an agent reports.
  parts = build.parts.map((p, i) => ({ ...p, n: i + 1, result: work[i] }))
  const ready = parts.filter(p => p.result && p.result.commit && !p.result.blocker)
  log(`${ready.length}/${parts.length} parts built`)

  if (ready.length) {
    phase('Integrate')
    integration = await agent(`Merge finished worker branches into the current branch (${build.branch}) of this repository, one at a time, in this order, and run the checks after each merge:
${ready.map(p => `- part ${p.n}: branch ${p.result.branch}, worktree ${p.result.worktree}; it may change only: ${p.files.join(', ')}`).join('\n')}

For each branch:
1. \`git diff --name-only HEAD...<branch>\`: if it touches a file outside its list, don't merge it; report why.
2. \`git merge --no-ff <branch>\`. On a conflict, \`git merge --abort\` and report it; don't resolve conflicts by guessing.
3. Run: ${A.checks}. If they fail, report the failing output for that branch.

Then remove the worktrees and branches you merged, and only those, with the safe script, and put its output in cleanup:
node "${A.pluginRoot}/scripts/worktrees.mjs" remove --include-ignored <merged worktree paths, quoted>
node "${A.pluginRoot}/scripts/worktrees.mjs" delete-branches --into ${build.branch} <merged branches>
Don't edit source files, push, or remove anything you didn't merge. Report every branch by its exact name.`, { label: 'integrate', phase: 'Integrate', model: 'sonnet', schema: INTEGRATION })
  }
}
const mergedBranches = integration ? integration.merged.filter(m => m.ok).map(m => m.branch) : []
const landed = build.mode === 'fan-out' ? mergedBranches.length > 0 : build.checksPassed !== undefined

let review = null
if (landed) {
  phase('Review')
  review = await agent(`You review a change you didn't write, then settle every finding. Plan: ${A.plan}
Checks: ${A.checks}

1. Call the code-review skill with the Skill tool, args \`high ${build.base}..HEAD\`, and wait for its findings.
2. Give each finding one outcome, with evidence:
   - fixed: first reproduce it with a command or a throwaway test (not committed), then fix it and add a regression test;
   - dismissed: only with evidence that it's wrong (the line you read, or a command you ran and its output);
   - unverified: only when checking would take more than a few minutes or needs the user's decision (a gap or conflict in the plan).
   "The plan's examples pass" and "it was like that before" are not evidence. When in doubt, it's unverified.
3. Plan table: every item in the plan, with the file:line that implements it and the name of the test that covers it. An item without both goes in "missing"; don't implement it.
4. Run the checks, commit your fixes on the current branch as "fan-out: review fixes" (if any), and report.`, { label: 'review', phase: 'Review', model: REVIEW_MODEL, schema: REVIEW })
}

return {
  mode: build.mode,
  scope: build.scope,
  base: build.base,
  buildChecks: { passed: build.checksPassed, output: build.checkOutput },
  parts: parts.map(p => ({
    part: p.n, goal: p.goal, tier: p.tier, branch: p.result ? p.result.branch : null,
    built: Boolean(p.result && p.result.commit && !p.result.blocker), blocker: p.result ? p.result.blocker : 'worker failed',
    merged: Boolean(p.result && mergedBranches.includes(p.result.branch)),
  })),
  integration: integration ? { merged: integration.merged, checksPassed: integration.checksPassed, cleanup: integration.cleanup } : null,
  review: review ? review.findings : [],
  planTable: review ? review.planTable : [],
  missing: review ? review.missing : [],
  finalChecks: review ? { passed: review.checksPassed, output: review.checkOutput } : null,
  unmergedWorktrees: parts.filter(p => p.result && p.result.worktree && !mergedBranches.includes(p.result.branch)).map(p => p.result.worktree),
}
