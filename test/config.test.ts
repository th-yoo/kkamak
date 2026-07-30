import { describe, expect, test } from "bun:test"
import { DEFAULT_CHECK_TIMEOUT_MS, DEFAULT_ROUNDS, DEFAULT_SENSOR_PATH, parseGateConfig } from "../src/kernel/config.ts"

describe("parseGateConfig", () => {
  test("parses a minimal config and fills defaults", () => {
    const cfg = parseGateConfig('{"check":"bun test"}')
    expect(cfg).toEqual({
      check: "bun test",
      rounds: DEFAULT_ROUNDS,
      sensor: DEFAULT_SENSOR_PATH,
      checkTimeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
    })
  })

  test("defaults are rounds 2, .km/gate-outcomes.ndjson, 300s", () => {
    expect(DEFAULT_ROUNDS).toBe(2)
    expect(DEFAULT_SENSOR_PATH).toBe(".km/gate-outcomes.ndjson")
    expect(DEFAULT_CHECK_TIMEOUT_MS).toBe(300_000)
  })

  test("honours every explicit field", () => {
    const cfg = parseGateConfig(
      '{"check":"npm test","rounds":5,"sensor":"logs/x.ndjson","checkTimeoutMs":1000}',
    )
    expect(cfg).toEqual({
      check: "npm test",
      rounds: 5,
      sensor: "logs/x.ndjson",
      checkTimeoutMs: 1000,
    })
  })

  test("rounds 0 is legal — observe-only mode", () => {
    expect(parseGateConfig('{"check":"x","rounds":0}')?.rounds).toBe(0)
  })

  // Every rejection below must yield undefined, which no-ops the gate rather
  // than wedging it. This is the fail-open contract at the config layer.
  test.each([
    ["undefined input", undefined],
    ["empty string", ""],
    ["not JSON", "{oops"],
    ["JSON null", "null"],
    ["JSON array", "[]"],
    ["JSON string", '"bun test"'],
    ["JSON number", "42"],
    ["no check key", '{"rounds":2}'],
    ["empty check", '{"check":""}'],
    ["whitespace-only check", '{"check":"   "}'],
    ["non-string check", '{"check":123}'],
    ["null check", '{"check":null}'],
  ])("returns undefined for %s", (_label, raw) => {
    expect(parseGateConfig(raw as string | undefined)).toBeUndefined()
  })

  // A bad numeric field falls back to its default instead of rejecting the
  // whole config: the check command is the part that matters.
  test.each([
    ["negative", '{"check":"x","rounds":-1}'],
    ["fractional", '{"check":"x","rounds":1.5}'],
    ["NaN-ish string", '{"check":"x","rounds":"2"}'],
    ["infinite", '{"check":"x","rounds":1e999}'],
  ])("falls back to the default rounds for a %s value", (_label, raw) => {
    expect(parseGateConfig(raw)?.rounds).toBe(DEFAULT_ROUNDS)
  })

  test.each([
    ["zero", '{"check":"x","checkTimeoutMs":0}'],
    ["negative", '{"check":"x","checkTimeoutMs":-5}'],
    ["non-numeric", '{"check":"x","checkTimeoutMs":"soon"}'],
  ])("falls back to the default timeout for a %s value", (_label, raw) => {
    expect(parseGateConfig(raw)?.checkTimeoutMs).toBe(DEFAULT_CHECK_TIMEOUT_MS)
  })

  test("falls back to the default sensor path for a non-string value", () => {
    expect(parseGateConfig('{"check":"x","sensor":7}')?.sensor).toBe(DEFAULT_SENSOR_PATH)
  })

  test("ignores unknown keys rather than rejecting", () => {
    const cfg = parseGateConfig('{"check":"x","futureFlag":true}')
    expect(cfg?.check).toBe("x")
    expect(cfg).not.toHaveProperty("futureFlag")
  })

  test("trims the check command", () => {
    expect(parseGateConfig('{"check":"  bun test  "}')?.check).toBe("bun test")
  })
})
