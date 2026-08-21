// Gauge's own vocabulary — the divergence map's NEW rows
// (meta-harness docs/superpowers/specs/2026-08-21-core-divergence-map.md).
// No kkamak core host exists for any of these; copied verbatim from
// cc-gate-plugin/src/types.ts, additive per-file as the ported gauge files
// demand them — never speculative.

/** km-gauge v2 classification (pre-reg §2.1/§2.2 extension, 2026-07-29 design). */
export type GaugePromptClass = "A1" | "A2" | "B" | "C" | "D"

/** Class-C only: horizon over which the derived check should be trusted. */
export type GaugeHorizon = "single-turn" | "multi-turn"

/** §6d: a third transport joins the §6c pair. §6e: a fourth, the warm
 * daemon lane. Order is incumbent-first so existing readings that sort by
 * this array do not reshuffle. */
export const GAUGE_TRANSPORTS = ["cli", "sdk", "agent-sdk", "agent-sdk-daemon"] as const
export type GaugeTransport = (typeof GAUGE_TRANSPORTS)[number]

/** Why the instrument produced nothing. Present iff `present` is false
 * (pre-reg §6b amendment, 2026-08-01). `no-record` is deliberately
 * collective — armed but nothing to attach, covering not-task-shaped,
 * daily-cap, a swallowed spawn error, and a still-pending derivation. */
export type GaugeOffReason = "disabled" | "env-off" | "no-record"

/** km-gauge shadow-eval record (pre-reg §2.3) — attached to sensor lines,
 * NEVER consulted by any gate decision. absent/present:false = no gauge. */
export interface GaugeSensorField {
  present: boolean
  /** Set ONLY when present is false. Distinct from `reason`, which carries
   * the CLASSIFICATION reason — overloading one key with instrument state
   * would let a consumer grouping by `reason` mix the two populations. */
  offReason?: GaugeOffReason
  executable?: boolean
  /** Safety-guard verdict when the derived check was refused unrun. */
  refused?: string
  pass?: boolean
  wouldBlock?: boolean
  agreesWithFloor?: boolean
  derivationMs?: number
  confidence?: number
  model?: string
  n?: number
  /** v2 classification passthrough (validate.ts) — presence-conditional. */
  class?: GaugePromptClass
  reason?: string
  horizon?: GaugeHorizon
  /** Recorded when validate.ts discards a model-invented/misplaced check. */
  downgraded?: {
    fromClass: GaugePromptClass
    fromCheck: string | null
    rule: string
    token?: string
  }
  /** Two-strike policy state (shadow.ts) for a multi-turn class-C pending. */
  strike?: 1 | 2
  /** §6c derive-transport provenance passthrough — the Split rule (per-
   * transport reporting) is read off the sensor stream, so the field must
   * reach the line, not just the gauge file store. Absent = pre-boundary
   * CLI derivation; never fabricated. */
  transport?: GaugeTransport
}

/** Refiner's parsed derivation — becomes the persisted gauge file payload
 * once run through validate.ts.
 *
 * Origin: cc-gate-plugin/src/gauge/refiner.ts:14. refiner.ts itself stays
 * lab-side (its runtime is consumed by transport.ts/cls-ab/corpus-replay,
 * all lab-only) — validate.ts's only dependency on it was `import type`,
 * so this interface is shared vocabulary copied verbatim, not a port of
 * refiner.ts's behavior. Same treatment as send-prompt.ts's type-only
 * WarmIsolation import — see the K2 ruling. */
export interface GaugeDerivation {
  goalSummary: string
  class: GaugePromptClass
  reason: string | null
  criteria: string[]
  check: string | null
  horizon: GaugeHorizon | null
  confidence: number
}

/** nudge.ts's config dependency. The lab types this as
 * `Pick<GateConfig, "channelNudge">`, but kkamak's kernel GateConfig
 * (kernel/ports.ts) deliberately has no channelNudge field — the
 * divergence map's own ruling: "the extension's own config layer supplies
 * these, not kkamak core GateConfig." A LATER task (K4, config wiring)
 * parses this from gate.json; K2 only needs the shape nudge.ts's pure
 * decideNudge function is called with. */
export interface GaugeChannelNudgeConfig {
  channelNudge?: boolean
}
