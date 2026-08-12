// The gate lifecycle state machine.
//
// PURE: every effect arrives through a port on GateHost. Nothing here imports
// fs, child_process, os, or any harness.
//
// The governing rule is fail-open. A gate that wedges a session is worse than
// no gate at all, so every failure path — unreadable config, crashed check,
// unwritable state, a bug in this file — resolves to "allow".
import { isTestPath } from "./classify.ts"
import { parseGateConfig } from "./config.ts"
import { buildSensorLine, type SensorArgs } from "./sensor.ts"
import { INITIAL_STATE, TOUCHED_PATHS_CAP } from "./state.ts"
import type {
  CheckResult,
  Gate,
  GateConfig,
  GateDecision,
  GateEvent,
  GateHost,
  GateState,
  RoundOutcome,
} from "./ports.ts"

/** Consecutive internal errors after which the gate gives up on the session. */
export const ERROR_STREAK_LIMIT = 3

/**
 * Safety margin held back from a host-supplied kill ceiling
 * (`HostInfo.stopTimeoutMs`) when clamping `checkTimeoutMs`: everything the
 * ceiling covers besides the check itself must fit inside it, or the host
 * SIGKILLs the hook before the gate records anything.
 *
 * Basis: measured 2026-08-12 (WSL2 dev machine, 15 end-to-end Claude Code
 * hook-cli Stop runs with a trivial check), worst-case non-check overhead —
 * bun startup, stdin read, config/state load, state write, sensor append,
 * decision emit — was 78.8ms. The ~60x headroom on top of that is a declared
 * guess, not a measurement: it buys room for system load, cold caches and
 * slow filesystems, and costs under 1% of a 600s ceiling.
 */
export const CHECK_CLAMP_MARGIN_MS = 5_000

/**
 * Advisory hygiene countermand, returned on `GateDecision.marker` when
 * `GateConfig.marker` is on and a cycle just cleanly accepted. Mirrors the
 * intent of the frozen contract's own hygiene marker (meta-harness
 * cc-gate-plugin `vendor/session2.ts`'s `HYGIENE_MARKER`) without copying
 * its wording — kkamak-style, not a port.
 */
export const HYGIENE_MARKER =
  "kkamak: the gate for this task is closed — its check output and verification transcripts are obsolete; do not carry them into unrelated work."

const ALLOW: GateDecision = { kind: "allow" }

export function createGate(host: GateHost): Gate {
  return {
    async handle(event: GateEvent): Promise<GateDecision> {
      try {
        return await handleEvent(host, event)
      } catch (err) {
        // Last line of defence: a bug in the kernel must not hold a session
        // hostage.
        note(host, `gate error, allowing the event through: ${describe(err)}`)
        return ALLOW
      }
    },
  }
}

async function handleEvent(host: GateHost, event: GateEvent): Promise<GateDecision> {
  // Read gate.json on every single event and hold it nowhere. Caching is
  // impossible by construction rather than by discipline, which is what makes
  // editing or deleting the file an escape hatch that needs no restart.
  const config = parseGateConfig(host.config.read())
  const state = host.state.load(event.sessionID)

  if (state.disarmed) return ALLOW

  switch (event.kind) {
    case "file-edited":
      return onFileEdited(host, event.sessionID, state, config, event.path)
    case "new-user-prompt":
      return onNewUserPrompt(host, event.sessionID, state, config)
    case "stop-requested":
      return onStopRequested(host, event.sessionID, state, config)
  }
}

/**
 * A1: fold one newly-observed path into the cycle's touched-path set.
 * `undefined` (a harness that reports no path, e.g. opencode) and an
 * already-seen path both leave the set untouched. Once the cap is hit, a new
 * distinct path is dropped rather than added, and `truncated` flips instead
 * — the cap bounds the state record, the flag says the set can no longer be
 * trusted as complete (see `cycleTags` for what that means downstream).
 */
function accumulateTouchedPath(
  paths: readonly string[],
  truncated: boolean,
  path: string | undefined,
): { paths: string[]; truncated: boolean; changed: boolean } {
  if (path === undefined || paths.includes(path)) {
    return { paths: [...paths], truncated, changed: false }
  }
  if (paths.length >= TOUCHED_PATHS_CAP) {
    return { paths: [...paths], truncated: true, changed: !truncated }
  }
  return { paths: [...paths, path], truncated, changed: true }
}

/**
 * Arming. A repo with no usable gate.json accumulates no state at all.
 *
 * Audited (docs/known-issues.md #8), extended for A1: earlier this persist's
 * return was ignored because the payload only ever flipped `edited`
 * false→true, so losing the compare-and-swap against another concurrent
 * file-edited write was harmless — that writer set the same field to the
 * same value. A1 adds a second payload, the touched-path set, that keeps
 * changing across the whole cycle rather than settling after the first
 * write — so this now persists on every edit that adds a new distinct path
 * or newly trips the truncation cap, not just the first. The race reasoning
 * still holds in the same direction: losing this compare-and-swap drops one
 * edit's path from the set (or, rarely, the truncation flip), which
 * under-gates the *telemetry* rather than over-blocking anything — the
 * classifier never gates a decision (see `classify.ts`), so a dropped path
 * costs a possibly-wrong `implOnly`/`sameTurnCoEdit` field, never a wedged
 * turn. Losing it against a concurrent reset still just drops this one
 * edit's own arming/path write — the reset itself already committed
 * (`resetWithRetry` covers *its* side of that race), so the session ends up
 * correctly unarmed for a cycle that is, from the reset's point of view,
 * genuinely over.
 */
function onFileEdited(
  host: GateHost,
  sessionID: string,
  state: GateState,
  config: GateConfig | undefined,
  path: string | undefined,
): GateDecision {
  if (!config) return ALLOW
  const touched = accumulateTouchedPath(state.touchedPaths, state.touchedTruncated, path)
  if (state.edited && !touched.changed) return ALLOW
  persist(
    host,
    sessionID,
    { ...state, edited: true, touchedPaths: touched.paths, touchedTruncated: touched.truncated },
    state.updatedAt,
  )
  return ALLOW
}

/**
 * Commit an unconditional full reset (`{...INITIAL_STATE, ...patch}`),
 * retrying once against fresh state if the first attempt loses its
 * compare-and-swap. A reset represents unconditional intent — the cycle is
 * over, full stop — so silently no-op'ing on a lost race would leave
 * `gating`/`round` stuck at whatever a concurrent writer left, for an
 * unrelated later cycle to inherit: the "round already at budget, first
 * failing check exhausts with zero blocks issued" symptom
 * `docs/known-issues.md` #8 describes. One retry, not a loop — fail-open
 * still governs, so a second lost race (a third writer landing in the
 * narrow gap between the retry's own load and its persist) is left alone
 * rather than chased further, same as every other retry in this file.
 *
 * `patch` is narrowed to the one field pair a reset ever needs to layer on
 * top of `INITIAL_STATE` (`onInternalError`'s disarm) — not the full
 * `GateState`, so a future call site cannot accidentally patch in something
 * only `INITIAL_STATE` itself should control (`touchedPaths`,
 * `cycleStartedAt`, ...) and have it silently survive both the first
 * attempt and the retry.
 *
 * The retry's own `host.state.load()` is not locally wrapped, matching
 * `handleEvent`'s top-level load (`gate.ts:74`): `StateStore.load()` is
 * documented never to throw, so both rely on that same port contract rather
 * than defending against a contract violation.
 */
function resetWithRetry(
  host: GateHost,
  sessionID: string,
  state: GateState,
  patch: Partial<Pick<GateState, "errorStreak" | "disarmed">> = {},
): void {
  if (!persist(host, sessionID, { ...INITIAL_STATE, ...patch }, state.updatedAt)) {
    const fresh = host.state.load(sessionID)
    persist(host, sessionID, { ...INITIAL_STATE, ...patch }, fresh.updatedAt)
  }
}

/**
 * A1: derive the cycle-tagging sensor booleans from the touched-path set.
 * Returns `{}` (both fields absent from the built line) rather than `false`
 * whenever the set cannot be trusted to answer the question:
 *
 * - no paths known at all — a harness that reports none (opencode), or a
 *   state record written before this field existed;
 * - the set was truncated — a truncated set has already dropped paths, so no
 *   test path among what remains cannot be told apart from no test path
 *   ever having been touched, and a field that can be silently wrong is
 *   worse than one that is absent.
 *
 * Otherwise both are real booleans, never both true (a path is source or
 * test, not both, by the same classifier call).
 */
function cycleTags(
  touchedPaths: readonly string[],
  touchedTruncated: boolean,
  testPathPattern: string,
): Pick<SensorArgs, "implOnly" | "sameTurnCoEdit"> {
  if (touchedTruncated || touchedPaths.length === 0) return {}
  const hasTest = touchedPaths.some((p) => isTestPath(p, testPathPattern))
  const hasSource = touchedPaths.some((p) => !isTestPath(p, testPathPattern))
  return { implOnly: hasSource && !hasTest, sameTurnCoEdit: hasSource && hasTest }
}

/**
 * Human preemption. With no cycle open the prompt is ordinary and state passes
 * through untouched — that is what lets `edited` survive normal turns. With a
 * cycle open the human has overtaken the gate, so it stands down completely.
 */
function onNewUserPrompt(
  host: GateHost,
  sessionID: string,
  state: GateState,
  config: GateConfig | undefined,
): GateDecision {
  if (!state.gating) {
    // A queued prompt can consume the turn boundary, so the harness never
    // delivers a stop: the check never runs and the edits go unmeasured. Say so
    // rather than dropping the boundary silently. State is left untouched — the
    // session stays armed, so the next real stop measures the edits
    // cumulatively.
    //
    // A1: deliberately no cycleTags() here. The touched-path set at this
    // instant is not final — more edits accumulate under this same still-armed
    // session, and whichever line eventually closes the cycle will tag the
    // complete set. Stamping a snapshot now would describe a cycle that has
    // not actually finished; absence is more honest than a same-cycle
    // duplicate that may not even match the eventual outcome.
    if (config && state.edited) {
      record(host, config.sensor, {
        sessionID,
        check: config.check,
        accepted: true,
        gateExhausted: false,
        interrupted: true,
        skippedStop: true,
        rounds: [],
        checkMs: [],
        durationMs: 0,
        marker: false,
        roundsMax: config.rounds,
      })
    }
    return ALLOW
  }

  if (config) {
    record(host, config.sensor, {
      sessionID,
      check: config.check,
      accepted: true,
      gateExhausted: true,
      interrupted: true,
      rounds: state.outcomes,
      checkMs: state.checkMs,
      durationMs: elapsed(host, state.cycleStartedAt),
      marker: false,
      roundsMax: config.rounds,
      ...cycleTags(state.touchedPaths, state.touchedTruncated, config.testPathPattern),
    })
  }

  // Human preemption is unconditional intent: a new prompt means this cycle
  // is over, full stop, whatever else raced against it. A concurrent
  // stop-requested handler (a second process, or opencode's session.idle
  // callback sharing this gate instance with chat.message) may have landed a
  // block first, based on the same pre-prompt read — resetWithRetry covers
  // that race, see its own doc comment.
  resetWithRetry(host, sessionID, state)
  return ALLOW
}

async function onStopRequested(
  host: GateHost,
  sessionID: string,
  state: GateState,
  config: GateConfig | undefined,
): Promise<GateDecision> {
  // Nothing armed the gate: no check runs, so an ordinary session pays nothing.
  if (!state.edited && !state.gating) return ALLOW

  if (!config) {
    // The config vanished or broke mid-cycle. Abandon the cycle but keep
    // `edited` — the user's edit is unrelated to the config's disappearance, so
    // restoring gate.json should re-gate without needing a fresh edit.
    if (state.gating) {
      persist(host, sessionID, { ...INITIAL_STATE, edited: state.edited }, state.updatedAt)
    }
    return ALLOW
  }

  const startedAt = state.gating ? state.cycleStartedAt : host.clock.now()

  // A4: a checkTimeoutMs leaving no margin under the host's kill ceiling
  // means the host SIGKILLs this whole process before the gate can record
  // anything — no state, no round, no notice. Clamp what the runner gets and
  // say so. A host that reports no ceiling (opencode's session.idle has no
  // killable timeout) passes through untouched.
  let checkTimeoutMs = config.checkTimeoutMs
  const ceiling = host.info.stopTimeoutMs
  if (ceiling !== undefined && checkTimeoutMs > ceiling - CHECK_CLAMP_MARGIN_MS) {
    const clamped = Math.max(1, ceiling - CHECK_CLAMP_MARGIN_MS)
    if (clamped < checkTimeoutMs) {
      note(
        host,
        `checkTimeoutMs ${checkTimeoutMs} leaves no margin under the host's` +
          ` ${ceiling}ms stop ceiling — running the check with ${clamped}ms instead;` +
          ` set checkTimeoutMs to at most ${clamped} in gate.json`,
      )
      checkTimeoutMs = clamped
    }
  }

  const checkStartedAt = host.clock.now()
  let result: CheckResult
  try {
    result = await host.check.run(config.check, checkTimeoutMs)
    if (typeof result?.code !== "number") {
      throw new Error(`check runner returned a malformed result: ${JSON.stringify(result)}`)
    }
  } catch (err) {
    return onInternalError(host, sessionID, state, err)
  }

  // Measured around the runner only. `durationMs` spans the whole cycle and so
  // includes agent think time, subagent runs and human wait; a 420s cycle can
  // be a 1s check, and the two numbers answer different questions.
  const checkMs = [...state.checkMs, host.clock.now() - checkStartedAt]

  const outcome: RoundOutcome = result.code === 0 ? "accepted" : "verify-failed"
  const outcomes = [...state.outcomes, outcome]

  if (outcome === "accepted") {
    record(host, config.sensor, {
      sessionID,
      check: config.check,
      accepted: true,
      gateExhausted: false,
      interrupted: false,
      rounds: outcomes,
      checkMs,
      durationMs: elapsed(host, startedAt),
      marker: config.marker,
      roundsMax: config.rounds,
      ...cycleTags(state.touchedPaths, state.touchedTruncated, config.testPathPattern),
    })
    // A concurrent file-edited write (A1 persists far more often across a
    // cycle than before) or another handler can land here first; see
    // resetWithRetry's doc comment for why this is not a bare persist().
    resetWithRetry(host, sessionID, state)
    return config.marker ? { kind: "allow", marker: HYGIENE_MARKER } : ALLOW
  }

  // rounds is a budget of blocks: `rounds + 1` failing checks ends the cycle.
  if (state.round < config.rounds) {
    const round = state.round + 1
    const recorded = persist(
      host,
      sessionID,
      {
        ...state,
        gating: true,
        round,
        outcomes,
        checkMs,
        cycleStartedAt: startedAt,
        // A real verdict, pass or fail, proves the runner works.
        errorStreak: 0,
      },
      state.updatedAt,
    )

    // A block we cannot record is a block we cannot bound: the round would
    // never advance on disk, so every later stop would recompute this same
    // decision and the session could never get through. Allow instead.
    if (!recorded) {
      return {
        kind: "allow",
        notice:
          "kkamak: the check failed, but the gate could not record the attempt" +
          " and so cannot bound its retries — stop allowed; check that .km/ is writable",
      }
    }

    return { kind: "block", evidence: evidenceFrom(result), round, roundsMax: config.rounds }
  }

  const attempts = config.rounds + 1
  record(host, config.sensor, {
    sessionID,
    check: config.check,
    accepted: true,
    gateExhausted: true,
    interrupted: false,
    rounds: outcomes,
    checkMs,
    durationMs: elapsed(host, startedAt),
    // Marker must never fire on exhaustion, even with config.marker on —
    // see GateConfig.marker's doc comment.
    marker: false,
    roundsMax: config.rounds,
    ...cycleTags(state.touchedPaths, state.touchedTruncated, config.testPathPattern),
  })
  // See resetWithRetry's doc comment: same race as the accept-path reset above.
  resetWithRetry(host, sessionID, state)
  return {
    kind: "allow",
    notice:
      `kkamak: gate exhausted after ${attempts} failing check${attempts === 1 ? "" : "s"}` +
      ` — stop allowed; see ${config.sensor}`,
  }
}

/**
 * The check could not be run at all: a spawn failure or a broken runner, not a
 * failing test suite. No round is consumed, so a transient blip does not spend
 * the user's budget — but a check command that can never run must not gate a
 * session shut forever, so a persistent streak disarms it.
 */
function onInternalError(
  host: GateHost,
  sessionID: string,
  state: GateState,
  err: unknown,
): GateDecision {
  note(host, `check could not be run: ${describe(err)}`)
  const errorStreak = state.errorStreak + 1

  if (errorStreak >= ERROR_STREAK_LIMIT) {
    // Same "unconditional intent" shape as onNewUserPrompt's and
    // onStopRequested's resets: disarming is terminal for this session, so a
    // lost compare-and-swap must retry rather than leave the session at
    // whatever a concurrent writer left instead of disarmed. See
    // resetWithRetry's doc comment.
    resetWithRetry(host, sessionID, state, { errorStreak, disarmed: true })
    return {
      kind: "allow",
      notice:
        `kkamak: gate disarmed for this session after ${ERROR_STREAK_LIMIT} consecutive` +
        " internal errors — check the `check` command in gate.json",
    }
  }

  // Audited (docs/known-issues.md #8): unlike onNewUserPrompt's reset, this
  // persist's payload only increments errorStreak on top of whatever else
  // `state` already carries — it does not undo a concurrent writer's real
  // progress. Losing this compare-and-swap just means the increment is
  // dropped; the next internal error re-reads the current (correct, if not
  // this one's) errorStreak and increments from there, so disarm-after-3 is
  // delayed by at most one extra error, never skipped or corrupted the way
  // a lost reset would corrupt round accounting.
  return withPersist(host, sessionID, { ...state, errorStreak }, state.updatedAt, ALLOW)
}

// ── Effect helpers: each contains its own failure ────────────────────────────

/** Evidence is the check's own output. Prose framing belongs to the adapter. */
function evidenceFrom(result: CheckResult): string {
  const output = typeof result.output === "string" ? result.output.trim() : ""
  return output || `check exited with code ${result.code} and produced no output`
}

function elapsed(host: GateHost, startedAt: number): number {
  return host.clock.now() - startedAt
}

/**
 * Returns false when the state could not be written — either an outright
 * store failure, or a lost optimistic-concurrency race (`expectedUpdatedAt`
 * is the `updatedAt` of the `state` this handler loaded at the top of
 * `handleEvent`; see `StateStore.save`'s doc comment). Callers that issued a
 * decision already do not care; the block branch does, because a block it
 * cannot record is a block it cannot bound — and either failure reason
 * downgrades it the same way, deliberately: a session that lost a
 * compare-and-swap race must fail open exactly like one that hit ENOSPC.
 */
function persist(
  host: GateHost,
  sessionID: string,
  state: GateState,
  expectedUpdatedAt: number,
): boolean {
  try {
    host.state.save(sessionID, state, expectedUpdatedAt)
    return true
  } catch (err) {
    note(host, `could not persist state for ${sessionID}: ${describe(err)}`)
    return false
  }
}

function withPersist(
  host: GateHost,
  sessionID: string,
  state: GateState,
  expectedUpdatedAt: number,
  decision: GateDecision,
): GateDecision {
  persist(host, sessionID, state, expectedUpdatedAt)
  return decision
}

/** The sensor is an observation, never a precondition for a decision. */
function record(host: GateHost, sensorPath: string, args: SensorArgs): void {
  try {
    host.sensor.append(buildSensorLine(host.info, host.clock, args), sensorPath)
  } catch (err) {
    note(host, `could not append a sensor line: ${describe(err)}`)
  }
}

/** Even the logger is allowed to be broken. */
function note(host: GateHost, message: string): void {
  try {
    host.logger.log(`kkamak: ${message}`)
  } catch {
    // Nothing left to report with.
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
  return String(err)
}
