import type { GateState, RoundOutcome } from "./ports.ts"

export const INITIAL_STATE: GateState = {
  v: 1,
  edited: false,
  gating: false,
  round: 0,
  outcomes: [],
  cycleStartedAt: 0,
  errorStreak: 0,
  disarmed: false,
  updatedAt: 0,
}

const OUTCOMES: readonly string[] = ["passed", "failed"] satisfies RoundOutcome[]

/**
 * Initial-equivalence ignores updatedAt, so a store can treat "saved initial
 * state" and "no file at all" as the same thing and delete rather than litter.
 */
export function isInitialState(s: GateState): boolean {
  return (
    !s.edited &&
    !s.gating &&
    s.round === 0 &&
    s.outcomes.length === 0 &&
    s.cycleStartedAt === 0 &&
    s.errorStreak === 0 &&
    !s.disarmed
  )
}

/**
 * Structural check against the v1 shape. Anything else — wrong types, missing
 * fields, a future version — is treated as corrupt by the caller, which reads
 * back fresh initial state instead.
 */
export function isGateState(x: unknown): x is GateState {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false
  const s = x as Record<string, unknown>
  return (
    s.v === 1 &&
    typeof s.edited === "boolean" &&
    typeof s.gating === "boolean" &&
    typeof s.round === "number" &&
    typeof s.cycleStartedAt === "number" &&
    typeof s.errorStreak === "number" &&
    typeof s.disarmed === "boolean" &&
    typeof s.updatedAt === "number" &&
    Array.isArray(s.outcomes) &&
    s.outcomes.every((o) => typeof o === "string" && OUTCOMES.includes(o))
  )
}
