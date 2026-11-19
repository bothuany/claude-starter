#!/usr/bin/env node
// User-level setup for claude-starter: the settings and MCP servers a plugin can't ship itself, written only when the
// /starter:setup skill has shown the plan and the user agreed. The rules need no setup: the plugin's SessionStart
// hook injects them.
//
//   node setup.mjs check [--data <plugin data dir>]   report what is installed, as JSON
//   node setup.mjs apply [--rules on|off] [--remove-old-rules] [--context7] [--review-gate on|off]
//                        [--data <plugin data dir>]
//   node setup.mjs skip|unskip review-md|project-setup --data <plugin data dir>   stop or resume asking about it in this project
//
// It writes flags in the plugin's data dir (rules off, review gate off), the user-scope context7 MCP server
// through `claude mcp add`, and removes the old marked copy of the rules (versions before 0.8) from the user's
// CLAUDE.md. Files it changes are backed up next to themselves first, with a timestamp, so no backup
// is ever overwritten. An old block with unbalanced or out-of-order markers is reported and left alone.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { claudeMd, configDir, findBlock, oldBlockState, rulesOff } from './rules-block.mjs'
import { gateOff } from './review-gate.mjs'
import { STEPS, claudeCodeSetupInstalled, projectInfo, setStep, stateFile, stateUnreadable, stepStates } from './project-setup.mjs'

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

// Enabled in the effective settings, from any marketplace: the project's local settings override its shared ones,
// which override the user's.
function pluginEnabled(name) {
  const files = [settingsFile, join(process.cwd(), '.claude', 'settings.json'), join(process.cwd(), '.claude', 'settings.local.json')]
  const enabled = Object.assign({}, ...files.map(file => readSettings(file, file === settingsFile).enabledPlugins || {}))
  return Object.keys(enabled).some(key => key.startsWith(`${name}@`) && enabled[key])
}

function check(dataDir) {
  readSettings()
  const project = projectInfo(process.cwd())
  return {
    configDir,
    project: process.cwd(),
    node: process.version,
    rules: rulesOff(dataDir) ? 'off' : 'on',
    oldRulesBlock: oldBlockState(),
    context7Mcp: mcpRegistered('context7'),
    iHaveAdhd: pluginEnabled('i-have-adhd'),
    ponytail: pluginEnabled('ponytail'),
    reviewGate: dataDir && gateOff(dataDir) ? 'off' : 'on',
    projectReminders: project ? { root: project.root, ...stepStates(dataDir, project), claudeCodeSetupInstalled: claudeCodeSetupInstalled(), ...(dataDir && stateUnreadable(dataDir) ? { stateFile: `unreadable (not a valid JSON object; fix or delete it): ${stateFile(dataDir)}` } : {}) } : 'not in a git repository with commits',
  }
}

function apply(options) {
  const done = []
  mkdirSync(configDir, { recursive: true })

  if (options.removeOldRules) {
    const current = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : ''
    const block = findBlock(current)
    if (block === 'broken') {
      done.push(`old rules not removed: ${claudeMd} has unbalanced or out-of-order claude-starter markers. Delete every line from "<!-- claude-starter:begin" to "<!-- claude-starter:end -->" (and any stray marker) by hand.`)
    } else if (block) {
      // Drop the block and the blank lines around it, keeping the rest of the file and its line endings as they are.
      const eol = current.includes('\r\n') ? '\r\n' : '\n'
      const before = current.slice(0, block.start).trimEnd()
      const after = current.slice(block.end).trimStart()
      const next = before && after ? before + eol + eol + after : (before || after) && (before || after).trimEnd() + eol
      backup(claudeMd)
      writeFileSync(claudeMd, next)
      done.push(`old rules block removed from ${claudeMd}`)
    }
  }

  if (options.rules) {
    mkdirSync(options.dataDir, { recursive: true })
    for (const name of ['rules-off', 'rules-skipped']) {
      rmSync(join(options.dataDir, name), { force: true })
    }
    if (options.rules === 'off') {
      writeFileSync(join(options.dataDir, 'rules-off'), '')
    }
    done.push(`rules ${options.rules} (from the next session)`)
    if (options.rules === 'off' && oldBlockState() !== 'none') {
      done.push(`note: the old copy of the rules in ${claudeMd} still loads; remove it (--remove-old-rules, or by hand if its markers are broken) to turn them off fully`)
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
      const add = claude(['mcp', 'add', '-s', 'user', '--transport', 'http', 'context7', 'https://mcp.context7.com/mcp'])
      done.push(add.status === 0 ? 'context7 MCP registered (user scope): https://mcp.context7.com/mcp' : `context7 MCP registration failed: ${failure(add)}`)
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
  const rules = value('--rules')
  if (rest.includes('--rules') && !['on', 'off'].includes(rules)) {
    console.error('--rules takes on or off')
    process.exit(1)
  }
  if (rules && !dataDir) {
    console.error('--rules needs --data <plugin data dir>')
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
  const options = { rules, removeOldRules: rest.includes('--remove-old-rules'), context7: rest.includes('--context7'), reviewGate, dataDir }
  for (const line of apply(options)) {
    console.log(line)
  }
} else if (command === 'skip' || command === 'unskip') {
  const [step] = rest
  const project = projectInfo(process.cwd())
  if (!STEPS.includes(step) || !dataDir || !project) {
    console.error(!project ? 'not in a git repository with commits' : `usage: setup.mjs ${command} ${STEPS.join('|')} --data <dir>`)
    process.exit(1)
  }
  // Clearing the stamp on unskip makes the reminder come back at the next session.
  const written = setStep(dataDir, project, step, command === 'skip' ? 'declined' : null) && (command === 'skip' || setStep(dataDir, project, 'reminded', null))
  if (!written) {
    console.error(`${stateFile(dataDir)} is not a valid JSON object; fix or delete it first, nothing was changed.`)
    process.exit(1)
  }
  console.log(command === 'skip' ? `${step}: declined for ${project.root} (and its worktrees)` : `${step}: back to unknown for ${project.root} (and its worktrees)`)
} else {
  console.error('usage: setup.mjs check [--data <dir>] | skip|unskip review-md|project-setup --data <dir> | apply [--rules on|off] [--remove-old-rules] [--context7] [--review-gate on|off] [--data <dir>]')
  process.exit(1)
}
