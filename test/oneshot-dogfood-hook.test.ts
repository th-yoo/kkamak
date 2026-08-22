import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { countMarkers, parseBashPostToolUse } from "../skills/oneshot/dogfood-hook-input.ts"

describe("countMarkers", () => {
  test("zero for an unrelated command", () => {
    expect(countMarkers("ls -la")).toBe(0)
  })

  test("counts one invocation", () => {
    expect(countMarkers('bun "/plugin/skills/oneshot/run-once.ts"')).toBe(1)
  })

  test("counts a retry loop's two invocations", () => {
    const cmd = 'bun "/p/run-once.ts" || (echo retry; bun "/p/run-once.ts")'
    expect(countMarkers(cmd)).toBe(2)
  })
})

describe("parseBashPostToolUse", () => {
  const payload = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: "s-1",
      cwd: "/repo",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "bun run-once.ts" },
      ...over,
    })

  test("parses a well-formed Bash PostToolUse payload", () => {
    expect(parseBashPostToolUse(payload())).toEqual({ sessionID: "s-1", command: "bun run-once.ts" })
  })

  test("returns undefined for a non-Bash tool", () => {
    expect(parseBashPostToolUse(payload({ tool_name: "Edit" }))).toBeUndefined()
  })

  test("returns undefined for malformed JSON", () => {
    expect(parseBashPostToolUse("{not json")).toBeUndefined()
  })

  test("returns undefined when tool_input.command is missing or not a string", () => {
    expect(parseBashPostToolUse(payload({ tool_input: {} }))).toBeUndefined()
    expect(parseBashPostToolUse(payload({ tool_input: { command: 7 } }))).toBeUndefined()
  })

  test("returns undefined when session_id is missing", () => {
    const raw = JSON.stringify({ cwd: "/repo", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "x" } })
    expect(parseBashPostToolUse(raw)).toBeUndefined()
  })
})

const HOOK_CLI = path.join(import.meta.dir, "..", "skills", "oneshot", "dogfood-hook-cli.ts")

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "oneshot-dogfood-hook-")) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

async function runHook(payload: Record<string, unknown>): Promise<void> {
  const proc = Bun.spawn(["bun", HOOK_CLI, "PostToolUse"], { cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  proc.stdin.write(JSON.stringify(payload))
  proc.stdin.end()
  await proc.exited
}

describe("known holes", () => {
  // KNOWN-HOLE(KI-13) — known-issues #13: marker blind to indirection; needs
  // its own review before any change (this marker pins the behavior, decides
  // nothing about the fix). #13's exact indirection shape (from the #12
  // dogfood run): "the actual `Bash` tool call invoked a driver script file
  // (`bash /path/to/driver.sh <PLUGIN_ROOT> <MAX_ATTEMPTS>`) rather than
  // inlining the template. `tool_input.command` for that real call was just
  // that one line — it never contains the substring `"run-once.ts"` at all
  // (confirmed: `countMarkers` on the real command text returns `0`), even
  // though the driver script it invoked genuinely ran `run-once.ts` three
  // times, and Source 1 genuinely recorded all three."
  //
  // Unskip when direction (b) lands — run-once.ts emits a per-invocation
  // marker the hook can attribute — and this test then pins it. If #13
  // resolves as direction (a) instead (Source 2 accepted as an
  // adoption-only signal, markerCount no longer claimed as a retry-count
  // proxy), the hole is closed by definition: do NOT unskip — delete this
  // marker and record why.
  test.skip("KNOWN-HOLE(KI-13): a Bash call that indirects through a driver script counts zero markers even though run-once.ts ran three times inside it", () => {
    const cmd = "bash /path/to/driver.sh /plugin/root 3"
    expect(countMarkers(cmd)).toBe(3) // DESIRED: marker count includes the indirect write
  })
})

describe("dogfood-hook-cli.ts as a real subprocess", () => {
  test("writes one line for a Bash call that invokes run-once.ts", async () => {
    await runHook({
      session_id: "s-1",
      cwd: dir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: 'bun "run-once.ts"' },
    })
    const lines = fs
      .readFileSync(path.join(dir, ".km", "oneshot-dogfood-calls.ndjson"), "utf8")
      .trim()
      .split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ sessionID: "s-1", markerCount: 1 })
  })

  test("writes nothing for an ordinary Bash call unrelated to oneshot", async () => {
    await runHook({
      session_id: "s-1",
      cwd: dir,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    })
    expect(fs.existsSync(path.join(dir, ".km", "oneshot-dogfood-calls.ndjson"))).toBe(false)
  })

  test("never exits nonzero, even on garbage stdin", async () => {
    const proc = Bun.spawn(["bun", HOOK_CLI, "PostToolUse"], { cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    proc.stdin.write("not json at all")
    proc.stdin.end()
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
  })
})
