import { describe, expect, test } from "bun:test"
import { createGate } from "../src/kernel/gate.ts"
import { FAIL, FakeClock, makeHarness, PASS } from "./fakes.ts"

const SESSION = "sess-1"
const edit = { kind: "file-edited", sessionId: SESSION } as const
const stop = { kind: "stop-requested", sessionId: SESSION } as const
const prompt = { kind: "new-user-prompt", sessionId: SESSION } as const

describe("arming", () => {
  test("an unedited session stops freely and never runs the check", async () => {
    const h = makeHarness()
    const gate = createGate(h.host)
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
    expect(h.check.calls).toHaveLength(0)
  })

  test("an edit arms the session, so the next stop runs the check", async () => {
    const h = makeHarness({ script: [PASS] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(h.store.peek(SESSION)?.edited).toBe(true)
    await gate.handle(stop)
    expect(h.check.calls).toHaveLength(1)
  })

  test("editing in a repo with no gate.json accumulates no state", async () => {
    const h = makeHarness({ raw: undefined })
    const gate = createGate(h.host)
    expect(await gate.handle(edit)).toEqual({ kind: "allow" })
    expect(h.store.peek(SESSION)).toBeUndefined()
  })

  test("sessions are independent", async () => {
    const h = makeHarness({ fallback: PASS })
    const gate = createGate(h.host)
    await gate.handle({ kind: "file-edited", sessionId: "a" })
    expect(await gate.handle({ kind: "stop-requested", sessionId: "b" })).toEqual({ kind: "allow" })
    expect(h.check.calls).toHaveLength(0)
  })
})

describe("passing check", () => {
  test("allows the stop and records an accepted line", async () => {
    const h = makeHarness({ script: [PASS], clock: new FakeClock(1_000, 500) })
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })

    expect(h.sensor.lines).toHaveLength(1)
    expect(h.sensor.lines[0]).toMatchObject({
      sessionId: SESSION,
      check: "bun test",
      accepted: true,
      gateExhausted: false,
      interrupted: false,
      rounds: ["passed"],
      app: "test-app",
      host: "test-host",
    })
  })

  test("stands the session down, so a second stop runs nothing", async () => {
    const h = makeHarness({ fallback: PASS })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    await gate.handle(stop)
    expect(h.check.calls).toHaveLength(1)
  })

  test("passes the configured timeout to the runner", async () => {
    const h = makeHarness({ raw: '{"check":"x","checkTimeoutMs":1234}', script: [PASS] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    expect(h.check.calls[0]).toEqual({ command: "x", timeoutMs: 1234 })
  })
})

describe("failing check", () => {
  test("blocks with the check output as evidence", async () => {
    const h = makeHarness({ script: [FAIL] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toEqual({
      kind: "block",
      evidence: FAIL.output.trim(),
      round: 1,
      roundsMax: 2,
    })
  })

  test("writes no sensor line mid-cycle — a line means a finished cycle", async () => {
    const h = makeHarness({ script: [FAIL] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    expect(h.sensor.lines).toHaveLength(0)
  })

  test("opens a cycle that survives without a further edit", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    const s = h.store.peek(SESSION)!
    expect(s.gating).toBe(true)
    expect(s.round).toBe(1)
    expect(s.outcomes).toEqual(["failed"])
  })

  // rounds:2 means two blocks, then the third failure gives up.
  test("blocks twice then allows through, exhausted", async () => {
    const h = makeHarness({ fallback: FAIL, clock: new FakeClock(1_000, 100) })
    const gate = createGate(h.host)
    await gate.handle(edit)

    expect(await gate.handle(stop)).toMatchObject({ kind: "block", round: 1, roundsMax: 2 })
    expect(await gate.handle(stop)).toMatchObject({ kind: "block", round: 2, roundsMax: 2 })

    const third = await gate.handle(stop)
    expect(third.kind).toBe("allow")
    expect((third as { notice?: string }).notice).toBeString()
    expect(h.check.calls).toHaveLength(3)

    expect(h.sensor.lines).toHaveLength(1)
    expect(h.sensor.lines[0]).toMatchObject({
      accepted: true,
      gateExhausted: true,
      interrupted: false,
      rounds: ["failed", "failed", "failed"],
    })
  })

  test("recovers mid-cycle when a later round passes", async () => {
    const h = makeHarness({ script: [FAIL, PASS] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
    expect(h.sensor.lines[0]).toMatchObject({
      accepted: true,
      gateExhausted: false,
      rounds: ["failed", "passed"],
    })
  })

  test("stands the session fully down after exhaustion", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    await gate.handle(stop)
    await gate.handle(stop)
    await gate.handle(stop)
    expect(h.check.calls).toHaveLength(3)
  })

  test("rounds:0 is observe-only — records the failure and allows immediately", async () => {
    const h = makeHarness({ raw: '{"check":"x","rounds":0}', script: [FAIL] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    const d = await gate.handle(stop)
    expect(d.kind).toBe("allow")
    expect(h.sensor.lines[0]).toMatchObject({ gateExhausted: true, rounds: ["failed"] })
  })

  test("measures duration across the whole cycle, not the last round", async () => {
    const clock = new FakeClock(1_000, 0)
    const h = makeHarness({ raw: '{"check":"x","rounds":1}', fallback: FAIL, clock })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop) // cycle starts at 1000
    clock.set(9_000)
    await gate.handle(stop) // exhausted at 9000
    expect(h.sensor.lines[0]?.durationMs).toBe(8_000)
  })
})

describe("config is the escape hatch", () => {
  test("is re-read on every event, never cached", async () => {
    const h = makeHarness({ fallback: PASS })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(prompt)
    await gate.handle(stop)
    expect(h.config.reads).toBe(3)
  })

  test("a check command changed between turns takes effect on the next stop", async () => {
    const h = makeHarness({ fallback: PASS })
    const gate = createGate(h.host)
    await gate.handle(edit)
    h.config.raw = '{"check":"the-new-command"}'
    await gate.handle(stop)
    expect(h.check.calls[0]?.command).toBe("the-new-command")
  })

  test("deleting gate.json mid-cycle releases the session with no restart", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toMatchObject({ kind: "block" })

    h.config.raw = undefined
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
    expect(h.check.calls).toHaveLength(1) // the check never ran again
  })

  test("an abandoned cycle keeps `edited`, so restoring the config re-gates", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)

    h.config.raw = undefined
    await gate.handle(stop)
    expect(h.store.peek(SESSION)?.edited).toBe(true)
    expect(h.store.peek(SESSION)?.gating).toBe(false)

    h.config.raw = '{"check":"bun test"}'
    expect(await gate.handle(stop)).toMatchObject({ kind: "block", round: 1 })
  })

  test("a corrupt gate.json no-ops rather than wedging the session", async () => {
    const h = makeHarness({ raw: "{not json", fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
  })
})

describe("a new user prompt preempts the gate", () => {
  test("stands the session down and records an interrupted line", async () => {
    const h = makeHarness({ fallback: FAIL, clock: new FakeClock(1_000, 250) })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)

    expect(await gate.handle(prompt)).toEqual({ kind: "allow" })
    expect(h.sensor.lines).toHaveLength(1)
    expect(h.sensor.lines[0]).toMatchObject({
      accepted: true,
      gateExhausted: true,
      interrupted: true,
      rounds: ["failed"],
    })

    // Fully stood down: edited is cleared too, so the next stop is free.
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
    expect(h.check.calls).toHaveLength(1)
  })

  test("an ordinary prompt with no open cycle leaves `edited` intact", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(prompt)
    expect(h.store.peek(SESSION)?.edited).toBe(true)
    expect(h.sensor.lines).toHaveLength(0)
    expect(await gate.handle(stop)).toMatchObject({ kind: "block" })
  })

  test("a prompt in a session that never edited anything records nothing", async () => {
    const h = makeHarness()
    const gate = createGate(h.host)
    expect(await gate.handle(prompt)).toEqual({ kind: "allow" })
    expect(h.sensor.lines).toHaveLength(0)
  })
})

describe("internal errors disarm rather than wedge", () => {
  test("a crashing check allows the stop and consumes no round", async () => {
    const h = makeHarness({ fallback: new Error("spawn ENOENT") })
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })

    const s = h.store.peek(SESSION)!
    expect(s.errorStreak).toBe(1)
    expect(s.round).toBe(0)
    expect(s.gating).toBe(false)
    expect(s.outcomes).toEqual([])
    expect(h.sensor.lines).toHaveLength(0)
  })

  test("three consecutive crashes disarm the session for good", async () => {
    const h = makeHarness({ fallback: new Error("spawn ENOENT") })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    await gate.handle(stop)

    const third = await gate.handle(stop)
    expect(third.kind).toBe("allow")
    expect((third as { notice?: string }).notice).toContain("disarmed")
    expect(h.store.peek(SESSION)?.disarmed).toBe(true)
  })

  test("a disarmed session stays disarmed even after further edits", async () => {
    const h = makeHarness({ fallback: new Error("boom") })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    await gate.handle(stop)
    await gate.handle(stop)
    expect(h.check.calls).toHaveLength(3)

    await gate.handle(edit)
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
    expect(await gate.handle(prompt)).toEqual({ kind: "allow" })
    expect(h.check.calls).toHaveLength(3) // never ran again
  })

  test("a passing round clears the streak", async () => {
    const h = makeHarness({ script: [new Error("boom"), PASS] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    await gate.handle(stop)
    expect(h.store.peek(SESSION)?.disarmed).toBe(false)
    expect(h.store.peek(SESSION)?.errorStreak).toBe(0)
  })

  test("a failing round clears the streak — a real verdict is not an error", async () => {
    const h = makeHarness({ script: [new Error("boom"), FAIL] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    await gate.handle(stop)
    expect(h.store.peek(SESSION)?.errorStreak).toBe(0)
  })

  test("logs the crash so the failure is diagnosable", async () => {
    const h = makeHarness({ fallback: new Error("spawn ENOENT") })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    expect(h.logger.messages.join("\n")).toContain("spawn ENOENT")
  })
})

describe("fail-open: no port failure may wedge a session", () => {
  test("a throwing config source allows", async () => {
    const h = makeHarness({ fallback: FAIL })
    h.host.config = {
      read: () => {
        throw new Error("EACCES")
      },
    }
    const gate = createGate(h.host)
    expect(await gate.handle(edit)).toEqual({ kind: "allow" })
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
  })

  test("a throwing state load allows", async () => {
    const h = makeHarness({ fallback: FAIL })
    h.host.state = {
      load: () => {
        throw new Error("EIO")
      },
      save: () => {},
    }
    const gate = createGate(h.host)
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
  })

  // The decision is already computed by the time state is persisted; a failed
  // write must not retroactively change it.
  test("a throwing state save does not change the decision", async () => {
    const h = makeHarness({ fallback: FAIL })
    const realSave = h.store.save.bind(h.store)
    h.host.state = {
      load: (id) => h.store.load(id),
      save: (id, s) => {
        realSave(id, s)
        throw new Error("ENOSPC")
      },
    }
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toMatchObject({ kind: "block", round: 1 })
  })

  test("a throwing sensor sink does not change the decision", async () => {
    const h = makeHarness({ script: [PASS] })
    h.host.sensor = {
      append: () => {
        throw new Error("ENOSPC")
      },
    }
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
  })

  test("a throwing clock allows", async () => {
    const h = makeHarness({ fallback: FAIL })
    h.host.clock = {
      now: () => {
        throw new Error("no clock")
      },
    }
    const gate = createGate(h.host)
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
  })

  test("a throwing logger allows", async () => {
    const h = makeHarness({ fallback: new Error("boom") })
    h.host.logger = {
      log: () => {
        throw new Error("no logger")
      },
    }
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
  })

  test("a check runner that rejects with a non-Error still allows", async () => {
    const h = makeHarness()
    h.host.check = { run: () => Promise.reject("just a string") }
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
  })

  // A runner that answers with nonsense is broken, not reporting a verdict, so
  // it counts toward the disarm streak rather than being scored as a round.
  test("a check runner returning a malformed result allows and counts as an internal error", async () => {
    const h = makeHarness()
    h.host.check = { run: async () => ({}) as unknown as { code: number; output: string } }
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
    expect(h.store.peek(SESSION)?.errorStreak).toBe(1)
    expect(h.store.peek(SESSION)?.outcomes).toEqual([])
  })

  test("a failing check with empty output still yields non-empty evidence", async () => {
    const h = makeHarness({ script: [{ code: 1, output: "" }] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    const d = await gate.handle(stop)
    expect(d.kind).toBe("block")
    expect((d as { evidence: string }).evidence.length).toBeGreaterThan(0)
  })
})
