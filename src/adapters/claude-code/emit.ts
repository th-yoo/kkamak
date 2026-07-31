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

  const stdout: Record<string, unknown> = {}
  if (decision.notice) stdout.systemMessage = decision.notice
  // Same delivery channel the reference implementation uses for its
  // allow-with-marker decision (meta-harness cc-gate-plugin src/output.ts):
  // hookSpecificOutput.additionalContext, a Stop-hook-specific field that
  // feeds text into the model's own context — distinct from systemMessage,
  // which only surfaces as a status line.
  if (decision.marker) {
    stdout.hookSpecificOutput = { hookEventName: "Stop", additionalContext: decision.marker }
  }
  if (Object.keys(stdout).length === 0) return { exitCode: 0 }
  return { stdout, exitCode: 0 }
}
