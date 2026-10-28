#!/usr/bin/env node
// User-level setup for claude-starter. A plugin can't ship CLAUDE.md or settings, so this script writes them,
// and only when the /starter:setup skill has shown the plan and the user agreed.
//
//   node setup.mjs check                     report what is installed, as JSON
//   node setup.mjs apply [--rules] [--base-ref head|fresh] [--obscura]
//
// Everything it writes lives in the Claude config dir (CLAUDE_CONFIG_DIR or ~/.claude). Files it changes are
// backed up next to themselves first. The rules go between markers, so re-running replaces them in place and
// nothing else in the user's CLAUDE.md is touched.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { BEGIN, END, blockState, claudeMd, configDir, rulesBlock } from './rules-block.mjs'

const settingsFile = join(configDir, 'settings.json')
const isWin = process.platform === 'win32'

// A settings file that isn't valid JSON stops the script before anything is written.
function readSettings() {
  if (!existsSync(settingsFile)) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(settingsFile, 'utf8'))
  } catch {
    console.error(`${settingsFile} is not valid JSON; fix it first, nothing was changed.`)
    process.exit(1)
  }
}

function backup(file) {
  if (existsSync(file)) {
    copyFileSync(file, `${file}.starter-backup`)
  }
}

// The obscura binary, from PATH or the usual install folders; '' when it isn't installed.
function findObscura() {
  const lookup = spawnSync(isWin ? 'where' : 'which', ['obscura'], { encoding: 'utf8' })
  if (lookup.status === 0 && lookup.stdout.trim()) {
    return lookup.stdout.trim().split(/\r?\n/)[0]
  }
  const candidates = isWin
    ? [join(process.env.LOCALAPPDATA || '', 'obscura', 'obscura.exe')]
    : [join(homedir(), '.local', 'bin', 'obscura'), '/usr/local/bin/obscura', '/opt/homebrew/bin/obscura']
  return candidates.find(path => existsSync(path)) || ''
}

// The native installer puts claude.exe on PATH, which runs without a shell. An npm install on Windows only has a
// claude.cmd shim, which needs cmd.exe, so there every argument is quoted (paths may contain spaces).
function claude(args) {
  if (!isWin) {
    return spawnSync('claude', args, { encoding: 'utf8' })
  }
  const found = spawnSync('where', ['claude'], { encoding: 'utf8' }).stdout.split(/\r?\n/).filter(Boolean)
  const exe = found.find(path => /\.exe$/i.test(path))
  if (exe) {
    return spawnSync(exe, args, { encoding: 'utf8' })
  }
  const line = ['claude', ...args].map(arg => `"${arg.replace(/"/g, '""')}"`).join(' ')
  return spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { encoding: 'utf8', windowsVerbatimArguments: true })
}

function obscuraRegistered() {
  return claude(['mcp', 'get', 'obscura']).status === 0
}

function adhdInstalled() {
  const enabled = readSettings().enabledPlugins || {}
  return Object.keys(enabled).some(key => key.startsWith('i-have-adhd@') && enabled[key])
}

function check() {
  const settings = readSettings()
  return {
    configDir,
    rules: blockState(),
    worktreeBaseRef: settings.worktree?.baseRef ?? 'fresh (default)',
    obscuraBinary: findObscura() || null,
    obscuraMcp: obscuraRegistered(),
    iHaveAdhd: adhdInstalled(),
  }
}

function apply(options) {
  const done = []
  mkdirSync(configDir, { recursive: true })

  if (options.rules) {
    const current = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : ''
    // Keep the file's own line endings.
    const eol = current.includes('\r\n') ? '\r\n' : '\n'
    const text = rulesBlock().text.replace(/\n/g, eol)
    const start = current.indexOf(BEGIN)
    const end = current.indexOf(END)
    let next
    if (start !== -1 && end > start) {
      next = current.slice(0, start) + text + current.slice(end + END.length)
    } else {
      next = current.trimEnd() + (current.trim() ? eol + eol : '') + text + eol
    }
    if (next !== current) {
      backup(claudeMd)
      writeFileSync(claudeMd, next)
      done.push(`rules written to ${claudeMd}`)
    }
  }

  if (options.baseRef) {
    const settings = readSettings()
    if (settings.worktree?.baseRef !== options.baseRef) {
      backup(settingsFile)
      settings.worktree = { ...settings.worktree, baseRef: options.baseRef }
      writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n')
      done.push(`worktree.baseRef set to "${options.baseRef}" in ${settingsFile}`)
    }
  }

  if (options.obscura) {
    const binary = findObscura()
    if (!binary) {
      done.push('obscura not found on this machine: skipped (WebSearch/WebFetch stay the fallback)')
    } else if (obscuraRegistered()) {
      done.push('obscura MCP already registered')
    } else {
      const add = claude(['mcp', 'add', '--scope', 'user', 'obscura', '--', binary, 'mcp'])
      done.push(add.status === 0 ? `obscura MCP registered (user scope): ${binary} mcp` : `obscura MCP registration failed: ${add.stderr.trim()}`)
    }
  }
  return done.length ? done : ['nothing to change']
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'check') {
  console.log(JSON.stringify(check(), null, 2))
} else if (command === 'apply') {
  const baseRef = rest.includes('--base-ref') ? rest[rest.indexOf('--base-ref') + 1] ?? '' : ''
  if (rest.includes('--base-ref') && !['head', 'fresh'].includes(baseRef)) {
    console.error('--base-ref takes head or fresh')
    process.exit(1)
  }
  for (const line of apply({ rules: rest.includes('--rules'), baseRef, obscura: rest.includes('--obscura') })) {
    console.log(line)
  }
} else {
  console.error('usage: setup.mjs check | apply [--rules] [--base-ref head|fresh] [--obscura]')
  process.exit(1)
}
