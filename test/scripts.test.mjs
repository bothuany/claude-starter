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

test('a link named .git below the worktree root is unlinked, not followed', () => {
  const { repo, wt } = repoWithWorktree()
  mkdirSync(join(repo, 'shared'))
  writeFileSync(join(repo, 'shared', 'canary.txt'), 'keep')
  mkdirSync(join(wt, 'vendor'))
  link(join(repo, 'shared'), join(wt, 'vendor', '.git'))
  worktrees(repo, 'remove', '--include-ignored', wt)
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

const rulesHook = (dir, env) => {
  const out = run('rules-hook.mjs', [], dir, env).out
  return out ? JSON.parse(out).hookSpecificOutput : null
}

test('the rules hook injects rules.md into the session, and nothing when the rules are off', () => {
  const { dir, env } = configDir()
  const injected = rulesHook(dir, env)
  assert.equal(injected.hookEventName, 'SessionStart')
  assert.match(injected.additionalContext, /^## Working rules \(claude-starter\)/)
  run('setup.mjs', ['apply', '--rules', 'off', '--data', env.CLAUDE_PLUGIN_DATA], dir, env)
  assert.equal(rulesHook(dir, env), null)
  run('setup.mjs', ['apply', '--rules', 'on', '--data', env.CLAUDE_PLUGIN_DATA], dir, env)
  assert.ok(rulesHook(dir, env))
  // Declining the rules in an older version counts as off.
  writeFileSync(join(env.CLAUDE_PLUGIN_DATA, 'rules-skipped'), '')
  assert.equal(rulesHook(dir, env), null)
})

test('an old rules block in CLAUDE.md holds the hook back until setup removes it, with a backup', () => {
  const { dir, env } = configDir()
  const old = 'mine\r\n\r\n<!-- claude-starter:begin deadbeef -->\r\nold rules\r\n<!-- claude-starter:end -->\r\n\r\nafter\r\n'
  writeFileSync(join(dir, 'CLAUDE.md'), old)
  assert.equal(rulesHook(dir, env), null)
  assert.match(run('session-check.mjs', [], dir, env).out, /remove the old copy/)
  assert.match(run('setup.mjs', ['apply', '--rules', 'off', '--data', env.CLAUDE_PLUGIN_DATA], dir, env).out, /old copy of the rules .* still loads/)
  run('setup.mjs', ['apply', '--rules', 'on', '--data', env.CLAUDE_PLUGIN_DATA], dir, env)
  assert.match(run('setup.mjs', ['apply', '--remove-old-rules'], dir, env).out, /old rules block removed/)
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), 'mine\r\n\r\nafter\r\n')
  assert.equal(readdirSync(dir).filter(name => name.endsWith('.starter-backup')).length, 1)
  assert.ok(rulesHook(dir, env))
  assert.equal(run('setup.mjs', ['apply', '--remove-old-rules'], dir, env).out, 'nothing to change')
})

test('setup leaves unbalanced old markers alone and says so', () => {
  const { dir, env } = configDir()
  for (const text of ['mine\n<!-- claude-starter:begin deadbeef -->\nold\nUSER NOTE\n', '<!-- claude-starter:end -->\nmine\n']) {
    writeFileSync(join(dir, 'CLAUDE.md'), text)
    assert.match(run('setup.mjs', ['apply', '--remove-old-rules'], dir, env).out, /old rules not removed/)
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), text)
    assert.match(run('session-check.mjs', [], dir, env).out, /unbalanced claude-starter markers/)
    assert.equal(rulesHook(dir, env), null)
  }
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
  return { root, repo, env, hook, edit, review, call }
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

test('the review gate counts files a subagent changed, and a review by the reviewer subagent', () => {
  const delegated = () => {
    const gate = gateRepo()
    gate.hook('start')
    // The lead's only tool call is the Agent call; the writer's own edits are not in the lead's transcript.
    writeFileSync(join(gate.repo, 'src', 'a.js'), 'a\n'.repeat(10))
    writeFileSync(join(gate.repo, 'src', 'b.js'), 'b\n'.repeat(10))
    gate.call('Agent', { subagent_type: 'starter:writer', description: 'build', prompt: 'p' })
    return gate
  }
  const blocked = delegated().hook('stop')
  assert.equal(blocked.decision, 'block')
  assert.match(blocked.reason, /`reviewer` subagent/)
  for (const subagent_type of ['starter:reviewer', 'reviewer']) {
    const reviewed = delegated()
    reviewed.call('Agent', { subagent_type, description: 'review', prompt: 'p' })
    assert.equal(reviewed.hook('stop'), null)
  }
  // Not a reviewer: a name that only contains the word doesn't count as a review.
  const other = delegated()
  other.call('Agent', { subagent_type: 'pre-reviewer-notes', description: 'x', prompt: 'p' })
  assert.equal(other.hook('stop').decision, 'block')
  const unchanged = gateRepo()
  unchanged.hook('start')
  unchanged.call('Agent', { subagent_type: 'starter:reader', description: 'read', prompt: 'p' })
  assert.equal(unchanged.hook('stop'), null)
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

test('without a start, the review gate takes the current tree as base instead of HEAD', () => {
  const { repo, hook, edit } = gateRepo()
  // Another session's work, already in the tree when this session's first Stop runs.
  writeFileSync(join(repo, 'src', 'other.js'), 'o\n'.repeat(80))
  edit('src/a.js', 'a\n')
  assert.equal(hook('stop'), null)
  edit('src/a.js', 'a\n'.repeat(60))
  assert.equal(hook('stop').decision, 'block')
})

test('the review gate ignores lockfiles, build output, pure renames and whitespace', () => {
  const { repo, hook, edit } = gateRepo()
  writeFileSync(join(repo, 'src', 'old.js'), 'x\n'.repeat(80))
  writeFileSync(join(repo, 'src', 'fmt.js'), 'y\n'.repeat(80))
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'old')
  hook('start')
  edit('package-lock.json', '{}\n'.repeat(200))
  mkdirSync(join(repo, 'dist'))
  edit('dist/app.js', 'x\n'.repeat(200))
  git(repo, 'mv', 'src/old.js', 'src/new.js')
  edit('src/fmt.js', '  y\n'.repeat(80))
  assert.equal(hook('stop'), null)
})

test('the review gate leaves large untracked files out and writes nothing into .git', () => {
  const { repo, hook, edit } = gateRepo()
  const objects = () => readdirSync(join(repo, '.git', 'objects')).length
  const before = objects()
  hook('start')
  writeFileSync(join(repo, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 1))
  edit('src/a.js', 'a\n'.repeat(60))
  assert.equal(hook('stop').decision, 'block')
  assert.equal(objects(), before)
})

test('the review gate skips large untracked files when the session runs in a subfolder', () => {
  const { repo, hook, edit } = gateRepo()
  const cwd = join(repo, 'src')
  hook('start', { cwd })
  writeFileSync(join(repo, 'big.csv'), 'x\n'.repeat(1024 * 1024 + 1))
  edit('src/a.js', 'a\n'.repeat(5))
  assert.equal(hook('stop', { cwd }), null)
})

test('the review gate judges a renamed doc by its new name, reads non-ASCII paths, and keeps Contest.java as code', () => {
  const { repo, hook, edit } = gateRepo()
  writeFileSync(join(repo, 'src', 'notes.md'), 'n\n'.repeat(40))
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'notes')
  hook('start')
  git(repo, 'mv', 'src/notes.md', 'src/guide.md')
  edit('src/guide.md', 'n\n'.repeat(40) + 'more\n'.repeat(60))
  edit('src/notlar-ş.md', 'x\n'.repeat(100))
  mkdirSync(join(repo, 'src', 'test'))
  edit('src/FooTest.java', 'x\n'.repeat(100))
  assert.equal(hook('stop'), null)
  edit('src/Contest.java', 'x\n'.repeat(60))
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

function agentLog(input, env = {}) {
  const data = mkdtempSync(join(tmpdir(), 'starter-agents-'))
  const result = spawnSync(process.execPath, [join(scripts, 'agent-log.mjs')], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: data, ...env } })
  const file = join(data, 'agents.jsonl')
  return { status: result.status, out: result.stdout + result.stderr, lines: existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] }
}

test('the agent log writes one line per Agent call, nothing when off, and survives garbage input', () => {
  const call = JSON.stringify({ session_id: 's1', tool_name: 'Agent', tool_input: { subagent_type: 'starter:writer', model: 'opus', description: 'fix it', prompt: 'p' } })
  const logged = agentLog(call)
  assert.deepEqual([logged.status, logged.out], [0, ''])
  const [{ ts, ...line }] = logged.lines
  assert.ok(ts)
  assert.deepEqual(line, { session_id: 's1', subagent_type: 'starter:writer', model: 'opus', effort: null, description: 'fix it' })
  assert.deepEqual(agentLog(call, { CLAUDE_STARTER_AGENT_LOG: 'off' }), { status: 0, out: '', lines: [] })
  assert.deepEqual(agentLog('not json'), { status: 0, out: '', lines: [] })
  // A data dir that can't be created (its parent is a file) is a write error: still silent.
  assert.deepEqual(agentLog(call, { CLAUDE_PLUGIN_DATA: join(fileURLToPath(import.meta.url), 'x') }), { status: 0, out: '', lines: [] })
})

test('hooks.json names the subagents pane module and keeps every command hook', () => {
  const plugin = join(scripts, '..')
  const hooks = JSON.parse(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8'))
  assert.deepEqual(hooks.modules, ['./register.tsx'])
  assert.ok(existsSync(join(plugin, 'hooks', hooks.modules[0])))
  for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']) assert.ok(event in hooks.hooks, event)
  const manifest = JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.ok(existsSync(join(plugin, manifest.types)))
})

// Per-project setup reminders: session-check.mjs reads them, setup-track.mjs and `setup.mjs skip` write them.
function plainRepo(commit = true) {
  const repo = mkdtempSync(join(tmpdir(), 'starter-project-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  if (commit) {
    writeFileSync(join(repo, 'a.txt'), 'a')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'init')
  }
  return repo
}

const installClaudeCodeSetup = (dir, enabled = true) => {
  mkdirSync(join(dir, 'plugins'), { recursive: true })
  writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'claude-code-setup@claude-plugins-official': [{ scope: 'user' }] } }))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledPlugins: enabled ? { 'claude-code-setup@claude-plugins-official': true } : {} }))
}

// The project line of the session notice, or '' when there is none; the monthly review's notice is ignored.
const projectLine = (cwd, env) => {
  const result = spawnSync(process.execPath, [join(scripts, 'session-check.mjs')], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  const message = result.stdout.trim() ? JSON.parse(result.stdout).systemMessage : ''
  return message.replace(/^claude-starter: /, '').replace(/\.$/, '').split('. ').find(note => note.startsWith('this project')) ?? ''
}

const skillCall = (cwd, env, skill) => hookCall(env, { hook_event_name: 'PostToolUse', tool_name: 'Skill', cwd, tool_input: { skill } })
const promptSubmit = (cwd, env, prompt) => hookCall(env, { hook_event_name: 'UserPromptSubmit', cwd, prompt })
const hookCall = (env, event) => {
  const input = JSON.stringify(event)
  const result = spawnSync(process.execPath, [join(scripts, 'setup-track.mjs')], { input, encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: result.status, out: result.stdout + result.stderr }
}

const REVIEW_LINE = 'this project has no REVIEW.md: run /starter:review-setup, or /starter:setup skip review-md to stop asking here'

test('a repo without REVIEW.md is reminded once, then silent for the rest of the day', () => {
  const { env } = configDir()
  const repo = plainRepo()
  assert.equal(projectLine(repo, env), REVIEW_LINE)
  assert.equal(projectLine(repo, env), '')
  // The next day it asks again.
  const file = join(env.CLAUDE_PLUGIN_DATA, 'projects.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  state[Object.keys(state)[0]].reminded = '2000-01-01'
  writeFileSync(file, JSON.stringify(state))
  assert.equal(projectLine(repo, env), REVIEW_LINE)
})

test('a REVIEW.md at the repo root ends the REVIEW.md reminder', () => {
  const { env } = configDir()
  const repo = plainRepo()
  writeFileSync(join(repo, 'REVIEW.md'), '# review')
  assert.equal(projectLine(repo, env), '')
})

test('claude-code-setup is mentioned only when installed, and stops after the plugin ran in this project', () => {
  const { dir, env } = configDir()
  const repo = plainRepo()
  writeFileSync(join(repo, 'REVIEW.md'), '# review')
  assert.equal(projectLine(repo, env), '')
  installClaudeCodeSetup(dir)
  const expected = "this project hasn't run claude-code-setup: run /claude-code-setup:claude-automation-recommender, or /starter:setup skip project-setup to stop asking here"
  assert.equal(projectLine(repo, env), expected)
  // A skill from another plugin, or the same skill in another project, changes nothing.
  assert.deepEqual(skillCall(repo, env, 'starter:setup'), { status: 0, out: '' })
  assert.deepEqual(skillCall(plainRepo(), env, 'claude-code-setup:claude-automation-recommender'), { status: 0, out: '' })
  const state = JSON.parse(readFileSync(join(env.CLAUDE_PLUGIN_DATA, 'projects.json'), 'utf8'))
  state[Object.keys(state).find(key => state[key].reminded)].reminded = '2000-01-01'
  writeFileSync(join(env.CLAUDE_PLUGIN_DATA, 'projects.json'), JSON.stringify(state))
  assert.equal(projectLine(repo, env), expected)
  state[Object.keys(state).find(key => state[key].reminded)].reminded = '2000-01-01'
  writeFileSync(join(env.CLAUDE_PLUGIN_DATA, 'projects.json'), JSON.stringify(state))
  assert.deepEqual(skillCall(repo, env, 'claude-code-setup:claude-automation-recommender'), { status: 0, out: '' })
  assert.equal(projectLine(repo, env), '')
})

test('a CLAUDE.md or AGENTS.md at the repo root counts as set up, a bare .claude/ does not', () => {
  for (const make of [repo => writeFileSync(join(repo, 'CLAUDE.md'), 'x'), repo => writeFileSync(join(repo, 'AGENTS.md'), 'x')]) {
    const { dir, env } = configDir()
    installClaudeCodeSetup(dir)
    const repo = plainRepo()
    writeFileSync(join(repo, 'REVIEW.md'), '# review')
    make(repo)
    assert.equal(projectLine(repo, env), '')
  }
  const { dir, env } = configDir()
  installClaudeCodeSetup(dir)
  const repo = plainRepo()
  writeFileSync(join(repo, 'REVIEW.md'), '# review')
  mkdirSync(join(repo, '.claude'))
  writeFileSync(join(repo, '.claude', 'settings.local.json'), '{}')
  assert.match(projectLine(repo, env), /hasn't run claude-code-setup/)
})

test('turning the monthly review reminders off does not silence the project line', () => {
  const { env } = configDir()
  run('review.mjs', ['reminders', 'off', '--data', env.CLAUDE_PLUGIN_DATA], plainRepo(), env)
  assert.equal(projectLine(plainRepo(), env), REVIEW_LINE)
})

test('setup skip stops the reminder for this project, unskip brings it back, check shows both steps', () => {
  const { dir, env } = configDir()
  installClaudeCodeSetup(dir)
  const repo = plainRepo()
  const other = plainRepo()
  const setup = (...args) => run('setup.mjs', [...args, '--data', env.CLAUDE_PLUGIN_DATA], repo, env)
  const steps = () => JSON.parse(setup('check').out).projectReminders
  const before = steps()
  assert.match(before.root, /starter-project-/)
  assert.deepEqual([before['review-md'], before['project-setup'], before.claudeCodeSetupInstalled], ['unknown', 'unknown', true])
  assert.match(setup('skip', 'review-md').out, /review-md: declined for /)
  const afterSkip = steps()
  assert.deepEqual([afterSkip['review-md'], afterSkip['project-setup']], ['declined', 'unknown'])
  assert.equal(projectLine(repo, env), "this project hasn't run claude-code-setup: run /claude-code-setup:claude-automation-recommender, or /starter:setup skip project-setup to stop asking here")
  assert.equal(projectLine(other, env), 'this project has no REVIEW.md and hasn\'t run claude-code-setup: run /starter:review-setup and /claude-code-setup:claude-automation-recommender, or /starter:setup skip review-md / skip project-setup to stop asking here')
  setup('skip', 'project-setup')
  const afterBoth = steps()
  assert.deepEqual([afterBoth['review-md'], afterBoth['project-setup']], ['declined', 'declined'])
  const fresh = plainRepo()
  run('setup.mjs', ['skip', 'review-md', '--data', env.CLAUDE_PLUGIN_DATA], fresh, env)
  run('setup.mjs', ['skip', 'project-setup', '--data', env.CLAUDE_PLUGIN_DATA], fresh, env)
  assert.equal(projectLine(fresh, env), '')
  setup('unskip', 'review-md')
  assert.equal(projectLine(repo, env), REVIEW_LINE)
  assert.equal(setup('skip', 'nonsense').status, 1)
  assert.equal(run('setup.mjs', ['skip', 'review-md'], repo, env).status, 1)
})

test('with both steps unknown the notice is a single combined line', () => {
  const { dir, env } = configDir()
  installClaudeCodeSetup(dir)
  const result = spawnSync(process.execPath, [join(scripts, 'session-check.mjs')], { cwd: plainRepo(), encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(result.stdout.trim().split('\n').length, 1)
  assert.equal(result.stdout.match(/this project/g).length, 1)
  assert.match(result.stdout, /has no REVIEW\.md and hasn't run claude-code-setup: run \/starter:review-setup and \/claude-code-setup:claude-automation-recommender, or \/starter:setup skip review-md \/ skip project-setup/)
})

test('outside a git repo, or in a repo without commits, the project reminders stay silent', () => {
  const { dir, env } = configDir()
  installClaudeCodeSetup(dir)
  assert.equal(projectLine(mkdtempSync(join(tmpdir(), 'starter-nogit-')), env), '')
  assert.equal(projectLine(plainRepo(false), env), '')
  assert.equal(run('setup.mjs', ['skip', 'review-md', '--data', env.CLAUDE_PLUGIN_DATA], plainRepo(false), env).status, 1)
})

test('a typed /claude-code-setup: command or the unprefixed skill marks the project as set up, printing nothing', () => {
  const { dir, env } = configDir()
  installClaudeCodeSetup(dir)
  const reset = () => {
    const file = join(env.CLAUDE_PLUGIN_DATA, 'projects.json')
    const state = JSON.parse(readFileSync(file, 'utf8'))
    for (const key of Object.keys(state)) state[key].reminded = '2000-01-01'
    writeFileSync(file, JSON.stringify(state))
  }
  const repo = plainRepo()
  writeFileSync(join(repo, 'REVIEW.md'), '# review')
  assert.match(projectLine(repo, env), /hasn't run claude-code-setup/)
  // Other prompts, other plugins' commands and a prefix in the middle of the text change nothing.
  for (const prompt of ['hello', '/starter:setup', 'run /claude-code-setup:x', '/claude-code-setupx']) {
    assert.deepEqual(promptSubmit(repo, env, prompt), { status: 0, out: '' })
  }
  reset()
  assert.match(projectLine(repo, env), /hasn't run claude-code-setup/)
  assert.deepEqual(promptSubmit(repo, env, '/claude-code-setup:claude-automation-recommender'), { status: 0, out: '' })
  reset()
  assert.equal(projectLine(repo, env), '')

  const second = plainRepo()
  writeFileSync(join(second, 'REVIEW.md'), '# review')
  assert.match(projectLine(second, env), /hasn't run claude-code-setup/)
  reset()
  assert.deepEqual(skillCall(second, env, 'claude-automation-recommender'), { status: 0, out: '' })
  assert.equal(projectLine(second, env), '')
})

test('a project state file that is not a JSON object is never overwritten', () => {
  for (const content of ['{not json', '', '[]', '"x"', 'null']) {
    const { env } = configDir()
    mkdirSync(env.CLAUDE_PLUGIN_DATA, { recursive: true })
    const file = join(env.CLAUDE_PLUGIN_DATA, 'projects.json')
    const repo = plainRepo()
    const untouched = () => assert.equal(readFileSync(file, 'utf8'), content, content)
    const setup = (...args) => run('setup.mjs', [...args, '--data', env.CLAUDE_PLUGIN_DATA], repo, env)
    writeFileSync(file, content)
    // The notice stays silent rather than repeat every session; the monthly notice is unaffected.
    const first = spawnSync(process.execPath, [join(scripts, 'session-check.mjs')], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } })
    assert.equal(first.status, 0)
    assert.match(first.stdout, /monthly review due/)
    assert.doesNotMatch(first.stdout, /this project/, content)
    assert.equal(projectLine(repo, env), '', content)
    untouched()
    for (const args of [['skip', 'review-md'], ['unskip', 'review-md']]) {
      const result = setup(...args)
      assert.equal(result.status, 1)
      assert.match(result.err, /not a valid JSON object/)
      untouched()
    }
    assert.deepEqual(skillCall(repo, env, 'claude-code-setup:x'), { status: 0, out: '' })
    assert.deepEqual(promptSubmit(repo, env, '/claude-code-setup:x'), { status: 0, out: '' })
    untouched()
    const reminders = JSON.parse(setup('check').out).projectReminders
    assert.equal(reminders['review-md'], 'unknown')
    assert.equal(reminders.stateFile, `unreadable (not a valid JSON object; fix or delete it): ${file}`)
    assert.deepEqual(readdirSync(env.CLAUDE_PLUGIN_DATA).filter(name => name.endsWith('.tmp')), [])
  }
})

test('state writes keep other projects, leave no temp file, and the file stays small', () => {
  const { env } = configDir()
  mkdirSync(env.CLAUDE_PLUGIN_DATA, { recursive: true })
  const file = join(env.CLAUDE_PLUGIN_DATA, 'projects.json')
  const old = Object.fromEntries(Array.from({ length: 250 }, (_, n) => [`/old/${n}`, n < 100 ? { 'review-md': 'declined' } : { reminded: `2020-01-${String(n % 28 + 1).padStart(2, '0')}` }]))
  old['/old/newest'] = { 'review-md': 'declined', reminded: '2026-11-13' }
  writeFileSync(file, JSON.stringify(old))
  const repo = plainRepo()
  run('setup.mjs', ['skip', 'review-md', '--data', env.CLAUDE_PLUGIN_DATA], repo, env)
  const state = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(Object.keys(state).length, 200)
  assert.deepEqual(state[Object.keys(state).find(key => key.endsWith('.git'))], { 'review-md': 'declined' })
  assert.ok(state['/old/newest'], 'the most recently reminded project survives the cap')
  assert.ok(!('/old/0' in state), 'entries never reminded go first')
  assert.deepEqual(readdirSync(env.CLAUDE_PLUGIN_DATA), ['projects.json'])
})

test('a repo and its worktrees share one entry: skip in the main checkout applies in a worktree', () => {
  const { env } = configDir()
  const repo = plainRepo()
  const wt = join(mkdtempSync(join(tmpdir(), 'starter-wt-')), 'wt')
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'w')
  assert.equal(run('setup.mjs', ['skip', 'review-md', '--data', env.CLAUDE_PLUGIN_DATA], repo, env).status, 0)
  assert.equal(projectLine(wt, env), '')
  // Files are read from the current checkout: a REVIEW.md only in the worktree is seen there, not in the main one.
  const other = plainRepo()
  const otherWt = join(mkdtempSync(join(tmpdir(), 'starter-wt-')), 'wt')
  git(other, 'worktree', 'add', '-q', otherWt, '-b', 'w')
  writeFileSync(join(otherWt, 'REVIEW.md'), '# review')
  assert.equal(projectLine(otherWt, env), '')
  assert.equal(projectLine(other, env), REVIEW_LINE)
})

test('claude-code-setup is not mentioned when installed but not enabled', () => {
  const { dir, env } = configDir()
  installClaudeCodeSetup(dir, false)
  const repo = plainRepo()
  writeFileSync(join(repo, 'REVIEW.md'), '# review')
  assert.equal(projectLine(repo, env), '')
})

test('the monthly stamp and the project stamp are written only after the notice is printed', () => {
  const { env } = configDir()
  // A hook killed before it prints (simulated: stdout closed) must not use up the day's notices.
  const result = spawnSync(process.execPath, ['-e', `console.log = () => { throw new Error('killed') }; await import(${JSON.stringify(join(scripts, 'session-check.mjs'))})`, '--input-type=module'], { cwd: plainRepo(), env: { ...process.env, ...env }, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.ok(!existsSync(join(env.CLAUDE_PLUGIN_DATA, 'last-reminder')))
  assert.ok(!existsSync(join(env.CLAUDE_PLUGIN_DATA, 'projects.json')))
})
