// A1: the test-path HEURISTIC. A text pattern standing in for real analysis —
// these tests pin both what it matches and, just as deliberately, what it
// must not (substring traps like "latest.ts" or "src/contest/"). It informs
// telemetry only; gate.test.ts pins that it never influences a decision.
import { describe, expect, test } from "bun:test"
import { DEFAULT_TEST_PATH_PATTERN, isTestPath } from "../src/kernel/classify.ts"

describe("isTestPath with the default pattern", () => {
  test.each([
    "test/gate.test.ts",
    "tests/helpers.py",
    "spec/models/user_spec.rb",
    "specs/api.js",
    "src/__tests__/button.tsx",
    "src/gate.test.ts",
    "src/components/Button.spec.tsx",
    "pkg/store_test.go",
    "lib/parser-test.js",
    "deep/nested/test/fixture-loader.ts",
  ])("classifies %s as a test path", (path) => {
    expect(isTestPath(path, DEFAULT_TEST_PATH_PATTERN)).toBe(true)
  })

  test.each([
    "src/kernel/gate.ts",
    "src/latest.ts",
    "src/contest/entry.ts",
    "docs/protest-notes.md",
    "src/attestation.ts",
    "README.md",
    "src/spectrum.ts",
    "testimony/record.ts",
  ])("classifies %s as NOT a test path", (path) => {
    expect(isTestPath(path, DEFAULT_TEST_PATH_PATTERN)).toBe(false)
  })

  test("is case-insensitive, matching e.g. C# Tests/ conventions", () => {
    expect(isTestPath("Tests/UnitTest1.cs", DEFAULT_TEST_PATH_PATTERN)).toBe(true)
  })

  test("treats backslashes as separators, so Windows paths classify the same", () => {
    expect(isTestPath("src\\__tests__\\button.tsx", DEFAULT_TEST_PATH_PATTERN)).toBe(true)
    expect(isTestPath("src\\kernel\\gate.ts", DEFAULT_TEST_PATH_PATTERN)).toBe(false)
  })
})

describe("isTestPath with a custom pattern", () => {
  test("uses the supplied pattern instead of the default", () => {
    expect(isTestPath("checks/foo.ts", "(^|/)checks(/|$)")).toBe(true)
    expect(isTestPath("test/foo.test.ts", "(^|/)checks(/|$)")).toBe(false)
  })

  // Never-throw discipline: config.ts refuses to store an uncompilable
  // pattern, but this function is the last line and must hold on its own.
  test("falls back to the default on an uncompilable pattern rather than throwing", () => {
    expect(isTestPath("test/gate.test.ts", "([")).toBe(true)
    expect(isTestPath("src/kernel/gate.ts", "([")).toBe(false)
  })
})
