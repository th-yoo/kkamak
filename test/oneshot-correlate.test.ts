import { describe, expect, test } from "bun:test"
import { correlate } from "../skills/oneshot/correlate.ts"
import type { Source1Line, Source2Line } from "../skills/oneshot/correlate.ts"

describe("correlate", () => {
  test("no data in, no windows out", () => {
    expect(correlate([], [])).toEqual({ windows: [], steeringConsumptionRate: undefined, abandonedRetryCount: 0 })
  })

  test("one window, one attempt, matches the command text's marker count", () => {
    const s1: Source1Line[] = [{ ts: 10, ok: true, output: "" }]
    const s2: Source2Line[] = [{ ts: 20, sessionID: "s", markerCount: 1 }]
    const r = correlate(s1, s2)
    expect(r.windows).toHaveLength(1)
    expect(r.windows[0]).toMatchObject({ markerCount: 1, attemptsObserved: 1, mismatch: false, steeringConsumed: false })
  })

  test("steering consumed: a false attempt followed by a true attempt in the same window", () => {
    const s1: Source1Line[] = [
      { ts: 10, ok: false, output: "" },
      { ts: 15, ok: true, output: "" },
    ]
    const s2: Source2Line[] = [{ ts: 20, sessionID: "s", markerCount: 2 }]
    const r = correlate(s1, s2)
    expect(r.windows[0]!.steeringConsumed).toBe(true)
    expect(r.steeringConsumptionRate).toBe(1)
  })

  test("mismatch: command text implies 2 attempts but only 1 real log line landed in the window", () => {
    const s1: Source1Line[] = [{ ts: 10, ok: false, output: "" }]
    const s2: Source2Line[] = [{ ts: 20, sessionID: "s", markerCount: 2 }]
    const r = correlate(s1, s2)
    expect(r.windows[0]!.mismatch).toBe(true)
  })

  test("abandoned retry: a window ending false, followed by another window", () => {
    const s1: Source1Line[] = [
      { ts: 10, ok: false, output: "" },
      { ts: 25, ok: false, output: "" },
    ]
    const s2: Source2Line[] = [
      { ts: 20, sessionID: "s", markerCount: 1 },
      { ts: 30, sessionID: "s", markerCount: 1 },
    ]
    const r = correlate(s1, s2)
    expect(r.abandonedRetryCount).toBe(1)
  })

  test("steeringConsumptionRate is undefined when no window ever hit ok:false", () => {
    const s1: Source1Line[] = [{ ts: 10, ok: true, output: "" }]
    const s2: Source2Line[] = [{ ts: 20, sessionID: "s", markerCount: 1 }]
    expect(correlate(s1, s2).steeringConsumptionRate).toBeUndefined()
  })
})
