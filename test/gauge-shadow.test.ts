import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { applyTwoStrike, shadowEvaluateAtStop } from "../src/extensions/gauge/shadow.ts"
import { gaugeDir, writeGaugeFile, type GaugeFile } from "../src/extensions/gauge/files.ts"
import { parseGateConfig } from "../src/kernel/config.ts"
import type { GaugeSensorField, GaugedSensorLine } from "../src/extensions/gauge/types.ts"

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-gauge-shadow-"))
}

// K4 port note: the lab's fixture also set "gauge": true — that field lives
// on the lab's OWN GateConfig (a MAP row kkamak's core deliberately omits;
// enablement here is the K1 extensions mechanism instead). Dropped: shadow.ts
// itself only ever reads cfg.check (confirmed by reading the source), so it
// was never load-bearing for this test either.
const CFG = parseGateConfig(`{"check": "floor-check"}`)!

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

function floorLine(over: Partial<GaugedSensorLine> = {}): GaugedSensorLine {
  return {
    ts: 2000,
    sessionID: "sid-1",
    check: "floor-check",
    accepted: true,
    gateExhausted: false,
    rounds: ["accepted"],
    interrupted: false,
    marker: false,
    durationMs: 10,
    host: "h",
    app: "claude-code",
    ...over,
  }
}

const deps = { now: () => 3000, hostname: () => "h", log: () => {} }
const passCheck = async () => ({ code: 0, out: "" })
const failCheck = async () => ({ code: 1, out: "" })

test("no pending gauge → sensor line passes through untouched", async () => {
  const repo = mkRepo()
  const line = floorLine()
  const out = await shadowEvaluateAtStop(repo, "sid-1", CFG, line, passCheck, deps)
  expect(out).toBe(line)
})

test("pending gauge + accepting floor line → gauge field attached, pending consumed", async () => {
  const repo = mkRepo()
  pendingGauge(repo)
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, floorLine(), failCheck, deps))!
  expect(out.gauge).toMatchObject({
    present: true,
    executable: true,
    pass: false,
    wouldBlock: true,
    agreesWithFloor: false, // the M3 shape: floor accepted, gauge disagrees
    n: 1,
  })
  // consumed: pending renamed to .done.json with eval embedded
  const done = JSON.parse(
    fs.readFileSync(path.join(gaugeDir(repo), "sid-1-1.done.json"), "utf-8"),
  )
  expect(done.eval.pass).toBe(false)
})

test("exhausted floor line counts as NOT accepted for agreement", async () => {
  const repo = mkRepo()
  pendingGauge(repo)
  const line = floorLine({ accepted: true, gateExhausted: true, rounds: ["verify-failed", "verify-failed", "verify-failed"] })
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, line, failCheck, deps))!
  expect(out.gauge!.agreesWithFloor).toBe(true) // both say not-done
})

test("interrupted line → no gauge eval, pending kept for the next cycle", async () => {
  const repo = mkRepo()
  pendingGauge(repo)
  const line = floorLine({ interrupted: true })
  const out = await shadowEvaluateAtStop(repo, "sid-1", CFG, line, passCheck, deps)
  expect(out).toBe(line)
  expect(fs.existsSync(path.join(gaugeDir(repo), "sid-1-1.json"))).toBe(true)
})

test("no floor line + pending gauge → gauge-only line with rounds:[] marker", async () => {
  const repo = mkRepo()
  pendingGauge(repo)
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, undefined, failCheck, deps))!
  expect(out.rounds).toEqual([])
  expect(out.accepted).toBe(true)
  expect(out.gateExhausted).toBe(false)
  expect(out.interrupted).toBe(false)
  expect(out.durationMs).toBe(0)
  expect(out.host).toBe("h")
  expect(out.gauge).toMatchObject({ present: true, pass: false, wouldBlock: true })
  expect(out.gauge!.agreesWithFloor).toBeUndefined() // floor never ran
})

test("no floor line + no pending gauge → undefined (nothing to log)", async () => {
  const repo = mkRepo()
  const out = await shadowEvaluateAtStop(repo, "sid-1", CFG, undefined, passCheck, deps)
  expect(out).toBeUndefined()
})

test("evaluator IO failure is swallowed: sensor line survives un-gauged", async () => {
  const repo = mkRepo()
  pendingGauge(repo)
  const boom = async () => {
    throw new Error("spawn dead")
  }
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, floorLine(), boom, deps))!
  // runCheck throw → executable:false inside the gauge field, line still emitted
  expect(out.gauge).toMatchObject({ present: true, executable: false })
})

// ── two-strike (km-gauge v2 extractor, Task 3) ────────────────────────────
// pre-reg §2.3/design plan "Two-strike" table. class C + horizon multi-turn
// only; single-turn C and legacy (no class) pendings are UNCHANGED behavior.

function multiTurnCPending(repo: string, over: Partial<GaugeFile> = {}): void {
  writeGaugeFile(gaugeDir(repo), {
    v: 2,
    sessionID: "sid-1",
    n: 1,
    ts: 500,
    model: "haiku",
    derivationMs: 800,
    goalSummary: "g",
    criteria: ["c"],
    check: "gauge-check",
    confidence: 0.6,
    class: "C",
    reason: null,
    horizon: "multi-turn",
    ...over,
  })
}

const pendingPath = (repo: string, n = 1) => path.join(gaugeDir(repo), `sid-1-${n}.json`)
const donePath = (repo: string, n = 1) => path.join(gaugeDir(repo), `sid-1-${n}.done.json`)

test("multi-turn C: first fail (floor cycle ran) → strike:1, wouldBlock:false, pending REWRITTEN not consumed", async () => {
  const repo = mkRepo()
  multiTurnCPending(repo)
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, floorLine(), failCheck, deps))!
  expect(out.gauge).toMatchObject({ present: true, executable: true, pass: false, wouldBlock: false, strike: 1 })

  expect(fs.existsSync(donePath(repo))).toBe(false)
  expect(fs.existsSync(pendingPath(repo))).toBe(true)
  const pending = JSON.parse(fs.readFileSync(pendingPath(repo), "utf-8"))
  expect(pending.strike).toBe(1)
  expect(pending.class).toBe("C")
  expect(pending.horizon).toBe("multi-turn")
})

test("multi-turn C: strike:1 + fail (floor cycle ran) → wouldBlock:true strike:2, consumed, .done.json embeds strike:2", async () => {
  const repo = mkRepo()
  multiTurnCPending(repo, { strike: 1 })
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, floorLine(), failCheck, deps))!
  expect(out.gauge).toMatchObject({ pass: false, wouldBlock: true, strike: 2 })

  expect(fs.existsSync(pendingPath(repo))).toBe(false)
  const done = JSON.parse(fs.readFileSync(donePath(repo), "utf-8"))
  expect(done.eval.strike).toBe(2)
  expect(done.eval.wouldBlock).toBe(true)
})

test("multi-turn C: pass at strike:1 (floor cycle ran) → consumed, strike:1 kept on the recovery line", async () => {
  const repo = mkRepo()
  multiTurnCPending(repo, { strike: 1 })
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, floorLine(), passCheck, deps))!
  expect(out.gauge).toMatchObject({ pass: true, wouldBlock: false, strike: 1 })
  expect(fs.existsSync(pendingPath(repo))).toBe(false)
  expect(fs.existsSync(donePath(repo))).toBe(true)
})

test("multi-turn C: pass with no prior strike (floor cycle ran) → consumed immediately, no strike field", async () => {
  const repo = mkRepo()
  multiTurnCPending(repo)
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, floorLine(), passCheck, deps))!
  expect(out.gauge).toMatchObject({ pass: true, wouldBlock: false })
  expect(out.gauge!.strike).toBeUndefined()
  expect(fs.existsSync(donePath(repo))).toBe(true)
})

test("single-turn C: immediate wouldBlock at any Stop incl. gauge-only (v1 behavior, unchanged)", async () => {
  const repo = mkRepo()
  multiTurnCPending(repo, { horizon: "single-turn" })
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, undefined, failCheck, deps))!
  expect(out.gauge).toMatchObject({ pass: false, wouldBlock: true })
  expect(out.gauge!.strike).toBeUndefined()
  expect(fs.existsSync(donePath(repo))).toBe(true)
})

test("multi-turn C: gauge-only Stop (no floor cycle) → NOT evaluated, pending untouched, no strike", async () => {
  const repo = mkRepo()
  multiTurnCPending(repo)
  let called = false
  const spyCheck = async () => {
    called = true
    return { code: 1, out: "" }
  }
  const out = await shadowEvaluateAtStop(repo, "sid-1", CFG, undefined, spyCheck, deps)
  expect(called).toBe(false) // evaluateGauge (and its runCheck) never ran

  expect(fs.existsSync(donePath(repo))).toBe(false)
  const pending = JSON.parse(fs.readFileSync(pendingPath(repo), "utf-8"))
  expect(pending.strike).toBeUndefined()
  expect(pending.class).toBe("C")
  expect(pending.horizon).toBe("multi-turn")

  // gauge field, if attached, is passthrough-only — no execution outcome.
  expect(out?.rounds).toEqual([])
  expect(out?.gauge?.class).toBe("C")
  expect(out?.gauge?.executable).toBe(false)
  expect(out?.gauge?.pass).toBeUndefined()
  expect(out?.gauge?.wouldBlock).toBeUndefined()
  expect(out?.gauge?.strike).toBeUndefined()
})

test("multi-turn C: strike:1 pending at a gauge-only Stop (no floor cycle) → NOT evaluated, pending byte-unchanged, passthrough field carries strike:1", async () => {
  const repo = mkRepo()
  multiTurnCPending(repo, { strike: 1 })
  const before = fs.readFileSync(pendingPath(repo), "utf-8")
  let called = false
  const spyCheck = async () => {
    called = true
    return { code: 1, out: "" }
  }
  const out = await shadowEvaluateAtStop(repo, "sid-1", CFG, undefined, spyCheck, deps)
  expect(called).toBe(false) // evaluateGauge (and its runCheck) never ran

  expect(fs.existsSync(donePath(repo))).toBe(false)
  const after = fs.readFileSync(pendingPath(repo), "utf-8")
  expect(after).toBe(before) // byte-unchanged, still strike:1

  // fabricated line: passthrough-only field, strike:1 carried through, no execution outcome.
  expect(out?.rounds).toEqual([])
  expect(out?.gauge?.class).toBe("C")
  expect(out?.gauge?.horizon).toBe("multi-turn")
  expect(out?.gauge?.executable).toBe(false)
  expect(out?.gauge?.strike).toBe(1)
  expect(out?.gauge?.pass).toBeUndefined()
  expect(out?.gauge?.wouldBlock).toBeUndefined()
})

test("multi-turn C: refused check (floor ran) → consumed immediately, no strike", async () => {
  const repo = mkRepo()
  multiTurnCPending(repo, { check: "rm -rf /" })
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, floorLine(), passCheck, deps))!
  expect(out.gauge?.refused).toBe("destructive-command")
  expect(out.gauge?.strike).toBeUndefined()
  expect(fs.existsSync(donePath(repo))).toBe(true)
  expect(fs.existsSync(pendingPath(repo))).toBe(false)
})

test("multi-turn C: 127 (floor ran) → consumed immediately, no strike", async () => {
  const repo = mkRepo()
  multiTurnCPending(repo)
  const notFound = async () => ({ code: 127, out: "" })
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, floorLine(), notFound, deps))!
  expect(out.gauge?.executable).toBe(false)
  expect(out.gauge?.strike).toBeUndefined()
  expect(fs.existsSync(donePath(repo))).toBe(true)
  expect(fs.existsSync(pendingPath(repo))).toBe(false)
})

test("multi-turn C: interrupt preserves a strike:1 pending untouched", async () => {
  const repo = mkRepo()
  multiTurnCPending(repo, { strike: 1 })
  const line = floorLine({ interrupted: true })
  const out = await shadowEvaluateAtStop(repo, "sid-1", CFG, line, failCheck, deps)
  expect(out).toBe(line)
  const pending = JSON.parse(fs.readFileSync(pendingPath(repo), "utf-8"))
  expect(pending.strike).toBe(1)
})

test("multi-turn C: newer-n pending supersedes an older strike:1 pending (orphan-honesty: never consumed)", async () => {
  const repo = mkRepo()
  multiTurnCPending(repo, { n: 1, strike: 1 })
  multiTurnCPending(repo, { n: 2 })
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, floorLine(), failCheck, deps))!
  // pickPending = highest n: the n:2 pending is the one evaluated (its own first fail).
  expect(out.gauge?.n).toBe(2)
  expect(out.gauge?.strike).toBe(1)

  const orphan = JSON.parse(fs.readFileSync(pendingPath(repo, 1), "utf-8"))
  expect(orphan.strike).toBe(1) // untouched, never superseded on disk
  expect(fs.existsSync(donePath(repo, 1))).toBe(false) // and never consumed
})

test("v1-legacy pending (no class): fail → immediate wouldBlock, consumed (today's behavior, unchanged)", async () => {
  const repo = mkRepo()
  pendingGauge(repo) // v:1, no class field at all
  const out = (await shadowEvaluateAtStop(repo, "sid-1", CFG, floorLine(), failCheck, deps))!
  expect(out.gauge).toMatchObject({ wouldBlock: true })
  expect(out.gauge!.strike).toBeUndefined()
  expect(fs.existsSync(donePath(repo))).toBe(true)
})

// ── applyTwoStrike: pure unit rows ─────────────────────────────────────────

function mkPending(over: Partial<GaugeFile> = {}): GaugeFile {
  return {
    v: 2,
    sessionID: "s",
    n: 1,
    ts: 1,
    model: "haiku",
    derivationMs: 5,
    goalSummary: "g",
    criteria: ["c"],
    check: "chk",
    confidence: 0.9,
    class: "C",
    reason: null,
    horizon: "multi-turn",
    ...over,
  }
}

function mkGauge(over: Partial<GaugeSensorField> = {}): GaugeSensorField {
  return { present: true, executable: true, pass: false, wouldBlock: true, ...over }
}

test("applyTwoStrike: non-C pending → field unchanged (same reference), keepPending false", () => {
  const pending = mkPending({ class: "B", horizon: null, check: null })
  const gauge = mkGauge({ executable: false, pass: undefined, wouldBlock: undefined })
  const { field, keepPending } = applyTwoStrike(pending, gauge, true)
  expect(field).toBe(gauge)
  expect(keepPending).toBe(false)
})

test("applyTwoStrike: single-turn C → field unchanged, keepPending false", () => {
  const pending = mkPending({ horizon: "single-turn" })
  const gauge = mkGauge()
  const { field, keepPending } = applyTwoStrike(pending, gauge, true)
  expect(field).toBe(gauge)
  expect(keepPending).toBe(false)
})

test("applyTwoStrike: v1-legacy pending (no class) → field unchanged, keepPending false", () => {
  const pending = mkPending({ class: undefined, reason: undefined, horizon: undefined })
  const gauge = mkGauge()
  const { field, keepPending } = applyTwoStrike(pending, gauge, true)
  expect(field).toBe(gauge)
  expect(keepPending).toBe(false)
})

test("applyTwoStrike: multi-turn C without a floor cycle → no strike movement (pure rule row)", () => {
  const pending = mkPending()
  const gauge = mkGauge()
  const { field, keepPending } = applyTwoStrike(pending, gauge, false)
  expect(field).toBe(gauge)
  expect(keepPending).toBe(false)
})

test("applyTwoStrike: multi-turn C first fail (floor ran) → strike:1, wouldBlock forced false, keepPending true", () => {
  const pending = mkPending()
  const gauge = mkGauge({ pass: false, wouldBlock: true })
  const { field, keepPending } = applyTwoStrike(pending, gauge, true)
  expect(field).toMatchObject({ wouldBlock: false, strike: 1 })
  expect(keepPending).toBe(true)
})

test("applyTwoStrike: multi-turn C second fail (pending.strike:1, floor ran) → strike:2, wouldBlock true, keepPending false", () => {
  const pending = mkPending({ strike: 1 })
  const gauge = mkGauge({ pass: false, wouldBlock: true, strike: 1 })
  const { field, keepPending } = applyTwoStrike(pending, gauge, true)
  expect(field).toMatchObject({ wouldBlock: true, strike: 2 })
  expect(keepPending).toBe(false)
})

test("applyTwoStrike: multi-turn C pass → field unchanged (strike rides through as-is), keepPending false", () => {
  const pending = mkPending({ strike: 1 })
  const gauge = mkGauge({ pass: true, wouldBlock: false, strike: 1 })
  const { field, keepPending } = applyTwoStrike(pending, gauge, true)
  expect(field).toBe(gauge)
  expect(keepPending).toBe(false)
})

test("applyTwoStrike: multi-turn C refused/unrunnable (executable:false) → field unchanged, keepPending false", () => {
  const pending = mkPending()
  const gauge = mkGauge({ executable: false, pass: undefined, wouldBlock: undefined, refused: "destructive-command" })
  const { field, keepPending } = applyTwoStrike(pending, gauge, true)
  expect(field).toBe(gauge)
  expect(keepPending).toBe(false)
})
