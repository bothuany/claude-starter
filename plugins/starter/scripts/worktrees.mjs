#!/usr/bin/env node
// Safe cleanup of git worktrees and merged branches, run from inside a repository.
//
//   node worktrees.mjs list [--into <ref>]                   every linked worktree and local branch, as JSON
//   node worktrees.mjs remove [--force-locked] <path>...     remove clean worktrees (locked ones only when forced)
//   node worktrees.mjs delete-branches [--into <ref>] <name>...   delete branches already merged into <ref>
//
// "Merged" means merged into --into, or by default into the local default branch (main or master, or the local
// branch origin/HEAD names). The local ref, not origin/...: a merge that hasn't been pushed counts. With no default
// branch and no --into, the script stops rather than guess.
//
// Why not plain `git worktree remove --force`: worktrees often hold links (symlinks, or NTFS junctions on Windows)
// to big folders such as node_modules in the main checkout, and Git for Windows deletes through a junction. This
// script deletes every link inside a worktree first (the link only, never its target), then removes the worktree.
// It refuses a worktree with uncommitted changes or untracked files, one whose git status can't be read, and a
// detached one whose commits no local branch holds; and a branch that isn't merged.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const git = (args, cwd = process.cwd()) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (args, cwd) => {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}
const isWin = process.platform === 'win32'
const same = (a, b) => (isWin ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b))
const localBranch = name => tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) !== null

// The ref "merged" is measured against: --into, else the local default branch. Throws when there is none.
function mergeTarget(into) {
  if (into) {
    if (tryGit(['rev-parse', '--verify', '--quiet', `${into}^{commit}`]) === null) {
      throw new Error(`--into ${into}: no such ref`)
    }
    // A local branch however it is spelled (heads/main, refs/heads/main) becomes its short name, so the target
    // itself is never listed as merged or deleted.
    const full = tryGit(['rev-parse', '--symbolic-full-name', into]) ?? ''
    return full.startsWith('refs/heads/') ? full.slice('refs/heads/'.length) : into
  }
  const remoteHead = tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const candidates = [remoteHead?.replace(/^origin\//, ''), 'main', 'master'].filter(Boolean)
  const found = candidates.find(localBranch)
  if (!found) {
    throw new Error('could not find the default branch (no local main, master or origin/HEAD branch); pass --into <ref>')
  }
  return found
}

function worktrees() {
  const list = []
  let current = null
  for (const line of git(['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9), branch: null }
      list.push(current)
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5)
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).replace('refs/heads/', '')
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true
      current.lockReason = line.slice(7)
    }
  }
  return list
}

// Every link inside dir, without following any of them.
function findLinks(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.name === '.git') {
      continue
    }
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      found.push(path)
    } else if (stat.isDirectory()) {
      findLinks(path, found)
    }
  }
  return found
}

// True when relative path rel, or a folder on the way to it, is a link inside worktree.
function underLink(worktree, rel) {
  let path = worktree
  for (const part of rel.split('/').filter(Boolean)) {
    path = join(path, part)
    try {
      if (lstatSync(path).isSymbolicLink()) {
        return true
      }
    } catch {
      return false
    }
  }
  return false
}

// Changed or untracked paths, leaving out links and what is under them: a link such as node_modules is untracked to
// git (a .gitignore pattern like `node_modules/` doesn't match a symlink) but holds no work of its own. Returns null
// when git can't read the status: the caller must treat that as dirty, never as clean. Untracked files are listed
// whatever the user's status.showUntrackedFiles says, and submodule changes whatever their ignore setting.
function dirtyFiles(worktree) {
  let out
  try {
    out = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=normal', '--ignore-submodules=none'], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return null
  }
  const tokens = out.split('\0')
  const paths = []
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i]) {
      continue
    }
    paths.push(tokens[i].slice(3))
    // A rename or copy, staged or not, is followed by its source path as a token of its own.
    if (/^[RC]|^.[RC]/.test(tokens[i])) {
      i++
    }
  }
  // git collapses an untracked folder to "dir/"; one that holds nothing but links (and folders of links) is no work.
  return paths.filter(path => !underLink(worktree, path) && !(path.endsWith('/') && onlyLinks(join(worktree, path))))
}

// True when dir holds no files of its own: only links and folders that hold only links. Links are not followed.
// A folder that can't be read counts as holding files.
function onlyLinks(dir) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const stat = lstatSync(path)
      if (!stat.isSymbolicLink() && !(stat.isDirectory() && onlyLinks(path))) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

// For a detached worktree: true when no local branch contains its HEAD, so removing it would orphan its commits.
// Uses the HEAD git recorded, so it works for a worktree whose folder is gone too.
function detachedAndUnreachable(w) {
  if (w.branch || !w.head) {
    return false
  }
  return !tryGit(['branch', '--contains', w.head])
}

// Windows can't rename a folder that a process works in or holds a file open in. Checking that first keeps a busy
// worktree whole: otherwise git deletes part of it before it fails.
function inUse(path) {
  if (!isWin) {
    return false
  }
  try {
    renameSync(path, `${path}.starter-check`)
    renameSync(`${path}.starter-check`, path)
    return false
  } catch {
    return true
  }
}

function removeLink(path) {
  try {
    rmdirSync(path)
  } catch {
    unlinkSync(path)
  }
}

function list(into) {
  const base = mergeTarget(into)
  const [main, ...linked] = worktrees()
  const checkedOut = new Set([main, ...linked].map(w => w.branch).filter(Boolean))
  const result = { mergeTarget: base, mainCheckout: main.path, worktrees: [], mergedBranches: [], unmergedBranches: [] }
  for (const w of linked) {
    const missing = !existsSync(w.path)
    const dirty = missing ? null : dirtyFiles(w.path)
    result.worktrees.push({
      path: w.path,
      branch: w.branch ?? '(detached)',
      merged: w.head ? tryGit(['merge-base', '--is-ancestor', w.head, base]) !== null : null,
      dirtyFiles: dirty === null ? null : dirty.length,
      statusUnreadable: !missing && dirty === null,
      unreachableCommits: detachedAndUnreachable(w),
      locked: Boolean(w.locked),
      missing,
    })
  }
  for (const branch of git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean)) {
    if (checkedOut.has(branch) || branch === base) {
      continue
    }
    const merged = tryGit(['merge-base', '--is-ancestor', `refs/heads/${branch}`, base]) !== null
    ;(merged ? result.mergedBranches : result.unmergedBranches).push(branch)
  }
  return result
}

// One worktree; returns the line to print.
function removeOne(entry, forceLocked) {
  if (entry.locked && !forceLocked) {
    // Claude Code locks the worktree of a running agent or background session; a lock is never overridden quietly.
    return `skipped ${entry.path}: it is locked (a running session may be using it); pass --force-locked to remove it anyway`
  }
  // Every check comes before the unlock, so a worktree that is skipped keeps its lock.
  if (detachedAndUnreachable(entry)) {
    return `skipped ${entry.path}: it is detached and its commits are on no local branch; create one first (git branch <name> ${entry.head})`
  }
  if (!existsSync(entry.path)) {
    // prune keeps a locked entry, so a forced one is unlocked first.
    if (entry.locked) {
      tryGit(['worktree', 'unlock', entry.path])
    }
    return `pruned ${entry.path} (folder was already gone)`
  }
  const dirty = dirtyFiles(entry.path)
  if (dirty === null) {
    return `skipped ${entry.path}: git could not read its status`
  }
  if (dirty.length) {
    return `skipped ${entry.path}: it has uncommitted changes or untracked files`
  }
  if (inUse(entry.path)) {
    return `skipped ${entry.path}: a program is using a folder or file inside it; close it and run remove again`
  }
  const links = findLinks(entry.path)
  links.forEach(removeLink)
  if (findLinks(entry.path).length) {
    return `skipped ${entry.path}: links are still left inside it`
  }
  if (entry.locked) {
    tryGit(['worktree', 'unlock', entry.path])
  }
  try {
    git(['worktree', 'remove', '--force', entry.path])
  } catch (error) {
    const reason = error.stderr?.toString().trim() || error.message
    if (entry.locked) {
      tryGit(['worktree', 'lock', ...(entry.lockReason ? ['--reason', entry.lockReason] : []), entry.path])
    }
    // git may have deleted part of the folder before it failed: say so instead of calling it skipped.
    const partial = !existsSync(join(entry.path, '.git'))
    return partial
      ? `failed ${entry.path}: git deleted part of it and then stopped (${reason}); its links were unlinked already. Nothing outside it was touched. Close what is using it and run remove again.`
      : `skipped ${entry.path}: git refused to remove it (${reason}); its links were unlinked already`
  }
  // git removed the worktree but may leave ignored files it couldn't delete; no links are left, so this stays inside.
  if (existsSync(entry.path)) {
    rmSync(entry.path, { recursive: true, force: true, maxRetries: 3 })
  }
  return `removed ${entry.path}${links.length ? ` (${links.length} link(s) unlinked first)` : ''}`
}

function remove(paths, forceLocked) {
  const known = worktrees()
  try {
    for (const path of paths) {
      const entry = known.find(w => same(w.path, path))
      if (!entry || same(entry.path, known[0].path)) {
        console.log(`skipped ${path}: not a linked worktree of this repository`)
        continue
      }
      try {
        console.log(removeOne(entry, forceLocked))
      } catch (error) {
        console.log(`skipped ${entry.path}: ${error.message}`)
      }
    }
  } finally {
    // prune drops every worktree whose folder is gone, and with it the only record of a detached one's commits.
    const orphans = worktrees().filter(w => !w.locked && !existsSync(w.path) && detachedAndUnreachable(w))
    if (orphans.length) {
      console.log(`not pruned: ${orphans.map(w => `${w.path} (HEAD ${w.head})`).join(', ')} is gone but holds commits no branch has; create a branch for them, then run remove again`)
    } else {
      tryGit(['worktree', 'prune'])
    }
  }
}

function deleteBranches(names, into) {
  const base = mergeTarget(into)
  const checkedOut = new Set(worktrees().map(w => w.branch).filter(Boolean))
  for (const name of names) {
    if (!localBranch(name)) {
      console.log(`skipped ${name}: no such local branch`)
    } else if (checkedOut.has(name)) {
      console.log(`skipped ${name}: checked out in a worktree`)
    } else if (name === base) {
      console.log(`skipped ${name}: it is the merge target`)
    } else if (tryGit(['merge-base', '--is-ancestor', `refs/heads/${name}`, base]) === null) {
      console.log(`skipped ${name}: not merged into ${base}`)
    } else if (tryGit(['branch', '-D', name]) === null) {
      console.log(`skipped ${name}: git could not delete it`)
    } else {
      console.log(`deleted ${name}`)
    }
  }
}

const usage = 'usage: worktrees.mjs list [--into <ref>] | remove [--force-locked] <path>... | delete-branches [--into <ref>] <name>...'
const [command, ...args] = process.argv.slice(2)
const forceLocked = args.includes('--force-locked')
const intoAt = args.indexOf('--into')
const into = intoAt === -1 ? '' : args[intoAt + 1] ?? ''
const targets = args.filter((arg, i) => arg !== '--force-locked' && arg !== '--into' && (intoAt === -1 || i !== intoAt + 1))
try {
  if (intoAt !== -1 && (!into || into.startsWith('--'))) {
    throw new Error('--into needs a ref')
  }
  if (command === 'list') {
    console.log(JSON.stringify(list(into), null, 2))
  } else if (command === 'remove' && targets.length) {
    remove(targets, forceLocked)
  } else if (command === 'delete-branches' && targets.length) {
    deleteBranches(targets, into)
  } else {
    console.error(usage)
    process.exit(1)
  }
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message)
  process.exit(1)
}
