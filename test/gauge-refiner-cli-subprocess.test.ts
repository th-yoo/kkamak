// S1 (round-3 review, Critical): gauge-refiner-cli.test.ts calls
// runRefinerOnce() IN-PROCESS after registering a stub provider itself —
// that registration is exactly what the real detached child (spawn.ts's
// `bun refiner-cli.ts ...`) never gets, since it is its own process with
// its own send-prompt.ts registry Map, never inheriting the parent's. This
// file is the test that crosses the process boundary: it spawns the real
// refiner-cli.ts as a subprocess, with a stub `claude` binary reachable
// only via PATH, and registers NOTHING in this (parent) test process — the
// only way a pending file can appear is if refiner-cli.ts's own module
// graph registers cli-spawn's provider on its own.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { gaugeDir } from "../src/extensions/gauge/files.ts"

const REFINER_CLI = path.join(import.meta.dir, "..", "src", "extensions", "gauge", "refiner-cli.ts")

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-gauge-rcli-subprocess-"))
}

function writeReq(repo: string, sessionID: string, n: number, prompt: string, floorCheck = ""): void {
  const dir = gaugeDir(repo)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${sessionID}-${n}.req.json`), JSON.stringify({ v: 2, sessionID, n, ts: 1, prompt, floorCheck }))
}

describe("refiner-cli.ts as a real subprocess: the spawn chain must self-register cli-spawn, not depend on the parent process", () => {
  let stubDir: string

  beforeAll(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "km-gauge-stub-claude-"))
    const resultJson = JSON.stringify({
      goalSummary: "g",
      class: "C",
      criteria: ["c1"],
      check: "test -f done.txt",
      confidence: 0.9,
    })
    // Mimics cli-spawn.ts's own expected shape: --output-format json ->
    // one terminal {type:"result", is_error, result} object on stdout.
    const event = JSON.stringify({ type: "result", is_error: false, result: resultJson })
    const stubPath = path.join(stubDir, "claude")
    fs.writeFileSync(stubPath, `#!/usr/bin/env bash\ncat <<'STUBEOF'\n${event}\nSTUBEOF\n`)
    fs.chmodSync(stubPath, 0o755)
  })

  afterAll(() => {
    fs.rmSync(stubDir, { recursive: true, force: true })
  })

  test("a real `bun refiner-cli.ts` child, with a stub claude on PATH and NO registerProvider call in this (parent) process, writes a valid pending gauge file", async () => {
    const repo = mkRepo()
    writeReq(repo, "sid-sub", 1, "create done.txt")

    const proc = Bun.spawn(["bun", REFINER_CLI, repo, "sid-sub", "1"], {
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [, exitCode] = await Promise.all([
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ])
    expect(exitCode).toBe(0) // fail-open: never a nonzero exit, pending or not

    const gaugeFile = path.join(gaugeDir(repo), "sid-sub-1.json")
    // The actual assertion under test: without cli-spawn.ts self-registering
    // on import, refiner-cli.ts's own sendPrompt() call resolves to no
    // provider at all (unknown provider id -> {ok:false, kind:"no-call"}),
    // so no gauge file is EVER written — a permanent, silent
    // offReason:"no-record" in production, indistinguishable from a
    // session that simply had no task prompts.
    expect(fs.existsSync(gaugeFile)).toBe(true)
    const gauge = JSON.parse(fs.readFileSync(gaugeFile, "utf-8"))
    expect(gauge.class).toBe("C")
    expect(gauge.check).toBe("test -f done.txt")
    expect(gauge.confidence).toBe(0.9)
    // The req is always cleaned up regardless — this alone is NOT proof the
    // provider was ever reached, which is exactly why gaugeFile existing is
    // the load-bearing assertion here, not this line.
    expect(fs.existsSync(path.join(gaugeDir(repo), "sid-sub-1.req.json"))).toBe(false)
  })
})
