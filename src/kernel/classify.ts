// A1: test-path classification for cycle tagging.
//
// HEURISTIC, and named as one on purpose: a text pattern over the path string
// standing in for real analysis, structurally the same shape as the import
// scanner's comment-matching false positive already on record
// (docs/known-issues.md #9). The decisive difference is that this one NEVER
// BLOCKS: it feeds only the derived telemetry booleans
// (`SensorLine.implOnly`/`sameTurnCoEdit`), so a mislabel costs a wrong
// telemetry field, not a wrongly-blocked turn. It must never influence any
// gate decision — gate.ts consults it exclusively while building sensor
// lines, and a test pins that.
//
// PURE: imports nothing, throws never.

/**
 * Default pattern, matched case-insensitively against the whole path with
 * backslashes normalised to `/`. Two alternatives:
 *
 * - a path segment that IS a test directory by convention: `test`, `tests`,
 *   `spec`, `specs`, `__tests__` — segment-exact, so `contest/` or
 *   `testimony/` do not match;
 * - a filename whose extension is preceded by a `.`/`_`/`-`-separated
 *   `test`/`spec` marker: `foo.test.ts`, `Button.spec.tsx`, `store_test.go`,
 *   `parser-test.js` — separator-anchored, so `latest.ts` or
 *   `attestation.ts` do not match.
 */
export const DEFAULT_TEST_PATH_PATTERN =
  "(^|/)(tests?|specs?|__tests__)(/|$)|[._-](test|spec)s?\\.[^/]*$"

/**
 * Whether `path` looks like a test file under `pattern` (a regex source
 * string, applied case-insensitively). Never throws: an uncompilable pattern
 * falls back to `DEFAULT_TEST_PATH_PATTERN` — config.ts already refuses to
 * store one, but this function is the last line and holds on its own.
 */
export function isTestPath(path: string, pattern: string): boolean {
  const normalized = path.replaceAll("\\", "/")
  let re: RegExp
  try {
    re = new RegExp(pattern, "i")
  } catch {
    re = new RegExp(DEFAULT_TEST_PATH_PATTERN, "i")
  }
  return re.test(normalized)
}
