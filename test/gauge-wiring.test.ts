import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createGate } from "../src/kernel/index.ts"
import { INITIAL_STATE } from "../src/kernel/state.ts"
import { loadActiveExtensions } from "../src/extensions/registry.ts"
import type { ExtensionContext } from "../src/extensions/registry.ts"
import { gaugeExtension } from "../src/extensions/gauge/index.ts"
import { gaugeDir, pickPending, writeGaugeFile, type GaugeFile } from "../src/extensions/gauge/files.ts"
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

function floorLine(): import("../src/kernel/ports.ts").SensorLine {
  return {
    ts: 1,
    sessionID: "sid-1",
    check: "true",
    accepted: true,
    gateExhausted: false,
    rounds: ["accepted"],
    interrupted: false,
    marker: false,
    durationMs: 1,
    host: "h",
    app: "claude-code",
  }
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
    wrapped.sensor.append(floorLine(), ".km/gate-outcomes.ndjson")
    expect(sensor.lines).toHaveLength(1)
    expect((sensor.lines[0] as { gauge?: unknown }).gauge).toBeUndefined()
  })
})

describe("(b)/Q7 real enablement path: wrapHost(h) !== h, and a real Stop cycle produces a gauge-annotated line", () => {
  test("gate.json {extensions:{gauge:true}} via the real loadActiveExtensions → wrapHost changes the host, and the flushed Stop line carries a real gauge field", async () => {
    const repo = mkRepo()
    pendingGauge(repo)
    const { host, store, sensor } = makeHarness({
      raw: '{"check":"true","extensions":{"gauge":true}}',
      script: [PASS, FAIL], // 1st: the floor check (kernel); 2nd: the gauge's own derived check
    })
    store.save("sid-1", { ...INITIAL_STATE, edited: true }, 0)
    const ctx: ExtensionContext = { root: repo }

    const ext = await loadActiveExtensions(host, ctx)
    const wrapped = ext.wrapHost(host)
    expect(wrapped).not.toBe(host) // a registry-key typo would leave this identity — real gate

    const decision = await createGate(wrapped).handle(STOP)
    await ext.afterDecision(STOP, decision)

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

describe("(d)/(g) total dependency failure: afterDecision resolves, every held line still flushed, nothing remains held", () => {
  test("config unparseable at flush time → afterDecision resolves, held line flushed with offReason:error (Q5: distinct from no-record), and a second afterDecision on the same host flushes nothing (zero-remaining observable)", async () => {
    const repo = mkRepo()
    pendingGauge(repo)
    const { host, sensor, config } = makeHarness({ raw: '{"check":"true"}', script: [PASS] })
    const ctx: ExtensionContext = { root: repo }

    const wrapped = gaugeExtension.wrapHost(host, ctx)
    wrapped.sensor.append(floorLine(), ".km/gate-outcomes.ndjson")
    // Break config parsing entirely for the flush's own read — annotateLine's
    // own guard (no cfg -> immediate stamped fallback) must still resolve.
    config.raw = "{not json"

    await expect(gaugeExtension.afterDecision(STOP, ALLOW, host, ctx)).resolves.toBeUndefined()
    expect(sensor.lines).toHaveLength(1)
    expect((sensor.lines[0] as { gauge?: Record<string, unknown> }).gauge).toEqual({
      present: false,
      offReason: "error", // Q5: unreadable config is a real break, not "nothing was pending"
    })

    // Zero-remaining observable (Q1/g): the WeakMap entry for this host was
    // drained on the first afterDecision call — a second call must find
    // nothing held and append nothing new.
    const linesBefore = sensor.lines.length
    await gaugeExtension.afterDecision(STOP, ALLOW, host, ctx)
    expect(sensor.lines.length).toBe(linesBefore)
  })

  test("the check runner rejects (a genuine internal error, not a failing check) → afterDecision still resolves and flushes", async () => {
    const repo = mkRepo()
    pendingGauge(repo)
    const { host, sensor } = makeHarness({ raw: '{"check":"true"}', fallback: new Error("spawn exploded") })
    const ctx: ExtensionContext = { root: repo }

    const wrapped = gaugeExtension.wrapHost(host, ctx)
    wrapped.sensor.append(floorLine(), ".km/gate-outcomes.ndjson")
    await expect(gaugeExtension.afterDecision(STOP, ALLOW, host, ctx)).resolves.toBeUndefined()
    expect(sensor.lines).toHaveLength(1) // flushed, not dropped
  })
})

describe("(f) eval throws mid-flush: the held line is still flushed with offReason:error", () => {
  test("a genuinely throwing dependency (host.config.read itself) is caught by annotateLine's own outer catch, not swallowed silently upstream", async () => {
    const repo = mkRepo()
    pendingGauge(repo)
    const { host, sensor } = makeHarness({ raw: '{"check":"true"}', script: [PASS] })
    // Inject a throwing dep directly — per the review finding, substituting
    // a corrupt pending file does NOT exercise this path: pickPending's own
    // try/catch (files.ts) already swallows a corrupt pending file and
    // treats it as "nothing pending", never reaching annotateLine's outer
    // catch at all. host.config.read() throwing is a real dependency
    // failure that DOES reach it.
    host.config = {
      read(): string | undefined {
        throw new Error("disk read exploded")
      },
    }
    const ctx: ExtensionContext = { root: repo }

    const wrapped = gaugeExtension.wrapHost(host, ctx)
    wrapped.sensor.append(floorLine(), ".km/gate-outcomes.ndjson")
    await gaugeExtension.afterDecision(STOP, ALLOW, host, ctx)

    expect(sensor.lines).toHaveLength(1)
    expect((sensor.lines[0] as { gauge?: Record<string, unknown> }).gauge).toEqual({
      present: false,
      offReason: "error",
    })
  })
})

describe("(h) ordering + relativePath fidelity", () => {
  test("two held lines flush in original order to their original paths", async () => {
    const repo = mkRepo()
    const { host, sensor } = makeHarness({ raw: '{"check":"true"}', script: [PASS] })
    const ctx: ExtensionContext = { root: repo }

    const wrapped = gaugeExtension.wrapHost(host, ctx)
    wrapped.sensor.append({ ...floorLine(), ts: 1 }, "first.ndjson")
    wrapped.sensor.append({ ...floorLine(), ts: 2 }, "second.ndjson")
    await gaugeExtension.afterDecision(STOP, ALLOW, host, ctx)

    expect(sensor.lines.map((l) => l.ts)).toEqual([1, 2])
    expect(sensor.paths).toEqual(["first.ndjson", "second.ndjson"])
  })
})

describe("(e) no-extensions parity guarantee", () => {
  // The K1 subprocess parity tests (test/claude-code-adapter.test.ts's
  // "hook-cli.ts subprocess behavior (no extensions in gate.json)" describe
  // block) already assert this at the process boundary and needed ZERO
  // edits through R12/R13/R16's whole redesign — this test re-confirms the
  // same guarantee at this file's own level.
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

describe("Q1 (Critical): per-host held-line isolation — two hosts in one process must never cross-contaminate", () => {
  test("host A's held line flushes to host A's sink under A's relativePath; host B's flushes to B's under B's — never swapped", async () => {
    const repoA = mkRepo()
    const repoB = mkRepo()
    const a = makeHarness({ raw: '{"check":"true"}', script: [PASS] })
    const b = makeHarness({ raw: '{"check":"true"}', script: [PASS] })
    const ctxA: ExtensionContext = { root: repoA }
    const ctxB: ExtensionContext = { root: repoB }

    const wrappedA = gaugeExtension.wrapHost(a.host, ctxA)
    const wrappedB = gaugeExtension.wrapHost(b.host, ctxB)
    wrappedA.sensor.append({ ...floorLine(), ts: 111, sessionID: "sid-a" }, "a-path.ndjson")
    wrappedB.sensor.append({ ...floorLine(), ts: 222, sessionID: "sid-b" }, "b-path.ndjson")

    await gaugeExtension.afterDecision({ kind: "stop-requested", sessionID: "sid-a" }, ALLOW, a.host, ctxA)
    await gaugeExtension.afterDecision({ kind: "stop-requested", sessionID: "sid-b" }, ALLOW, b.host, ctxB)

    expect(a.sensor.lines).toHaveLength(1)
    expect(a.sensor.lines[0]!.ts).toBe(111)
    expect(a.sensor.paths).toEqual(["a-path.ndjson"])

    expect(b.sensor.lines).toHaveLength(1)
    expect(b.sensor.lines[0]!.ts).toBe(222)
    expect(b.sensor.paths).toEqual(["b-path.ndjson"])
  })
})

describe("Q3 (High): a gauge-only Stop (no file edits) still runs shadow eval and consumes a pending derivation", () => {
  test("no state.edited at all (kernel returns ALLOW before ever calling sensor.append) + a pending derivation exists → afterDecision still fabricates a gauge-only line AND consumes the pending file", async () => {
    const repo = mkRepo()
    pendingGauge(repo)
    const { host, sensor } = makeHarness({ raw: '{"check":"true"}', script: [FAIL] })
    // Deliberately NOT arming state (no store.save) — a real no-edit Stop.
    const ctx: ExtensionContext = { root: repo }

    const wrapped = gaugeExtension.wrapHost(host, ctx)
    const decision = await createGate(wrapped).handle(STOP)
    expect(decision).toEqual({ kind: "allow" }) // confirms the kernel's own no-edit fast path fired

    await gaugeExtension.afterDecision(STOP, decision, host, ctx)

    // A line WAS appended even though the kernel itself never held one —
    // the fabricated gauge-only line (rounds: [] marker, per shadow.ts).
    expect(sensor.lines).toHaveLength(1)
    expect(sensor.lines[0]!.rounds).toEqual([])
    expect((sensor.lines[0] as { gauge?: Record<string, unknown> }).gauge).toMatchObject({
      present: true,
      pass: false,
    })

    // The pending derivation was genuinely consumed (renamed to .done.json),
    // not just measured and left behind — matching shadow.ts's own
    // shadowEvaluateAtStop contract for a v1-legacy (non-multi-turn-C) pending.
    expect(pickPending(gaugeDir(repo), "sid-1")).toBeUndefined()
    expect(fs.existsSync(path.join(gaugeDir(repo), "sid-1-1.done.json"))).toBe(true)
  })

  test("no held line, no pending derivation either → nothing is fabricated, nothing is appended", async () => {
    const repo = mkRepo() // no pendingGauge()
    const { host, sensor } = makeHarness({ raw: '{"check":"true"}', script: [PASS] })
    const ctx: ExtensionContext = { root: repo }

    const wrapped = gaugeExtension.wrapHost(host, ctx)
    const decision = await createGate(wrapped).handle(STOP)
    await gaugeExtension.afterDecision(STOP, decision, host, ctx)

    expect(sensor.lines).toHaveLength(0)
  })
})

describe("N1: an interrupted held line with a pending derivation is offReason:no-record, never error", () => {
  test("line.interrupted=true, a pending derivation exists → shadow.ts's own no-op branch fires; flushed as no-record (routine preemption, not a break)", async () => {
    const repo = mkRepo()
    pendingGauge(repo)
    const { host, sensor } = makeHarness({ raw: '{"check":"true"}', script: [] })
    const ctx: ExtensionContext = { root: repo }

    const wrapped = gaugeExtension.wrapHost(host, ctx)
    wrapped.sensor.append({ ...floorLine(), interrupted: true }, ".km/gate-outcomes.ndjson")
    await gaugeExtension.afterDecision(STOP, ALLOW, host, ctx)

    expect(sensor.lines).toHaveLength(1)
    expect((sensor.lines[0] as { gauge?: Record<string, unknown> }).gauge).toEqual({
      present: false,
      offReason: "no-record",
    })
    // The pending derivation was deliberately left untouched for the next cycle.
    expect(pickPending(gaugeDir(repo), "sid-1")).toBeDefined()
  })
})

describe("N2: afterDecision idempotency — a second call on the same host (no new wrapHost) must not re-fabricate", () => {
  test("a multi-turn-C pending stays byte-untouched after a gauge-only-Stop fabrication; a second afterDecision call on the same host appends nothing new", async () => {
    const repo = mkRepo()
    pendingGauge(repo, { class: "C", horizon: "multi-turn" })
    const { host, sensor } = makeHarness({ raw: '{"check":"true"}', script: [] })
    // Deliberately NOT arming state — a real no-edit, gauge-only Stop.
    const ctx: ExtensionContext = { root: repo }

    const wrapped = gaugeExtension.wrapHost(host, ctx)
    const decision = await createGate(wrapped).handle(STOP)
    expect(decision).toEqual({ kind: "allow" })

    await gaugeExtension.afterDecision(STOP, decision, host, ctx)
    expect(sensor.lines).toHaveLength(1) // fabricated once
    // M6' fix (shadow.ts): an open multi-turn-C pending on a no-floor Stop
    // is left byte-untouched, not consumed — the exact condition under
    // which a length-only check would re-fabricate on every extra call.
    expect(pickPending(gaugeDir(repo), "sid-1")).toBeDefined()

    const linesBefore = sensor.lines.length
    await gaugeExtension.afterDecision(STOP, decision, host, ctx) // no wrapHost in between
    expect(sensor.lines.length).toBe(linesBefore)
  })
})
