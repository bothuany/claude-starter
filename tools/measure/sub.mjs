// Subagent economics from local transcripts: what delegated steps cost in their own context versus what the same
// number of steps would have re-read in the main context at the moment of the spawn. Reads the transcripts under the
// Claude config dir (projects/*/*.jsonl and their subagents/ folders). Aggregates only.
//
//   node sub.mjs --since <date> [--cut <date>]    sessions that started on or after --since; --cut adds a before/after split
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
// A flag with no value after it comes back as '', which does not parse and ends in the usage error.
const dateArg = name => {
  const i = process.argv.indexOf(name)
  return i > 1 ? process.argv[i + 1] ?? '' : undefined
}
const sinceArg = dateArg('--since'), cutArg = dateArg('--cut')
const SINCE = Date.parse(sinceArg ?? '')
const CUT = cutArg === undefined ? undefined : Date.parse(cutArg)
if (Number.isNaN(SINCE) || Number.isNaN(CUT)) {
  console.error('usage: node sub.mjs --since <date, e.g. 2026-11-01> [--cut <date>]')
  process.exit(1)
}
if (!existsSync(root)) {
  console.log(`no transcripts found under ${root}`)
  process.exit(0)
}
const k = n => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`)
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0 }
const ctxOf = u => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

// Requests of one transcript file: [{ t, ctx, write, model }], one per API message id; sidechain lines skipped.
function requests(path) {
  const seen = new Set(), out = []
  let firstId, attach = 0
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'attachment') attach += line.length
    if (e.type !== 'assistant' || !e.message?.usage) continue
    const id = e.message.id ?? e.requestId ?? e.uuid
    if (seen.has(id)) continue
    seen.add(id)
    firstId ||= id
    out.push({ t: Date.parse(e.timestamp) || 0, ctx: ctxOf(e.message.usage), write: e.message.usage.cache_creation_input_tokens || 0, model: e.message.model || '?', side: Boolean(e.isSidechain) })
  }
  return { reqs: out, firstId, attach }
}
const walk = dir => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.jsonl') ? [join(dir, d.name)] : [])) : [])

const byFirst = new Map() // dedupe forks and resumes: same first API message id -> keep the longest
for (const project of readdirSync(root)) {
  let files
  try { files = readdirSync(join(root, project)).filter(f => f.endsWith('.jsonl')) } catch { continue }
  for (const f of files) {
    const path = join(root, project, f)
    if (statSync(path).mtimeMs < SINCE) continue
    const { reqs, firstId, attach } = requests(path)
    const main = reqs.filter(r => !r.side)
    if (main.length < 5 || main[0].t < SINCE) continue
    const s = { path, dir: join(root, project, f.slice(0, -6)), main, attach, first: main[0].t }
    const prev = byFirst.get(firstId)
    if (!prev || prev.main.length < main.length) byFirst.set(firstId, s)
  }
}
const sessions = [...byFirst.values()]
if (!sessions.length) {
  console.log(`no sessions found since ${sinceArg}`)
  process.exit(0)
}
console.log(`unique sessions (forks and resumes folded): ${sessions.length}`)
const peaks = sessions.map(s => Math.max(...s.main.map(r => r.ctx)))
console.log(`peak main context: median ${k(q(peaks, 0.5))}, p75 ${k(q(peaks, 0.75))}, p90 ${k(q(peaks, 0.9))}; over 200k: ${peaks.filter(p => p > 2e5).length}, over 500k: ${peaks.filter(p => p > 5e5).length}`)
const reqCounts = sessions.map(s => s.main.length)
console.log(`main requests per session: median ${q(reqCounts, 0.5)}, p90 ${q(reqCounts, 0.9)}`)
// Where the re-read volume sits: share of all main-session context tokens spent in requests above a context size.
const all = sessions.flatMap(s => s.main)
const tot = all.reduce((n, r) => n + r.ctx, 0)
for (const lim of [1e5, 2e5, 5e5]) console.log(`share of main re-read volume in requests with context over ${k(lim)}: ${Math.round((100 * all.filter(r => r.ctx > lim).reduce((n, r) => n + r.ctx, 0)) / tot)}% (${Math.round((100 * all.filter(r => r.ctx > lim).length) / all.length)}% of requests)`)

function economics(name, list) {
  let agents = 0, steps = 0, own = 0, inline = 0, mainTot = 0, starts = [], spawnCtx = [], perAgentSteps = [], models = {}
  for (const s of list) {
    mainTot += s.main.reduce((n, r) => n + r.ctx, 0)
    for (const file of walk(join(s.dir, 'subagents'))) {
      const { reqs } = requests(file)
      if (!reqs.length) continue
      agents++
      const at = reqs[0].t
      // Main context at the spawn: the last main request before the subagent's first one.
      const before = s.main.filter(r => r.t <= at)
      const c = (before.at(-1) ?? s.main[0]).ctx
      spawnCtx.push(c)
      starts.push(reqs[0].ctx)
      perAgentSteps.push(reqs.length)
      steps += reqs.length
      own += reqs.reduce((n, r) => n + r.ctx, 0)
      inline += reqs.length * c
      const m = reqs[0].model.replace('claude-', '')
      models[m] = (models[m] || 0) + 1
    }
  }
  console.log(`\n## ${name}: ${list.length} sessions, ${agents} subagent transcripts`)
  if (!agents) return
  console.log(`models: ${Object.entries(models).map(([m, n]) => `${m} ${n}`).join(', ')}`)
  console.log(`subagent first-request context (start-up): median ${k(q(starts, 0.5))}, p90 ${k(q(starts, 0.9))}`)
  console.log(`steps per subagent: median ${q(perAgentSteps, 0.5)}, p90 ${q(perAgentSteps, 0.9)}`)
  console.log(`main context at spawn: median ${k(q(spawnCtx, 0.5))}, p25 ${k(q(spawnCtx, 0.25))}, p75 ${k(q(spawnCtx, 0.75))}`)
  console.log(`subagents re-read in their own contexts: ${k(own)} over ${steps} steps (avg ${k(own / steps)} per step)`)
  console.log(`the same step count at the main context of each spawn: ${k(inline)} (${(inline / own).toFixed(1)}x)`)
  console.log(`main-session re-read volume in these sessions: ${k(mainTot)}; subagents are ${Math.round((100 * own) / (own + mainTot))}% of the total`)
}
const withAgents = sessions.filter(s => existsSync(join(s.dir, 'subagents')))
economics('all sessions with subagents', withAgents)
if (CUT !== undefined) {
  economics(`before ${cutArg}`, withAgents.filter(s => s.first < CUT))
  economics(`from ${cutArg}`, withAgents.filter(s => s.first >= CUT))
}

// Per subagent: did its own re-read volume come in under the inline estimate?
let under = 0, over = 0
for (const s of sessions) for (const file of walk(join(s.dir, 'subagents'))) {
  const { reqs } = requests(file)
  if (!reqs.length) continue
  const c = (s.main.filter(r => r.t <= reqs[0].t).at(-1) ?? s.main[0]).ctx
  reqs.reduce((n, r) => n + r.ctx, 0) < reqs.length * c ? under++ : over++
}
console.log(`\nsubagents whose own volume was below the inline estimate: ${under}; above: ${over}`)
const att = sessions.reduce((n, s) => n + s.attach, 0)
console.log(`attachment records (hook context, reminders, file attachments), raw JSON chars across sessions: ${k(att)}`)
