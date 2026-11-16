export type Phase = 'gather' | 'plan' | 'plan-review' | 'build' | 'code-review' | 'probe' | 'done'

// What the pane needs of a plan file (the contract in docs/plans): the front matter, the item counts and the log lines.
export type Plan = {
  cycle: string
  phase: Phase
  waiting: boolean
  items: number
  ticked: number
  log: { key: string; text: string }[]
}

// The open plan: its normalised path and the last good parse of it.
export type Cycle = { path: string; plan: Plan }

// A subagent that is running now.
export type Agent = {
  id: string
  agentId?: string
  role: string
  model: string
  effort?: string
  startedAt: number
  tool?: string
  target?: string
}

declare module 'claude-code' {
  interface PluginState {
    starter: { cycle: Shaped<Cycle | null>; agents: Shaped<Agent[]> }
  }
}
