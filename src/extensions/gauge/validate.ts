// km-gauge v2 extractor — validate.ts (2026-07-29 design session, Task 1).
// Pure, lexical-only, ordered, first-violation-wins enforcement of the
// refiner's extraction discipline. The refiner CLASSIFIES + (class C only)
// EXTRACTS; this module is the code-side judge — every rule it fires is a
// RECORDED downgrade, never a silent vanish (see task-1-brief.md "Design
// core"). validateDerivation is the single call site that turns a raw
// GaugeDerivation into the ValidatedDerivation that gets persisted.
//
// Self-contained by design: this file must not reach into files.ts/
// spawn.ts/refiner-cli.ts/evaluate.ts/shadow.ts/score*.ts — those are later
// DAG-wave concerns (Task 2+). classifier.ts is included because its
// PATH_EXTENSIONS is the single source of truth for "bare filename with a
// known extension" — duplicating that list here would silently drift from
// classifier.ts's own PATH_LIKE regex.
import path from "node:path"
import type { GaugeHorizon, GaugePromptClass, GaugeDerivation } from "./types.ts"
import { PATH_EXTENSIONS } from "./classifier.ts"

export type DowngradeRule =
  | "check-outside-class-c"
  | "missing-check"
  | "b-keyword"
  | "no-path-reference"
  | "path-not-in-prompt"
  | "out-of-scope"

export interface Downgrade {
  /** Class the derivation carried BEFORE this rule fired. */
  fromClass: GaugePromptClass
  /** The model's original check — the only place it survives once nulled. */
  fromCheck: string | null
  rule: DowngradeRule
  /** The offending token, when the rule is token-specific. */
  token?: string
}

export interface ValidatedDerivation {
  goalSummary: string
  class: GaugePromptClass
  reason: string | null
  criteria: string[]
  check: string | null
  horizon: GaugeHorizon | null
  confidence: number
  downgraded?: Downgrade
}

export interface ValidateInput {
  derivation: GaugeDerivation
  prompt: string
  floorCheck: string
  repoRoot: string
}

// ── step 4: extractPathTokens — shell tokenizer + path-like filter ──────

const META = new Set(["&&", "||", ";", "|"])
const PATTERN_CMDS = new Set(["grep", "egrep", "fgrep", "rg", "sed", "awk"])
const FIND_VALUE_FLAGS = new Set(["-name", "-iname", "-path", "-regex"])
const PATH_EXT_RE = new RegExp(`\\.(${PATH_EXTENSIONS.join("|")})$`, "i")

/** Whitespace + shell-metachar tokenizer honoring single/double quotes.
 * Quoted content (including embedded spaces) becomes ONE token, dequoted. */
function shellTokenize(s: string): string[] {
  const tokens: string[] = []
  let i = 0
  const n = s.length
  while (i < n) {
    const c = s[i]!
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === "'" || c === '"') {
      const quote = c
      let j = i + 1
      let buf = ""
      while (j < n && s[j] !== quote) {
        buf += s[j]
        j++
      }
      tokens.push(buf)
      i = j + 1
      continue
    }
    if (s.startsWith("&&", i)) {
      tokens.push("&&")
      i += 2
      continue
    }
    if (s.startsWith("||", i)) {
      tokens.push("||")
      i += 2
      continue
    }
    if (c === ";" || c === "|") {
      tokens.push(c)
      i += 1
      continue
    }
    let j = i
    let buf = ""
    while (j < n && !/\s/.test(s[j]!) && s[j] !== ";" && s[j] !== "|" && !s.startsWith("&&", j)) {
      buf += s[j]
      j++
    }
    tokens.push(buf)
    i = j
  }
  return tokens
}

/** path-like = contains "/" OR is a bare filename with a known extension
 * (extension list is classifier.ts's PATH_EXTENSIONS — single source). */
function isPathLikeToken(tok: string): boolean {
  if (tok.includes("/")) return true
  return PATH_EXT_RE.test(tok)
}

interface PathTokenHit {
  token: string
  /** True for a `cd`'s own directory argument. Included in the public
   * extractPathTokens result (steps 5/6 still enforce it) but EXCLUDED from
   * the B-screen's B2' scoping-token check (review finding #1, 2026-07-29
   * fix pass) — a bare `cd <dir> && <floor cmd>` verifies nothing beyond
   * the floor even when <dir> is named in the prompt. */
  isCdTarget: boolean
}

/** Every path-like token in `check`, after excluding: flags, URLs,
 * /dev/null, the grep-family pattern slot, find's -name|-iname|-path|-regex
 * VALUE, and command words (the first token of each &&/||/;/|-separated
 * segment — never a path token, even when it happens to look path-like).
 * Globs are path-like and NOT expanded (step 4). */
function extractPathTokenHits(check: string): PathTokenHit[] {
  const raw = shellTokenize(check)
  const out: PathTokenHit[] = []

  let commandWord: string | undefined
  let atSegmentStart = true
  let patternSlotPending = false
  let findValuePending = false
  let cdTargetPending = false

  for (const tok of raw) {
    if (META.has(tok)) {
      atSegmentStart = true
      commandWord = undefined
      patternSlotPending = false
      findValuePending = false
      cdTargetPending = false
      continue
    }
    if (atSegmentStart) {
      commandWord = tok
      atSegmentStart = false
      if (PATTERN_CMDS.has(commandWord)) patternSlotPending = true
      if (commandWord === "cd") cdTargetPending = true
      continue // command word itself is never a path token
    }

    if (findValuePending) {
      findValuePending = false
      continue // value paired with find's -name/-iname/-path/-regex
    }
    if (commandWord === "find" && FIND_VALUE_FLAGS.has(tok)) {
      findValuePending = true
      continue
    }
    if (tok.startsWith("-")) continue // flags
    if (patternSlotPending) {
      patternSlotPending = false
      continue // grep-family PATTERN argument (known coarse gap: -f FILE)
    }
    const isCdTarget = cdTargetPending
    if (cdTargetPending) cdTargetPending = false
    if (tok === "/dev/null") continue
    if (tok.includes("://")) continue // URL

    if (isPathLikeToken(tok)) out.push({ token: tok, isCdTarget })
  }
  return out
}

/** Public step-4 tokenizer — includes cd-target directories (steps 5/6
 * still verbatim/scope-enforce them). */
export function extractPathTokens(check: string): string[] {
  return extractPathTokenHits(check).map((h) => h.token)
}

// ── step 5: verbatim-in-prompt ───────────────────────────────────────────

function normalizeForPromptCheck(tok: string): string {
  let t = tok
  if (t.startsWith("./")) t = t.slice(2)
  if (t.endsWith("/")) t = t.slice(0, -1)
  return t
}

/** [^A-Za-z0-9_] or a string edge — a plain substring match is not enough
 * (review finding #2, 2026-07-29 fix pass): "a.ts" must not match inside
 * "thisisnota.tsfile", "app.js" must not match inside "webapp.jsx". */
function isBoundaryChar(c: string | undefined): boolean {
  return c === undefined || !/[A-Za-z0-9_]/.test(c)
}

function tokenInPrompt(tok: string, prompt: string): boolean {
  const needle = normalizeForPromptCheck(tok)
  if (!needle) return false
  let idx = prompt.indexOf(needle)
  while (idx !== -1) {
    const before = idx > 0 ? prompt[idx - 1] : undefined
    const after = idx + needle.length < prompt.length ? prompt[idx + needle.length] : undefined
    if (isBoundaryChar(before) && isBoundaryChar(after)) return true
    idx = prompt.indexOf(needle, idx + 1)
  }
  return false
}

// ── step 6: repo scope ───────────────────────────────────────────────────

function inRepoScope(tok: string, repoRoot: string): boolean {
  if (tok.startsWith("~")) return false
  const root = path.resolve(repoRoot)
  const resolved = path.resolve(repoRoot, tok)
  return resolved === root || resolved.startsWith(root + path.sep)
}

// ── step 3: B-screen ──────────────────────────────────────────────────────

const B_PHRASE_RE = /\b(tests?\s+pass(?:es|ing)?|build\s+(?:is\s+)?green)\b/i

/** goalSummary + criteria ONLY — never the raw prompt (model free text is
 * screened by a closed phrase set, not trusted as a classification). */
function phraseScreenFires(derivation: GaugeDerivation): boolean {
  const text = `${derivation.goalSummary}\n${derivation.criteria.join("\n")}`
  return B_PHRASE_RE.test(text)
}

function stripLeadingCd(s: string): string {
  let out = s.trim()
  const re = /^cd\s+\S+\s*&&\s*/
  while (re.test(out)) out = out.replace(re, "").trim()
  return out
}

function headOf(s: string, n = 2): string {
  return s.trim().split(/\s+/).slice(0, n).join(" ")
}

/** floorCheck split into its logical `cd <dir> && <cmd...>` segments — a
 * bare `cd <dir>` (post &&-split) starts a new segment; everything else
 * joins the current one. Live floor example:
 * "cd cc-gate-plugin && bun test && cd ../gate-plugin && bun test" →
 * ["cd cc-gate-plugin && bun test", "cd ../gate-plugin && bun test"]. */
function splitFloorSegments(floorCheck: string): string[] {
  const parts = floorCheck.split(/\s*&&\s*/).filter((p) => p.length > 0)
  const segments: string[] = []
  for (const part of parts) {
    if (segments.length === 0 || /^cd\s+\S/.test(part)) {
      segments.push(part)
    } else {
      segments[segments.length - 1] += ` && ${part}`
    }
  }
  return segments
}

/** cd-prefix-stripped floor comparison (review B2/B2'). Fires iff the
 * stripped derived check's head matches a stripped floor-segment head AND
 * carries no NON-CD-TARGET path token beyond that head verbatim-matching
 * the prompt (a scoped subset run, e.g. `bun test test/x.test.ts` naming a
 * real file, is legitimate C extraction) — OR the derived check contains
 * the full floorCheck verbatim. Skipped entirely when floorCheck === "".
 *
 * Directory-level `cd` scoping does NOT count as a B2' scoping token
 * (review finding #1, 2026-07-29 fix pass): `cd sub/dir && bun test` with
 * "sub/dir" named in the prompt still verifies nothing beyond the floor and
 * must fire B, even though "sub/dir" is itself a real, prompt-verified,
 * in-repo path (steps 5/6 still enforce it on the cd target when the check
 * DOES survive to class C via some other path). */
function floorHeadFires(check: string, floorCheck: string, prompt: string): boolean {
  if (floorCheck === "") return false
  if (check.includes(floorCheck)) return true

  const strippedCheck = stripLeadingCd(check)
  const derivedHead = headOf(strippedCheck)
  const segments = splitFloorSegments(floorCheck)
  const headMatches = segments.some((seg) => headOf(stripLeadingCd(seg)) === derivedHead)
  if (!headMatches) return false

  const hits = extractPathTokenHits(check).filter((h) => !h.isCdTarget)
  const hasScopingToken = hits.some((h) => tokenInPrompt(h.token, prompt))
  return !hasScopingToken
}

// ── step 0: reason canonicalization (model free text never trusted) ─────

function canonicalReason(cls: GaugePromptClass, rule: DowngradeRule | undefined): string | null {
  switch (cls) {
    case "A1":
      return "no-eval-needed"
    case "A2":
      return "not-shell-checkable"
    case "B":
      return "floor-covered"
    case "C":
      return null
    case "D":
      return rule === "out-of-scope" ? "out-of-scope" : "not-extractable"
  }
}

// ── validateDerivation: steps 1-8 ────────────────────────────────────────

export function validateDerivation(input: ValidateInput): ValidatedDerivation {
  const { derivation, prompt, floorCheck, repoRoot } = input
  const originalClass = derivation.class
  const originalCheck = derivation.check

  let cls: GaugePromptClass = originalClass
  let downgrade: Downgrade | undefined

  const mkDowngrade = (rule: DowngradeRule, token?: string): Downgrade => ({
    fromClass: originalClass,
    fromCheck: originalCheck,
    rule,
    ...(token !== undefined ? { token } : {}),
  })

  if (originalClass !== "C" && originalCheck !== null) {
    // 1. Non-C with check → strip check (step 8), record downgrade, class kept.
    downgrade = mkDowngrade("check-outside-class-c")
  } else if (originalClass === "C" && originalCheck === null) {
    // 2. C with null check → D missing-check.
    cls = "D"
    downgrade = mkDowngrade("missing-check")
  } else if (originalClass === "C" && originalCheck !== null) {
    // 3. B-screen (before path rules).
    if (floorHeadFires(originalCheck, floorCheck, prompt) || phraseScreenFires(derivation)) {
      cls = "B"
      downgrade = mkDowngrade("b-keyword")
    } else {
      const tokens = extractPathTokens(originalCheck)
      if (tokens.length === 0) {
        // 3.5. Zero path tokens after exclusions → D no-path-reference.
        cls = "D"
        downgrade = mkDowngrade("no-path-reference")
      } else {
        // 5. Verbatim-in-prompt per token — first fail wins.
        const missingToken = tokens.find((t) => !tokenInPrompt(t, prompt))
        if (missingToken !== undefined) {
          cls = "D"
          downgrade = mkDowngrade("path-not-in-prompt", missingToken)
        } else {
          // 6. Repo scope per token — first fail wins.
          const outToken = tokens.find((t) => !inRepoScope(t, repoRoot))
          if (outToken !== undefined) {
            cls = "D"
            downgrade = mkDowngrade("out-of-scope", outToken)
          }
          // else: 7. All pass → C (cls already "C", no downgrade).
        }
      }
    }
  }
  // else: originalClass !== "C" && originalCheck === null → nothing to
  // enforce, passthrough (class kept, check already null).

  // 8. FINAL INVARIANT NORMALIZATION — unconditional, LAST line: only a
  // surviving class C ever keeps a live check. This is defense-in-depth
  // even though every branch above already implies it.
  const check = cls === "C" ? originalCheck : null

  // cls === "C" here can only be the step-7 success path (a downgrade never
  // targets C, and the passthrough branch requires originalClass !== "C").
  const horizon: GaugeHorizon | null = cls === "C" ? (derivation.horizon ?? "single-turn") : derivation.horizon

  const reason = canonicalReason(cls, downgrade?.rule)

  return {
    goalSummary: derivation.goalSummary,
    class: cls,
    reason,
    criteria: derivation.criteria,
    check,
    horizon,
    confidence: derivation.confidence,
    ...(downgrade ? { downgraded: downgrade } : {}),
  }
}
