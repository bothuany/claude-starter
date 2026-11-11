export const meta = {
  name: 'fan-out-run',
  description: 'Carry out an approved plan outside the main session on a work branch: one Sonnet builder (or, when the user approved it for a very large plan, parallel Sonnet workers and an integrator), then one fresh reviewer that runs code-review and settles every finding with evidence',
  whenToUse: 'Started by the starter:fan-out skill with an approved plan. Not for direct use.',
  phases: [
    { title: 'Build', detail: 'one Sonnet agent builds the whole plan, or (parallel approved) commits the shared contract and writes one brief per part', model: 'sonnet' },
    { title: 'Fan out', detail: 'parallel only: one Sonnet worker per part in its own worktree', model: 'sonnet' },
    { title: 'Integrate', detail: 'parallel only: merge the branches one at a time with fast checks, fix or roll back only the failing merge, run the full checks once, remove merged worktrees', model: 'sonnet' },
    { title: 'Review', detail: 'code-review at high effort on base..HEAD, then reproduce, fix or dismiss each finding with evidence; plan table' },
  ],
}

// args from the fan-out skill: { plan, checks, fastChecks, deps, pluginRoot, base, parallel }
// The skill has already checked out a clean work branch at `base` (a sha it read from git, never an agent's report)
// and asked the user about `parallel` when the plan is very large. Every workflow agent pays its own start-up (about
// 70k tokens of context on a machine with many skills and MCP servers), so this script uses as few as the job allows:
// 2 for most plans (builder, reviewer), 3 + one per part when the user approved parallel workers. Measured: one plain
// Sonnet session solved both benchmark plans (4 parts of ~100 and ~250 lines) at the lowest cost; parallel workers
// only pay off when the parts together don't fit in one session's context.
const REVIEW_MODEL = 'sonnet'

const A = typeof args === 'string' ? JSON.parse(args) : args
if (!A || !A.plan || !A.checks || !A.pluginRoot || !A.base) {
  throw new Error('fan-out-run needs args { plan, checks, fastChecks, deps, pluginRoot, base, parallel }')
}
const EFFORT = { mechanical: 'low', standard: 'medium', hard: 'high' }
// A silent wait (an `until [ -f done ]` loop around a background run) shows as "stalled" in the UI.
const LONG_RUNS = 'Run long commands (the checks) in the foreground with an explicit Bash timeout of up to 600000 ms, never as a background job polled by a silent loop.'

const BUILD = {
  type: 'object',
  properties: {
    branch: { type: 'string', description: 'the current branch' },
    head: { type: 'string', description: 'HEAD after your last commit (git rev-parse HEAD)' },
    mode: { type: 'string', enum: ['one-session', 'fan-out'] },
    scope: { type: 'string' },
    contract: { type: 'string', description: 'fan-out only: what you committed as the shared contract, with paths' },
    contractCommit: { type: 'string', description: 'fan-out only: the sha of the contract commit' },
    parts: { type: 'array', description: 'fan-out only', items: { type: 'object', properties: {
      goal: { type: 'string' }, files: { type: 'array', items: { type: 'string' } },
      behaviour: { type: 'string' }, done: { type: 'string' }, tier: { type: 'string', enum: ['mechanical', 'standard', 'hard'] },
    }, required: ['goal', 'files', 'behaviour', 'done', 'tier'] } },
    checksPassed: { type: 'boolean' }, checkOutput: { type: 'string' },
    notes: { type: 'string', description: 'caveats for the workers or the reviewer; empty if none' },
    ciGaps: { type: 'array', items: { type: 'string' }, description: 'CI jobs or steps whose commands the checks do not cover' },
    blocker: { type: 'string', description: 'why the plan cannot be carried out as written; empty if none' },
  },
  required: ['branch', 'head', 'mode', 'scope', 'contract', 'contractCommit', 'parts', 'checksPassed', 'checkOutput', 'notes', 'ciGaps', 'blocker'],
}
const WORK = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, worktree: { type: 'string' }, commit: { type: 'string' },
    built: { type: 'boolean', description: 'true when the part is implemented and committed' },
    checksPassed: { type: 'boolean' }, checkOutput: { type: 'string' },
    notes: { type: 'string', description: 'anything the integrator or reviewer should know; empty if none' },
    blocker: { type: 'string', description: 'only when built is false: why the part could not be built' },
  },
  required: ['branch', 'worktree', 'commit', 'built', 'checksPassed', 'checkOutput', 'notes', 'blocker'],
}
const INTEGRATION = {
  type: 'object',
  properties: {
    merged: { type: 'array', items: { type: 'object', properties: {
      part: { type: 'number' }, branch: { type: 'string' }, ok: { type: 'boolean', description: 'true when the merge is on the branch at the end' },
      note: { type: 'string', description: 'out-of-list files and why they were accepted, fixes made, or why it was dropped (with the reset or revert)' },
    }, required: ['part', 'branch', 'ok', 'note'] } },
    fixes: { type: 'array', items: { type: 'object', properties: {
      part: { type: 'number' }, commit: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, why: { type: 'string' },
    }, required: ['part', 'commit', 'files', 'why'] } },
    checksPassed: { type: 'boolean' }, checkOutput: { type: 'string' }, cleanup: { type: 'string' },
  },
  required: ['merged', 'fixes', 'checksPassed', 'checkOutput', 'cleanup'],
}
const REVIEW = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: {
      summary: { type: 'string' }, outcome: { type: 'string', enum: ['fixed', 'dismissed', 'pre-existing', 'needs-decision', 'not-checked'] }, evidence: { type: 'string' },
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
const build = await agent(`You carry out an approved plan in this repository, on the current branch (a work branch made for it).
Plan: ${A.plan}
Checks: ${A.checks}

1. ${A.parallel
    ? `The user approved parallel workers for this plan. Split it into parts. A part qualifies only when no other part touches its files and it needs no other part's result, only a shared contract (shared types, an index or registry, a manifest or central config belong to the contract). Choose "fan-out" when there are 2 or more qualifying parts, else "one-session". Write the scope line: "Scope: <n> qualifying parts; estimated non-test lines per part: <...> -> <mode>".`
    : 'Choose "one-session". Write the scope line: "Scope: one session; estimated non-test lines: <n>".'}
2. Don't switch branches. Report the current branch, and HEAD after your last commit.
3. one-session: implement the whole plan yourself now, with tests, in the style of the code around it. Run the checks and commit. Leave contract and contractCommit empty and parts as [].
4. fan-out: don't implement the parts. Write and commit the shared contract (exports, types, stubs that keep the checks passing) and report its sha. Then return one self-contained brief per part: goal, files it owns, behaviour with edge cases and error handling, done (the tests to add), and tier (mechanical, standard or hard).
5. CI: read the CI config (\`.github/workflows/*.yml\` and any other CI files). List in ciGaps each job or step whose commands the checks above don't cover (a site build, a type check of another package, ...). Don't add them to the checks yourself.
6. Don't run code-review; the result is reviewed once at the end. Put caveats in notes. blocker is only for a plan that can't be carried out as written: anything in it stops the run. ${LONG_RUNS}`, { label: 'build', phase: 'Build', model: 'sonnet', effort: 'high', schema: BUILD })
if (!build || build.blocker) {
  return { status: 'stopped', stopped: build ? build.blocker : 'the builder failed', base: A.base, build }
}
if (build.mode === 'fan-out' && !A.parallel) {
  // Parallel workers cost several times one builder; only the user can approve them.
  return { status: 'stopped', stopped: 'the builder chose fan-out, but the user did not approve parallel workers', base: A.base, build }
}
if (build.mode === 'fan-out' && !build.parts.length) {
  return { status: 'stopped', stopped: 'the builder chose fan-out but returned no parts', base: A.base, build }
}
if (build.mode === 'fan-out') {
  // Two parts that declare the same file can't be merged independently. Decided here from the declared lists, not by
  // an agent: they become one part, so one worker builds them in order and only disjoint parts run in parallel.
  const declared = build.parts.length
  build.parts = foldOverlapping(build.parts)
  if (build.parts.length < declared) log(`${declared - build.parts.length} part(s) shared files with another part and were folded into it: ${build.parts.length} worker(s)`)
}
log(build.scope)
if (build.ciGaps && build.ciGaps.length) log(`CI runs more than the checks: ${build.ciGaps.join('; ')}`)

let integration = null
let parts = []
if (build.mode === 'fan-out' && build.parts.length) {
  phase('Fan out')
  const work = await parallel(build.parts.map((p, i) => () => agent(`You implement one part of an approved plan, in your own git worktree. Other workers build the other parts in parallel and are merged later.

Goal: ${p.goal}
Files you own: ${p.files.join(', ')}
Contract, already committed in ${build.contractCommit}: ${build.contract}${build.notes ? `
Builder notes: ${build.notes}` : ''}
Behaviour: ${p.behaviour}
Done when: ${p.done}
Checks: ${A.checks}
Dependencies: ${A.deps || 'none needed'}
Plan, for context: ${A.plan}

- First run \`git merge-base --is-ancestor ${build.contractCommit} HEAD\`. If it fails, your worktree doesn't hold the contract (worktree.baseRef isn't "head"): stop, set built to false and say so in blocker.
- Read the existing code your part uses before writing. If something you need is missing from the contract, stop, set built to false and say why in blocker. Never change the contract's files.
- Stay in your files. If the goal truly needs a small change elsewhere (the place the plan puts the feature, a new pure helper), make it, keep it minimal, and name the file and why in notes; the integrator decides.
- Write it with tests, in the style of the code around it. Run the checks. Commit on the current branch. Don't push, merge or switch branches. Don't run code-review. ${LONG_RUNS}
- Set built to true once the part is committed. blocker is only for a part you could not build; anything else goes in notes.`,
    { label: `part ${i + 1} (${p.tier})`, phase: 'Fan out', model: 'sonnet', effort: EFFORT[p.tier] || 'medium', isolation: 'worktree', schema: WORK })))
  // Results keep the order of build.parts, so parts are matched by position, never by ids an agent reports.
  parts = build.parts.map((p, i) => ({ ...p, n: i + 1, result: work[i] }))
  const ready = parts.filter(isBuilt)
  log(`${ready.length}/${parts.length} parts built`)

  if (ready.length) {
    phase('Integrate')
    const perMerge = A.fastChecks
      ? `run the fast checks: ${A.fastChecks}`
      : 'run no checks (a clean merge is enough here)'
    log(`integrating ${ready.length} branch(es)${A.fastChecks ? ' with fast checks per merge' : ''}, full checks once at the end`)
    integration = await agent(`Merge finished worker branches into the current branch (${build.branch}) of this repository, one at a time, in this order. Handle every branch on the list and report each one in merged, with its part number and exact branch name:
${ready.map(p => `- part ${p.n}: branch ${p.result.branch}, worktree ${p.result.worktree}; its files: ${p.files.join(', ')}; goal: ${p.goal}${p.result.notes ? `; worker notes: ${p.result.notes}` : ''}`).join('\n')}

For each branch:
1. Record HEAD (\`git rev-parse HEAD\`) as that merge's restore point.
2. \`git diff --name-only HEAD...<branch>\`. A file outside the part's list is a warning, not a refusal: read that hunk, and accept it when it serves the part's goal, no other part on the list owns or touches that file, and it isn't part of the shared contract. A change to the contract is never accepted: don't merge that branch. Name every accepted file in the note.
3. \`git merge --no-ff <branch>\`. On a conflict, \`git merge --abort\` and report it; don't resolve conflicts by guessing.
4. Then ${perMerge}.
5. If a check fails: when the fix is small, make it, commit it as "fan-out: integrate fix part <n>" and list it in fixes. Small means at most 10 changed lines, only in files that part's merge changed, and no change to tests. Otherwise drop only this merge with \`git reset --hard <its restore point>\` and report the failing output. Never redo earlier merges.

After the last branch, run the full checks once: ${A.checks}
If they fail, find the merge that caused it from the failing output (the files and tests it names map to parts); don't rerun the checks once per merge to find it. If the output doesn't point clearly at one part (two merges interacting, say), don't revert anything: report it in checkOutput. Otherwise fix it the same small way, or undo that part: \`git revert\` its integrate-fix commits, newest first, then \`git revert -m 1 <its merge commit>\`. Mark that branch ok: false with the revert shas in its note, and run the full checks again. If a revert conflicts, \`git revert --abort\`, keep the branch as it is, and report the failing output in checkOutput.
${LONG_RUNS}

Then remove the worktrees and branches that are merged at the end, and only those, with the safe script, and put its output in cleanup:
node "${A.pluginRoot}/scripts/worktrees.mjs" remove --include-ignored <merged worktree paths, quoted>
node "${A.pluginRoot}/scripts/worktrees.mjs" delete-branches --into ${build.branch} <merged branches>
Edit source files only for the small fixes above. Don't push, or remove anything that isn't merged.`, { label: 'integrate', phase: 'Integrate', model: 'sonnet', schema: INTEGRATION })
  }
}
// Parts are matched by the number this script gave them, not by a branch name an agent reports back.
const reportFor = p => (integration ? integration.merged.find(m => m.part === p.n) : null)
// The integrator died after starting: some branches may be merged on the work branch already, so nothing is known.
const integrationFailed = build.mode === 'fan-out' && parts.some(isBuilt) && !integration
const isMerged = p => isBuilt(p) && Boolean(reportFor(p) && reportFor(p).ok)
if (integration) {
  const skipped = parts.filter(isBuilt).filter(p => !reportFor(p))
  if (skipped.length) log(`the integrator did not report part(s) ${skipped.map(p => p.n).join(', ')}; counted as unmerged`)
}
// Every part that didn't land, with its reason, so the reviewer doesn't report it as a missing feature.
const dropped = parts.filter(p => !isMerged(p)).map(p => {
  const m = reportFor(p)
  const why = !isBuilt(p) ? `not built: ${p.result ? p.result.blocker : 'worker failed'}`
    : m ? `not merged: ${m.note}`
    : integrationFailed ? 'unknown: the integrator failed; inspect the work branch' : 'not merged: skipped by the integrator'
  return `part ${p.n} (${p.goal}): ${why}`
})
// One session landed when its checks pass and it committed something; fan-out when at least one part merged.
const landed = build.mode === 'fan-out' ? parts.some(isMerged) : build.checksPassed === true && build.head !== A.base
if (!landed) {
  log(build.mode === 'fan-out' ? 'no part merged: nothing to review' : 'the build has no passing commit: nothing to review')
}

let review = null
if (landed) {
  phase('Review')
  log(dropped.length ? `reviewing without ${dropped.length} part(s) that did not land` : 'reviewing the whole change')
  review = await agent(`You review a change you didn't write, then settle every finding. Plan: ${A.plan}
Checks: ${A.checks}
${integration && integration.fixes.length ? `The integrator committed these fixes itself; check each one:
${integration.fixes.map(f => `- part ${f.part}, ${f.commit} (${f.files.join(', ')}): ${f.why}`).join('\n')}
` : ''}${dropped.length ? `These parts did not land and are not on this branch. List their plan items in "missing", not as findings:\n${dropped.map(d => `- ${d}`).join('\n')}\n` : ''}
1. If the repository root has a REVIEW.md, read it first: it says what failure looks like here, what is risky and what to skip.
2. Call the code-review skill with the Skill tool, args \`high ${A.base}..HEAD\`, and wait for its findings.
3. Give each finding one outcome, with evidence:
   - fixed: first reproduce it with a command or a throwaway test (not committed), then fix it and add a regression test;
   - dismissed: only with evidence that it's wrong (the line you read, or a command you ran and its output);
   - pre-existing: the bug is in code this change did not touch (name the line); report it, don't fix it;
   - needs-decision: it needs the user's decision (a gap or conflict in the plan);
   - not-checked: checking would take more than a few minutes, or you didn't get to it; say what you would run.
   "The plan's examples pass" and "it was like that before" are not evidence. When in doubt, it's not-checked.
   When a finding is one instance of a class, find every instance in the change and settle them together.
4. Plan table: every item in the plan, with the file:line that implements it and the name of the test that covers it. An item without both goes in "missing"; don't implement it.
5. Run the checks, commit your fixes on the current branch as "fan-out: review fixes" (if any), and report. ${LONG_RUNS}`, { label: 'review', phase: 'Review', model: REVIEW_MODEL, schema: REVIEW })
}

// done only when the review ran and its final checks pass.
const status = integrationFailed ? 'integration-failed'
  : !landed ? 'not-landed'
  : !review ? 'review-failed'
  : !review.checksPassed ? 'checks-failing'
  : dropped.length ? 'partial' : 'done'
return {
  status,
  branch: build.branch,
  mode: build.mode,
  scope: build.scope,
  base: A.base,
  ciGaps: build.ciGaps || [],
  buildChecks: { passed: build.checksPassed, output: build.checkOutput },
  buildNotes: build.notes || '',
  parts: parts.map(p => ({
    part: p.n, goal: p.goal, tier: p.tier, branch: p.result ? p.result.branch : null,
    built: isBuilt(p), blocker: isBuilt(p) ? '' : p.result ? p.result.blocker : 'worker failed', notes: p.result ? p.result.notes : '',
    merged: isMerged(p),
  })),
  integration: integration ? { merged: integration.merged, fixes: integration.fixes, checksPassed: integration.checksPassed, cleanup: integration.cleanup } : null,
  review: review ? review.findings : [],
  planTable: review ? review.planTable : [],
  missing: review ? review.missing : [],
  dropped,
  finalChecks: review ? { passed: review.checksPassed, output: review.checkOutput } : null,
  unmergedWorktrees: parts.filter(p => p.result && p.result.worktree && !isMerged(p)).map(p => p.result.worktree),
}

function sameFile(a, b) {
  const [x, y] = [a, b].map(f => f.replace(/^\.\//, ''))
  // A trailing slash declares a whole directory.
  return x === y || (x.endsWith('/') && y.startsWith(x)) || (y.endsWith('/') && x.startsWith(y))
}

function foldOverlapping(parts) {
  const TIERS = ['mechanical', 'standard', 'hard']
  const groups = []
  for (const p of parts) {
    const hits = groups.filter(g => g.files.some(f => p.files.some(q => sameFile(f, q))))
    if (!hits.length) { groups.push({ ...p, files: [...p.files] }); continue }
    const first = hits[0]
    for (const g of [...hits.slice(1), p]) {
      first.goal += `; then: ${g.goal}`
      first.behaviour += `\n${g.behaviour}`
      first.done += `; ${g.done}`
      first.files = [...new Set([...first.files, ...g.files])]
      if (TIERS.indexOf(g.tier) > TIERS.indexOf(first.tier)) first.tier = g.tier
    }
    for (const g of hits.slice(1)) groups.splice(groups.indexOf(g), 1)
  }
  return groups
}

function isBuilt(p) {
  // A worker's notes or a stray blocker never un-build a committed part.
  return Boolean(p.result && p.result.built && p.result.commit)
}
