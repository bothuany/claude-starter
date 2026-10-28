#!/usr/bin/env node
// Safe cleanup of git worktrees and merged branches, run from inside a repository.
//
//   node worktrees.mjs list                  every linked worktree and local branch, as JSON
//   node worktrees.mjs remove [--force-locked] <path>...   remove clean worktrees (locked ones only when forced)
//   node worktrees.mjs delete-branches <name>...   delete branches already merged into the default branch
//
// Why not plain `git worktree remove --force`: worktrees often hold links (symlinks, or NTFS junctions on Windows)
// to big folders such as node_modules in the main checkout, and Git for Windows deletes through a junction. This
// script deletes every link inside a worktree first (the link only, never its target), then removes the worktree.
// It refuses a worktree with uncommitted changes or untracked files, and a branch that isn't merged.
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

const git = (args, cwd = process.cwd()) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const tryGit = (args, cwd) => {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()

function defaultBranch() {
  const head = tryGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head) {
    return head
  }
  return ['main', 'master'].find(name => tryGit(['rev-parse', '--verify', '--quiet', name])) || 'HEAD'
}

function worktrees() {
  const list = []
  let current = null
  for (const line of git(['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9), branch: null }
      list.push(current)
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).replace('refs/heads/', '')
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true
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

// Changed or untracked paths, leaving out links: a link such as node_modules is untracked to git (a .gitignore
// pattern like `node_modules/` doesn't match a symlink) but holds no work of its own.
function dirtyFiles(worktree) {
  const entries = (tryGit(['status', '--porcelain', '-z'], worktree) ?? '').split('\0').filter(Boolean)
  return entries.filter(entry => {
    try {
      return !lstatSync(join(worktree, entry.slice(3).replace(/\/$/, ''))).isSymbolicLink()
    } catch {
      return true
    }
  })
}

function removeLink(path) {
  try {
    rmdirSync(path)
  } catch {
    unlinkSync(path)
  }
}

function list() {
  const base = defaultBranch()
  const [main, ...linked] = worktrees()
  const checkedOut = new Set(worktrees().map(w => w.branch).filter(Boolean))
  const result = { defaultBranch: base, mainCheckout: main.path, worktrees: [], mergedBranches: [], unmergedBranches: [] }
  for (const w of linked) {
    const head = tryGit(['rev-parse', 'HEAD'], w.path)
    const dirty = existsSync(w.path) ? dirtyFiles(w.path).length : null
    result.worktrees.push({
      path: w.path,
      branch: w.branch ?? '(detached)',
      merged: head ? tryGit(['merge-base', '--is-ancestor', head, base]) !== null : null,
      dirtyFiles: dirty,
      locked: Boolean(w.locked),
      missing: !existsSync(w.path),
    })
  }
  for (const branch of git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean)) {
    if (checkedOut.has(branch) || branch === base || `origin/${branch}` === base) {
      continue
    }
    const merged = tryGit(['merge-base', '--is-ancestor', branch, base]) !== null
    ;(merged ? result.mergedBranches : result.unmergedBranches).push(branch)
  }
  return result
}

function remove(paths, forceLocked) {
  const known = worktrees()
  for (const path of paths) {
    const entry = known.find(w => same(w.path, path))
    if (!entry || same(entry.path, known[0].path)) {
      console.log(`skipped ${path}: not a linked worktree of this repository`)
      continue
    }
    // Claude Code locks the worktree of a running agent or background session; a lock is never overridden quietly.
    if (entry.locked && !forceLocked) {
      console.log(`skipped ${entry.path}: it is locked (a running session may be using it); pass --force-locked to remove it anyway`)
      continue
    }
    if (entry.locked) {
      tryGit(['worktree', 'unlock', entry.path])
    }
    if (existsSync(entry.path)) {
      if (dirtyFiles(entry.path).length) {
        console.log(`skipped ${entry.path}: it has uncommitted changes or untracked files`)
        continue
      }
      const links = findLinks(entry.path)
      links.forEach(removeLink)
      if (findLinks(entry.path).length) {
        console.log(`skipped ${entry.path}: links are still left inside it`)
        continue
      }
      tryGit(['worktree', 'remove', '--force', entry.path])
      // git leaves ignored files it couldn't delete behind; no links are left, so deleting the rest stays inside.
      if (existsSync(entry.path)) {
        rmSync(entry.path, { recursive: true, force: true, maxRetries: 3 })
      }
      console.log(`removed ${entry.path}${links.length ? ` (${links.length} link(s) unlinked first)` : ''}`)
    } else {
      console.log(`pruned ${entry.path} (folder was already gone)`)
    }
  }
  git(['worktree', 'prune'])
}

function deleteBranches(names) {
  const base = defaultBranch()
  const checkedOut = new Set(worktrees().map(w => w.branch).filter(Boolean))
  for (const name of names) {
    if (tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) === null) {
      console.log(`skipped ${name}: no such local branch`)
    } else if (checkedOut.has(name)) {
      console.log(`skipped ${name}: checked out in a worktree`)
    } else if (tryGit(['merge-base', '--is-ancestor', `refs/heads/${name}`, base]) === null) {
      console.log(`skipped ${name}: not merged into ${base}`)
    } else if (tryGit(['branch', '-D', name]) === null) {
      console.log(`skipped ${name}: git could not delete it`)
    } else {
      console.log(`deleted ${name}`)
    }
  }
}

const usage = 'usage: worktrees.mjs list | remove [--force-locked] <path>... | delete-branches <name>...'
const [command, ...args] = process.argv.slice(2)
const forceLocked = args.includes('--force-locked')
const targets = args.filter(arg => arg !== '--force-locked')
try {
  if (command === 'list') {
    console.log(JSON.stringify(list(), null, 2))
  } else if (command === 'remove' && targets.length) {
    remove(targets, forceLocked)
  } else if (command === 'delete-branches' && targets.length) {
    deleteBranches(targets)
  } else {
    console.error(usage)
    process.exit(1)
  }
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message)
  process.exit(1)
}
