// Per-project setup reminders: whether this repository has a REVIEW.md and has run claude-code-setup.
// State lives in ${CLAUDE_PLUGIN_DATA}/projects.json, keyed by the absolute git common dir, so a repository and all
// its worktrees share one entry:
//   { "/abs/repo/.git": { "review-md": "declined", "project-setup": "done" | "declined", "reminded": "YYYY-MM-DD" } }
// A missing file, entry or value means "unknown". A file that exists but is not a JSON object is left untouched
// and the session notice stays silent until the user fixes or deletes it. Nothing is ever written into the repository.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './rules-block.mjs'

export const STEPS = ['review-md', 'project-setup']
export const MAX_PROJECTS = 200
export const stateFile = dataDir => join(dataDir, 'projects.json')
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// { root: git toplevel, key: absolute git common dir } for cwd, or null outside a repository or in one without commits.
export function projectInfo(cwd) {
  const git = args => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim().split(/\r?\n/)
  try {
    // One call for both values; HEAD fails in a repository without commits.
    const [root, key] = git(['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir', 'HEAD'])
    return root && key ? { root, key } : null
  } catch {
    try {
      // git older than 2.31 has no --path-format: key by the toplevel.
      const [root] = git(['rev-parse', '--show-toplevel', 'HEAD'])
      return root ? { root, key: root } : null
    } catch {
      return null
    }
  }
}

// The saved state, {} when the file is missing, null when it exists but is not a JSON object.
function readAll(dataDir) {
  if (!dataDir) {
    return {}
  }
  try {
    const all = JSON.parse(readFileSync(stateFile(dataDir), 'utf8'))
    return isObject(all) ? all : null
  } catch (error) {
    return error?.code === 'ENOENT' ? {} : null
  }
}

export const stateUnreadable = dataDir => readAll(dataDir) === null

const entryOf = (all, key) => (Object.hasOwn(all, key) && isObject(all[key]) ? all[key] : {})

// Sets one field of a project's entry (value null removes it). Returns false when the file is unreadable and was
// left alone. At most MAX_PROJECTS entries are kept: the ones reminded longest ago (or never) go first.
function setField(dataDir, key, field, value) {
  const all = readAll(dataDir)
  if (all === null) {
    return false
  }
  const entry = { ...entryOf(all, key) }
  if (value === null) {
    delete entry[field]
  } else {
    entry[field] = value
  }
  const next = { ...all, [key]: entry }
  const reminded = name => (isObject(next[name]) && typeof next[name].reminded === 'string' ? next[name].reminded : '')
  const others = Object.keys(next).filter(name => name !== key).sort((a, b) => reminded(a).localeCompare(reminded(b)))
  for (const name of others.slice(0, Math.max(0, others.length + 1 - MAX_PROJECTS))) {
    delete next[name]
  }
  mkdirSync(dataDir, { recursive: true })
  // Written beside the file and renamed over it, so a concurrent or interrupted write never leaves half a file.
  const temp = `${stateFile(dataDir)}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(next, null, 2) + '\n')
  renameSync(temp, stateFile(dataDir))
  return true
}

export const setStep = (dataDir, project, step, state) => setField(dataDir, project.key, step, state)

export function claudeCodeSetupInstalled() {
  try {
    const installed = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'))
    const enabled = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')).enabledPlugins
    return isObject(installed.plugins) && isObject(enabled) && Object.keys(installed.plugins).some(name => name.startsWith('claude-code-setup@') && enabled[name] === true)
  } catch {
    return false
  }
}

// Each step is 'unknown', 'done' or 'declined'.
export function stepStates(dataDir, project) {
  const entry = entryOf(readAll(dataDir) ?? {}, project.key)
  const saved = step => (entry[step] === 'done' || entry[step] === 'declined' ? entry[step] : 'unknown')
  const otherSetup = ['CLAUDE.md', 'AGENTS.md'].some(name => existsSync(join(project.root, name)))
  return {
    'review-md': existsSync(join(project.root, 'REVIEW.md')) ? 'done' : saved('review-md') === 'declined' ? 'declined' : 'unknown',
    'project-setup': otherSetup || saved('project-setup') === 'done' ? 'done' : saved('project-setup'),
  }
}

export function markProjectSetupRun(dataDir, cwd) {
  const project = projectInfo(cwd)
  if (project) {
    setStep(dataDir, project, 'project-setup', 'done')
  }
}

// The line for the session notice and a function that records it as shown today, or null when nothing is unknown,
// it was already shown today, or this is no project. Recording is separate so the caller can do it after printing.
export function setupNote(dataDir, cwd, today) {
  const project = projectInfo(cwd)
  if (!project) {
    return null
  }
  // An unreadable state file can't record the throttle, so say nothing rather than repeat every session.
  if (stateUnreadable(dataDir)) {
    return null
  }
  const states = stepStates(dataDir, project)
  const open = []
  if (states['review-md'] === 'unknown') {
    open.push({ has: 'has no REVIEW.md', run: '/starter:review-setup', skip: 'skip review-md' })
  }
  if (states['project-setup'] === 'unknown' && claudeCodeSetupInstalled()) {
    open.push({ has: "hasn't run claude-code-setup", run: '/claude-code-setup:claude-automation-recommender', skip: 'skip project-setup' })
  }
  if (!open.length || entryOf(readAll(dataDir) ?? {}, project.key).reminded === today) {
    return null
  }
  const each = key => open.map(step => step[key])
  return {
    text: `this project ${each('has').join(' and ')}: run ${each('run').join(' and ')}, or /starter:setup ${each('skip').join(' / ')} to stop asking here`,
    markShown: () => setField(dataDir, project.key, 'reminded', today),
  }
}
