// Regression tests for the starter's scripts, run in throwaway repositories and config dirs: `node --test test/scripts.test.mjs`.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'starter', 'scripts')
const isWin = process.platform === 'win32'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const run = (script, args, cwd, env = {}) => {
  const result = spawnSync(process.execPath, [join(scripts, script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  return { out: result.stdout.trim(), err: result.stderr.trim(), status: result.status }
}
const worktrees = (cwd, ...args) => run('worktrees.mjs', args, cwd)

// A repository on main with one commit, plus a linked worktree on branch w.
function repoWithWorktree() {
  const root = mkdtempSync(join(tmpdir(), 'starter-test-'))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, 'a.txt'), 'a')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  const wt = join(root, 'wt')
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'w')
  return { root, repo, wt }
}

function link(target, path) {
  if (isWin) {
    execFileSync('cmd', ['/c', 'mklink', '/J', path, target], { stdio: 'ignore' })
  } else {
    symlinkSync(target, path)
  }
}

test('remove keeps a worktree whose git status fails', () => {
  const { repo, wt } = repoWithWorktree()
  writeFileSync(join(wt, 'work.txt'), 'precious')
  // Replaced, not overwritten: Windows refuses to open the hidden .git file for writing.
  rmSync(join(wt, '.git'))
  writeFileSync(join(wt, '.git'), 'gitdir: /nonexistent\n')
  assert.match(worktrees(repo, 'remove', wt).out, /skipped .*git could not read its status/)
  assert.ok(existsSync(join(wt, 'work.txt')))
})

test('remove sees untracked files even with status.showUntrackedFiles=no', () => {
  const { repo, wt } = repoWithWorktree()
  git(repo, 'config', 'status.showUntrackedFiles', 'no')
  writeFileSync(join(wt, 'work.txt'), 'precious')
  assert.match(worktrees(repo, 'remove', wt).out, /skipped .*uncommitted changes/)
  assert.ok(existsSync(join(wt, 'work.txt')))
})

test('remove unlinks links first and leaves their targets alone', () => {
  const { repo, wt } = repoWithWorktree()
  mkdirSync(join(repo, 'shared'))
  writeFileSync(join(repo, 'shared', 'canary.txt'), 'keep')
  link(join(repo, 'shared'), join(wt, 'shared'))
  mkdirSync(join(wt, 'untracked-dir'))
  link(join(repo, 'shared'), join(wt, 'untracked-dir', 'nested'))
  // untracked-dir holds only a link, so it is not work of its own; the worktree counts as clean.
  assert.match(worktrees(repo, 'remove', wt).out, /removed .*\(2 link\(s\) unlinked first\)/)
  assert.ok(!existsSync(wt))
  assert.equal(readFileSync(join(repo, 'shared', 'canary.txt'), 'utf8'), 'keep')
})

test('remove keeps a detached worktree whose commits are on no branch', () => {
  const { repo, root } = repoWithWorktree()
  const wt = join(root, 'detached')
  git(repo, 'worktree', 'add', '-q', '--detach', wt)
  writeFileSync(join(wt, 'b.txt'), 'b')
  git(wt, 'add', '.')
  git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'orphan')
  assert.match(worktrees(repo, 'remove', wt).out, /skipped .*detached/)
  assert.ok(existsSync(wt))
})

test('a detached worktree whose folder is gone is not pruned while its commits are on no branch', () => {
  const { repo, root } = repoWithWorktree()
  const wt = join(root, 'detached')
  git(repo, 'worktree', 'add', '-q', '--detach', wt)
  writeFileSync(join(wt, 'b.txt'), 'b')
  git(wt, 'add', '.')
  git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'orphan')
  rmSync(wt, { recursive: true, force: true })
  const listed = JSON.parse(worktrees(repo, 'list').out).worktrees.find(w => w.missing)
  assert.equal(listed.unreachableCommits, true)
  assert.match(worktrees(repo, 'remove', wt).out, /skipped .*detached/)
  assert.match(git(repo, 'worktree', 'list'), /detached/)
})

test('a worktree in use is left whole (Windows)', { skip: !isWin }, async () => {
  const { repo, wt } = repoWithWorktree()
  const busy = (await import('node:child_process')).spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { cwd: wt, stdio: 'ignore' })
  try {
    await new Promise(done => setTimeout(done, 500))
    assert.match(worktrees(repo, 'remove', wt).out, /skipped .*using/)
    assert.ok(existsSync(join(wt, 'a.txt')))
  } finally {
    busy.kill()
  }
})

test('the merge target is never listed as merged or deleted, however it is spelled', () => {
  const { repo, wt } = repoWithWorktree()
  git(wt, 'checkout', '-q', '--detach')
  git(repo, 'checkout', '-q', '-b', 'other')
  for (const into of ['heads/main', 'refs/heads/main']) {
    assert.ok(!JSON.parse(worktrees(repo, 'list', '--into', into).out).mergedBranches.includes('main'))
    assert.match(worktrees(repo, 'delete-branches', '--into', into, 'main').out, /skipped main: it is the merge target/)
  }
})

test('an unstaged rename is parsed without swallowing the next entry', () => {
  const { repo, wt } = repoWithWorktree()
  writeFileSync(join(wt, 'z.txt'), 'z')
  git(wt, 'add', 'z.txt')
  git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'z')
  git(wt, 'mv', 'a.txt', 'Rnew.txt')
  git(wt, 'reset', '-q')
  git(wt, 'add', '-N', 'Rnew.txt')
  writeFileSync(join(wt, 'z.txt'), 'changed')
  // " R Rnew.txt\0a.txt\0 M z.txt\0": the rename and z.txt.
  assert.equal(JSON.parse(worktrees(repo, 'list').out).worktrees[0].dirtyFiles, 2)
})

test('a skipped locked worktree keeps its lock', () => {
  const { repo, wt } = repoWithWorktree()
  git(repo, 'worktree', 'lock', wt)
  writeFileSync(join(wt, 'dirty.txt'), 'x')
  assert.match(worktrees(repo, 'remove', '--force-locked', wt).out, /skipped/)
  assert.match(git(repo, 'worktree', 'list', '--porcelain'), /^locked/m)
})

test('a renamed file counts once', () => {
  const { repo, wt } = repoWithWorktree()
  git(wt, 'mv', 'a.txt', 'b.txt')
  const listed = JSON.parse(worktrees(repo, 'list').out).worktrees[0]
  assert.equal(listed.dirtyFiles, 1)
})

test('branches merged locally but not pushed count as merged (fan-out cleanup)', () => {
  const { root, repo, wt } = repoWithWorktree()
  // A remote whose main lags behind: origin/HEAD -> origin/main.
  const remote = join(root, 'remote.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  git(repo, 'remote', 'set-head', 'origin', 'main')
  writeFileSync(join(wt, 'w.txt'), 'w')
  git(wt, 'add', '.')
  git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'worker')
  git(repo, 'checkout', '-q', '-b', 'feature')
  git(repo, 'merge', '-q', '--no-ff', 'w', '-m', 'merge')
  assert.match(worktrees(repo, 'remove', wt).out, /removed/)
  // Not merged into main, so the default target refuses it; --into the branch it was merged into deletes it.
  assert.match(worktrees(repo, 'delete-branches', 'w').out, /skipped w: not merged into main/)
  assert.match(worktrees(repo, 'delete-branches', '--into', 'feature', 'w').out, /deleted w/)
})

test('the default target is the local main, not origin/main', () => {
  const { root, repo, wt } = repoWithWorktree()
  const remote = join(root, 'remote.git')
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  git(repo, 'remote', 'set-head', 'origin', 'main')
  writeFileSync(join(wt, 'w.txt'), 'w')
  git(wt, 'add', '.')
  git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'worker')
  git(repo, 'merge', '-q', '--no-ff', 'w', '-m', 'merge')
  const listed = JSON.parse(worktrees(repo, 'list').out)
  assert.equal(listed.mergeTarget, 'main')
  assert.equal(listed.worktrees[0].merged, true)
})

test('with no default branch the script stops instead of using HEAD', () => {
  const { repo } = repoWithWorktree()
  git(repo, 'branch', '-m', 'main', 'develop')
  git(repo, 'branch', 'sub')
  const result = worktrees(repo, 'delete-branches', 'sub')
  assert.equal(result.status, 1)
  assert.match(result.err, /pass --into/)
  assert.match(git(repo, 'branch'), /sub/)
})

// setup.mjs and session-check.mjs, against a throwaway config dir.
function configDir() {
  const dir = mkdtempSync(join(tmpdir(), 'starter-config-'))
  return { dir, env: { CLAUDE_CONFIG_DIR: dir, CLAUDE_PLUGIN_DATA: join(dir, 'data') } }
}
const begins = text => text.split('<!-- claude-starter:begin').length - 1

test('setup writes the rules once, keeps CRLF and never overwrites a backup', () => {
  const { dir, env } = configDir()
  writeFileSync(join(dir, 'CLAUDE.md'), 'mine\r\nline2\r\n')
  run('setup.mjs', ['apply', '--rules'], dir, env)
  const first = readFileSync(join(dir, 'CLAUDE.md'), 'utf8')
  assert.equal(run('setup.mjs', ['apply', '--rules'], dir, env).out, 'nothing to change')
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), first)
  assert.equal(begins(first), 1)
  assert.ok(!/[^\r]\n/.test(first))
  // Stale block: rewritten in place, and a second, separate backup appears.
  writeFileSync(join(dir, 'CLAUDE.md'), first.replace(/begin \w+/, 'begin 00000000'))
  run('setup.mjs', ['apply', '--rules'], dir, env)
  assert.equal(readdirSync(dir).filter(name => name.endsWith('.starter-backup')).length, 2)
})

test('setup refuses unbalanced markers and leaves the file alone', () => {
  const { dir, env } = configDir()
  for (const text of ['mine\n<!-- claude-starter:begin deadbeef -->\nold\nUSER NOTE\n', '<!-- claude-starter:end -->\nmine\n']) {
    writeFileSync(join(dir, 'CLAUDE.md'), text)
    assert.match(run('setup.mjs', ['apply', '--rules'], dir, env).out, /rules not written/)
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), text)
    assert.match(run('session-check.mjs', [], dir, env).out, /markers .* are unbalanced/)
  }
})

test('skipped rules keep the session-start notice quiet until applied', () => {
  const { dir, env } = configDir()
  // A fresh report, so only the rules notice could show.
  mkdirSync(join(dir, 'usage-data'))
  writeFileSync(join(dir, 'usage-data', 'report.html'), '<p>x</p>')
  assert.match(run('session-check.mjs', [], dir, env).out, /not installed/)
  run('setup.mjs', ['apply', '--skip-rules', '--data', env.CLAUDE_PLUGIN_DATA], dir, env)
  assert.equal(run('session-check.mjs', [], dir, env).out, '')
  run('setup.mjs', ['apply', '--rules', '--data', env.CLAUDE_PLUGIN_DATA], dir, env)
  assert.ok(!existsSync(join(env.CLAUDE_PLUGIN_DATA, 'rules-skipped')))
})

test('review counts memory lines as Claude Code loads them and decodes the report', () => {
  const { dir, env } = configDir()
  mkdirSync(join(dir, 'projects', 'p', 'memory'), { recursive: true })
  // 80 entries with a blank line after each: 160 lines as loaded, though only 80 have text.
  writeFileSync(join(dir, 'projects', 'p', 'memory', 'MEMORY.md'), Array.from({ length: 80 }, (_, i) => `- ${i}\n\n`).join(''))
  const status = JSON.parse(run('review.mjs', ['status'], dir, env).out)
  assert.equal(status.largeMemoryIndexes[0].lines, 160)
  mkdirSync(join(dir, 'usage-data'))
  writeFileSync(join(dir, 'usage-data', 'report-1.html'), '<script>x()</script><p>Use &#x27;git&#x27; &amp; ok&nbsp;now &#99999999;</p>')
  assert.equal(run('review.mjs', ['report', '--data', env.CLAUDE_PLUGIN_DATA], dir, env).out, "Use 'git' & ok now &#99999999;")
})

test('remove keeps a worktree with gitignored files unless --include-ignored', () => {
  const { repo, wt } = repoWithWorktree()
  writeFileSync(join(repo, '.gitignore'), '.env.local\nnode_modules/\n')
  git(repo, 'add', '.gitignore')
  git(repo, 'commit', '-qm', 'ignore')
  git(wt, 'merge', '-q', 'main')
  writeFileSync(join(wt, '.env.local'), 'SECRET=1')
  // A linked node_modules is not the worktree's own data and must not hold the removal back.
  mkdirSync(join(repo, 'node_modules'))
  link(join(repo, 'node_modules'), join(wt, 'node_modules'))
  const listed = JSON.parse(worktrees(repo, 'list').out).worktrees[0]
  assert.deepEqual(listed.ignoredFiles, ['.env.local'])
  assert.match(worktrees(repo, 'remove', wt).out, /skipped .*gitignored files .*\.env\.local.*--include-ignored/)
  assert.ok(existsSync(join(wt, '.env.local')))
  assert.match(worktrees(repo, 'remove', '--include-ignored', wt).out, /removed /)
  assert.ok(!existsSync(wt))
  assert.ok(existsSync(join(repo, 'node_modules')))
})

test('setup sets worktree.baseRef for the project by default, for the user with --scope user', () => {
  const { dir, env } = configDir()
  const project = mkdtempSync(join(tmpdir(), 'starter-project-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }))
  run('setup.mjs', ['apply', '--base-ref', 'head'], project, env)
  const local = JSON.parse(readFileSync(join(project, '.claude', 'settings.local.json'), 'utf8'))
  assert.equal(local.worktree.baseRef, 'head')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')), { theme: 'dark' })
  run('setup.mjs', ['apply', '--base-ref', 'head', '--scope', 'user'], project, env)
  assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).worktree.baseRef, 'head')
  // A project file that says otherwise wins, and setup says so.
  mkdirSync(join(project, 'sub', '.claude'), { recursive: true })
  writeFileSync(join(project, 'sub', '.claude', 'settings.local.json'), JSON.stringify({ worktree: { baseRef: 'fresh' } }))
  assert.match(run('setup.mjs', ['apply', '--base-ref', 'head', '--scope', 'user'], join(project, 'sub'), env).out, /higher-precedence .* "fresh"/)
  assert.equal(run('setup.mjs', ['apply', '--base-ref', 'head', '--scope', 'team'], project, env).status, 1)
})

// Review gate: a repository, a plugin data dir and a transcript file, with helpers that run one hook event and
// append a tool call to the transcript.
function gateRepo() {
  const root = mkdtempSync(join(tmpdir(), 'starter-gate-'))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, 'src', 'a.js'), 'a\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'init')
  const transcript = join(root, 'transcript.jsonl')
  writeFileSync(transcript, '')
  const env = { CLAUDE_PLUGIN_DATA: join(root, 'data') }
  const hook = (event, extra = {}, more = {}) => {
    const input = JSON.stringify({ session_id: 's1', cwd: repo, transcript_path: transcript, ...extra })
    const result = spawnSync(process.execPath, [join(scripts, 'review-gate.mjs'), event], { cwd: repo, input, encoding: 'utf8', env: { ...process.env, ...env, ...more } })
    return result.stdout.trim() ? JSON.parse(result.stdout) : null
  }
  const call = (name, input) => writeFileSync(transcript, readFileSync(transcript, 'utf8') +
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }) + '\n')
  const edit = (file, text) => {
    writeFileSync(join(repo, file), text)
    call('Write', { file_path: file })
  }
  const review = () => call('Skill', { skill: 'code-review', args: 'medium' })
  return { root, repo, env, hook, edit, review }
}

test('the review gate lets small changes, tests, docs and one-line wiring through', () => {
  const { repo, hook, edit } = gateRepo()
  hook('start')
  edit('src/a.js', 'a\nb\n')
  edit('src/b.js', 'export * from "./a.js"\n')
  mkdirSync(join(repo, 'test'))
  edit('test/a.test.js', 'x\n'.repeat(200))
  edit('README.md', 'x\n'.repeat(200))
  assert.equal(hook('stop'), null)
})

test('the review gate asks once per change set; a review or an answer moves the base', () => {
  const { hook, edit, review } = gateRepo()
  hook('start')
  edit('src/a.js', 'a\n'.repeat(10))
  edit('src/b.js', 'b\n'.repeat(10))
  const blocked = hook('stop')
  assert.equal(blocked.decision, 'block')
  assert.match(blocked.reason, /2 non-test file/)
  // Claude answered the gate without a review: it can stop, and the next turn doesn't ask again for the same change.
  assert.equal(hook('stop', { stop_hook_active: true }), null)
  assert.equal(hook('stop'), null)
  // A new change set past the threshold asks again; after a review it doesn't, and small fixes stay under the base.
  edit('src/c.js', 'c\n'.repeat(60))
  assert.equal(hook('stop').decision, 'block')
  review()
  assert.equal(hook('stop'), null)
  edit('src/c.js', 'c\n'.repeat(61))
  assert.equal(hook('stop'), null)
})

test('the review gate does not ask again after a one-line answer with no tool call', () => {
  const { hook, edit } = gateRepo()
  hook('start')
  edit('src/a.js', 'a\n'.repeat(20))
  edit('src/b.js', 'b\n'.repeat(20))
  assert.equal(hook('stop').decision, 'block')
  // Claude declined in one line: no new transcript lines before the stop that follows the gate.
  assert.equal(hook('stop', { stop_hook_active: true }), null)
  // The next turn touches a file but changes nothing new: the same change set must not be asked about again.
  edit('src/a.js', 'a\n'.repeat(20))
  assert.equal(hook('stop'), null)
})

test('the review gate counts committed changes and more than 50 lines in one file', () => {
  const { repo, hook, edit } = gateRepo()
  hook('start')
  edit('src/a.js', 'x\n'.repeat(60))
  git(repo, 'commit', '-qam', 'big')
  assert.equal(hook('stop').decision, 'block')
})

test('the review gate still asks when Claude branches before committing its own work', () => {
  const { repo, hook, edit } = gateRepo()
  hook('start')
  edit('src/a.js', 'a\n'.repeat(20))
  edit('src/b.js', 'b\n'.repeat(20))
  // `checkout -b` leaves HEAD on the same commit, so it brings nothing in from outside.
  git(repo, 'checkout', '-qb', 'feature')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'own work')
  assert.equal(hook('stop').decision, 'block')
})

test('the review gate still asks when the checkout or pull that put HEAD there came before the session', () => {
  const { repo, hook, edit } = gateRepo()
  git(repo, 'checkout', '-qb', 'other')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'other')
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'checkout', '-q', 'other')
  hook('start')
  edit('src/a.js', 'a\n'.repeat(20))
  edit('src/b.js', 'b\n'.repeat(20))
  git(repo, 'commit', '-qam', 'own work')
  assert.equal(hook('stop').decision, 'block')
})

test('the review gate ignores a merge or pull from outside the session, and turns without tool calls', () => {
  const { repo, hook } = gateRepo()
  hook('start')
  git(repo, 'checkout', '-qb', 'other')
  for (const name of ['x', 'y', 'z']) {
    writeFileSync(join(repo, 'src', `${name}.js`), `${name}\n`.repeat(30))
  }
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'other work')
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'merge', '-q', 'other')
  // No tool call in the transcript and HEAD moved by a merge: the merged files become the base.
  assert.equal(hook('stop'), null)
  writeFileSync(join(repo, 'src', 'x.js'), 'x\n'.repeat(80))
  // A change with no tool call behind it (the user's editor) doesn't count either.
  assert.equal(hook('stop'), null)
})

test('the review gate stays silent when off, or outside a git repository', () => {
  const { root, repo, env, hook, edit } = gateRepo()
  hook('start')
  edit('src/b.js', 'b\n'.repeat(10))
  edit('src/c.js', 'c\n'.repeat(10))
  assert.equal(hook('stop', {}, { CLAUDE_STARTER_REVIEW_GATE: 'off' }), null)
  run('review-gate.mjs', ['off', '--data', env.CLAUDE_PLUGIN_DATA], repo)
  assert.equal(hook('stop'), null)
  run('review-gate.mjs', ['on', '--data', env.CLAUDE_PLUGIN_DATA], repo)
  assert.equal(hook('stop').decision, 'block')
  const plain = join(root, 'plain')
  mkdirSync(plain)
  const result = spawnSync(process.execPath, [join(scripts, 'review-gate.mjs'), 'stop'], { cwd: plain, input: JSON.stringify({ session_id: 's2', cwd: plain }), encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(result.stdout.trim(), '')
  assert.equal(result.status, 0)
})

test('setup shows and switches the review gate', () => {
  const { dir, env } = configDir()
  const state = () => JSON.parse(run('setup.mjs', ['check', '--data', env.CLAUDE_PLUGIN_DATA], dir, env).out).reviewGate
  assert.equal(state(), 'on')
  run('setup.mjs', ['apply', '--review-gate', 'off', '--data', env.CLAUDE_PLUGIN_DATA], dir, env)
  assert.equal(state(), 'off')
  assert.equal(run('setup.mjs', ['apply', '--review-gate', 'maybe', '--data', env.CLAUDE_PLUGIN_DATA], dir, env).status, 1)
  run('setup.mjs', ['apply', '--review-gate', 'on', '--data', env.CLAUDE_PLUGIN_DATA], dir, env)
  assert.equal(state(), 'on')
})

test('every plugin workflow script parses as plain JavaScript', () => {
  const dir = join(scripts, '..', 'workflows')
  for (const name of readdirSync(dir).filter(f => f.endsWith('.js'))) {
    // The workflow runtime runs the body in an async context with these globals; `export const meta` is its header.
    const body = readFileSync(join(dir, name), 'utf8').replace(/^export const meta/m, 'const meta')
    assert.doesNotThrow(() => new Function('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow', `return (async () => {\n${body}\n})()`), name)
  }
})
