import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  gaugeDir,
  nextN,
  writeGaugeFile,
  pickPending,
  consumePending,
  underDailyCap,
  bumpDailyCount,
} from "../src/extensions/gauge/files.ts"

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-gauge-test-"))
}

const SID = "aaaa-bbbb"

const GAUGE = {
  v: 1 as const,
  sessionID: SID,
  n: 1,
  ts: 1000,
  model: "haiku",
  derivationMs: 1234,
  goalSummary: "g",
  criteria: ["c"],
  check: "true",
  confidence: 0.9,
}

test("gaugeDir is <cwd>/.km/gauge", () => {
  expect(gaugeDir("/repo")).toBe(path.join("/repo", ".km", "gauge"))
})

test("nextN starts at 1 in an empty/missing dir", () => {
  const d = path.join(tmp(), "nope")
  expect(nextN(d, SID)).toBe(1)
})

test("nextN counts past pending, done, and req files; other sessions ignored", () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, `${SID}-1.done.json`), "{}")
  fs.writeFileSync(path.join(d, `${SID}-2.json`), "{}")
  fs.writeFileSync(path.join(d, `${SID}-5.req.json`), "{}")
  fs.writeFileSync(path.join(d, `other-9.json`), "{}")
  expect(nextN(d, SID)).toBe(6)
})

test("writeGaugeFile then pickPending round-trips; highest n wins", () => {
  const d = tmp()
  writeGaugeFile(d, { ...GAUGE, n: 1, goalSummary: "old" })
  writeGaugeFile(d, { ...GAUGE, n: 3, goalSummary: "new" })
  const got = pickPending(d, SID)!
  expect(got.n).toBe(3)
  expect(got.goalSummary).toBe("new")
})

test("pickPending ignores done/req files and other sessions; corrupt file → undefined", () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, `${SID}-1.done.json`), JSON.stringify(GAUGE))
  fs.writeFileSync(path.join(d, `${SID}-2.req.json`), JSON.stringify(GAUGE))
  fs.writeFileSync(path.join(d, `other-1.json`), JSON.stringify({ ...GAUGE, sessionID: "other" }))
  expect(pickPending(d, SID)).toBeUndefined()

  fs.writeFileSync(path.join(d, `${SID}-3.json`), "{corrupt")
  expect(pickPending(d, SID)).toBeUndefined()
})

test("consumePending renames pending → done with eval merged in", () => {
  const d = tmp()
  writeGaugeFile(d, GAUGE)
  consumePending(d, SID, 1, { pass: false, wouldBlock: true })
  expect(fs.existsSync(path.join(d, `${SID}-1.json`))).toBe(false)
  const done = JSON.parse(fs.readFileSync(path.join(d, `${SID}-1.done.json`), "utf-8"))
  expect(done.goalSummary).toBe("g")
  expect(done.eval).toEqual({ pass: false, wouldBlock: true })
})

test("daily cap: under until cap reached, resets on a new day", () => {
  const d = tmp()
  const day1 = "2026-07-28"
  expect(underDailyCap(d, day1, 2)).toBe(true)
  bumpDailyCount(d, day1)
  expect(underDailyCap(d, day1, 2)).toBe(true)
  bumpDailyCount(d, day1)
  expect(underDailyCap(d, day1, 2)).toBe(false)

  const day2 = "2026-07-29"
  expect(underDailyCap(d, day2, 2)).toBe(true)
  bumpDailyCount(d, day2)
  const raw = JSON.parse(fs.readFileSync(path.join(d, "daily-count"), "utf-8"))
  expect(raw).toEqual({ date: day2, count: 1 })
})

test("daily cap: corrupt counter file fails CLOSED (over cap)", () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, "daily-count"), "{corrupt")
  expect(underDailyCap(d, "2026-07-28", 30)).toBe(false)
})

// ── v2 fields round-trip (km-gauge v2 extractor, Task 2) ────────────────

const GAUGE_V2 = {
  v: 2 as const,
  sessionID: SID,
  n: 1,
  ts: 1000,
  model: "haiku",
  derivationMs: 1234,
  goalSummary: "g",
  criteria: ["c"],
  check: "true",
  confidence: 0.9,
  class: "C" as const,
  reason: null,
  horizon: "single-turn" as const,
  downgraded: { fromClass: "C" as const, fromCheck: "true", rule: "b-keyword" as const },
  strike: 1 as const,
}

test("v2: class/reason/horizon/downgraded/strike round-trip through write/pick", () => {
  const d = tmp()
  writeGaugeFile(d, GAUGE_V2)
  const got = pickPending(d, SID)!
  expect(got.v).toBe(2)
  expect(got.class).toBe("C")
  expect(got.reason).toBeNull()
  expect(got.horizon).toBe("single-turn")
  expect(got.downgraded).toEqual({ fromClass: "C", fromCheck: "true", rule: "b-keyword" })
  expect(got.strike).toBe(1)
})

test("v2: same-n overwrite carries strike:1 through", () => {
  const d = tmp()
  writeGaugeFile(d, { ...GAUGE_V2, n: 4, strike: undefined })
  writeGaugeFile(d, { ...GAUGE_V2, n: 4, strike: 1 })
  const got = pickPending(d, SID)!
  expect(got.n).toBe(4)
  expect(got.strike).toBe(1)
})
