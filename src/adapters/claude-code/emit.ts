import { composeBlockMessage } from "../shared/framing.ts"
import type { GateDecision } from "../../kernel/ports.ts"

export interface EmitPlan {
  stdout?: Record<string, unknown>
  stderr?: string
  exitCode: 0 | 2
}

/**
 * Blocks use the JSON form rather than exit-2-with-stderr: exit 2 is
 * indistinguishable from the hook itself crashing, and a crashing gate should
 * never look like an intentional refusal.
 */
export function planEmit(decision: GateDecision): EmitPlan {
  if (decision.kind === "block") {
    return {
      stdout: { decision: "block", reason: composeBlockMessage(decision) },
      exitCode: 0,
    }
  }
  if (decision.notice) {
    return { stdout: { systemMessage: decision.notice }, exitCode: 0 }
  }
  return { exitCode: 0 }
}
