#!/usr/bin/env node
// Data for the monthly review and its reminder.
//
//   node review.mjs status [--data <plugin data dir>]   newest /insights report, MEMORY.md sizes, reminder state (JSON)
//   node review.mjs report [<file>]                      the newest (or given) /insights report as plain text
//   node review.mjs reminders on|off --data <dir>        turn the session-start reminder on or off
//
// Nothing here calls a model or changes CLAUDE.md, skills or memory; the monthly-review skill does that with the
// user's approval.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './rules-block.mjs'

export const REVIEW_DAYS = 30
export const MEMORY_LINES = 150
export const MEMORY_BYTES = 20 * 1024
const DAY = 24 * 60 * 60 * 1000

// The newest /insights report under the config dir, or null.
export function newestReport() {
  const dir = join(configDir, 'usage-data')
  if (!existsSync(dir)) {
    return null
  }
  const reports = readdirSync(dir)
    .filter(name => /^report.*\.html$/.test(name))
    .map(name => ({ path: join(dir, name), modified: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.modified - a.modified)
  return reports[0] ?? null
}

// Every project's auto-memory index with its size, largest first. Lines are counted as Claude Code counts them when
// it loads the index (the first 200 lines or 25KB), blank lines included.
export function memoryIndexes() {
  const projects = join(configDir, 'projects')
  if (!existsSync(projects)) {
    return []
  }
  const found = []
  for (const project of readdirSync(projects)) {
    const file = join(projects, project, 'memory', 'MEMORY.md')
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8')
      found.push({ project, file, lines: text.replace(/\r?\n$/, '').split(/\r?\n/).length, bytes: Buffer.byteLength(text) })
    }
  }
  return found.sort((a, b) => b.lines - a.lines)
}

export function remindersOff(dataDir) {
  return Boolean(dataDir) && existsSync(join(dataDir, 'reminders-off'))
}

export function status(dataDir, now = Date.now()) {
  const report = newestReport()
  const ageDays = report ? Math.floor((now - report.modified) / DAY) : null
  const memory = memoryIndexes()
  return {
    insightsReport: report?.path ?? null,
    insightsAgeDays: ageDays,
    reviewDue: ageDays === null || ageDays >= REVIEW_DAYS,
    largeMemoryIndexes: memory.filter(m => m.lines > MEMORY_LINES || m.bytes > MEMORY_BYTES),
    memoryIndexes: memory.slice(0, 10),
    remindersOff: remindersOff(dataDir),
  }
}

// The character for a numeric entity, or the entity itself when the number isn't a valid code point.
const codePoint = (n, entity) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity)

// The report's readable text, without markup, scripts or styles.
function reportText(file) {
  const html = readFileSync(file, 'utf8')
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&bull;/g, '-')
    .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&hellip;/g, '…')
    .replace(/&#x([0-9a-f]+);/gi, (entity, hex) => codePoint(parseInt(hex, 16), entity))
    .replace(/&#(\d+);/g, (entity, dec) => codePoint(Number(dec), entity))
    .replace(/&amp;/g, '&')
    .split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n')
}

if (process.argv[1]?.endsWith('review.mjs')) {
  const [command, ...args] = process.argv.slice(2)
  const dataAt = args.indexOf('--data')
  const dataDir = dataAt === -1 ? '' : args[dataAt + 1] ?? ''
  const positional = args.filter((arg, i) => !arg.startsWith('--') && (dataAt === -1 || i !== dataAt + 1))
  if (command === 'status') {
    console.log(JSON.stringify(status(dataDir), null, 2))
  } else if (command === 'report') {
    const file = positional[0] || newestReport()?.path
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      console.error('No /insights report found. Run /insights first.')
      process.exit(1)
    }
    console.log(reportText(file))
  } else if (command === 'reminders' && ['on', 'off'].includes(positional[0]) && dataDir) {
    mkdirSync(dataDir, { recursive: true })
    if (positional[0] === 'off') {
      writeFileSync(join(dataDir, 'reminders-off'), '')
    } else {
      rmSync(join(dataDir, 'reminders-off'), { force: true })
    }
    console.log(`review reminders ${positional[0]}`)
  } else {
    console.error('usage: review.mjs status [--data <dir>] | report [<file>] | reminders on|off --data <dir>')
    process.exit(1)
  }
}
