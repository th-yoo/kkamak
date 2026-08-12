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
retrying, not by silently no-op'ing. One retry, not a loop; a second lost
race is left alone, consistent with fail-open. Pinned by
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
