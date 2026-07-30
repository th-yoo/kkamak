import type { Clock, HostInfo, RoundOutcome, SensorLine } from "./ports.ts"

/**
 * The sensor schema, declared as data so a test can assert the built line
 * carries exactly these keys. Adding a field to SensorLine without adding it
 * here (or vice versa) fails the suite rather than silently producing lines
 * that later analysis cannot pool.
 */
export const SENSOR_FIELDS = [
  "ts",
  "sessionID",
  "check",
  "accepted",
  "gateExhausted",
  "interrupted",
  "rounds",
  "durationMs",
  "host",
  "app",
  "marker",
] as const satisfies readonly (keyof SensorLine)[]

/**
 * Additive fields. Emitted only when the gate has something to say with them,
 * so every existing line and every existing consumer is unaffected.
 */
export const OPTIONAL_SENSOR_FIELDS = [
  "checkMs",
  "skippedStop",
] as const satisfies readonly (keyof SensorLine)[]

export interface SensorArgs {
  sessionID: string
  check: string
  accepted: boolean
  gateExhausted: boolean
  interrupted: boolean
  rounds: RoundOutcome[]
  durationMs: number
  checkMs?: number[]
  skippedStop?: boolean
}

/**
 * Build one sensor line. `app` and `host` come from the host info, never from a
 * kernel constant — that is what keeps this kernel harness-abstract.
 */
export function buildSensorLine(info: HostInfo, clock: Clock, args: SensorArgs): SensorLine {
  const line: SensorLine = {
    ts: clock.now(),
    sessionID: args.sessionID,
    check: args.check,
    accepted: args.accepted,
    gateExhausted: args.gateExhausted,
    interrupted: args.interrupted,
    // Copied: the caller passes live state, which keeps mutating after this
    // line is built.
    rounds: [...args.rounds],
    durationMs: args.durationMs,
    host: info.host,
    app: info.app,
    // Required by the frozen consumer contract, but this kernel has no
    // marker/session-carryover mechanism at all (no SensorArgs field feeds
    // it) — always stamp the documented default-OFF value. DEFERRED: real
    // marker tracking, and (D1, phase-0 scope) the pluginVersion/forced
    // optionals, to a later milestone. See SensorLine.marker's doc comment.
    marker: false,
  }
  // Additive fields last, so the leading columns of the NDJSON stay where a
  // human's eye expects them.
  if (args.checkMs) line.checkMs = [...args.checkMs]
  if (args.skippedStop) line.skippedStop = true
  return line
}
