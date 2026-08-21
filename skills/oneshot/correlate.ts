// Joins the two dogfood logs by timestamp ordering only — run-once.ts (a
// plain subprocess, not a hook) has no access to Claude Code's session_id,
// so Source 1 cannot be scoped by session. Concurrent oneshot usage across
// sessions on the same machine will misattribute. Accepted limitation for
// measurement tooling, not shipped-gate logic — see the implementation
// plan's Global Constraints.

export interface Source1Line {
  ts: number
  ok: boolean
  output: string
}

export interface Source2Line {
  ts: number
  sessionID: string
  markerCount: number
}

export interface CorrelatedWindow {
  windowEndTs: number
  markerCount: number
  attemptsObserved: number
  mismatch: boolean
  steeringConsumed: boolean
  /** Last observed attempt in this window was ok:false (or no attempts at all). */
  endedInFailure: boolean
  /** At least one attempt in this window was ok:false, regardless of how it ended. */
  hadAnyFailure: boolean
}

export interface CorrelationReport {
  windows: CorrelatedWindow[]
  steeringConsumptionRate: number | undefined
  abandonedRetryCount: number
}

export function correlate(source1: Source1Line[], source2: Source2Line[]): CorrelationReport {
  const sortedS2 = [...source2].sort((a, b) => a.ts - b.ts)
  const windows: CorrelatedWindow[] = []
  let windowStart = -Infinity

  for (const call of sortedS2) {
    const attempts = source1.filter((l) => l.ts > windowStart && l.ts <= call.ts).sort((a, b) => a.ts - b.ts)
    const lastOk = attempts.length > 0 ? attempts[attempts.length - 1]!.ok : undefined
    const hadAnyFailure = attempts.some((l) => !l.ok)

    windows.push({
      windowEndTs: call.ts,
      markerCount: call.markerCount,
      attemptsObserved: attempts.length,
      mismatch: attempts.length < call.markerCount,
      steeringConsumed: hadAnyFailure && lastOk === true,
      endedInFailure: lastOk !== true,
      hadAnyFailure,
    })
    windowStart = call.ts
  }

  // steering-consumption rate: of windows that hit ok:false at least once
  // (regardless of how they ended), how many resolved ok:true in that same
  // window.
  const windowsWithAnyFailure = windows.filter((w) => w.hadAnyFailure)

  // abandoned retry: a window that ENDED in failure, followed by another
  // window at all (a later Bash call that also invoked run-once.ts).
  let abandonedRetryCount = 0
  for (let i = 0; i < windows.length - 1; i++) {
    if (windows[i]!.endedInFailure) abandonedRetryCount++
  }

  return {
    windows,
    steeringConsumptionRate:
      windowsWithAnyFailure.length > 0
        ? windowsWithAnyFailure.filter((w) => w.steeringConsumed).length / windowsWithAnyFailure.length
        : undefined,
    abandonedRetryCount,
  }
}
