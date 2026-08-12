import { describe, expect, test } from "bun:test"
import { CHECK_CLAMP_MARGIN_MS, createGate } from "../src/kernel/gate.ts"
import { INITIAL_STATE } from "../src/kernel/state.ts"
import { FAIL, FakeClock, makeHarness, PASS } from "./fakes.ts"

const SESSION = "sess-1"
const edit = { kind: "file-edited", sessionID: SESSION } as const
const stop = { kind: "stop-requested", sessionID: SESSION } as const
const prompt = { kind: "new-user-prompt", sessionID: SESSION } as const

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
    await gate.handle({ kind: "file-edited", sessionID: "a" })
    expect(await gate.handle({ kind: "stop-requested", sessionID: "b" })).toEqual({ kind: "allow" })
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
      sessionID: SESSION,
      check: "bun test",
      accepted: true,
      gateExhausted: false,
      interrupted: false,
      rounds: ["accepted"],
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

  test("writes the line to the configured sensor path", async () => {
    const h = makeHarness({ raw: '{"check":"x","sensor":"logs/gate.ndjson"}', script: [PASS] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    expect(h.sensor.paths).toEqual(["logs/gate.ndjson"])
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
    expect(s.outcomes).toEqual(["verify-failed"])
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
      rounds: ["verify-failed", "verify-failed", "verify-failed"],
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
      rounds: ["verify-failed", "accepted"],
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
    expect(h.sensor.lines[0]).toMatchObject({ gateExhausted: true, rounds: ["verify-failed"] })
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

// gate.json's `marker` toggle: real reference semantics (meta-harness
// cc-gate-plugin src/core/stop.ts, README), NOT the "session-carryover"
// this repo's own docs previously (incorrectly) described. Off by default;
// when on, a clean accept both stamps the sensor line and returns a
// hygiene countermand for the agent's own context — but exhaustion and
// interrupted/skipped lines must never carry it, even with the toggle on.
describe("hygiene marker", () => {
  test("off by default: a clean accept carries no marker", async () => {
    const h = makeHarness({ script: [PASS] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
    expect(h.sensor.lines[0]?.marker).toBe(false)
  })

  test("on: a clean accept returns a marker and stamps the sensor line", async () => {
    const h = makeHarness({ raw: '{"check":"x","marker":true}', script: [PASS] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    const decision = await gate.handle(stop)
    expect(decision.kind).toBe("allow")
    expect((decision as { marker?: string }).marker).toBeString()
    expect((decision as { marker?: string }).marker!.length).toBeGreaterThan(0)
    expect(h.sensor.lines[0]?.marker).toBe(true)
  })

  test("never fires on exhaustion, even with the toggle on", async () => {
    const h = makeHarness({ raw: '{"check":"x","marker":true}', fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    await gate.handle(stop)
    const third = await gate.handle(stop)
    expect(third.kind).toBe("allow")
    expect((third as { marker?: string }).marker).toBeUndefined()
    expect(h.sensor.lines[0]?.marker).toBe(false)
  })

  test("never fires on an interrupted cycle, even with the toggle on", async () => {
    const h = makeHarness({ raw: '{"check":"x","marker":true}', fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop) // opens a cycle
    const decision = await gate.handle(prompt) // preempts it
    expect(decision).toEqual({ kind: "allow" })
    expect(h.sensor.lines[0]?.marker).toBe(false)
  })

  test("never fires on a skipped-stop diagnostic line, even with the toggle on", async () => {
    const h = makeHarness({ raw: '{"check":"x","marker":true}', fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    const decision = await gate.handle(prompt) // never reached a stop
    expect(decision).toEqual({ kind: "allow" })
    expect(h.sensor.lines[0]?.marker).toBe(false)
  })

  test("a block decision never carries a marker", async () => {
    const h = makeHarness({ raw: '{"check":"x","marker":true}', script: [FAIL] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    const decision = await gate.handle(stop)
    expect(decision.kind).toBe("block")
    expect(decision).not.toHaveProperty("marker")
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
      rounds: ["verify-failed"],
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
    expect(h.sensor.lines).toHaveLength(1)
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

  // A block that cannot be persisted would never advance `round` on disk, so
  // every later stop would recompute the same block decision forever. The
  // gate downgrades to allow instead of issuing a block it cannot bound.
  test("a throwing state save downgrades a block rather than issuing one it cannot bound", async () => {
    const h = makeHarness({ fallback: FAIL })
    const realSave = h.store.save.bind(h.store)
    h.host.state = {
      load: (id) => h.store.load(id),
      save: (id, s, expected) => {
        realSave(id, s, expected)
        throw new Error("ENOSPC")
      },
    }
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toMatchObject({ kind: "allow" })
  })

  // docs/known-issues.md #8: a check can run for minutes, and nothing held
  // the state file locked while it did. `onRun` fires mid-`host.check.run`,
  // exactly where a second writer — another process, or opencode's second
  // concurrent callback — would land a real write between this handler's own
  // `load()` and its later `persist()`. The stale writer must lose the race,
  // and losing it must still fail open rather than wedge the turn.
  test("a concurrent writer during a slow check wins the race, and the stale write still fails open", async () => {
    const h = makeHarness({ raw: '{"check":"bun test","rounds":2}', script: [FAIL] })
    const gate = createGate(h.host)
    await gate.handle(edit)

    h.check.onRun = () => {
      const loaded = h.store.load(SESSION)
      h.store.save(SESSION, { ...loaded, disarmed: true }, loaded.updatedAt)
    }

    const decision = await gate.handle(stop)
    expect(decision.kind).toBe("allow")
    // The concurrent writer's state survived; this handler's own,
    // now-stale block was refused rather than clobbering it.
    expect(h.store.peek(SESSION)?.disarmed).toBe(true)
    expect(h.store.peek(SESSION)?.gating).toBe(false)
  })

  // docs/known-issues.md #8, in reverse. Same race as the test above, other
  // direction: a concurrent stop-requested handler is the FAST one this
  // time, landing its own block before onNewUserPrompt's reset — reachable
  // in one process via opencode's chat.message and session.idle sharing one
  // gate instance. Human preemption is unconditional intent, so a lost
  // compare-and-swap here must retry against the fresh state rather than
  // silently leave that block's round count behind for an unrelated later
  // cycle to inherit (the "round already at budget, first failure exhausts
  // with zero blocks issued" symptom the doc describes).
  test("a concurrent writer that lands a block first still loses to the human's reset, once retried", async () => {
    const h = makeHarness({ raw: '{"check":"bun test","rounds":2}' })
    const gate = createGate(h.host)

    // A cycle already has one block issued: gating:true, round:1.
    h.store.save(SESSION, { ...INITIAL_STATE, gating: true, round: 1, outcomes: ["verify-failed"], cycleStartedAt: 500 }, 0)

    // Both a stop-requested and this new-user-prompt load that same state.
    // The stop-requested handler is the fast one and lands its own block —
    // round:2 — before this handler's own load-based reset attempt runs.
    let raced = false
    const realLoad = h.store.load.bind(h.store)
    h.host.state = {
      load: (id) => {
        const snapshot = realLoad(id)
        if (!raced) {
          raced = true
          h.store.save(id, { ...snapshot, round: 2, outcomes: [...snapshot.outcomes, "verify-failed"] }, snapshot.updatedAt)
        }
        return snapshot
      },
      save: (id, s, expected) => h.store.save(id, s, expected),
    }

    expect(await gate.handle(prompt)).toEqual({ kind: "allow" })

    // The sensor line reflects what this handler saw (the pre-race cycle).
    expect(h.sensor.lines).toHaveLength(1)
    expect(h.sensor.lines[0]).toMatchObject({ interrupted: true, gateExhausted: true, rounds: ["verify-failed"] })

    // Human preemption still wins: the retry against the fresh state landed
    // the reset, so a later unrelated cycle does not inherit round:2 and
    // exhaust on its first failure with zero blocks of its own issued.
    expect(h.store.peek(SESSION)).toMatchObject({ gating: false, round: 0 })
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

  // Must arm first: an unedited session returns before the clock is ever read,
  // so without the edit this test passes whether or not the clock is guarded.
  test("a clock that throws while starting a cycle allows", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    h.host.clock = {
      now: () => {
        throw new Error("no clock")
      },
    }
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
  })

  // Every stop that reaches the runner now reads the clock at least once, to
  // time the check itself. Which read throws does not matter to this test —
  // only that a clock failure on the exhausting stop still fails open.
  test("a clock that throws while ending a cycle allows", async () => {
    const h = makeHarness({ raw: '{"check":"x","rounds":1}', fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toMatchObject({ kind: "block", round: 1 })
    h.host.clock = {
      now: () => {
        throw new Error("no clock")
      },
    }
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

describe("a block that cannot be recorded is not a block", () => {
  /** Arms the session durably, then makes every subsequent save fail. */
  function armedThenReadOnly() {
    const h = makeHarness({ fallback: FAIL })
    h.store.save(SESSION, { ...INITIAL_STATE, edited: true }, 0)
    h.host.state = {
      load: (id) => h.store.load(id),
      save: () => {
        throw new Error("ENOSPC")
      },
    }
    return h
  }

  test("downgrades to allow when the round cannot be persisted", async () => {
    const h = armedThenReadOnly()
    const gate = createGate(h.host)
    const decision = await gate.handle(stop)
    expect(decision.kind).toBe("allow")
    expect((decision as { notice?: string }).notice).toBeString()
  })

  // The actual wedge: the round never advances on disk, so a naive
  // implementation recomputes the same block decision forever.
  test("cannot wedge a session, however many times the agent retries", async () => {
    const h = armedThenReadOnly()
    const gate = createGate(h.host)
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await gate.handle(stop)).kind).toBe("allow")
    }
  })

  test("still blocks normally once the round can be persisted", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toMatchObject({ kind: "block", round: 1 })
  })

  test("says why it let the turn through", async () => {
    const h = armedThenReadOnly()
    const gate = createGate(h.host)
    const decision = await gate.handle(stop)
    expect((decision as { notice: string }).notice.toLowerCase()).toContain("could not")
  })

  test("logs the persist failure", async () => {
    const h = armedThenReadOnly()
    const gate = createGate(h.host)
    await gate.handle(stop)
    expect(h.logger.messages.join("\n")).toContain("ENOSPC")
  })
})

// A queued user message can consume the turn boundary, so the harness never
// delivers a stop and the edits go unmeasured. Silence there is the blind spot.
describe("a skipped stop boundary is visible", () => {
  test("records a diagnostic line when a prompt arrives on an armed session", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(prompt)).toEqual({ kind: "allow" })

    expect(h.sensor.lines).toHaveLength(1)
    expect(h.sensor.lines[0]).toMatchObject({
      sessionID: SESSION,
      check: "bun test",
      skippedStop: true,
      rounds: [],
      checkMs: [],
      gateExhausted: false,
    })
    expect(h.check.calls).toHaveLength(0) // no check ran: there was no stop
  })

  test("leaves the session armed, so the next real stop still measures", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(prompt)

    expect(h.store.peek(SESSION)?.edited).toBe(true)
    expect(await gate.handle(stop)).toMatchObject({ kind: "block", round: 1 })
  })

  test("every skipped boundary is recorded, not just the first", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(prompt)
    await gate.handle(prompt)
    expect(h.sensor.lines).toHaveLength(2)
    expect(h.sensor.lines.every((l) => l.skippedStop === true)).toBe(true)
  })

  test("an interrupted open cycle is still reported as interrupted, not skipped", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    await gate.handle(prompt)
    expect(h.sensor.lines).toHaveLength(1)
    expect(h.sensor.lines[0]?.interrupted).toBe(true)
    expect(h.sensor.lines[0]?.skippedStop).toBeUndefined()
    expect(h.sensor.lines[0]?.rounds).toEqual(["verify-failed"])
  })

  test("no config means no sensor path, so nothing is recorded", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    h.config.raw = undefined
    expect(await gate.handle(prompt)).toEqual({ kind: "allow" })
    expect(h.sensor.lines).toHaveLength(0)
  })
})

// A4: Claude Code SIGKILLs the Stop hook at its manifest timeout, before the
// gate can record anything — no state, no round, no notice. A checkTimeoutMs
// at or above that ceiling therefore silently never gets its configured time.
// When the host supplies its ceiling, the kernel clamps what it passes to the
// runner and says so; a host with no killable ceiling (opencode) supplies
// nothing and is never clamped.
describe("checkTimeoutMs clamped under the stop-hook ceiling", () => {
  const CEILING = 600_000
  const withCeiling = { app: "test-app", host: "test-host", stopTimeoutMs: CEILING }

  test("a timeout leaving no margin is clamped to ceiling minus margin", async () => {
    const h = makeHarness({
      raw: '{"check":"x","checkTimeoutMs":600000}',
      script: [PASS],
      info: withCeiling,
    })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    expect(h.check.calls[0]?.timeoutMs).toBe(CEILING - CHECK_CLAMP_MARGIN_MS)
  })

  test("notes the exact numbers and how to fix the config", async () => {
    const h = makeHarness({
      raw: '{"check":"x","checkTimeoutMs":600000}',
      script: [PASS],
      info: withCeiling,
    })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    const log = h.logger.messages.join("\n")
    expect(log).toContain("600000")
    expect(log).toContain(String(CEILING - CHECK_CLAMP_MARGIN_MS))
    expect(log).toContain("gate.json")
  })

  test("a timeout at the boundary passes through untouched, silently", async () => {
    const h = makeHarness({
      raw: `{"check":"x","checkTimeoutMs":${CEILING - CHECK_CLAMP_MARGIN_MS}}`,
      script: [PASS],
      info: withCeiling,
    })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    expect(h.check.calls[0]?.timeoutMs).toBe(CEILING - CHECK_CLAMP_MARGIN_MS)
    expect(h.logger.messages).toEqual([])
  })

  test("a comfortable timeout passes through untouched", async () => {
    const h = makeHarness({
      raw: '{"check":"x","checkTimeoutMs":1234}',
      script: [PASS],
      info: withCeiling,
    })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    expect(h.check.calls[0]?.timeoutMs).toBe(1234)
  })

  test("a host with no ceiling never clamps, however large the timeout", async () => {
    const h = makeHarness({
      raw: '{"check":"x","checkTimeoutMs":900000}',
      script: [PASS],
    })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    expect(h.check.calls[0]?.timeoutMs).toBe(900_000)
    expect(h.logger.messages).toEqual([])
  })

  test("a ceiling smaller than the margin still passes a positive timeout", async () => {
    const h = makeHarness({
      raw: '{"check":"x","checkTimeoutMs":500}',
      script: [PASS],
      info: { app: "test-app", host: "test-host", stopTimeoutMs: 1_000 },
    })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    expect(h.check.calls[0]?.timeoutMs).toBeGreaterThan(0)
  })
})

// A2: every sensor line carries the budget it was measured against, so an
// exhaustion-rate change can be attributed to agent behaviour vs a config
// edit. rounds:3 everywhere below — a non-default value, so a default
// leaking in from anywhere else cannot make these pass vacuously.
describe("roundsMax on the sensor line", () => {
  const RAW = '{"check":"bun test","rounds":3}'

  test("a clean accept records the configured budget", async () => {
    const h = makeHarness({ raw: RAW, script: [PASS] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    expect(h.sensor.lines[0]).toMatchObject({ rounds: ["accepted"], roundsMax: 3 })
  })

  test("an exhausted cycle records the configured budget", async () => {
    const h = makeHarness({ raw: RAW, fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    for (let i = 0; i < 4; i++) await gate.handle(stop)
    expect(h.sensor.lines).toHaveLength(1)
    expect(h.sensor.lines[0]).toMatchObject({ gateExhausted: true, roundsMax: 3 })
  })

  test("an interrupted cycle records the configured budget", async () => {
    const h = makeHarness({ raw: RAW, fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    await gate.handle(prompt)
    expect(h.sensor.lines[0]).toMatchObject({ interrupted: true, roundsMax: 3 })
  })

  test("a skipped-stop diagnostic records the configured budget", async () => {
    const h = makeHarness({ raw: RAW, fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(prompt)
    expect(h.sensor.lines[0]).toMatchObject({ skippedStop: true, roundsMax: 3 })
  })

  test("rounds:0 stamps a zero budget rather than dropping the field", async () => {
    const h = makeHarness({ raw: '{"check":"x","rounds":0}', script: [FAIL] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    expect(h.sensor.lines[0]?.roundsMax).toBe(0)
  })
})

// Cycle durationMs includes agent and human wait time: an observed 420s cycle
// ran a ~1s check. Check cost has to be measurable on its own.
describe("per-round check timing", () => {
  test("times the check runner, not the whole cycle", async () => {
    const clock = new FakeClock(1_000, 0)
    const h = makeHarness({ raw: '{"check":"x","rounds":1}', fallback: FAIL, clock })
    const gate = createGate(h.host)
    await gate.handle(edit)

    // Round 1: the check itself takes 300ms.
    h.check.onRun = () => clock.set(clock.peek() + 300)
    await gate.handle(stop)

    // …then the agent and the human take 100s before the next stop.
    clock.set(101_300)
    h.check.onRun = () => clock.set(clock.peek() + 400)
    await gate.handle(stop)

    const line = h.sensor.lines[0]!
    expect(line.checkMs).toEqual([300, 400])
    expect(line.durationMs).toBeGreaterThan(100_000) // cycle time still recorded
  })

  test("one entry per round, parallel to rounds, on a passing cycle", async () => {
    const h = makeHarness({ script: [FAIL, PASS] })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    await gate.handle(stop)

    const line = h.sensor.lines[0]!
    expect(line.rounds).toEqual(["verify-failed", "accepted"])
    expect(line.checkMs).toHaveLength(2)
    expect(line.checkMs?.every((ms) => typeof ms === "number" && ms >= 0)).toBe(true)
  })

  test("accumulates across the rounds of an exhausted cycle", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    await gate.handle(stop)
    await gate.handle(stop)
    expect(h.sensor.lines[0]?.checkMs).toHaveLength(3)
  })

  test("an interrupted cycle reports the rounds it did time", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    await gate.handle(prompt)
    expect(h.sensor.lines[0]?.checkMs).toHaveLength(1)
  })

  test("a check that could not run consumes no round and times nothing", async () => {
    const h = makeHarness({ fallback: new Error("spawn ENOENT") })
    const gate = createGate(h.host)
    await gate.handle(edit)
    await gate.handle(stop)
    expect(h.store.peek(SESSION)?.checkMs).toEqual([])
  })
})
