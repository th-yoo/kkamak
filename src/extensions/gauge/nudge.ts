// cc-gate-plugin/src/gauge/nudge.ts — pure pieces of the C4 nudge (spec §5:
// soft-only, config-flagged, fail-open). The real model call + emission live
// in hook-cli's UserPromptSubmit branch; nothing here touches IO directly —
// decideNudge takes the transport as an injected dep so bun test drives the
// entire armed path with stubs and never makes a real model call.
import { buildChannelPrompt, parseChannelOutput } from "./channel.ts"
import type { GaugeChannelNudgeConfig } from "./types.ts"

/** Spec §5 prefilter constants — FROZEN at first armed firing. */
const MIN_PROMPT_CHARS = 80

export function shouldConsiderPrompt(prompt: string): boolean {
  return prompt.length >= MIN_PROMPT_CHARS && !prompt.startsWith("/")
}

/** additionalContext text (spec §6 ruling 1 carries final wording; this is
 * the PROPOSED draft). Soft guidance to the model, invisible-to-user by
 * hook semantics; asks for a measurable exit, never refuses work. */
export function buildNudgeContext(channel: "C4"): string {
  return [
    "kkamak gauge: this prompt states no verifiable completion criterion",
    "(no programmatic check, no LLM-judgeable condition, no human-decidable",
    "condition in the prompt's own words). Before starting, restate the goal",
    "with a measurable, verifiable exit — e.g. name the artifact and the",
    "observable property that will hold when done — and confirm it with the",
    "user if the restatement changes scope.",
  ].join(" ")
}

/** Spec §5: prompt-time classification budget. The race resolves undefined
 * at the budget — timeout = no nudge, never a block (fail-open). */
export const NUDGE_TIMEOUT_MS = 8_000

/** Injected transport: takes the fully built channel prompt text, returns
 * the model's raw text (or undefined on any transport-level failure).
 * hook-cli supplies the real SDK call; tests supply stubs. */
export type ChannelTransport = (messageText: string) => Promise<string | undefined>

export interface NudgeDeps {
  transport: ChannelTransport
  /** Test seam; production omits it and gets NUDGE_TIMEOUT_MS. */
  timeoutMs?: number
}

/** The whole armed path as one injectable function: returns the
 * additionalContext text IFF the flag is armed, the prefilter passes, the
 * transport answers within the budget, and the parsed channel is "C4".
 * Everything else — flag off/absent, prefilter miss, C2/C3, malformed
 * output, timeout, transport throw — returns undefined (fail-open family
 * rule: a broken channel classification never surfaces, never blocks).
 * The transport is NEVER called unless cfg.channelNudge === true AND the
 * prefilter passes — flag-off inertness lives here, not just in hook-cli. */
export async function decideNudge(
  deps: NudgeDeps,
  prompt: string,
  cfg: GaugeChannelNudgeConfig | undefined,
): Promise<string | undefined> {
  if (cfg?.channelNudge !== true) return undefined
  if (!shouldConsiderPrompt(prompt)) return undefined
  const timeoutMs = deps.timeoutMs ?? NUDGE_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  let raw: string | undefined
  try {
    raw = await Promise.race([
      deps.transport(buildChannelPrompt(prompt)),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (!raw) return undefined
  const parsed = parseChannelOutput(raw)
  if (parsed?.channel !== "C4") return undefined
  return buildNudgeContext("C4")
}
