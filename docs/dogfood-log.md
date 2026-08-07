# Dogfood log

**Who this is for.** This is the maintainer's working log of running kkamak
on kkamak: one dated entry per session, carrying that session's sensor
numbers and the mechanism observations the sensor stream cannot see. It is
proposer evidence for a measurement process, not documentation of the
plugin — nothing here is needed to install or use kkamak, and nothing here
is a promise about how kkamak behaves.

**It references a private repo.** Entries below cite `meta-harness` — a
separate, unpublished repository holding the measurement harness, its
pre-registration (§4.3), its round ledgers, and the committed sensor
evidence snapshots. Round numbers, section references, and the
`evidence/…` path resolve only there. If you are reading this without access to that repo,
those citations are dead ends by design: they are recorded so the
maintainer's own claims stay auditable, not to send you anywhere. The
factual content of each entry — what changed, what the numbers were, what
was observed — stands on its own without them.

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

## 2026-08-07 — FIRST NON-kkamak SUBJECT REPO: gate armed on `cc-api-daemon` (yoo-dev)

**Read the scope line first.** Every other entry in this file is kkamak
running on kkamak. This one is not: the subject is `cc-api-daemon`, a
separate repo (an ACP daemon being rebuilt on the Anthropic API SDK), which
had the kkamak plugin's hooks firing but no `gate.json` — armed
(`edited:true`) with no configured check, so nothing enforced. A `gate.json`
was added this session and the gate began running there.

**Do NOT pool this stream with the kkamak-on-kkamak stream.** Different
repo, different workload, different test suite, and `gauge` disabled here
vs enabled there. It is a separate stream that happens to share a host and
a plugin version. Same rule as the BASELINE block above: descriptive record
only, not a control arm, and no before/after claim rides on it.

- **Configuration:** `gate.json` = `{check: "bun test", rounds: 2, gauge:
  false}`. `gauge` is off deliberately — a review-sensor checkpoint is open
  on this host through 2026-08-13 and a new gauge emitter would perturb the
  emission rate being measured. Confirmed off in the stream: every cycle
  line carries `gauge {"present": false, "offReason": "disabled"}`.
- **Sensor numbers, measured** — `~/z2/cc-api-daemon/.km/gate-outcomes.ndjson`,
  read directly, whole file (the stream begins this session):
  `totalLines 4, gateCycles 2, clean 2, catch 0, exhausted 0, interrupted 0,
  skippedStop 1, nonCycleLines 1 (promptCheck, spawnTs 1786065473715),
  checkMs [6256, 11753], reinject v0 ×2, pluginVersion ["0.4.0"],
  sessions 1 (ea0cfa23), host yoo-dev, app claude-code`.
  `gateCycles + skippedStop + nonCycleLines` = `2 + 1 + 1` = `4` =
  `totalLines`, checked.
- **`checkMs` nearly doubled within the session — workload, not instrument.**
  6256 ms → 11753 ms across two cycles. Cause is known and mechanical: the
  session ported 1878 lines of source plus their test files into the repo
  between the two cycles, taking the suite from 54 to 177 tests. Recorded
  explicitly so a later reader does not mistake it for the instrument
  regression the BASELINE block warns about — nothing about the plugin
  changed, the thing being checked got bigger.

**Mechanism observations the stream cannot see:**

- **The gate changed the plan, before it ever blocked anything.** The
  implementation plan being executed had Task 1 create a file that Task 2
  imported, so Task 1 would have ended on a broken import and a red suite.
  Ungated that is a wobble; under a gate it is a task that cannot commit its
  own work. The task boundary was redrawn (contract file pulled forward into
  Task 1) *because* the gate existed. The defect was invisible while the repo
  was ungated and surfaced within minutes of arming.
- **Gate-avoidance pressure, observed live.** The first gated commit landed
  green partly by skipping 10 tests across 3 sites. Two were legitimately
  blocked on code that did not exist yet; the third was a wire-level
  cancel-race test skipped on backend-semantics grounds. Every site carried
  an inline re-enable note — good discipline — but nothing enforced the
  re-enablement, so a later plan step now requires all skips removed and
  `grep -rn "\.skip\|skipIf" test/` to return nothing. Worth naming plainly:
  a green gate makes skipping the cheapest path, and a skipped test under a
  green gate is indistinguishable from a passing one.
- **Second instance of the same pressure: deletion deferred, duplication
  shipped.** A later task was supposed to delete three functions
  (`daemonCall`/`ensureDaemon`/`closeSession`) from the old single-process
  implementation, now superseded by a ported client that exports the same
  three names. It did not happen: the package's `index.ts` still exported
  them, so deleting turned the commit red, while leaving them cost nothing.
  The repo therefore carried two complete implementations of the same three
  names, with the public surface still pointing at the superseded one and
  the real client unreachable behind it — through four consecutive green
  commits. Caught by reading the export list, not by any check.
- **The shape both instances share.** A gate answers "is it broken"
  precisely and says nothing about "is it finished". Skipping a test and
  keeping a superseded function are both *green* moves, and both defer work
  in the direction the gate does not look. Neither is a defect in the gate —
  it is doing exactly what it claims — but it is worth stating that a green
  streak under a check-command gate is evidence about breakage only, and
  that the two cheapest ways to stay green are both forms of deferral.
- **Instrument observability finding (maintainer-facing).** The per-session
  cycle record `.km/cc-gate/<sessionID>.json` sat at
  `{edited:true, gating:false, round:0, outcomes:[]}` across the whole
  session, and that was misread here as "the gate has never run a round."
  It is in fact the healthy steady state: an accepted round resets to
  `INITIAL_STATE` and the session's next edit re-sets `edited`. A gate that
  is passing every cycle and a gate that is never firing therefore present
  an identical cycle record, and the only way to tell them apart is to read
  `gate-outcomes.ndjson`. Not a bug — the record is cycle state, not
  history — but the failure mode is easy to hit and cost a wrong conclusion
  before the sensor file settled it.

  **CORRECTION, same day, later.** The last sentence of that bullet is
  **wrong**, and it is left standing above rather than edited away because
  the error is the finding. `gate-outcomes.ndjson` does **not** distinguish
  them: it appends only when a cycle **COMPLETES**, so an open cycle writes
  nothing and a *failing* cycle writes nothing. A frozen stream is therefore
  consistent with idle, blocking, **and** dead.

  Measured directly, hours later on the same subject repo. The stream sat
  unchanged for 105 minutes (11 lines, mtime 12:49:01) while the session
  committed normally, which was read here as "the gate stopped enforcing" —
  and that call was published in this log's earlier draft before it was
  checked. Forcing a Stop (one trivial edit, end the turn immediately)
  produced, within seconds: `{gating: true, round: 2, outcomes:
  ["verify-failed","verify-failed"], checkMs: [10678, 10515]}`. The gate had
  been working the whole time; the silence was that Stop fires only at turn
  end and the session had been running 18-minute turns.

  So the same missing distinction produced **two opposite wrong calls in one
  session** — a dead gate read as healthy, then a healthy gate read as dead.
  That symmetry is the durable lesson, not either individual error.

  **The instrument is not defective and needs no change.** The cycle record
  *does* separate all three states — but only while a cycle is open, which
  is ~10 s and only at turn end, so any sampled read lands on the idle shape
  with near-certainty. The stream shows only completions. Neither surface
  can be *sampled*; they go quiet together, and their agreement looks like
  confirmation while being two instruments blind in the same window. The
  correct method is to force a transition, not to poll. Recorded as an
  operator rule rather than a defect — an instrument edit motivated by an
  observer error would have been the worse outcome.

  One consequence worth stating separately: forcing a Stop mid-refactor
  gates a tree that was never meant to be gated. The `verify-failed` rounds
  above were a half-migrated tree (`socketPath` deleted, its importers not
  yet re-pointed) caught by a Stop the diagnostic itself created. That
  failure was the observer's artifact, not the subject's regression.

**Not committed anywhere durable.** `.km/` is gitignored, so this stream is
host-local to yoo-dev and does not travel. The numbers above are the record.

### Update, same day — full-run close, and the finding that matters

The subject repo went on to complete an 8-task rebuild (10 commits) with the
gate armed throughout. Final stream: `totalLines 11, gateCycles 9, accepted 9,
blocked 0, exhausted 0, checkMs 6256 → ~14000`.

**The gate accepted 9 of 9 cycles. GitHub Actions CI was failing on three of
the commits it accepted.**

Those two sentences are the entry. Root cause of the CI failures: two
re-enabled test blocks redirected `ANTHROPIC_BASE_URL` to a local stub but
never overrode the *credential*, so `resolveAuth` fell through to the dev
host's real `~/.claude/.credentials.json`. The tests passed locally because
the host had credentials, and failed on the first credential-less runner.
Nothing leaked — the base URL was redirected throughout, so no real token
ever left the machine and no request reached the real API — but the tests
were green for a reason unrelated to what they assert.

**Why the gate could not have caught it, structurally.** The gate runs
`bun test` on the host being worked on. That host has credentials. A check
command cannot observe a dependence on its own environment; it *is* the
environment. This is not a defect to fix in the gate — it is a limit on what
a green gate is evidence *of*. Recorded as such.

The repo's fix generalizes and is worth stealing: an explicit
`env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN HOME=/tmp/no-creds bun test`
step, run as its own CI step rather than folded into the normal one — because
the normal step being credential-less today is *incidental*, and would stop
being true the day a key is wired in for something unrelated.

**A fourth instance, in the supervising session rather than the subject.**
This session verified each task independently — commits, diffs, test counts,
budget arithmetic, doc staleness — and reported three consecutive tasks as
"verified" while CI was red on all three. The verification was real but ran
entirely on the same host as the gate, so it shared the gate's blind spot
exactly. Adding more checks that share an environment adds no coverage. The
maintainer had to report the CI failure; no instrument here surfaced it.

**Standing lesson for reading this log:** a green streak is evidence about
breakage *in the environment the check ran in*. Four findings this session —
skipped tests, a shipped duplicate implementation, host-credential
dependence, and unwatched CI — are all the same shape, and none of them are
visible in the sensor numbers above.

## 2026-08-05 — 0.4.1 review-debt paydown (yoo-dev)

Executed the `docs/superpowers/plans/2026-08-05-kkamak-0.4.1-review-debt.md`
plan: paid down the five open `docs/known-issues.md` entries (#2, #4, #5,
#6, #7) the 0.4.0 pre-release review recorded as Minor and left unfixed,
and cut the 0.4.1 release. No behavior changes — docs, tests, comments,
and version strings only.

- **Sensor numbers, measured** — window `2026-08-05T00:00:00` local to now,
  from `.km/gate-outcomes.ndjson`, this session's own extractor script:
  `totalLines 7, gateCycles 6, clean 6, catch 0, exhausted 0, preempted 0,
  unclassified 0, skippedStop 0, nonCycleLines 1, medianCheckMs 2428,
  pluginVersions ["0.2.1"], sessions 1`. `gateCycles + skippedStop +
  nonCycleLines` = `6 + 0 + 1` = `7` = `totalLines`, checked. Every cycle
  this session accepted on the first round; nothing blocked, nothing
  exhausted.
- **`pluginVersion` observation — corrected.** Within the window measured
  above, the stream stamped `"0.2.1"` — the installed private
  `cc-gate-plugin` research build driving this repo's own gate, not this
  checkout at 0.4.1. That was true of the window, not a standing fact: a
  later line in the same file stamps `"0.3.0"`, first at `ts 1785930930213`
  (2026-08-05 20:55:30 local, `rounds ["accepted"]`, `checkMs 2538`) — this
  repo stream's regime boundary; never pool across it. Re-counted directly
  against `.km/gate-outcomes.ndjson` as of this correction: `0.2.0` × 10,
  `0.2.1` × 58, `0.3.0` × 2 (70 lines total). The cause was **not** a stale
  install: `installed_plugins.json` had shown `kkamak@kkamak-local` at
  `0.3.0` since `2026-08-05T03:10:11Z`, cached `gitCommitSha ffb8d00`, zero
  `cc-gate-plugin` commits after it — the install was current the whole
  time this entry's window was measured. `readPluginVersion()`
  (`cc-gate-plugin/src/sensor-append.ts`, module-relative via
  `import.meta.dir`) caches once per process, so a session started before
  the install kept stamping `0.2.1` until it exited; the lines were
  correct about which build produced them, the stale thing was the
  process, not the cache. Worth recording as a trap, not just a doc fix:
  `sessionID 79967164-a751-4daa-a3c4-6bfffb594bd7` appears on **both**
  sides of the boundary, stamping `0.2.1` and `0.3.0` — confirmed by
  direct query against the file. `/exit` plus resume preserves the session
  id while starting a new process with a newly-read version, so
  `sessionID` is not a valid key for partitioning build regimes; only the
  `pluginVersion` stamp and its `ts` boundary are. Lines in this repo's own
  sensor stream still do not report the version of the code in this repo's
  working tree either way; reading them as evidence about 0.4.1's behavior
  would be wrong regardless of which regime produced them.
- **Suite:** 315 at `c5f8600` → 319 after Task 1 (one new `FileConfigSource`
  test pinning that `gate.json` is read from the launch cwd and never
  resolved upward, plus a three-case `test.each` over `HOOK_EVENTS` pinning
  the same claim on the adapter side) → 319 unchanged through Tasks 2-6
  (Task 2 replaced one test with one test; Tasks 3-6 are docs/version only).
  `bunx tsc --noEmit` clean at every task boundary.
- **Mechanism observation: known issue #4 was invisible to the instrument,
  by construction.** It was a documentation claim (`README.md` said `gate.json`
  lives at the repo root) that the code contradicted (it's read from the
  launch cwd) — found by review, not by any gate cycle. The gate behaved
  correctly the entire time the wrong sentence sat in the README, so no
  sensor line, however read, could ever have surfaced it. A limit of the
  instrument: it measures whether the gate did its job, not whether the
  docs describe the gate correctly.
- **The review loop that produced this release's plan, as measured `n=1`
  evidence.** Descriptive only — not a control arm, not a §4.3 claim, and
  nothing about `ralph-loop` is adoptable from this one run. The plan was
  produced by a `ralph-loop` run of 3 iterations (its cap), dispatching 4
  independent `code-architect` passes, folding roughly 25 findings back in.
  Per the plan's own Review record, at least 9 of those 25 were iatrogenic
  rather than discovered — repairs of defects a previous round's own
  folding had introduced (5 found in round 2, 4 in round 3). After the loop
  hit its cap, an external lab pass found 4 more (two wrong counts, one
  execution-seam ambiguity, one block-versus-prose disagreement).
  Per-pass yield ran 6, 5, 4, 4. The mechanism observation that matters:
  zero of those findings came from a sensor line — the gate ran green
  through the entire arc, because nothing was ever broken, so known issue
  4 (a documentation claim the code contradicted) was invisible to the
  instrument by construction, same as the bullet above. Confound worth
  recording for anyone reading this window later: the session model
  switched Opus 5 → Sonnet 5 partway through this release, between the plan
  being reviewed/committed and Tasks 3-7 being executed.
- **Runbook status:** Task 6 Step 6 (7a) re-pointed `docs/install-verification.md`
  at 0.4.1 and committed that on its own, before the release commit. Step 8
  (7b) — a human executing the runbook on a real machine — has **not**
  happened as of this entry. Installability is unproven; a green suite is
  not evidence of it.

## 2026-07-31 — CHANGELOG.md added (yoo-dev)

`CHANGELOG.md` now exists at the repo root, keep-a-changelog format, one
`[Unreleased] - 2026-07-31` section grouped Added/Fixed, summarizing
today's five commits (`ead09d5`, `ad63d3b`, `65c9546`, `8e23103`,
`9d2f6f6`) — one line each, linking to this file's matching entry rather
than restating detail. Precursor to the packaging milestone this repo has
been tracking toward since D1 (`docs/dogfood-log.md`'s own D1 entries) —
a real release needs a changelog before it needs a version bump.

## 2026-07-31 — opencode adapter wired to deliver the hygiene marker (yoo-dev)

Closes the opencode gap the CC-adapter entry below left open: both
adapters now deliver `GateDecision.marker`.

- **opencode — wired**, symmetric with the CC delivery split (steered
  explicitly: marker and notice stay on separate channels, never
  merged). `plugin.ts`'s `session.idle` handler now injects a continuation
  prompt (`INJECTED_MARKER`-prefixed, same mechanism a block uses — opencode
  has no hook-return channel like Claude Code's `hookSpecificOutput`, so
  continuing the session is the only way to feed the model's context) when
  `decision.marker` is set. `decision.notice` still only ever logs, as
  before; the two `if`s are independent, so neither branch can leak into
  the other's channel.
- Never fires on exhaustion under opencode either — proven with
  `marker:true, rounds:0` driven to a real exhaustion, not assumed from
  the kernel-level test already covering this.
- The injected marker prompt lands after the accept branch has already
  reset session state to `INITIAL_STATE`, so replaying it back through
  `chat.message` is inert (no `skippedStop` line, no new gate line) —
  pinned down by a test rather than left as an unverified consequence of
  the reset-before-injecting order.
- Suite: 287 → 291 (4 new: prompt delivery + text, off-by-default,
  exhaustion override, self-injected-replay inertness). `bunx tsc --noEmit`
  clean. Golden fixture untouched — same as the CC-adapter entry, this
  never touches sensor-line shape.
- README: both adapters' delivery channels for `marker` now documented in
  one place (the sensor-file section) instead of the CC-only note the
  prior entry left.

## 2026-07-31 — CC adapter wired to deliver the hygiene marker (yoo-dev)

Follow-on to the `marker` milestone below: that commit (`65c9546`) left
`GateDecision.marker` kernel-complete but undelivered — README flagged
neither adapter injected it into the conversation yet.

- **Claude Code — wired.** `src/adapters/claude-code/emit.ts`'s
  `planEmit` now emits `hookSpecificOutput: { hookEventName: "Stop",
  additionalContext: decision.marker }` on an allow decision carrying
  `marker` — the same delivery channel the reference implementation uses
  for its own `allow-with-marker` (meta-harness cc-gate-plugin
  `src/output.ts`), and deliberately distinct from `systemMessage` (which
  `notice` already used): `additionalContext` feeds the model's own
  context, `systemMessage` only surfaces as a status line. `notice` and
  `marker` deliver independently, so a future decision carrying both
  would not silently drop one, though gate.ts never produces that
  combination today.
- **Which adapter events can ever carry it:** only `Stop` — `gate.ts`
  only ever sets `GateDecision.marker` from `onStopRequested`'s accepted
  branch. `PostToolUse` (file-edited) and `UserPromptSubmit`
  (new-user-prompt) always resolve through `onFileEdited`/
  `onNewUserPrompt`, which never return it, so those two hook events have
  nothing to deliver regardless of adapter wiring.
- **opencode — still not wired**, unchanged this milestone and noted in
  README: `plugin.ts`'s `session.idle` handler logs `decision.notice`
  when present but never reads `decision.marker`, so a clean accept with
  `marker: true` silently drops the notice under opencode today. Same
  event-scope rule applies there too (only the `session.idle` → stop path
  could ever carry it).
- Suite: 283 → 287 (4 new: `hookSpecificOutput.additionalContext`
  delivery, marker never on `systemMessage`, notice+marker both deliver,
  JSON round-trip). `bunx tsc --noEmit` clean. Golden fixture
  (`test/fixtures/sensor-contract.ndjson`) untouched — this change never
  touches sensor-line shape, only decision delivery.

## 2026-07-31 — real `marker` mechanism implemented, correcting an earlier misreading (yoo-dev)

Next milestone after D1: implement the `marker` mechanism this kernel had
stamped `false` on every line. The task's initial framing (and this
repo's own prior `SensorLine.marker` doc comment, written before this
session) described it as a "session-carryover" flag — persisted state
that follows a session across process restarts so a downstream consumer
could join interrupted work across session boundaries.

**That description is wrong.** Read directly against the frozen contract's
source before implementing anything (meta-harness `cc-gate-plugin/src/
core/stop.ts`, `src/config.ts`, `vendor/session2.ts`, and its own
README), not against this repo's prior comments:
- `GateConfig.marker` is a static config toggle, default `false`. README:
  "If true, successful runs inject a hygiene marker into Claude's
  context."
- The marker text (`HYGIENE_MARKER`) is a same-session countermand
  injected at accept time for a bench mode that chains two different
  tasks into one session (`run.ts --then --marker`) — never written to
  disk, never read back by a later process.
- `SensorLine.marker` just records whether that injection fired *this
  cycle*: true only when `cfg.marker` is on and the round cleanly
  accepted. `stop.ts` explicitly forces it `false` on exhaustion —
  "Marker must NOT fire on exhaustion even with cfg.marker true."

There is no cross-session persistence anywhere in the reference. Flagged
this to the operator mid-task rather than building the described (but
nonexistent) feature; confirmed direction: port the actual semantics and
correct the wrong wording everywhere it appeared.

**Implemented (kernel-side only):**
- `GateConfig.marker: boolean` (default `false`, `config.ts`) — same
  coercion as upstream (`j.marker === true`, so only the JSON literal
  `true` turns it on).
- `GateDecision`'s `allow` variant gains `marker?: string` — a hygiene
  notice (kkamak's own wording, not copied from `HYGIENE_MARKER`),
  returned only on a clean accept with the config on. Never set alongside
  exhaustion, a block, or an interrupted/skipped line, even with the
  config on.
- `SensorLine.marker` / `SensorArgs.marker` — now a caller-threaded
  required field (`gate.ts` sets it explicitly at all four `record()`
  call sites) instead of a hardcoded `false`.
- Corrected the "session-carryover" wording in `ports.ts`'s
  `SensorLine.marker` doc comment and in README's sensor-field docs.
- Not done this milestone: neither harness adapter (Claude Code, opencode)
  reads `GateDecision.marker` yet, so turning the config on has no visible
  in-conversation effect today — only the sensor line and the kernel-level
  decision field. Noted in README. Matches this repo's established
  pattern of landing a kernel milestone before its adapter wiring (see the
  D1 entry below, and the original harness-adapters entry further down).
- Suite: 272 → 283 (11 new: config coercion tests, sensor threading tests,
  6 gate-level hygiene-marker behavior tests, 2 contract-conformance
  tests). `bunx tsc --noEmit` clean. Golden fixture
  (`test/fixtures/sensor-contract.ndjson`) untouched — byte-shared with
  meta-harness km-crank, and this change never required touching it.

## 2026-07-31 — D1 closure: pluginVersion/forced adopted (yoo-dev)

Closes the D1 deferral recorded below (packaging milestone, ahead of
schedule — landed before the marketplace milestone it was originally
pinned to), per the frozen `SensorLine` contract
(meta-harness `cc-gate-plugin/src/types.ts`).

- **`pluginVersion?: string` adopted, always stamped.** New `KERNEL_VERSION`
  constant in `src/kernel/sensor.ts` ("0.3.0"), stamped on every line by
  `buildSensorLine` — this kernel always knows its own version, unlike the
  frozen contract's general "producer may not know" case that makes the
  field optional there. Kept as a literal rather than a `package.json`
  read to keep the kernel I/O-free; a new `test/packaging.test.ts` case
  guards it against drifting from `package.json`'s `version`.
- **`forced?: boolean` adopted, never emitted.** Plumbed through
  `SensorArgs` and `OPTIONAL_SENSOR_FIELDS` so a future feature can set it,
  but no caller does today: the frozen contract scopes `forced` to
  `KKAMAK_REINJECT` (an env override forcing the reinject-arm choice) and
  this kernel has no reinject-arm mechanism at all. Confirmed against the
  actual contract source (not just this repo's own doc comments) before
  landing — `forced` is not a generic "the gate forced this decision"
  flag, it is specific to that one env override.
- **`test/sensor-contract.test.ts` assertions flipped**, per plan: the two
  `expect(line).not.toHaveProperty(...)` bans (D1-deferred, "must never
  appear") became contract-conformant conformance checks — `pluginVersion`
  now asserted present-and-typed (this kernel's actual behavior), `forced`
  asserted typed-if-present (tolerated-absent, since nothing sets it yet).
  `test/fixtures/sensor-contract.ndjson` untouched, as required — the
  golden vectors already carried both fields (copied byte-for-byte from
  meta-harness), so no drift was ever possible there.
- Suite: 268 → 272 (4 new: pluginVersion stamp + field-count update, forced
  plumbing + round-trip, packaging drift guard). `bunx tsc --noEmit`
  clean. Kernel-side only, no adapter or config changes.

## 2026-07-30 — sensor contract conformance fix (phase 0, meta-harness §4.3 build)

Fixes the drift flagged by the MacBook setup review finding below, plus two
more found while landing it (ratified plan: meta-harness
`docs/superpowers/plans/2026-07-30-phase0-contract-events.md`).

- **`sessionId` → `sessionID`** (exact casing) renamed across the whole
  emission path: `SensorLine`/`SensorArgs`/`GateEvent`/`StateStore` in
  `src/kernel/ports.ts`, `src/kernel/sensor.ts`, `src/kernel/gate.ts`, both
  harness adapters (`hook-input.ts`, `opencode/plugin.ts`),
  `file-state-store.ts`, and every test site. `session_id` (Claude Code's
  own hook JSON field name) is untouched — only kkamak's internal field.
- **`marker: boolean` added**, required by the consumer's parser. This
  kernel has no marker/session-carryover mechanism, so `buildSensorLine`
  always stamps `marker:false`, documented in `SensorLine.marker`'s and
  `buildSensorLine`'s doc comments as a standing deferral, not an oversight.
- **`rounds` vocabulary aligned**: `RoundOutcome` was `"passed"|"failed"`,
  the frozen contract wants `"accepted"|"verify-failed"` — renamed the type
  and every emit/persist/test site (this also changes the on-disk
  `GateState.outcomes` vocabulary; no back-compat shim, since it's
  session-transient host-local state, not a shared artifact). README's
  sensor-file example and field docs updated to match.
- **D1 deferral (explicit, not silent)**: `pluginVersion`/`forced` — two
  tolerated-absent optionals on the frozen contract — are ratified as OUT
  OF SCOPE for phase 0; porting them is deferred to a packaging milestone.
  The new conformance test (`test/sensor-contract.test.ts`) asserts their
  absence from every kernel-emitted line, so a future accidental partial
  port gets caught rather than silently drifting further from the vector
  shapes.
- **Golden vectors**: `test/fixtures/sensor-contract.ndjson` — the 4
  canonical vector lines, copied byte-for-byte (D2) from meta-harness
  `km-crank/test/sensor-contract.test.ts`'s embedded `VECTOR_LINES`. Byte
  parity verified both directions: locally against a reconstruction of the
  meta-harness source, and by running that repo's own advisory parity test
  (`bun test test/sensor-contract.test.ts` there — 5/5 pass, parity no
  longer skipped now that this file exists).
- Suite: 260 → 268 (8 new: 1 marker-stamping test, 7 in the new
  `test/sensor-contract.test.ts` covering a driven-kernel conformance check
  for all 4 canonical shapes plus fixture sanity). `bunx tsc --noEmit`
  clean.

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
