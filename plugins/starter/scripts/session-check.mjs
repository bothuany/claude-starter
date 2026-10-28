// SessionStart: tell the user (not Claude) when the starter's rules are missing or out of date in their CLAUDE.md.
// It prints a systemMessage, which the user sees and which costs no context; it never injects instructions.
import { blockState } from './rules-block.mjs'

try {
  const state = blockState()
  if (state !== 'current') {
    const what = state === 'missing' ? 'are not installed' : 'changed in a plugin update'
    console.log(JSON.stringify({ systemMessage: `claude-starter: the working rules ${what}. Run /starter:setup to review and apply them.` }))
  }
} catch {
  // A broken check must never block a session.
}
