#!/usr/bin/env node
// Remember, per project, that claude-code-setup has run, so the session-start reminder stops asking. Two events feed it:
//   - PostToolUse on Skill: a Skill call named `claude-code-setup:*` (or the bare `claude-automation-recommender`)
//   - UserPromptSubmit: a typed `/claude-code-setup:...` command, which makes no Skill tool call (the hook input
//     carries the typed line in `prompt`)
// State goes to ${CLAUDE_PLUGIN_DATA}/projects.json. Prints nothing (a UserPromptSubmit hook's stdout is added to the
// conversation) and never fails.
try {
  const { readFileSync } = await import('node:fs')
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const dataDir = process.env.CLAUDE_PLUGIN_DATA || ''
  const skill = String(input.tool_input?.skill ?? '')
  const prompt = String(input.prompt ?? '').trimStart()
  if (dataDir && (skill.startsWith('claude-code-setup:') || skill === 'claude-automation-recommender' || prompt.startsWith('/claude-code-setup:'))) {
    const { markProjectSetupRun } = await import('./project-setup.mjs')
    markProjectSetupRun(dataDir, input.cwd || process.cwd())
  }
} catch {
  // A hook must never break a session: malformed input or a write error means "remember nothing".
}
