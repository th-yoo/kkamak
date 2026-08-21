// Joins the two dogfood logs by timestamp ordering only — run-once.ts (a
// plain subprocess, not a hook) has no access to Claude Code's session_id,
// so Source 1 cannot be scoped by session. Concurrent oneshot usage across
// sessions on the same machine will misattribute. Accepted limitation for
// measurement tooling, not shipped-gate logic — see the implementation
// plan's Global Constraints.
//
// Precondition: both logs must be read from the same root. run-once.ts
// writes Source 1 relative to its own process.cwd(); dogfood-hook-cli.ts
// writes Source 2 relative to the hook payload's cwd (the Claude Code
// session's working directory). These are normally the same directory,
// but a Bash call that `cd`s elsewhere before invoking run-once.ts splits
// the two logs into different .km/ directories, silently breaking this
// join (known-issues.md #12.3) — not checked at runtime here.

export interface Source1Line {
  ts: number
  ok: boolean
  /** Present only on a full log entry — see run-once.ts's shouldLogFull. */
  output?: string
  /** Present only on a light log entry (a non-final failing attempt). */
  outputLength?: number
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
  /**
   * TEMPORAL co-occurrence only: a false attempt followed by a true one in
   * the same window. This does NOT establish that the model read and acted
   * on the failure's `output` — it could have retried for an unrelated
   * reason and happened to pass regardless. Never read this as proven
   * causal steering use (known-issues.md #12.1; the meta-harness lab
   * overclaimed exactly this once and had to retract it).
   */
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

  const windowsWithAnyFailure = windows.filter((w) => w.hadAnyFailure)

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
