// SessionStart (startup, resume, clear, compact): put the starter's rules into the session's context. Nothing is
// injected when the user turned the rules off in /starter:setup, or while an old copy still sits in their CLAUDE.md
// (session-check.mjs tells them to remove it), so the rules never load twice. Any error means "inject nothing".
try {
  const { oldBlockState, rulesOff, rulesText } = await import('./rules-block.mjs')
  if (!rulesOff(process.env.CLAUDE_PLUGIN_DATA || '') && oldBlockState() === 'none') {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: rulesText() } }))
  }
} catch {
  // A broken hook must never block a session.
}
