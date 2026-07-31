import { describe, expect, test } from "bun:test"
import { EDIT_TOOLS, HOOK_EVENTS, parseHookInput } from "../src/adapters/claude-code/hook-input.ts"
import { planEmit } from "../src/adapters/claude-code/emit.ts"

const payload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: "s-1", cwd: "/repo", hook_event_name: "Stop", ...over })

describe("parseHookInput", () => {
  test("maps Stop to stop-requested", () => {
    const parsed = parseHookInput(payload(), "Stop")
    expect(parsed).toEqual({ event: { kind: "stop-requested", sessionID: "s-1" }, root: "/repo" })
  })

  test("maps UserPromptSubmit to new-user-prompt", () => {
    const parsed = parseHookInput(payload({ hook_event_name: "UserPromptSubmit" }), "UserPromptSubmit")
    expect(parsed?.event.kind).toBe("new-user-prompt")
  })

  test.each(EDIT_TOOLS)("maps PostToolUse on %s to file-edited", (tool) => {
    const parsed = parseHookInput(payload({ tool_name: tool }), "PostToolUse")
    expect(parsed?.event.kind).toBe("file-edited")
  })

  // A non-editing tool must not arm the gate, even if the matcher lets it through.
  test.each(["Read", "Bash", "Grep", "edit", "WRITE"])("ignores PostToolUse on %s", (tool) => {
    expect(parseHookInput(payload({ tool_name: tool }), "PostToolUse")).toBeUndefined()
  })

  test.each([
    ["not JSON", "{oops", "Stop"],
    ["JSON that is not an object", "[]", "Stop"],
    ["a missing session_id", JSON.stringify({ cwd: "/repo" }), "Stop"],
    ["an empty session_id", payload({ session_id: "" }), "Stop"],
    ["a non-string session_id", payload({ session_id: 7 }), "Stop"],
    ["a missing cwd", JSON.stringify({ session_id: "s-1" }), "Stop"],
    ["an unknown event name", payload(), "Frobnicate"],
  ])("returns undefined for %s", (_label, raw, eventName) => {
    expect(parseHookInput(raw, eventName)).toBeUndefined()
  })

  test("declares exactly the three hooks the manifest registers", () => {
    expect([...HOOK_EVENTS].sort()).toEqual(["PostToolUse", "Stop", "UserPromptSubmit"])
  })
})

describe("planEmit", () => {
  test("a plain allow is silent and exits 0", () => {
    expect(planEmit({ kind: "allow" })).toEqual({ exitCode: 0 })
  })

  test("an allow with a notice reports it as a system message", () => {
    const plan = planEmit({ kind: "allow", notice: "gate exhausted" })
    expect(plan.exitCode).toBe(0)
    expect(plan.stdout).toEqual({ systemMessage: "gate exhausted" })
  })

  test("a block refuses the stop with the framed evidence as the reason", () => {
    const plan = planEmit({ kind: "block", evidence: "2 tests failed", round: 1, roundsMax: 2 })
    expect(plan.exitCode).toBe(0)
    expect(plan.stdout?.decision).toBe("block")
    expect(String(plan.stdout?.reason)).toContain("2 tests failed")
    expect(String(plan.stdout?.reason).toLowerCase()).toContain("not done")
  })

  test("emits JSON that survives a round trip", () => {
    const plan = planEmit({ kind: "block", evidence: "x", round: 1, roundsMax: 2 })
    expect(() => JSON.parse(JSON.stringify(plan.stdout))).not.toThrow()
  })

  // Mirrors the reference implementation's own delivery for allow-with-marker
  // (meta-harness cc-gate-plugin src/output.ts): hookSpecificOutput's
  // additionalContext, a Stop-hook-specific field, not systemMessage —
  // Claude Code feeds additionalContext into the model's own context rather
  // than surfacing it as a status line the way systemMessage does.
  test("an allow with a marker delivers it via hookSpecificOutput.additionalContext", () => {
    const plan = planEmit({ kind: "allow", marker: "gate closed; do not reuse this evidence" })
    expect(plan.exitCode).toBe(0)
    expect(plan.stdout).toEqual({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: "gate closed; do not reuse this evidence",
      },
    })
  })

  test("a marker never rides systemMessage", () => {
    const plan = planEmit({ kind: "allow", marker: "gate closed" })
    expect(plan.stdout).not.toHaveProperty("systemMessage")
  })

  // Not reachable through gate.ts today (notice and marker are mutually
  // exclusive there), but planEmit's own contract should not silently drop
  // one if a future decision ever carries both.
  test("a notice and a marker on the same decision both deliver", () => {
    const plan = planEmit({ kind: "allow", notice: "gate exhausted", marker: "gate closed" })
    expect(plan.stdout).toEqual({
      systemMessage: "gate exhausted",
      hookSpecificOutput: { hookEventName: "Stop", additionalContext: "gate closed" },
    })
  })

  test("emits marker JSON that survives a round trip", () => {
    const plan = planEmit({ kind: "allow", marker: "x" })
    expect(() => JSON.parse(JSON.stringify(plan.stdout))).not.toThrow()
  })
})
