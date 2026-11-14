// The four token counts and the model of TurnUsage, as `turn.complete` and `turn.step` report them.
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

export type Row = {
  id: string
  agentId?: string
  role: string
  model: string
  effort?: string
  description: string
  startedAt: number
  endedAt?: number
  outcome?: string
  tool?: string
  target?: string
  tools: number
  edited?: boolean
  usage?: Usage
  live?: Usage
}

export type Feed = {
  events: string[]
  tokens: number
  lead: { model?: string; tool?: string; target?: string }
}

export type Mode = 'compact' | 'extended'

declare module 'claude-code' {
  interface PluginState {
    starter: { rows: Shaped<Row[]>; feed: Shaped<Feed>; mode: Shaped<Mode> }
  }
}
