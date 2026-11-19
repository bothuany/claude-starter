---
cycle: agent-config
author: rbdikmen@gmail.com
phase: plan-review
branch: cycle/agent-config
---

# Agent model/effort settings, and row spacing in the /phase pane

## Why

The role agents fix their model and effort in frontmatter (reviewer: Opus, medium). That suits a 20x plan, not
everyone's. Users need to lower them (say reviewer to Sonnet) without forking the plugin. The /phase pane's rows
also sit too close together to read (screenshot from the desktop app: the head block and the card).

## Decisions (settled with the user; do not reopen)

- Settings live in `userConfig` in `plugins/starter/.claude-plugin/plugin.json`: asked at install, changed through
  `/config` rows or `/plugin configure`, stored in settings.json `pluginConfigs`. One source of truth: no `$.store`
  copy.
- Seven string fields, each with `options` so `/config` draws a picker:
  - `profile`: `max` (default) | `balanced` | `light`.
  - `reader_model`, `writer_model`, `reviewer_model`: `profile` (default) | `opus` | `sonnet` | `haiku`.
  - `reader_effort`, `writer_effort`, `reviewer_effort`: `profile` (default) | `low` | `medium` | `high` | `xhigh` | `max`.
  - (`inherit` is left out: the Agent tool's `model` parameter does not take it.)
- Profiles (approved by the user):

  | profile  | reader          | writer          | reviewer        |
  |----------|-----------------|-----------------|-----------------|
  | max      | sonnet · medium | sonnet · high   | opus · medium   |
  | balanced | sonnet · low    | sonnet · medium | sonnet · high   |
  | light    | haiku · low     | sonnet · medium | sonnet · medium |

  A field set to anything but `profile` wins over the profile and stays when the profile changes.
- Applied in the existing `tool.call` hook in `plugins/starter/hooks/register.tsx`: for `e.tool === 'Agent'` whose
  `subagent_type` is `starter:reader|writer|reviewer`, call `next({ ...e, model, effort })` with the resolved values.
  The setting wins over a `model`/`effort` the lead passed. Other agent types pass through untouched. The rewrite
  happens before the existing `efforts` bookkeeping and before `agent.spawn`, so the /phase card shows the real
  model and effort. A failure in resolving falls back to passing `e` unchanged (the hook must never break a spawn).
  Not `${user_config}` in agent frontmatter: the docs do not say it is substituted there.
- The agent frontmatter keeps today's values (the `max` profile), so the plugin behaves as before when no hook runs.
- `/starter:agents` toggles a pane (id `agents`, like `/phase` toggles `phase`) with one `Select` per field, drawn
  on terminal and desktop. A pick calls `$.config.set({ key, value })`, the key taken from `$.config.list()` (the row
  whose provider is this plugin and whose key ends in `.<field>`), so an installed and a `--plugin-dir` copy both work.
  Each role row also shows the resolved `model · effort` it will run on. A `{ deny }` (a locked row) shows a toast.
- Global env vars (`CLAUDE_CODE_SUBAGENT_MODEL` with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, `CLAUDE_CODE_EFFORT_LEVEL`)
  are documented as a fallback only: they apply to every subagent, not per role.
- /phase pane spacing: `rowGap="sm"` on the column boxes of the head block (the `head`+`main` box and `leadBlock`'s
  column), the card (body column and the rail column alike, so each `▍` stays beside its line) and the finished-phases
  list. `sm` is 0 rows in the terminal (so a narrow terminal pane gets no taller) and a small gap on desktop.
- Version 0.11.0 (`plugin.json`, `.claude-plugin/marketplace.json`).

## Items

- [ ] 1. Add the seven `userConfig` fields above to `plugins/starter/.claude-plugin/plugin.json`, each with a
  `description`, `default` and `options`; bump `version` to 0.11.0 there and in `.claude-plugin/marketplace.json`.
  check: `claude plugin validate plugins/starter && node -e "const c=require('./plugins/starter/.claude-plugin/plugin.json');const k=Object.keys(c.userConfig||{});if(k.length!==7||c.version!=='0.11.0')process.exit(1)"`
- [ ] 2. In `register.tsx`, a `PROFILES` table and a resolver from `options` + role to `{ model, effort }`; the
  `tool.call` rewrite for `starter:*` Agent calls. Tests in `register.test.tsx` (with `test(name, { options }, ...)`):
  default options give today's values; `profile: light` gives haiku/low for reader; `reviewer_model: sonnet` with
  `profile: max` gives sonnet/medium; a model the lead passed is replaced; a non-starter agent is untouched; the
  /phase agent row shows the rewritten model and effort.
  check: `claude plugin test plugins/starter`
- [ ] 3. `/starter:agents` command and pane: Selects for the seven fields, resolved `model · effort` per role, a pick
  calls `$.config.set` with the listed row's key, a deny shows a toast. Tests mount it on `terminal` and `desktop`,
  select a value and assert the `config.set` it raised (key and value).
  check: `claude plugin test plugins/starter`
- [ ] 4. /phase spacing: `rowGap="sm"` on the boxes named in the decisions; the rail column matches the body column.
  A test asserts the rail and body columns carry the same `rowGap` and the line count still matches.
  check: `claude plugin test plugins/starter`
- [ ] 5. Docs: README (one short section: picking a profile, `/config`, `/starter:agents`) and `docs/DETAILS.md`
  (fields, profile table, precedence, the env var fallback); the plugin.json `description` names the settings.
  check: `grep -q "starter:agents" README.md && grep -q "CLAUDE_CODE_SUBAGENT_MODEL" docs/DETAILS.md && grep -q "balanced" docs/DETAILS.md`
- [ ] 6. Type check and the script tests still pass.
  check: `node --test test/scripts.test.mjs && claude plugin validate plugins/starter`

## Log

- gather: profiles approved by the user; screenshot (desktop) shows the head block and card rows crowded; `$.config.set` writes a plugin's own `<plugin>.<field>` row (ConfigRow doc in the engine types)
- plan: 6 items, each with a check; profiles, fields and spacing settled in the decisions
