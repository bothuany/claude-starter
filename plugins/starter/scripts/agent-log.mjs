#!/usr/bin/env node
// Spawn log: PreToolUse on Agent appends one JSONL line per subagent call (which role, which model and effort) to
// ${CLAUDE_PLUGIN_DATA}/agents.jsonl, or ~/.claude/starter/agents.jsonl without that variable.
//
// Off with CLAUDE_STARTER_AGENT_LOG=off in the environment (settings.json "env"). Prints nothing, never fails.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

try {
  if (!/^(off|0|false|no)$/i.test(process.env.CLAUDE_STARTER_AGENT_LOG ?? '')) {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    const call = input.tool_input ?? {}
    const dir = process.env.CLAUDE_PLUGIN_DATA || join(homedir(), '.claude', 'starter')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'agents.jsonl'), JSON.stringify({
      ts: new Date().toISOString(), session_id: input.session_id, subagent_type: call.subagent_type,
      model: call.model ?? null, effort: call.effort ?? null, description: call.description,
    }) + '\n')
  }
} catch {
  // A hook must never break a session: malformed input or a write error means "log nothing".
}
