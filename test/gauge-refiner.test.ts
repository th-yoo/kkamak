import { test, expect, describe } from "bun:test"
import {
  buildRefinerPrompt,
  parseRefinerOutput,
  buildLabelPrompt,
  parseLabelOutput,
  ANTI_OVER_EXTRACTION_TRAPS,
} from "../src/extensions/gauge/refiner.ts"

// --- buildRefinerPrompt ---

test("buildRefinerPrompt embeds the raw user prompt and demands JSON-only output", () => {
  const p = buildRefinerPrompt("fix the token expiry check in auth.ts", "bun test")
  expect(p).toContain("fix the token expiry check in auth.ts")
  expect(p.toLowerCase()).toContain("json")
  expect(p).toContain("exit 0")
})

test("buildRefinerPrompt embeds the floorCheck 2nd arg verbatim", () => {
  const p = buildRefinerPrompt("do something", "cd cc-gate-plugin && bun test")
  expect(p).toContain("cd cc-gate-plugin && bun test")
})

test('buildRefinerPrompt renders "(none armed)" when floorCheck is ""', () => {
  const p = buildRefinerPrompt("do something", "")
  expect(p).toContain("(none armed)")
  expect(p).not.toContain("cd cc-gate-plugin")
})

test("buildRefinerPrompt lists all five class literals", () => {
  const p = buildRefinerPrompt("do something", "")
  expect(p).toContain('"A1"|"A2"|"B"|"C"|"D"')
})

// --- parseRefinerOutput ---

const VALID = JSON.stringify({
  goalSummary: "token expiry uses <= not <",
  class: "C",
  reason: null,
  criteria: ["expiry comparison is exclusive", "existing auth tests pass"],
  check: "bun test test/auth.test.ts",
  horizon: "single-turn",
  confidence: 0.8,
})

test("valid JSON parses to a gauge derivation", () => {
  const g = parseRefinerOutput(VALID)!
  expect(g.goalSummary).toBe("token expiry uses <= not <")
  expect(g.class).toBe("C")
  expect(g.reason).toBeNull()
  expect(g.criteria).toEqual(["expiry comparison is exclusive", "existing auth tests pass"])
  expect(g.check).toBe("bun test test/auth.test.ts")
  expect(g.horizon).toBe("single-turn")
  expect(g.confidence).toBe(0.8)
})

test("markdown-fenced JSON is unwrapped", () => {
  const fenced = "```json\n" + VALID + "\n```"
  expect(parseRefinerOutput(fenced)!.check).toBe("bun test test/auth.test.ts")
})

test("null / empty / whitespace check normalizes to null", () => {
  const mk = (check: unknown) =>
    JSON.stringify({ goalSummary: "g", class: "C", criteria: ["c"], check, confidence: 0.5 })
  expect(parseRefinerOutput(mk(null))!.check).toBeNull()
  expect(parseRefinerOutput(mk(""))!.check).toBeNull()
  expect(parseRefinerOutput(mk("   "))!.check).toBeNull()
  expect(parseRefinerOutput(mk(42))!.check).toBeNull()
})

test("confidence clamps to [0,1] and defaults to 0.5 when missing/invalid", () => {
  const mk = (confidence: unknown) =>
    JSON.stringify({ goalSummary: "g", class: "A1", criteria: ["c"], check: null, confidence })
  expect(parseRefinerOutput(mk(1.7))!.confidence).toBe(1)
  expect(parseRefinerOutput(mk(-2))!.confidence).toBe(0)
  expect(parseRefinerOutput(mk("high"))!.confidence).toBe(0.5)
  expect(parseRefinerOutput(mk(undefined))!.confidence).toBe(0.5)
})

test("garbage / non-object / missing fields → undefined", () => {
  expect(parseRefinerOutput("not json at all")).toBeUndefined()
  expect(parseRefinerOutput("[]")).toBeUndefined()
  expect(parseRefinerOutput(`{"class": "C", "criteria": ["c"], "check": null}`)).toBeUndefined() // no goalSummary
  expect(parseRefinerOutput(`{"goalSummary": "g", "class": "C", "check": null}`)).toBeUndefined() // no criteria
  expect(
    parseRefinerOutput(`{"goalSummary": "g", "class": "C", "criteria": [], "check": null}`),
  ).toBeUndefined() // empty criteria
  expect(
    parseRefinerOutput(`{"goalSummary": "g", "class": "C", "criteria": [1, 2], "check": null}`),
  ).toBeUndefined() // non-string criteria
})

test("prose around a JSON object is tolerated (first { to last })", () => {
  const chatty = "Here is the gauge:\n" + VALID + "\nHope this helps!"
  expect(parseRefinerOutput(chatty)!.goalSummary).toBe("token expiry uses <= not <")
})

// --- v2: class (new: missing/invalid → undefined; M0 miss) ---

test("missing class → undefined (M0 miss)", () => {
  const noClass = JSON.stringify({ goalSummary: "g", criteria: ["c"], check: null, confidence: 0.5 })
  expect(parseRefinerOutput(noClass)).toBeUndefined()
})

test("invalid/unknown class literal → undefined (M0 miss)", () => {
  const badClass = JSON.stringify({
    goalSummary: "g",
    class: "E",
    criteria: ["c"],
    check: null,
    confidence: 0.5,
  })
  expect(parseRefinerOutput(badClass)).toBeUndefined()

  const numericClass = JSON.stringify({
    goalSummary: "g",
    class: 1,
    criteria: ["c"],
    check: null,
    confidence: 0.5,
  })
  expect(parseRefinerOutput(numericClass)).toBeUndefined()
})

test("each of the five class literals parses", () => {
  const classes = ["A1", "A2", "B", "C", "D"] as const
  for (const cls of classes) {
    const j = JSON.stringify({ goalSummary: "g", class: cls, criteria: ["c"], check: null, confidence: 0.5 })
    expect(parseRefinerOutput(j)!.class).toBe(cls)
  }
})

// --- v2: horizon normalization ---

test("horizon: valid literals pass through", () => {
  const mk = (horizon: unknown) =>
    JSON.stringify({ goalSummary: "g", class: "C", criteria: ["c"], check: null, horizon, confidence: 0.5 })
  expect(parseRefinerOutput(mk("single-turn"))!.horizon).toBe("single-turn")
  expect(parseRefinerOutput(mk("multi-turn"))!.horizon).toBe("multi-turn")
})

test("horizon: invalid literal ('weekly') normalizes to null", () => {
  const j = JSON.stringify({
    goalSummary: "g",
    class: "C",
    criteria: ["c"],
    check: null,
    horizon: "weekly",
    confidence: 0.5,
  })
  expect(parseRefinerOutput(j)!.horizon).toBeNull()
})

test("horizon: missing/null normalizes to null", () => {
  const j = JSON.stringify({ goalSummary: "g", class: "A1", criteria: ["c"], check: null, confidence: 0.5 })
  expect(parseRefinerOutput(j)!.horizon).toBeNull()
})

// --- v2: reason trim/null ---

test("reason: non-empty string trims whitespace", () => {
  const j = JSON.stringify({
    goalSummary: "g",
    class: "A1",
    criteria: ["c"],
    check: null,
    reason: "  no-eval-needed  ",
    confidence: 0.5,
  })
  expect(parseRefinerOutput(j)!.reason).toBe("no-eval-needed")
})

test("reason: missing / null / empty / non-string → null", () => {
  const mk = (reason: unknown) =>
    JSON.stringify({ goalSummary: "g", class: "C", criteria: ["c"], check: null, reason, confidence: 0.5 })
  expect(parseRefinerOutput(mk(null))!.reason).toBeNull()
  expect(parseRefinerOutput(mk(""))!.reason).toBeNull()
  expect(parseRefinerOutput(mk("   "))!.reason).toBeNull()
  expect(parseRefinerOutput(mk(7))!.reason).toBeNull()
  const noReason = JSON.stringify({ goalSummary: "g", class: "C", criteria: ["c"], check: null, confidence: 0.5 })
  expect(parseRefinerOutput(noReason)!.reason).toBeNull()
})

// --- v2: shape-only — does NOT enforce check-iff-C (that's validate's job) ---

test("non-C class with a check present: parse keeps the raw check untouched", () => {
  const j = JSON.stringify({
    goalSummary: "g",
    class: "A2",
    criteria: ["c"],
    check: "bun test",
    confidence: 0.5,
  })
  const g = parseRefinerOutput(j)!
  expect(g.class).toBe("A2")
  expect(g.check).toBe("bun test")
})

// --- Task 2 (gauge-classifier 2×2 A/B): prompt variant ---

test("buildRefinerPrompt with no 3rd arg (every pre-T2 production caller) is byte-identical to variant 'base'", () => {
  expect(buildRefinerPrompt("do something", "bun test")).toBe(
    buildRefinerPrompt("do something", "bun test", "base"),
  )
})

test("buildRefinerPrompt 'base' never contains the trap text", () => {
  const p = buildRefinerPrompt("do something", "bun test", "base")
  expect(p).not.toContain("NOT class C")
  expect(p).not.toContain(ANTI_OVER_EXTRACTION_TRAPS)
})

test("buildRefinerPrompt 'patched' embeds the trap text byte-faithfully, before the Task prompt block", () => {
  const p = buildRefinerPrompt("do something", "bun test", "patched")
  expect(p).toContain(ANTI_OVER_EXTRACTION_TRAPS)
  expect(p.indexOf(ANTI_OVER_EXTRACTION_TRAPS)).toBeLessThan(p.indexOf("Task prompt:"))
})

test("ANTI_OVER_EXTRACTION_TRAPS is byte-faithful to docs/2026-08-01-gauge-classifier-labels.md", () => {
  expect(ANTI_OVER_EXTRACTION_TRAPS).toBe(
    [
      "NOT class C — shapes that look extractable but are not. Each is D unless some OTHER stated property independently qualifies:",
      "- The prompt names a path but states NO property of it. Reading, viewing, opening, reviewing or looking at a file leaves no filesystem trace, so there is nothing for a check to observe.",
      "- The name looks path-like but is not a filesystem path: a git branch or ref, a URL, a package or module name, a bare identifier. Only a real file or directory path counts.",
      "- A bare filename with no directory, where the prompt never says where it belongs. A check would have to invent the location.",
      "- The prompt says to fill, populate, update or finish a named file without stating what content would make it done. Mere existence is not the criterion the prompt stated.",
      "Naming a path is NEVER sufficient on its own. Ask: what would the file look like afterward that it does not look like now, in words the prompt itself supplies? If you cannot answer from the prompt text alone, the class is D.",
    ].join("\n"),
  )
})

// --- Task 2: buildLabelPrompt / parseLabelOutput ---

test("buildLabelPrompt embeds the raw user prompt and demands JSON-only C/not-C output", () => {
  const p = buildLabelPrompt("fix the token expiry check in auth.ts", "bun test")
  expect(p).toContain("fix the token expiry check in auth.ts")
  expect(p).toContain('"C"|"not-C"')
})

test("buildLabelPrompt embeds floorCheck verbatim, and renders '(none armed)' when empty", () => {
  const withCheck = buildLabelPrompt("do something", "cd cc-gate-plugin && bun test")
  expect(withCheck).toContain("cd cc-gate-plugin && bun test")
  const noCheck = buildLabelPrompt("do something", "")
  expect(noCheck).toContain("(none armed)")
})

test("buildLabelPrompt never extracts a shell check — no extraction-discipline language", () => {
  const p = buildLabelPrompt("do something", "")
  expect(p).not.toContain("shell command")
})

test("parseLabelOutput: valid C / not-C with optional class", () => {
  expect(parseLabelOutput(JSON.stringify({ label: "C", class: "C" }))).toEqual({ label: "C", class: "C" })
  expect(parseLabelOutput(JSON.stringify({ label: "not-C", class: "D" }))).toEqual({
    label: "not-C",
    class: "D",
  })
  expect(parseLabelOutput(JSON.stringify({ label: "not-C", class: null }))).toEqual({
    label: "not-C",
    class: null,
  })
})

test("parseLabelOutput: invalid/unknown class literal normalizes to null (never fabricated)", () => {
  expect(parseLabelOutput(JSON.stringify({ label: "C", class: "E" }))).toEqual({ label: "C", class: null })
  expect(parseLabelOutput(JSON.stringify({ label: "C" }))).toEqual({ label: "C", class: null })
})

// --- buildLabelPrompt structural independence (F13, user ruling 2026-08-03) ---
//
// Final-review finding: the rubric copied buildRefinerPrompt's class-C
// clause near-verbatim, which aligns the judge's prior with the base arm
// and structurally blinds the experiment to the patched arm's corrections.
// User ruled: rewrite the rubric from the pre-registration's CONCEPT of
// class C, in fresh words, independent of both buildRefinerPrompt's C
// clause and its anti-over-extraction traps. These tests pin that
// independence directly against the two texts it must not resemble.
describe("buildLabelPrompt — structural independence from buildRefinerPrompt (F13)", () => {
  // The base prompt's own class-C clause (buildRefinerPrompt, variant "base"):
  // most distinctive substrings, picked to catch a near-verbatim reuse.
  const BASE_C_CLAUSE_SUBSTRINGS = [
    "states an observable property of a file or path",
    "names that path literally",
    "Only then extract a check",
  ]

  // One distinctive substring per anti-over-extraction trap bullet
  // (ANTI_OVER_EXTRACTION_TRAPS, "patched" variant only).
  const TRAP_BULLET_SUBSTRINGS = [
    "leaves no filesystem trace",
    "looks path-like",
    "would have to invent the location",
    "fill, populate, update or finish",
  ]

  test("contains none of the base prompt's C-clause distinctive phrasing", () => {
    const p = buildLabelPrompt("fix src/auth.ts so the token never expires", "bun test")
    for (const s of BASE_C_CLAUSE_SUBSTRINGS) expect(p).not.toContain(s)
  })

  test("contains none of the four anti-over-extraction trap bullets' phrasings", () => {
    const p = buildLabelPrompt("fix src/auth.ts so the token never expires", "bun test")
    for (const s of TRAP_BULLET_SUBSTRINGS) expect(p).not.toContain(s)
  })

  test("never carries base's doubt-handling clause", () => {
    const p = buildLabelPrompt("fix src/auth.ts so the token never expires", "bun test")
    expect(p).not.toContain("choose D")
  })

  test("blind protocol unchanged: still carries the record's prompt, floorCheck, and the C/not-C output instruction", () => {
    const p = buildLabelPrompt("fix src/auth.ts so the token never expires", "bun test")
    expect(p).toContain("fix src/auth.ts so the token never expires")
    expect(p).toContain("bun test")
    expect(p).toContain('"C"|"not-C"')
  })
})

test("parseLabelOutput: missing/invalid label -> undefined (M0 miss, never fabricated)", () => {
  expect(parseLabelOutput(JSON.stringify({ class: "C" }))).toBeUndefined()
  expect(parseLabelOutput(JSON.stringify({ label: "maybe", class: "C" }))).toBeUndefined()
  expect(parseLabelOutput("not json")).toBeUndefined()
  expect(parseLabelOutput("[]")).toBeUndefined()
})

test("parseLabelOutput: markdown-fenced JSON is unwrapped", () => {
  const fenced = "```json\n" + JSON.stringify({ label: "C", class: "C" }) + "\n```"
  expect(parseLabelOutput(fenced)).toEqual({ label: "C", class: "C" })
})
