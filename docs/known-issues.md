# Known issues

These came out of the 0.4.0 pre-release review. All were judged Minor: none
of them block using kkamak, and none were fixed as part of that review —
they are recorded here so the judgement is visible, not silently acted on.

## 1. `.claude-plugin/marketplace.json` has no `$schema` or top-level `description` — RESOLVED

Judged minor because the marketplace still works without either — `claude
plugin marketplace add` doesn't require them. Worth having anyway: `$schema`
buys editor and CI validation for free, and other working marketplaces on
the maintainer's own machine carry both fields.

Resolved: both fields added. `$schema` is
`https://anthropic.com/claude-code/marketplace.schema.json`, confirmed
against the official `claude-plugins-official` and third-party `caveman`
marketplaces installed on the maintainer's machine, which both point at the
same URL. `description` mirrors `plugin.json`'s. Pinned by
`test/packaging.test.ts`'s "marketplace.json carries a $schema and a
top-level description" test.

## 2. `CHANGELOG.md` files every 0.4.0 entry under `### Added` — RESOLVED

Entries like "Bump version to 0.4.0…" and "Rewrite the README…" (lines 8-19)
are changes to existing things, which [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/) files under `### Changed`,
not `### Added`. Separately, the file's header claims "All notable changes to
this project are documented in this file" while the recorded history starts
at 0.4.0 with no explanation of the gap. Judged minor because the content
under each entry is accurate regardless of which heading it sits under, and
the gap has an obvious one-line explanation that just hasn't been written
yet: 0.4.0 is the first public release; 0.1-0.3 were never released.

Resolved: the two change-shaped 0.4.0 entries moved under a new `### Changed`
heading; the header now states that 0.4.0 is the first public release and
0.1-0.3 were never released. Nothing pins this; it is prose.

## 3. `package.json`'s description uses "an agent" instead of "Claude Code" — RESOLVED

`package.json:5` reads "an agent cannot say done…" where `.claude-plugin/
plugin.json` and `.claude-plugin/marketplace.json` both say "Claude Code
cannot say done…". Judged minor because `package.json` is `"private": true`
and never published to npm, so this description is not user-facing in
practice — but it's the one place the CC-first framing slips.

Resolved: `package.json` now reads "Claude Code cannot say done…", matching
`plugin.json` and `marketplace.json` verbatim. Pinned by
`test/packaging.test.ts`'s "package.json, plugin.json and marketplace.json
descriptions agree" test.

## 4. README's gate.json placement instructions describe the wrong directory — RESOLVED

`README.md`'s "Set up `gate.json`" section says to put the file "at the repo
root, next to `.git/`." In fact `gate.json` is read from the Claude Code
hook payload's `cwd` (`src/adapters/claude-code/hook-input.ts:37` →
`src/runtime/config-source.ts:17`), not resolved relative to the repo root.
Launch Claude Code from a subdirectory and the gate silently no-ops — which
is exactly the failure mode the README's own "Confirm it loaded" paragraph
warns is indistinguishable from a passing check. Judged minor rather than
blocking because the common case (launching from the repo root) happens to
put `cwd` and repo root in the same place, so most readers never hit the
discrepancy; a clearer clause would read "…at the directory you launch
Claude Code from (normally the repo root)."

Resolved. `README.md` now reads: "Or write it yourself at the directory you
launch Claude Code from — normally the repo root:" — an em-dash
construction, not the parenthetical this issue's text speculatively
proposed. A following paragraph explains that the gate never searches
upward; the `sensor` field-table row was corrected the same way; the same
wrong claim was fixed in `commands/init.md` (two places) and in doc
comments on `src/runtime/config-source.ts`, `src/runtime/index.ts` (two
places), and `src/kernel/ports.ts`. The opencode adapter's `worktree`
comment (`src/adapters/opencode/opencode-types.ts:27`) was deliberately
left — its root genuinely is a repo root there. `src/runtime/
ndjson-sink.ts:26`'s error string was deliberately left, being
program-visible output. Pinned by `test/runtime.test.ts`'s "does not walk
upward: a gate.json in the parent is invisible from a subdirectory root"
test and `test/claude-code-adapter.test.ts`'s "carries the payload cwd
through as root, verbatim" test.

## 5. README's Docs section doesn't link `docs/install-verification.md` — RESOLVED

`README.md`'s Docs section links `docs/opencode.md` and `CHANGELOG.md` but
not the install-verification runbook. Judged minor because omitting it may
be intentional — the runbook is maintainer-only in the sense that a maintainer,
not an end user, runs it after cutting a release — but that intent isn't
stated anywhere, so a reader can't tell the omission from an oversight.

Resolved: README's Docs section now links `docs/install-verification.md`
and states it is maintainer-scoped.

## 6. `docs/dogfood-log.md` is opaque to readers outside the private meta-harness repo — RESOLVED

`CHANGELOG.md` sends public readers to `docs/dogfood-log.md` for entry
details, and that file references the private `meta-harness` repo 13 times
(round numbers, ledger files, evidence paths) that a stranger has no way to
resolve. Judged minor because nothing in the file is incorrect — it's an
honest log of what happened — it's just written for an audience with access
this repo's public readers don't have.

Resolved: `docs/dogfood-log.md` opens with a preamble declaring its audience
and stating that its `meta-harness` citations resolve only in a private
repo. The citations themselves were kept.

## 7. A stray `hello` line leaks to stderr during the test run — RESOLVED

`test/runtime.test.ts:283` calls `host.logger.log("hello")` to assert a
logger failure doesn't throw, and that call's own output (`hello`) leaks to
stderr rather than being captured — so every `bun test` run, including CI,
prints a bare `hello` line above the pass/fail summary. Judged minor because
it's purely cosmetic: the line carries no information and doesn't affect the
test's pass/fail result.

Resolved: `test/runtime.test.ts`'s logger test now spies on
`process.stderr.write` and asserts the delivered message, so no bare
`hello` reaches the run's output.

## 8. `FileStateStore.save()` is a blind overwrite — concurrent handlers can race and lose an update — RESOLVED

Flagged by an independent architect review, 2026-08-11. `FileStateStore.save()`
(`src/runtime/file-state-store.ts:36-53`) writes via temp-file-plus-rename, so
each individual write is atomic — but there is no compare-and-swap or version
check against whatever is already on disk at write time. Every handler in
`gate.ts` does a non-atomic read-modify-write: `handleEvent` loads state at
`gate.ts:58`, and in `onStopRequested` an `await host.check.run` sits between
that load and the eventual persist (`gate.ts:155-169`) — for up to
`checkTimeoutMs`, 300s by default. No locking exists anywhere in `src/`
(confirmed by grep).

**Concrete failure case.** `rounds: 2`, state on disk `gating:true, round:1`.
Process A is mid-check on the retry. A new user prompt arrives and Claude Code
delivers it in a separate process; process B loads that same pre-A state,
takes the `gating` branch of `onNewUserPrompt` (`gate.ts:117-133`), writes an
interrupted sensor line, and persists a full `INITIAL_STATE` reset — the
documented human-preemption stand-down. Process A then finishes its check and
persists its own, now-stale snapshot with `round:2`, clobbering the reset. A
later, unrelated turn now sees `round === config.rounds`, so its first failing
check goes straight to exhaustion with zero blocks actually issued that cycle
— and the sensor stream holds two overlapping lines making inconsistent
claims about the same window. For opencode this needs no second process at
all: `plugin.ts`'s `chat.message` handler and its `session.idle`-driven stop
handler (`src/adapters/opencode/plugin.ts:90-125`) are async callbacks in one
event loop sharing a single `gate` instance, and the `await` inside each
yields control between them the same way a second process would.

This exact gap was flagged and deliberately deferred in
`docs/superpowers/plans/2026-07-30-kernel-review-remediation.md`, on the
stated condition that it be revisited "once the adapters exist and the real
invocation model is known." That condition is now met — both adapters have
shipped.

**Judgement: not fixed here.** Fail-open still holds, so no session wedges;
what degrades is enforcement strength on a later turn and the integrity of the
sensor stream, not availability. The fix is optimistic concurrency (re-read
and compare `updatedAt` before the rename) or an OS advisory lock in
`FileStateStore`, plus tests that exercise the actual cross-process/cross-callback
race — too large to land unplanned on release day.

**Partially resolved.** `FileStateStore.save()` now does a compare-and-swap:
it re-reads the on-disk record immediately before committing and throws
rather than overwrite when its `updatedAt` doesn't match the
`expectedUpdatedAt` the caller's `state` was loaded with. That version is
threaded from `load()` through every `gate.ts` handler via the `state`
parameter each already holds — the `StateStore.save()` port signature changed
to `save(sessionID, state, expectedUpdatedAt)` accordingly, both
implementations and every call site updated. A stale write now throws,
`persist()`'s existing catch turns that into `false`, and the block branch's
existing "cannot record → downgrade to allow" path handles it exactly like
any other save failure — fail-open holds.

This closes the failure case described above: the load-then-slow-check
window, where process A sits on a stale `load()` for up to `checkTimeoutMs`
while a faster writer B commits first. **It does not close the
read-to-rename window**: `save()`'s own compare read and its later
`fs.renameSync` are two separate syscalls with nothing holding a lock between
them, so a second OS process could still land a write in that narrow gap and
still win a race against this store's own compare-and-swap. That is the
OS-advisory-lock half of the fix named in the original judgement above, and
it is still not implemented — this remains the honest boundary of what a
single-process optimistic check can guarantee. Regression tests
(`test/runtime.test.ts`, `test/gate.test.ts`) cover the stale-write refusal,
both awkward cases named in the original finding (racing to create a
session's first record, racing to delete one a concurrent writer just
advanced), and that losing the race still fails open end-to-end through the
kernel.

**Fully resolved.** `FileStateStore.save()`'s whole read-modify-write — the
compare-and-swap read, the accept/delete decision, and the commit itself —
now also runs under a best-effort advisory lock (`FileStateStore.withLock`),
closing the read-to-rename window the "Partially resolved" note above named
as still open. It is a lockfile via atomic `O_CREAT|O_EXCL` create (`"wx"`),
not a real `flock` syscall — Node's `fs` module exposes none without a
native addon, and this is the technique effectively every userland Node
lockfile library falls back to instead. Two concurrent `save()` calls for
the same session now serialize, so one's compare-and-swap read can no longer
interleave with the other's rename.

This does not make the lock unconditional, by design. Fail-open is absolute
(`gate.ts`'s governing rule), so a lock that cannot be acquired within a
bounded timeout, a lock left behind by a killed process (reclaimed once it
is older than a generous staleness threshold rather than waited out
indefinitely), or a filesystem that rejects the lock operation outright
(`EACCES`, `EROFS`, an unsupported call) all fall through to running the
read-modify-write **unlocked** — still protected by the compare-and-swap
check alone, exactly as in the "Partially resolved" state above. A `save()`
that takes that degraded path is exposed only to the microscopic
read-to-rename gap this lock exists to close; the much larger
load-then-slow-check race the compare-and-swap check closes on its own still
holds unconditionally either way. The lockfile technique also inherits the
standard caveat any `O_CREAT|O_EXCL`-based lock has on very old NFS versions
that do not implement it atomically — the same caveat a real `flock` would
have there too, and not a new limitation this introduces. Regression tests
(`test/runtime.test.ts`) cover a live lock forcing the degraded path without
hanging or throwing, a stale lock being reclaimed rather than blocking
forever, and a filesystem that rejects the lock operation outright still
completing the save unlocked.

**A second, independent review of this fix found two more gaps, both now
closed.**

**Defect 1 (high): the reset in `onNewUserPrompt` ignored its own
`persist()` failure.** `onStopRequested`'s block branch already checked
`persist()`'s return and downgraded to `allow` on a lost compare-and-swap
(pinned by `test/gate.test.ts`'s "a concurrent writer during a slow check
wins the race" test, above) — but the reverse interleaving was unguarded.
Setup: `gating:true, round:1, updatedAt:U0` on disk. A `stop-requested` and
a `new-user-prompt` both load `U0`; this time the stop-requested handler is
the fast one and lands its own block first, `round:2, updatedAt:U1`. The
prompt handler's reset then computes its compare-and-swap against the now-
stale `U0`, loses, `persist()` returns `false` — and the old code returned
`allow` anyway without checking. On-disk state was left `gating:true,
round:2` even though the human had moved on, while the sensor line already
claimed `interrupted:true` — state and telemetry disagreeing. Worse: a
later, unrelated cycle would then see `state.round === config.rounds` and
exhaust on its very first failing check with zero blocks of its own
issued — this issue's own headline symptom, reproduced through the one
path the first pass left unguarded. Reachable in a single process, no
second process needed: opencode's `chat.message` and `session.idle`
handlers share one `gate` instance and can race the same way.

Fixed: `onNewUserPrompt`'s reset now checks `persist()`'s return, and on a
lost race reloads the current state and retries the reset once against the
fresh `updatedAt`. Human preemption is unconditional intent — it wins by
retrying, not by silently no-op'ing. One retry, not a loop: a second lost
race — needing a *third* write to land in the brief window between the
retry's own load and its persist — is left alone rather than chased
further.

**That residual is not a fail-open case, and an earlier draft of this entry
mislabeled it as one.** Fail-open means this session's own turn is allowed
through regardless, which was already true before this fix existed and
isn't what's at stake here. What a second lost race actually leaves behind
is this issue's own over-gating symptom, narrowed rather than eliminated: a
later, unrelated cycle could still inherit a stale round count from
whichever write won that second race, and exhaust on its first failing
check with zero blocks of its own issued. Narrower by a wide margin than
the defect this fix closes — it now takes three overlapping writers instead
of two — but not zero, and not the same shape as fail-open. Corrected here
rather than left mislabeled, because a wrong justification is how an
accepted risk gets re-accepted later without re-examination. Pinned by
`test/gate.test.ts`'s "a concurrent writer that lands a block first still
loses to the human's reset, once retried" test — the mirror image of the
existing one.

The same ignored-return shape was audited at the two other places
`persist`/`withPersist`'s return goes unchecked in `gate.ts`:
- `onFileEdited` (arming): the payload only ever flips `edited` false→true.
  Losing the race against another concurrent arm is harmless (both write the
  same value); losing it against a concurrent reset drops this one edit's
  mark, which under-gates rather than over-blocks — the same direction the
  file's own fail-open rule already calls for, and the same conclusion the
  original 2026-07-30 review reached for this exact line. Left as-is.
- `onInternalError`'s sub-limit branch (the `errorStreak` increment before
  disarm): the payload only increments a counter on top of whatever `state`
  already carries; it does not undo a concurrent writer's real progress.
  Losing the race just delays disarm-after-3 by at most one extra internal
  error, never skips or corrupts it. Left as-is.
- The disarm branch itself (`{...INITIAL_STATE, errorStreak, disarmed:true}`)
  is structurally closer to `onNewUserPrompt`'s case than to either of the
  above — a full reset representing its own kind of unconditional intent —
  but was out of scope for this review. Noted in `gate.ts` as a candidate
  for the same retry treatment if it gets a closer look; not fixed here.

**Defect 2 (medium): `reclaimIfStale` judged staleness on age alone.**
`DEFAULT_LOCK_STALE_MS` (2000ms) is far longer than any real critical
section, but age alone cannot distinguish a dead holder from a merely slow
one — a disk stall, scheduler preemption, or a throttled cgroup (all
realistic under WSL2) can push a live holder's critical section past the
threshold. The old code reclaimed on age alone, so a second writer could
steal a still-live holder's lock, and both would then run `commit()`
concurrently — both reading the same pre-write value and both passing their
own compare-and-swap, reintroducing the exact lost update this lock exists
to prevent, now masked by an apparently successful lock cycle instead of
surfaced as a conflict.

Fixed: the lockfile now records its holder's pid (still one atomic create —
`fs.writeFileSync(lockPath, String(process.pid), {flag:"wx"})`), and
`reclaimIfStale` reclaims only when BOTH the age check and a liveness check
(`process.kill(pid, 0)` throwing `ESRCH`) agree the holder is gone. A pid
that cannot be read or parsed is left alone rather than guessed at — that
case still falls back to the bounded acquire timeout in `withLock`, which is
what actually prevents wedging either way, not this staleness check.
Regression tests (`test/runtime.test.ts`) cover a stale lock with a
confirmed-dead pid being reclaimed, and — the case the defect was actually
about — an old lock whose recorded holder is still alive NOT being reclaimed
even past the staleness threshold.

**A related residual, not previously documented here: pid reuse.** If a
holder crashes after writing the lockfile but before its own
`finally`-release runs, the lockfile is left stamped with that holder's
pid. Should the OS later recycle that exact pid to any unrelated live
process before this lock is next contended, `process.kill(pid, 0)` succeeds
against the new process and the lock is never reclaimed by the liveness
check either. This shares its fallback with the unparseable-pid case just
above and cannot wedge for the same reason: the same bounded acquire
timeout in `withLock` covers it too, degrading to the CAS-only unlocked
path exactly as it would for any other unreclaimable lock. The cost is
narrower than a wedge but real — whichever session hits it pays a full
`lockAcquireTimeoutMs` stall on every `save()` against that lockfile, plus
an orphaned lockfile that persists until the recycled pid itself exits.
Untestable by construction — a pid recycle cannot be forced
deterministically — which is exactly why it is documented here and at
`reclaimIfStale`'s own comment in `file-state-store.ts` rather than pinned
by a test.

## 9. `test/imports.test.ts`'s import scanner is a regex over raw text, not comment-aware — prose can be misread as an import

`importsIn()` (`test/imports.test.ts:36-39`) scans a file's raw source text
with `/(?:\b(?:import|export)\b[\s\S]*?\bfrom\s*|\bimport\s*|\brequire\s*)
\(?\s*["']([^"']+)["']/g` — matching the literal words `import`/`export`/
`require`, followed by any characters at all (`[\s\S]*?`, non-greedy but
unbounded), then `from` and a quoted string. It never strips comments
first, so `import`, `export`, `require`, and `from` mean nothing special to
it inside a `//` or `/* */` comment — they read exactly as code would.

**Concrete instance, hit for real during this work.** A doc comment in
`src/runtime/file-state-store.ts` read, across two comment lines: `tell
"old and abandoned" from "old and merely` / `slow" apart in
reclaimIfStale below...`. The scanner matched `from "old and merely\n
      // slow"` as an import specifier — a two-line quoted string built by
treating the comment's own line break as if it were source — and
`test/imports.test.ts`'s "no import depends on a package that installation
would leave behind" test failed on it, blocking the turn. Nothing about the
code was wrong; the words were prose describing what the code does.

That failure was resolved by rewording the comment, not by fixing the
scanner. The defect is therefore still present on `main`: the next comment
that happens to contain the word `from` followed eventually by a quoted
phrase — plausible in any comment describing string handling, error
messages, or (as here) explaining a data-format distinction in prose — will
fail the suite the same way, and the cheapest fix available in the moment
will again be to edit the comment rather than the scanner.

This connects to a limitation already on record. The 0.4.0 pre-release
review's finding 2 flagged that "the import scan cannot prove itself"
(`docs/superpowers/plans/2026-07-30-kernel-review-remediation.md:361`) —
that finding was about **under**-detection, a regex that could miss a real
violation with nothing to prove otherwise. This is the same root cause
running the other way: a text regex standing in for real import-graph
analysis, with neither its precision nor its recall ever fully proven. Both
directions are consequences of scanning text instead of parsing it.

**Judgement: recorded, not fixed.** A real fix needs either an actual
parser (so `import`/`from`/`require` are only meaningful in syntactic
position, never inside a comment or string literal) or, at minimum,
stripping comments from the source before the regex runs — the latter is a
smaller change but only closes this specific direction, not the sibling
under-detection gap finding 2 already named. Leaving it as-is carries a
real risk beyond an occasional false alarm: it is a test that can fail on
provably correct code, and a test that does that trains whoever hits it to
edit until the test stops complaining rather than to trust it — exactly the
gate-avoidance shape recorded in this session's `docs/dogfood-log.md`
correction to the 2026-08-11 entry.

## Regression: `gate.json`'s `gauge` field was wrongly removed, then restored

This repo's own tracked `gate.json` carries `"gauge": true`. The public
kernel's `parseGateConfig` (`src/kernel/config.ts`) ignores unknown fields
entirely, so in a plain kkamak install `gauge` does nothing — which made it
look, correctly for any other install, like dead config. A later review
finding removed it from this file on exactly that basis.

But on the maintainer's own machine this repo's `gate.json` is also read by
an installed research build, `cc-gate-plugin` (a separate, private plugin
layered on top of kkamak for dogfooding measurement), whose
`src/config.ts:18` reads `gauge: j.gauge === true` and whose
`src/gauge/spawn.ts:36` returns early — arming no measurement — unless that
field is `true`. Removing the field from this repo's `gate.json` silently
disabled that instrument's corpus collection here; every gate cycle between
the removal and its discovery recorded no gauge data, and that gap is not
recoverable after the fact.

**Do not remove `gauge` from this repo's `gate.json` again** on the grounds
that the public kernel doesn't read it. It is intentionally present for a
consumer outside this repo's own kernel. If the public-facing sample gate.json
shown in README.md or elsewhere needs to omit it for clarity, that's a
different file than this repo's own root `gate.json` — don't conflate the two.

## 10. The `checkTimeoutMs` clamp's warning never reaches the user under Claude Code

Found while executing `docs/install-verification.md` against 0.5.0, before merging it.

The A4 clamp (0.5.0) stops a `checkTimeoutMs` set at or above the `Stop` hook's
own 600s ceiling from getting the hook process killed mid-check, which
previously destroyed the whole cycle: no state written, no round consumed, no
record — indistinguishable from a gate that never ran. That protection works,
verified end to end through a real plugin install.

The warning does not. The clamp reports through `note()`
(`src/kernel/gate.ts`), which reaches `StderrLogger` and therefore the hook
process's stderr. **Measured:** running a real `claude -p` session in a scratch
repo whose `gate.json` set `checkTimeoutMs: 600000` produced a normal sensor
line and no warning anywhere in the session output; driving the same installed
`hook-cli.ts` directly against the same repo printed the full line
(`kkamak: checkTimeoutMs 600000 leaves no margin under the host's 600000ms stop
ceiling — running the check with 595000ms instead; set checkTimeoutMs to at
most 595000 in gate.json`). So the message exists and is correct; Claude Code
simply does not surface hook stderr in an ordinary session.

**Why it is not routed to the user-facing channel.** README's "Delivery
channels" section is accurate: `notice` reaches the user as a `systemMessage`.
But `notice` lives on `GateDecision`, and the clamp happens *before* the check
runs — there is no decision yet to attach it to. Threading a pending warning
into the eventual decision would cover the allow paths only:
`GateDecision.block` has no `notice` field at all, so a clamp on a blocking
cycle would stay invisible unless one were added. That is a design change to
the decision type, not a small fix.

**Judgement: recorded, not fixed.** The consequence is bounded and one-
directional — a user with a misconfigured `checkTimeoutMs` silently gets a
shorter check than they asked for, rather than silently losing the entire
cycle as before. That is strictly better than 0.4.2 and strictly worse than
being told. Both `README.md` and `CHANGELOG.md` were corrected to describe the
clamp as silent protection rather than as a warning, so the docs do not
promise a message that never arrives.

## 11. A1 widened an unaudited gap in #8's own CAS coverage: `onStopRequested`'s accept/exhaust resets never checked `persist()`'s return — RESOLVED

Flagged by an independent architect review, 2026-08-12, while reviewing A1
(cycle tagging). #8's audit above enumerated every place `persist`/
`withPersist`'s return went unchecked in `gate.ts` and reasoned about each —
but `onStopRequested`'s own two unconditional resets (the accept path and the
exhausted path, both `persist(host, sessionID, { ...INITIAL_STATE }, ...)`)
were not among them. Not "left as-is" by a documented judgement, like
`onFileEdited`'s arm write — simply missed.

Pre-A1 this was hard to hit: `onFileEdited` persisted once, at a cycle's
first edit, then went silent for the rest of the cycle (`state.edited` was
already `true`), so there was effectively nothing left to race against these
two resets during `onStopRequested`'s `await host.check.run(...)` window.
A1's `accumulateTouchedPath` changes that — `onFileEdited` now persists on
every edit that adds a new distinct touched path, for the whole cycle, not
just the first — which reopens that window for the full duration of the
check. A concurrent `file-edited` write landing in it can win the race and
leave these resets' own compare-and-swap stale.

Because these two resets ignored `persist()`'s return, a lost race here was
silent: the decision returned to this turn was already correct (computed and
recorded before the reset attempt, same as the block branch's own accept/
reject-of-persist pattern), but on-disk `gating`/`round` stayed at whatever
the concurrent writer left — the same "round already at budget, first
failing check exhausts with zero blocks issued" symptom class #8 exists to
prevent, reachable here through a path #8 never covered.

**Resolved**, alongside a third, adjacent gap the same review surfaced:
`onInternalError`'s disarm-after-3-errors reset was already flagged in its
own doc comment as "worth a retry like `onNewUserPrompt`'s if this gets a
closer look, not fixed here" (see #8's own audit list above) — that closer
look happened here. All three — the two `onStopRequested` resets and
`onInternalError`'s disarm — now share one `resetWithRetry` helper
(`gate.ts`) implementing the identical one-retry-on-CAS-loss pattern
`onNewUserPrompt`'s reset already used (`onNewUserPrompt` was refactored onto
the same helper rather than kept as a fourth, slightly different copy).
Regression tests (`test/gate.test.ts`) cover a lost race for each of the
three, injected the same way the pre-existing `onNewUserPrompt` race test
was: a scripted concurrent write during the check runner's execution.

Not touched: the config-vanished-mid-cycle reset (`onStopRequested`, config
parses to `undefined` while `state.gating`) keeps `edited` rather than doing
a pure `INITIAL_STATE` reset, and its race window is the same narrow,
un-widened one it always had (no `await` sits between the state load and
this particular persist) — out of scope for what this review actually
found, not a judgement that it is race-free.

## 12. `oneshot`'s dogfood measurement — four minors from cross-lane checkpoint-3 review — RESOLVED

Surfaced during meta-harness lane-B's independent review of the `oneshot`
skill (`docs/superpowers/specs/2026-08-21-oneshot-design.md`,
`docs/superpowers/plans/2026-08-21-oneshot.md`), after the suite was
independently re-run there (458/458) and the shipped files checked against
the plan's claims. Judged minors, not gates: none block using `oneshot` or
change what it's safe to merge; recorded so the judgement is visible rather
than silently deferred.

1. **`correlate.ts`'s `steeringConsumed` is temporal co-occurrence, not
   proven causal steering use.** `hadAnyFailure && lastOk` only says a
   window contained a false attempt followed by a true one — it does not
   establish that the model actually read and acted on the failure's
   `output`, as opposed to retrying for an unrelated reason and happening
   to pass. The header comment documents the session-id correlation
   limitation but not this one. Follow-up: add a line to `correlate.ts`'s
   header (or the `steeringConsumed` field's doc comment) making this
   explicit — the meta-harness lab made exactly this overclaim once and
   had to retract it; the metric here should never be read stronger than
   what it actually establishes.

2. **`run-once.ts` appends a full ~4k output tail to the dogfood log on
   every attempt**, not just the final one. A chatty check (a large test
   suite's failing output, repeated across several in-script retries)
   bloats `.km/oneshot-dogfood.ndjson` faster than necessary for what the
   log is actually used for (steering-consumption/mismatch counting, which
   only needs `ok` + attempt count per window). Follow-up: consider logging
   `{ts, ok, outputLength}` on non-final attempts and the full (truncated)
   `output` only on the attempt that ends the window.

3. **Source 1 and Source 2 can land in different directories.** `run-once.ts`
   writes `.km/oneshot-dogfood.ndjson` relative to its own `process.cwd()`
   (wherever the script that invoked it was run from); `dogfood-hook-cli.ts`
   writes `.km/oneshot-dogfood-calls.ndjson` relative to the hook payload's
   `cwd` (the Claude Code session's working directory). These are normally
   the same directory, but a `Bash` call that `cd`s elsewhere before
   invoking `run-once.ts` splits the two logs into different `.km/`
   directories, silently breaking `correlate.ts`'s join. Follow-up: one doc
   line in `correlate.ts`'s header noting this precondition (both logs must
   be read from the same root) rather than a runtime check.

4. **On a repo with no `gate.json`, `template.sh` burns its full
   `rounds + 1` attempt budget on identical, unhelpful failures** — each
   attempt's `run-once.ts` invocation reports the same "no gate.json with a
   usable check found" error, and the loop has no way to distinguish that
   from a real, possibly-fixable check failure. Harmless (bounded, same
   failure every time, exits 1 same as it should), but wasted attempts.
   Follow-up: `SKILL.md` could tell Claude to confirm `gate.json` exists
   and has a `check` field before writing the retry loop at all.

**Resolved**, all four, by dogfooding `oneshot` on itself: the fixes were
written as one `oneshot`-shaped script (`run-once.ts`, `template.sh`,
`correlate.ts`, `SKILL.md`, and their tests, rewritten in full) and run
against this repo's own `gate.json` (`check: "bun test"`, `rounds: 2` →
3 attempts) in a single `Bash` call, per `skills/oneshot/SKILL.md`.

1. `correlate.ts`'s `steeringConsumed` field now carries a doc comment
   stating plainly that it is temporal co-occurrence, not proven causal
   steering use.
2. `run-once.ts` now logs `{ts, ok, outputLength}` on non-final failing
   attempts and the full truncated `output` only when an attempt is final
   (`ok:true`, or `ONESHOT_FINAL_ATTEMPT=1` set by `template.sh` on its
   last allowed attempt). Confirmed against the real dogfood log this
   produced: attempts 1-2 (both failing, non-final) logged
   `outputLength` only; attempt 3 (failing, final) logged full `output`.
3. `correlate.ts`'s header now states the same-root precondition between
   Source 1 and Source 2 explicitly.
4. `SKILL.md` now instructs confirming `gate.json` exists before writing
   the retry loop.

**What the dogfood run itself found, unprompted:** all 3 real attempts
failed identically — a genuine steering-not-consumed result, not a
mechanism bug. The driver script's EDITS block wrote the same content on
every retry (no correction between attempts), so the same test failure
recurred 3 times and the budget exhausted for real: `test/oneshot-skill.
test.ts`'s new assertion checked for the literal substring `"gate.json
exists"`, but the `SKILL.md` prose it was checking reads `` `gate.json`
exists `` — a markdown code-span backtick sits between the two words,
so the literal substring never matched. Both were authored in the same
pass and disagreed with each other. Fixed via the normal `Edit` fallback,
per `SKILL.md`'s own step 6 ("if it exits 1 ... fall back to the normal
edit/Stop-hook cycle") — `oneshot`'s own 3-attempt budget had already been
spent on identical failures, so a 4th identical retry inside the same
mechanism would not have helped.

## 13. `oneshot`'s Source-2 marker count is blind to any indirection between the `Bash` call and `run-once.ts`

Found during the dogfood run for #12, not one of the four minors reviewed
at checkpoint-3 — a fresh discovery, not yet reviewed. `countMarkers`
(`dogfood-hook-input.ts`) counts literal occurrences of the substring
`"run-once.ts"` in `tool_input.command` — the outer command text Claude
Code hands the `PostToolUse` hook. This only works when that text
*directly* contains the invocation, matching `SKILL.md`'s literal
prescription ("copy `template.sh`'s contents ... into one `Bash` tool
call").

The dogfood run for #12 did not do that: six files needed rewriting
(`run-once.ts`, `template.sh`, `correlate.ts`, `SKILL.md`, two test
files), so the actual `Bash` tool call invoked a driver script file
(`bash /path/to/driver.sh <PLUGIN_ROOT> <MAX_ATTEMPTS>`) rather than
inlining the template. `tool_input.command` for that real call was just
that one line — it never contains the substring `"run-once.ts"` at all
(confirmed: `countMarkers` on the real command text returns `0`), even
though the driver script it invoked genuinely ran `run-once.ts` three
times, and Source 1 genuinely recorded all three. Feeding
`dogfood-hook-cli.ts` that real command line confirmed it: no
`.km/oneshot-dogfood-calls.ndjson` was written at all, and `correlate.ts`
against the real Source-1 log and an empty Source-2 correctly produced an
empty report (`{"windows":[],"abandonedRetryCount":0}`) — accurate given
the inputs, but zero observability into three real, successful attempts.

Separately, even under the literal-inline usage pattern `SKILL.md`
prescribes, `template.sh`'s own retry loop calls `run-once.ts` from a
*single* line inside a `while` loop — the command text contains that
substring once, regardless of how many times the loop actually retries
at runtime. Static text-counting cannot distinguish "one invocation site
that ran three times" from "one invocation site that ran once"; only
Source 1's real log-line count can. `markerCount` is therefore, at best,
a same-session-adopted-`oneshot`-at-all signal, not a retry-count signal
— the spec's "structural retry-shape signal" and "mismatch = script
crashed mid-loop" framing (`correlate.ts`'s header, `known-issues.md`
#12.3's context) assumed `markerCount` would scale with real retries,
which it does not for the loop shape `template.sh` itself ships.

Not fixed here — beyond the four minors reviewed at checkpoint-3, needs
its own review before any change. Two directions worth weighing, neither
chosen yet: (a) accept Source 2 as an adoption-only signal (did `oneshot`
get used at all this session) and stop calling `markerCount` a retry-count
proxy anywhere in the docs; (b) have `run-once.ts` itself emit a
distinguishable marker per real invocation to *its own stdout*, which
`PostToolUse` genuinely cannot see (confirmed absent per #12.3's own
`tool_response` finding) — meaning (b) may not be buildable at all under
the current hook payload, which is itself worth confirming before
proposing it as a fix.
