import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Feed, Mode, Row, Usage } from '../types'

const PANE = 'subagents'
const rows = atom({ plugin: 'starter', key: 'rows' } as const, [], { shape: 'rows-3' })
const feed = atom({ plugin: 'starter', key: 'feed' } as const, { events: [], tokens: 0, lead: {} } as Feed, { shape: 'feed-1' })
const modeAtom = atom({ plugin: 'starter', key: 'mode' } as const, 'compact' as Mode, { shape: 'mode-1' })

// US$ per million tokens, from the claude-api skill (models table, cached 2026-11-03; shared/prompt-caching.md).
// Cache writes are priced at the 5-minute rate (1.25x input): TurnUsage does not split writes by TTL.
// Haiku 5.5: the skill gives no cache-read rate, so its general ~0.1x of input is used; its >100K-prompt tier is not applied.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
}
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const LANES = [
  { name: 'READ', note: 'in parallel', roles: ['locator', 'reader', 'Explore', 'Plan'] },
  { name: 'WRITE', note: 'one at a time', roles: ['writer'] },
  { name: 'CHECK', note: 'fresh context', roles: ['reviewer'] },
] as const
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const isRunning = (r: Row) => r.endedAt === undefined
const keepRecent = (list: Row[]) => {
  const finished = list.filter(r => !isRunning(r)).sort((a, b) => a.endedAt! - b.endedAt!).slice(-10)
  const running = list.filter(isRunning).sort((a, b) => a.startedAt - b.startedAt).slice(-20)
  return list.filter(r => running.includes(r) || finished.includes(r))
}
const remember = <V,>(map: Map<string, V>, key: string, value: V) => {
  map.set(key, value)
  if (map.size > 50) map.delete(map.keys().next().value!)
}
// Display state only: a failed write must never hold up the tool call, step or spawn it watches.
const bg = (p: Promise<unknown>) => void p.catch(() => undefined)

const family = (model?: string) => {
  const name = model && /opus|sonnet|haiku|fable|mythos/i.exec(model)?.[0]
  return name ? name[0]!.toUpperCase() + name.slice(1).toLowerCase() : model
}
const label = (r: Row) => (r.effort ? `${family(r.model)} · ${r.effort}` : (family(r.model) ?? r.model))
const plain = (u: Usage): Usage => ({
  input_tokens: u.input_tokens ?? 0,
  output_tokens: u.output_tokens ?? 0,
  cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
  cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  model: u.model,
})
const add = (a: Usage | undefined, b: Usage | undefined): Usage | undefined =>
  !a || !b
    ? (a ?? b)
    : {
        input_tokens: a.input_tokens + b.input_tokens,
        output_tokens: a.output_tokens + b.output_tokens,
        cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
        cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
        model: b.model,
      }
// Cache reads are left out: every step re-reads the cached prefix, so counting them inflates the figure. Cost still prices them.
const fresh = (u?: Usage) => (u ? u.input_tokens + u.output_tokens + u.cache_creation_input_tokens : 0)
const tokens = (r: Row) => fresh(add(r.usage, r.live))
const short = (n: number) => (n < 1000 ? `${n}` : `${Math.round(n / 1000)}k`)
// Bedrock `us.anthropic.<id>-v1:0`, Vertex `<id>@<date>`, a `[1m]` tag or a date suffix all price as the bare id.
const priceKey = (model: string) =>
  model.replace(/^.*anthropic\./, '').replace(/\[.*\]$/, '').replace(/@.*$/, '').replace(/-v\d+(:\d+)?$/, '').replace(/-\d{8}$/, '')
const cost = (u?: Usage) => {
  const price = u && PRICES[priceKey(u.model)]
  if (!u || !price) return undefined
  const usd =
    (u.input_tokens * price.input +
      u.output_tokens * price.output +
      u.cache_read_input_tokens * price.cacheRead +
      u.cache_creation_input_tokens * price.cacheWrite) /
    1e6
  return `$${usd.toFixed(2)} est.`
}
const firstLine = (text?: string) => text?.split('\n').find(line => line.trim())?.trim().slice(0, 200)
const targetOf = (e: object) => {
  const input = e as Record<string, unknown>
  const text = (k: string) => (typeof input[k] === 'string' && input[k] ? (input[k] as string) : undefined)
  const path = text('file_path') ?? text('notebook_path')
  if (path) return path.split('/').pop()
  const command = text('command')
  return command !== undefined ? program(command) : (text('pattern') ?? text('skill'))
}
// The program and a plain subcommand-like word only: the rest of a command can hold a secret, and rows live in $.state.
const program = (command: string) => {
  const words = command.trim().split(/\s+/).filter((w, i, all) => !all.slice(0, i + 1).every(v => /^\w+=/.test(v)))
  const name = words[0]?.split('/').pop()
  if (!name || !/^[\w.+-]+$/.test(name)) return undefined
  const sub = words[1]
  return sub && /^[a-z][a-z-]{0,19}$/.test(sub) ? `${name} ${sub}` : name
}
const activity = (tool: string, target?: string) => (target ? `${tool}  ${target}` : tool)
const laneOf = (r: Row) =>
  r.edited && r.role !== 'reviewer'
    ? 'WRITE'
    : (LANES.find(l => (l.roles as readonly string[]).includes(r.role))?.name ?? 'OTHER')

type End = { endedAt: number; outcome: string; usage?: Usage; answer?: string }
const finish = (r: Row, end: End): Row => ({
  ...r,
  endedAt: end.endedAt,
  outcome: end.outcome,
  usage: add(r.usage, end.usage ?? r.live),
  live: undefined,
})
const endEvent = (r: Row, answer?: string) => {
  const head = r.outcome === 'done' ? `${r.role} done · ${clock(r.endedAt! - r.startedAt)}` : `${r.role} ${r.outcome}`
  const tok = tokens(r)
  return `${head}${tok ? ` · ${short(tok)} tok` : ''}${answer ? ` — ${answer}` : ''}`
}

// `complete` is false when a read failed, so the caller does not keep a partial result.
async function readPins($: EngineInterface) {
  const dir = `${$.plugin.root}/agents`
  const pins: Record<string, { effort?: string; model?: string }> = {}
  let names: string[]
  try {
    names = (await $.fs.list(dir)).map(f => f.name).filter(name => name.endsWith('.md'))
  } catch {
    return { pins, complete: false }
  }
  let complete = true
  for (const name of names) {
    try {
      const head = (await $.fs.read(`${dir}/${name}`)).split('---')[1] ?? ''
      pins[name.slice(0, -3)] = { effort: /^effort:\s*(\S+)/m.exec(head)?.[1], model: /^model:\s*(\S+)/m.exec(head)?.[1] }
    } catch {
      complete = false
    }
  }
  return { pins, complete }
}

const efforts = new Map<string, string>()
const ended = new Map<string, End>()
let pins: Record<string, { effort?: string; model?: string }> | undefined
let tick: Timer | undefined
let syncs = 0
let spawns = 0
let leadModel: string | undefined
let encoded: { key: string; cells: string } | undefined
// Hooks cannot be added after register() (Registration has only .catch), so tool.call and turn.step pass straight
// through until the pane has been opened in this session.
let active = false

async function pinOf($: EngineInterface, type: string) {
  if (!type.startsWith('starter:')) return {}
  let found = pins
  if (!found) {
    const result = await readPins($)
    found = result.pins
    if (result.complete) pins = found
  }
  return found[type.slice(8)] ?? {}
}

const addEvents = ($: EngineInterface, lines: string[]) =>
  update($, feed, f => ({ ...f, events: [...f.events, ...lines].slice(-8) }))

async function note($: EngineInterface, agentId: string | undefined, tool: string, target?: string) {
  if (!agentId) {
    await update($, feed, f => ({ ...f, lead: { ...f.lead, tool, target } }))
    return
  }
  const mine = (r: Row) => r.agentId === agentId && isRunning(r)
  if (!(await read($, rows)).some(mine)) return
  await update($, rows, list =>
    list.map(r => (mine(r) ? { ...r, tool, target, tools: r.tools + 1, ...(EDITS.has(tool) && { edited: true }) } : r)),
  )
}

async function setMode($: EngineInterface, mode: Mode) {
  await update($, modeAtom, () => mode)
  await $.store.set('mode', mode)
}

// Only the latest call decides, so a slower stale one cannot cancel or restart the timer.
async function sync($: EngineInterface) {
  const call = ++syncs
  const live = (await read($, rows)).some(isRunning) && (await $.ui.panes()).some(p => p.id === PANE)
  if (call !== syncs) return
  if (live && !tick) {
    tick = $.clock.every(250, () => {
      $.ui.invalidate('ui.render')
      void sync($)
    })
  } else if (!live && tick) {
    tick.cancel()
    tick = undefined
  }
}

// One width-1 glyph per cell, the terminal's default colours (a Raster takes raw RGB, not theme keys).
function cells(lines: string[], columns: number) {
  const DEFAULT = 0x01000000
  const words = new Uint32Array(columns * lines.length * 3)
  lines.forEach((line, y) => {
    for (let x = 0; x < columns; x++) words.set([line.codePointAt(x) ?? 0x20, DEFAULT, DEFAULT], (y * columns + x) * 3)
  })
  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
const cachedCells = (lines: string[], columns: number) => {
  const key = `${columns}\n${lines.join('\n')}`
  if (encoded?.key !== key) encoded = { key, cells: cells(lines, columns) }
  return encoded.cells
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'subagents', description: 'Show the subagents pane', argumentHint: '[compact|extended]' })
    const stored = await $.store.get('mode')
    if (stored === 'compact' || stored === 'extended') await update($, modeAtom, () => stored)
    if (await $.store.get('open')) {
      active = true
      void $.ui.open({ id: PANE, title: 'Subagents' }).then(() => sync($))
    }

    return next(e)
  })

  on('command.run', { command: 'subagents' }, async ($, e) => {
    const arg = e.args.trim()
    const mode = arg === 'compact' || arg === 'extended' ? arg : undefined
    if (arg && !mode) return { text: `Unknown mode "${arg}": use /subagents compact or /subagents extended.` }
    if (mode) await setMode($, mode)
    active = true
    await $.store.set('open', true)
    await $.ui.open({ id: PANE, title: 'Subagents' })
    await sync($)

    return { text: mode ? `Subagents pane opened in ${mode} mode.` : 'Subagents pane opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await $.store.delete('open')
    const closed = await next(e)
    await sync($)

    return closed
  })

  on('tool.call', ($, e, next) => {
    if (e.tool === 'Agent' && e.effort) remember(efforts, e.tool_use_id, e.effort)
    if (active) bg(note($, e.agentId, String(e.tool), targetOf(e)))

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!active) return yield* next(e)
    const step = yield* next(e)
    if (e.agentId && step?.usage) {
      const usage = plain(step.usage)
      bg(update($, rows, list => list.map(r => (r.agentId === e.agentId && isRunning(r) ? { ...r, live: add(r.live, usage) } : r))))
    }
    if (!e.agentId && e.model !== leadModel) {
      leadModel = e.model
      bg(update($, feed, f => ({ ...f, lead: { ...f.lead, model: e.model } })))
    }

    return step
  })

  on('agent.spawn', async ($, e, next) => {
    const pin = await pinOf($, e.subagentType)
    const effort = efforts.get(e.tool_use_id) ?? pin.effort
    efforts.delete(e.tool_use_id)
    const startedAt = await $.clock.now()
    const resumed = e.resume?.agentId
    // tool_use_id is shared by a workflow run's agents, so each spawn gets its own key.
    const id = resumed ?? `${startedAt}-${++spawns}`
    const role = e.subagentType.replace(/^starter:/, '')
    const isMine = (r: Row) => (resumed ? r.agentId === resumed : r.id === id)
    let before: Row | undefined
    await update($, rows, list => {
      before = list.find(isMine)
      if (before) return keepRecent(list.map(r => (r === before ? { ...r, startedAt, endedAt: undefined, outcome: undefined } : r)))
      const row: Row = { id, agentId: resumed, role, model: e.model ?? '…', effort, description: e.description, startedAt, tools: 0 }
      return keepRecent([...list, row])
    })
    await update($, feed, f => (f.firstAt === undefined ? { ...f, firstAt: startedAt } : f))
    const undo = (list: Row[]) => list.flatMap(r => (isMine(r) ? (before ? [before] : []) : [r]))

    try {
      await sync($)
      const started = await next(e)
      if (started.deny !== undefined || !started.agentId) {
        await update($, rows, undo)
        await sync($)
        return started
      }
      const { model } = started
      const agentId = started.agentId
      const end = resumed ? undefined : ended.get(agentId)
      let closed: Row | undefined
      await update($, rows, list =>
        keepRecent(
          list.map(r => {
            if (!isMine(r)) return r
            const row = { ...r, agentId, model }
            closed = end && finish(row, end)
            return closed ?? row
          }),
        ),
      )
      if (!resumed) ended.delete(agentId)
      const escalated = e.model && pin.model && family(e.model) !== family(pin.model)
      const lines = [`lead → ${role}: ${e.description}`]
      if (escalated) lines.push(`escalation: ${role} sent again on ${family(e.model)}`)
      if (closed) lines.push(endEvent(closed, end?.answer))
      await addEvents($, lines).catch(() => undefined)

      return started
    } catch (error) {
      await update($, rows, undo)
      throw error
    }
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    const usage = e.usage ? plain(e.usage) : undefined
    if (usage) await update($, feed, f => ({ ...f, tokens: f.tokens + fresh(usage) }))
    if (id) {
      const end: End = { endedAt: await $.clock.now(), outcome: e.reason === 'answer' ? 'done' : e.reason, usage, answer: firstLine(e.answer) }
      let closed: Row | undefined
      await update($, rows, list => {
        closed = undefined
        if (list.some(r => r.agentId === id)) ended.delete(id)
        else if (list.some(r => r.agentId === undefined && isRunning(r))) remember(ended, id, end)
        return keepRecent(list.map(r => (r.agentId === id && isRunning(r) ? (closed = finish(r, end)) : r)))
      })
      if (closed) await addEvents($, [endEvent(closed, end.answer)])
      await sync($)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, rows)
    if (list.length === 0) return <Text dimColor>No subagents have run yet in this session.</Text>

    const { events, firstAt, lead, tokens: spent } = await read($, feed)
    const mode = await read($, modeAtom)
    const now = await $.clock.now()
    const session = await $.session.usage().catch(() => undefined)
    const cols = Math.max(20, e.props.bodyColumns)
    const running = list.filter(isRunning)
    const recent = list.filter(r => !isRunning(r)).reverse()
    const other: Mode = mode === 'compact' ? 'extended' : 'compact'
    const spin = (i: number) => SPIN[(Math.floor(now / 250) + i) % SPIN.length]
    const stats = (r: Row) => {
      const tok = tokens(r)
      return [isRunning(r) && `${r.tools} tools`, tok > 0 && `${short(tok)} tok`, cost(add(r.usage, r.live))].filter(Boolean).join(' · ')
    }
    const figures = (r: Row) => [clock((r.endedAt ?? now) - r.startedAt), stats(r)].filter(Boolean).join(' · ')
    const pct = session?.context.percent
    const sessionLine = [
      `session  ${short(spent + running.reduce((n, r) => n + fresh(r.live), 0))} tok`,
      session?.cost && `$${session.cost.usd.toFixed(2)} est.`,
      mode === 'compact' ? pct !== undefined && `lead ctx ${pct}%` : `${running.length} running`,
    ]
      .filter(Boolean)
      .join('   ')
    const rule = <Text dimColor>{'─'.repeat(cols)}</Text>
    const head = (
      <Box justifyContent="space-between">
        <Text bold>{mode === 'compact' ? 'SUBAGENTS' : 'SUBAGENTS · extended'}</Text>
        <Box gap={2}>
          <Text dimColor>{`${running.length} running`}</Text>
          <Button key="mode" hotkey="m" plain onPress={() => setMode($, other)}>
            {other}
          </Button>
        </Box>
      </Box>
    )

    if (mode === 'compact') {
      return (
        <Box flexDirection="column">
          {head}
          {rule}
          {running.map((r, i) => (
            <Box flexDirection="column">
              <Box justifyContent="space-between">
                <Text color="claude">{`${spin(i)} ${r.role.padEnd(9)} ${label(r)}`}</Text>
                <Text>{clock(now - r.startedAt)}</Text>
              </Box>
              {r.tool && <Text dimColor wrap="truncate-end">{`  ↳ ${activity(r.tool, r.target)}`}</Text>}
              <Text dimColor>{`  ${'▓'.repeat(Math.min(14, r.tools)).padEnd(14, '░')}  ${stats(r)}`}</Text>
            </Box>
          ))}
          {recent.map(r => (
            <Box justifyContent="space-between">
              <Text color={r.outcome === 'done' ? 'success' : 'error'}>
                {`${r.outcome === 'done' ? '✓' : '✗'} ${r.role.padEnd(9)} ${label(r)}${r.outcome === 'done' ? '' : `  ${r.outcome}`}`}
              </Text>
              <Text dimColor>{figures(r)}</Text>
            </Box>
          ))}
          {rule}
          <Text dimColor>{sessionLine}</Text>
        </Box>
      )
    }

    const boxWidth = cols >= 64 ? Math.floor(cols / 2) : cols
    const agentBox = (r: Row, i: number) => {
      const state = !isRunning(r) ? (r.outcome === 'done' ? 'done' : 'failed') : r.agentId ? 'running' : 'waiting'
      const color = ({ running: 'claude', done: 'success', failed: 'error', waiting: 'subtle' } as const)[state]
      const status = {
        running: `${spin(i)} ${figures(r)}`,
        done: `✓ done ${figures(r)}`,
        failed: `✗ ${r.outcome} ${figures(r)}`,
        waiting: '· waiting',
      }[state]
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={color} borderDimColor={state === 'done'} width={boxWidth}>
          <Text bold color={color} wrap="truncate-end">{`${r.role} ─ ${label(r)}`}</Text>
          <Text wrap="truncate-end">{status}</Text>
          {state === 'running' && r.tool && <Text dimColor wrap="truncate-end">{`↳ ${activity(r.tool, r.target)}`}</Text>}
        </Box>
      )
    }
    const lanes = [...LANES, { name: 'OTHER', note: '' }].map(lane => {
      const members = list.filter(r => laneOf(r) === lane.name)
      if (members.length === 0 && lane.name === 'OTHER') return undefined
      return (
        <Box flexDirection="column">
          <Text dimColor>{lane.note ? `${lane.name} · ${lane.note}` : lane.name}</Text>
          <Box flexWrap="wrap">
            {members.length > 0 ? (
              members.map((r, i) => agentBox(r, i))
            ) : (
              <Box borderStyle="round" borderColor="subtle" borderDimColor width={boxWidth}>
                <Text dimColor>none this session</Text>
              </Box>
            )}
          </Box>
        </Box>
      )
    })

    const timeline = [...list].sort((a, b) => a.startedAt - b.startedAt)
    const origin = firstAt ?? timeline[0]!.startedAt
    // Whole seconds, so the bars (and the Raster's cells) change at most once a second while the spinner ticks faster.
    const second = Math.floor(now / 1000) * 1000
    const span = Math.max(1000, Math.max(second, ...list.map(r => r.endedAt ?? second)) - origin)
    const labelWidth = 10
    const barWidth = Math.max(1, Math.min(512, cols - labelWidth))
    const bars = timeline.map(r => {
      const from = Math.min(barWidth - 1, Math.floor(((r.startedAt - origin) / span) * barWidth))
      const to = Math.max(from + 1, Math.floor((((r.endedAt ?? second) - origin) / span) * barWidth))
      return (' '.repeat(from) + '▓'.repeat(Math.min(barWidth, to) - from)).padEnd(barWidth)
    })
    const leadLine = [lead.model && family(lead.model), pct !== undefined && `ctx ${pct}%`].filter(Boolean).join(' · ')
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined

    return (
      <Box flexDirection="column">
        {head}
        <Box flexDirection="column" borderStyle="round" borderColor="claude" width={Math.min(cols, 30)}>
          <Text bold color="claude">LEAD</Text>
          {leadLine ? <Text>{leadLine}</Text> : undefined}
          {lead.tool && <Text dimColor wrap="truncate-end">{`↳ ${activity(lead.tool, lead.target)}`}</Text>}
        </Box>
        {lanes}
        <Text bold>{`TIMELINE  0:00 ${'─'.repeat(Math.max(1, cols - 22))} ${clock(span)}`}</Text>
        <Box>
          <Box flexDirection="column" width={labelWidth}>
            {timeline.map(r => (
              <Text wrap="truncate-end">{r.role}</Text>
            ))}
          </Box>
          {Raster ? (
            <Raster key="timeline" columns={barWidth} rows={bars.length} cells={cachedCells(bars, barWidth)} />
          ) : (
            <Box flexDirection="column">
              {bars.map(bar => (
                <Text>{bar}</Text>
              ))}
            </Box>
          )}
        </Box>
        <Text bold>EVENTS</Text>
        {events.map(line => (
          <Text dimColor wrap="truncate-end">{line}</Text>
        ))}
        <Text dimColor>{sessionLine}</Text>
      </Box>
    )
  })
}
