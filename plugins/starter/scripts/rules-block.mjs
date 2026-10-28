// The starter's rules as a marked block in the user's CLAUDE.md, shared by setup.mjs and session-check.mjs.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
export const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
export const claudeMd = join(configDir, 'CLAUDE.md')
export const BEGIN = '<!-- claude-starter:begin'
export const END = '<!-- claude-starter:end -->'

export function rulesBlock() {
  // LF only, so the hash is the same whether git checked rules.md out with CRLF or LF.
  const rules = readFileSync(join(pluginRoot, 'rules.md'), 'utf8').replace(/\r\n/g, '\n').trim()
  const hash = createHash('sha256').update(rules).digest('hex').slice(0, 8)
  return { hash, text: `${BEGIN} ${hash} -->\n${rules}\n${END}` }
}

// True when the user declined the rules in /starter:setup (a flag in the plugin's data dir).
export function rulesSkipped(dataDir) {
  return Boolean(dataDir) && existsSync(join(dataDir, 'rules-skipped'))
}

// Where the block sits in text: { start, end } (end is past the end marker), null when there are no markers, or
// 'broken' when they aren't exactly one begin followed by one end. A broken block is never rewritten: guessing
// where it ends could delete the user's own text.
export function findBlock(text) {
  const begins = text.split(BEGIN).length - 1
  const ends = text.split(END).length - 1
  if (!begins && !ends) {
    return null
  }
  const start = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (begins !== 1 || ends !== 1 || end < start) {
    return 'broken'
  }
  return { start, end: end + END.length }
}

// 'missing', 'broken', 'outdated' or 'current', from the markers and the hash in the begin marker.
export function blockState() {
  if (!existsSync(claudeMd)) {
    return 'missing'
  }
  const text = readFileSync(claudeMd, 'utf8')
  const block = findBlock(text)
  if (block === null || block === 'broken') {
    return block ?? 'missing'
  }
  const match = text.slice(block.start).match(/^<!-- claude-starter:begin (\w+) -->/)
  return match?.[1] === rulesBlock().hash ? 'current' : 'outdated'
}
