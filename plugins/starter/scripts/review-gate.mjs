#!/usr/bin/env node
// Review gate: makes the rules' "call code-review for larger changes" reliable on models that skip it.
//
//   SessionStart:  node review-gate.mjs start    snapshot the working tree as the session's review base
//   Stop:          node review-gate.mjs stop     if the change since the base crosses the threshold and code-review
//                                                wasn't called since, ask Claude once to run it before stopping
//   node review-gate.mjs on|off --data <dir>     turn the gate on or off for this user
//
// Threshold, as in the rules: 2 or more non-test files, or more than 50 non-test lines (docs not counted). A review
// moves the base to the reviewed state, so the fixes that follow don't trigger a second review unless they grow past
// the threshold themselves. The gate blocks at most once in a row (stop_hook_active), and any failure lets Claude stop.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const MIN_FILES = 2
export const MIN_LINES = 50
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|testdata|fixtures)\/|\.(test|spec)\.[^/]+$|_test\.go$|(^|\/)test_[^/]*\.py$/i
const DOC_PATH = /(^|\/)docs?\/|\.(md|mdx|markdown|rst|txt|adoc)$/i
const IGNORED_PATH = /(^|\/)\.claude\//
const REVIEW_CALL = /code-review/

function git(cwd, args, env) {
  return execFileSync('git', ['-c', 'core.longpaths=true', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
  }).trim()
}

// A tree object for the working tree as it is now: tracked changes, staged or not, plus untracked files that
// .gitignore doesn't exclude. Built in a scratch index, so the user's index is untouched.
export function snapshot(cwd) {
  const gitDir = git(cwd, ['rev-parse', '--absolute-git-dir'])
  const scratch = join(tmpdir(), `starter-gate-${process.pid}-${Date.now()}.index`)
  try {
    if (existsSync(join(gitDir, 'index'))) {
      copyFileSync(join(gitDir, 'index'), scratch)
    }
    git(cwd, ['add', '-A', '--', ':/'], { GIT_INDEX_FILE: scratch })
    return git(cwd, ['write-tree'], { GIT_INDEX_FILE: scratch })
  } finally {
    rmSync(scratch, { force: true })
  }
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
  return { files: files.length, lines, over: files.length >= MIN_FILES || lines > MIN_LINES }
}

// Whether the transcript, from line `from` on, holds a code-review call: the Skill tool from Claude, or the user
// typing /code-review. Returns the transcript's line count too, so the next check starts after it.
export function reviewSince(transcriptPath, from) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { reviewed: false, lines: from }
  }
  // Complete lines only: a line still being written is read on the next check.
  const lines = readFileSync(transcriptPath, 'utf8').split('\n').slice(0, -1)
  let reviewed = false
  for (const line of lines.slice(from)) {
    if (!line.includes('code-review')) {
      continue
    }
    try {
      const entry = JSON.parse(line)
      const content = entry.message?.content
      if (entry.type === 'assistant' && Array.isArray(content)) {
        reviewed ||= content.some(b => b?.type === 'tool_use' && b.name === 'Skill' && REVIEW_CALL.test(String(b.input?.skill ?? '')))
      } else if (entry.type === 'user') {
        reviewed ||= /<command-name>\/code-review<\/command-name>/.test(typeof content === 'string' ? content : JSON.stringify(content))
      }
    } catch {
      // Not JSON: skip it.
    }
  }
  return { reviewed, lines: lines.length }
}

function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'claude-starter')
}

function statePath(sessionId) {
  return join(dataDir(), 'review-gate', `${String(sessionId).replace(/[^\w-]/g, '_')}.json`)
}

export function gateOff(dir = dataDir()) {
  return existsSync(join(dir, 'review-gate-off'))
}

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

function save(sessionId, state) {
  const file = statePath(sessionId)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(state))
}

function start(input) {
  const cwd = input.cwd || process.cwd()
  save(input.session_id, { base: snapshot(cwd), transcriptLines: 0 })
}

function stop(input) {
  const cwd = input.cwd || process.cwd()
  const file = statePath(input.session_id)
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { base: git(cwd, ['rev-parse', 'HEAD^{tree}']), transcriptLines: 0 }
  const now = snapshot(cwd)
  const review = reviewSince(input.transcript_path, state.transcriptLines)
  if (review.reviewed) {
    // Reviewed since the last check: what is there now counts as reviewed.
    save(input.session_id, { base: now, transcriptLines: review.lines })
    return
  }
  const files = changedCode(cwd, state.base, now)
  const size = crosses(files)
  if (!size.over || input.stop_hook_active) {
    save(input.session_id, { ...state, transcriptLines: review.lines })
    return
  }
  save(input.session_id, { ...state, transcriptLines: review.lines })
  const list = files.slice(0, 8).map(f => f.path).join(', ') + (files.length > 8 ? ', ...' : '')
  console.log(JSON.stringify({
    decision: 'block',
    reason: `claude-starter review gate: since the last review this session changed ${size.files} non-test file(s), ` +
      `${size.lines} line(s) (${list}). Call the code-review skill with the Skill tool (args \`medium\`), then fix or ` +
      'report what it finds. If the change is only docs, a rename or formatting, say so in one line and stop.',
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
