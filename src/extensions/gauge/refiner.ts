// km-gauge refiner (pre-reg §2.2, v2 design 2026-07-29) — pure pieces of the
// derivation step: prompt construction + output parsing. The actual claude
// spawn lives in refiner-cli.ts (detached child); nothing here touches IO.
//
// v2 EXTRACTS ONLY: the refiner classifies the prompt (A1/A2/B/C/D) and, for
// class C only, extracts a check verbatim-anchored to the prompt. It never
// invents a check. Enforcement of the extraction discipline (check-iff-C,
// path-in-prompt, in-repo-scope, …) happens in code — validate.ts — never
// here; parseRefinerOutput below is SHAPE validation only.
import type { GaugeHorizon, GaugePromptClass } from "./types.ts"

/** Refiner's parsed derivation — becomes the persisted gauge file payload
 * once run through validate.ts.
 *
 * K4 port note: canonical definition stays in ./types.ts (ported there
 * first, K3, before this file existed — validate.ts already imports it
 * from there and stays untouched rather than gaining a gratuitous re-edit
 * back to this path). Re-exported here so this file's own export surface
 * still matches the lab's (anything importing GaugeDerivation from
 * ./refiner.ts, matching the lab's own import path, still works). */
export type { GaugeDerivation } from "./types.ts"

const CLASS_LITERALS: readonly string[] = ["A1", "A2", "B", "C", "D"]
const HORIZON_LITERALS: readonly string[] = ["single-turn", "multi-turn"]

/** Task 2 (2×2 gauge-classifier A/B, plan `docs/superpowers/plans/2026-08-03-
 * gauge-classifier-ab.md`) — which text `buildRefinerPrompt` builds. `"base"`
 * is byte-identical to the pre-T2 prompt (every existing production caller
 * omits this argument and gets exactly that). `"patched"` is base + the four
 * anti-over-extraction traps below. */
export type PromptVariant = "base" | "patched"

/** The four anti-over-extraction traps, byte-faithful to the committed,
 * already-measured text in `docs/2026-08-01-gauge-classifier-labels.md`
 * ("The anti-over-extraction traps (tested, NOT applied)") — this constant
 * does not restate a new decision, it carries forward text already
 * committed and already measured (false-C 4→0 on the CLI transport, at a
 * recall cost 100%→67%; known defect: overcorrects record 12). F2 is not in
 * play here — this is committed classifier-logic prose, not sampled task
 * prompt content. Applied ONLY by the "patched" arm of the 2×2 experiment
 * (cls-ab.ts) — NOT wired into the "base" variant, so every production
 * caller (refiner-cli.ts, corpus-replay.ts, transport.ts's default) is
 * untouched, per the plan's Global Constraints ("cannot change the production
 * refiner prompt or model"). */
export const ANTI_OVER_EXTRACTION_TRAPS = [
  "NOT class C — shapes that look extractable but are not. Each is D unless some OTHER stated property independently qualifies:",
  "- The prompt names a path but states NO property of it. Reading, viewing, opening, reviewing or looking at a file leaves no filesystem trace, so there is nothing for a check to observe.",
  "- The name looks path-like but is not a filesystem path: a git branch or ref, a URL, a package or module name, a bare identifier. Only a real file or directory path counts.",
  "- A bare filename with no directory, where the prompt never says where it belongs. A check would have to invent the location.",
  "- The prompt says to fill, populate, update or finish a named file without stating what content would make it done. Mere existence is not the criterion the prompt stated.",
  "Naming a path is NEVER sufficient on its own. Ask: what would the file look like afterward that it does not look like now, in words the prompt itself supplies? If you cannot answer from the prompt text alone, the class is D.",
].join("\n")

export function buildRefinerPrompt(
  userPrompt: string,
  floorCheck: string,
  variant: PromptVariant = "base",
): string {
  const trap = variant === "patched" ? [ANTI_OVER_EXTRACTION_TRAPS, ""] : []
  return [
    "You classify a coding-agent task prompt and, ONLY when possible, EXTRACT a completion check from it.",
    "Output ONLY a JSON object, no prose, no markdown fences:",
    '{"goalSummary": string, "class": "A1"|"A2"|"B"|"C"|"D", "reason": string|null, "criteria": string[], "check": string|null, "horizon": "single-turn"|"multi-turn"|null, "confidence": number}',
    "",
    "Pick exactly one class, by where the completion criterion lives:",
    '- "A1": no evaluation needed (greeting, chat, trivial acknowledgement). reason "no-eval-needed".',
    '- "A2": the criterion is the QUALITY of the reply or judgment (research, review, explanation, planning) — real, but not checkable by a shell command. reason "not-shell-checkable".',
    '- "B": the criterion is already covered by the repo\'s own gate check shown below (e.g. "fix the failing tests", "make the build green"). reason "floor-covered".',
    '- "C": the prompt ITSELF states an observable property of a file or path inside this repo AND names that path literally. Only then extract a check.',
    '- "D": a criterion exists, but writing a check would require inventing paths or conventions not present in the prompt (reason "not-extractable"), or observing something outside this repo (reason "out-of-scope").',
    "",
    `The repo's own gate check (for class B): ${floorCheck === "" ? "(none armed)" : floorCheck}`,
    "",
    "Extraction discipline (class C only — violations are detected in code and discarded):",
    "- check: ONE cheap read-only shell command run from the repo root; exit 0 iff the work is done, non-zero otherwise (<30s, no network, no writes, no interactivity).",
    "- Every file or directory path in the check MUST appear verbatim, character for character, in the task prompt below. If the prompt names no usable path, the class is D and check is null.",
    "- The check must test a property the prompt itself states — never a guessed proxy (no git-status dirtiness, no repo-wide greps for something the prompt scoped to one file).",
    "- When in doubt between C and D, choose D. null beats a guess.",
    "- check MUST be null for every class except C.",
    "",
    "horizon (class C only, null for all other classes):",
    '- "single-turn": plausibly completable in one assistant turn.',
    '- "multi-turn": a larger task; its check should only be trusted after more than one turn of work.',
    "",
    "- goalSummary: one sentence, what outcome the user asked for.",
    "- criteria: 1-5 testable acceptance statements (unambiguous, observable).",
    "- confidence: 0..1, how well class+check capture the prompt's intent.",
    "",
    ...trap,
    "Task prompt:",
    "<<<PROMPT",
    userPrompt,
    "PROMPT",
  ].join("\n")
}

/** Gauge-classifier-2×2-A/B label rubric (`cls-label`, Task 2).
 *
 * Rewritten 2026-08-03 per user ruling on final-review finding F13
 * (pre-data — zero labels existed at rewrite time): the earlier draft
 * copied `buildRefinerPrompt`'s class-C clause near-verbatim, which
 * aligns the judge's prior with the base arm and structurally blinds the
 * experiment to corrections the patched arm (`ANTI_OVER_EXTRACTION_TRAPS`)
 * is measured against. This version is authored fresh from the
 * pre-registration's CONCEPT of class C
 * (`docs/superpowers/specs/2026-08-03-gauge-classifier-ab-preregistration.md`
 * §2.2) — the judge is asked the underlying question in its own words,
 * never handed either arm's phrasing, its traps, or its "when in doubt"
 * bias. Deliberately NOT `buildRefinerPrompt`: the labeler asks a
 * strictly narrower question (C vs not-C, plus an optional class letter
 * for context) and never extracts a check — the pre-registration's
 * ground-truth judgment is a classification only. Inputs are the SAME two
 * fields buildRefinerPrompt takes (`userPrompt`, `floorCheck`) and
 * nothing else — this is what makes the blind-isolation protocol
 * (pre-reg §5) hold BY CONSTRUCTION: this function has no parameter
 * through which a stored nominal class or an arm's output could even be
 * passed in. */
export function buildLabelPrompt(userPrompt: string, floorCheck: string): string {
  return [
    "You are given a coding-agent task prompt. Answer one question about it:",
    "does the prompt's own text state a success condition that could be mechanically",
    "verified — for example by running a command from the repo root — against a named",
    "artifact (a file, a directory, or an output the prompt points to)?",
    "Answer C if it does, not-C if it does not.",
    "",
    "Clarifications:",
    "- The success condition must be stated in the prompt's own words. A condition you",
    "  infer from context, convention, or from what a typical repo would contain does not",
    "  count.",
    "- The named artifact must likewise come from the prompt's own text. If verifying the",
    "  condition would require you to supply a path, file, or convention the prompt never",
    "  gives, the answer is not-C.",
    "- Judge only whether the condition and the artifact are both present in the prompt",
    "  text as written. Do not judge how hard the condition would be to verify, and do not",
    "  weigh it against any other task the prompt might also be doing.",
    "",
    `The repo's own gate check (for context only): ${floorCheck === "" ? "(none armed)" : floorCheck}`,
    "",
    "Output ONLY a JSON object, no prose, no markdown fences:",
    '{"label": "C"|"not-C", "class": "A1"|"A2"|"B"|"C"|"D"|null}',
    "- label: your C vs not-C verdict per the question above.",
    '- class: your best single-letter classification if you have one (may restate "C"/mirror',
    "  label, or name which of A1/A2/B/D fits best); null if you cannot narrow beyond not-C.",
    "",
    "Task prompt:",
    "<<<PROMPT",
    userPrompt,
    "PROMPT",
  ].join("\n")
}

export type ClsLabel = "C" | "not-C"

/** Labeler's parsed output. Shape-only, mirrors `parseRefinerOutput`'s
 * discipline (tolerant of fences/prose, first `{` to last `}`). */
export interface ClsLabelOutput {
  label: ClsLabel
  class: GaugePromptClass | null
}

const LABEL_LITERALS: readonly string[] = ["C", "not-C"]

/** Model text → SHAPE-validated label; undefined on any malformed shape
 * (M0-miss precedent — never fabricate a label from a bad response). */
export function parseLabelOutput(text: string): ClsLabelOutput | undefined {
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

  if (typeof r.label !== "string" || !LABEL_LITERALS.includes(r.label)) return undefined
  const label = r.label as ClsLabel

  const cls =
    typeof r.class === "string" && CLASS_LITERALS.includes(r.class) ? (r.class as GaugePromptClass) : null

  return { label, class: cls }
}

/** Model text → SHAPE-validated derivation; undefined on any malformed shape.
 * Does NOT enforce check-iff-C, path-in-prompt, or any other extraction
 * discipline — that's validate.ts's job so violations are recorded
 * downgrades, not silently vanished. */
export function parseRefinerOutput(text: string): import("./types.ts").GaugeDerivation | undefined {
  // Tolerate fences and surrounding prose: take first "{" to last "}".
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

  if (typeof r.goalSummary !== "string" || !r.goalSummary) return undefined
  if (!Array.isArray(r.criteria) || r.criteria.length === 0) return undefined
  if (!r.criteria.every((c) => typeof c === "string" && c)) return undefined
  if (typeof r.class !== "string" || !CLASS_LITERALS.includes(r.class)) return undefined
  const cls = r.class as GaugePromptClass

  const check = typeof r.check === "string" && r.check.trim() ? r.check.trim() : null

  const confidence =
    typeof r.confidence === "number" && Number.isFinite(r.confidence)
      ? Math.min(1, Math.max(0, r.confidence))
      : 0.5

  const reason = typeof r.reason === "string" && r.reason.trim() ? r.reason.trim() : null

  const horizon =
    typeof r.horizon === "string" && HORIZON_LITERALS.includes(r.horizon)
      ? (r.horizon as GaugeHorizon)
      : null

  return {
    goalSummary: r.goalSummary,
    class: cls,
    reason,
    criteria: r.criteria as string[],
    check,
    horizon,
    confidence,
  }
}
