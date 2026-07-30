// The gate lifecycle state machine.
//
// PURE: every effect arrives through a port on GateHost. Nothing here imports
// fs, child_process, os, or any harness.
//
// The governing rule is fail-open. A gate that wedges a session is worse than
// no gate at all, so every failure path — unreadable config, crashed check,
// unwritable state, a bug in this file — resolves to "allow".
import { parseGateConfig } from "./config.ts"
import { buildSensorLine, type SensorArgs } from "./sensor.ts"
import { INITIAL_STATE } from "./state.ts"
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
  const state = host.state.load(event.sessionId)

  if (state.disarmed) return ALLOW

  switch (event.kind) {
    case "file-edited":
      return onFileEdited(host, event.sessionId, state, config)
    case "new-user-prompt":
      return onNewUserPrompt(host, event.sessionId, state, config)
    case "stop-requested":
      return onStopRequested(host, event.sessionId, state, config)
  }
}

/** Arming. A repo with no usable gate.json accumulates no state at all. */
function onFileEdited(
  host: GateHost,
  sessionId: string,
  state: GateState,
  config: GateConfig | undefined,
): GateDecision {
  if (!config || state.edited) return ALLOW
  persist(host, sessionId, { ...state, edited: true })
  return ALLOW
}

/**
 * Human preemption. With no cycle open the prompt is ordinary and state passes
 * through untouched — that is what lets `edited` survive normal turns. With a
 * cycle open the human has overtaken the gate, so it stands down completely.
 */
function onNewUserPrompt(
  host: GateHost,
  sessionId: string,
  state: GateState,
  config: GateConfig | undefined,
): GateDecision {
  if (!state.gating) return ALLOW

  if (config) {
    record(host, config.sensor, {
      sessionId,
      check: config.check,
      accepted: true,
      gateExhausted: true,
      interrupted: true,
      rounds: state.outcomes,
      durationMs: elapsed(host, state.cycleStartedAt),
    })
  }

  persist(host, sessionId, { ...INITIAL_STATE })
  return ALLOW
}

async function onStopRequested(
  host: GateHost,
  sessionId: string,
  state: GateState,
  config: GateConfig | undefined,
): Promise<GateDecision> {
  // Nothing armed the gate: no check runs, so an ordinary session pays nothing.
  if (!state.edited && !state.gating) return ALLOW

  if (!config) {
    // The config vanished or broke mid-cycle. Abandon the cycle but keep
    // `edited` — the user's edit is unrelated to the config's disappearance, so
    // restoring gate.json should re-gate without needing a fresh edit.
    if (state.gating) persist(host, sessionId, { ...INITIAL_STATE, edited: state.edited })
    return ALLOW
  }

  const startedAt = state.gating ? state.cycleStartedAt : host.clock.now()

  let result: CheckResult
  try {
    result = await host.check.run(config.check, config.checkTimeoutMs)
    if (typeof result?.code !== "number") {
      throw new Error(`check runner returned a malformed result: ${JSON.stringify(result)}`)
    }
  } catch (err) {
    return onInternalError(host, sessionId, state, err)
  }

  const outcome: RoundOutcome = result.code === 0 ? "passed" : "failed"
  const outcomes = [...state.outcomes, outcome]

  if (outcome === "passed") {
    record(host, config.sensor, {
      sessionId,
      check: config.check,
      accepted: true,
      gateExhausted: false,
      interrupted: false,
      rounds: outcomes,
      durationMs: elapsed(host, startedAt),
    })
    persist(host, sessionId, { ...INITIAL_STATE })
    return ALLOW
  }

  // rounds is a budget of blocks: `rounds + 1` failing checks ends the cycle.
  if (state.round < config.rounds) {
    const round = state.round + 1
    persist(host, sessionId, {
      ...state,
      gating: true,
      round,
      outcomes,
      cycleStartedAt: startedAt,
      // A real verdict, pass or fail, proves the runner works.
      errorStreak: 0,
    })
    return { kind: "block", evidence: evidenceFrom(result), round, roundsMax: config.rounds }
  }

  const attempts = config.rounds + 1
  record(host, config.sensor, {
    sessionId,
    check: config.check,
    accepted: true,
    gateExhausted: true,
    interrupted: false,
    rounds: outcomes,
    durationMs: elapsed(host, startedAt),
  })
  persist(host, sessionId, { ...INITIAL_STATE })
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
  sessionId: string,
  state: GateState,
  err: unknown,
): GateDecision {
  note(host, `check could not be run: ${describe(err)}`)
  const errorStreak = state.errorStreak + 1

  if (errorStreak >= ERROR_STREAK_LIMIT) {
    persist(host, sessionId, { ...INITIAL_STATE, errorStreak, disarmed: true })
    return {
      kind: "allow",
      notice:
        `kkamak: gate disarmed for this session after ${ERROR_STREAK_LIMIT} consecutive` +
        " internal errors — check the `check` command in gate.json",
    }
  }

  return withPersist(host, sessionId, { ...state, errorStreak }, ALLOW)
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
 * The decision is already computed by the time we persist, so a failed write
 * must not retroactively change it. Losing state fails open on the next event:
 * a session that forgets it was gating simply stops being gated.
 */
function persist(host: GateHost, sessionId: string, state: GateState): void {
  try {
    host.state.save(sessionId, state)
  } catch (err) {
    note(host, `could not persist state for ${sessionId}: ${describe(err)}`)
  }
}

function withPersist(
  host: GateHost,
  sessionId: string,
  state: GateState,
  decision: GateDecision,
): GateDecision {
  persist(host, sessionId, state)
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
