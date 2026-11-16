// What fills the main session's context? Reads local transcripts, prints aggregates only (no content).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = join(homedir(), '.claude', 'projects')
const SINCE = Date.parse('2026-10-20')
const CUT = Date.parse('2026-11-12') // 0.9.0: "the lead delegates all code"
const CAT = name =>
  /^(Read|Grep|Glob|NotebookRead)$/.test(name) ? 'read'
  : /^(Bash|PowerShell)$/.test(name) ? 'shell'
  : /^(Agent|Task|Workflow)$/.test(name) ? 'agent'
  : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name) ? 'edit'
  : /^(WebFetch|WebSearch)$|browser|obscura/i.test(name) ? 'web'
  : /^mcp__/.test(name) ? 'mcp'
  : name === 'Skill' ? 'skill' : 'other'
const len = c => (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((n, b) => n + (typeof b?.text === 'string' ? b.text.length : b?.type === 'image' ? 6000 : 0), 0) : 0)

const sessions = []
for (const project of readdirSync(root)) {
  let files
  try { files = readdirSync(join(root, project)).filter(f => f.endsWith('.jsonl')) } catch { continue }
  for (const f of files) {
    const path = join(root, project, f)
    if (statSync(path).mtimeMs < SINCE) continue
    const tools = new Map() // tool_use id -> name
    const items = [] // { cat, chars, at: request index when it entered context }
    const seen = new Set()
    let requests = 0, peak = 0, compactions = 0, first = 0, model = {}, starter = 0, agents = 0
    const total = { in: 0, read: 0, write: 0, out: 0 }
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (e.isSidechain) continue
      if (e.type === 'system' && e.subtype === 'compact_boundary') compactions++
      if (e.type !== 'user' && e.type !== 'assistant') continue
      first ||= Date.parse(e.timestamp) || 0
      const content = e.message?.content
      if (e.type === 'assistant') {
        const id = e.message?.id ?? e.requestId ?? e.uuid
        const u = e.message?.usage
        if (u && !seen.has(id)) {
          seen.add(id)
          requests++
          const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
          peak = Math.max(peak, ctx)
          total.in += u.input_tokens || 0; total.read += u.cache_read_input_tokens || 0
          total.write += u.cache_creation_input_tokens || 0; total.out += u.output_tokens || 0
          const m = e.message?.model || '?'
          model[m] = (model[m] || 0) + 1
        }
        if (Array.isArray(content)) for (const b of content) {
          if (b?.type === 'text') items.push({ cat: 'assistant-text', chars: b.text.length, at: requests })
          if (b?.type === 'tool_use') {
            tools.set(b.id, b.name)
            const c = CAT(b.name)
            if (c === 'agent') { agents++; if (String(b.input?.subagent_type || '').startsWith('starter:')) starter++ }
            items.push({ cat: c === 'edit' ? 'edit-input' : c === 'agent' ? 'agent-prompt' : 'other-input', chars: JSON.stringify(b.input ?? {}).length, at: requests })
          }
        }
      } else if (typeof content === 'string') {
        items.push({ cat: e.isCompactSummary ? 'compact-summary' : 'user-text', chars: content.length, at: requests })
      } else if (Array.isArray(content)) for (const b of content) {
        if (b?.type === 'tool_result') items.push({ cat: `${CAT(tools.get(b.tool_use_id) || '?')}-result`, chars: len(b.content), at: requests })
        else if (b?.type === 'text') items.push({ cat: e.isCompactSummary ? 'compact-summary' : 'user-text', chars: b.text.length, at: requests })
      }
    }
    if (requests < 5 || first < SINCE) continue
    const raw = {}, weighted = {}
    for (const it of items) {
      raw[it.cat] = (raw[it.cat] || 0) + it.chars
      weighted[it.cat] = (weighted[it.cat] || 0) + it.chars * Math.max(0, requests - it.at) // re-read on every later request
    }
    const top = Object.entries(model).sort((a, b) => b[1] - a[1])[0][0]
    sessions.push({ project, id: f.slice(0, 8), first, requests, peak, compactions, model: top.replace('claude-', ''), agents, starter, raw, weighted, total })
  }
}

const pct = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : '-')
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0 }
const k = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`)
const ORDER = ['read-result', 'shell-result', 'web-result', 'mcp-result', 'agent-result', 'agent-prompt', 'edit-input', 'edit-result', 'skill-result', 'other-result', 'other-input', 'assistant-text', 'user-text', 'compact-summary']

function report(name, list) {
  if (!list.length) return console.log(`\n## ${name}: no sessions`)
  const sum = key => { const o = {}; for (const s of list) for (const [c, v] of Object.entries(s[key])) o[c] = (o[c] || 0) + v; return o }
  const raw = sum('raw'), w = sum('weighted')
  const rawAll = Object.values(raw).reduce((a, b) => a + b, 0), wAll = Object.values(w).reduce((a, b) => a + b, 0)
  const peaks = list.map(s => s.peak)
  const t = list.reduce((a, s) => ({ in: a.in + s.total.in, read: a.read + s.total.read, write: a.write + s.total.write, out: a.out + s.total.out }), { in: 0, read: 0, write: 0, out: 0 })
  console.log(`\n## ${name}: ${list.length} sessions`)
  console.log(`peak main context: median ${k(q(peaks, 0.5))}, p90 ${k(q(peaks, 0.9))}, max ${k(Math.max(...peaks))}`)
  console.log(`sessions over 200k: ${list.filter(s => s.peak > 2e5).length}, over 500k: ${list.filter(s => s.peak > 5e5).length}, compacted: ${list.filter(s => s.compactions).length}`)
  console.log(`main-session tokens: cache read ${k(t.read)} (${pct(t.read, t.read + t.write + t.in + t.out)}), cache write ${k(t.write)}, input ${k(t.in)}, output ${k(t.out)}`)
  console.log(`sessions with Agent calls: ${list.filter(s => s.agents).length}; with starter:* roles: ${list.filter(s => s.starter).length}`)
  console.log('category          share of content   share weighted by re-reads')
  for (const c of ORDER) if (raw[c]) console.log(`${c.padEnd(18)}${pct(raw[c], rawAll).padStart(8)}${pct(w[c], wAll).padStart(22)}`)
}

report('ALL', sessions)
report('before 0.9.0 (to Nov 11)', sessions.filter(s => s.first < CUT))
report('since 0.9.0 (Nov 12 on)', sessions.filter(s => s.first >= CUT))
report('since 0.9.0, sessions using starter roles', sessions.filter(s => s.first >= CUT && s.starter))
report('since 0.9.0, sessions without starter roles', sessions.filter(s => s.first >= CUT && !s.starter))
report('Fable-led', sessions.filter(s => /fable/.test(s.model)))
report('peak over 200k', sessions.filter(s => s.peak > 2e5))

console.log('\n## 12 largest sessions by peak context')
for (const s of [...sessions].sort((a, b) => b.peak - a.peak).slice(0, 12)) {
  const all = Object.values(s.weighted).reduce((a, b) => a + b, 0)
  const top3 = Object.entries(s.weighted).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, v]) => `${c} ${pct(v, all)}`).join(', ')
  console.log(`${new Date(s.first).toISOString().slice(0, 10)} ${s.id} ${s.model.padEnd(11)} peak ${k(s.peak).padStart(5)} req ${String(s.requests).padStart(4)} compact ${s.compactions} agents ${s.agents}(${s.starter}) | ${top3}`)
}
