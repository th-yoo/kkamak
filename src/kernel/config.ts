import type { GateConfig } from "./ports.ts"

export const DEFAULT_ROUNDS = 2
export const DEFAULT_SENSOR_PATH = ".km/gate-outcomes.ndjson"
export const DEFAULT_CHECK_TIMEOUT_MS = 300_000

/** A non-negative integer, and not Infinity/NaN. */
function isCount(x: unknown): x is number {
  return typeof x === "number" && Number.isSafeInteger(x) && x >= 0
}

/**
 * Parse raw gate.json text. Returns undefined when there is no usable check
 * command, which no-ops the gate — never throws, whatever the input.
 *
 * A malformed *numeric* field falls back to its default rather than rejecting
 * the whole config: `check` is the part that carries meaning, and refusing to
 * gate over a typo'd timeout would be a worse failure than using 300s.
 */
export function parseGateConfig(raw: string | undefined): GateConfig | undefined {
  if (!raw) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const j = parsed as Record<string, unknown>

  if (typeof j.check !== "string") return undefined
  const check = j.check.trim()
  if (!check) return undefined

  return {
    check,
    rounds: isCount(j.rounds) ? j.rounds : DEFAULT_ROUNDS,
    sensor: typeof j.sensor === "string" && j.sensor ? j.sensor : DEFAULT_SENSOR_PATH,
    checkTimeoutMs: isCount(j.checkTimeoutMs) && j.checkTimeoutMs > 0
      ? j.checkTimeoutMs
      : DEFAULT_CHECK_TIMEOUT_MS,
  }
}
