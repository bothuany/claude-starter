// SessionStart: tell the user (not Claude) when something needs their attention. It prints one systemMessage, which
// the user sees and which costs no context; it never injects instructions.
//   - the starter's rules are missing or out of date in their CLAUDE.md (every session until fixed)
//   - the monthly review is due: no /insights report in 30 days, or a memory index grew past 150 lines
//     (at most once a day, and never after `/starter:monthly-review off`)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { blockState } from './rules-block.mjs'
import { MEMORY_LINES, remindersOff, status } from './review.mjs'

try {
  const notes = []
  const state = blockState()
  if (state !== 'current') {
    const what = state === 'missing' ? 'are not installed' : 'changed in a plugin update'
    notes.push(`the working rules ${what}: run /starter:setup to review and apply them`)
  }

  const dataDir = process.env.CLAUDE_PLUGIN_DATA || ''
  if (dataDir && !remindersOff(dataDir)) {
    const stampFile = join(dataDir, 'last-reminder')
    const today = new Date().toISOString().slice(0, 10)
    const shownToday = existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === today
    const review = status(dataDir)
    const reasons = []
    if (review.reviewDue) {
      reasons.push(review.insightsAgeDays === null ? 'no /insights report yet' : `last /insights report is ${review.insightsAgeDays} days old`)
    }
    if (review.largeMemoryIndexes.length) {
      reasons.push(`${review.largeMemoryIndexes.length} memory index(es) over ${MEMORY_LINES} lines`)
    }
    if (reasons.length && !shownToday) {
      notes.push(`monthly review due (${reasons.join('; ')}): run /starter:monthly-review, or /starter:monthly-review off to stop these reminders`)
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(stampFile, today)
    }
  }

  if (notes.length) {
    console.log(JSON.stringify({ systemMessage: `claude-starter: ${notes.join('. ')}.` }))
  }
} catch {
  // A broken check must never block a session.
}
