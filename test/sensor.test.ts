import { describe, expect, test } from "bun:test"
import { buildSensorLine, KERNEL_VERSION, OPTIONAL_SENSOR_FIELDS, SENSOR_FIELDS } from "../src/kernel/sensor.ts"
import type { HostInfo, SensorLine } from "../src/kernel/ports.ts"

const info: HostInfo = { app: "opencode", host: "test-host" }
const clock = { now: () => 1_700_000_000_000 }

const base = {
  sessionID: "sess-1",
  check: "bun test",
  accepted: true,
  gateExhausted: false,
  interrupted: false,
  rounds: ["accepted"] as const,
  durationMs: 4200,
}

describe("buildSensorLine", () => {
  test("emits exactly the declared field set — no extras, none missing", () => {
    const line = buildSensorLine(info, clock, { ...base, rounds: [...base.rounds] })
    expect(Object.keys(line).sort()).toEqual([...SENSOR_FIELDS].sort())
  })

  test("declares the twelve agreed fields", () => {
    expect([...SENSOR_FIELDS].sort()).toEqual([
      "accepted",
      "app",
      "check",
      "durationMs",
      "gateExhausted",
      "host",
      "interrupted",
      "marker",
      "pluginVersion",
      "rounds",
      "sessionID",
      "ts",
    ])
  })

  // D1 (closed): pluginVersion is now adopted — this kernel always knows its
  // own version, so unlike the frozen contract's tolerated-absent optional,
  // buildSensorLine never omits it.
  test("stamps pluginVersion from the kernel's own package version", () => {
    const line = buildSensorLine(info, clock, { ...base, rounds: [...base.rounds] })
    expect(line.pluginVersion).toBe(KERNEL_VERSION)
  })

  // The consumer's frozen contract requires `marker` on every line. This
  // kernel has no marker mechanism (no session-carryover concept) — see
  // sensor.ts's doc comment on the field for the deferral this stands in for.
  test("stamps marker false, since this kernel has no marker mechanism yet", () => {
    const line = buildSensorLine(info, clock, { ...base, rounds: [...base.rounds] })
    expect(line.marker).toBe(false)
  })

  test("stamps ts from the clock", () => {
    const line = buildSensorLine(info, { now: () => 42 }, { ...base, rounds: [...base.rounds] })
    expect(line.ts).toBe(42)
  })

  // The whole point of the harness-abstract kernel: app is data from the host,
  // never a constant compiled into the kernel.
  test("takes app and host from the host info rather than hardcoding them", () => {
    const cc = buildSensorLine({ app: "claude-code", host: "box-a" }, clock, {
      ...base,
      rounds: [...base.rounds],
    })
    expect(cc.app).toBe("claude-code")
    expect(cc.host).toBe("box-a")

    const oc = buildSensorLine({ app: "opencode", host: "box-b" }, clock, {
      ...base,
      rounds: [...base.rounds],
    })
    expect(oc.app).toBe("opencode")
    expect(oc.host).toBe("box-b")
  })

  test("threads every argument verbatim", () => {
    const args = {
      sessionID: "my-session",
      check: "npm run check",
      accepted: false,
      gateExhausted: true,
      interrupted: true,
      rounds: ["verify-failed", "verify-failed"] as const,
      durationMs: 90_000,
    }
    const line = buildSensorLine(info, clock, { ...args, rounds: [...args.rounds] })
    expect(line.sessionID).toBe(args.sessionID)
    expect(line.check).toBe(args.check)
    expect(line.accepted).toBe(false)
    expect(line.gateExhausted).toBe(true)
    expect(line.interrupted).toBe(true)
    expect(line.rounds).toEqual(["verify-failed", "verify-failed"])
    expect(line.durationMs).toBe(90_000)
  })

  test("copies rounds so later mutation of the state array cannot rewrite history", () => {
    const rounds = ["verify-failed"] as ("accepted" | "verify-failed")[]
    const line = buildSensorLine(info, clock, { ...base, rounds })
    rounds.push("accepted")
    expect(line.rounds).toEqual(["verify-failed"])
  })

  test("survives a JSON round trip unchanged — it is written as NDJSON", () => {
    const line = buildSensorLine(info, clock, {
      ...base,
      rounds: ["verify-failed", "accepted"],
      accepted: true,
      gateExhausted: true,
    })
    const parsed = JSON.parse(JSON.stringify(line)) as SensorLine
    expect(parsed).toEqual(line)
  })

  test("serialises to a single line, since the sensor file is newline-delimited", () => {
    const line = buildSensorLine(info, clock, { ...base, rounds: [...base.rounds] })
    expect(JSON.stringify(line)).not.toContain("\n")
  })

  test("handles an empty rounds array", () => {
    const line = buildSensorLine(info, clock, { ...base, rounds: [] })
    expect(line.rounds).toEqual([])
  })
})

describe("additive fields", () => {
  test("declares the three optional fields", () => {
    expect([...OPTIONAL_SENSOR_FIELDS].sort()).toEqual(["checkMs", "forced", "skippedStop"])
  })

  // Existing consumers must not have to learn a new field to keep working.
  test("omits all three when not supplied, so an ordinary line is unchanged", () => {
    const line = buildSensorLine(info, clock, { ...base, rounds: [...base.rounds] })
    expect(Object.keys(line).sort()).toEqual([...SENSOR_FIELDS].sort())
    expect("checkMs" in line).toBe(false)
    expect("skippedStop" in line).toBe(false)
    expect("forced" in line).toBe(false)
  })

  test("carries per-round check times parallel to rounds", () => {
    const line = buildSensorLine(info, clock, {
      ...base,
      rounds: ["verify-failed", "accepted"],
      checkMs: [1_200, 900],
    })
    expect(line.checkMs).toEqual([1_200, 900])
    expect(line.checkMs).toHaveLength(line.rounds.length)
  })

  test("copies checkMs, like rounds, so later mutation cannot rewrite history", () => {
    const checkMs = [10]
    const line = buildSensorLine(info, clock, { ...base, rounds: [...base.rounds], checkMs })
    checkMs.push(20)
    expect(line.checkMs).toEqual([10])
  })

  test("keeps an empty checkMs, which is meaningful on a skipped-stop line", () => {
    const line = buildSensorLine(info, clock, { ...base, rounds: [], checkMs: [] })
    expect(line.checkMs).toEqual([])
  })

  test("marks a skipped stop", () => {
    const line = buildSensorLine(info, clock, { ...base, rounds: [], skippedStop: true })
    expect(line.skippedStop).toBe(true)
  })

  test("a skipped-stop line survives a JSON round trip", () => {
    const line = buildSensorLine(info, clock, {
      ...base,
      rounds: [],
      checkMs: [],
      skippedStop: true,
    })
    expect(JSON.parse(JSON.stringify(line))).toEqual(line)
    expect(JSON.stringify(line)).not.toContain("\n")
  })

  // D1 (closed): forced is now plumbed through, but this kernel has no
  // reinject-arm mechanism (KKAMAK_REINJECT is the frozen contract's sole
  // trigger, per cc-gate-plugin/src/types.ts) — no current caller ever
  // passes it, so it stays absent in practice. This test only proves the
  // plumbing works if a future caller does.
  test("marks a forced session", () => {
    const line = buildSensorLine(info, clock, { ...base, rounds: [...base.rounds], forced: true })
    expect(line.forced).toBe(true)
  })

  test("a forced line survives a JSON round trip", () => {
    const line = buildSensorLine(info, clock, { ...base, rounds: [...base.rounds], forced: true })
    expect(JSON.parse(JSON.stringify(line))).toEqual(line)
    expect(JSON.stringify(line)).not.toContain("\n")
  })
})
