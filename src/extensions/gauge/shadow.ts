// km-gauge shadow-at-Stop orchestration (pre-reg §2.3) — picks the pending
// derivation, runs the shadow eval, attaches the gauge field to the outgoing
// sensor line (or fabricates a gauge-only line on fast-path Stops), and
// consumes the pending file into the .done.json audit trail.
//
// NOTE (Task 1, fix-them-serialized-teacup plan, 2026-07-30; updated Phase 3
// Task 4, 5th pre-data amendment): `rounds: []` is no longer a UNIQUE
// gauge-only marker — prompt.ts's skippedStop lines and prompt-check lines
// (`promptCheck: true`) also carry `rounds: []`. There are now THREE
// `rounds: []` classes (gauge-only / skipped-stop / prompt-check),
// disambiguated by `skippedStop` then `promptCheck`, both checked before the
// empty-rounds gauge-only branch (classifyCycle, score.ts). This module only
// ever fabricates gauge-only lines (never skippedStop, never promptCheck),
// so its own behavior is unchanged; the comments below are updated for
// anyone reading `rounds: []` as sufficient on its own.
//
// SHADOW ONLY: the return value feeds appendSensor and nothing else — the
// Stop DECISION is computed before this runs and is never touched.
//
// Task 3 (v2 extractor, 2026-07-29): two-strike deferred confirmation for a
// class-C multi-turn pending — policy lives here; evaluate.ts stays pure.
import type { GateConfig } from "../../kernel/ports.ts"
import type { GaugeSensorField, GaugedSensorLine } from "./types.ts"
import { evaluateGauge } from "./evaluate.ts"
import { consumePending, gaugeDir, pickPending, writeGaugeFile, type GaugeFile } from "./files.ts"

interface ShadowDeps {
  now(): number
  hostname(): string
  log(msg: string): void
}

/**
 * Pure two-strike policy (pre-reg §2.3 / v2 extractor design, review
 * M6/M6'). Only a class-C multi-turn pending is subject to deferral —
 * single-turn C, every other class (A1/A2/B/D), and a v1-legacy pending (no
 * `class` at all) are TODAY'S BEHAVIOR: `field` passes through unchanged and
 * the pending is always consumed (`keepPending: false`).
 *
 * Strike advancement REQUIRES a real floor cycle (`floorRan`) [review M6].
 * In production, shadowEvaluateAtStop never calls this (or evaluateGauge)
 * for an open multi-turn-C pending when `floorRan` is false — it skips
 * straight to a passthrough-only field (see M6' below). The `floorRan`
 * branch here exists so that rule is directly unit-testable in isolation.
 */
export function applyTwoStrike(
  pending: GaugeFile,
  gauge: GaugeSensorField,
  floorRan: boolean,
): { field: GaugeSensorField; keepPending: boolean } {
  const isMultiTurnC = pending.class === "C" && pending.horizon === "multi-turn"
  if (!isMultiTurnC || !floorRan) return { field: gauge, keepPending: false }

  // Refused / unrunnable (126/127) / IO-failure (runCheck threw): the check
  // never produced a real pass/fail, so deferral is pointless — consume
  // immediately as an M1v2 miss. Strike state is left as whatever `gauge`
  // already carries via evaluate.ts's presence-conditional passthrough.
  if (gauge.executable !== true) return { field: gauge, keepPending: false }

  // Pass at either strike: consume. strike:1 (if any) rides along on the
  // recovery line via that same passthrough — free data, nothing to add.
  if (gauge.pass) return { field: gauge, keepPending: false }

  // Fail with a real floor cycle.
  if (pending.strike === 1) {
    // Second consecutive fail: the deferred verdict lands.
    return { field: { ...gauge, wouldBlock: true, strike: 2 }, keepPending: false }
  }
  // First fail: damp wouldBlock, defer the verdict, keep the pending (same n).
  return { field: { ...gauge, wouldBlock: false, strike: 1 }, keepPending: true }
}

/**
 * evaluate.ts's `base` presence-conditional passthrough, built WITHOUT ever
 * running the derived check [review M6'] — the check-execution risk (up to
 * the gauge check budget, inside the Stop hook, on every planning turn,
 * unbounded) is exactly what this exists to avoid. Deliberately NOT routed
 * through evaluateGauge (whose only no-execution path is `!gauge.check`,
 * never true for a live class-C pending): kept as a small manually-mirrored
 * duplicate rather than reaching into evaluate.ts internals it doesn't
 * export.
 */
function passthroughOnly(pending: GaugeFile): GaugeSensorField {
  return {
    present: true,
    executable: false,
    derivationMs: pending.derivationMs,
    confidence: pending.confidence,
    model: pending.model,
    n: pending.n,
    ...(pending.class !== undefined
      ? {
          class: pending.class,
          ...(pending.reason != null ? { reason: pending.reason } : {}),
          ...(pending.horizon != null ? { horizon: pending.horizon } : {}),
          ...(pending.downgraded ? { downgraded: pending.downgraded } : {}),
        }
      : {}),
    ...(pending.strike !== undefined ? { strike: pending.strike } : {}),
  }
}

function fabricateLine(
  deps: ShadowDeps,
  sessionID: string,
  cfg: GateConfig,
  gauge: GaugeSensorField,
): GaugedSensorLine {
  return {
    ts: deps.now(),
    sessionID,
    check: cfg.check,
    accepted: true,
    gateExhausted: false,
    rounds: [],
    interrupted: false,
    marker: false,
    durationMs: 0,
    host: deps.hostname(),
    app: "claude-code",
    gauge,
  }
}

/**
 * sensor = the floor gate's outgoing line for this Stop (undefined on the
 * no-edit fast path). Returns the line to append: the input line (with a
 * gauge field when one was evaluated), a fabricated gauge-only line
 * (rounds: [] is A marker — real gate lines always carry ≥1 outcome — but
 * no longer THE marker: prompt.ts's skippedStop lines and prompt-check lines
 * (`promptCheck: true`) share the same `rounds: []` envelope for unrelated
 * reasons, giving three `rounds: []` classes in total; `skippedStop` then
 * `promptCheck` are what actually distinguish them, see score.ts's
 * classifyCycle), or undefined when there is nothing to log.
 */
export async function shadowEvaluateAtStop(
  cwd: string,
  sessionID: string,
  cfg: GateConfig,
  sensor: GaugedSensorLine | undefined,
  runCheck: (cmd: string) => Promise<{ code: number; out: string }>,
  deps: ShadowDeps,
): Promise<GaugedSensorLine | undefined> {
  try {
    // An interrupt line means the user preempted the cycle — the pending
    // gauge belongs to the NEW prompt's work, keep it for the next cycle.
    if (sensor?.interrupted) return sensor

    const dir = gaugeDir(cwd)
    const pending = pickPending(dir, sessionID)
    if (!pending) return sensor

    const floorRan = sensor !== undefined
    const isOpenMultiTurnC = pending.class === "C" && pending.horizon === "multi-turn"

    // M6' fix: a gauge-only Stop (no floor cycle) never runs the derived
    // check for an open multi-turn-C pending. Skip evaluateGauge entirely;
    // the pending stays byte-untouched (design note: a pass can then never
    // be observed at gauge-only Stops for multi-turn — intended). floorRan
    // is exactly `sensor !== undefined`, so `!floorRan` here means sensor
    // IS undefined — always the fabricated-line path, never the attach path.
    if (isOpenMultiTurnC && !floorRan) {
      return fabricateLine(deps, sessionID, cfg, passthroughOnly(pending))
    }

    // Exhausted lines carry accepted:true for schema parity; a real floor
    // accept is accepted && !gateExhausted.
    const floor = floorRan
      ? { ran: true, accepted: sensor!.accepted && !sensor!.gateExhausted }
      : { ran: false }

    const gauge = await evaluateGauge(pending, floor, runCheck)
    const { field, keepPending } = applyTwoStrike(pending, gauge, floorRan)

    if (keepPending) {
      writeGaugeFile(dir, { ...pending, strike: 1 })
    } else {
      consumePending(dir, sessionID, pending.n, field as unknown as Record<string, unknown>)
    }

    if (sensor) return { ...sensor, gauge: field }
    return fabricateLine(deps, sessionID, cfg, field)
  } catch (e) {
    try {
      deps.log(`km-gauge: shadow eval failed (swallowed): ${String(e)}`)
    } catch {
      // nothing more to do
    }
    return sensor
  }
}
