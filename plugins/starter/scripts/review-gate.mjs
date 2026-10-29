#!/usr/bin/env node
// Review gate: makes the rules' "call code-review for larger changes" reliable on models that skip it.
//
//   SessionStart:  node review-gate.mjs start    snapshot the working tree as the session's review base
//   Stop:          node review-gate.mjs stop     if the change since the base crosses the threshold and code-review
//                                                wasn't called since, ask Claude once to run it before stopping
//   node review-gate.mjs on|off --data <dir>     turn the gate on or off (setup passes the plugin data dir)
//
// Off also with CLAUDE_STARTER_REVIEW_GATE=off in the environment (settings.json "env").
//
// Threshold, as in the rules: 2 or more non-test files with at least 15 changed lines in total, or more than 50
// non-test lines (docs not counted). Each change set is gated once: after a review, or after Claude answered the gate
// without one, the base moves to the current state. Changes that came from outside the session (pull, merge,
// checkout, reset, rebase in the reflog) also move the base. Any failure lets Claude stop.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const MIN_FILES = 2
export const MIN_FILES_LINES = 15
export const MIN_LINES = 50
const STATE_DAYS = 30
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|testdata|fixtures)\/|\.(test|spec)\.[^/]+$|_test\.go$|(^|\/)test_[^/]*\.py$/i
const DOC_PATH = /(^|\/)docs?\/|\.(md|mdx|markdown|rst|txt|adoc)$/i
const IGNORED_PATH = /(^|\/)\.claude\//
const REVIEW_CALL = /code-review/
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'])
const FOREIGN_REFLOG = /^(pull|merge|checkout|reset|rebase|cherry-pick|am)\b/

function git(cwd, args, env) {
  return execFileSync('git', ['-c', 'core.longpaths=true', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
  }).trim()
}

// A tree object for the working tree as it is now: tracked changes, staged or not, plus untracked files that
// .gitignore doesn't exclude. Built in the session's own index file (seeded from the real one), so the user's index
// is untouched and later snapshots reuse its stat cache.
export function snapshot(cwd, indexFile) {
  if (!existsSync(indexFile)) {
    const gitDir = git(cwd, ['rev-parse', '--absolute-git-dir'])
    if (existsSync(join(gitDir, 'index'))) {
      copyFileSync(join(gitDir, 'index'), indexFile)
    }
  }
  git(cwd, ['add', '-A', '--', ':/'], { GIT_INDEX_FILE: indexFile })
  return git(cwd, ['write-tree'], { GIT_INDEX_FILE: indexFile })
}

// Non-test, non-doc files changed between two trees, with their changed line counts.
export function changedCode(cwd, fromTree, toTree) {
  if (fromTree === toTree) {
    return []
  }
  const out = git(cwd, ['diff', '--numstat', '--no-renames', fromTree, toTree])
  return out.split('\n').filter(Boolean).map(line => {
    const [added, deleted, ...rest] = line.split('\t')
    return { path: rest.join('\t'), lines: (Number(added) || 0) + (Number(deleted) || 0) }
  }).filter(f => !TEST_PATH.test(f.path) && !DOC_PATH.test(f.path) && !IGNORED_PATH.test(f.path))
}

export function crosses(files) {
  const lines = files.reduce((sum, f) => sum + f.lines, 0)
  return { files: files.length, lines, over: (files.length >= MIN_FILES && lines >= MIN_FILES_LINES) || lines > MIN_LINES }
}

// What the transcript holds from line `from` on: a code-review call (the Skill tool from Claude, or the user typing
// /code-review), and any tool call that can change files. Complete lines only: a line still being written is read
// on the next check.
export function scanTranscript(transcriptPath, from) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { reviewed: false, edited: true, lines: from }
  }
  const lines = readFileSync(transcriptPath, 'utf8').split('\n').slice(0, -1)
  let reviewed = false
  let edited = false
  for (const line of lines.slice(from)) {
    if (!line.includes('tool_use') && !line.includes('code-review')) {
      continue
    }
    try {
      const entry = JSON.parse(line)
      const content = entry.message?.content
      if (entry.type === 'assistant' && Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_use') {
            continue
          }
          reviewed ||= block.name === 'Skill' && REVIEW_CALL.test(String(block.input?.skill ?? ''))
          edited ||= EDIT_TOOLS.has(block.name)
        }
      } else if (entry.type === 'user') {
        reviewed ||= /<command-name>\/code-review<\/command-name>/.test(typeof content === 'string' ? content : JSON.stringify(content))
      }
    } catch {
      // Not JSON: skip it.
    }
  }
  return { reviewed, edited, lines: lines.length }
}

// Whether HEAD moved since `head` through something other than this session's own commits: a pull, merge,
// checkout, reset or rebase in HEAD's reflog.
export function foreignMove(cwd, head) {
  if (!head) {
    return false
  }
  const current = git(cwd, ['rev-parse', 'HEAD'])
  if (current === head) {
    return false
  }
  const entries = git(cwd, ['reflog', '-n', '100', '--format=%H %gs', 'HEAD']).split('\n')
  for (const entry of entries) {
    const [sha, ...subject] = entry.split(' ')
    if (FOREIGN_REFLOG.test(subject.join(' '))) {
      return true
    }
    if (sha === head) {
      return false
    }
  }
  return true
}

function headOf(cwd) {
  try {
    return git(cwd, ['rev-parse', 'HEAD'])
  } catch {
    return null
  }
}

function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'claude-starter')
}

function sessionFiles(sessionId) {
  const dir = join(dataDir(), 'review-gate')
  const id = String(sessionId).replace(/[^\w-]/g, '_')
  return { dir, state: join(dir, `${id}.json`), index: join(dir, `${id}.index`) }
}

export function gateOff(dir = dataDir()) {
  return /^(off|0|false|no)$/i.test(process.env.CLAUDE_STARTER_REVIEW_GATE ?? '') || existsSync(join(dir, 'review-gate-off'))
}

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

function save(file, state) {
  writeFileSync(file, JSON.stringify(state))
}

// State and index files of sessions not seen for 30 days.
function prune(dir) {
  const cutoff = Date.now() - STATE_DAYS * 24 * 60 * 60 * 1000
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).mtimeMs < cutoff) {
      rmSync(path, { force: true })
    }
  }
}

function start(input) {
  const cwd = input.cwd || process.cwd()
  const files = sessionFiles(input.session_id)
  mkdirSync(files.dir, { recursive: true })
  prune(files.dir)
  rmSync(files.index, { force: true })
  save(files.state, { base: snapshot(cwd, files.index), head: headOf(cwd), transcriptLines: 0 })
}

function stop(input) {
  const cwd = input.cwd || process.cwd()
  const files = sessionFiles(input.session_id)
  mkdirSync(files.dir, { recursive: true })
  const state = existsSync(files.state)
    ? JSON.parse(readFileSync(files.state, 'utf8'))
    : { base: git(cwd, ['rev-parse', 'HEAD^{tree}']), head: headOf(cwd), transcriptLines: 0 }
  const scan = scanTranscript(input.transcript_path, state.transcriptLines)
  const foreign = foreignMove(cwd, state.head)
  if (!scan.reviewed && !scan.edited && !foreign && !input.stop_hook_active) {
    // Nothing since the last check could have changed files: skip the snapshot.
    save(files.state, { ...state, transcriptLines: scan.lines })
    return
  }
  const now = snapshot(cwd, files.index)
  const next = { base: now, head: headOf(cwd), transcriptLines: scan.lines }
  // Reviewed, answered the gate already, or the change came from outside the session: this state is the new base.
  if (scan.reviewed || input.stop_hook_active || foreign) {
    save(files.state, next)
    return
  }
  const changed = changedCode(cwd, state.base, now)
  const size = crosses(changed)
  if (!size.over) {
    save(files.state, { ...state, transcriptLines: scan.lines })
    return
  }
  save(files.state, { ...state, transcriptLines: scan.lines })
  const list = changed.slice(0, 8).map(f => f.path).join(', ') + (changed.length > 8 ? ', ...' : '')
  console.log(JSON.stringify({
    decision: 'block',
    reason: `claude-starter review gate: since the last review this session changed ${size.files} non-test file(s), ` +
      `${size.lines} line(s) (${list}). Call the code-review skill with the Skill tool (args \`medium\`). For each ` +
      'finding: reproduce it with a command or a throwaway test, then fix it; dismiss it only with evidence (the ' +
      'line you read, or a command you ran and its output); report it as unverified only if checking would take ' +
      'more than a few minutes or needs the user\'s decision. "The task\'s examples pass" and "it was like that ' +
      'before" are not evidence. If the change is only docs, a rename or formatting, if these changes were not made in ' +
      'this session (a pull, a merge, the user\'s own edits), or if a fan-out in progress will review them at its ' +
      'step 5, say so in one line and stop.',
  }))
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'on' || command === 'off') {
  const i = rest.indexOf('--data')
  const dir = i >= 0 ? rest[i + 1] : dataDir()
  mkdirSync(dir, { recursive: true })
  const flag = join(dir, 'review-gate-off')
  if (command === 'off') {
    writeFileSync(flag, '')
  } else {
    rmSync(flag, { force: true })
  }
  console.log(`review gate ${command}`)
} else if (command === 'start' || command === 'stop') {
  // A hook must never break a session: any error (not a git repo, no git, a bad state file) means "do nothing".
  try {
    if (!gateOff()) {
      const input = readInput()
      if (input.session_id) {
        command === 'start' ? start(input) : stop(input)
      }
    }
  } catch {
    // stay silent
  }
}
