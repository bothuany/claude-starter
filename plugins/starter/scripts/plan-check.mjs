#!/usr/bin/env node
// Runs every item's `check:` command of a cycle plan and prints one line: `PASS 7/7` or `FAIL 5/7: 3, 6`. When the plan has
// P0/P1 rule cards (`## Rules`), it also looks for a file outside the plan that names each one as `<cycle>/RC<nn>` (its
// test) and adds `· rules 2/3: RC02`: a card nothing names is a failure too.
//
//   node plan-check.mjs <plan>    exit 0 when all pass, 1 when any fails (an item with no check fails), 2 when nothing ran
//
// Runs nothing unless the plan's single `author:` equals `git config user.email` (letter case ignored): a teammate's
// plan, or an unmarked one, is not this user's cycle. Each command runs in bash from the root of the plan's repository,
// as the plan contract in skills/cycle/SKILL.md says; a failing check's output goes to stderr. On Windows `bash` must be
// Git Bash: started from PowerShell it can resolve to WSL's, where the project's tools are missing.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// The plan's author and its items, by the contract the /phase pane reads (hooks/register.tsx parsePlan). Undefined: not a
// cycle plan. Unlike the pane it also treats an indented fence as a fence: an example check inside an item must not run.
export function parseChecks(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (lines[0]?.trim() !== '---' || end < 0) return undefined
  const front = lines.slice(1, end)
  const cycle = front.map(l => /^cycle:\s*(.*?)\s*$/.exec(l)?.[1]).find(Boolean)?.replace(/^(["'])(.*)\1$/, '$2')
  if (!cycle) return undefined
  const authors = front.map(l => /^author:\s*(.*?)\s*$/.exec(l)?.[1]).filter(a => a !== undefined)
  const author = authors.length === 1 ? authors[0].replace(/^(["'])(.*)\1$/, '$2').toLowerCase() : undefined
  const items = []
  const rules = []
  let section = ''
  let fence
  for (const line of lines.slice(end + 1)) {
    // A backtick fence has no backtick after its opening run (CommonMark); "```x``` text" is inline code.
    const run = /^\s*(`{3,}(?!.*`)|~{3,})/.exec(line)?.[1]
    if (fence ? run && run[0] === fence[0] && run.length >= fence.length : run) {
      fence = fence ? undefined : run
      continue
    }
    if (fence) continue
    const head = /^## (.*?)\s*$/.exec(line)
    if (head) section = head[1].toLowerCase()
    else if (section === 'rules') {
      // A struck-out card (`### ~~RC04~~ dropped`) is not a rule.
      const card = /^###\s+(RC\d+)\b/.exec(line)
      if (card) rules.push({ id: card[1], priority: undefined })
      const priority = /^\s*-\s*\*\*Priority:\*\*\s*(P\d)/i.exec(line)
      const last = rules.at(-1)
      if (priority && last && last.priority === undefined) last.priority = priority[1].toUpperCase()
    } else if (section === 'items') {
      const item = /^- \[[ xX]\] (\d+)\./.exec(line)
      if (item) items.push({ n: Number(item[1]), check: undefined })
      const check = /^\s+check:\s*(.*?)\s*$/.exec(line)
      const last = items.at(-1)
      if (check && last && last.check === undefined) last.check = check[1].replace(/^`(.*)`$/, '$1')
    }
  }
  return { cycle, author, items, rules }
}

function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node plan-check.mjs <plan>')
    return 2
  }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    console.error(`${file}: ${e.message}`)
    return 2
  }
  const plan = parseChecks(text)
  if (!plan) {
    console.error(`${file}: no front matter with a cycle: key, not a cycle plan`)
    return 2
  }
  // The plan's own repository decides who the user is and where checks run, wherever the script was started.
  const git = args => {
    try {
      return execFileSync('git', args, { cwd: dirname(resolve(file)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return ''
    }
  }
  const email = git(['config', 'user.email']).toLowerCase()
  if (!email || plan.author !== email) {
    console.error(`${file}: author is ${plan.author || 'not set (empty, none or two)'}, not ${email || 'an unset user.email'}; ran nothing`)
    return 2
  }
  if (plan.items.length === 0) {
    console.error(`${file}: no items`)
    return 2
  }
  const cwd = git(['rev-parse', '--show-toplevel'])
  if (!cwd) {
    console.error(`${file}: not in a git repository; ran nothing`)
    return 2
  }
  const failed = []
  for (const { n, check } of plan.items) {
    if (!check) {
      failed.push(n)
      console.error(`--- ${n}: no check: line`)
      continue
    }
    const r = spawnSync('bash', ['-c', check], { cwd, encoding: 'utf8', maxBuffer: Infinity })
    if (r.status !== 0) {
      failed.push(n)
      console.error(`--- ${n}: exit ${r.status ?? r.error?.message}\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim()}`)
    }
  }
  const total = plan.items.length
  let line = failed.length ? `FAIL ${total - failed.length}/${total}: ${failed.join(', ')}` : `PASS ${total}/${total}`
  // A card without a priority counts as P1, the default for a rule.
  const locked = plan.rules.filter(r => r.priority !== 'P2')
  const uncovered = []
  if (locked.length) {
    const self = resolve(file)
    for (const { id } of locked) {
      const tag = `${plan.cycle}/${id}`
      const r = spawnSync('git', ['grep', '--untracked', '-l', '-w', '-F', '-e', tag, '--', '.'], { cwd, encoding: 'utf8' })
      const named = (r.stdout ?? '').split('\n').filter(Boolean).some(f => resolve(cwd, f) !== self)
      if (!named) {
        uncovered.push(id)
        console.error(`--- ${id}: no file outside the plan names ${tag}`)
      }
    }
    const n = locked.length
    line += uncovered.length ? ` · rules ${n - uncovered.length}/${n}: ${uncovered.join(', ')}` : ` · rules ${n}/${n}`
    if (uncovered.length && !failed.length) line = `FAIL${line.slice(4)}`
  }
  console.log(line)
  return failed.length || uncovered.length ? 1 : 0
}

if (process.argv[1]?.endsWith('plan-check.mjs')) process.exitCode = main()
