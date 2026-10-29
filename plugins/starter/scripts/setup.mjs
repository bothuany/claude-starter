#!/usr/bin/env node
// User-level setup for claude-starter. A plugin can't ship CLAUDE.md or settings, so this script writes them,
// and only when the /starter:setup skill has shown the plan and the user agreed.
//
//   node setup.mjs check [--data <plugin data dir>]   report what is installed, as JSON
//   node setup.mjs apply [--rules | --skip-rules] [--base-ref head|fresh [--scope project|user]] [--context7] [--obscura]
//                        [--review-gate on|off] [--data <plugin data dir>]
//
// Everything it writes lives in the Claude config dir (CLAUDE_CONFIG_DIR or ~/.claude), plus a "rules skipped" flag
// in the plugin's data dir, user-scope MCP servers (context7, obscura) through `claude mcp add`, and, for
// --base-ref with the default project scope, the current project's .claude/settings.local.json. Files it changes are backed up next to themselves first, with a timestamp, so no backup
// is ever overwritten. The rules go between markers, so re-running replaces them in place and nothing else in the
// user's CLAUDE.md is touched; markers that are unbalanced or out of order are reported and left alone.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { blockState, claudeMd, configDir, findBlock, rulesBlock, rulesSkipped } from './rules-block.mjs'
import { gateOff } from './review-gate.mjs'

const settingsFile = join(configDir, 'settings.json')
const isWin = process.platform === 'win32'

// A settings file that isn't a valid JSON object stops the script before anything is written.
function readSettings(file = settingsFile, exitOnError = true) {
  if (!existsSync(file)) {
    return {}
  }
  let settings
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    settings = null
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    if (!exitOnError) {
      return {}
    }
    console.error(`${file} is not a valid JSON object; fix it first, nothing was changed.`)
    process.exit(1)
  }
  return settings
}

// <file>.<timestamp>.starter-backup; never overwrites an earlier backup.
function backup(file) {
  if (!existsSync(file)) {
    return
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  let target = `${file}.${stamp}.starter-backup`
  for (let n = 2; existsSync(target); n++) {
    target = `${file}.${stamp}-${n}.starter-backup`
  }
  copyFileSync(file, target)
}

// The first match for a program on PATH; '' when there is none. On Windows, `where $PATH:<name>` searches PATH only:
// plain `where` looks in the current folder first, which could pick up a binary that happens to sit in a repository.
function onPath(name) {
  const lookup = isWin ? spawnSync('where', [`$PATH:${name}`], { encoding: 'utf8' }) : spawnSync('which', [name], { encoding: 'utf8' })
  return lookup.status === 0 ? (lookup.stdout ?? '').trim().split(/\r?\n/).filter(Boolean) : []
}

// The obscura binary, from PATH or the usual install folders; '' when it isn't installed.
function findObscura() {
  const found = onPath('obscura')[0]
  if (found) {
    return found
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
  const found = onPath('claude')
  const exe = found.find(path => /\.exe$/i.test(path))
  if (exe) {
    return spawnSync(exe, args, { encoding: 'utf8' })
  }
  // The shim's full path from PATH, never the bare name: cmd.exe would look in the current folder first.
  const shim = found.find(path => /\.(cmd|bat)$/i.test(path))
  if (!shim) {
    return { status: null, stderr: 'claude was not found on PATH' }
  }
  const line = [shim, ...args].map(arg => `"${arg.replace(/"/g, '""')}"`).join(' ')
  return spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { encoding: 'utf8', windowsVerbatimArguments: true })
}

const failure = result => (result.stderr || result.error?.message || `exit ${result.status}`).trim()

// Registered in any scope: a context7 the user added themselves counts, so setup never adds a second one.
const mcpRegistered = name => claude(['mcp', 'get', name]).status === 0

// The settings files for worktree.baseRef, lowest precedence first: user, then the project's shared and local files.
const projectSettings = name => join(process.cwd(), '.claude', name)
function baseRefs() {
  const read = file => readSettings(file, file === settingsFile).worktree?.baseRef ?? null
  const user = read(settingsFile)
  const project = read(projectSettings('settings.json'))
  const local = read(projectSettings('settings.local.json'))
  return { user, project, local, effective: local ?? project ?? user ?? 'fresh (default)' }
}

// Enabled in the effective settings, from any marketplace: the project's local settings override its shared ones,
// which override the user's.
function pluginEnabled(name) {
  const files = [settingsFile, join(process.cwd(), '.claude', 'settings.json'), join(process.cwd(), '.claude', 'settings.local.json')]
  const enabled = Object.assign({}, ...files.map(file => readSettings(file, file === settingsFile).enabledPlugins || {}))
  return Object.keys(enabled).some(key => key.startsWith(`${name}@`) && enabled[key])
}

function check(dataDir) {
  readSettings()
  return {
    configDir,
    project: process.cwd(),
    node: process.version,
    rules: blockState(),
    rulesSkipped: rulesSkipped(dataDir),
    worktreeBaseRef: baseRefs(),
    context7Mcp: mcpRegistered('context7'),
    obscuraBinary: findObscura() || null,
    obscuraMcp: mcpRegistered('obscura'),
    iHaveAdhd: pluginEnabled('i-have-adhd'),
    ponytail: pluginEnabled('ponytail'),
    reviewGate: dataDir && gateOff(dataDir) ? 'off' : 'on',
  }
}

function apply(options) {
  const done = []
  mkdirSync(configDir, { recursive: true })

  if (options.rules) {
    const current = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : ''
    const block = findBlock(current)
    if (block === 'broken') {
      done.push(`rules not written: ${claudeMd} has unbalanced or out-of-order claude-starter markers. Delete every line from "<!-- claude-starter:begin" to "<!-- claude-starter:end -->" (and any stray marker) by hand, then run setup again.`)
    } else {
      // Keep the file's own line endings.
      const eol = current.includes('\r\n') ? '\r\n' : '\n'
      const text = rulesBlock().text.replace(/\n/g, eol)
      const next = block
        ? current.slice(0, block.start) + text + current.slice(block.end)
        : current.trimEnd() + (current.trim() ? eol + eol : '') + text + eol
      if (next !== current) {
        backup(claudeMd)
        writeFileSync(claudeMd, next)
        done.push(`rules written to ${claudeMd}`)
      }
      // The rules are in place now, so an earlier skip no longer applies.
      if (options.dataDir) {
        rmSync(join(options.dataDir, 'rules-skipped'), { force: true })
      }
    }
  } else if (options.skipRules) {
    mkdirSync(options.dataDir, { recursive: true })
    writeFileSync(join(options.dataDir, 'rules-skipped'), '')
    done.push('rules skipped: the session-start notice about them stays quiet until you apply them with /starter:setup (unbalanced markers are still reported)')
  }

  if (options.baseRef) {
    // Project scope writes the project's own, personal settings.local.json, so `claude --worktree` sessions in
    // other projects keep starting from a clean default branch.
    const file = options.scope === 'user' ? settingsFile : projectSettings('settings.local.json')
    const settings = readSettings(file)
    if (settings.worktree?.baseRef !== options.baseRef) {
      backup(file)
      mkdirSync(join(file, '..'), { recursive: true })
      settings.worktree = { ...settings.worktree, baseRef: options.baseRef }
      writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
      done.push(`worktree.baseRef set to "${options.baseRef}" in ${file}`)
    }
    const effective = baseRefs().effective
    if (effective !== options.baseRef) {
      done.push(`note: a higher-precedence settings file still sets worktree.baseRef to "${effective}" for this project`)
    }
  }

  if (options.reviewGate) {
    mkdirSync(options.dataDir, { recursive: true })
    const flag = join(options.dataDir, 'review-gate-off')
    if (options.reviewGate === 'off') {
      writeFileSync(flag, '')
    } else {
      rmSync(flag, { force: true })
    }
    done.push(`review gate ${options.reviewGate}`)
  }

  if (options.context7) {
    if (mcpRegistered('context7')) {
      done.push('context7 MCP already registered')
    } else {
      const add = claude(['mcp', 'add', '--scope', 'user', '--transport', 'http', 'context7', 'https://mcp.context7.com/mcp'])
      done.push(add.status === 0 ? 'context7 MCP registered (user scope): https://mcp.context7.com/mcp' : `context7 MCP registration failed: ${failure(add)}`)
    }
  }

  if (options.obscura) {
    const binary = findObscura()
    if (!binary) {
      done.push('obscura not found on this machine: skipped (WebSearch/WebFetch stay the fallback)')
    } else if (mcpRegistered('obscura')) {
      done.push('obscura MCP already registered')
    } else {
      const add = claude(['mcp', 'add', '--scope', 'user', 'obscura', '--', binary, 'mcp'])
      done.push(add.status === 0 ? `obscura MCP registered (user scope): ${binary} mcp` : `obscura MCP registration failed: ${failure(add)}`)
    }
  }
  return done.length ? done : ['nothing to change']
}

const [command, ...rest] = process.argv.slice(2)
const value = flag => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] ?? '' : '')
const dataDir = value('--data')
if (command === 'check') {
  console.log(JSON.stringify(check(dataDir), null, 2))
} else if (command === 'apply') {
  const baseRef = value('--base-ref')
  if (rest.includes('--base-ref') && !['head', 'fresh'].includes(baseRef)) {
    console.error('--base-ref takes head or fresh')
    process.exit(1)
  }
  if (rest.includes('--rules') && rest.includes('--skip-rules')) {
    console.error('--rules and --skip-rules exclude each other')
    process.exit(1)
  }
  if (rest.includes('--skip-rules') && !dataDir) {
    console.error('--skip-rules needs --data <plugin data dir>')
    process.exit(1)
  }
  const scope = value('--scope') || 'project'
  if (!['project', 'user'].includes(scope)) {
    console.error('--scope takes project or user')
    process.exit(1)
  }
  const reviewGate = value('--review-gate')
  if (rest.includes('--review-gate') && !['on', 'off'].includes(reviewGate)) {
    console.error('--review-gate takes on or off')
    process.exit(1)
  }
  if (reviewGate && !dataDir) {
    console.error('--review-gate needs --data <plugin data dir>')
    process.exit(1)
  }
  const options = { rules: rest.includes('--rules'), skipRules: rest.includes('--skip-rules'), baseRef, scope, context7: rest.includes('--context7'), obscura: rest.includes('--obscura'), reviewGate, dataDir }
  for (const line of apply(options)) {
    console.log(line)
  }
} else {
  console.error('usage: setup.mjs check [--data <dir>] | apply [--rules | --skip-rules] [--base-ref head|fresh [--scope project|user]] [--context7] [--obscura] [--review-gate on|off] [--data <dir>]')
  process.exit(1)
}
