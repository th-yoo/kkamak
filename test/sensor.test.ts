import { describe, expect, test } from "bun:test"
import { buildSensorLine, SENSOR_FIELDS } from "../src/kernel/sensor.ts"
import type { HostInfo, SensorLine } from "../src/kernel/ports.ts"

const info: HostInfo = { app: "opencode", host: "test-host" }
const clock = { now: () => 1_700_000_000_000 }

const base = {
  sessionId: "sess-1",
  check: "bun test",
  accepted: true,
  gateExhausted: false,
  interrupted: false,
  rounds: ["passed"] as const,
  durationMs: 4200,
}

describe("buildSensorLine", () => {
  test("emits exactly the declared field set — no extras, none missing", () => {
    const line = buildSensorLine(info, clock, { ...base, rounds: [...base.rounds] })
    expect(Object.keys(line).sort()).toEqual([...SENSOR_FIELDS].sort())
  })

  test("declares the ten agreed fields", () => {
    expect([...SENSOR_FIELDS].sort()).toEqual([
      "accepted",
      "app",
      "check",
      "durationMs",
      "gateExhausted",
      "host",
      "interrupted",
      "rounds",
      "sessionId",
      "ts",
    ])
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
      sessionId: "my-session",
      check: "npm run check",
      accepted: false,
      gateExhausted: true,
      interrupted: true,
      rounds: ["failed", "failed"] as const,
      durationMs: 90_000,
    }
    const line = buildSensorLine(info, clock, { ...args, rounds: [...args.rounds] })
    expect(line.sessionId).toBe(args.sessionId)
    expect(line.check).toBe(args.check)
    expect(line.accepted).toBe(false)
    expect(line.gateExhausted).toBe(true)
    expect(line.interrupted).toBe(true)
    expect(line.rounds).toEqual(["failed", "failed"])
    expect(line.durationMs).toBe(90_000)
  })

  test("copies rounds so later mutation of the state array cannot rewrite history", () => {
    const rounds = ["failed"] as ("passed" | "failed")[]
    const line = buildSensorLine(info, clock, { ...base, rounds })
    rounds.push("passed")
    expect(line.rounds).toEqual(["failed"])
  })

  test("survives a JSON round trip unchanged — it is written as NDJSON", () => {
    const line = buildSensorLine(info, clock, {
      ...base,
      rounds: ["failed", "passed"],
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
