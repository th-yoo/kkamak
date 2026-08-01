import type { Clock, HostInfo, RoundOutcome, SensorLine } from "./ports.ts"

/**
 * This kernel's own version, stamped into every sensor line's
 * `pluginVersion` field (D1, closed). Must match `package.json`'s
 * `version` — guarded by a test (test/packaging.test.ts) rather than read
 * from the file at runtime, so this stays a plain literal and the kernel
 * stays free of I/O.
 */
export const KERNEL_VERSION = "0.4.0"

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
  "pluginVersion",
] as const satisfies readonly (keyof SensorLine)[]

/**
 * Additive fields. Emitted only when the gate has something to say with them,
 * so every existing line and every existing consumer is unaffected.
 */
export const OPTIONAL_SENSOR_FIELDS = [
  "checkMs",
  "skippedStop",
  "forced",
] as const satisfies readonly (keyof SensorLine)[]

export interface SensorArgs {
  sessionID: string
  check: string
  accepted: boolean
  gateExhausted: boolean
  interrupted: boolean
  rounds: RoundOutcome[]
  durationMs: number
  /** See `SensorLine.marker`'s doc comment: the caller (gate.ts) computes this. */
  marker: boolean
  checkMs?: number[]
  skippedStop?: boolean
  /** See `SensorLine.forced`'s doc comment: no current caller sets this. */
  forced?: boolean
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
    marker: args.marker,
    // This kernel always knows its own version, unlike the frozen contract's
    // general "producer may not know" case — so unlike checkMs/skippedStop/
    // forced below, this is never conditional. See SensorLine.pluginVersion.
    pluginVersion: KERNEL_VERSION,
  }
  // Additive fields last, so the leading columns of the NDJSON stay where a
  // human's eye expects them.
  if (args.checkMs) line.checkMs = [...args.checkMs]
  if (args.skippedStop) line.skippedStop = true
  if (args.forced) line.forced = true
  return line
}
