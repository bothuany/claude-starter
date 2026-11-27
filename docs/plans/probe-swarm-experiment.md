# Experiment: does a Haiku breaker swarm beat one try-to-break pass?

Not a cycle plan (no `cycle:` key): a measurement to run before anything changes in the plugin. The harness work
lives in `C:\development\harness-evals` (not a git repository); this file is the record.

## Why

The probe phase ends, for a high-tier change, with one `reviewer` (Opus, medium) "try to break it" pass
(`plugins/starter/skills/cycle/SKILL.md`, phase 6). DETAILS lists that pass as not measured
(`docs/DETAILS.md:332`), and the review's catch rate on seeded defects as not measured either. The idea: several
cheap Haiku agents, each attacking one surface, find more real breaks than one strong pass. The fan-out history
(`docs/DETAILS.md:14-31`) says coordination can eat the savings, so this is measured before it is built.

## Question

On the same seeded defects, which arm finds more of them with a reproducible command, at what false-positive count
and cost?

## Decisions (settled with the user in /starter:grill, 2026-11-26; do not reopen)

- **Runner:** headless `claude -p`, inside Harbor, for every entry: one environment, comparable `cost_usd`.
- **Corpus:** this repo's four defects, one clean control, and the SWE-bench Pro vuls task.
- **Sample:** k = 3 per arm per entry. When an entry's result is split (the arms differ by one run), rerun only that
  entry at k = 5.
- **Breakers are subagents** started by the lead with the Agent tool, as the plugin would ship them, so the lead's
  coordination cost is measured. Harbor once pinned every subagent to the main model (`docs/DETAILS.md:31`): every
  run's transcripts are checked, and a run whose breakers did not run on Haiku is not counted.
- **Bar for adopting B** (set before any result): B finds at least one defect A misses, in at least 2 of its 3 runs;
  at most 1 false positive per run after triage; cost at most 2× A's. Otherwise B is not adopted.
- **Defaults, not asked:** the lead runs on Opus (as a cycle's lead does), triage on Sonnet.

## Corpus

Each entry has a seeded tree the arms attack, a fix the arms never see, and the fix's tests as the ground truth.
For this repo's defects the seeded tree is the fix's parent (`<fix>^`) and the fix is the commit itself: reverting
on HEAD applies cleanly only for `a40ebcf` (`git show <c> -- <file> | git apply -R --check`).

| ID | Source | Defect seeded | Class |
|----|--------|---------------|-------|
| D1 | `6c75529` | review gate keeps the old base when a stop follows the gate with no tool call | state / sequence |
| D2 | `a40ebcf` | plan-check treats inline code as a fence; runs checks outside a repository | parsing / boundary |
| D3 | `b3b410a` | plan-check reads `user.email` and runs checks in the wrong repo when started elsewhere; indented example fences | environment / path |
| D4 | `8867605` (worktrees.mjs part only) | worktree cleanup removes a detached worktree whose commits are on no branch | data loss |
| V1 | SWE-bench Pro `instance_future-architect__vuls-0ec945d0…` | the filename-parsing edge case 8 earlier runs missed (`docs/DETAILS.md:172`) | parsing, real Go project |
| C0 | HEAD, nothing seeded | none: control for false positives | — |

D4 is the high-tier case the probe exists for; its arms see only the worktrees.mjs files and its hidden tests are the
worktree ones. If an entry's hidden test doesn't fail on its seeded tree, drop it and say so; don't hand-craft a
replacement.

## Arms

All arms get the same task instruction: the seeded tree, the files the fix touched (not the fix), the project's test
command with the hidden tests removed, and "write each finding to `/app/findings.json` as `{claim, repro}`".

- **A, today's pass.** One `starter:reviewer` with the "try to break it" instruction from `agents/reviewer.md`.
  Plugin at `bb7f221`, profile `max`.
- **B, swarm.** The lead starts four Haiku breakers in parallel, one surface each, then one Sonnet triage agent:
  1. inputs and boundaries (empty, huge, CRLF/BOM, unicode, malformed)
  2. sequence and state (repeat, reorder, interrupt, rerun after partial failure)
  3. environment and paths (other cwd, spaces and Turkish characters in paths, Windows separators, missing git)
  4. destructive outcomes (what could this delete, overwrite or leave half-done)
  Triage runs every repro, keeps what it can reproduce, deduplicates, and writes `findings.json`.
- **C, one Sonnet breaker with all four surfaces in one prompt.** Separates "more agents" from "a better brief".

## Scoring (in the task's verifier, no model judges)

Harbor copies `tests/` in only at verification, so the fix stays out of the agents' reach. The verifier runs each
repro from `findings.json` on the seeded tree, applies the fix patch from `tests/`, and runs it again.

- **Hit:** the repro fails on the seeded tree and passes on the fixed tree.
- **False positive:** a repro that behaves the same on both trees or doesn't run. On C0 every finding is one; one
  that looks like a real pre-existing bug is reported apart, not counted as a hit.
- Per run: hit (yes/no), false positives, `cost_usd`, wall time, and each agent's model from its transcript.
- The verifier also records whether the hidden tests pass on the tree as the agent left it; item 3 uses that.

## Safety

Harbor runs every trial in its own container, so breakers can't reach this checkout, its junctions or the real
`~/.claude`. Nothing is pushed. Docker Desktop must be running; it was off on 2026-11-26.

## Run size (ask before running)

6 entries × k = 3: A 18 agent runs, B 90, C 18. Agent startup was about 70k tokens of context in the 0.6–0.7
measurements; that number is old and is re-measured in the pilot. On the subscription, the runs go in queues as
before (`run_queue.sh`), split around the usage limit.

## Items

- [x] 1. Five Harbor tasks for D1–D4 and C0 under `harness-evals/tasks/swarm-*`, laid out like
  `tasks/starter-pilot-fix-parser` (environment, instruction, solution, task.toml, tests). `tests/` holds the fix
  patch, the hidden tests and the verifier.
  check: `for t in d1 d2 d3 d4 c0; do test -f /c/development/harness-evals/tasks/swarm-$t/task.toml || exit 1; done`
- [x] 2. `tasks/swarm-v1` from the vuls SWE-bench Pro task: its environment, the arms' instruction, its gold patch
  and tests moved into the verifier.
  check: `test -f /c/development/harness-evals/tasks/swarm-v1/task.toml`
- [x] 3. Seed check, the way `harness-evals/prove_starter.sh` proves its tasks: the `oracle` agent (fix applied)
  passes the hidden tests, the `nop` agent (seeded tree untouched) fails them; C0 passes under both.
  check: `cd /c/development/harness-evals && bash prove_swarm.sh` (exits 0 only when every task behaves so)
- [x] 4. `harness-evals/arms/swarm_arms.py`: `SwarmA`, `SwarmB`, `SwarmC`, built on `ToolArm` the way
  `arms/starter_arms.py` is, with the arm prompts as files under `arms/swarm/`.
  check: `cd /c/development/harness-evals && PYTHONPATH=. ~/AppData/Roaming/uv/tools/harbor/Scripts/python.exe -c "import arms.swarm_arms as m; m.SwarmA, m.SwarmB, m.SwarmC"`
- [x] 5. Model check: a script that reads a trial's transcripts and fails when a B breaker did not run on Haiku.
  check: `cd /c/development/harness-evals && python swarm_models.py --self-test`
- [x] 6. Pilot: D1 through A, B and C, one trial each. Report real cost, time and the model check; stop and ask.
- [x] 7. Full run, k = 3 on all six entries, only after the user approves the pilot's cost; k = 5 reruns for split
  entries.
- [x] 8. Results against the bar above into `docs/DETAILS.md` under "The evidence", replacing the "try-to-break probe"
  line in "Not measured in 0.10". Small sample, said plainly.

## What would change the plugin

- B clears the bar: breakers go into the probe phase for the highest tier only.
- C ties B: the four-surface brief goes into `agents/reviewer.md`, no swarm.
- Neither beats A: leave it, and record the measurement.

## Open risks

- Harbor's model pinning may still override `model: haiku`; the pilot's model check decides before the full run.
- Packaging four Harbor tasks from this repo's history is guessed at about a day of work; not measured.
- k = 3 can be won by one lucky run; the bar asks for 2 of 3 and the k = 5 rerun covers split entries.

## Not in scope

- A review swarm (code-review with many Haikus): single runs already found the plan conflict 3/3; not tested here.
- Changing any agent, skill or hook before the results.

## Log

- grill (2026-11-26): runner, corpus, sample, spawn and bar decided; see Decisions.
- build (2026-11-26): tasks swarm-d1..d4, c0, v1 built; prove_swarm.sh 12/12 PASS (oracle: hits=1 fp=0, control fp=1; nop: hits=0); swarm_models.py self-test passed. Pilot not run.
- pilot B/d1 (2026-11-26): first run invalid (all agents on Opus: Harbor pins aliases unless ANTHROPIC_DEFAULT_*_MODEL are set; run_swarm.sh now sets them). Rerun: models ok, $0.86, 5 min, hits 0, 4 findings failing on both trees. Of the 10 such findings from both runs, 4 pass on HEAD (bugs fixed later) and 6 still fail on HEAD (harness-evals/swarm/pilot-b-d1-candidates.json): the fp metric counts real other bugs as false positives.
- pilot A/B/C on d1 (2026-11-27): scorer split fp into fp / later_fixed / open (HEAD as third tree; re-proved 12/12). A: hit, later_fixed 2, $0.52. B (rescored): no hit, later_fixed 1, open 3, $0.86. C: no hit, later_fixed 1, $0.16. Models checked OK for all three. Full run started: run_swarm_queue.sh, k=3, about $25-40 API-equivalent estimated.
- full run (2026-11-27): k=3 on all six entries, then +2 per arm on the split entries d1, d3, v1 (k=5); 126 trials, about $25 API-equivalent (A $11.2, B $10.5, C $2.9); models OK in every counted trial. One power loss at 03:07 cut a B/v1 job; set aside as jobs/aborted-*, rerun. Seeded defect: A 18/21, B 10/21, C 4/21; fp at most 0.2 per run in every arm; cost per trial A $0.31-0.42 (c0 $1.02), B $0.33-0.59, C $0.10-0.16. Overlap (swarm/claims.md, clustered by a Sonnet reader): B has B-only clusters in 2+ runs on c0, d1, d2, d3, all in the open bucket; the largest (edits after a review call in the same window are not gated, 7 B trials) does not reproduce: the gate stays silent in that repro with no review call at all, on Windows and in node:22 Linux. The others are a script run through a symlink or a renamed copy (main() guard), core.logAllRefUpdates=false and a resumed transcript; unverified. Bar: fp and cost pass; "a defect A misses" not shown. Outcome: neither beats A; the plugin stays as it is. The open bucket counts broken repros as defects: a repro that fails on all three trees proves nothing without a control.
