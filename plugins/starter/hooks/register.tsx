import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { Agent, Cycle, Plan } from '../types'

const PANE = 'phase'
const cycleAtom = atom({ plugin: 'starter', key: 'cycle' } as const, null, { shape: 'cycle-1' })
const agentsAtom = atom({ plugin: 'starter', key: 'agents' } as const, [], { shape: 'agents-1' })

const PHASES = ['gather', 'plan', 'plan-review', 'build', 'code-review', 'probe'] as const
const SHORT = ['gather', 'plan', 'review', 'build', 'review', 'probe']
const EDITS = new Set(['Edit', 'Write', 'MultiEdit'])
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const NONE = 'No cycle running. Start one with /starter:cycle <work>'
const SOLID = 2
const BAR = 16

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const words = (phase: string) => phase.replace('-', ' ')
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

// Forward slashes, lower-case drive letter, no trailing slash: Windows hands paths in either form.
const normal = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, d => d.toLowerCase()).replace(/\/+$/, '')
const planFile = (root: string, path: string) => {
  const file = normal(path)
  const full = /^([a-z]:)?\//i.test(file) ? file : `${root}/${file}`
  return full.startsWith(`${root}/docs/plans/`) && full.endsWith('.md') ? full : undefined
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
  for (const line of lines.slice(end + 1)) {
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

const rootOf = async ($: EngineInterface) => normal(await $.session.root())
const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

// Only the latest call decides, so a slower stale one cannot cancel or restart the timer.
async function sync($: EngineInterface) {
  const call = ++syncs
  const live = (await read($, agentsAtom)).length > 0 && (await isOpen($))
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

// Re-reads the open plan; a failed read or a file that no longer parses leaves the last good state.
async function refresh($: EngineInterface) {
  await quiet(async () => {
    const open = await read($, cycleAtom)
    const plan = open && (await load($, open.path))
    if (open && plan) await update($, cycleAtom, (): Cycle => ({ path: open.path, plan }))
  })
}

async function openPane($: EngineInterface) {
  await $.store.set('open', true)
  await $.ui.open({ id: PANE, title: 'Phase' })
  await sync($)
}

// A plan file was just edited: show it, remember it for this root and open the pane, unless it is a finished cycle that is not the open one.
async function adopt($: EngineInterface, root: string, path: string) {
  const plan = await load($, path)
  if (!plan) return
  const open = await read($, cycleAtom)
  if (plan.phase === 'done' && open?.path !== path) return
  await update($, cycleAtom, (): Cycle => ({ path, plan }))
  if (plan.phase === 'done') return
  await $.store.set(`plan:${root}`, path)
  if (!(await isOpen($))) await openPane($)
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'phase', description: 'Show the open cycle: phase, running agent and finished phases' })
    await quiet(async () => {
      const key = `plan:${await rootOf($)}`
      const path = await $.store.get(key)
      const plan = typeof path === 'string' ? await load($, path) : undefined
      if (typeof path === 'string' && plan && plan.phase !== 'done') {
        await update($, cycleAtom, (): Cycle => ({ path, plan }))
      } else {
        if (path !== undefined) await $.store.delete(key)
        await update($, cycleAtom, () => null)
      }
      if (await $.store.get('open')) void $.ui.open({ id: PANE, title: 'Phase' }).then(() => sync($)).catch(() => undefined)
    })

    return next(e)
  })

  on('command.run', { command: 'phase' }, async $ => {
    let text = 'Phase pane opened.'
    await quiet(async () => {
      if (await isOpen($)) {
        text = 'Phase pane closed.'
        await $.store.delete('open')
        await $.ui.close({ id: PANE })
        await sync($)
      } else {
        await refresh($)
        await openPane($)
      }
    })

    return { text }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await quiet(() => $.store.delete('open'))
    const closed = await next(e)
    await quiet(() => sync($))

    return closed
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Agent' && e.effort) remember(efforts, e.tool_use_id, e.effort)
    if (e.agentId) bg(note($, e.agentId, String(e.tool), targetOf(e)))
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
    if (!e.agentId) await refresh($)

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const effort = efforts.get(e.tool_use_id) ?? (await pinOf($, e.subagentType).catch(() => undefined))
    efforts.delete(e.tool_use_id)
    const startedAt = await $.clock.now()
    const resumed = e.resume?.agentId
    // tool_use_id is shared by a workflow run's agents, so each spawn gets its own key.
    const id = resumed ?? `${startedAt}-${++spawns}`
    const without = (list: Agent[]) => list.filter(a => a.id !== id)
    const row: Agent = { id, agentId: resumed, role: e.subagentType.replace(/^starter:/, ''), model: e.model ?? '…', effort, startedAt }
    await quiet(() => update($, agentsAtom, list => [...without(list), row]))

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
    if (!id) await refresh($)

    return out
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const none = <Text dimColor>{NONE}</Text>
    try {
      const open = await read($, cycleAtom)
      if (!open) return none
      const { plan } = open
      const agents = await read($, agentsAtom)
      const now = await $.clock.now()
      const width = e.props.bodyColumns ?? 40

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
      const agent = agents[agents.length - 1]
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
          {head}
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
