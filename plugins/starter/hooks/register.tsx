import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

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
  { name: 'WRITE', note: 'own files each', roles: ['writer'] },
  { name: 'CHECK', note: 'fresh context', roles: ['reviewer'] },
] as const
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const BAR = 10
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const bar = (ms: number, longest: number) => {
  const eighths = Math.round((Math.min(Math.max(0, ms), longest) / longest) * BAR * 8)
  const full = Math.min(BAR, Math.max(0, Math.floor(eighths / 8)))
  return ('█'.repeat(full) + (EIGHTHS[eighths % 8] ?? '')).padEnd(BAR, '░')
}
const MODELS = ['haiku', 'sonnet', 'opus']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const higher = (order: string[], value?: string, pinned?: string) => {
  const [a, b] = [value, pinned].map(v => order.indexOf(v?.toLowerCase() ?? ''))
  return a! >= 0 && b! >= 0 && a! > b!
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
    const explicitEffort = efforts.get(e.tool_use_id)
    const effort = explicitEffort ?? pin.effort
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
      const changed = [
        higher(MODELS, family(e.model), family(pin.model)) && `on ${family(e.model)}`,
        higher(EFFORTS, explicitEffort, pin.effort) && `at ${explicitEffort} effort`,
      ].filter(Boolean)
      const lines = [`lead → ${role}: ${e.description}`]
      if (changed.length) lines.push(`escalation: ${role} re-sent ${changed.join(' ')}`)
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

    const { events, lead, tokens: spent } = await read($, feed)
    const mode = await read($, modeAtom)
    const now = await $.clock.now()
    const session = await $.session.usage().catch(() => undefined)
    const running = list.filter(isRunning)
    const longest = Math.max(1, ...running.map(r => now - r.startedAt))
    const other: Mode = mode === 'compact' ? 'extended' : 'compact'
    const spin = (i: number) => SPIN[(Math.floor(now / 250) + i) % SPIN.length]
    const stats = (r: Row) => {
      const tok = tokens(r)
      return [isRunning(r) && `${r.tools} tools`, tok > 0 && `${short(tok)} tok`, cost(add(r.usage, r.live))].filter(Boolean).join(' · ')
    }
    const figures = (r: Row) => [clock((r.endedAt ?? now) - r.startedAt), stats(r)].filter(Boolean).join(' · ')
    const pct = session?.context.percent
    const sessionParts = [
      `session ${short(spent + running.reduce((n, r) => n + fresh(r.live), 0))} tok`,
      session?.cost && `$${session.cost.usd.toFixed(2)} est.`,
      mode === 'compact' && pct !== undefined && `lead ctx ${pct}%`,
      `${running.length} running`,
    ].filter(Boolean)

    // All horizontal spacing is `gap`. A row has one shrinkable child at most; every other child keeps its size.
    const keep = (child: RenderChildren) => <Box flexShrink={0}>{child}</Box>
    const grow = (child: RenderChildren) => (
      <Box flexShrink={1} flexGrow={1} minWidth={0}>
        {child}
      </Box>
    )
    const head = (
      <Box justifyContent="space-between" gap={2}>
        {keep(<Text weight="bold">SUBAGENTS</Text>)}
        <Box flexShrink={0} gap={2}>
          <Text dimColor tabular>{`${running.length} running`}</Text>
          <Button key="mode" hotkey="m" plain dimColor onPress={() => setMode($, other)}>
            {other}
          </Button>
        </Box>
      </Box>
    )
    const section = (name: string, note: string | undefined, content: RenderChildren) => (
      <Box flexDirection="column">
        <Box gap={2}>
          {keep(<Text weight="semibold" size="caption">{name}</Text>)}
          {note ? keep(<Text dimColor size="caption">{note}</Text>) : undefined}
        </Box>
        {content}
      </Box>
    )
    // The rail has one `▍` per body line, so every body line stays one row high.
    const card = (color: 'claude' | 'subtle', ...lines: RenderChildren[]) => {
      const body = lines.filter(Boolean)
      return (
        <Box gap={1}>
          <Box flexDirection="column" flexShrink={0}>
            {body.map(() => (
              <Text mono color={color}>▍</Text>
            ))}
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            {body}
          </Box>
        </Box>
      )
    }
    const runningCard = (r: Row, i: number) =>
      card(
        r.agentId ? 'claude' : 'subtle',
        <Box gap={2}>
          {keep(<Text weight="bold">{r.role}</Text>)}
          {grow(<Text dimColor wrap="truncate-end">{label(r)}</Text>)}
          {keep(<Text dimColor tabular>{clock(now - r.startedAt)}</Text>)}
        </Box>,
        r.agentId ? (
          <Box gap={2}>
            {keep(<Text color="claude" mono>{spin(i)}</Text>)}
            {keep(<Text>{r.tool ?? 'starting'}</Text>)}
            {r.tool && r.target ? grow(<Text dimColor wrap="truncate-end">{r.target}</Text>) : undefined}
          </Box>
        ) : (
          <Text dimColor>waiting</Text>
        ),
        r.agentId ? (
          <Box gap={2}>
            {keep(<Text mono color="claude">{bar(now - r.startedAt, longest)}</Text>)}
            {grow(<Text dimColor wrap="truncate-end">{stats(r)}</Text>)}
          </Box>
        ) : undefined,
      )
    const leadCard = card(
      'claude',
      <Box gap={2}>
        {keep(<Text weight="bold">{lead.model ? family(lead.model) : 'lead'}</Text>)}
        <Box flexShrink={1} flexGrow={1} minWidth={0} />
        {pct !== undefined ? keep(<Text dimColor tabular>{`ctx ${pct}%`}</Text>) : undefined}
      </Box>,
      lead.tool ? (
        <Box gap={2}>
          {keep(<Text>{lead.tool}</Text>)}
          {lead.target ? grow(<Text dimColor wrap="truncate-end">{lead.target}</Text>) : undefined}
        </Box>
      ) : undefined,
    )
    const finishedLine = (r: Row) => {
      const ok = r.outcome === 'done'
      return (
        <Box paddingLeft={2} gap={2}>
          {keep(<Text color={ok ? 'success' : 'error'}>{ok ? '✓' : '✗'}</Text>)}
          {keep(<Text dimColor>{r.role}</Text>)}
          {grow(<Text dimColor wrap="truncate-end">{ok ? label(r) : `${label(r)} · ${r.outcome}`}</Text>)}
          {keep(<Text dimColor tabular>{figures(r)}</Text>)}
        </Box>
      )
    }
    const cards = (members: Row[]) => {
      const live = members.filter(isRunning)
      return live.length > 0 ? (
        <Box flexDirection="column" gap={1}>
          {live.map(runningCard)}
        </Box>
      ) : undefined
    }
    const finished = (members: Row[]) => {
      const done = members.filter(r => !isRunning(r)).reverse()
      return done.length > 0 ? <Box flexDirection="column">{done.map(finishedLine)}</Box> : undefined
    }
    const footer = (
      <Box flexWrap="wrap" columnGap={2}>
        {sessionParts.map(part => (
          <Text dimColor size="caption">{part}</Text>
        ))}
      </Box>
    )

    if (mode === 'compact') {
      return (
        <Box flexDirection="column" gap={1}>
          {head}
          {cards(list)}
          {finished(list)}
          {footer}
        </Box>
      )
    }

    const lanes = [...LANES, { name: 'OTHER', note: '' }].map(lane => {
      const members = list.filter(r => laneOf(r) === lane.name)
      if (members.length === 0 && lane.name === 'OTHER') return undefined
      return section(
        lane.name,
        lane.note,
        members.length > 0 ? (
          <Box flexDirection="column" gap={1}>
            {cards(members)}
            {finished(members)}
          </Box>
        ) : (
          <Box paddingLeft={2}>
            <Text dimColor>none this session</Text>
          </Box>
        ),
      )
    })

    return (
      <Box flexDirection="column" gap={1}>
        {head}
        {section('LEAD', undefined, leadCard)}
        {lanes}
        {section(
          'EVENTS',
          undefined,
          events.map(line => (
            <Box paddingLeft={2}>
              <Text dimColor size="caption" wrap="truncate-end">{line}</Text>
            </Box>
          )),
        )}
        {footer}
      </Box>
    )
  })
}
