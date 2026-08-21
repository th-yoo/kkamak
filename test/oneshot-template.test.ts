import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const TEMPLATE = path.join(import.meta.dir, "..", "skills", "oneshot", "template.sh")
const PLUGIN_ROOT = path.join(import.meta.dir, "..", "skills", "oneshot")

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "oneshot-template-")) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

async function runTemplate(cwd: string, maxAttempts: number): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["bash", TEMPLATE, PLUGIN_ROOT, String(maxAttempts)], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  const exitCode = await proc.exited
  return { exitCode, stdout }
}

// A stateful fixture: fails on its first invocation, passes on every one
// after. State lives in a file inside the tmp repo, not a Date.now()-relative
// timer — deterministic regardless of how fast the test runs.
function writeStatefulCheck(dir: string): void {
  const marker = path.join(dir, ".ran-once")
  const script = path.join(dir, "check.sh")
  fs.writeFileSync(
    script,
    `#!/usr/bin/env bash\nif [ -f "${marker}" ]; then exit 0; else touch "${marker}"; exit 1; fi\n`,
  )
  fs.chmodSync(script, 0o755)
  fs.writeFileSync(path.join(dir, "gate.json"), JSON.stringify({ check: script, rounds: 2 }))
}

describe("the design-buying property: one Bash call, retry included", () => {
  test("a check that fails once then passes resolves ok within one template.sh run, run-once.ts invoked twice", async () => {
    writeStatefulCheck(dir)
    const { exitCode } = await runTemplate(dir, 3) // rounds:2 + 1
    expect(exitCode).toBe(0)

    const log = fs
      .readFileSync(path.join(dir, ".km", "oneshot-dogfood.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    // Exactly two real run-once.ts invocations happened — the retry
    // happened inside this one process, not via a second Bash call.
    expect(log).toHaveLength(2)
    expect(log[0].ok).toBe(false)
    expect(log[1].ok).toBe(true)
  })

  test("a check that never passes exhausts MAX_ATTEMPTS and exits 1", async () => {
    fs.writeFileSync(path.join(dir, "gate.json"), JSON.stringify({ check: "exit 1", rounds: 1 }))
    const { exitCode } = await runTemplate(dir, 2) // rounds:1 + 1
    expect(exitCode).toBe(1)
    const log = fs
      .readFileSync(path.join(dir, ".km", "oneshot-dogfood.ndjson"), "utf8")
      .trim()
      .split("\n")
    expect(log).toHaveLength(2)
  })

  test("a check that passes immediately exits 0 after exactly one attempt", async () => {
    fs.writeFileSync(path.join(dir, "gate.json"), JSON.stringify({ check: "exit 0", rounds: 2 }))
    const { exitCode } = await runTemplate(dir, 3)
    expect(exitCode).toBe(0)
    const log = fs
      .readFileSync(path.join(dir, ".km", "oneshot-dogfood.ndjson"), "utf8")
      .trim()
      .split("\n")
    expect(log).toHaveLength(1)
  })
})
