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

// 'missing', 'outdated' or 'current', from the hash in the begin marker.
export function blockState() {
  if (!existsSync(claudeMd)) {
    return 'missing'
  }
  const match = readFileSync(claudeMd, 'utf8').match(/<!-- claude-starter:begin (\w+) -->/)
  if (!match) {
    return 'missing'
  }
  return match[1] === rulesBlock().hash ? 'current' : 'outdated'
}
