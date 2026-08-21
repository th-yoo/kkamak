import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runOnce, truncateTail } from "../skills/oneshot/run-once.ts"

describe("truncateTail", () => {
  test("returns short output unchanged", () => {
    expect(truncateTail("hello")).toBe("hello")
  })

  test("keeps the tail and prepends a truncation marker when over the cap", () => {
    const big = "x".repeat(5000) + "TAIL_MARKER_END"
    const out = truncateTail(big, 100)
    expect(out.endsWith("TAIL_MARKER_END")).toBe(true)
    expect(out.length).toBeLessThan(200)
    expect(out).toContain("truncated")
    expect(out).toContain(String(big.length))
  })

  test("respects a custom maxChars", () => {
    const out = truncateTail("y".repeat(50), 10)
    expect(out).toContain("truncated")
    expect(out.endsWith("y".repeat(10))).toBe(true)
  })
})

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "oneshot-test-")) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function writeGate(check: string, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(dir, "gate.json"), JSON.stringify({ check, ...extra }))
}

describe("runOnce", () => {
  test("returns undefined when there is no gate.json", async () => {
    expect(await runOnce(dir)).toBeUndefined()
  })

  test("a passing check reports ok:true with real output", async () => {
    writeGate("echo hello")
    const r = await runOnce(dir)
    expect(r?.ok).toBe(true)
    expect(r?.output).toContain("hello")
  })

  test("a failing check reports ok:false with real output", async () => {
    writeGate("echo boom 1>&2; exit 1")
    const r = await runOnce(dir)
    expect(r?.ok).toBe(false)
    expect(r?.output).toContain("boom")
  })

  test("a check that outruns checkTimeoutMs reports ok:false", async () => {
    writeGate("sleep 30", { checkTimeoutMs: 300 })
    const r = await runOnce(dir)
    expect(r?.ok).toBe(false)
  }, 10_000)
})

const RUN_ONCE = path.join(import.meta.dir, "..", "skills", "oneshot", "run-once.ts")

async function spawnRunOnce(cwd: string, env: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["bun", RUN_ONCE], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env } as Record<string, string>,
  })
  const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  const exitCode = await proc.exited
  return { exitCode, stdout }
}

describe("run-once.ts as a real subprocess", () => {
  test("exits 0 and prints one JSON line on a passing check", async () => {
    writeGate("exit 0")
    const { exitCode, stdout } = await spawnRunOnce(dir)
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout.trim())).toMatchObject({ ok: true })
  })

  test("exits 1 on a failing check", async () => {
    writeGate("exit 1")
    const { exitCode } = await spawnRunOnce(dir)
    expect(exitCode).toBe(1)
  })

  test("exits 1 with no gate.json, no dogfood log written", async () => {
    const { exitCode } = await spawnRunOnce(dir)
    expect(exitCode).toBe(1)
    expect(fs.existsSync(path.join(dir, ".km", "oneshot-dogfood.ndjson"))).toBe(false)
  })

  test("appends one dogfood log line per real attempt", async () => {
    writeGate("exit 0")
    await spawnRunOnce(dir)
    await spawnRunOnce(dir)
    const lines = fs
      .readFileSync(path.join(dir, ".km", "oneshot-dogfood.ndjson"), "utf8")
      .trim()
      .split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true })
  })
})

describe("dogfood log: full vs light entries (known-issues.md #12.2)", () => {
  test("a non-final failing attempt logs a light entry: outputLength, no output", async () => {
    writeGate("echo boom 1>&2; exit 1")
    await spawnRunOnce(dir)
    const line = JSON.parse(
      fs.readFileSync(path.join(dir, ".km", "oneshot-dogfood.ndjson"), "utf8").trim(),
    ) as { ok: boolean; output?: string; outputLength?: number }
    expect(line.ok).toBe(false)
    expect(typeof line.outputLength).toBe("number")
    expect(line.output).toBeUndefined()
  })

  test("a final failing attempt (ONESHOT_FINAL_ATTEMPT=1) logs a full entry with output", async () => {
    writeGate("echo boom 1>&2; exit 1")
    await spawnRunOnce(dir, { ONESHOT_FINAL_ATTEMPT: "1" })
    const line = JSON.parse(
      fs.readFileSync(path.join(dir, ".km", "oneshot-dogfood.ndjson"), "utf8").trim(),
    ) as { ok: boolean; output?: string }
    expect(line.ok).toBe(false)
    expect(line.output).toContain("boom")
  })

  test("a successful attempt always logs full output, even without ONESHOT_FINAL_ATTEMPT", async () => {
    writeGate("echo hi")
    await spawnRunOnce(dir)
    const line = JSON.parse(
      fs.readFileSync(path.join(dir, ".km", "oneshot-dogfood.ndjson"), "utf8").trim(),
    ) as { ok: boolean; output?: string }
    expect(line.ok).toBe(true)
    expect(line.output).toContain("hi")
  })
})
