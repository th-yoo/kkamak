import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EDIT_TOOLS, HOOK_EVENTS, parseHookInput } from "../src/adapters/claude-code/hook-input.ts"
import { planEmit } from "../src/adapters/claude-code/emit.ts"
import { composeBlockMessage } from "../src/adapters/shared/framing.ts"
import { createGate } from "../src/kernel/index.ts"
import { loadActiveExtensions } from "../src/extensions/registry.ts"
import { makeHarness } from "./fakes.ts"

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

  // ExtensionContext (K4 ruling R12): the prompt text needed to fire
  // maybeSpawnGauge for real lives in the raw UserPromptSubmit payload
  // (record.prompt) — the kernel's own GateEvent never carries it, by
  // design. Same never-throw, absent-on-anything-else discipline as root.
  test("carries the prompt text through for UserPromptSubmit", () => {
    const raw = payload({ hook_event_name: "UserPromptSubmit", prompt: "fix the parser" })
    const parsed = parseHookInput(raw, "UserPromptSubmit")
    expect(parsed?.prompt).toBe("fix the parser")
  })

  test("prompt is absent (not undefined-but-present) when the payload has no prompt field", () => {
    const raw = payload({ hook_event_name: "UserPromptSubmit" })
    const parsed = parseHookInput(raw, "UserPromptSubmit")
    expect(parsed && "prompt" in parsed).toBe(false)
  })

  test("a non-string prompt field leaves prompt absent rather than passing through garbage", () => {
    const raw = payload({ hook_event_name: "UserPromptSubmit", prompt: 42 })
    const parsed = parseHookInput(raw, "UserPromptSubmit")
    expect(parsed && "prompt" in parsed).toBe(false)
  })

  test.each(["Stop", "PostToolUse"])("prompt is never carried on %s, even if the raw payload has one", (event) => {
    const raw = payload({ hook_event_name: event, tool_name: "Edit", prompt: "should be ignored" })
    const parsed = parseHookInput(raw, event)
    expect(parsed && "prompt" in parsed).toBe(false)
  })

  // The config root is the payload's cwd verbatim — not the repo root, not
  // the process's cwd. See docs/known-issues.md #4 and README's gate.json
  // placement paragraph, which this pins.
  test.each([...HOOK_EVENTS])("%s carries the payload cwd through as root, verbatim", (event) => {
    const raw = payload({ cwd: "/home/dev/repo/packages/web", tool_name: "Edit" })
    expect(parseHookInput(raw, event)?.root).toBe("/home/dev/repo/packages/web")
  })

  test.each(EDIT_TOOLS)("maps PostToolUse on %s to file-edited", (tool) => {
    const parsed = parseHookInput(payload({ tool_name: tool }), "PostToolUse")
    expect(parsed?.event.kind).toBe("file-edited")
  })

  // A1: tool_input.file_path is the edited path, confirmed against a real
  // captured Claude Code PostToolUse payload.
  test.each(EDIT_TOOLS)("carries tool_input.file_path through as the event's path for %s", (tool) => {
    const raw = payload({ tool_name: tool, tool_input: { file_path: "/repo/src/kernel/gate.ts" } })
    const parsed = parseHookInput(raw, "PostToolUse")
    expect(parsed?.event).toEqual({
      kind: "file-edited",
      sessionID: "s-1",
      path: "/repo/src/kernel/gate.ts",
    })
  })

  test("a PostToolUse payload with no tool_input.file_path leaves path absent, not undefined-but-present", () => {
    const raw = payload({ tool_name: "Edit" })
    const parsed = parseHookInput(raw, "PostToolUse")
    expect(parsed?.event).toEqual({ kind: "file-edited", sessionID: "s-1" })
    expect(parsed && "path" in parsed.event).toBe(false)
  })

  test("a non-string tool_input.file_path leaves path absent rather than passing through garbage", () => {
    const raw = payload({ tool_name: "Edit", tool_input: { file_path: 7 } })
    const parsed = parseHookInput(raw, "PostToolUse")
    expect(parsed && "path" in parsed.event).toBe(false)
  })

  test("stop-requested and new-user-prompt never carry a path", () => {
    expect(parseHookInput(payload(), "Stop")?.event).not.toHaveProperty("path")
    expect(
      parseHookInput(payload({ hook_event_name: "UserPromptSubmit" }), "UserPromptSubmit")?.event,
    ).not.toHaveProperty("path")
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

// K1: the extension seam wraps hook-cli.ts's gate construction. hook-cli.ts
// itself has an unconditional top-level main() (no import.meta.main guard,
// same as the rest of this file's own comments elsewhere note about it) so
// it cannot be imported to compare byte-for-byte binary output. This proves
// parity at the layer that can actually be tested directly: with no
// extensions enabled, wrapping a host through loadActiveExtensions/wrapHost
// and running afterDecision produces the identical GateDecision that
// createGate(host) alone produced before this task — same config, same
// script, two independent fake hosts so neither call's state consumption
// affects the other's.
describe("extension seam parity (K1, no extensions enabled)", () => {
  test("a Stop payload's decision is identical with and without the seam wired in", async () => {
    const opts = { raw: '{"check":"x"}', script: [{ code: 0, output: "ok\n" }] }
    const before = makeHarness(opts)
    const after = makeHarness(opts)

    const decisionBefore = await createGate(before.host).handle({ kind: "stop-requested", sessionID: "s-1" })

    const ext = await loadActiveExtensions(after.host, { root: "/repo" })
    const decisionAfter = await createGate(ext.wrapHost(after.host)).handle({
      kind: "stop-requested",
      sessionID: "s-1",
    })
    await ext.afterDecision({ kind: "stop-requested", sessionID: "s-1" }, decisionAfter)

    expect(decisionAfter).toEqual(decisionBefore)
    expect(planEmit(decisionAfter)).toEqual(planEmit(decisionBefore))
  })
})

// K1 review finding: the parity block above reimplements hook-cli.ts's call
// sequence rather than executing the real file, so a literal wiring defect
// (wrong arg, dropped await, wrong host passed to createGate) would not be
// caught. This closes that gap by actually spawning hook-cli.ts as a
// subprocess, same Bun.spawn + piped-stdin pattern
// test/oneshot-dogfood-hook.test.ts already uses for a different CLI hook.
describe("hook-cli.ts subprocess behavior (no extensions in gate.json)", () => {
  const HOOK_CLI = path.join(import.meta.dir, "..", "src", "adapters", "claude-code", "hook-cli.ts")

  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-cli-test-")) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  async function runHook(
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", HOOK_CLI, eventName], { cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    proc.stdin.write(JSON.stringify({ session_id: "s-1", cwd: dir, ...payload }))
    proc.stdin.end()
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  }

  function writeGate(check: string, extra: Record<string, unknown> = {}): void {
    fs.writeFileSync(path.join(dir, "gate.json"), JSON.stringify({ check, ...extra }))
  }

  // A bare Stop with no prior edit allows immediately without running the
  // check at all (gate.ts's onStopRequested) — both scenarios below arm the
  // session with a real PostToolUse first, matching real usage.
  async function armSession(): Promise<void> {
    await runHook("PostToolUse", { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "x.ts" } })
  }

  test("allow path: passing check prints nothing to stdout, exits 0", async () => {
    writeGate("true")
    await armSession()
    const { exitCode, stdout, stderr } = await runHook("Stop", { hook_event_name: "Stop" })
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toBe("")
  })

  test("block path: failing check prints the exact block JSON, exits 0 (block is signaled in stdout, not exit code)", async () => {
    writeGate("false", { rounds: 2 })
    await armSession()
    const { exitCode, stdout } = await runHook("Stop", { hook_event_name: "Stop" })
    expect(exitCode).toBe(0)
    // gate.ts synthesizes a fallback when the check's own output is empty
    // (`check exited with code ${code} and produced no output`) — "false"
    // exits 1 with no stdout/stderr, so that's the real evidence text.
    const expectedReason = composeBlockMessage({
      kind: "block",
      evidence: "check exited with code 1 and produced no output",
      round: 1,
      roundsMax: 2,
    })
    expect(JSON.parse(stdout.trim())).toEqual({ decision: "block", reason: expectedReason })
  })
})
