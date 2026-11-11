// The fan-out-run workflow's control flow, run with a stub runtime: `node --test test/workflow.test.mjs`.
// Each test scripts the agents' answers by label and checks which agents ran, what they were told, and what the
// workflow returned. The prompts themselves are only spot-checked.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'starter', 'workflows', 'fan-out-run.js'), 'utf8')
  .replace(/^export const meta/m, 'const meta')
const AsyncFunction = (async () => {}).constructor

const ARGS = { plan: 'P', checks: 'npm test', fastChecks: 'npm run typecheck', deps: 'none needed', pluginRoot: '/p', base: 'BASE' }

// answers: label prefix -> the agent's return value (or a function of its prompt).
async function runWorkflow(args, answers) {
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, prompt, opts })
    const key = Object.keys(answers).find(prefix => opts.label.startsWith(prefix))
    const answer = key ? answers[key] : null
    return typeof answer === 'function' ? answer(prompt) : answer
  }
  const parallel = thunks => Promise.all(thunks.map(thunk => thunk()))
  const logs = []
  const result = await new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', source)(args, agent, parallel, () => {}, m => logs.push(m))
  return { result, calls, logs, labels: calls.map(c => c.label), prompt: label => calls.find(c => c.label.startsWith(label))?.prompt }
}

const build = (over = {}) => ({
  branch: 'fan-out/x', head: 'HEAD1', mode: 'one-session', scope: 's', contract: '', contractCommit: '', parts: [],
  checksPassed: true, checkOutput: '', notes: '', ciGaps: [], blocker: '', ...over,
})
const review = { findings: [], planTable: [], missing: [], checksPassed: true, checkOutput: '' }
const part = n => ({ goal: `g${n}`, files: [`f${n}`], behaviour: 'b', done: 'd', tier: 'standard' })
const work = (n, over = {}) => ({ branch: `w${n}`, worktree: `t${n}`, commit: `c${n}`, built: true, checksPassed: true, checkOutput: '', notes: '', blocker: '', ...over })

test('without the base sha the workflow refuses to start', async () => {
  await assert.rejects(runWorkflow({ ...ARGS, base: undefined }, {}), /needs args/)
})

test('one session: builds on the work branch, then one review of base..HEAD', async () => {
  const run = await runWorkflow(ARGS, { build: build(), review })
  assert.deepEqual(run.labels, ['build', 'review'])
  assert.match(run.prompt('build'), /Choose "one-session"/)
  assert.doesNotMatch(run.prompt('build'), /parallel workers/)
  assert.match(run.prompt('review'), /high BASE\.\.HEAD/)
  assert.equal(run.result.status, 'done')
  assert.equal(run.result.base, 'BASE')
})

test('one session that failed its checks or committed nothing is not reviewed', async () => {
  for (const over of [{ checksPassed: false }, { head: 'BASE' }]) {
    const run = await runWorkflow(ARGS, { build: build(over), review })
    assert.deepEqual(run.labels, ['build'])
    assert.equal(run.result.status, 'not-landed')
  }
})

test('a builder blocker, or fan-out without parts, stops the run', async () => {
  let run = await runWorkflow(ARGS, { build: build({ blocker: 'plan contradicts itself' }) })
  assert.equal(run.result.status, 'stopped')
  run = await runWorkflow({ ...ARGS, parallel: true }, { build: build({ mode: 'fan-out' }) })
  assert.equal(run.result.status, 'stopped')
  assert.deepEqual(run.labels, ['build'])
})

test('parallel: parts are matched by number, notes never un-build a part, and the reviewer hears what did not land', async () => {
  const run = await runWorkflow({ ...ARGS, parallel: true }, {
    build: build({ mode: 'fan-out', contract: 'types.ts', contractCommit: 'C0', parts: [part(1), part(2), part(3)] }),
    'part 1': work(1, { blocker: 'just a note', notes: 'touched transcripts.ts' }),
    'part 2': work(2),
    'part 3': work(3, { commit: '', built: false, blocker: 'contract lacks X' }),
    // Part 1 reported under a different branch spelling; part 2 not reported at all.
    integrate: { merged: [{ part: 1, branch: 'origin/w1', ok: true, note: 'accepted transcripts.ts' }], fixes: [{ part: 1, commit: 'F1', files: ['f1'], why: 'semgrep' }], checksPassed: true, checkOutput: '', cleanup: '' },
    review,
  })
  assert.deepEqual(run.labels, ['build', 'part 1 (standard)', 'part 2 (standard)', 'part 3 (standard)', 'integrate', 'review'])
  assert.match(run.prompt('part 1'), /merge-base --is-ancestor C0 HEAD/)
  assert.match(run.prompt('integrate'), /part 1: branch w1/)
  assert.doesNotMatch(run.prompt('integrate'), /part 3: branch/)
  assert.deepEqual(run.result.parts.map(p => [p.built, p.merged]), [[true, true], [true, false], [false, false]])
  assert.equal(run.result.parts[0].blocker, '')
  assert.match(run.prompt('review'), /part 1, F1 \(f1\): semgrep/)
  assert.match(run.prompt('review'), /part 2 \(g2\): not merged: skipped by the integrator/)
  assert.match(run.prompt('review'), /part 3 \(g3\): not built: contract lacks X/)
  assert.ok(run.logs.some(line => /did not report part\(s\) 2/.test(line)))
  assert.deepEqual(run.result.unmergedWorktrees, ['t2', 't3'])
  assert.equal(run.result.status, 'partial')
})

test('a fan-out the user did not approve stops before any worker runs', async () => {
  const run = await runWorkflow(ARGS, { build: build({ mode: 'fan-out', contractCommit: 'C0', parts: [part(1), part(2)] }) })
  assert.deepEqual(run.labels, ['build'])
  assert.equal(run.result.status, 'stopped')
  assert.match(run.result.stopped, /did not approve/)
})

test('a failed review, failing final checks or a failed integrator never reads as done', async () => {
  let run = await runWorkflow(ARGS, { build: build(), review: null })
  assert.equal(run.result.status, 'review-failed')
  run = await runWorkflow(ARGS, { build: build(), review: { ...review, checksPassed: false } })
  assert.equal(run.result.status, 'checks-failing')
  run = await runWorkflow({ ...ARGS, parallel: true }, {
    build: build({ mode: 'fan-out', contractCommit: 'C0', parts: [part(1), part(2)] }),
    'part ': work(1),
    integrate: null,
  })
  assert.equal(run.result.status, 'integration-failed')
  assert.match(run.result.dropped[0], /integrator failed; inspect the work branch/)
})

test('parallel with no part merged ends without a review', async () => {
  const run = await runWorkflow({ ...ARGS, parallel: true }, {
    build: build({ mode: 'fan-out', contractCommit: 'C0', parts: [part(1), part(2)] }),
    'part ': work(1),
    integrate: { merged: [{ part: 1, branch: 'w1', ok: false, note: 'conflict' }, { part: 2, branch: 'w1', ok: false, note: 'conflict' }], fixes: [], checksPassed: true, checkOutput: '', cleanup: '' },
  })
  assert.ok(!run.labels.includes('review'))
  assert.equal(run.result.status, 'not-landed')
})

test('parallel: parts that declare the same file or directory are folded into one worker', async () => {
  const parts = [part(1), { ...part(2), files: ['./f1', 'f2'], tier: 'hard' }, part(3), { ...part(4), files: ['src/a/'] }, { ...part(5), files: ['src/a/x.ts', 'f2'] }]
  const run = await runWorkflow({ ...ARGS, parallel: true }, {
    build: build({ mode: 'fan-out', contractCommit: 'C0', parts }),
    'part 1': work(1), 'part 2': work(2),
    integrate: { merged: [{ part: 1, branch: 'w1', ok: true, note: '' }, { part: 2, branch: 'w2', ok: true, note: '' }], fixes: [], checksPassed: true, checkOutput: '', cleanup: '' },
    review,
  })
  // 1+2 share f1; 4+5 share src/a/; 5 also shares f2 with the 1+2 group, so all four end up in one part. 3 stays alone.
  assert.deepEqual(run.labels, ['build', 'part 1 (hard)', 'part 2 (standard)', 'integrate', 'review'])
  assert.match(run.prompt('part 1'), /Goal: g1; then: g2; then: g4; then: g5/)
  assert.match(run.prompt('part 1'), /Files you own: f1, \.\/f1, f2, src\/a\/, src\/a\/x\.ts/)
  assert.match(run.prompt('part 2'), /Goal: g3\n/)
  assert.ok(run.logs.some(line => /3 part\(s\) shared files .* 2 worker\(s\)/.test(line)))
  assert.equal(run.result.status, 'done')
})
