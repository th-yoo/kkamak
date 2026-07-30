import type { GateDecision } from "../../kernel/ports.ts"

/** Hook payloads are size-limited, and a giant paste buries the useful part. */
export const MAX_EVIDENCE_BYTES = 16_000

type BlockDecision = Extract<GateDecision, { kind: "block" }>

/** Keeps the tail: a test runner's summary is at the end of its output. */
export function truncateEvidence(evidence: string): string {
  if (evidence.length <= MAX_EVIDENCE_BYTES) return evidence
  return `…output truncated, showing the last ${MAX_EVIDENCE_BYTES} characters…\n${evidence.slice(-MAX_EVIDENCE_BYTES)}`
}

export function composeBlockMessage(decision: BlockDecision): string {
  return [
    "not done: the repository's completion check failed.",
    "",
    truncateEvidence(decision.evidence),
    "",
    `This check is configured by the repository in gate.json and the gate runs it automatically when you finish, so do not run it yourself. Fix the failures above and end your turn. (Attempt ${decision.round} of ${decision.roundsMax}; after that the gate gives up and lets the turn through.)`,
  ].join("\n")
}
