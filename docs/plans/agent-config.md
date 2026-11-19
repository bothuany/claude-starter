---
cycle: agent-config
author: rbdikmen@gmail.com
phase: done
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
- No settings pane of our own: after probe the user dropped the `/roles` pane; the settings are managed in `/config`
  (and at install or with `/plugin configure`).
- Only `starter:`-prefixed `subagent_type` values are rewritten: a bare `reviewer` may be the user's own agent.
- Global env vars (`CLAUDE_CODE_SUBAGENT_MODEL` with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, `CLAUDE_CODE_EFFORT_LEVEL`)
  are documented as a fallback only: they apply to every subagent, not per role.
- /phase pane spacing: `rowGap="sm"` on the column boxes of the head block (the `head`+`main` box and `leadBlock`'s
  column), the card (body column and the rail column alike, so each `▍` stays beside its line) and the finished-phases
  list. `sm` is 0 rows in the terminal (so a narrow terminal pane gets no taller) and a small gap on desktop.
- Version 0.11.0: `plugins/starter/.claude-plugin/plugin.json` and the badge at `README.md:5`
  (`.claude-plugin/marketplace.json` has no version).
- Tests are named with a prefix per item (`settings:`, `spacing:`) so each check can find its own.
  `claude plugin test` has no filter and passes on today's tree, so a check greps for its prefix too.

## Items

- [x] 1. Add the seven `userConfig` fields above to `plugins/starter/.claude-plugin/plugin.json`, each with `type:
  "string"`, `title`, `description`, `default` and `options`; bump `version` to 0.11.0 there and in the
  `README.md:5` badge (text and URL).
  check: `claude plugin validate plugins/starter && node -e "const c=require('./plugins/starter/.claude-plugin/plugin.json');const u=c.userConfig||{};const k=Object.keys(u);if(k.length!==7||c.version!=='0.11.0'||k.some(f=>!u[f].title||!u[f].options))process.exit(1)" && grep -q "version-0.11.0" README.md`
- [x] 2. In `register.tsx`: `register` takes `(on, options)`; a `PROFILES` table and a resolver from `options` +
  role to `{ model, effort }`; the `tool.call` rewrite for `starter:*` Agent calls, before the `efforts` record.
  Tests (`settings:` prefix, using `test(name, { options }, ...)`): default options give today's values;
  `profile: light` gives haiku/low for reader; `reviewer_model: sonnet` with `profile: max` gives sonnet/medium; a
  model and effort the lead passed are replaced; a bare `reviewer` and a non-starter agent are untouched; a resolver
  failure (an options value outside the table) passes the call through unchanged; the /phase agent row shows the
  rewritten model and effort, with the spawn's model taken from the rewritten `tool.call` input (not passed by the
  test). The existing test at `register.test.tsx:603-604` (`starter:reader` with `effort: 'max'` expecting `max`) is
  rewritten for "the setting wins".
  check: `out=$(claude plugin test plugins/starter 2>&1) && [ "$(echo "$out" | grep -c '(pass) settings:')" -ge 7 ]`
- [x] 3. (Dropped after probe by the user: no `/roles` pane; `/config` manages the settings.) No `roles` command
  is registered.
  check: `! grep -q "name: 'roles'" plugins/starter/hooks/register.tsx && ! grep -q '/roles' README.md docs/DETAILS.md`
- [x] 4. /phase spacing: `rowGap="sm"` on the boxes named in the decisions; the rail column matches the body column.
  A test (`spacing:` prefix) asserts the rail and body columns carry the same `rowGap` and the rail's `▍` count still
  equals the body's line count; existing pane snapshot tests are updated, not deleted.
  check: `out=$(claude plugin test plugins/starter 2>&1) && echo "$out" | grep -q '(pass) spacing:'`
- [x] 5. Docs: README (one short section: picking a profile, `/config`), `docs/DETAILS.md` (fields,
  profile table, precedence, the env var fallback) and the plugin.json `description`. Fix the lines that say a role
  fixes its model and effort: `README.md:86`, `docs/DETAILS.md:40`, `docs/DETAILS.md:332`.
  check: `grep -q "profile" README.md && grep -q "CLAUDE_CODE_SUBAGENT_MODEL" docs/DETAILS.md && grep -qE "^\| *balanced" docs/DETAILS.md && ! grep -q "Each role fixes its model and effort" README.md docs/DETAILS.md`
- [x] 6. Script tests pass and no new type errors: `claude plugin validate` exits 0 on type errors, so count them;
  the two in `register.test.tsx` (lines ~979, ~981) are pre-existing and left alone.
  check: `node --test test/scripts.test.mjs && [ "$(claude plugin validate plugins/starter 2>&1 | grep -c 'error TS')" -le 2 ]`

## Log

- gather: profiles approved by the user; screenshot (desktop) shows the head block and card rows crowded; `$.config.set` writes a plugin's own `<plugin>.<field>` row (ConfigRow doc in the engine types)
- plan: 6 items, each with a check; profiles, fields and spacing settled in the decisions
- plan-review: 10 findings (reviewer); all settled in the plan: command renamed /roles (user), title+type fields, README badge, per-item test prefixes, docs lines, type-error count
- plan-review: approved by the user
- build: 6/6 items ticked, every check exit 0 (writer); 56 plugin tests pass, TS error count unchanged at 2
- code-review: round 1 five findings (3 fixed-needed, 2 needs-decision, both fixed); round 2 all five fixed, 0 new (reviewer, mutation-checked)
- probe: all 6 checks exit 0; plugin tests 57 pass 0 fail; script tests pass; TS errors 2 (pre-existing); try-to-break by reviewer in code-review round 1 (stored config write)
- after probe: the user dropped the `/roles` pane (managed in /config); command, pane, its tests and docs removed
