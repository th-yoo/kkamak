import { describe, expect, test } from "bun:test"
import { composeBlockMessage, MAX_EVIDENCE_BYTES, truncateEvidence } from "../src/adapters/shared/framing.ts"

const block = (over: Partial<{ evidence: string; round: number; roundsMax: number }> = {}) =>
  ({ kind: "block" as const, evidence: "2 tests failed", round: 1, roundsMax: 2, ...over })

describe("composeBlockMessage", () => {
  test("says the work is not done", () => {
    expect(composeBlockMessage(block()).toLowerCase()).toContain("not done")
  })

  test("includes the check output verbatim", () => {
    expect(composeBlockMessage(block({ evidence: "FAIL src/a.test.ts" }))).toContain("FAIL src/a.test.ts")
  })

  test("states which round this is", () => {
    const message = composeBlockMessage(block({ round: 2, roundsMax: 3 }))
    expect(message).toContain("2")
    expect(message).toContain("3")
  })

  // The agent must fix the failure, not run the check itself — a second
  // concurrent run of the suite is wasted work and confuses the transcript.
  test("tells the agent not to run the check itself", () => {
    expect(composeBlockMessage(block()).toLowerCase()).toContain("do not run it yourself")
  })

  test("names the repository as the source of the check, not the assistant", () => {
    expect(composeBlockMessage(block()).toLowerCase()).toContain("gate.json")
  })

  test("truncates oversized evidence and says so", () => {
    const message = composeBlockMessage(block({ evidence: "x".repeat(MAX_EVIDENCE_BYTES * 2) }))
    expect(message.length).toBeLessThan(MAX_EVIDENCE_BYTES * 1.5)
    expect(message.toLowerCase()).toContain("truncated")
  })
})

describe("truncateEvidence", () => {
  test("leaves short evidence alone", () => {
    expect(truncateEvidence("short")).toBe("short")
  })

  test("keeps the tail, where a test runner puts its summary", () => {
    const evidence = `${"a".repeat(MAX_EVIDENCE_BYTES)}THE-SUMMARY`
    expect(truncateEvidence(evidence)).toContain("THE-SUMMARY")
  })

  test("caps the result", () => {
    const out = truncateEvidence("x".repeat(MAX_EVIDENCE_BYTES * 3))
    expect(out.length).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES + 200)
  })

  test("respects the byte cap with multi-byte UTF-8 characters", () => {
    // ✓ is 3 bytes in UTF-8, 1 code unit in .length
    const evidence = "✓".repeat(MAX_EVIDENCE_BYTES)
    const truncated = truncateEvidence(evidence)
    const byteLength = Buffer.byteLength(truncated, "utf8")
    expect(byteLength).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES + 200)
  })

  test("returns unchanged when multi-byte evidence fits the byte cap", () => {
    // 5000 code units of ✓ = 15000 UTF-8 bytes, fits under 16000
    const evidence = "✓".repeat(5000)
    const truncated = truncateEvidence(evidence)
    expect(truncated).toBe(evidence)
  })

  test("never produces a replacement character when cutting multi-byte text", () => {
    const evidence = "✓".repeat(MAX_EVIDENCE_BYTES)
    const truncated = truncateEvidence(evidence)
    expect(truncated).not.toContain("�")
  })
})

describe("composeBlockMessage with multi-byte UTF-8", () => {
  test("keeps composed message within byte budget for multi-byte evidence", () => {
    const evidence = "✓".repeat(MAX_EVIDENCE_BYTES)
    const message = composeBlockMessage(block({ evidence }))
    const byteLength = Buffer.byteLength(message, "utf8")
    // Message includes the evidence plus framing text, but should stay reasonable
    expect(byteLength).toBeLessThan(MAX_EVIDENCE_BYTES * 1.5)
  })

  test("composed message with multi-byte evidence has no replacement characters", () => {
    const evidence = "✓".repeat(MAX_EVIDENCE_BYTES)
    const message = composeBlockMessage(block({ evidence }))
    expect(message).not.toContain("�")
  })
})
