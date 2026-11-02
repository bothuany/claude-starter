// SessionStart: tell the user (not Claude) when something needs their attention. It prints one systemMessage, which
// the user sees and which costs no context; it never injects instructions.
//   - an old copy of the starter's rules (from versions before 0.8) still sits in their CLAUDE.md: the plugin now
//     injects them itself, and holds them back until that copy is gone so they don't load twice
//   - the monthly review is due: no /insights report in 30 days, or a memory index grew past 150 lines or 20KB
//     (at most once a day, and never after `/starter:monthly-review off`)
// The imports are inside the try, so even a broken install stays silent instead of blocking a session.
try {
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { oldBlockState } = await import('./rules-block.mjs')
  const { MEMORY_BYTES, MEMORY_LINES, remindersOff, status } = await import('./review.mjs')

  const notes = []
  const dataDir = process.env.CLAUDE_PLUGIN_DATA || ''
  const old = oldBlockState()
  if (old === 'present') {
    notes.push('the working rules now come from the plugin itself; run /starter:setup to remove the old copy from your CLAUDE.md (until then the plugin holds its own copy back)')
  } else if (old === 'broken') {
    notes.push('your CLAUDE.md has unbalanced claude-starter markers from an old version: delete that block by hand (run /starter:setup to see where)')
  }

  if (dataDir && !remindersOff(dataDir)) {
    const stampFile = join(dataDir, 'last-reminder')
    // The local date, so "once a day" follows the user's day rather than UTC's.
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const shownToday = existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === today
    const review = status(dataDir)
    const reasons = []
    if (review.reviewDue) {
      // Claude Code deletes reports after cleanupPeriodDays (30 by default), so "none" usually means "none recent".
      reasons.push(review.insightsAgeDays === null ? 'no recent /insights report' : `last /insights report is ${review.insightsAgeDays} days old`)
    }
    if (review.largeMemoryIndexes.length) {
      reasons.push(`${review.largeMemoryIndexes.length} memory index(es) over ${MEMORY_LINES} lines or ${MEMORY_BYTES / 1024}KB`)
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
