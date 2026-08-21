// km-gauge shadow evaluator (pre-reg §2.3) — runs the derived check and
// builds the sensor gauge field. PURE relative to IO: the check runner is
// injected. The result NEVER feeds any gate decision (shadow-only).
import type { GaugeSensorField } from "./types.ts"
import type { GaugeFile } from "./files.ts"
import { unsafeReason } from "./guard.ts"

/** Floor-gate context for agreement scoring. ran=false → fast-path Stop. */
export interface FloorOutcome {
  ran: boolean
  accepted?: boolean
}

// 127 = command not found, 126 = not executable: the check itself is
// unrunnable (an M1 miss). 124 = our timeout convention: the check ran and
// failed — a real would-block, not a malformed command.
const UNRUNNABLE_CODES = new Set([126, 127])

export async function evaluateGauge(
  gauge: GaugeFile,
  floor: FloorOutcome,
  runCheck: (cmd: string) => Promise<{ code: number; out: string }>,
): Promise<GaugeSensorField> {
  const base: GaugeSensorField = {
    present: true,
    executable: false,
    derivationMs: gauge.derivationMs,
    confidence: gauge.confidence,
    model: gauge.model,
    n: gauge.n,
    // v2 passthrough (validate.ts's persisted, already-validated result) —
    // presence-conditional on gauge.class: a v1 GaugeFile carries none of
    // this. reason/horizon are separately null-stripped (GaugeFile allows
    // null for "not applicable to this class"; GaugeSensorField's contract
    // is optional-when-absent, never a live null).
    ...(gauge.class !== undefined
      ? {
          class: gauge.class,
          ...(gauge.reason != null ? { reason: gauge.reason } : {}),
          ...(gauge.horizon != null ? { horizon: gauge.horizon } : {}),
          ...(gauge.downgraded ? { downgraded: gauge.downgraded } : {}),
        }
      : {}),
    ...(gauge.strike !== undefined ? { strike: gauge.strike } : {}),
    // §6c transport provenance — passthrough when present, absent means a
    // pre-boundary CLI derivation (never fabricated here).
    ...(gauge.transport !== undefined ? { transport: gauge.transport } : {}),
  }

  if (!gauge.check) return base

  // The derived check is model-generated shell run with the user's
  // permissions: refuse anything that is not plainly read-only. A refusal
  // is an M1 miss, never a risk to the repo.
  const refused = unsafeReason(gauge.check)
  if (refused) return { ...base, refused }

  let code: number
  try {
    ;({ code } = await runCheck(gauge.check))
  } catch {
    return base
  }
  if (UNRUNNABLE_CODES.has(code)) return base

  const pass = code === 0
  return {
    ...base,
    executable: true,
    pass,
    wouldBlock: !pass,
    ...(floor.ran ? { agreesWithFloor: floor.accepted === pass } : {}),
  }
}
