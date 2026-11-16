// The starter's rules. The plugin's SessionStart hook (rules-hook.mjs) puts them into each session's context, so
// nothing is written to the user's CLAUDE.md. Versions before 0.8 copied them into CLAUDE.md between markers; this
// module also finds and removes that old copy, so the rules don't load twice.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
export const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
export const claudeMd = join(configDir, 'CLAUDE.md')
export const BEGIN = '<!-- claude-starter:begin'
export const END = '<!-- claude-starter:end -->'

export function rulesText() {
  return readFileSync(join(pluginRoot, 'rules.md'), 'utf8').replace(/\r\n/g, '\n').trim()
}

// `/solo on|off` in the plugin's hooks module writes this file; a command hook can't read the module's store.
const soloFile = join(configDir, 'claude-starter', 'solo')
const SOLO_LINE =
  "Solo mode is on: do the work yourself in this session; don't delegate to subagents unless the user asks. Where the rules below name the `reviewer` or `writer` subagent, do that step yourself: run the `code-review` skill directly and make the fixes in this session."

export function soloOn() {
  try {
    return readFileSync(soloFile, 'utf8').trim() === 'on'
  } catch {
    return false
  }
}

// The rules without the delegation section, which the solo line stands in for.
export function soloRules(text) {
  return text.replace(/\*\*Delegate to keep the main context clean\.\*\*[\s\S]*?(?=\n\n\*\*)/, SOLO_LINE)
}

// True when the user turned the rules off in /starter:setup (a flag in the plugin's data dir). `rules-skipped` is the
// flag older versions wrote when the user declined the rules.
export function rulesOff(dataDir) {
  return Boolean(dataDir) && ['rules-off', 'rules-skipped'].some(name => existsSync(join(dataDir, name)))
}

// Where the old block sits in text: { start, end } (end is past the end marker), null when there are no markers, or
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

// 'none', 'present' or 'broken': the old copy of the rules in the user's CLAUDE.md.
export function oldBlockState() {
  if (!existsSync(claudeMd)) {
    return 'none'
  }
  const block = findBlock(readFileSync(claudeMd, 'utf8'))
  return block === null ? 'none' : block === 'broken' ? 'broken' : 'present'
}
