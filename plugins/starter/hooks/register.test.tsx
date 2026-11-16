import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'starter',
  component: 'Pane',
  requestId: 'phase',
  props: { title: 'Phase', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const BY = { plugin: 'starter', tier: 'user' } as const
// On Windows the harness hands $.fs paths in Windows form, so every path is compared normalised.
const ROOT = 'C:\\work\\proj'
const KEY = 'plan:c:/work/proj'
const PLAN = 'c:/work/proj/docs/plans/rate-limiter.md'
const win = (rel: string, root = ROOT) => `${root}\\${rel.replace(/\//g, '\\')}`
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, d => d.toLowerCase())
const NONE = 'No cycle running. Start one with /starter:cycle <work>'

const PHASES = ['gather', 'plan', 'plan-review', 'build', 'code-review', 'probe', 'done']
const EVIDENCE: Record<string, string> = {
  gather: '3 decisions',
  plan: 'docs/plans/rate-limiter.md',
  'plan-review': '2 found, 2 settled',
  build: '7 items built',
  'code-review': '1 found, settled',
  probe: 'all checks pass',
}
const TITLES = ['Gather', 'Plan', 'Plan review', 'Build', 'Code review', 'Probe', 'Done']
const NEXT = [
  'plan · plan review · build · code review · probe',
  'plan review · build · code review · probe',
  'build · code review · probe',
  'code review · probe',
  'probe',
]
const ITEMS = ['- [x] 1. one', '- [x] 2. two', '- [x] 3. three', '- [ ] 4. four', '- [ ] 5. five', '- [ ] 6. six', '- [ ] 7. seven']
const logFor = (phase: string) => PHASES.slice(0, PHASES.indexOf(phase)).map(p => `- ${p}: ${EVIDENCE[p]}`)
const planText = (front: Record<string, string> = {}, items = ITEMS, log = logFor(front.phase ?? 'build')) =>
  [
    '---',
    ...Object.entries({ cycle: 'rate-limiter', phase: 'build', branch: 'cycle/rate-limiter', ...front }).map(([k, v]) => `${k}: ${v}`),
    '---',
    '',
    '# Rate limiter',
    '',
    '## Items',
    '',
    ...items,
    '',
    '## Log',
    '',
    ...log,
    '',
  ].join('\n')

const spawn = (tool_use_id: string, subagentType: string, model?: string) => ({
  tool_use_id, prompt: 'p', description: `task ${tool_use_id}`, subagentType, model, provider: BY,
  parentModel: 'opus', background: true, fork: false,
})
const complete = (agentId: string | undefined, reason: 'answer' | 'error' = 'answer') => ({
  answer: '', durationMs: 1, isAborted: false, turnId: `t-${agentId}`, agentId, reason,
})
const COMMAND = { command: 'phase', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const edit = (file_path: string, agentId?: string) => ({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b', agentId }) as const

// The engine beneath the plugin: a clock, a store, panes that open and close, and files by normalised path.
function world(on: On, entries: Record<string, unknown> = {}, root = ROOT, withClock = true) {
  const time = withClock ? mock.clock(on, { now: 1000 }) : undefined
  const store = new Map<string, unknown>(Object.entries(entries))
  const broken = { store: false }
  on('store.get', (_, e) => {
    if (broken.store) throw new Error('disk gone')
    return { value: store.get(e.key) }
  })
  on('store.set', (_, e) => {
    if (broken.store) throw new Error('disk full')
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  const files = new Map<string, string>()
  const definitions = new Map<string, string>()
  const unreadable = new Set<string>()
  const seen = { call: '' }
  const reads: string[] = []
  const panes: string[] = []
  const where = { root }
  on('session.root', () => ({ value: where.root }))
  on('fs.read', (_, e) => {
    const path = norm(e.path)
    reads.push(path)
    const name = path.split('/').pop()!
    if (unreadable.has(name)) throw new Error('busy')
    const text = path.includes('/agents/') ? definitions.get(name) : files.get(path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.list', (_, e) => {
    const dir = norm(e.path)
    const names = dir.endsWith('/docs/plans')
      ? [...files.keys()].filter(f => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes('/')).map(f => f.slice(dir.length + 1))
      : [...definitions.keys()]
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('ui.open', (_, e) => {
    if (!panes.includes(e.id)) panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    panes.splice(0, panes.length, ...panes.filter(id => id !== e.id))
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: panes.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'phase' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_, e) => {
    seen.call = e.tool_use_id
    return { result: {} }
  })
  files.set(PLAN, planText())
  return { time: time!, files, definitions, unreadable, panes, store, broken, reads, where, call: () => seen.call }
}

async function start($: Engine, time: ReturnType<typeof mock.clock>) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await time?.settle()
}

type Drawn = string | { type: string; props?: Record<string, unknown>; children?: unknown[] }
const flatText = (n: Drawn): string => (typeof n === 'string' ? n : (n.children ?? []).flat(Infinity).map(c => flatText(c as Drawn)).join(''))
const kidsOf = (n: Drawn) =>
  (typeof n === 'string' ? [] : (n.children ?? [])).flat(Infinity).filter((c): c is Drawn => c != null && c !== false) as Drawn[]
const widthOf = (lines: string[]) => Math.max(0, ...lines.map(l => l.length))
// A text rendering of the drawn tree: padding, width, gaps, flexGrow, space-between rows and truncate-end as the terminal lays them out; wrapping is not modelled.
function layout(n: Drawn, cols: number): string[] {
  if (typeof n === 'string' || n.type === 'Text') {
    const text = flatText(n)
    const cut = typeof n !== 'string' && n.props?.wrap === 'truncate-end' && text.length > cols
    return [cut ? `${text.slice(0, Math.max(0, cols - 1))}…` : text]
  }
  const p = n.props ?? {}
  const left = Number(p.paddingLeft ?? 0)
  const inner = cols - left
  const kids = kidsOf(n)
  const gap = Number(p.gap ?? p.columnGap ?? 0)
  let lines: string[]
  if (p.flexDirection === 'column') {
    lines = kids.flatMap((k, i) => [...(i > 0 ? Array<string>(gap).fill('') : []), ...layout(k, inner)])
  } else {
    const grown = kids.findIndex(k => typeof k !== 'string' && Number(k.props?.flexGrow) > 0)
    const cells = kids.map((k, i) => (i === grown ? [] : layout(k, inner)))
    const used = cells.reduce((sum, c) => sum + widthOf(c), 0) + gap * Math.max(0, kids.length - 1)
    const free = Math.max(0, inner - used)
    if (grown >= 0) cells[grown] = layout(kids[grown]!, free)
    const widths = cells.map((c, i) => (i === grown ? free : widthOf(c)))
    const spread = p.justifyContent === 'space-between' && grown < 0 && kids.length === 2 ? free : 0
    lines = Array.from({ length: Math.max(1, ...cells.map(c => c.length)) }, (_, y) =>
      cells.map((c, i) => (c[y] ?? '').padEnd(widths[i]!)).join(' '.repeat(gap + spread)),
    )
  }
  if (typeof p.width === 'number') lines = lines.map(l => l.padEnd(Number(p.width)))
  return left ? lines.map(l => ' '.repeat(left) + l) : lines
}

const mounted = (surface: 'terminal' | 'desktop', width: number) => ({ ...PANE, surface, props: { ...PANE.props, bodyColumns: width } })
async function screen($: Engine, width = 44, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount(mounted(surface, width))
  const lines = layout((await ui.drawn()) as Drawn, width).map(l => l.trimEnd())
  await ui.unmount()
  return lines
}
async function texts($: Engine, width = 44, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount(mounted(surface, width))
  const found: string[] = []
  for (const t of await ui.findAll({ type: 'Text' })) found.push(t.text ?? '')
  await ui.unmount()
  return found
}
const content = async ($: Engine, width = 44) => (await screen($, width)).filter(Boolean)

test('a stored plan is read by the contract: continuations, a backticked check, [X], CRLF and a BOM', async ($, on) => {
  const { time, files } = world(on, { [KEY]: PLAN, open: true })
  const items = [
    '- [x] 1. one, with a check',
    '  more of the text',
    '  check: `grep -q "- [x] 5." a && echo "## Log"`',
    '- [X] 2. two',
    '  - [x] 9. an indented line is not an item',
    '- [ ] 3. three',
  ]
  const text = planText({ phase: 'plan-review' }, items, ['- gather: 3 decisions', '- off: stopped at build'])
  files.set(PLAN, '\uFEFF' + text.replace(/\n/g, '\r\n'))

  await start($, time)

  expect(await content($)).toEqual([
    'rate-limiter'.padEnd(41) + '3/6',
    ' ━━●━━━━━━━●━━━━━━━◉╌╌╌╌╌╌╌○╌╌╌╌╌╌╌○╌╌╌╌╌╌╌○',
    ' gather  plan   review   build  review probe',
    ' ▍ Plan review',
    ' ▍ checks ███████████░░░░░ 2/3',
    ' off: stopped at build',
    ' ✓ gather  3 decisions',
    ' next: build · code review · probe',
  ])
})

test('a plan without a cycle key is no cycle plan: it is not shown, its stored key stays, and an edit to it opens nothing', async ($, on) => {
  const { time, files, panes, store } = world(on, { [KEY]: PLAN, open: false })
  files.set(PLAN, planText().replace('cycle: rate-limiter\n', ''))
  files.set('c:/work/proj/docs/plans/notes.md', '# notes\n\n## Items\n- [ ] 1. x\n')

  await start($, time)
  expect(store.has(KEY)).toBe(true)
  expect(await texts($)).toEqual([NONE])

  await $.tool.call(edit('C:\\work\\proj\\docs\\plans\\notes.md'))
  await $.tool.call(edit('C:\\work\\proj\\docs\\plans\\rate-limiter.md'))
  expect(panes).toEqual([])
  expect(await texts($)).toEqual([NONE])
})

test('one render per phase, done included', async ($, on) => {
  const { time, files, store } = world(on)
  const rule = (filled: number, running: boolean) =>
    ' ━━' + [0, 1, 2, 3, 4, 5].map(i => (i === 0 ? '' : i < filled || (i === filled && running) ? '━━━━━━━' : '╌╌╌╌╌╌╌') + (i < filled ? '●' : i === filled && running ? '◉' : '○')).join('')
  for (const [i, phase] of PHASES.entries()) {
    // A finished cycle is forgotten at start, so `done` is reached by the edit that finishes the open one.
    files.set(PLAN, planText({ phase: phase === 'done' ? 'probe' : phase }))
    store.set(KEY, PLAN)
    await start($, time)
    files.set(PLAN, planText({ phase }))
    await $.tool.call(edit('C:\\work\\proj\\docs\\plans\\rate-limiter.md'))
    const lines = await screen($)
    expect(lines[0]).toBe('rate-limiter'.padEnd(41) + `${Math.min(i + 1, 6)}/6`)
    expect(lines[2]).toBe(rule(i, phase !== 'done'))
    expect(lines.find(l => l.startsWith(' ▍'))).toBe(` ▍ ${TITLES[i]}`)
    expect(lines.filter(l => l.startsWith(' ✓'))).toHaveLength(i)
    expect(lines.filter(l => l.startsWith(' next:'))).toEqual(NEXT[i] ? [` next: ${NEXT[i]}`] : [])
    expect(lines.includes(' ▍ the cycle is done')).toBe(phase === 'done')
  }
})

const READER = ['---', 'model: opus', 'effort: medium', '---', ''].join(String.fromCharCode(10))
const WRITER = '---\nname: writer\nmodel: sonnet\neffort: high\n---\nbody effort: no'
const LIMITER = 'C:\\work\\proj\\src\\limiter.ts'
async function writer(on: On, $: Engine, entries: Record<string, unknown> = {}) {
  const w = world(on, { [KEY]: PLAN, ...entries })
  w.definitions.set('writer.md', WRITER)
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: 'a1' }))
  await start($, w.time)
  await $.agent.spawn(spawn('u1', 'starter:writer'))
  await $.tool.call(edit(LIMITER, 'a1'))
  await w.time.settle()
  await w.time.advance(252_000)
  return w
}

test('build with a writer running: the card shows its role, model, effort, time, tool and file', async ($, on) => {
  await writer(on, $)
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await screen($, 44, surface)).toEqual([
      'rate-limiter'.padEnd(41) + '4/6',
      '',
      ' ━━●━━━━━━━●━━━━━━━●━━━━━━━◉╌╌╌╌╌╌╌○╌╌╌╌╌╌╌○',
      ' gather  plan   review   build  review probe',
      '',
      ' ▍ Build'.padEnd(40) + '4:12',
      ' ▍ writer · Sonnet 5.5 · high',
      ' ▍ ⠹ Edit limiter.ts',
      ' ▍ checks ███████░░░░░░░░░ 3/7',
      '',
      ' ✓ plan review  2 found, 2 settled',
      ' ✓ plan         docs/plans/rate-limiter.md',
      ' ✓ gather       3 decisions',
      '',
      ' next: code review · probe',
    ])
  }
})


const PLAN_EDIT = win('docs/plans/rate-limiter.md')
const LIVE_NARROW = [
  'rate-limiter             4/6',
  '',
  ' ━━●━━━●━━━●━━━◉╌╌╌○╌╌╌○',
  '             build',
  '',
  ' ▍ Build                4:12',
  ' ▍ writer · Sonnet 5.5 · hi…',
  ' ▍ ⠹ Edit limiter.ts',
  ' ▍ checks ██████░░░░░░░░ 3/7',
  '',
  ' ✓ plan review  2 found, 2 …',
  ' ✓ plan         docs/plans/…',
  ' ✓ gather       3 decisions',
  '',
  ' next: code review · probe',
]

test('the build phase at a narrow width keeps the stations and names only the running phase', async ($, on) => {
  await writer(on, $)

  expect(await screen($, 28)).toEqual(LIVE_NARROW)
})

test('plan review waiting for the user says so in place of the agent lines, at 44 columns and narrow', async ($, on) => {
  const w = world(on, { [KEY]: PLAN })
  w.files.set(PLAN, planText({ phase: 'plan-review', waiting: 'user' }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  await start($, w.time)
  await $.agent.spawn(spawn('u1', 'starter:reviewer'))
  await $.tool.call(edit(LIMITER, 'a1'))

  expect(await screen($, 44)).toEqual([
    'rate-limiter'.padEnd(41) + '3/6',
    '',
    ' ━━●━━━━━━━●━━━━━━━◉╌╌╌╌╌╌╌○╌╌╌╌╌╌╌○╌╌╌╌╌╌╌○',
    ' gather  plan   review   build  review probe',
    '',
    ' ▍ Plan review',
    ' ▍ waiting for you',
    ' ▍ checks ███████░░░░░░░░░ 3/7',
    '',
    ' ✓ plan    docs/plans/rate-limiter.md',
    ' ✓ gather  3 decisions',
    '',
    ' next: build · code review · probe',
  ])
  expect(await screen($, 28)).toEqual([
    'rate-limiter             3/6',
    '',
    ' ━━●━━━●━━━◉╌╌╌○╌╌╌○╌╌╌○',
    '      plan review',
    '',
    ' ▍ Plan review',
    ' ▍ waiting for you',
    ' ▍ checks ██████░░░░░░░░ 3/7',
    '',
    ' ✓ plan    docs/plans/rate-…',
    ' ✓ gather  3 decisions',
    '',
    ' next: build · code review · probe',
  ])
})

test('stations are finished, running or pending in their own colours, and the running label is bold', async ($, on) => {
  await writer(on, $)
  const ui = await $.ui.mount(mounted('terminal', 44))
  const props = async (text: string) => (await ui.findAll({ type: 'Text', text })).map(t => t.props)

  expect(await props('●')).toMatchObject([{ color: 'success' }, { color: 'success' }, { color: 'success' }])
  expect(await props('◉')).toMatchObject([{ color: 'claude' }])
  expect(await props('○')).toMatchObject([{ dimColor: true }, { dimColor: true }])
  expect((await props('build'))[0]).toMatchObject({ weight: 'bold' })
  expect((await props('probe'))[0]).toMatchObject({ dimColor: true })
  await ui.unmount()
})

test('the writer line is gone when the writer ends, and the card keeps the phase and the checks', async ($, on) => {
  await writer(on, $)
  await $.turn.complete(complete('a1'))

  expect((await screen($, 44)).slice(5, 8)).toEqual([' ▍ Build', ' ▍ checks ███████░░░░░░░░░ 3/7', ''])
})

test('with no plan the pane is one dim line naming /starter:cycle', async ($, on) => {
  const w = world(on)
  w.files.clear()
  await start($, w.time)

  expect(await texts($)).toEqual([NONE])
  const ui = await $.ui.mount(mounted('terminal', 44))
  expect((await ui.find({ type: 'Text' }))?.props).toMatchObject({ dimColor: true })
  await ui.unmount()
})

test("another project's stored plan is not shown, and this project's own is", async ($, on) => {
  const other = 'c:/other/work/docs/plans/rate-limiter.md'
  const w = world(on, { 'plan:c:/other/work': other, open: true })
  w.files.clear()
  w.files.set(other, planText())
  await start($, w.time)

  expect(await texts($)).toEqual([NONE])
  expect(w.store.get('plan:c:/other/work')).toBe(other)

  w.files.set(PLAN, planText())
  w.store.set(KEY, PLAN)
  await start($, w.time)
  expect((await texts($))[0]).toBe('rate-limiter')
})

test('a stored plan that parses as done is forgotten at start; one whose file cannot be read is kept', async ($, on) => {
  const w = world(on, { [KEY]: PLAN })
  w.files.set(PLAN, planText({ phase: 'done' }))
  await start($, w.time)
  expect(w.store.has(KEY)).toBe(false)
  expect(await texts($)).toEqual([NONE])

  w.store.set(KEY, PLAN)
  w.files.delete(PLAN)
  await start($, w.time)
  expect(w.store.get(KEY)).toBe(PLAN)
  expect(await texts($)).toEqual([NONE])
})

test('/phase opens the pane and closes it when it is open, and a later session reopens it while it was left open', async ($, on) => {
  const w = world(on)
  await start($, w.time)
  expect(w.panes).toEqual([])

  expect((await $.command.run({ ...COMMAND, args: '' })).text).toBe('Phase pane opened.')
  expect(w.panes).toEqual(['phase'])
  expect(w.store.get('open:c:/work/proj')).toBe(true)

  w.panes.length = 0
  await start($, w.time)
  expect(w.panes).toEqual(['phase'])

  expect((await $.command.run({ ...COMMAND, args: '' })).text).toBe('Phase pane closed.')
  expect(w.panes).toEqual([])
  expect(w.store.has('open:c:/work/proj')).toBe(false)

  await start($, w.time)
  expect(w.panes).toEqual([])
})

test('an Edit, Write or MultiEdit that leaves a cycle plan under docs/plans opens the pane and stores the plan for this root', async ($, on) => {
  const w = world(on)
  w.files.clear()
  await start($, w.time)

  // Not a plan: no cycle key, a finished cycle, another folder, another suffix.
  w.files.set('c:/work/proj/docs/plans/notes.md', '# notes\n')
  w.files.set('c:/work/proj/docs/plans/old.md', planText({ phase: 'done' }))
  w.files.set('c:/work/proj/docs/other.md', planText())
  w.files.set('c:/work/proj/docs/plans/plan.txt', planText())
  for (const file of ['docs/plans/notes.md', 'docs/plans/old.md', 'docs/other.md', 'docs/plans/plan.txt']) await $.tool.call(edit(win(file)))
  await $.tool.call({ tool: 'Read', file_path: PLAN_EDIT })
  expect(w.panes).toEqual([])
  expect(w.store.get(KEY)).toBeUndefined()

  // A subagent's Write counts the same.
  w.files.set(PLAN, planText())
  await $.tool.call({ tool: 'Write', file_path: PLAN_EDIT, content: 'x', agentId: 'a1' })
  expect(w.panes).toEqual(['phase'])
  expect(w.store.get(KEY)).toBe(PLAN)
  expect((await texts($))[0]).toBe('rate-limiter')

  // MultiEdit is not in this build's tool table, so it is compared by name.
  w.files.set(PLAN, planText({ phase: 'code-review' }, ITEMS.map(i => i.replace('[ ]', '[x]'))))
  await $.tool.call({ tool: 'MultiEdit', file_path: PLAN_EDIT, edits: [] } as never)
  expect((await content($))[3]).toBe(' ▍ Code review')
  expect((await content($)).find(l => l.includes('checks'))).toBe(' ▍ checks ████████████████ 7/7')
})

test('the plan is read again at the start and end of a turn, so an edit made outside Claude shows up', async ($, on) => {
  const w = world(on, { [KEY]: PLAN })
  await start($, w.time)
  const checks = async () => (await content($)).find(l => l.includes('checks'))
  expect(await checks()).toBe(' ▍ checks ███████░░░░░░░░░ 3/7')

  w.files.set(PLAN, planText({}, ITEMS.map((item, i) => (i < 5 ? item.replace('[ ]', '[x]') : item))))
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(await checks()).toBe(' ▍ checks ███████████░░░░░ 5/7')

  w.files.set(PLAN, planText({}, ITEMS.map(item => item.replace('[ ]', '[x]'))))
  await $.turn.complete(complete(undefined))
  expect(await checks()).toBe(' ▍ checks ████████████████ 7/7')
})

test('a failed read, a file that no longer parses and a store error leave the last good state and throw nowhere', async ($, on) => {
  const w = world(on, { [KEY]: PLAN })
  await start($, w.time)

  w.files.delete(PLAN)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(edit(PLAN_EDIT))
  expect((await texts($))[0]).toBe('rate-limiter')

  w.files.set(PLAN, '---\nphase: build\n---\n')
  await $.turn.complete(complete(undefined))
  expect((await texts($))[0]).toBe('rate-limiter')
  w.files.set(PLAN, planText({ phase: 'nonsense' }))
  await $.turn.start({ text: 'go', turnId: 't2' })
  expect((await texts($))[0]).toBe('rate-limiter')

  w.files.set(PLAN, planText())
  w.broken.store = true
  await $.tool.call(edit(PLAN_EDIT))
  await $.command.run({ ...COMMAND, args: '' })
  await start($, w.time)
  expect((await texts($))[0]).toBe('rate-limiter')
})

const agentLine = async ($: Engine) => (await screen($)).find(l => l.startsWith(' ▍ ') && l.includes(' · '))

test('the agent line shows the explicit effort, else the role pin, and a failed definition read is retried on the next spawn', async ($, on) => {
  const w = world(on, { [KEY]: PLAN })
  w.definitions.set('writer.md', WRITER)
  w.definitions.set('reader.md', READER)
  w.unreadable.add('reader.md')
  let n = 0
  on('agent.spawn', (_, e) => ({ model: e.model === 'opus' ? 'claude-opus-5-5' : 'claude-sonnet-5-5', agentId: `a${++n}` }))
  await start($, w.time)
  let turns = 0
  // The card shows only the agent of the phase's role, so each run sets the phase it belongs to.
  const run = async (type: string, phase: string, model?: string) => {
    w.files.set(PLAN, planText({ phase }))
    await $.turn.start({ text: 'go', turnId: `t${++turns}` })
    await $.agent.spawn(spawn(w.call(), type, model))
    const line = await agentLine($)
    await $.turn.complete(complete(`a${n}`))
    return line
  }

  expect(await run('starter:writer', 'build')).toBe(' ▍ writer · Sonnet 5.5 · high')
  expect(await run('starter:reviewer', 'plan-review', 'opus')).toBe(' ▍ reviewer · Opus 5.5')
  // reader.md cannot be read yet, so its pin is unknown; the read is tried again at the next spawn.
  expect(await run('starter:reader', 'gather', 'opus')).toBe(' ▍ reader · Opus 5.5')
  w.unreadable.clear()
  expect(await run('starter:reader', 'gather', 'opus')).toBe(' ▍ reader · Opus 5.5 · medium')

  await $.tool.call({ tool: 'Agent', subagent_type: 'starter:reader', model: 'opus', effort: 'max', description: 'd', prompt: 'p' })
  expect(await run('starter:reader', 'gather', 'opus')).toBe(' ▍ reader · Opus 5.5 · max')
})

test('a Bash target is the program and one plain word, never the rest of the command', async ($, on) => {
  const w = world(on, { [KEY]: PLAN })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'a1' }))
  await start($, w.time)
  await $.agent.spawn(spawn('u1', 'starter:writer'))
  const shown = async () => {
    await w.time.settle()
    return (await screen($)).find(l => /^ ▍ \S+ Bash/.test(l))
  }
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command, agentId: 'a1' })

  await bash('git push https://user:ghp_s3cretT0ken@github.com/o/r.git main')
  expect(await shown()).toMatch(/Bash git push$/)
  await bash('curl -H "Authorization: Bearer ghp_s3cretT0ken" https://api.example.com')
  expect(await shown()).toMatch(/Bash curl$/)
  await bash('GITHUB_TOKEN=ghp_s3cretT0ken ./deploy.sh prod')
  expect(await shown()).toMatch(/Bash deploy.sh prod$/)
  expect((await screen($)).some(line => line.includes('ghp_'))).toBe(false)
})

test('a denied or rejected spawn leaves no agent line, and a turn that ends before its spawn settles still clears it', async ($, on) => {
  const w = world(on, { [KEY]: PLAN })
  on('agent.spawn', async (_, e) => {
    if (e.prompt === 'deny') return { deny: 'no' }
    if (e.prompt === 'throw') throw new Error('spawn failed')
    await w.time.sleep(10)
    return { model: 'claude-sonnet-5-5', agentId: 'a1' }
  })
  await start($, w.time)
  const lines = async () => (await screen($)).filter(l => l.startsWith(' ▍ ') && !l.includes('checks') && !l.includes('Build'))

  await $.agent.spawn({ ...spawn('u1', 'starter:writer'), prompt: 'deny' })
  await $.agent.spawn({ ...spawn('u2', 'starter:writer'), prompt: 'throw' }).catch(() => undefined)
  expect(await lines()).toEqual([])

  const spawning = $.agent.spawn(spawn('u3', 'starter:writer'))
  await w.time.settle()
  expect(await lines()).toEqual([' ▍ writer · …', ' ▍ ⠼ starting'])
  await $.turn.complete(complete('a1'))
  await w.time.advance(10)
  await spawning
  expect(await lines()).toEqual([])
})

test('a resumed agent shows again from zero, and its end clears it', async ($, on) => {
  const w = world(on, { [KEY]: PLAN })
  on('agent.spawn', (_, e) => ({ model: 'claude-sonnet-5-5', agentId: e.resume?.agentId ?? 'a1' }))
  await start($, w.time)
  const title = async () => (await screen($))[5]

  await $.agent.spawn(spawn('u1', 'starter:writer'))
  await $.turn.complete(complete('a1'))
  await w.time.advance(5000)
  await $.agent.spawn({ ...spawn('u2', 'starter:writer'), resume: { agentId: 'a1' } })
  expect(await title()).toBe(' ▍ Build'.padEnd(40) + '0:00')
  await w.time.advance(2000)
  expect(await title()).toBe(' ▍ Build'.padEnd(40) + '0:02')
  await $.turn.complete(complete('a1'))
  expect(await title()).toBe(' ▍ Build')
})

test('an agent whose clock reads before its start draws 0:00 instead of throwing', async ($, on) => {
  let t = 5000
  const w = world(on, { [KEY]: PLAN }, ROOT, false)
  on('clock.now', () => ({ value: t }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))
  await start($, w.time)

  await $.agent.spawn(spawn('u1', 'starter:writer'))
  t = 2000

  expect((await screen($))[5]).toBe(' ▍ Build'.padEnd(40) + '0:00')
})

// Every card is a row of a rail column of ▍ and a body column.
const railed = (n: Drawn): number[][] => {
  const [rail, body] = kidsOf(n)
  const isCard = rail && body && typeof rail !== 'string' && rail.type === 'Box' && kidsOf(rail).length > 0 && kidsOf(rail).every(k => flatText(k) === '▍')
  const own = isCard ? [[kidsOf(rail).length, kidsOf(body).length, ...kidsOf(body).map(k => layout(k, 44).length)]] : []
  return [...own, ...kidsOf(n).flatMap(railed)]
}
const SURFACES = ['terminal', 'desktop'] as const

test("the card's rail has one ▍ per body line, and every body line is one row", async ($, on) => {
  await writer(on, $)
  const expected = [4]

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(mounted(surface, 44))
    const cards = railed((await ui.drawn()) as Drawn)
    await ui.unmount()
    expect(cards.map(([rail]) => rail)).toEqual(expected)
    for (const [rail, body, ...rows] of cards) {
      expect(body).toBe(rail)
      expect(rows).toEqual(Array(rail).fill(1))
    }
  }
})

test('no drawn text starts or ends with whitespace or holds two spaces in a row, and no box has a border', async ($, on) => {
  await writer(on, $)
  const bordered = (n: Drawn): boolean => typeof n !== 'string' && (n.props?.borderStyle !== undefined || kidsOf(n).some(bordered))

  for (const surface of SURFACES) {
    for (const width of [44, 28]) {
      const found = await texts($, width, surface)
      expect(found).toContain('writer · Sonnet 5.5 · high')
      expect(found.filter(t => /^\s|\s$|\s{2}/.test(t))).toEqual([])
      const ui = await $.ui.mount(mounted(surface, width))
      expect(bordered((await ui.drawn()) as Drawn)).toBe(false)
      await ui.unmount()
    }
  }
})

// Review fix 1: a plan edited by a path in another valid form.
test('a plan path as ./relative, in another letter case or with .. is recognised, and one outside the root is ignored', async ($, on) => {
  const w = world(on)
  w.files.clear()
  await start($, w.time)

  const outside = [win('../other/docs/plans/d.md'), win('docs/plans/d.md', `${ROOT}2`), win('../docs/plans/d.md'), win('docs/plans/../../x.md')]
  for (const file of ['c:/work/other/docs/plans/d.md', 'c:/work/proj2/docs/plans/d.md', 'c:/work/docs/plans/d.md', 'c:/work/proj/x.md']) w.files.set(file, planText())
  for (const file of outside) await $.tool.call(edit(file))
  expect(w.panes).toEqual([])
  expect(w.store.get(KEY)).toBeUndefined()

  const mixed = ROOT.replace('work', 'Work').replace('proj', 'Proj')
  const forms: [string, string][] = [
    ['./docs/plans/a.md', 'a'],
    [win('docs/plans/b.md', mixed), 'b'],
    [win('src/../docs/plans/c.md'), 'c'],
  ]
  for (const [file, name] of forms) {
    w.files.set(`c:/work/proj/docs/plans/${name}.md`, planText({ cycle: name }))
    w.panes.length = 0
    await $.tool.call(edit(file))
    expect(w.panes).toEqual(['phase'])
    expect(w.store.get(KEY)).toBe(`c:/work/proj/docs/plans/${name}.md`)
    expect((await texts($))[0]).toBe(name)
  }
})

// Review fix 2: finding a cycle that no edit of this session has touched.
const PLANS = 'c:/work/proj/docs/plans'

test('with no stored plan the first open cycle plan in docs/plans is found at start, in name order, and nothing is stored', async ($, on) => {
  const w = world(on)
  w.files.clear()
  w.files.set(`${PLANS}/d.md`, planText({ cycle: 'dee' }))
  w.files.set(`${PLANS}/c.md`, planText({ cycle: 'cee' }))
  w.files.set(`${PLANS}/b.md`, planText({ cycle: 'bee', phase: 'done' }))
  w.files.set(`${PLANS}/a.md`, '# no cycle key\n')
  await start($, w.time)

  expect((await texts($))[0]).toBe('cee')
  expect(w.store.get(KEY)).toBeUndefined()
})

test('a stored plan whose file cannot be read keeps its key, and the listing is used meanwhile', async ($, on) => {
  const gone = `${PLANS}/gone.md`
  const w = world(on, { [KEY]: gone })
  w.files.clear()
  w.files.set(`${PLANS}/c.md`, planText({ cycle: 'cee' }))
  await start($, w.time)

  expect((await texts($))[0]).toBe('cee')
  expect(w.store.get(KEY)).toBe(gone)
})

test('at most 50 plan files are read, in name order', async ($, on) => {
  const w = world(on)
  w.files.clear()
  for (let i = 54; i >= 0; i--) w.files.set(`${PLANS}/f${String(i).padStart(2, '0')}.md`, '# notes\n')
  w.files.set(`${PLANS}/zz.md`, planText({ cycle: 'late' }))
  await start($, w.time)

  expect(w.reads.filter(path => path.startsWith(`${PLANS}/`))).toEqual(Array.from({ length: 50 }, (_, i) => `${PLANS}/f${String(i).padStart(2, '0')}.md`))
  expect(await texts($)).toEqual([NONE])
})

test('with no cycle loaded, /phase looks for one', async ($, on) => {
  const w = world(on)
  w.files.clear()
  await start($, w.time)
  expect(await texts($)).toEqual([NONE])

  w.files.set(`${PLANS}/c.md`, planText({ cycle: 'cee' }))
  await $.command.run({ ...COMMAND, args: '' })
  expect((await texts($))[0]).toBe('cee')

})

test('with no cycle loaded, the start of a main-session turn looks for one', async ($, on) => {
  const w = world(on)
  w.files.clear()
  await start($, w.time)
  w.files.set(`${PLANS}/c.md`, planText({ cycle: 'cee' }))

  await $.turn.start({ text: 'go', turnId: 't1', agentId: 'a1' })
  expect(await texts($)).toEqual([NONE])
  await $.turn.start({ text: 'go', turnId: 't2' })
  expect((await texts($))[0]).toBe('cee')
})

// Review fix 3: a fenced block holds examples.
test('headings, items and log lines inside a fenced block are not the plan', async ($, on) => {
  const w = world(on, { [KEY]: PLAN })
  const fence = '`'.repeat(3)
  const items = ['- [x] 1. one', `${fence}md`, '## Log', '- [ ] 2. an example', '- fake: line', fence, '- [ ] 3. three']
  w.files.set(PLAN, planText({ phase: 'plan-review' }, items, ['- gather: 3 decisions', fence, '- fake: line', fence]))
  await start($, w.time)

  const lines = await content($)
  expect(lines.find(l => l.includes('checks'))).toBe(' ▍ checks ████████░░░░░░░░ 1/2')
  expect(lines.filter(l => l.includes('fake'))).toEqual([])
  expect(lines.filter(l => l.startsWith(' ✓'))).toEqual([' ✓ gather  3 decisions'])
})

// Review fix 4: the card shows an agent of the phase's role only.
test('the card shows the newest running agent of the phase role, and none when there is none', async ($, on) => {
  const w = world(on, { [KEY]: PLAN })
  let n = 0
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'claude-sonnet-5-5', agentId: `a${++n}` }))
  await start($, w.time)
  const card = async () => (await screen($)).filter(l => l.startsWith(' ▍ ') && !l.includes('checks'))

  await $.agent.spawn(spawn('u1', 'starter:writer'))
  await $.agent.spawn(spawn('u2', 'Explore', 'haiku'))
  expect((await card())[1]).toBe(' ▍ writer · Sonnet 5.5')

  // The phase moves on while the writer still runs: a writer is not the code reviewer.
  w.files.set(PLAN, planText({ phase: 'code-review' }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(await card()).toEqual([' ▍ Code review'])

  await $.agent.spawn(spawn('u3', 'starter:reviewer', 'opus'))
  expect((await card())[1]).toBe(' ▍ reviewer · Opus')
})

test('at most 20 running agents are tracked, the oldest dropped first', async ($, on) => {
  const w = world(on, { [KEY]: PLAN })
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `a${++n}` }))
  await start($, w.time)
  const writerShown = async () => (await screen($)).some(l => l.startsWith(' ▍ writer'))

  await $.agent.spawn(spawn('u0', 'starter:writer'))
  for (let i = 1; i < 20; i++) await $.agent.spawn(spawn(`u${i}`, 'Explore'))
  expect(await writerShown()).toBe(true)
  await $.agent.spawn(spawn('u20', 'Explore'))
  expect(await writerShown()).toBe(false)
})

// Review fix 5: the pane opens by itself only for a plan that becomes the open cycle, and its flag is per root.
test('a pane the person closed stays closed when the open plan is edited again', async ($, on) => {
  const w = world(on, { [KEY]: PLAN })
  await start($, w.time)
  await $.command.run({ ...COMMAND, args: '' })
  await $.command.run({ ...COMMAND, args: '' })
  expect(w.panes).toEqual([])

  await $.tool.call(edit(PLAN_EDIT))
  await $.tool.call(edit(PLAN_EDIT))
  expect(w.panes).toEqual([])
  expect(w.store.has('open:c:/work/proj')).toBe(false)
  expect(w.store.has('open')).toBe(false)
})

test('the open flag is per project root, needs a loaded cycle, and the old global flag is handed to one root and removed', async ($, on) => {
  const other = 'c:/other/work/docs/plans/o.md'
  const w = world(on, { [KEY]: PLAN, 'plan:c:/other/work': other, open: true })
  w.files.set(other, planText({ cycle: 'other' }))

  await start($, w.time)
  expect(w.panes).toEqual(['phase'])
  expect(w.store.get('open:c:/work/proj')).toBe(true)
  expect(w.store.has('open')).toBe(false)

  // Another project: no flag of its own, so the pane stays closed, though its cycle is loaded.
  w.panes.length = 0
  w.where.root = 'C:\\other\\work'
  await start($, w.time)
  expect(w.panes).toEqual([])
  expect((await texts($))[0]).toBe('other')

  // The flag without a cycle opens nothing.
  w.where.root = ROOT
  w.files.clear()
  await start($, w.time)
  expect(w.store.get('open:c:/work/proj')).toBe(true)
  expect(w.panes).toEqual([])
})
