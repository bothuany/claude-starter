#!/usr/bin/env node
// Runs every item's `check:` command of a cycle plan and prints one line: `PASS 7/7` or `FAIL 5/7: 3, 6`.
//
//   node plan-check.mjs <plan>    exit 0 when all pass, 1 when any fails, 2 when nothing was run
//
// Runs nothing unless the plan's single `author:` equals `git config user.email` (letter case ignored): a teammate's
// plan, or an unmarked one, is not this user's cycle. Each command runs in bash from the repository root, as the
// plan contract in skills/cycle/SKILL.md says; a failing check's output goes to stderr.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// The plan's author and its items, by the contract the /phase pane reads (hooks/register.tsx parsePlan).
export function parseChecks(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (lines[0]?.trim() !== '---' || end < 0) return undefined
  const authors = lines.slice(1, end).map(l => /^author:\s*(.*?)\s*$/.exec(l)?.[1]).filter(a => a !== undefined)
  const author = authors.length === 1 ? authors[0].replace(/^(["'])(.*)\1$/, '$2').toLowerCase() : undefined
  const items = []
  let section = ''
  let fence
  for (const line of lines.slice(end + 1)) {
    const run = /^(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence ? run && run[0] === fence[0] && run.length >= fence.length : run) {
      fence = fence ? undefined : run
      continue
    }
    if (fence) continue
    const head = /^## (.*?)\s*$/.exec(line)
    if (head) section = head[1].toLowerCase()
    else if (section === 'items') {
      const item = /^- \[[ xX]\] (\d+)\./.exec(line)
      if (item) items.push({ n: Number(item[1]), check: undefined })
      const check = /^\s+check:\s*(.*?)\s*$/.exec(line)
      const last = items.at(-1)
      if (check && last && last.check === undefined) last.check = check[1].replace(/^`(.*)`$/, '$1')
    }
  }
  return { author, items }
}

function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node plan-check.mjs <plan>')
    return 2
  }
  const plan = parseChecks(readFileSync(file, 'utf8'))
  if (!plan) {
    console.error(`${file}: no front matter, not a cycle plan`)
    return 2
  }
  const git = args => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return ''
    }
  }
  const email = git(['config', 'user.email']).toLowerCase()
  if (!email || plan.author !== email) {
    console.error(`${file}: author is ${plan.author ?? 'not set (none or two)'}, not ${email || 'an unset user.email'}; ran nothing`)
    return 2
  }
  if (plan.items.length === 0) {
    console.error(`${file}: no items`)
    return 2
  }
  const cwd = git(['rev-parse', '--show-toplevel']) || process.cwd()
  const failed = []
  for (const { n, check } of plan.items) {
    if (!check) {
      failed.push(n)
      console.error(`--- ${n}: no check: line`)
      continue
    }
    const r = spawnSync('bash', ['-c', check], { cwd, encoding: 'utf8' })
    if (r.status !== 0) {
      failed.push(n)
      console.error(`--- ${n}: exit ${r.status ?? r.error?.message}\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim()}`)
    }
  }
  const total = plan.items.length
  console.log(failed.length ? `FAIL ${total - failed.length}/${total}: ${failed.join(', ')}` : `PASS ${total}/${total}`)
  return failed.length ? 1 : 0
}

if (process.argv[1]?.endsWith('plan-check.mjs')) process.exitCode = main()
