import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { Agent, Cycle, Lead, Plan } from '../types'

const PANE = 'phase'
const cycleAtom = atom({ plugin: 'starter', key: 'cycle' } as const, null, { shape: 'cycle-1' })
const agentsAtom = atom({ plugin: 'starter', key: 'agents' } as const, [], { shape: 'agents-1' })
const leadAtom = atom({ plugin: 'starter', key: 'lead' } as const, { busy: false }, { shape: 'lead-1' })

const PHASES = ['gather', 'plan', 'plan-review', 'build', 'code-review', 'probe'] as const
const SHORT = ['gather', 'plan', 'review', 'build', 'review', 'probe']
const EDITS = new Set(['Edit', 'Write', 'MultiEdit'])
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const NONE = 'No cycle running. Start one with /starter:cycle <work>'
const SOLID = 2
const BAR = 16
const MAX_AGENTS = 20
const CTX = 8
const WINDOWS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
// The roles that do each phase's work: the card shows only a running agent of one of them.
const ROLES: Record<string, string[]> = {
  gather: ['reader'],
  plan: ['reader'],
  'plan-review': ['reviewer'],
  build: ['writer'],
  // The writer that fixes the findings runs in this phase too.
  'code-review': ['reviewer', 'writer'],
  probe: ['reviewer'],
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const words = (phase: string) => phase.replace('-', ' ')
const span = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}
const remember = <V,>(map: Map<string, V>, key: string, value: V) => {
  map.set(key, value)
  if (map.size > 50) map.delete(map.keys().next().value!)
}
// Display state only: a failure here must never reach the tool call, spawn, turn or command it watches.
const quiet = async (fn: () => Promise<unknown>) => {
  try {
    await fn()
  } catch {
    // keep the last good state
  }
}
const bg = (p: Promise<unknown>) => void p.catch(() => undefined)
const maybe = async <T,>(fn: () => Promise<T>) => {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

// Forward slashes, `.` and `..` resolved, no trailing slash, the leading `//` of a network path kept; a drive-letter path is lower-cased whole, as Windows compares it.
const normal = (path: string) => {
  const slashed = path.replace(/\\/g, '/')
  const out: string[] = []
  for (const [i, seg] of slashed.split('/').entries()) {
    if (seg === '..') {
      if (out.length > 1) out.pop()
    } else if (seg !== '.' && (seg !== '' || i === 0)) out.push(seg)
  }
  const joined = out.join('/') || '/'
  if (/^\/\/[^/]/.test(slashed)) return `/${joined}`
  return /^[a-z]:/i.test(joined) ? joined.toLowerCase() : joined
}
const planFile = (root: string, path: string) => {
  const file = normal(/^([A-Za-z]:)?[\\/]/.test(path) ? path : `${root}/${path}`)
  return file.startsWith(`${root}/docs/plans/`) && file.endsWith('.md') ? file : undefined
}

// The plan file's contract (docs/plans): front matter, the `## Items` lines and the `## Log` lines. Undefined: not a cycle plan.
const parsePlan = (text: string): Plan | undefined => {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (lines[0]?.trim() !== '---' || end < 0) return undefined
  const front: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const m = /^(\w+):\s*(.*?)\s*$/.exec(line)
    if (m) front[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, '$2')
  }
  const phase = front.phase
  if (!front.cycle || !(phase === 'done' || PHASES.some(p => p === phase))) return undefined
  const plan: Plan = { cycle: front.cycle, phase: phase as Plan['phase'], waiting: front.waiting === 'user', items: 0, ticked: 0, log: [] }
  let section = ''
  let fence: string | undefined
  for (const line of lines.slice(end + 1)) {
    // A fenced block holds examples: its headings, items and log lines are not the plan's. A fence opens with three or
    // more backticks or tildes and closes on a line that starts with at least as many of the same character.
    const run = /^(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence ? run && run[0] === fence[0] && run.length >= fence.length : run) {
      fence = fence ? undefined : run
      continue
    }
    if (fence) continue
    const head = /^## (.*?)\s*$/.exec(line)
    if (head) section = head[1]!.toLowerCase()
    else if (section === 'items') {
      const item = /^- \[([ xX])\] \d+\./.exec(line)
      if (item) {
        plan.items++
        if (item[1] !== ' ') plan.ticked++
      }
    } else if (section === 'log') {
      const entry = /^- ([^:]+): (.*?)\s*$/.exec(line)
      if (entry) plan.log.push({ key: entry[1]!.trim(), text: entry[2]! })
    }
  }
  return plan
}

const family = (model: string) => {
  const m = /(opus|sonnet|haiku|fable|mythos)(?:-(\d+)(?:-(\d{1,2})(?!\d))?)?/i.exec(model)
  if (!m) return model
  const name = m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase()
  return m[2] ? `${name} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : name
}
const field = (e: object, key: string) => {
  const value = (e as Record<string, unknown>)[key]
  return typeof value === 'string' && value ? value : undefined
}
const targetOf = (e: object) => {
  const path = field(e, 'file_path') ?? field(e, 'notebook_path')
  if (path) return path.split(/[\\/]/).pop()
  const command = field(e, 'command')
  return command !== undefined ? program(command) : (field(e, 'pattern') ?? field(e, 'skill'))
}
// The program and a plain subcommand-like word only: the rest of a command can hold a secret, and agents live in $.state.
const program = (command: string) => {
  const parts = command.trim().split(/\s+/).filter((w, i, all) => !all.slice(0, i + 1).every(v => /^\w+=/.test(v)))
  const name = parts[0]?.split('/').pop()
  if (!name || !/^[\w.+-]+$/.test(name)) return undefined
  const sub = parts[1]
  return sub && /^[a-z][a-z-]{0,19}$/.test(sub) ? `${name} ${sub}` : name
}

// `complete` is false when a read failed, so the caller does not keep a partial result.
async function readPins($: EngineInterface) {
  const dir = `${$.plugin.root}/agents`
  const pins: Record<string, string | undefined> = {}
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
      pins[name.slice(0, -3)] = /^effort:\s*(\S+)/m.exec(head)?.[1]
    } catch {
      complete = false
    }
  }
  return { pins, complete }
}

const efforts = new Map<string, string>()
const ended = new Map<string, true>()
let pins: Record<string, string | undefined> | undefined
let tick: Timer | undefined
let syncs = 0
let spawns = 0

async function pinOf($: EngineInterface, type: string) {
  if (!type.startsWith('starter:')) return undefined
  let found = pins
  if (!found) {
    const result = await readPins($)
    found = result.pins
    if (result.complete) pins = found
  }
  return found[type.slice(8)]
}

async function note($: EngineInterface, agentId: string, tool: string, target?: string) {
  const mine = (a: Agent) => a.agentId === agentId
  if (!(await read($, agentsAtom)).some(mine)) return
  await update($, agentsAtom, list => list.map(a => (mine(a) ? { ...a, tool, target } : a)))
}

async function lead($: EngineInterface, change: (l: Lead) => Lead) {
  await quiet(async () => {
    const before = (await read($, leadAtom)).busy
    await update($, leadAtom, change)
    if ((await read($, leadAtom)).busy !== before) await sync($)
  })
}

const rootOf = async ($: EngineInterface) => normal(await $.session.root())
const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

// Only the latest call decides, so a slower stale one cannot cancel or restart the timer.
async function sync($: EngineInterface) {
  const call = ++syncs
  const live = ((await read($, agentsAtom)).length > 0 || (await read($, leadAtom)).busy) && (await isOpen($))
  if (call !== syncs) return
  if (live && !tick) {
    tick = $.clock.every(250, () => {
      try {
        $.ui.invalidate('ui.render')
      } catch {
        // the next tick draws again
      }
      bg(sync($))
    })
  } else if (!live && tick) {
    tick.cancel()
    tick = undefined
  }
}

async function load($: EngineInterface, path: string) {
  try {
    return parsePlan(await $.fs.read(path))
  } catch {
    return undefined
  }
}

// The plan stored for this root, if its file parses and is not done. Only a plan that parses as done is forgotten:
// an unreadable file may be on another branch or locked.
async function stored($: EngineInterface, root: string): Promise<Cycle | undefined> {
  const key = `plan:${root}`
  const path = await $.store.get(key)
  if (typeof path !== 'string') return undefined
  const plan = await load($, path)
  if (plan?.phase === 'done') await $.store.delete(key)
  else if (plan) return { path, plan }
  return undefined
}

// The plan to show: the stored one, else the first open cycle plan in docs/plans.
async function find($: EngineInterface, root: string): Promise<Cycle | undefined> {
  const kept = await stored($, root)
  if (kept) return kept
  const dir = `${root}/docs/plans`
  let names: string[]
  try {
    // shortcut: the listing reads the first 50 files by name, so a cycle plan sorting after the 50th is not found, upgrade when plan folders grow past 50 files.
    names = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.md')).map(f => f.name).sort().slice(0, 50)
  } catch {
    return undefined
  }
  for (const name of names) {
    const plan = await load($, `${dir}/${name}`)
    if (plan && plan.phase !== 'done') return { path: `${dir}/${name}`, plan }
  }
  return undefined
}

// Re-reads the open plan; a failed read or a file that no longer parses leaves the last good state.
async function refresh($: EngineInterface) {
  await quiet(async () => {
    const open = await read($, cycleAtom)
    const plan = open && (await load($, open.path))
    if (open && plan) await update($, cycleAtom, (): Cycle => ({ path: open.path, plan }))
  })
}

// With a cycle loaded, read it again; with none, look for one: in the store alone, or (`full`) in docs/plans too.
async function reload($: EngineInterface, full: boolean) {
  await quiet(async () => {
    if (await read($, cycleAtom)) return refresh($)
    const root = await rootOf($)
    const found = await (full ? find($, root) : stored($, root))
    if (found) await update($, cycleAtom, () => found)
  })
}

async function openPane($: EngineInterface, root: string) {
  await $.store.set(`open:${root}`, true)
  await $.ui.open({ id: PANE, title: 'Phase' })
  await sync($)
}

// A plan file was just edited: show it and remember it for this root, unless it is a finished cycle that is not the open one.
// Only a plan that becomes the open cycle opens the pane by itself: later edits never reopen a pane the person closed.
async function adopt($: EngineInterface, root: string, path: string) {
  const plan = await load($, path)
  if (!plan) return
  const open = await read($, cycleAtom)
  if (plan.phase === 'done' && open?.path !== path) return
  await update($, cycleAtom, (): Cycle => ({ path, plan }))
  if (plan.phase === 'done') return
  await $.store.set(`plan:${root}`, path)
  if (open?.path !== path && !(await isOpen($))) await openPane($, root)
}

// The main session in three lines: model and effort with the session's age, the context and rate-limit windows, and its tool.
// Undefined when the model is not known yet, so a pane without it draws as before.
async function leadBlock($: EngineInterface, now: number, width: number, Box: any, Text: any) {
  const l = await read($, leadAtom)
  const usage = await maybe(() => $.session.usage())
  const model = l.model ?? (await maybe(() => $.session.model()))
  if (!model) return undefined
  const keep = (child: RenderChildren) => <Box flexShrink={0}>{child}</Box>
  const rows: RenderChildren[] = [
    <Box justifyContent="space-between" gap={2}>
      <Box flexShrink={1} minWidth={0}>
        <Text weight="bold" wrap="truncate-end">{[family(model), l.effort].filter(Boolean).join(' · ')}</Text>
      </Box>
      {usage ? keep(<Text dimColor tabular>{span(now - usage.startedAt)}</Text>) : undefined}
    </Box>,
  ]
  if (usage) {
    const pct = usage.context.percent
    const full = pct === undefined ? 0 : Math.round((Math.min(100, pct) / 100) * CTX)
    const limits = usage.rateLimits.map(r => `${WINDOWS[r.kind] ?? r.kind} ${Math.round(r.percentUsed)}%`).join(' · ')
    const hot = (n: number) => (n >= 80 ? 'warning' : undefined)
    rows.push(
      <Box gap={2}>
        <Box gap={1} flexShrink={0}>
          <Text dimColor>ctx</Text>
          <Box>
            {full > 0 ? <Text mono color={hot(pct ?? 0) ?? 'claude'}>{'█'.repeat(full)}</Text> : undefined}
            {full < CTX ? <Text mono dimColor>{'░'.repeat(CTX - full)}</Text> : undefined}
          </Box>
          <Text dimColor tabular>{pct === undefined ? '–' : `${Math.round(pct)}%`}</Text>
        </Box>
        {limits ? (
          <Box flexShrink={1} flexGrow={1} minWidth={0}>
            <Text color={hot(Math.max(...usage.rateLimits.map(r => r.percentUsed)))} dimColor={!usage.rateLimits.some(r => r.percentUsed >= 80)} wrap="truncate-end">
              {limits}
            </Text>
          </Box>
        ) : undefined}
      </Box>,
    )
  }
  rows.push(
    l.busy ? (
      <Box gap={1}>
        {keep(<Text color="claude" mono>{SPIN[Math.floor(now / 250) % SPIN.length]}</Text>)}
        {keep(<Text>{l.tool ?? 'thinking'}</Text>)}
        {l.tool && l.target ? (
          <Box flexShrink={1} flexGrow={1} minWidth={0}>
            <Text dimColor wrap="truncate-end">{l.target}</Text>
          </Box>
        ) : undefined}
      </Box>
    ) : (
      <Text dimColor>idle</Text>
    ),
  )
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {rows}
    </Box>
  )
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'phase', description: 'Show the main session and the open cycle: phase, running agent and finished phases' })
    await quiet(async () => {
      const root = await rootOf($)
      const found = await find($, root)
      await update($, cycleAtom, (): Cycle | null => found ?? null)
      // The pane's old global flag opened it in every project: it is read once, handed to this root and removed.
      const legacy = await $.store.get('open')
      if (legacy !== undefined) {
        await $.store.delete('open')
        if (legacy && found) await $.store.set(`open:${root}`, true)
      }
      if (found && (await $.store.get(`open:${root}`))) void $.ui.open({ id: PANE, title: 'Phase' }).then(() => sync($)).catch(() => undefined)
    })

    return next(e)
  })

  on('command.run', { command: 'phase' }, async $ => {
    let text = 'Phase pane opened.'
    await quiet(async () => {
      const root = await rootOf($)
      if (await isOpen($)) {
        text = 'Phase pane closed.'
        await $.store.delete(`open:${root}`)
        await $.ui.close({ id: PANE })
        await sync($)
      } else {
        await reload($, true)
        await openPane($, root)
      }
    })

    return { text }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await quiet(async () => $.store.delete(`open:${await rootOf($)}`))
    const closed = await next(e)
    await quiet(() => sync($))

    return closed
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Agent' && e.effort) remember(efforts, e.tool_use_id, e.effort)
    if (e.agentId) bg(note($, e.agentId, String(e.tool), targetOf(e)))
    else bg(lead($, l => ({ ...l, busy: true, tool: String(e.tool), target: targetOf(e) })))
    const ran = await next(e)
    const edited = EDITS.has(String(e.tool)) ? field(e, 'file_path') : undefined
    if (edited) {
      await quiet(async () => {
        const root = await rootOf($)
        const file = planFile(root, edited)
        if (file) await adopt($, root, file)
      })
    }

    return ran
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await reload($, false)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      const effort = typeof e.effort === 'string' ? e.effort : undefined
      bg(lead($, l => ({ ...l, busy: true, model: e.model, effort })))
    }

    return yield* next(e)
  })

  on('session.measure', async ($, e, next) => {
    await quiet(async () => {
      if (await isOpen($)) $.ui.invalidate('ui.render')
    })

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const effort = efforts.get(e.tool_use_id) ?? (await pinOf($, e.subagentType).catch(() => undefined))
    efforts.delete(e.tool_use_id)
    const startedAt = await $.clock.now()
    const resumed = e.resume?.agentId
    // A new spawn has no agent id yet, so it gets a key of its own.
    const id = resumed ?? `${startedAt}-${++spawns}`
    const without = (list: Agent[]) => list.filter(a => a.id !== id)
    const row: Agent = { id, agentId: resumed, role: e.subagentType.replace(/^starter:/, ''), model: e.model ?? '…', effort, startedAt }
    await quiet(() => update($, agentsAtom, list => [...without(list), row].slice(-MAX_AGENTS)))

    try {
      await quiet(() => sync($))
      const started = await next(e)
      const agentId = started.deny === undefined ? started.agentId : undefined
      if (!agentId || (!resumed && ended.delete(agentId))) {
        await quiet(() => update($, agentsAtom, without))
        await quiet(() => sync($))
        return started
      }
      await quiet(() => update($, agentsAtom, list => list.map(a => (a.id === id ? { ...a, agentId, model: started.model ?? a.model } : a))))

      return started
    } catch (error) {
      await quiet(() => update($, agentsAtom, without))
      throw error
    }
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      await quiet(async () => {
        let known = false
        let pending = false
        await update($, agentsAtom, list => {
          known = list.some(a => a.agentId === id)
          pending = list.some(a => a.agentId === undefined)
          return list.filter(a => a.agentId !== id)
        })
        if (known) ended.delete(id)
        else if (pending) remember(ended, id, true)
        await sync($)
      })
    }
    const out = await next(e)
    if (!id) {
      await refresh($)
      await lead($, l => ({ ...l, busy: false, tool: undefined, target: undefined }))
    }

    return out
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const none = <Text dimColor>{NONE}</Text>
    try {
      const open = await read($, cycleAtom)
      const now = await $.clock.now()
      const width = e.props.bodyColumns ?? 40
      const main = await leadBlock($, now, width, Box, Text)
      if (!open) {
        return main ? (
          <Box flexDirection="column" gap={1}>
            {main}
            <Box paddingLeft={1}>
              <Text dimColor>no open cycle · /starter:cycle</Text>
            </Box>
          </Box>
        ) : (
          none
        )
      }
      const { plan } = open
      const agents = await read($, agentsAtom)

      const done = plan.phase === 'done'
      const at = done ? 5 : PHASES.findIndex(p => p === plan.phase)
      const filled = done ? 6 : at
      const state = (i: number) => (i < filled ? 'done' : i === at && !done ? 'run' : 'next')
      const color = { done: 'success', run: 'claude', next: undefined } as const

      // All horizontal spacing is `gap` or padding. A row has one shrinkable child at most; every other child keeps its size.
      const keep = (child: RenderChildren) => <Box flexShrink={0}>{child}</Box>
      const grow = (child: RenderChildren) => (
        <Box flexShrink={1} flexGrow={1} minWidth={0}>
          {child}
        </Box>
      )
      const piece = (text: string, s: 'done' | 'run' | 'next') =>
        s === 'next' ? <Text dimColor mono>{text}</Text> : <Text color={color[s]} mono>{text}</Text>

      const head = (
        <Box gap={2}>
          {grow(<Text weight="bold" wrap="truncate-end">{plan.cycle}</Text>)}
          {keep(<Text dimColor tabular>{`${done ? 6 : at + 1}/6`}</Text>)}
        </Box>
      )

      // Six stations on one line; the rule between them is sized from the pane's width, 1 column of which is padding.
      const seg = Math.max(0, Math.min(8, Math.floor((width - 9) / 5)))
      const cols = SHORT.map((_, i) => SOLID + i * (seg + 1))
      const lens = SHORT.map(s => s.length)
      const labelAt = (() => {
        const s = cols.map((c, i) => c - Math.floor(lens[i]! / 2))
        s[0] = Math.max(0, s[0]!)
        for (let i = 1; i < 6; i++) s[i] = Math.max(s[i]!, s[i - 1]! + lens[i - 1]! + 1)
        s[5] = Math.min(s[5]!, width - 1 - lens[5]!)
        for (let i = 4; i >= 0; i--) s[i] = Math.min(s[i]!, s[i + 1]! - 1 - lens[i]!)
        return s[0]! >= 0 ? s : undefined
      })()
      const line = [piece('━'.repeat(SOLID), state(0))]
      for (let i = 0; i < 6; i++) {
        if (i > 0) line.push(state(i) === 'next' ? piece('╌'.repeat(seg), 'next') : piece('━'.repeat(seg), 'done'))
        line.push(piece(state(i) === 'done' ? '●' : state(i) === 'run' ? '◉' : '○', state(i)))
      }
      let labels: RenderChildren
      if (labelAt) {
        let end = 0
        labels = (
          <Box>
            {SHORT.map((name, i) => {
              const pad = labelAt[i]! - end
              end = labelAt[i]! + lens[i]!
              const text = state(i) === 'run' ? <Text weight="bold">{name}</Text> : <Text dimColor>{name}</Text>
              return <Box paddingLeft={pad}>{text}</Box>
            })}
          </Box>
        )
      } else {
        // Too narrow for the six labels: the running phase's name alone, under its station.
        const name = done ? 'done' : words(plan.phase)
        const start = Math.max(0, Math.min(cols[Math.min(at, 5)]! - Math.floor(name.length / 2), width - 1 - name.length))
        labels = (
          <Box paddingLeft={start}>
            <Text weight="bold">{name}</Text>
          </Box>
        )
      }
      const stations = (
        <Box flexDirection="column" paddingLeft={1}>
          <Box>{line}</Box>
          {labels}
        </Box>
      )

      // The rail has one `▍` per body line, so every body line stays one row high.
      const card = (...lines: RenderChildren[]) => (
        <Box gap={1} paddingLeft={1}>
          <Box flexDirection="column" flexShrink={0}>
            {lines.map(() => (
              <Text mono color="claude">▍</Text>
            ))}
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            {lines}
          </Box>
        </Box>
      )
      const agent = [...agents].reverse().find(a => ROLES[plan.phase]?.includes(a.role))
      const live = agent && !done && !plan.waiting
      const title = (done ? 'Done' : words(plan.phase)).replace(/^./, c => c.toUpperCase())
      const counts = `${plan.ticked}/${plan.items}`
      // The bar takes what the rail, the word `checks`, the count and the gaps leave, up to BAR cells.
      const cells = Math.max(4, Math.min(BAR, width - 11 - counts.length))
      const filledBar = plan.items > 0 ? Math.round((plan.ticked / plan.items) * cells) : 0
      const checks = (
        <Box gap={1}>
          {keep(<Text dimColor>checks</Text>)}
          <Box flexShrink={0}>
            {filledBar > 0 ? <Text mono color="claude">{'█'.repeat(filledBar)}</Text> : undefined}
            {filledBar < cells ? <Text mono dimColor>{'░'.repeat(cells - filledBar)}</Text> : undefined}
          </Box>
          {keep(<Text dimColor tabular>{counts}</Text>)}
        </Box>
      )
      const body: RenderChildren[] = [
        <Box justifyContent="space-between" gap={2}>
          {keep(<Text weight="bold">{title}</Text>)}
          {live ? keep(<Text dimColor tabular>{clock(now - agent.startedAt)}</Text>) : undefined}
        </Box>,
      ]
      if (done) body.push(<Text dimColor>the cycle is done</Text>)
      else if (plan.waiting) body.push(<Text color="warning">waiting for you</Text>)
      else if (live) {
        body.push(<Text dimColor wrap="truncate-end">{[agent.role, family(agent.model), agent.effort].filter(Boolean).join(' · ')}</Text>)
        body.push(
          <Box gap={1}>
            {keep(<Text color="claude" mono>{SPIN[Math.floor(now / 250) % SPIN.length]}</Text>)}
            {keep(<Text>{agent.tool ?? 'starting'}</Text>)}
            {agent.tool && agent.target ? grow(<Text dimColor wrap="truncate-end">{agent.target}</Text>) : undefined}
          </Box>,
        )
      }
      body.push(checks)

      // Finished phases, newest first, with the evidence the lead logged for them; any other log line as it is.
      const isPhase = (key: string) => PHASES.some(p => p === key)
      const label = Math.max(0, ...plan.log.filter(l => isPhase(l.key)).map(l => words(l.key).length))
      const finished = [...plan.log].reverse().map(l =>
        isPhase(l.key) ? (
          <Box paddingLeft={1} gap={1}>
            {keep(<Text color="success">✓</Text>)}
            <Box width={label + 1} flexShrink={0}>
              <Text dimColor>{words(l.key)}</Text>
            </Box>
            {grow(<Text dimColor wrap="truncate-end">{l.text}</Text>)}
          </Box>
        ) : (
          <Box paddingLeft={1}>
            <Text dimColor wrap="truncate-end">{`${l.key}: ${l.text}`}</Text>
          </Box>
        ),
      )
      const next = done ? [] : PHASES.slice(at + 1).map(words)

      return (
        <Box flexDirection="column" gap={1}>
          {main ? (
            <Box flexDirection="column">
              {head}
              {main}
            </Box>
          ) : (
            head
          )}
          {stations}
          {card(...body)}
          {finished.length > 0 ? <Box flexDirection="column">{finished}</Box> : undefined}
          {next.length > 0 ? (
            <Box paddingLeft={1}>
              <Text dimColor>{`next: ${next.join(' · ')}`}</Text>
            </Box>
          ) : undefined}
        </Box>
      )
    } catch {
      return none
    }
  })
}
