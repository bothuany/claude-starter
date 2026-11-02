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
// non-test lines (docs, lockfiles, generated files and pure renames not counted; whitespace-only changes neither).
// Each change set is gated once: after a review, or after Claude answered the gate
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
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|testdata|fixtures|e2e)\/|\.(test|spec)\.[^/]+$|_(test|spec)\.[^/]+$|(^|\/)(test_[^/]*|conftest)\.py$/i
// FooTest.java, BarTests.cs: case-sensitive, so Contest.java or Latest.kt stay code.
const CLASS_TEST_PATH = /(^|\/)[A-Z][A-Za-z0-9]*Tests?\.(java|kt|cs)$/
const DOC_PATH = /(^|\/)docs?\/|\.(md|mdx|markdown|rst|txt|adoc)$/i
const IGNORED_PATH = /(^|\/)\.claude\//
// Lockfiles and build output: changed by tools, not written by hand.
const GENERATED_PATH = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|bun\.lockb|go\.sum|[^/]+\.lock)$|(^|\/)(dist|build|out|coverage|__snapshots__)\/|\.(min\.[^/]+|snap|map)$/i
// Untracked files larger than this are left out of snapshots: hashing them can outlast the hook's timeout.
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024
const REVIEW_CALL = /code-review/
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'])
const FOREIGN_REFLOG = /^(pull|merge|checkout|reset|rebase|cherry-pick|am)\b/

function git(cwd, args, env, input) {
  return execFileSync('git', ['-c', 'core.longpaths=true', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env }, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim()
}

// The environment for git commands that read or write snapshot objects: the session's own index, and its own object
// dir with the repository's objects as an alternate, so snapshots never write into the user's .git.
export function snapshotEnv(cwd, files) {
  const objects = git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])
  mkdirSync(files.objects, { recursive: true })
  return { GIT_INDEX_FILE: files.index, GIT_OBJECT_DIRECTORY: files.objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects }
}

// A tree object for the working tree as it is now: tracked changes, staged or not, plus untracked files that
// .gitignore doesn't exclude (except large ones). Built in the session's own index file (seeded from the real one),
// so the user's index is untouched and later snapshots reuse its stat cache.
export function snapshot(cwd, files) {
  const env = snapshotEnv(cwd, files)
  if (!existsSync(files.index)) {
    const gitDir = git(cwd, ['rev-parse', '--absolute-git-dir'])
    if (existsSync(join(gitDir, 'index'))) {
      copyFileSync(join(gitDir, 'index'), files.index)
    }
  }
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  // --full-name: paths from the top, whatever folder the session runs in.
  const large = git(cwd, ['ls-files', '-o', '--exclude-standard', '-z', '--full-name', '--', ':/']).split('\0').filter(Boolean)
    .filter(path => {
      try {
        return statSync(join(top, path)).size > MAX_UNTRACKED_BYTES
      } catch {
        return false
      }
    })
  // Pathspecs on stdin: one argument per large file could pass the command-line length limit.
  const pathspecs = [':/', ...large.map(path => `:(top,exclude,literal)${path}`)].join('\0')
  git(cwd, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], env, pathspecs)
  return git(cwd, ['write-tree'], env)
}

// Hand-written code files changed between two trees, with their changed line counts. Renames are followed and
// whitespace is ignored, so a pure rename or a reformat counts as no change.
export function changedCode(cwd, fromTree, toTree, env) {
  if (fromTree === toTree) {
    return []
  }
  // -z: raw paths (no quoting of non-ASCII names). A record is "added<TAB>deleted<TAB>path", or for a rename
  // "added<TAB>deleted<TAB>" followed by the old and the new path as two more records; the new path is the one judged.
  const records = git(cwd, ['diff', '--numstat', '-z', '-M', '-w', fromTree, toTree], env).split('\0')
  const files = []
  for (let i = 0; i < records.length; i++) {
    const [added, deleted, path] = records[i].split('\t')
    if (path === undefined) {
      continue
    }
    files.push({ path: path === '' ? records[(i += 2)] : path, lines: (Number(added) || 0) + (Number(deleted) || 0) })
  }
  return files.filter(f => f.path && f.lines > 0 &&
    ![TEST_PATH, CLASS_TEST_PATH, DOC_PATH, IGNORED_PATH, GENERATED_PATH].some(re => re.test(f.path)))
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
// checkout, reset or rebase in HEAD's reflog. An entry that left HEAD on the same commit (`checkout -b`, `switch -c`)
// brought nothing in, so Claude branching before it commits its own work doesn't hide that work from the gate.
// Claude's own merge, pull or rebase still count as foreign; the fan-out-run workflow reviews its merges itself.
export function foreignMove(cwd, head) {
  if (!head) {
    return false
  }
  const current = git(cwd, ['rev-parse', 'HEAD'])
  if (current === head) {
    return false
  }
  const entries = git(cwd, ['reflog', '-n', '100', '--format=%H %gs', 'HEAD']).split('\n').map(line => {
    const [sha, ...subject] = line.split(' ')
    return { sha, subject: subject.join(' ') }
  })
  // The entry that reached `head` is what put HEAD there before the session, so stop before judging it.
  for (const [i, { sha, subject }] of entries.entries()) {
    if (sha === head) {
      return false
    }
    const moved = !entries[i + 1] || entries[i + 1].sha !== sha
    if (moved && FOREIGN_REFLOG.test(subject)) {
      return true
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
  return { dir, state: join(dir, `${id}.json`), index: join(dir, `${id}.index`), objects: join(dir, `${id}.objects`) }
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

// State, index and object dirs of sessions not seen for 30 days.
function prune(dir) {
  const cutoff = Date.now() - STATE_DAYS * 24 * 60 * 60 * 1000
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).mtimeMs < cutoff) {
      rmSync(path, { force: true, recursive: true })
    }
  }
}

function start(input, files = sessionFiles(input.session_id), transcriptLines = 0) {
  const cwd = input.cwd || process.cwd()
  mkdirSync(files.dir, { recursive: true })
  prune(files.dir)
  rmSync(files.index, { force: true })
  rmSync(files.objects, { force: true, recursive: true })
  save(files.state, { base: snapshot(cwd, files), head: headOf(cwd), transcriptLines })
}

function stop(input) {
  const cwd = input.cwd || process.cwd()
  const files = sessionFiles(input.session_id)
  mkdirSync(files.dir, { recursive: true })
  if (!existsSync(files.state)) {
    // No base (a session the start hook missed, or pruned state): the tree as it is now becomes the base. Falling back
    // to HEAD would count changes that other sessions or the user made before this one as this session's work.
    start(input, files, scanTranscript(input.transcript_path, 0).lines)
    return
  }
  const state = JSON.parse(readFileSync(files.state, 'utf8'))
  const scan = scanTranscript(input.transcript_path, state.transcriptLines)
  const foreign = foreignMove(cwd, state.head)
  if (!scan.reviewed && !scan.edited && !foreign && !input.stop_hook_active) {
    // Nothing since the last check could have changed files: skip the snapshot.
    save(files.state, { ...state, transcriptLines: scan.lines })
    return
  }
  const now = snapshot(cwd, files)
  const next = { base: now, head: headOf(cwd), transcriptLines: scan.lines }
  // Reviewed, answered the gate already, or the change came from outside the session: this state is the new base.
  if (scan.reviewed || input.stop_hook_active || foreign) {
    save(files.state, next)
    return
  }
  const changed = changedCode(cwd, state.base, now, snapshotEnv(cwd, files))
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
      'this session (a pull, a merge, the user\'s own edits), or if the fan-out-run workflow already reviewed them or ' +
      'will, say so in one line and stop.',
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
