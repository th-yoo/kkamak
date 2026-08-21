import { test, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { validateDerivation, extractPathTokens } from "../src/extensions/gauge/validate.ts"
import type { GaugeDerivation } from "../src/extensions/gauge/types.ts"

const REPO = "/repo"
const FLOOR = "cd cc-gate-plugin && bun test && cd ../gate-plugin && bun test"

function mkDerivation(over: Partial<GaugeDerivation> = {}): GaugeDerivation {
  return {
    goalSummary: "do the thing",
    class: "C",
    reason: null,
    criteria: ["c"],
    check: null,
    horizon: null,
    confidence: 0.8,
    ...over,
  }
}

// ── SELF-CONTAINED: import allow-list (brief item 3; classifier.ts added —
// see PATH_EXTENSIONS single-source note in the Task-1 report)
//
// K2 ruling: refiner.ts stays lab-side (not ported — its runtime is
// consumed by lab-only transport.ts/cls-ab/corpus-replay). validate.ts's
// only dependency on it was `import type { GaugeDerivation }`, so
// GaugeDerivation was copied verbatim into this port's own types.ts
// instead. Allow-list updated to match the rewritten import paths — this
// is the mechanical consequence of the import-path rewrite the port
// recipe already calls for, not a behavior change to validateDerivation
// or extractPathTokens (every other test below is untouched). ─────────────

test("SELF-CONTAINED: validate.ts imports only types/classifier/node:path", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dir, "..", "src", "extensions", "gauge", "validate.ts"),
    "utf-8",
  )
  const allow = new Set(["./types.ts", "./classifier.ts", "node:path"])
  const offenders: string[] = []
  for (const m of src.matchAll(/from\s+"([^"]+)"/g)) {
    const spec = m[1]!
    if (!allow.has(spec)) offenders.push(spec)
  }
  expect(offenders).toEqual([])
})

// ── extractPathTokens (step 4) ──────────────────────────────────────────

test("extractPathTokens: slash-bearing token is path-like", () => {
  expect(extractPathTokens("test -f src/a.ts")).toEqual(["src/a.ts"])
})

test("extractPathTokens: bare filename with known extension is path-like", () => {
  expect(extractPathTokens("cat README.md")).toEqual(["README.md"])
})

test("extractPathTokens: grep pattern-slot excluded; file arg kept", () => {
  expect(extractPathTokens('grep -q "foo/bar" src/a.ts')).toEqual(["src/a.ts"])
})

test("extractPathTokens: find -name value excluded; directory arg kept", () => {
  expect(extractPathTokens('find test/fixtures -name "*.ts"')).toEqual(["test/fixtures"])
})

test("extractPathTokens: glob is path-like, not expanded", () => {
  expect(extractPathTokens("ls src/*.ts")).toEqual(["src/*.ts"])
})

test("extractPathTokens: /dev/null and flags excluded", () => {
  expect(extractPathTokens("cmd -v > /dev/null")).toEqual([])
})

test("extractPathTokens: URL excluded", () => {
  expect(extractPathTokens("curl https://example.com/path")).toEqual([])
})

test("extractPathTokens: command word itself never a path token", () => {
  // "cd" excluded as the command word; "cc-gate-plugin" has no slash/ext.
  expect(extractPathTokens("cd cc-gate-plugin && bun test")).toEqual([])
})

// ── validateDerivation: path-in-prompt (steps 4-6) ──────────────────────

test("path named verbatim in prompt, in repo → stays C", () => {
  const d = mkDerivation({ check: "test -f src/a.ts" })
  const v = validateDerivation({
    derivation: d,
    prompt: "check that src/a.ts exists",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("C")
  expect(v.check).toBe("test -f src/a.ts")
  expect(v.downgraded).toBeUndefined()
})

test("path token not literally in prompt → D path-not-in-prompt", () => {
  const d = mkDerivation({ check: "test -f src/missing.ts" })
  const v = validateDerivation({
    derivation: d,
    prompt: "check that src/a.ts exists",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("D")
  expect(v.downgraded?.rule).toBe("path-not-in-prompt")
  expect(v.downgraded?.token).toBe("src/missing.ts")
  expect(v.check).toBeNull()
})

test("~-prefixed path passes verbatim-in-prompt (step 5) but dies at repo-scope (step 6)", () => {
  const d = mkDerivation({ check: "cat ~/plans/x.md" })
  const v = validateDerivation({
    derivation: d,
    prompt: "read ~/plans/x.md and summarize",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("D")
  expect(v.downgraded?.rule).toBe("out-of-scope")
  expect(v.downgraded?.token).toBe("~/plans/x.md")
})

test("absolute out-of-repo path named in prompt → D out-of-scope", () => {
  const d = mkDerivation({ check: "test -f /etc/passwd" })
  const v = validateDerivation({
    derivation: d,
    prompt: "verify /etc/passwd is untouched",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("D")
  expect(v.downgraded?.rule).toBe("out-of-scope")
})

test("../ escape resolves outside repo → D out-of-scope", () => {
  const d = mkDerivation({ check: "test -f ../other/secret.txt" })
  const v = validateDerivation({
    derivation: d,
    prompt: "check ../other/secret.txt",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("D")
  expect(v.downgraded?.rule).toBe("out-of-scope")
})

test("absolute path already inside repoRoot → allowed, stays C", () => {
  const d = mkDerivation({ check: "test -f /repo/src/a.ts" })
  const v = validateDerivation({
    derivation: d,
    prompt: "check /repo/src/a.ts",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("C")
})

test("src/../lib/x.ts resolves inside repo → stays C", () => {
  const d = mkDerivation({ check: "test -f src/../lib/x.ts" })
  const v = validateDerivation({
    derivation: d,
    prompt: "verify src/../lib/x.ts",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("C")
})

test("leading ./ and trailing / are normalized for the verbatim-in-prompt check only", () => {
  const d = mkDerivation({ check: "test -d ./src/utils/" })
  const v = validateDerivation({
    derivation: d,
    prompt: "look at src/utils",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("C")
})

test("glob token must appear verbatim in the prompt", () => {
  const d = mkDerivation({ check: "ls src/*.ts" })
  const ok = validateDerivation({
    derivation: d,
    prompt: "list src/*.ts",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(ok.class).toBe("C")

  const fail = validateDerivation({
    derivation: d,
    prompt: "list the files",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(fail.class).toBe("D")
  expect(fail.downgraded?.rule).toBe("path-not-in-prompt")
})

test("case-sensitive verbatim match: readme.md != README.md → D", () => {
  const d = mkDerivation({ check: "test -f readme.md" })
  const v = validateDerivation({
    derivation: d,
    prompt: "check README.md",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("D")
  expect(v.downgraded?.rule).toBe("path-not-in-prompt")
})

// ── step 5: word-boundary fix (finding #2, 2026-07-29 fix pass) ─────────
// A plain substring match is not enough: "a.ts" must not match inside
// "thisisnota.tsfile", "app.js" must not match inside "webapp.jsx". A match
// only counts when both flanking characters (or a string edge) are
// non-alphanumeric-non-underscore.

test("verbatim-in-prompt requires a token boundary: 'a.ts' inside 'thisisnota.tsfile' does not count", () => {
  const d = mkDerivation({ check: "test -f a.ts" })
  const v = validateDerivation({
    derivation: d,
    prompt: "look at thisisnota.tsfile carefully",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("D")
  expect(v.downgraded?.rule).toBe("path-not-in-prompt")
})

test("verbatim-in-prompt requires a token boundary: 'app.js' inside 'webapp.jsx' does not count", () => {
  const d = mkDerivation({ check: "test -f app.js" })
  const v = validateDerivation({
    derivation: d,
    prompt: "check that webapp.jsx renders",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("D")
  expect(v.downgraded?.rule).toBe("path-not-in-prompt")
})

// Deferred minor from the Task-1 fix pass (2026-07-29): tokenInPrompt scans
// ALL occurrences, not just the first — a bad-flank hit earlier in the
// prompt must not short-circuit a later boundary-clean hit.
test("multi-occurrence: first occurrence has a bad flank, second occurrence is clean → C", () => {
  const d = mkDerivation({ check: "test -f a.ts" })
  const v = validateDerivation({
    derivation: d,
    prompt: "thisisnota.tsfile isn't real, but a.ts is",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("C")
  expect(v.downgraded).toBeUndefined()
})

test("verbatim-in-prompt: a sentence-final period is a valid boundary", () => {
  const d = mkDerivation({ check: "test -f done.txt" })
  const v = validateDerivation({
    derivation: d,
    prompt: "please create done.txt.",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("C")
})

test("quoted path with a space is one token, checked verbatim", () => {
  const d = mkDerivation({ check: 'test -f "my dir/file.txt"' })
  const v = validateDerivation({
    derivation: d,
    prompt: 'check "my dir/file.txt" exists',
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("C")
})

test("/dev/null-only check has zero remaining path tokens → D no-path-reference", () => {
  const d = mkDerivation({ check: "test -w /dev/null" })
  const v = validateDerivation({
    derivation: d,
    prompt: "check /dev/null is writable",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("D")
  expect(v.downgraded?.rule).toBe("no-path-reference")
})

test("two offending tokens: only the first (in check order) is recorded", () => {
  const d = mkDerivation({ check: "diff a/missing.ts b/other-missing.ts" })
  const v = validateDerivation({
    derivation: d,
    prompt: "compare the two files",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("D")
  expect(v.downgraded?.rule).toBe("path-not-in-prompt")
  expect(v.downgraded?.token).toBe("a/missing.ts")
})

// ── step 3.5: zero-path-token vacuous-C hole ────────────────────────────

test("made-up extension-less dir name → zero path tokens → D no-path-reference", () => {
  const d = mkDerivation({ check: "cd made-up-dir && bun test" })
  const v = validateDerivation({
    derivation: d,
    prompt: "run the tests in made-up-dir",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("D")
  expect(v.downgraded?.rule).toBe("no-path-reference")
})

// ── step 2: C with null check ────────────────────────────────────────────

test("class C with null check → D missing-check", () => {
  const d = mkDerivation({ class: "C", check: null })
  const v = validateDerivation({
    derivation: d,
    prompt: "do something",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("D")
  expect(v.downgraded?.rule).toBe("missing-check")
  expect(v.downgraded?.fromCheck).toBeNull()
  expect(v.reason).toBe("not-extractable")
})

// ── step 1: non-C with check ─────────────────────────────────────────────

test("non-C class with a check attached: class kept, check stripped, rule check-outside-class-c", () => {
  const d = mkDerivation({ class: "A2", check: "bun test", reason: null })
  const v = validateDerivation({
    derivation: d,
    prompt: "look into this",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("A2")
  expect(v.check).toBeNull()
  expect(v.downgraded?.rule).toBe("check-outside-class-c")
  expect(v.downgraded?.fromCheck).toBe("bun test")
  expect(v.reason).toBe("not-shell-checkable")
})

// ── step 8: final invariant normalization (guard-safe out-of-repo read) ─

test("guard-safe out-of-repo read named in prompt → D out-of-scope, check nulled (step-8 invariant)", () => {
  const d = mkDerivation({ check: "cat ~/.ssh/id_rsa" })
  const v = validateDerivation({
    derivation: d,
    prompt: "check the contents of ~/.ssh/id_rsa",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("D")
  expect(v.downgraded?.rule).toBe("out-of-scope")
  expect(v.check).toBeNull()
  expect(v.downgraded?.fromCheck).toBe("cat ~/.ssh/id_rsa")
})

// ── step 3: B-screen ─────────────────────────────────────────────────────

test("B-screen B2' exception: scoped subset check naming a prompt file stays C", () => {
  const d = mkDerivation({ check: "cd cc-gate-plugin && bun test test/x.test.ts" })
  const v = validateDerivation({
    derivation: d,
    prompt: "make sure test/x.test.ts passes",
    floorCheck: FLOOR,
    repoRoot: REPO,
  })
  expect(v.class).toBe("C")
  expect(v.check).toBe("cd cc-gate-plugin && bun test test/x.test.ts")
})

test("B-screen fires when the scoped file isn't named in the prompt", () => {
  const d = mkDerivation({ check: "cd cc-gate-plugin && bun test test/x.test.ts" })
  const v = validateDerivation({
    derivation: d,
    prompt: "fix the auth bug",
    floorCheck: FLOOR,
    repoRoot: REPO,
  })
  expect(v.class).toBe("B")
  expect(v.downgraded?.rule).toBe("b-keyword")
  expect(v.check).toBeNull()
  expect(v.reason).toBe("floor-covered")
})

test("B-screen fires on bare floor-verb reuse with no scoping", () => {
  const d = mkDerivation({ check: "cd cc-gate-plugin && bun test" })
  const v = validateDerivation({
    derivation: d,
    prompt: "fix the auth bug",
    floorCheck: FLOOR,
    repoRoot: REPO,
  })
  expect(v.class).toBe("B")
  expect(v.downgraded?.rule).toBe("b-keyword")
})

test("directory-level cd scoping alone does NOT count as B2' scoping: cd <dir> in prompt still fires B", () => {
  // Fix-pass finding #1: a bare `cd sub/dir && bun test` verifies nothing
  // beyond the floor even though "sub/dir" is itself a real, prompt-named,
  // in-repo path — the B2' exception requires a scoping token BEYOND the
  // cd target.
  const d = mkDerivation({ check: "cd sub/dir && bun test" })
  const v = validateDerivation({
    derivation: d,
    prompt: "run the tests in sub/dir",
    floorCheck: FLOOR,
    repoRoot: REPO,
  })
  expect(v.class).toBe("B")
  expect(v.downgraded?.rule).toBe("b-keyword")
  expect(v.reason).toBe("floor-covered")
})

test("cd <dir> PLUS a real scoping token beyond it (both named in prompt) → stays C", () => {
  const d = mkDerivation({ check: "cd sub/dir && bun test test/x.test.ts" })
  const v = validateDerivation({
    derivation: d,
    prompt: "run the tests in sub/dir, specifically test/x.test.ts",
    floorCheck: FLOOR,
    repoRoot: REPO,
  })
  expect(v.class).toBe("C")
  expect(v.check).toBe("cd sub/dir && bun test test/x.test.ts")
})

test("derived check containing the full floorCheck verbatim → B", () => {
  const d = mkDerivation({ check: `echo before; ${FLOOR}` })
  const v = validateDerivation({
    derivation: d,
    prompt: "run the whole floor",
    floorCheck: FLOOR,
    repoRoot: REPO,
  })
  expect(v.class).toBe("B")
  expect(v.downgraded?.rule).toBe("b-keyword")
})

test("phrase screen fires on goalSummary 'make the tests pass' with an unrelated check", () => {
  const d = mkDerivation({ goalSummary: "make the tests pass", check: "test -f src/a.ts" })
  const v = validateDerivation({
    derivation: d,
    prompt: "src/a.ts should exist and make the tests pass",
    floorCheck: FLOOR,
    repoRoot: REPO,
  })
  expect(v.class).toBe("B")
  expect(v.downgraded?.rule).toBe("b-keyword")
  expect(v.check).toBeNull()
})

test("phrase present only in the raw prompt (not goalSummary/criteria) doesn't fire the phrase screen", () => {
  const d = mkDerivation({
    goalSummary: "add a retry wrapper around the fetcher",
    criteria: ["src/a.ts gains a retry wrapper"],
    check: "test -f src/a.ts",
  })
  const v = validateDerivation({
    derivation: d,
    prompt: "add a retry wrapper around the fetcher in src/a.ts; afterwards make the tests pass",
    floorCheck: FLOOR,
    repoRoot: REPO,
  })
  expect(v.class).toBe("C")
})

test("floorCheck='' skips the floor-head branch entirely, but the phrase screen stays active", () => {
  const headOnly = mkDerivation({ check: "cd cc-gate-plugin && bun test" })
  const vHead = validateDerivation({
    derivation: headOnly,
    prompt: "fix the auth bug",
    floorCheck: "",
    repoRoot: REPO,
  })
  // No floor armed → head branch inert; the bare check also has zero path
  // tokens, so it falls through specifically to no-path-reference (not
  // b-keyword, and not any other rule).
  expect(vHead.downgraded?.rule).toBe("no-path-reference")

  const phrase = mkDerivation({ goalSummary: "make the tests pass", check: "test -f src/a.ts" })
  const vPhrase = validateDerivation({
    derivation: phrase,
    prompt: "src/a.ts should exist",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(vPhrase.class).toBe("B")
  expect(vPhrase.downgraded?.rule).toBe("b-keyword")
})

// ── horizon (step 7) ──────────────────────────────────────────────────────

test("horizon: multi-turn preserved through a clean C validation", () => {
  const d = mkDerivation({ check: "test -f src/a.ts", horizon: "multi-turn" })
  const v = validateDerivation({
    derivation: d,
    prompt: "src/a.ts must exist",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("C")
  expect(v.horizon).toBe("multi-turn")
})

test("horizon: null (already-normalized-invalid) defaults to single-turn at step 7", () => {
  const d = mkDerivation({ check: "test -f src/a.ts", horizon: null })
  const v = validateDerivation({
    derivation: d,
    prompt: "src/a.ts must exist",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("C")
  expect(v.horizon).toBe("single-turn")
})

// ── reason canonicalization (step 0) — never trust model free text ──────

test("class A1 passes straight through with canonical reason, no downgrade", () => {
  const d = mkDerivation({ class: "A1", check: null, reason: "whatever the model said" })
  const v = validateDerivation({
    derivation: d,
    prompt: "hi there",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("A1")
  expect(v.reason).toBe("no-eval-needed")
  expect(v.downgraded).toBeUndefined()
})

test("class D declared directly by the model (no downgrade) canonicalizes to not-extractable", () => {
  const d = mkDerivation({ class: "D", check: null, reason: "out-of-scope" })
  const v = validateDerivation({
    derivation: d,
    prompt: "look at something external",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("D")
  expect(v.reason).toBe("not-extractable")
  expect(v.downgraded).toBeUndefined()
})

test("class B passes straight through with canonical floor-covered reason", () => {
  const d = mkDerivation({ class: "B", check: null, reason: "model prose" })
  const v = validateDerivation({
    derivation: d,
    prompt: "fix the failing tests",
    floorCheck: "",
    repoRoot: REPO,
  })
  expect(v.class).toBe("B")
  expect(v.reason).toBe("floor-covered")
})
