// NOT a port of cc-gate-plugin/test/gauge-refiner-cli.test.ts — that file is
// 100% dependent on transport.ts's HTTP-stub mechanics (env-redirected
// Anthropic API calls via KKAMAK_GAUGE_SDK_BASE_URL, a §6d transport-pin
// regression test comparing a "sdk" endpoint against an "agent-sdk" one).
// None of that exists in kkamak: transport.ts is explicitly excluded (K3
// ruling), and cli-spawn.ts is the only provider, so there is no pin to
// test. This is a genuinely new test file for the kkamak-native
// refiner-cli.ts (ruling R14 fix round), using registerProvider with a fake
// provider under CLI_SPAWN_PROVIDER_ID — the same testing style
// gauge-send-prompt.test.ts already uses — rather than the lab's HTTP-stub
// approach.
import { beforeEach, test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runRefinerOnce } from "../src/extensions/gauge/refiner-cli.ts"
import { gaugeDir } from "../src/extensions/gauge/files.ts"
import { registerProvider } from "../src/extensions/gauge/send-prompt.ts"
import type { SendOutcome } from "../src/extensions/gauge/send-prompt.ts"
import { CLI_SPAWN_PROVIDER_ID } from "../src/extensions/gauge/providers/cli-spawn.ts"

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-gauge-rcli-"))
}

function writeReq(repo: string, sessionID: string, n: number, prompt: string, floorCheck?: string): void {
  const dir = gaugeDir(repo)
  fs.mkdirSync(dir, { recursive: true })
  const body: Record<string, unknown> =
    floorCheck === undefined
      ? { v: 1, sessionID, n, ts: 1, prompt }
      : { v: 2, sessionID, n, ts: 1, prompt, floorCheck }
  fs.writeFileSync(path.join(dir, `${sessionID}-${n}.req.json`), JSON.stringify(body))
}

function stubProvider(outcome: SendOutcome | (() => SendOutcome)): void {
  registerProvider(CLI_SPAWN_PROVIDER_ID, async () => (typeof outcome === "function" ? outcome() : outcome))
}

const VALID_JSON = JSON.stringify({
  goalSummary: "g",
  class: "C",
  criteria: ["c1"],
  check: "test -f done.txt",
  confidence: 0.9,
})

beforeEach(() => {
  // Reset to a known-good stub before every test — CLI_SPAWN_PROVIDER_ID is
  // a shared, process-wide registry key (send-prompt.ts's Map), and no
  // other test in this suite depends on the real cli-spawn provider
  // surviving (confirmed: grepped the whole test/ tree for
  // resolveProvider(CLI_SPAWN_PROVIDER_ID) — no hits).
  stubProvider({ ok: true, text: VALID_JSON, model: "claude-haiku-4-5", canonicalModel: "claude-haiku-4-5-20260101" })
})

test("happy path: valid provider output → gauge file written, req removed", async () => {
  const repo = mkRepo()
  writeReq(repo, "sid-9", 1, "create done.txt", "")

  await runRefinerOnce(repo, "sid-9", 1)

  const gauge = JSON.parse(fs.readFileSync(path.join(gaugeDir(repo), "sid-9-1.json"), "utf-8"))
  expect(gauge.goalSummary).toBe("g")
  expect(gauge.check).toBe("test -f done.txt")
  expect(gauge.sessionID).toBe("sid-9")
  expect(gauge.n).toBe(1)
  expect(gauge.v).toBe(2)
  expect(gauge.class).toBe("C")
  expect(gauge.model).toBe("claude-haiku-4-5-20260101") // outcome.canonicalModel
  expect(typeof gauge.derivationMs).toBe("number")
  expect("transport" in gauge).toBe(false) // absent means cli, never fabricated
  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-1.req.json"))).toBe(false)
})

test("class C with a path NOT in the prompt → validated down to D pre-persist (downgraded, check null)", async () => {
  const repo = mkRepo()
  // Prompt names no path at all — validateDerivation cannot find
  // "done.txt" verbatim in it.
  writeReq(repo, "sid-9", 4, "please finish the task", "")

  await runRefinerOnce(repo, "sid-9", 4)

  const gauge = JSON.parse(fs.readFileSync(path.join(gaugeDir(repo), "sid-9-4.json"), "utf-8"))
  expect(gauge.v).toBe(2)
  expect(gauge.class).toBe("D")
  expect(gauge.check).toBeNull()
  expect(gauge.downgraded?.rule).toBe("path-not-in-prompt")
  expect(gauge.downgraded?.token).toBe("done.txt")
})

test("stale v1-shaped req (no floorCheck key) still produces a valid v2 pending (floorCheck '' path)", async () => {
  const repo = mkRepo()
  writeReq(repo, "sid-9", 5, "create done.txt") // no 5th arg -> v1 shape, no floorCheck key

  await runRefinerOnce(repo, "sid-9", 5)

  const gauge = JSON.parse(fs.readFileSync(path.join(gaugeDir(repo), "sid-9-5.json"), "utf-8"))
  expect(gauge.v).toBe(2)
  expect(gauge.class).toBe("C")
  expect(gauge.check).toBe("test -f done.txt")
})

test("garbage provider output → no gauge file, req still cleaned up", async () => {
  const repo = mkRepo()
  writeReq(repo, "sid-9", 2, "create done.txt")
  stubProvider({ ok: true, text: "I refuse to emit JSON", model: "m", canonicalModel: "m" })

  await runRefinerOnce(repo, "sid-9", 2)

  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-2.json"))).toBe(false)
  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-2.req.json"))).toBe(false)
})

test("provider failure (ok:false) → no gauge file, req cleaned up (fail-open)", async () => {
  const repo = mkRepo()
  writeReq(repo, "sid-9", 6, "create done.txt", "")
  stubProvider({ ok: false, kind: "no-call" })

  await runRefinerOnce(repo, "sid-9", 6)

  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-6.json"))).toBe(false)
  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-6.req.json"))).toBe(false)
})

test("missing req file → clean no-op, provider never called", async () => {
  const repo = mkRepo()
  let called = false
  stubProvider(() => {
    called = true
    return { ok: true, text: VALID_JSON, model: "m", canonicalModel: "m" }
  })

  await runRefinerOnce(repo, "sid-9", 3)

  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-3.json"))).toBe(false)
  expect(called).toBe(false)
})

test("provider throwing synchronously is swallowed by sendPrompt itself — no gauge file, req still cleaned up", async () => {
  const repo = mkRepo()
  writeReq(repo, "sid-9", 8, "create done.txt", "")
  registerProvider(CLI_SPAWN_PROVIDER_ID, async () => {
    throw new Error("boom")
  })

  await runRefinerOnce(repo, "sid-9", 8)

  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-8.json"))).toBe(false)
  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-9-8.req.json"))).toBe(false)
})
