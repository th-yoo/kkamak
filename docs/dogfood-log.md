# Dogfood log

## BASELINE — sealed 2026-07-30, BEFORE any km-crank round on this repo

Frozen descriptive anchor of the pre-crank state. Everything below was
produced with NO machine-proposed mechanism change active: installed
kkamak 0.2.1 defaults, `gate.json` = `{check: "bun test", rounds: 2,
gauge: true}`, no playbook candidate, no trial live. Repo at `0a0ea5c`.

**Stream (yoo-dev, day 1, 2 sessions, 48 lines):**
- gate cycles 25 — clean 20, catch 5 (rounds-to-accept 2,2,2,2,2 — every
  block fixed first retry), exhausted 0, interrupted 0
- skippedStop 13 · gauge-only 10 · median checkMs 898ms
- reinject arms: v0 16 / v1 9 (within-cycle counts)
- committed snapshot: `evidence/kkamak-sensors/yoo-dev/` in the
  meta-harness repo

**How to use this baseline — and how NOT to:**
- USE as the descriptive "before" anchor: what the stream looked like
  with stock mechanisms, and as the sanity reference for instrument
  regressions (e.g. if skippedStop rate or checkMs shifts wildly after a
  plugin change with no workload change).
- DO NOT use as a control arm. All n are under MIN_N=20 per class (rates
  here are noise) and before/after comparison against a later window is
  exactly the workload-drift confound the §4.3 pre-registration exists to
  avoid. Any improvement/regression CLAIM about a crank-proposed change
  goes through §4.3 arms (within-workload randomized, floors, calibrated)
  — never through a delta against this block.

One dated entry per working session in this repo. Two things only:
the day's sensor numbers, and mechanism observations the sensor stream
cannot see (behavioral shifts, qualitative saves, instrument anomalies).
This file is proposer evidence — keep entries factual and dated.

## 2026-07-30 — MacBook setup review finding: sensor contract divergence (yoo-mac.local)

- No sensor numbers — MacBook stream empty at entry time (repo freshly
  cloned, 0.2.1 installed plugin verified, dogfood session opened).
- **Instrument anomaly (latent): this repo's sensor line emits `sessionId`;
  the installed kkamak's frozen `SensorLine` contract is `sessionID`**
  (meta-harness `cc-gate-plugin/src/types.ts:152`). The §4.3 trial join and
  the scorecard both key on `sessionID`, so if this repo's own stream ever
  feeds meta-harness tooling, its lines silently fail to join — same
  failure shape as an unmatched-exposure exclusion, invisible in output.
  Same-name default sensor file (`.km/gate-outcomes.ndjson`) makes
  accidental interleave of the two dialects possible if both
  implementations ever gate one repo. Fix direction: rename to `sessionID`
  (or adopt the frozen contract wholesale — `pluginVersion`/`forced` are
  also absent here) no later than the packaging/marketplace milestone,
  before any consumer exists.

## 2026-07-30 — adapters merged + round-1 aftermath (yoo-dev)

- **Harness adapters DONE, merged, pushed** (260 tests, tsc clean): CC
  adapter (block = refuse the stop) + opencode adapter (block = marked
  self-injection; wedge scenarios verified); both dogfood lessons
  (skippedStop, checkMs) implemented in the NEW kernel; import-closure
  packaging test. Final review found 3 Important (vacuous test +
  plan/code divergence, stderr noise, swallowed gate-notices) — all fixed
  pre-merge. Next milestone: packaging/marketplace.
- **Round-1 rejection reason fixed upstream** (meta-harness `19196e2` →
  `605a407`): the leak rule's all-slashes false positive
  ("filters/qualifies") amended — prose word/word passes, paths still
  caught. The fix itself went through review → re-review → ruling
  (controller's own unsubstantiated layer-2 claim caught and corrected;
  PATH_WORDS prose collisions ruled accepted fail-closed). Reviewer loop
  applied to the reviewer's keeper.

## 2026-07-30 — km-crank round 1 against this repo's evidence (yoo-dev, supervised)

First proposer-loop run ever to ingest this repo's stream (post-baseline
seal). Outcome: **review gate REJECTED the single proposed bullet — no
candidate, no trial.** The bullet ("derive the output binding
independently of the filter…") read query/projection-domain, not derived
from this repo's evidence; rejection trigger was "leak: path-like or
file-extension token" — likely a false-positive hit on the slash in
"filters/qualifies", so right outcome, questionable reason. Rejection
ledgered (proposer sees it next round). Machinery exercised end-to-end:
scan → evidence assembly (all 4 repos) → proposer → review gate → ledger.
Found: office SITREP delivery fails on missing ~/.squad/ccacp-slack.env
and marks the round "failure" after a correct decision — transport
failure should degrade to stdout, not taint the round.

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
