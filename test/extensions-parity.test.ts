// K5: off-by-default parity + guard-can-fail proofs, now that the K1
// extension seam's registry is non-empty (gauge, K4) — the real risk point
// the K1-era parity tests couldn't cover, since nothing was registered yet.
//
// Design rule (downstream-of-decision law, this task's own instruction):
// parity compares against expectations the CURRENT change cannot influence.
// The hand-authored `expectedShape` below is grounded by READING
// kernel/sensor.ts (buildSensorLine/SensorArgs), kernel/gate.ts
// (onStopRequested's accept branch, cycleTags) and kernel/config.ts
// (DEFAULT_ROUNDS) — none of which K1-K4 touched — never by re-running
// today's code and trusting its own output. The two subprocess runs below
// are compared to EACH OTHER (registry non-empty either way) and to that
// pinned shape; a mismatch anywhere is a K1-K4 bug, reported here, not
// patched. No production files are touched by this task.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createGate } from "../src/kernel/index.ts"
import { INITIAL_STATE } from "../src/kernel/state.ts"
import { KERNEL_VERSION } from "../src/kernel/sensor.ts"
import { loadActiveExtensionsFrom } from "../src/extensions/registry.ts"
import type { Extension, ExtensionContext } from "../src/extensions/registry.ts"
import { gaugeDir, pickPending, writeGaugeFile } from "../src/extensions/gauge/files.ts"
import { makeHarness, PASS } from "./fakes.ts"
import type { GateEvent } from "../src/kernel/ports.ts"

const HOOK_CLI = path.join(import.meta.dir, "..", "src", "adapters", "claude-code", "hook-cli.ts")
const STOP: GateEvent = { kind: "stop-requested", sessionID: "sid-1" }
const CTX: ExtensionContext = { root: "/repo" }

async function runHook(
  cwd: string,
  eventName: string,
  payload: Record<string, unknown>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK_CLI, eventName], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  proc.stdin.write(JSON.stringify({ session_id: "s-1", cwd, ...payload }))
  proc.stdin.end()
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

// Mirrors test/claude-code-adapter.test.ts's own armSession — a bare Stop
// with no prior edit allows immediately without ever calling sensor.append
// (kernel/gate.ts's no-edit fast path), so every scenario here arms first.
async function armSession(cwd: string): Promise<void> {
  await runHook(cwd, "PostToolUse", {
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: "x.ts" },
  })
}

function readSensorLines(cwd: string): Record<string, unknown>[] {
  const file = path.join(cwd, ".km", "gate-outcomes.ndjson")
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

// Fields kernel/sensor.ts's buildSensorLine documents (or that are visibly
// wall-clock/hostname-derived in kernel/gate.ts) as inherently
// per-invocation, never structural — stripped before comparison so the
// comparator answers "did the SHAPE and DECISION diverge", the only
// question K1-K4 could have broken.
const NONDETERMINISTIC_KEYS = ["ts", "durationMs", "checkMs", "host"]
function normalizeLine(line: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...line }
  for (const k of NONDETERMINISTIC_KEYS) delete copy[k]
  return copy
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)])
    return [...keys].every((k) => deepEqual(ao[k], bo[k]))
  }
  return false
}

/**
 * The parity comparator itself (K5 item 2 — "a check that cannot fail
 * cannot inform"): test-local infra, never imported into src/. Proven to
 * fail on a genuine divergence by the tamper-detection describe block
 * below, not just asserted to pass on matched inputs.
 */
function parityCompare(a: Record<string, unknown>[], b: Record<string, unknown>[]): boolean {
  return deepEqual(a.map(normalizeLine), b.map(normalizeLine))
}

describe("off-by-default parity: gauge registered but not enabled — full adapter subprocess path", () => {
  let dirNoKey: string
  let dirEmptyBlock: string
  beforeEach(() => {
    dirNoKey = fs.mkdtempSync(path.join(os.tmpdir(), "parity-no-key-"))
    dirEmptyBlock = fs.mkdtempSync(path.join(os.tmpdir(), "parity-empty-block-"))
  })
  afterEach(() => {
    fs.rmSync(dirNoKey, { recursive: true, force: true })
    fs.rmSync(dirEmptyBlock, { recursive: true, force: true })
  })

  // The pre-seam pin (unedited since before K1 — test/claude-code-adapter.test.ts's
  // own "hook-cli.ts subprocess behavior (no extensions in gate.json)"
  // describe block asserts the SAME literal values): an accepted Stop with
  // a passing check prints nothing and exits 0.
  test("no 'extensions' key at all: stdout/exit/stderr match the pre-seam pin", async () => {
    fs.writeFileSync(path.join(dirNoKey, "gate.json"), JSON.stringify({ check: "true" }))
    await armSession(dirNoKey)
    const { exitCode, stdout, stderr } = await runHook(dirNoKey, "Stop", { hook_event_name: "Stop" })
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toBe("")
  })

  test('"extensions": {} (gauge registered, nothing enabled): stdout/exit/stderr identical to the no-key run', async () => {
    fs.writeFileSync(path.join(dirEmptyBlock, "gate.json"), JSON.stringify({ check: "true", extensions: {} }))
    await armSession(dirEmptyBlock)
    const { exitCode, stdout, stderr } = await runHook(dirEmptyBlock, "Stop", { hook_event_name: "Stop" })
    expect(exitCode).toBe(0)
    expect(stdout).toBe("")
    expect(stderr).toBe("")
  })

  test("both runs' written sensor lines are deep-equal to each other and to the hand-pinned pre-seam shape; neither carries a gauge field", async () => {
    fs.writeFileSync(path.join(dirNoKey, "gate.json"), JSON.stringify({ check: "true" }))
    fs.writeFileSync(path.join(dirEmptyBlock, "gate.json"), JSON.stringify({ check: "true", extensions: {} }))
    await armSession(dirNoKey)
    await armSession(dirEmptyBlock)
    await runHook(dirNoKey, "Stop", { hook_event_name: "Stop" })
    await runHook(dirEmptyBlock, "Stop", { hook_event_name: "Stop" })

    const linesNoKey = readSensorLines(dirNoKey)
    const linesEmptyBlock = readSensorLines(dirEmptyBlock)
    expect(linesNoKey).toHaveLength(1)
    expect(linesEmptyBlock).toHaveLength(1)
    expect(parityCompare(linesNoKey, linesEmptyBlock)).toBe(true)

    // kernel/sensor.ts buildSensorLine + kernel/gate.ts onStopRequested's
    // accept branch + kernel/config.ts's DEFAULT_ROUNDS=2 + classify.ts's
    // DEFAULT_TEST_PATH_PATTERN (x.ts doesn't match it, so implOnly:true,
    // sameTurnCoEdit:false) — read from source, not recomputed from a run.
    const expectedShape = {
      sessionID: "s-1",
      check: "true",
      accepted: true,
      gateExhausted: false,
      interrupted: false,
      rounds: ["accepted"],
      app: "claude-code",
      marker: false,
      // Not a hand-pinned literal: buildSensorLine (kernel/sensor.ts) always
      // stamps the kernel's OWN current version here, by design — pinning a
      // literal would make this test fail on every release bump for a
      // reason that has nothing to do with K1-K4 parity.
      pluginVersion: KERNEL_VERSION,
      product: "kkamak",
      roundsMax: 2,
      implOnly: true,
      sameTurnCoEdit: false,
    }
    expect(normalizeLine(linesNoKey[0]!)).toEqual(expectedShape)
    expect(normalizeLine(linesEmptyBlock[0]!)).toEqual(expectedShape)
    expect("gauge" in linesNoKey[0]!).toBe(false)
    expect("gauge" in linesEmptyBlock[0]!).toBe(false)
  })
})

describe("the parity comparator catches a tampering extension", () => {
  // Guard probe #1: proves the comparator isn't just biased to always fail
  // — a real, non-tampering extension routed through the SAME injection
  // seam still parity-matches an untouched baseline.
  test("sanity: a non-tampering extension routed through loadActiveExtensionsFrom still parity-matches the untouched baseline", async () => {
    const baseline = makeHarness({ raw: '{"check":"true"}', script: [PASS] })
    const viaSeam = makeHarness({ raw: '{"check":"true","extensions":{"noop":true}}', script: [PASS] })
    baseline.store.save("sid-1", { ...INITIAL_STATE, edited: true }, 0)
    viaSeam.store.save("sid-1", { ...INITIAL_STATE, edited: true }, 0)

    await createGate(baseline.host).handle(STOP)

    const noopExtension: Extension = { name: "noop", wrapHost: (h) => h, afterDecision: async () => {} }
    const ext = await loadActiveExtensionsFrom(viaSeam.host, { noop: async () => noopExtension }, CTX)
    const decision = await createGate(ext.wrapHost(viaSeam.host)).handle(STOP)
    await ext.afterDecision(STOP, decision)

    expect(
      parityCompare(
        baseline.sensor.lines as unknown as Record<string, unknown>[],
        viaSeam.sensor.lines as unknown as Record<string, unknown>[],
      ),
    ).toBe(true)
  })

  // Guard probe #2 (the actual K5 item-2 ask): a fake extension registered
  // ONLY through loadActiveExtensionsFrom's own injection seam — the real
  // EXTENSIONS map in registry.ts is never touched — tampers a real field
  // on the way through. The comparator MUST flag it, or it cannot inform.
  test("a tampering extension that flips a real sensor field is caught: parityCompare returns false", async () => {
    const baseline = makeHarness({ raw: '{"check":"true"}', script: [PASS] })
    const tamperTarget = makeHarness({ raw: '{"check":"true","extensions":{"tamperer":true}}', script: [PASS] })
    baseline.store.save("sid-1", { ...INITIAL_STATE, edited: true }, 0)
    tamperTarget.store.save("sid-1", { ...INITIAL_STATE, edited: true }, 0)

    await createGate(baseline.host).handle(STOP)

    const tamperingExtension: Extension = {
      name: "tamperer",
      wrapHost(host) {
        return {
          ...host,
          sensor: {
            append(line, relativePath) {
              host.sensor.append({ ...line, accepted: false }, relativePath)
            },
          },
        }
      },
      afterDecision: async () => {},
    }
    const ext = await loadActiveExtensionsFrom(tamperTarget.host, { tamperer: async () => tamperingExtension }, CTX)
    const decision = await createGate(ext.wrapHost(tamperTarget.host)).handle(STOP)
    await ext.afterDecision(STOP, decision)

    expect(baseline.sensor.lines).toHaveLength(1)
    expect(tamperTarget.sensor.lines).toHaveLength(1)
    expect(
      parityCompare(
        baseline.sensor.lines as unknown as Record<string, unknown>[],
        tamperTarget.sensor.lines as unknown as Record<string, unknown>[],
      ),
    ).toBe(false)
  })
})

describe("gated-path proof: gauge enabled, full adapter subprocess — a Stop cycle produces a gauge field and a .km/gauge artifact", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-gated-"))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // An off-by-default feature that was never turned on is unproven, not
  // proven-safe — K4's own wiring tests (test/gauge-wiring.test.ts) cover
  // this in-process; this proves it through the real hook-cli.ts adapter
  // process, the layer the "off" side of this file already covers.
  test("gate.json enables gauge, a pending derivation is seeded, a real Stop subprocess attaches a gauge field and leaves a consumed .km/gauge artifact", async () => {
    fs.writeFileSync(path.join(dir, "gate.json"), JSON.stringify({ check: "true", extensions: { gauge: true } }))
    writeGaugeFile(gaugeDir(dir), {
      v: 1,
      sessionID: "s-1",
      n: 1,
      ts: 500,
      model: "haiku",
      derivationMs: 800,
      goalSummary: "g",
      criteria: ["c"],
      check: "true", // a real, always-succeeding shell command — no external provider call needed
      confidence: 0.6,
    })
    await armSession(dir)
    const { exitCode } = await runHook(dir, "Stop", { hook_event_name: "Stop" })
    expect(exitCode).toBe(0)

    const lines = readSensorLines(dir)
    expect(lines).toHaveLength(1)
    expect("gauge" in lines[0]!).toBe(true)
    const gauge = lines[0]!.gauge as Record<string, unknown>
    expect(gauge.present).toBe(true)

    expect(fs.existsSync(gaugeDir(dir))).toBe(true)
    expect(pickPending(gaugeDir(dir), "s-1")).toBeUndefined() // consumed, not left pending
    expect(fs.existsSync(path.join(gaugeDir(dir), "s-1-1.done.json"))).toBe(true)
  })
})
