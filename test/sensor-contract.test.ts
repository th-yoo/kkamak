// sensor-contract.test.ts — Phase 0 Task 1 (2026-07-30 phase0-contract-events
// plan, ~/z2/meta-harness). Guards the drift that made this kernel's
// emitted sensor lines invisible to km-crank: sessionId (wrong casing), no
// marker field, and a "passed"/"failed" rounds vocabulary the consumer's
// parser does not recognise (it expects "verify-failed"/"accepted").
//
// Counterpart (byte-parity checked against the fixture below): the frozen
// vector lines are authored in meta-harness's
// km-crank/test/sensor-contract.test.ts (embedded VECTOR_LINES there). D2
// (ratified in meta-harness docs/superpowers/plans/2026-07-30-phase0-contract-events.md):
// this file's counterpart, test/fixtures/sensor-contract.ndjson, is the
// canonical/publishable copy, authored by copying those four lines
// byte-for-byte. IMPORTANT: that .ndjson file intentionally carries NO
// header comment of its own — the meta-harness parity test does a raw
// string compare (`VECTOR_LINES.join("\n") + "\n"` against the file's exact
// bytes, no comment-stripping), so a comment line inside the fixture would
// break the one thing D2 requires it to get exactly right. This header
// comment lives here instead, attached to the fixture from the outside.
//
// Required field truth (from the frozen contract, cross-checked against the
// vector lines): ts, sessionID, check, accepted, gateExhausted, interrupted,
// rounds, durationMs, host, app, marker. Optional and tolerated-absent:
// checkMs, pluginVersion, forced, skippedStop. D1 (closed, packaging
// milestone): pluginVersion and forced are adopted into this kernel's
// emission path (src/kernel/sensor.ts). This kernel always knows its own
// version, so pluginVersion is now stamped on every line; forced has no
// applicable mechanism here (the frozen contract scopes it to
// KKAMAK_REINJECT, which this kernel does not implement), so it stays
// absent in practice even though the plumbing exists. This file now
// asserts contract-conformant shape for both — present-and-typed or
// absent, per the contract's own tolerated-absent optionality — rather
// than a blanket ban on their presence.

import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { createGate } from "../src/kernel/gate.ts"
import { KERNEL_VERSION } from "../src/kernel/sensor.ts"
import type { RoundOutcome } from "../src/kernel/ports.ts"
import { FAIL, FakeClock, makeHarness, PASS } from "./fakes.ts"

const REQUIRED_FIELDS = [
  "ts",
  "sessionID",
  "check",
  "accepted",
  "gateExhausted",
  "interrupted",
  "rounds",
  "durationMs",
  "host",
  "app",
  "marker",
] as const

const ROUND_VOCAB: readonly RoundOutcome[] = ["verify-failed", "accepted"]

/**
 * Locates each named vector's string literal inside the meta-harness
 * counterpart source. Throws if the counterpart exists but a name can't be
 * found — a reformat of the counterpart must disarm the guard loudly, not
 * silently pass. Absence of the counterpart file itself is handled by the
 * caller (existsSync check), not here.
 */
function locateVectorLines(src: string, names: readonly string[]): string[] {
  const lines: string[] = []
  for (const name of names) {
    const re = new RegExp(`${name}\\s*=\\s*\\n?\\s*'([^']*)'`)
    const m = src.match(re)
    if (!m) {
      throw new Error(`could not locate ${name} in counterpart source`)
    }
    lines.push(m[1]!)
  }
  return lines
}

/**
 * Schema-level conformance: required fields present with the right types and
 * casing, rounds drawn from the frozen vocabulary, and the D1-deferred
 * optionals absent. This is NOT a byte-compare against the golden vectors —
 * a driven kernel run has its own timestamps/session ids/host info, so it
 * cannot equal the static fixture. It proves the same *shape* the vectors
 * assert.
 */
function assertConformsToSensorContract(line: Record<string, unknown>): void {
  for (const field of REQUIRED_FIELDS) {
    expect(line).toHaveProperty(field)
  }

  expect(typeof line.ts).toBe("number")
  expect(typeof line.sessionID).toBe("string")
  expect(typeof line.check).toBe("string")
  expect(typeof line.accepted).toBe("boolean")
  expect(typeof line.gateExhausted).toBe("boolean")
  expect(typeof line.interrupted).toBe("boolean")
  expect(typeof line.durationMs).toBe("number")
  expect(typeof line.host).toBe("string")
  expect(typeof line.app).toBe("string")
  expect(typeof line.marker).toBe("boolean")

  expect(Array.isArray(line.rounds)).toBe(true)
  for (const round of line.rounds as unknown[]) {
    expect(ROUND_VOCAB).toContain(round as RoundOutcome)
  }

  // The exact drift this whole file guards: the old casing must never
  // reappear alongside the correct field.
  expect(line).not.toHaveProperty("sessionId")

  if ("checkMs" in line) {
    expect(Array.isArray(line.checkMs)).toBe(true)
  }
  if ("skippedStop" in line) {
    expect(typeof line.skippedStop).toBe("boolean")
  }

  // D1 (closed): pluginVersion is always stamped by this kernel — asserted
  // present, not merely tolerated, because that is this kernel's actual
  // emission behavior (the frozen contract only requires tolerating absence
  // from producers that can't determine their own version).
  expect(typeof line.pluginVersion).toBe("string")
  expect(line.pluginVersion).toBe(KERNEL_VERSION)
  // forced has no applicable mechanism in this kernel (see header comment),
  // so it stays absent — but a future producer that does set it must still
  // conform to the contract's type.
  if ("forced" in line) {
    expect(typeof line.forced).toBe("boolean")
  }
}

describe("sensor contract: driven-kernel emission conforms to the frozen SensorLine", () => {
  // 1. Clean accept: single round, no failures — mirrors the vectors' CLEAN_ACCEPT shape.
  test("clean accept", async () => {
    const h = makeHarness({ script: [PASS], clock: new FakeClock(1_000, 500) })
    const gate = createGate(h.host)
    await gate.handle({ kind: "file-edited", sessionID: "sess-clean" })
    const decision = await gate.handle({ kind: "stop-requested", sessionID: "sess-clean" })

    expect(decision).toEqual({ kind: "allow" })
    expect(h.sensor.lines).toHaveLength(1)
    const line = h.sensor.lines[0]! as unknown as Record<string, unknown>
    assertConformsToSensorContract(line)
    expect(line.rounds).toEqual(["accepted"])
    expect(line.accepted).toBe(true)
    expect(line.gateExhausted).toBe(false)
    expect(line.marker).toBe(false)
  })

  // 1b. Same shape, gate.json's hygiene-marker toggle on: real semantics
  // (meta-harness cc-gate-plugin src/core/stop.ts, README — a same-cycle
  // accept-time context injection, NOT session-carryover) fire it only on a
  // clean accept.
  test("clean accept with the hygiene marker enabled", async () => {
    const h = makeHarness({
      raw: '{"check":"bun test","marker":true}',
      script: [PASS],
      clock: new FakeClock(1_000, 500),
    })
    const gate = createGate(h.host)
    await gate.handle({ kind: "file-edited", sessionID: "sess-clean-marker" })
    const decision = await gate.handle({ kind: "stop-requested", sessionID: "sess-clean-marker" })

    expect(decision.kind).toBe("allow")
    expect((decision as { marker?: string }).marker).toBeString()
    expect(h.sensor.lines).toHaveLength(1)
    const line = h.sensor.lines[0]! as unknown as Record<string, unknown>
    assertConformsToSensorContract(line)
    expect(line.marker).toBe(true)
  })

  // 2. Catch: a block round then a fix — mirrors CATCH_BLOCK_THEN_FIX.
  test("catch: block then fix", async () => {
    const h = makeHarness({ script: [FAIL, PASS], clock: new FakeClock(1_000, 500) })
    const gate = createGate(h.host)
    await gate.handle({ kind: "file-edited", sessionID: "sess-catch" })
    await gate.handle({ kind: "stop-requested", sessionID: "sess-catch" }) // blocks
    const decision = await gate.handle({ kind: "stop-requested", sessionID: "sess-catch" })

    expect(decision).toEqual({ kind: "allow" })
    expect(h.sensor.lines).toHaveLength(1)
    const line = h.sensor.lines[0]! as unknown as Record<string, unknown>
    assertConformsToSensorContract(line)
    expect(line.rounds).toEqual(["verify-failed", "accepted"])
  })

  // 3. Exhausted: rounds budget spent — mirrors EXHAUSTED.
  test("exhausted", async () => {
    // marker:true on purpose — proves the exhaustion override actually
    // fires, not just that the default happens to be false.
    const h = makeHarness({
      raw: '{"check":"bun test","marker":true}',
      fallback: FAIL,
      clock: new FakeClock(1_000, 500),
    })
    const gate = createGate(h.host)
    await gate.handle({ kind: "file-edited", sessionID: "sess-exhausted" })
    await gate.handle({ kind: "stop-requested", sessionID: "sess-exhausted" }) // block 1
    await gate.handle({ kind: "stop-requested", sessionID: "sess-exhausted" }) // block 2
    const decision = await gate.handle({ kind: "stop-requested", sessionID: "sess-exhausted" }) // exhausted

    expect(decision.kind).toBe("allow")
    expect((decision as { marker?: string }).marker).toBeUndefined()
    expect(h.sensor.lines).toHaveLength(1)
    const line = h.sensor.lines[0]! as unknown as Record<string, unknown>
    assertConformsToSensorContract(line)
    expect(line.gateExhausted).toBe(true)
    expect(line.rounds).toEqual(["verify-failed", "verify-failed", "verify-failed"])
    // stop.ts's rule on the frozen contract's side: marker must never fire on
    // exhaustion, even with the config toggle on (proven above, not assumed).
    expect(line.marker).toBe(false)
  })

  // 4. skippedStop-shaped diagnostic — mirrors SKIPPED_STOP_DIAGNOSTIC.
  test("skippedStop diagnostic", async () => {
    const h = makeHarness({ fallback: FAIL, clock: new FakeClock(1_000, 500) })
    const gate = createGate(h.host)
    await gate.handle({ kind: "file-edited", sessionID: "sess-skipped" })
    const decision = await gate.handle({ kind: "new-user-prompt", sessionID: "sess-skipped" })

    expect(decision).toEqual({ kind: "allow" })
    expect(h.sensor.lines).toHaveLength(1)
    const line = h.sensor.lines[0]! as unknown as Record<string, unknown>
    assertConformsToSensorContract(line)
    expect(line.skippedStop).toBe(true)
    expect(line.rounds).toEqual([])
    expect(line.durationMs).toBe(0)
  })
})

describe("sensor contract: golden vector fixture", () => {
  const FIXTURE = path.join(import.meta.dir, "fixtures", "sensor-contract.ndjson")

  test("fixture file exists", () => {
    expect(existsSync(FIXTURE)).toBe(true)
  })

  test("every fixture line is well-formed JSON conforming to the required-field schema", () => {
    const text = readFileSync(FIXTURE, "utf-8")
    const lines = text.split("\n").filter((l) => l.length > 0)
    expect(lines).toHaveLength(4)
    for (const raw of lines) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const field of REQUIRED_FIELDS) {
        expect(parsed).toHaveProperty(field)
      }
      expect(Array.isArray(parsed.rounds)).toBe(true)
      for (const round of parsed.rounds as unknown[]) {
        expect(ROUND_VOCAB).toContain(round as RoundOutcome)
      }
    }
  })

  // Advisory, mirroring the check meta-harness's own parity test does in the
  // other direction (D2). Not authoritative here — the meta-harness test is
  // — but a local guard is cheap and fails loudly on the same drift.
  //
  // Skip vs. fail distinction is deliberate: counterpart file ABSENT (public
  // standalone checkout, no meta-harness sibling) is not a failure — skip.
  // Counterpart file PRESENT but a vector name unlocatable means the
  // counterpart was reformatted out from under this guard — that must FAIL,
  // not silently pass, or the guard is disarmed while still reporting green.
  test("fixture byte-matches the meta-harness counterpart when present", () => {
    const counterpart = path.join(
      import.meta.dir,
      "..",
      "..",
      "meta-harness",
      "km-crank",
      "test",
      "sensor-contract.test.ts",
    )
    if (!existsSync(counterpart)) {
      console.log(`[sensor-contract] advisory check SKIPPED: ${counterpart} not found. Not a failure.`)
      return
    }
    const src = readFileSync(counterpart, "utf-8")
    const names = ["CLEAN_ACCEPT", "CATCH_BLOCK_THEN_FIX", "EXHAUSTED", "SKIPPED_STOP_DIAGNOSTIC"]
    const lines = locateVectorLines(src, names)
    const theirs = lines.join("\n") + "\n"
    const ours = readFileSync(FIXTURE, "utf-8")
    expect(ours).toBe(theirs)
  })
})

describe("locateVectorLines: guards the advisory check from silently disarming", () => {
  test("throws when a vector name cannot be located in the counterpart source", () => {
    const src = `const CLEAN_ACCEPT =\n  '{"a":1}'\nconst OTHER = 'x'\n`
    expect(() => locateVectorLines(src, ["CLEAN_ACCEPT", "MISSING_NAME"])).toThrow(
      /could not locate MISSING_NAME/,
    )
  })

  test("returns matched string literals in requested order when all names are present", () => {
    const src = `const B =\n  'second'\nconst A =\n  'first'\n`
    expect(locateVectorLines(src, ["A", "B"])).toEqual(["first", "second"])
  })
})
