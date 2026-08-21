// cc-gate-plugin/src/gauge/channel.ts
// km-gauge verification-channel ladder (pre-reg spec 2026-08-03-gauge-
// verification-channel-ladder-preregistration.md §1-§3). Pure module:
// text builders + shape parsers + deterministic mapping. No IO here —
// same discipline as refiner.ts.
import type { GaugePromptClass } from "./types.ts"

export type VerificationChannel = "C1" | "C2" | "C3" | "C4"
export type ChannelOrExempt = VerificationChannel | "exempt"

export const CHANNEL_LITERALS: readonly string[] = ["C1", "C2", "C3", "C4"]

/** Spec §2: A1/B/C map deterministically; A2/D return null = the model
 * refinement question (buildChannelPrompt) decides C2/C3/C4. */
export function channelForClass(cls: GaugePromptClass): ChannelOrExempt | null {
  switch (cls) {
    case "A1":
      return "exempt"
    case "B":
    case "C":
      return "C1"
    case "A2":
    case "D":
      return null
  }
}

/** Refinement channels: only A2/D records are refined, and refinement can
 * never promote to C1 (extraction already ruled that out upstream). */
export interface ChannelRefinement {
  channel: "C2" | "C3" | "C4"
  reason: string | null
}

const REFINEMENT_LITERALS: readonly string[] = ["C2", "C3", "C4"]

/** Spec §3. Deliberately takes ONLY the prompt text (blind isolation by
 * construction — buildLabelPrompt precedent). Never names gauge classes. */
export function buildChannelPrompt(userPrompt: string): string {
  return [
    "You are given a coding-agent task prompt. Answer one question about it:",
    "does the prompt's own text state a falsifiable completion criterion — a",
    "condition someone could check and get a yes/no answer — and if so, who is",
    "the cheapest competent judge of it?",
    "",
    '- "C2": a criterion is stated, and an LLM given only this prompt plus the',
    "  final work product could decide pass/fail non-vacuously.",
    '- "C3": a criterion is stated, but deciding it needs information or',
    "  authority no transcript can carry (a human must judge). The criterion",
    "  itself must still be stated — \"the user will know it when they see it\"",
    '  is NOT "C3".',
    '- "C4": no falsifiable criterion is stated at all — open-ended adjectives,',
    "  unstated scope, no yes/no condition derivable from the prompt text alone.",
    "",
    "Clarifications:",
    "- Judge only the prompt text as written. A criterion you infer from",
    "  context, convention, or from what a typical project would want does not",
    "  count.",
    "- Do not judge difficulty, importance, or how long the task would take.",
    "",
    "Output ONLY a JSON object, no prose, no markdown fences:",
    '{"channel": "C2"|"C3"|"C4", "reason": string|null}',
    "",
    "Task prompt:",
    "<<<PROMPT",
    userPrompt,
    "PROMPT",
  ].join("\n")
}

/** Shape-only parse (parseLabelOutput discipline: first "{" to last "}",
 * undefined on any malformed shape — never fabricate). */
export function parseChannelOutput(text: string): ChannelRefinement | undefined {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  let j: unknown
  try {
    j = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return undefined
  const r = j as Record<string, unknown>
  if (typeof r.channel !== "string" || !REFINEMENT_LITERALS.includes(r.channel)) return undefined
  const reason = typeof r.reason === "string" && r.reason.trim() ? r.reason.trim() : null
  return { channel: r.channel as ChannelRefinement["channel"], reason }
}
