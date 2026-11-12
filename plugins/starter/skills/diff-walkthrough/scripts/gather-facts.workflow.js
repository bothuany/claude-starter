export const meta = {
  name: 'diff-walkthrough-facts',
  description: 'Gather verified facts for a diff walkthrough: Haiku inventory, Sonnet per component, Haiku claim check',
  whenToUse: 'Step 1 of the diff-walkthrough skill, before writing the storyboard',
  phases: [
    { title: 'Inventory', detail: 'one Haiku agent: diff stats, file groups, options, tests, components', model: 'haiku' },
    { title: 'Explain', detail: 'one Sonnet agent per component: behavior, guards, failure paths, diagram', model: 'sonnet' },
    { title: 'Check', detail: 'one Haiku agent per component: every claim against the code', model: 'haiku' },
    { title: 'Release', detail: 'one Sonnet agent: preconditions outside the code', model: 'sonnet' },
  ],
}

// args: { repos: { alias: { path, base, head, name? } }, pr_text?: string, max_components?: number }
// Agent count: 1 inventory + 2 per component + 1 release. With the default cap of 4 components: 10.
const repos = args && args.repos
if (!repos || !Object.keys(repos).length) throw new Error('args.repos is required: { alias: { path, base, head } }')
const CAP = (args && args.max_components) || 4
const repoText = Object.entries(repos)
  .map(([k, r]) => `- ${k}: path ${r.path}, base ${r.base}, head ${r.head}`).join('\n')
const prText = (args && args.pr_text) ? `\nPR descriptions supplied by the user:\n${args.pr_text}\n` : ''

const EVIDENCE = {
  type: 'object',
  properties: {
    repo: { type: 'string' }, file: { type: 'string' },
    anchor: { type: 'string', description: 'exact substring of ONE line at the head ref, copied verbatim' },
    end_anchor: { type: 'string', description: 'optional exact substring of a later line that ends the excerpt' },
  },
  required: ['repo', 'file', 'anchor'],
}

const INVENTORY = {
  type: 'object',
  properties: {
    stats: { type: 'array', items: { type: 'object', properties: {
      repo: { type: 'string' }, files: { type: 'number' }, added: { type: 'number' }, removed: { type: 'number' } },
      required: ['repo', 'files', 'added', 'removed'] } },
    file_groups: { type: 'array', items: { type: 'object', properties: {
      label: { type: 'string' }, repo: { type: 'string' }, globs: { type: 'array', items: { type: 'string' } } },
      required: ['label', 'repo', 'globs'] } },
    options: { type: 'array', description: 'config keys and option properties with their default values',
      items: { type: 'object', properties: { name: { type: 'string' }, default: { type: 'string' }, where: { type: 'string' } },
        required: ['name', 'default', 'where'] } },
    tests: { type: 'array', items: { type: 'string' }, description: 'test class or file names, one per entry' },
    components: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, name: { type: 'string' }, summary: { type: 'string' },
      files: { type: 'array', items: { type: 'string' }, description: 'repo-alias:path entries' } },
      required: ['id', 'name', 'summary', 'files'] } },
  },
  required: ['stats', 'file_groups', 'options', 'tests', 'components'],
}

const FACTS = {
  type: 'object',
  properties: {
    purpose: { type: 'string', description: 'one sentence: what this component does for the user of the system' },
    facts: { type: 'array', items: { type: 'object', properties: {
      kind: { type: 'string', enum: ['behavior', 'guard', 'failure', 'config', 'data', 'risk'] },
      claim: { type: 'string', description: 'one plain English sentence a reviewer can check against the code' },
      why: { type: 'string', description: 'what would go wrong without this code; empty if unknown' },
      evidence: EVIDENCE },
      required: ['kind', 'claim', 'why', 'evidence'] } },
    diagram: { type: 'object', description: 'the one picture that explains this component', properties: {
      kind: { type: 'string', enum: ['flow', 'sequence', 'state'] },
      nodes: { type: 'array', items: { type: 'string' } },
      edges: { type: 'array', items: { type: 'string' }, description: '"A -> B : verb" entries, in narration order' } },
      required: ['kind', 'nodes', 'edges'] },
    undocumented: { type: 'array', items: { type: 'string' }, description: 'changes the PR text does not mention' },
  },
  required: ['purpose', 'facts', 'diagram', 'undocumented'],
}

const VERDICTS = {
  type: 'object',
  properties: { verdicts: { type: 'array', items: { type: 'object', properties: {
    index: { type: 'number' }, anchor_found: { type: 'boolean' },
    supported: { type: 'boolean' }, note: { type: 'string' } },
    required: ['index', 'anchor_found', 'supported', 'note'] } } },
  required: ['verdicts'],
}

const RELEASE = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: {
    title: { type: 'string' }, body: { type: 'string' },
    severity: { type: 'string', enum: ['blocker', 'config', 'deploy', 'follow-up'] },
    evidence: { type: 'string', description: 'file path, ref or command output that proves it' } },
    required: ['title', 'body', 'severity', 'evidence'] } } },
  required: ['items'],
}

const READ_RULE = `Read code only with git, from the refs given (for example \`git -C <path> show <head>:<file>\`,
\`git -C <path> diff <base> <head> -- <file>\`). The working tree may be on another branch. Do not edit anything.`

phase('Inventory')
const inv = await agent(
  `Make an inventory of a code change for a review video.\n\nRepositories:\n${repoText}\n${prText}\n${READ_RULE}\n\n` +
  `1. For each repo: \`git diff --numstat <base> <head>\` and \`--name-status\`. Report file count and line totals.\n` +
  `2. Group the changed files into 3-6 areas a reviewer would name (tests, one per feature area, other) as globs.\n` +
  `3. List new or changed options/config keys with their default values (options classes, appsettings, constants).\n` +
  `4. List the test classes that were added or changed.\n` +
  `5. Split the production code into at most ${CAP} components, in the order data flows through them ` +
  `(data model first). A component is a unit a reviewer would explain in one chapter. Merge small ones. ` +
  `If more than ${CAP} are needed, merge the least important ones and say so in their summary.`,
  { label: 'inventory', phase: 'Inventory', schema: INVENTORY, model: 'haiku', effort: 'low', agentType: 'Explore' })
if (!inv) throw new Error('inventory agent returned nothing')
const comps = inv.components.slice(0, CAP)
if (inv.components.length > CAP) log(`components over the cap, not explained: ${inv.components.slice(CAP).map(c => c.name).join(', ')}`)
log(`${comps.length} components: ${comps.map(c => c.name).join(' → ')}`)

const explain = c => agent(
  `Explain one component of a code change, for the narration of a review video.\n\nRepositories:\n${repoText}\n${prText}\n${READ_RULE}\n\n` +
  `Component: ${c.name}: ${c.summary}\nFiles: ${c.files.join(', ')}\n\n` +
  `Read each file in full at the head ref, and the diff against base. Follow calls into other files when needed.\n` +
  `Return 6-14 facts. Each fact is one checkable sentence about what the code DOES, with the reason in \`why\` ` +
  `(what breaks without it). Prefer guards, ordering decisions, race handling, failure paths and defaults over ` +
  `restating method names. Every fact needs evidence: an anchor that is an exact substring of one line at the ` +
  `head ref. Do not invent a rationale; leave \`why\` empty when the code and comments do not show it.\n` +
  `Also give the one diagram that explains this component, and list changes the PR text does not mention.`,
  { label: `explain:${c.id}`, phase: 'Explain', schema: FACTS, model: 'sonnet' })

const check = (res, c) => {
  if (!res || !res.facts.length) return null
  const list = res.facts.map((f, i) =>
    `${i}. ${f.claim}${f.why ? ' (why: ' + f.why + ')' : ''}\n   evidence: ${f.evidence.repo}:${f.evidence.file} anchor ${JSON.stringify(f.evidence.anchor)}`).join('\n')
  return agent(
    `Check claims about code against the code itself.\n\nRepositories:\n${repoText}\n\n${READ_RULE}\n\n` +
    `For each claim: (a) confirm the anchor is an exact substring of a line in the file at the head ref ` +
    `(\`git -C <path> show <head>:<file> | grep -nF -- '<anchor>'\`); (b) read the surrounding code and decide ` +
    `whether it supports the claim and its why. Mark supported=false ONLY when the code contradicts the claim ` +
    `or the anchor is missing. When the claim is right but imprecise, keep supported=true and write the exact ` +
    `wording in note (for example the real number or the missing case).\n\nClaims:\n${list}`,
    { label: `check:${c.id}`, phase: 'Check', schema: VERDICTS, model: 'haiku', effort: 'low', agentType: 'Explore' })
    .then(v => {
      const by = new Map(((v && v.verdicts) || []).map(x => [x.index, x]))
      const kept = [], dropped = []
      res.facts.forEach((f, i) => {
        const x = by.get(i)
        if (x && x.anchor_found && x.supported) kept.push(x.note ? { ...f, correction: x.note } : f)
        else dropped.push({ ...f, check: x ? x.note : 'not checked' })
      })
      return { id: c.id, name: c.name, purpose: res.purpose, diagram: res.diagram,
               undocumented: res.undocumented, facts: kept, dropped }
    })
}

const release = agent(
  `List what must happen outside the code before this change can ship.\n\nRepositories:\n${repoText}\n${prText}\n${READ_RULE}\n\n` +
  `Look for: new or changed tables and columns (entity configurations, ToTable, required columns), migrations ` +
  `or DDL that is not in the repo, config rows or settings that must exist per environment, package versions ` +
  `and merge order between the repos, deploy effects (downtime, leases, restarts), and follow-ups in other ` +
  `repos. Give evidence for each item. Do not repeat code behavior; only preconditions and consequences.`,
  { label: 'release', phase: 'Release', schema: RELEASE, model: 'sonnet' })

const [components, rel] = await Promise.all([pipeline(comps, explain, check), release])
const done = components.filter(Boolean)
const nDropped = done.reduce((n, c) => n + c.dropped.length, 0)
log(`${done.reduce((n, c) => n + c.facts.length, 0)} facts kept, ${nDropped} dropped by the check`)
return { inventory: inv, components: done, release: rel ? rel.items : [] }
