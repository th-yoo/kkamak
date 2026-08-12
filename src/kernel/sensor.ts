import type { Clock, HostInfo, RoundOutcome, SensorLine } from "./ports.ts"

/**
 * This kernel's own version, stamped into every sensor line's
 * `pluginVersion` field (D1, closed). Must match `package.json`'s
 * `version` — guarded by a test (test/packaging.test.ts) rather than read
 * from the file at runtime, so this stays a plain literal and the kernel
 * stays free of I/O.
 */
export const KERNEL_VERSION = "0.5.0"

/**
 * Product-identity stamp (A3), stamped into every line's `product` field.
 * `pluginVersion` alone cannot say which implementation wrote a line: a
 * differently-sourced build can ship the same plugin name and overlapping
 * versions into the same sensor file, and telling their lines apart has
 * previously required single-emitter isolation. Like `KERNEL_VERSION`, a
 * deliberate literal (pinned to `package.json`'s `name` by
 * test/packaging.test.ts) so the kernel stays I/O-free — and deliberately
 * NOT user-configurable: gate.json must not be able to spoof it.
 */
export const KERNEL_PRODUCT = "kkamak"

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
  "product",
] as const satisfies readonly (keyof SensorLine)[]

/**
 * Additive fields. Emitted only when the gate has something to say with them,
 * so every existing line and every existing consumer is unaffected.
 */
export const OPTIONAL_SENSOR_FIELDS = [
  "checkMs",
  "skippedStop",
  "forced",
  "roundsMax",
  "implOnly",
  "sameTurnCoEdit",
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
  /** See `SensorLine.roundsMax`: the config's rounds budget, 0 included. */
  roundsMax?: number
  /**
   * A1 cycle tagging. Tri-state, unlike skippedStop/forced above: the caller
   * (gate.ts) passes `undefined` for "unknown" and an explicit `true`/`false`
   * for "known" — both must reach the line, so this is checked for
   * `undefined`, not truthiness. See `SensorLine.implOnly`/`sameTurnCoEdit`.
   */
  implOnly?: boolean
  sameTurnCoEdit?: boolean
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
    // Also unconditional, and never caller-supplied: see KERNEL_PRODUCT.
    product: KERNEL_PRODUCT,
  }
  // Additive fields last, so the leading columns of the NDJSON stay where a
  // human's eye expects them.
  if (args.checkMs) line.checkMs = [...args.checkMs]
  if (args.skippedStop) line.skippedStop = true
  if (args.forced) line.forced = true
  // Not a truthiness check: rounds:0 (observe-only) is a real budget and
  // must stamp a literal 0 rather than vanish.
  if (args.roundsMax !== undefined) line.roundsMax = args.roundsMax
  // Not a truthiness check either: an explicit `false` is a real answer
  // ("known: not this shape") distinct from `undefined` ("unknown") — see
  // SensorArgs.implOnly's doc comment.
  if (args.implOnly !== undefined) line.implOnly = args.implOnly
  if (args.sameTurnCoEdit !== undefined) line.sameTurnCoEdit = args.sameTurnCoEdit
  return line
}
