import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createGate } from "../src/kernel/index.ts"
import { INITIAL_STATE } from "../src/kernel/state.ts"
import { loadActiveExtensions } from "../src/extensions/registry.ts"
import type { ExtensionContext } from "../src/extensions/registry.ts"
import { gaugeExtension } from "../src/extensions/gauge/index.ts"
import { gaugeDir, writeGaugeFile, type GaugeFile } from "../src/extensions/gauge/files.ts"
import { makeHarness, PASS, FAIL } from "./fakes.ts"
import type { GateDecision, GateEvent } from "../src/kernel/ports.ts"

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gauge-wiring-"))
}

const STOP: GateEvent = { kind: "stop-requested", sessionID: "sid-1" }
const ALLOW: GateDecision = { kind: "allow" }

function pendingGauge(repo: string, over: Partial<GaugeFile> = {}): void {
  writeGaugeFile(gaugeDir(repo), {
    v: 1,
    sessionID: "sid-1",
    n: 1,
    ts: 500,
    model: "haiku",
    derivationMs: 800,
    goalSummary: "g",
    criteria: ["c"],
    check: "gauge-check",
    confidence: 0.6,
    ...over,
  })
}

describe("(a)/(i) gauge registered but not enabled: identity passthrough, nothing held", () => {
  test("wrapHost(h) === h via the real loadActiveExtensions path when gauge is not enabled", async () => {
    const repo = mkRepo()
    const { host } = makeHarness({ raw: '{"check":"true"}' }) // no "extensions" block at all
    const ctx: ExtensionContext = { root: repo }
    const ext = await loadActiveExtensions(host, ctx)
    expect(ext.wrapHost(host)).toBe(host)
  })

  test("re-asserted: the decorator never engages when not enabled — a line pushed through the identity host lands on the real sensor directly, nothing is held back", async () => {
    const repo = mkRepo()
    const { host, sensor } = makeHarness({ raw: '{"check":"true"}' })
    const ctx: ExtensionContext = { root: repo }
    const ext = await loadActiveExtensions(host, ctx)
    const wrapped = ext.wrapHost(host)
    wrapped.sensor.append({ ts: 1, sessionID: "s", check: "x", accepted: true, gateExhausted: false, rounds: ["accepted"], interrupted: false, marker: false, durationMs: 1, host: "h", app: "claude-code" }, ".km/gate-outcomes.ndjson")
    expect(sensor.lines).toHaveLength(1)
    expect((sensor.lines[0] as { gauge?: unknown }).gauge).toBeUndefined()
  })
})

describe("(b) enabled + a completed Stop cycle: sensor line carries a real gauge field", () => {
  test("a real gate.handle(Stop) cycle, wrapped, flushes a line with a real gauge annotation", async () => {
    const repo = mkRepo()
    pendingGauge(repo)
    const { host, store, sensor } = makeHarness({
      raw: '{"check":"true"}',
      script: [PASS, FAIL], // 1st: the floor check (kernel); 2nd: the gauge's own derived check
    })
    store.save("sid-1", { ...INITIAL_STATE, edited: true }, 0)
    const ctx: ExtensionContext = { root: repo }

    const wrapped = gaugeExtension.wrapHost(host, ctx)
    const decision = await createGate(wrapped).handle(STOP)
    await gaugeExtension.afterDecision(STOP, decision, host, ctx)

    expect(sensor.lines).toHaveLength(1)
    const gauge = (sensor.lines[0] as { gauge?: Record<string, unknown> }).gauge
    expect(gauge).toMatchObject({ present: true, executable: true, pass: false })
  })
})

describe("(c) enabled + provider failure: {present:false, offReason} with the specific reason", () => {
  test("no pending gauge derivation at all → the flushed line carries offReason:no-record", async () => {
    const repo = mkRepo() // no pendingGauge() call — nothing for shadow eval to find
    const { host, store, sensor } = makeHarness({ raw: '{"check":"true"}', script: [PASS] })
    store.save("sid-1", { ...INITIAL_STATE, edited: true }, 0)
    const ctx: ExtensionContext = { root: repo }

    const wrapped = gaugeExtension.wrapHost(host, ctx)
    const decision = await createGate(wrapped).handle(STOP)
    await gaugeExtension.afterDecision(STOP, decision, host, ctx)

    expect(sensor.lines).toHaveLength(1)
    expect((sensor.lines[0] as { gauge?: Record<string, unknown> }).gauge).toEqual({
      present: false,
      offReason: "no-record",
    })
  })
})

describe("(d)/(g) total dependency failure: afterDecision resolves, every held line still flushed", () => {
  test("config unparseable at flush time → afterDecision resolves, held line flushed with offReason:no-record, zero lines remain held", async () => {
    const repo = mkRepo()
    pendingGauge(repo)
    const { host, sensor, config } = makeHarness({ raw: '{"check":"true"}', script: [PASS] })
    const ctx: ExtensionContext = { root: repo }

    const wrapped = gaugeExtension.wrapHost(host, ctx)
    wrapped.sensor.append(
      { ts: 1, sessionID: "sid-1", check: "true", accepted: true, gateExhausted: false, rounds: ["accepted"], interrupted: false, marker: false, durationMs: 1, host: "h", app: "claude-code" },
      ".km/gate-outcomes.ndjson",
    )
    // Break config parsing entirely for the flush's own read — annotateLine's
    // own guard (no cfg -> immediate no-record fallback) must still resolve.
    config.raw = "{not json"

    await expect(gaugeExtension.afterDecision(STOP, ALLOW, host, ctx)).resolves.toBeUndefined()
    expect(sensor.lines).toHaveLength(1)
    expect((sensor.lines[0] as { gauge?: Record<string, unknown> }).gauge).toEqual({
      present: false,
      offReason: "no-record",
    })
  })

  test("the check runner rejects (a genuine internal error, not a failing check) → afterDecision still resolves and flushes", async () => {
    const repo = mkRepo()
    pendingGauge(repo)
    const { host, sensor } = makeHarness({ raw: '{"check":"true"}', fallback: new Error("spawn exploded") })
    const ctx: ExtensionContext = { root: repo }

    const wrapped = gaugeExtension.wrapHost(host, ctx)
    wrapped.sensor.append(
      { ts: 1, sessionID: "sid-1", check: "true", accepted: true, gateExhausted: false, rounds: ["accepted"], interrupted: false, marker: false, durationMs: 1, host: "h", app: "claude-code" },
      ".km/gate-outcomes.ndjson",
    )
    await expect(gaugeExtension.afterDecision(STOP, ALLOW, host, ctx)).resolves.toBeUndefined()
    expect(sensor.lines).toHaveLength(1) // flushed, not dropped
  })
})

describe("(f) eval throws mid-flush: the held line is still flushed with a specific offReason", () => {
  test("shadowEvaluateAtStop's own dependency throwing still resolves to a flushed, offReason:no-record line", async () => {
    const repo = mkRepo()
    pendingGauge(repo)
    // No script at all + no fallback override -> FakeCheck's default
    // fallback ({code:0,output:""}) still runs fine; the throw case is
    // already covered above (d/g) via an injected Error. This test instead
    // pins that even a routine pending-but-somehow-unreadable case still
    // resolves with the specific reason, not a generic catch-all message.
    fs.rmSync(path.join(gaugeDir(repo), "sid-1-1.json"))
    fs.writeFileSync(path.join(gaugeDir(repo), "sid-1-1.json"), "{corrupt json")
    const { host, sensor } = makeHarness({ raw: '{"check":"true"}', script: [PASS] })
    const ctx: ExtensionContext = { root: repo }

    const wrapped = gaugeExtension.wrapHost(host, ctx)
    wrapped.sensor.append(
      { ts: 1, sessionID: "sid-1", check: "true", accepted: true, gateExhausted: false, rounds: ["accepted"], interrupted: false, marker: false, durationMs: 1, host: "h", app: "claude-code" },
      ".km/gate-outcomes.ndjson",
    )
    await gaugeExtension.afterDecision(STOP, ALLOW, host, ctx)
    expect(sensor.lines).toHaveLength(1)
    expect((sensor.lines[0] as { gauge?: Record<string, unknown> }).gauge).toEqual({
      present: false,
      offReason: "no-record",
    })
  })
})

describe("(h) ordering + relativePath fidelity", () => {
  test("two held lines flush in original order to their original paths", async () => {
    const repo = mkRepo()
    const { host, sensor } = makeHarness({ raw: '{"check":"true"}', script: [PASS] })
    const ctx: ExtensionContext = { root: repo }

    const wrapped = gaugeExtension.wrapHost(host, ctx)
    wrapped.sensor.append(
      { ts: 1, sessionID: "sid-1", check: "true", accepted: true, gateExhausted: false, rounds: ["accepted"], interrupted: false, marker: false, durationMs: 1, host: "h", app: "claude-code" },
      "first.ndjson",
    )
    wrapped.sensor.append(
      { ts: 2, sessionID: "sid-1", check: "true", accepted: true, gateExhausted: false, rounds: ["accepted"], interrupted: false, marker: false, durationMs: 1, host: "h", app: "claude-code" },
      "second.ndjson",
    )
    await gaugeExtension.afterDecision(STOP, ALLOW, host, ctx)

    expect(sensor.lines.map((l) => l.ts)).toEqual([1, 2])
    expect(sensor.paths).toEqual(["first.ndjson", "second.ndjson"])
  })
})

describe("(e) no-extensions parity guarantee", () => {
  // The K1 subprocess parity tests (test/claude-code-adapter.test.ts's
  // "hook-cli.ts subprocess behavior (no extensions in gate.json)" describe
  // block) already assert this at the process boundary and needed ZERO
  // edits through R12/R13's whole ExtensionContext threading — this test
  // just re-confirms the same guarantee at this file's own level: with
  // gauge registered (EXTENSIONS is non-empty as of K4) but not enabled,
  // a real Stop cycle's decision is unaffected.
  test("gauge registered but not enabled: a real Stop cycle's decision is identical with and without going through the registry", async () => {
    const opts = { raw: '{"check":"true"}', script: [PASS] }
    const before = makeHarness(opts)
    const after = makeHarness(opts)
    before.store.save("sid-1", { ...INITIAL_STATE, edited: true }, 0)
    after.store.save("sid-1", { ...INITIAL_STATE, edited: true }, 0)

    const decisionBefore = await createGate(before.host).handle(STOP)

    const ctx: ExtensionContext = { root: "/repo" }
    const ext = await loadActiveExtensions(after.host, ctx)
    const decisionAfter = await createGate(ext.wrapHost(after.host)).handle(STOP)

    expect(decisionAfter).toEqual(decisionBefore)
  })
})
