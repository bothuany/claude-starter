import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'starter',
  component: 'Pane',
  requestId: 'subagents',
  props: { title: 'Subagents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const BY = { plugin: 'starter', tier: 'user' } as const
const EMPTY_BAR = '░'.repeat(10)

const spawn = (tool_use_id: string, subagentType: string, model?: string) => ({
  tool_use_id, prompt: 'p', description: `task ${tool_use_id}`, subagentType, model, provider: BY,
  parentModel: 'opus', background: true, fork: false,
})
const complete = (agentId: string, reason: 'answer' | 'error', usage?: ReturnType<typeof tokens>, answer = '') => ({
  answer, durationMs: 1, isAborted: false, turnId: `t-${agentId}`, agentId, reason, usage,
})
const tokens = (model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, model,
})
const file = (name: string) => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })
const COMMAND = { command: 'subagents', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

function world(on: On) {
  const time = mock.clock(on, { now: 1000 })
  on('ui.panes', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))
  return time
}

function pins(on: On) {
  on('fs.list', () => ({ value: [file('writer.md'), file('locator.md')] }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('writer.md') ? '---\nname: x\nmodel: sonnet\neffort: high\n---\nbody effort: no' : '---\nmodel: haiku\n---\n' }))
}

function opens(on: On) {
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
}
const extended = ($: Engine) => $.command.run({ ...COMMAND, args: 'extended' })
const open = ($: Engine) => $.command.run({ ...COMMAND, args: '' })

async function step($: Engine, agentId: string | undefined, model: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model, messageCount: 1, agentId })
  let read = await stream.next()
  while (!read.done) read = await stream.next()
  return read.value
}

async function texts($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ ...PANE, surface })
  const found: string[] = []
  for (const t of await ui.findAll({ type: 'Text' })) found.push(t.text ?? '')
  await ui.unmount()
  return found
}

type Drawn = string | { type: string; props?: Record<string, unknown>; children?: unknown[] }
const flatText = (n: Drawn): string => (typeof n === 'string' ? n : (n.children ?? []).flat(Infinity).map(c => flatText(c as Drawn)).join(''))
const kidsOf = (n: Drawn) =>
  (typeof n === 'string' ? [] : (n.children ?? [])).flat(Infinity).filter((c): c is Drawn => c != null && c !== false) as Drawn[]
const widthOf = (lines: string[]) => Math.max(0, ...lines.map(l => l.length))
// A text rendering of the drawn tree: padding, gaps, flexGrow and space-between rows as the terminal lays them out; wrap and truncation are not modelled.
function layout(n: Drawn, cols: number): string[] {
  if (typeof n === 'string' || n.type === 'Text') return [flatText(n)]
  if (n.type === 'Button') return [`${n.props?.hotkey}: ${n.props?.label}`]
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
  return left ? lines.map(l => ' '.repeat(left) + l) : lines
}
async function screen($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ ...PANE, surface })
  const lines = layout((await ui.drawn()) as Drawn, 80).map(l => l.trimEnd())
  await ui.unmount()
  return lines
}
// The screen without blank rows and without the padding that right-aligns a time: any wider run of spaces reads as the 2-space gap.
const content = async ($: Engine) => (await screen($)).filter(Boolean).map(l => l.replace(/ {2,}/g, '  '))

test('the empty pane says no subagent has run', async ($, on) => {
  on('clock.now', () => ({ value: 1000 }))
  expect(await texts($)).toEqual(['No subagents have run yet in this session.'])
})

test('the pane stays closed until /subagents, then opens in later sessions', async ($, on) => {
  mock.store(on)
  const time = world(on)
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const start = async () => {
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await time.settle()
  }

  await start()
  expect(opened).toEqual([])

  const out = await $.command.run({ ...COMMAND, args: '' })
  expect(out.text).toBe('Subagents pane opened.')
  expect(opened).toEqual(['subagents'])

  await start()
  expect(opened).toEqual(['subagents', 'subagents'])
})

test('rows show the resolved model, the explicit effort else the role pin, and end with their outcome', async ($, on) => {
  let n = 0
  world(on)
  pins(on)
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'resolved', agentId: `a${++n}` }))
  let callId = ''
  on('tool.call', (_, e) => {
    callId = e.tool_use_id
    return { result: {} }
  })

  await $.agent.spawn(spawn('u1', 'starter:writer'))
  await $.agent.spawn(spawn('u2', 'starter:locator'))
  await $.agent.spawn(spawn('u3', 'general-purpose'))
  await $.agent.spawn(spawn('u4', 'starter:writer', 'opus'))
  await $.tool.call({ tool: 'Agent', subagent_type: 'starter:reader', model: 'opus', effort: 'max', description: 'd', prompt: 'p' })
  await $.agent.spawn(spawn(callId, 'starter:reader', 'opus'))
  await $.turn.complete(complete('a1', 'answer'))
  await $.turn.complete(complete('a2', 'error'))

  expect(await content($)).toEqual([
    'SUBAGENTS  3 running  m: extended',
    '▍ general-purpose  resolved  0:00', '▍ ⠼  starting', `▍ ${EMPTY_BAR}  0 tools`,
    '▍ writer  Opus · high  0:00', '▍ ⠴  starting', `▍ ${EMPTY_BAR}  0 tools`,
    '▍ reader  Opus · max  0:00', '▍ ⠦  starting', `▍ ${EMPTY_BAR}  0 tools`,
    '  ✗  locator  resolved · error  0:00',
    '  ✓  writer  resolved · high  0:00',
    'session 0 tok  3 running',
  ])
})

test('a failed definition read keeps the other pins and is read again on the next spawn', async ($, on) => {
  let n = 0
  let failures = 1
  world(on)
  on('fs.list', () => ({ value: [file('reader.md'), file('writer.md')] }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('reader.md') && failures-- > 0) throw new Error('busy')
    return { value: `---\neffort: ${e.path.endsWith('reader.md') ? 'medium' : 'high'}\n---\n` }
  })
  on('agent.spawn', () => ({ model: 'm', agentId: `a${++n}` }))

  await $.agent.spawn(spawn('u1', 'starter:writer'))
  await $.agent.spawn(spawn('u2', 'starter:reader'))

  expect((await content($)).filter(line => / m · /.test(line))).toEqual(['▍ writer  m · high  0:00', '▍ reader  m · medium  0:00'])
})

test('a turn.complete that arrives before the spawn settles still closes the row', async ($, on) => {
  const time = world(on)
  on('agent.spawn', async () => {
    await time.sleep(10)
    return { model: 'm', agentId: 'a1' }
  })

  const spawning = $.agent.spawn(spawn('u1', 'general-purpose'))
  await time.settle()
  await $.turn.complete(complete('a1', 'answer'))
  await time.advance(10)
  await spawning

  expect(await content($)).toEqual(['SUBAGENTS  0 running  m: extended', '  ✓  general-purpose  m  0:00', 'session 0 tok  0 running'])
})

test('a resumed subagent reuses its row, and a denied resume leaves it finished', async ($, on) => {
  const time = world(on)
  on('agent.spawn', (_, e) => (e.prompt === 'no' ? { deny: 'no' } : { model: 'm', agentId: e.resume?.agentId ?? 'a1' }))

  await $.agent.spawn(spawn('u1', 'general-purpose'))
  await $.turn.complete(complete('a1', 'answer'))
  await time.advance(5000)
  await $.agent.spawn({ ...spawn('u2', 'general-purpose'), resume: { agentId: 'a1' } })
  expect(await content($)).toEqual([
    'SUBAGENTS  1 running  m: extended',
    '▍ general-purpose  m  0:00', '▍ ⠼  starting', `▍ ${EMPTY_BAR}  0 tools`,
    'session 0 tok  1 running',
  ])

  await time.advance(2000)
  await $.turn.complete(complete('a1', 'answer'))
  const finished = ['SUBAGENTS  0 running  m: extended', '  ✓  general-purpose  m  0:02', 'session 0 tok  0 running']
  expect(await content($)).toEqual(finished)

  await $.agent.spawn({ ...spawn('u3', 'general-purpose'), prompt: 'no', resume: { agentId: 'a1' } }).catch(() => undefined)
  expect(await content($)).toEqual(finished)
})

test('a spawn whose next rejects leaves no row running', async ($, on) => {
  world(on)
  on('agent.spawn', () => {
    throw new Error('spawn failed')
  })

  await $.agent.spawn(spawn('u1', 'general-purpose')).catch(() => undefined)

  expect(await texts($)).toEqual(['No subagents have run yet in this session.'])
})

test('at most 20 subagents show as running, the oldest dropped first', async ($, on) => {
  let n = 0
  world(on)
  on('agent.spawn', () => ({ model: 'm', agentId: `a${++n}` }))

  for (let i = 1; i <= 22; i++) await $.agent.spawn(spawn(`u${i}`, `t${i}`))

  const roles = (await content($)).flatMap(line => /^▍ \S+  m  0:00$/.test(line) ? [line.split(' ')[1]] : [])
  expect(roles).toEqual(Array.from({ length: 20 }, (_, i) => `t${i + 3}`))
})

test('only the last 10 finished subagents stay in Recent', async ($, on) => {
  let n = 0
  world(on)
  on('agent.spawn', () => ({ model: 'm', agentId: `a${++n}` }))

  for (let i = 1; i <= 12; i++) {
    await $.agent.spawn(spawn(`u${i}`, `t${i}`))
    await $.turn.complete(complete(`a${i}`, 'answer'))
  }

  const lines = await content($)
  expect(lines[0]).toBe('SUBAGENTS  0 running  m: extended')
  const roles = lines.flatMap(line => /^ {2}✓ {2}(\S+)/.exec(line)?.[1] ?? [])
  expect(roles).toEqual(Array.from({ length: 10 }, (_, i) => `t${12 - i}`))
})

test('compact shows the current tool and its target for a running agent, and its running tokens', async ($, on) => {
  const time = world(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'a1' }))
  on('tool.call', () => ({ result: {} }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: tokens('claude-sonnet-5-5', 1000, 1000, 10_000, 1000) }
  })
  opens(on)

  await open($)
  await $.agent.spawn(spawn('u1', 'general-purpose'))
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/ClassReservationService.cs', agentId: 'a1' })
  await $.tool.call({ tool: 'Bash', command: 'dotnet test   --filter RC09\n  --no-build --verbosity quiet --logger trx', agentId: 'a1' })
  await step($, 'a1', 'claude-sonnet-5-5')
  await time.advance(2000)

  expect((await content($)).slice(1, 4)).toEqual(['▍ general-purpose  Sonnet  0:02', '▍ ⠹  Bash  dotnet test', '▍ ██████████  2 tools · 3k tok · $0.02 est.'])
})

test('a Bash target is the program and one plain word, never the rest of the command', async ($, on) => {
  const time = world(on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))
  on('tool.call', () => ({ result: {} }))
  opens(on)
  const shown = async () => (await content($)).find(line => /^▍ \S {2}Bash/.test(line))

  await open($)
  await $.agent.spawn(spawn('u1', 'general-purpose'))
  await $.tool.call({ tool: 'Bash', command: 'git push https://user:ghp_s3cretT0ken@github.com/o/r.git main', agentId: 'a1' })
  await time.settle()
  expect(await shown()).toMatch(/Bash {2}git push$/)

  await $.tool.call({ tool: 'Bash', command: 'curl -H "Authorization: Bearer ghp_s3cretT0ken" https://api.example.com', agentId: 'a1' })
  await time.settle()
  expect(await shown()).toMatch(/Bash {2}curl$/)

  await $.tool.call({ tool: 'Bash', command: 'GITHUB_TOKEN=ghp_s3cretT0ken ./deploy.sh prod', agentId: 'a1' })
  await time.settle()
  expect(await shown()).toMatch(/Bash {2}deploy.sh prod$/)
  expect((await screen($)).some(line => line.includes('ghp_'))).toBe(false)
})

test('with the pane never opened, a lead tool call and a model step pass through and leave $.state untouched', async ($, on) => {
  const touched: string[] = []
  on('state.get', (_, e, next) => {
    touched.push(`get ${e.key}`)
    return next(e)
  })
  on('state.set', (_, e, next) => {
    touched.push(`set ${e.key}`)
    return next(e)
  })
  const time = world(on)
  on('tool.call', () => ({ result: { stdout: 'ok' } }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: tokens('claude-opus-5-5', 1, 1) }
  })

  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })
  const stepped = await step($, undefined, 'claude-opus-5-5')
  await time.settle()

  expect(ran).toMatchObject({ result: { stdout: 'ok' } })
  expect(stepped).toMatchObject({ answer: 'hi', usage: { model: 'claude-opus-5-5' } })
  expect(touched).toEqual([])
})

function lanes(on: On) {
  let n = 0
  const time = world(on)
  pins(on)
  on('agent.spawn', (_, e) => ({ model: e.model ?? (e.subagentType.endsWith('locator') ? 'haiku' : 'sonnet'), agentId: `a${++n}` }))
  on('tool.call', () => ({ result: {} }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: 210_000, percent: 21 }, rateLimits: [], cost: { usd: 0.33 } } }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  opens(on)
  return time
}

test('every agent is a card in both modes, a finished one a single dim line, and extended adds the lead, lanes and events', async ($, on) => {
  const time = lanes(on)

  await open($)
  await step($, undefined, 'claude-opus-5-5')
  await $.agent.spawn(spawn('u1', 'starter:locator'))
  await time.advance(4000)
  await $.turn.complete(complete('a1', 'answer', tokens('claude-haiku-5-5', 1500, 500), 'Found 3 files.\nsrc/a.cs'))
  await $.agent.spawn(spawn('u2', 'starter:reader', 'opus'))
  await $.tool.call({ tool: 'Read', file_path: '/repo/RowLock.cs', agentId: 'a2' })
  await time.advance(3000)
  await $.agent.spawn(spawn('u3', 'starter:writer'))
  await $.tool.call({ tool: 'Edit', file_path: '/repo/TransferService.cs', old_string: 'a', new_string: 'b', agentId: 'a3' })
  await $.tool.call({ tool: 'Agent', subagent_type: 'starter:writer', description: 'd', prompt: 'p' })
  await time.advance(5000)
  await time.settle()

  expect(await content($)).toEqual([
    'SUBAGENTS  2 running  m: extended',
    '▍ reader  Opus  0:08', '▍ ⠹  Read  RowLock.cs', '▍ ██████████  1 tools',
    '▍ writer  Sonnet · high  0:05', '▍ ⠸  Edit  TransferService.cs', '▍ ██████▎░░░  1 tools',
    '  ✓  locator  Haiku  0:04 · 2k tok · $0.00 est.',
    'session 2k tok  $0.33 est.  lead ctx 21%  2 running',
  ])
  await extended($)

  expect(await content($)).toEqual([
    'SUBAGENTS  2 running  m: compact',
    'LEAD',
    '▍ Opus  ctx 21%', '▍ Agent',
    'READ  in parallel',
    '▍ reader  Opus  0:08', '▍ ⠹  Read  RowLock.cs', '▍ ██████████  1 tools',
    '  ✓  locator  Haiku  0:04 · 2k tok · $0.00 est.',
    'WRITE  own files each',
    '▍ writer  Sonnet · high  0:05', '▍ ⠹  Edit  TransferService.cs', '▍ ██████▎░░░  1 tools',
    'CHECK  fresh context', '  none this session',
    'EVENTS',
    '  lead → locator: task u1',
    '  locator done · 0:04 · 2k tok — Found 3 files.',
    '  lead → reader: task u2',
    '  lead → writer: task u3',
    'session 2k tok  $0.33 est.  2 running',
  ])

  await $.agent.spawn(spawn('u4', 'general-purpose'))
  const other = await content($)
  expect(other.slice(other.indexOf('  none this session') + 1, other.indexOf('  none this session') + 3)).toEqual(['OTHER', '▍ general-purpose  Sonnet  0:00'])
})

test('the duration bar is exactly 10 cells and the longest running agent fills it', async ($, on) => {
  const time = lanes(on)

  await $.agent.spawn(spawn('u1', 'starter:reader'))
  await time.advance(4000)
  await $.agent.spawn(spawn('u2', 'starter:reader'))
  await time.advance(2000)
  await $.agent.spawn(spawn('u3', 'starter:reader'))
  await time.advance(2000)

  for (const mode of ['compact', 'extended'] as const) {
    await $.command.run({ ...COMMAND, args: mode })
    const bars = (await content($)).flatMap(line => /^▍ ([█▏▎▍▌▋▊▉░]+) {2}/.exec(line)?.[1] ?? [])
    expect(bars.map(b => [...b].length)).toEqual([10, 10, 10])
    expect(bars).toEqual(['██████████', '█████░░░░░', '██▌░░░░░░░'])
  }
})

test('a finished agent is one line without a rail, in both modes', async ($, on) => {
  const time = lanes(on)
  await $.agent.spawn(spawn('u1', 'starter:locator'))
  await time.advance(4000)
  await $.turn.complete(complete('a1', 'answer', tokens('claude-haiku-5-5', 1500, 500)))

  // Extended draws the lead's own card, which is the one rail left.
  for (const [mode, rails] of [['compact', 0], ['extended', 1]] as const) {
    await $.command.run({ ...COMMAND, args: mode })
    const lines = await screen($)
    expect(lines.filter(line => line.includes('▍'))).toHaveLength(rails)
    expect(lines.filter(line => line.includes('✓'))).toHaveLength(1)
    expect(lines.find(line => line.includes('✓'))).toMatch(/^ {2}✓ {2}locator {2}Haiku +0:04 · 2k tok · \$0\.00 est\.$/)
  }
})

test('extended has no timeline section', async ($, on) => {
  const time = lanes(on)
  await $.agent.spawn(spawn('u1', 'starter:reader'))
  await time.advance(3000)

  await extended($)
  const lines = [...(await texts($)), ...(await texts($, 'desktop'))]
  expect(lines.some(line => /TIMELINE|▓/.test(line))).toBe(false)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  await ui.unmount()
})

test('cards are one blank row apart, in both modes', async ($, on) => {
  const time = lanes(on)
  await $.agent.spawn(spawn('u1', 'starter:reader'))
  await $.agent.spawn(spawn('u2', 'starter:reader'))
  await time.advance(1000)

  for (const mode of ['compact', 'extended'] as const) {
    await $.command.run({ ...COMMAND, args: mode })
    const lines = await screen($)
    const firsts = lines.flatMap((line, i) => (line.startsWith('▍ reader') ? [i] : []))
    expect(firsts).toHaveLength(2)
    expect(firsts[1]! - firsts[0]!).toBe(4)
    expect(lines[firsts[0]! + 3]).toBe('')
  }
})

test('a negative elapsed time draws an empty bar and 0:00 instead of throwing', async ($, on) => {
  let t = 5000
  on('clock.now', () => ({ value: t }))
  on('ui.panes', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))

  await $.agent.spawn(spawn('u1', 'general-purpose'))
  t = 2000

  expect((await content($)).slice(1, 4)).toEqual(['▍ general-purpose  m  0:00', '▍ ⠇  starting', `▍ ${EMPTY_BAR}  0 tools`])
})

test('a waiting card has no bar', async ($, on) => {
  const time = world(on)
  on('agent.spawn', async () => {
    await time.sleep(10)
    return { model: 'm', agentId: 'a1' }
  })

  const spawning = $.agent.spawn(spawn('u1', 'general-purpose'))
  await time.settle()
  expect(await content($)).toEqual(['SUBAGENTS  1 running  m: extended', '▍ general-purpose  …  0:00', '▍ waiting', 'session 0 tok  1 running'])

  await time.advance(10)
  await spawning
})

test("a failed agent's glyph keeps its error colour while the line stays dim", async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))
  await $.agent.spawn(spawn('u1', 'general-purpose'))
  await $.turn.complete(complete('a1', 'error'))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: '✗' }))?.props).toEqual({ color: 'error' })
  expect((await ui.find({ type: 'Text', text: 'general-purpose' }))?.props).toMatchObject({ dimColor: true })
  expect((await ui.find({ type: 'Text', text: 'm · error' }))?.props).toMatchObject({ dimColor: true })
  await ui.unmount()
})

test('/subagents extended is kept in the store, and the pane button switches back', async ($, on) => {
  const stored = new Map<string, unknown>()
  world(on)
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))
  await $.agent.spawn(spawn('u1', 'general-purpose'))

  const out = await $.command.run({ ...COMMAND, args: 'extended' })
  expect(out.text).toBe('Subagents pane opened in extended mode.')
  expect(stored.get('mode')).toBe('extended')
  expect(await texts($)).toContain('LEAD')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'mode' })
  expect(await ui.find({ type: 'Text', text: 'LEAD' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'SUBAGENTS' })).toBeDefined()
  await ui.unmount()
  expect(stored.get('mode')).toBe('compact')
})

test('a later session opens the pane in the mode the store kept', async ($, on) => {
  mock.store(on, { mode: 'extended' })
  world(on)
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawn('u1', 'general-purpose'))

  expect(await texts($)).toContain('LEAD')
})

test('cost shows as an estimate for a priced model and is left out for an unknown one', async ($, on) => {
  let n = 0
  world(on)
  on('agent.spawn', () => ({ model: 'm', agentId: `a${++n}` }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, percent: 21 }, rateLimits: [], cost: { usd: 0.33 } } }))

  await $.agent.spawn(spawn('u1', 'priced'))
  await $.agent.spawn(spawn('u2', 'unpriced'))
  await $.agent.spawn(spawn('u3', 'bedrock'))
  await $.agent.spawn(spawn('u4', 'vertex'))
  await $.turn.complete(complete('a1', 'answer', tokens('claude-sonnet-5-5', 1000, 2000, 10_000, 4000)))
  await $.turn.complete(complete('a2', 'answer', tokens('claude-unknown-9', 1000, 2000, 10_000, 4000)))
  await $.turn.complete(complete('a3', 'answer', tokens('us.anthropic.claude-sonnet-5-5-v1:0', 1000, 2000, 10_000, 4000)))
  await $.turn.complete(complete('a4', 'answer', tokens('claude-sonnet-5-5@20261101', 1000, 2000, 10_000, 4000)))

  expect((await content($)).slice(1)).toEqual([
    '  ✓  vertex  m  0:00 · 7k tok · $0.03 est.',
    '  ✓  bedrock  m  0:00 · 7k tok · $0.03 est.',
    '  ✓  unpriced  m  0:00 · 7k tok',
    '  ✓  priced  m  0:00 · 7k tok · $0.03 est.',
    'session 28k tok  $0.33 est.  lead ctx 21%  0 running',
  ])
})

test('only an explicit model or effort above the role pin is an escalation event, naming what changed', async ($, on) => {
  let n = 0
  let callId = ''
  world(on)
  on('fs.list', () => ({ value: [file('writer.md'), file('reader.md')] }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('writer.md') ? '---\nmodel: sonnet\neffort: high\n---\n' : '---\nmodel: opus\neffort: medium\n---\n' }))
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'sonnet', agentId: `a${++n}` }))
  on('tool.call', (_, e) => {
    callId = e.tool_use_id
    return { result: {} }
  })
  opens(on)
  await extended($)
  const raised: string[] = []
  const spawned = async (id: string, type: string, model?: string) => {
    await $.agent.spawn(spawn(id, type, model))
    for (const line of (await texts($)).filter(l => l.startsWith('escalation'))) if (!raised.includes(line)) raised.push(line)
  }
  const withEffort = async (type: string, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max') => {
    await $.tool.call({ tool: 'Agent', subagent_type: type, effort, description: 'd', prompt: 'p' })
    await spawned(callId, type)
  }

  await spawned('u1', 'starter:writer', 'opus')
  await spawned('u2', 'starter:writer', 'claude-sonnet-5-5')
  await spawned('u3', 'starter:writer', 'haiku')
  await spawned('u4', 'starter:writer')
  await spawned('u5', 'general-purpose', 'opus')
  await withEffort('starter:reader', 'high')
  await withEffort('starter:reader', 'medium')
  await withEffort('starter:reader', 'low')
  await withEffort('starter:writer', 'high')
  await withEffort('starter:writer', 'low')

  expect(raised).toEqual(['escalation: writer re-sent on Opus', 'escalation: reader re-sent at high effort'])
})

test('a turn with no usage and an empty answer still closes its row on both modes', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'mystery', agentId: 'a1' }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  opens(on)

  await $.agent.spawn(spawn('u1', 'general-purpose'))
  await step($, 'a1', 'mystery')
  await $.turn.complete(complete('a1', 'answer'))

  expect((await content($))[1]).toBe('  ✓  general-purpose  mystery  0:00')
  await extended($)
  expect(await content($)).toContain('  ✓  general-purpose  mystery  0:00')
  expect(await texts($)).toContain('general-purpose done · 0:00')
})

// A running reader, a waiting writer (spawned, no agentId yet), a finished ok locator and a failed reviewer; the lead has run a tool.
async function drawnScene($: Engine, on: On) {
  const time = world(on)
  on('agent.spawn', async (_, e) => {
    if (e.tool_use_id === 'u4') await time.sleep(10)
    return { model: 'sonnet', agentId: `a${e.tool_use_id.slice(1)}` }
  })
  on('tool.call', () => ({ result: {} }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: 210_000, percent: 21 }, rateLimits: [], cost: { usd: 0.33 } } }))
  opens(on)
  await open($)
  await $.tool.call({ tool: 'Read', file_path: '/repo/lead.cs' })
  await $.agent.spawn(spawn('u1', 'starter:reader'))
  await $.tool.call({ tool: 'Read', file_path: '/repo/RowLock.cs', agentId: 'a1' })
  await $.agent.spawn(spawn('u2', 'starter:locator'))
  await $.agent.spawn(spawn('u3', 'starter:reviewer'))
  await $.turn.complete(complete('a2', 'answer'))
  await $.turn.complete(complete('a3', 'error'))
  const spawning = $.agent.spawn(spawn('u4', 'starter:writer'))
  await time.settle()
  return async () => {
    await time.advance(10)
    await spawning
  }
}
const SURFACES = ['terminal', 'desktop'] as const
const MODES = ['compact', 'extended'] as const

test('no drawn text starts or ends with whitespace or holds two spaces in a row', async ($, on) => {
  const done = await drawnScene($, on)

  for (const mode of MODES) {
    await $.command.run({ ...COMMAND, args: mode })
    for (const surface of SURFACES) {
      const found = await texts($, surface)
      expect(found).toContain('waiting')
      expect(found.filter(t => /^\s|\s$|\s{2}/.test(t))).toEqual([])
    }
  }
  await done()
})

test('no box in the drawn tree has a borderStyle', async ($, on) => {
  const done = await drawnScene($, on)
  const bordered = (n: Drawn): boolean => typeof n !== 'string' && (n.props?.borderStyle !== undefined || kidsOf(n).some(bordered))

  for (const mode of MODES) {
    await $.command.run({ ...COMMAND, args: mode })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(bordered((await ui.drawn()) as Drawn)).toBe(false)
      await ui.unmount()
    }
  }
  await done()
})

test("each card's rail has one ▍ per body line, and every body line is one row", async ($, on) => {
  const done = await drawnScene($, on)
  // A card is a row of a rail column of ▍ and a body column.
  const railed = (n: Drawn): number[][] => {
    const [rail, body] = kidsOf(n)
    const isCard = rail && body && typeof rail !== 'string' && rail.type === 'Box' && kidsOf(rail).length > 0 && kidsOf(rail).every(k => flatText(k) === '▍')
    const own = isCard ? [[kidsOf(rail).length, kidsOf(body).length, ...kidsOf(body).map(k => layout(k, 80).length)]] : []
    return [...own, ...kidsOf(n).flatMap(railed)]
  }
  const expected = { compact: [3, 2], extended: [2, 3, 2] }

  for (const mode of MODES) {
    await $.command.run({ ...COMMAND, args: mode })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const cards = railed((await ui.drawn()) as Drawn)
      await ui.unmount()
      expect(cards.map(([rail]) => rail)).toEqual(expected[mode])
      for (const [rail, body, ...rows] of cards) {
        expect(body).toBe(rail)
        expect(rows).toEqual(Array(rail).fill(1))
      }
    }
  }
  await done()
})
