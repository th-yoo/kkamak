import type { Clock, HostInfo, RoundOutcome, SensorLine } from "./ports.ts"

/**
 * The sensor schema, declared as data so a test can assert the built line
 * carries exactly these keys. Adding a field to SensorLine without adding it
 * here (or vice versa) fails the suite rather than silently producing lines
 * that later analysis cannot pool.
 */
export const SENSOR_FIELDS = [
  "ts",
  "sessionId",
  "check",
  "accepted",
  "gateExhausted",
  "interrupted",
  "rounds",
  "durationMs",
  "host",
  "app",
] as const satisfies readonly (keyof SensorLine)[]

export interface SensorArgs {
  sessionId: string
  check: string
  accepted: boolean
  gateExhausted: boolean
  interrupted: boolean
  rounds: RoundOutcome[]
  durationMs: number
}

/**
 * Build one sensor line. `app` and `host` come from the host info, never from a
 * kernel constant — that is what keeps this kernel harness-abstract.
 */
export function buildSensorLine(info: HostInfo, clock: Clock, args: SensorArgs): SensorLine {
  return {
    ts: clock.now(),
    sessionId: args.sessionId,
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
  }
}
