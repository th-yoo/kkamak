# Handoff: build A1 — cycle tagging (`implOnly` / `sameTurnCoEdit`)

Temporary file. Delete it in the commit that finishes this work — it must not survive to `main`.

Branch: `feat/cycle-tagging`, cut from `main` at the 0.5.0 release (`1cdaebf`, tagged `v0.5.0`).
Baseline to re-verify yourself before asserting any delta: `bun test` = 351 pass / 0 fail,
`bun run typecheck` clean. Do not trust those numbers because they are written here.

## Why this feature exists

Across 13 measured gate cycles on this repo (`docs/dogfood-log.md`), the gate caught **zero real
defects and one false positive**, while independent architect reviews of the same code found **two
genuine defects** — both in code the gate had already accepted with a fully green suite. The
diagnosis on record: for both, the implementation and its tests were authored in the same turn, and
a test written to match an implementation passes by construction. A green check proves "nothing
already pinned broke"; it cannot prove "the new code is right", and it cannot pin what nobody
considered.

A1 does **not** try to catch those defects. It makes the mechanism that *did* catch them —
independent review — cheaper to aim, by recording which cycles have the risky shape. Review
attention is finite and currently unguided.

## What to build

Two additive sensor fields, derived from the paths a cycle touched:

- `implOnly` — the cycle touched source files and no test files.
- `sameTurnCoEdit` — the cycle touched both, i.e. implementation and its tests in one turn: the
  exact shape behind both real defects.

### Path plumbing

`GateEvent`'s `file-edited` variant currently carries only `sessionID` (`src/kernel/ports.ts`).
Add an **optional** `path`.

- **Claude Code supplies it.** `hooks/hooks.json` already registers PostToolUse with matcher
  `Edit|MultiEdit|Write|NotebookEdit`, and `src/adapters/claude-code/hook-input.ts` already reads
  `tool_name` from the payload — it just discards the rest. The edited path is at
  `tool_input.file_path`; this was confirmed against a real captured payload, alongside
  `tool_name`, `session_id` and `cwd`.
- **Opencode does not, and that is fine.** Its `tool.execute.after` hook types its arguments as
  `args: unknown` (`src/adapters/opencode/opencode-types.ts`), so the path is presumably in there
  but its shape is unpinned and unverified. Leave the opencode adapter passing no path. Both new
  fields then stay absent on opencode lines — correct additive behaviour, not a bug. Do not guess
  at opencode's arg shape.

### State

`GateState` (`src/kernel/state.ts`) gains a bounded collection of the cycle's touched paths.

- **Bound it.** A cap (~200) with a truncation flag, so a large refactor cannot grow the state
  record without limit. Decide whether the truncation flag needs to reach the sensor line — if the
  cap was hit, `implOnly`/`sameTurnCoEdit` may be computed from a partial set, and a field that can
  be silently wrong is worse than one that is absent. Your call, but state your reasoning.
- Thread it through `isGateState` / `normalizeGateState` / `isInitialState`, the same mechanical
  shape as the existing `checkMs` field. A record written before this field existed must still
  load — see the optional-chaining comment already in `isInitialState`.
- Clear it on every `INITIAL_STATE` reset, like the rest of the per-cycle accumulators.

### Classification

A path counts as a test path by **heuristic** — a pattern over the path string. Default should
match the common conventions (`test`, `spec`, `__tests__`); make it configurable via an optional
`GateConfig` field, parsed in `src/kernel/config.ts` with the same never-throw discipline as every
other field there (a malformed value falls back to the default, it does not disable the gate).

**Name and document it as a heuristic.** This is a text pattern standing in for real analysis —
structurally the same shape as the `test/imports.test.ts` false positive already filed as
`docs/known-issues.md` #9. The decisive difference is that this one **never blocks**: a mislabel
costs a wrong telemetry field, not a wrongly-blocked turn. Say so in the doc comment, and do not
let this classification influence any gate decision, ever.

### Emission

Stamp both fields wherever a cycle is recorded and paths are known. `record()` has four call sites
in `src/kernel/gate.ts`. Consider what these fields mean on a `skippedStop` diagnostic line (no
check ran) and on an interrupted line — absent may be more honest than `false` for some of them.

**Never put a path on the sensor line.** Only the derived booleans are emitted. Paths stay in
`.km/` state, which is gitignored and local. This is a hard privacy line: the sensor file is a
durable artifact, file paths are user data.

## HARD CONSTRAINTS

- **Never edit `test/fixtures/sensor-contract.ndjson`.** It is byte-parity compared against
  `VECTOR_LINES` in a separate private repo, a raw string compare with no comment-stripping.
  Both fields land as always-stamped-but-contract-tolerated-absent, the `pluginVersion` precedent
  (see `test/sensor-contract.test.ts`'s header). Confirm by reading that test's body that it does
  not ban unknown fields — it did not as of 0.5.0, but re-confirm rather than trusting this line.
- **Fail-open is absolute.** No path introduced here may throw upward or wedge a turn.
- **Kernel purity.** `src/kernel/` imports no fs, child_process or os.
- **TDD.** Failing test first, watched failing for the right reason, then implement.
- **Do not weaken, skip or delete a test to make something pass.** If a test blocks you and you
  believe the test is wrong, stop and report it. Editing around a failing check is the exact
  gate-avoidance shape this repo has already recorded once (`docs/known-issues.md` #9, "resolved"
  by rewording a comment rather than fixing the scanner).
- **No merge, no version bump, no push.** Stop with the branch green and hand back. The version
  bump rides the merge commit when that go is given, never a follow-up.

## Known limitation to state plainly in your report

**These fields have no reader.** kkamak ships no aggregation tool, so the tags sit in NDJSON until
someone greps them by hand. The data must exist before anything can consume it, which is why this
is built first — but do not describe A1 as delivering value on its own. It delivers a signal.

## Done means

`bun test` and `bun run typecheck` both green with their real output reported, the frozen fixture
untouched, `HANDOFF-A1.md` deleted, and a report covering: what you built, how you classified test
paths and why, what you decided about truncation and about absent-vs-false on non-check lines, and
anything you could not do.
