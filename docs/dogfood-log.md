# Dogfood log

One dated entry per working session in this repo. Two things only:
the day's sensor numbers, and mechanism observations the sensor stream
cannot see (behavioral shifts, qualitative saves, instrument anomalies).
This file is proposer evidence — keep entries factual and dated.

## 2026-07-30 — session 1 (yoo-dev, Opus 5 → Sonnet 5)

**Numbers (installed kkamak 0.2.0 → 0.2.1 mid-day):** ~15 gate cycles,
6 blocks — every one fixed in round 1, 0 exhausted, 0 interrupted;
7+ skippedStop boundary markers; gauge shadow: A1/A2/B/D classes, 0 refusals.
Check cost steady ~880ms (checkMs live from 0.2.1 on; divergence proof:
[884, 882] inside a 34,877ms blocked cycle — rest was agent fix time).

**Work gated:** repo bootstrap → kernel (165 tests, merged) → harness
adapters for Claude Code + opencode (260 tests, merged, pushed).

**Mechanism observations:**
- Turn 1, empty repo: gate blocked on unsatisfiable `bun test` and the
  block evidence drove the agent to create the scaffold — the gate forced
  the project into existence.
- Block evidence sufficiency: 6/6 blocks fixed on the first retry; the
  check output alone carried enough signal every time.
- Anticipatory shaping: the agent repeatedly HELD ITS TURN OPEN on a red
  tree (blocking on a wait-task) to avoid ending mid-TDD — verification
  discipline moved ahead of the gate. Invisible to M-catch; recorded here
  because the stream cannot see it.
- Queued prompts eat Stop boundaries: an 8-commit build produced zero
  cycles under 0.2.0. Found here, fixed same day (skippedStop class in
  0.2.1), and the fixed instrument captured 7 live specimens in this same
  session by evening.
- Instrument survived its own cache refresh mid-day (hooks re-exec per
  call); fail-open never trapped a turn.
