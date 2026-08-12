import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SpawnCheckRunner } from "../src/runtime/check-runner.ts"
import { FileConfigSource } from "../src/runtime/config-source.ts"
import { FileStateStore, recordName } from "../src/runtime/file-state-store.ts"
import { NdjsonSensorSink } from "../src/runtime/ndjson-sink.ts"
import { createNodeHost } from "../src/runtime/index.ts"
import { INITIAL_STATE } from "../src/kernel/state.ts"
import type { GateState, SensorLine } from "../src/kernel/ports.ts"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkamak-test-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("SpawnCheckRunner", () => {
  const runner = new SpawnCheckRunner(process.cwd())

  test("reports exit code 0 and captures stdout", async () => {
    const r = await runner.run("echo hello", 10_000)
    expect(r.code).toBe(0)
    expect(r.output).toContain("hello")
  })

  test("reports a nonzero exit code", async () => {
    const r = await runner.run("exit 3", 10_000)
    expect(r.code).toBe(3)
  })

  // Test runners write failures to stderr, so dropping it would throw away the
  // evidence the gate exists to deliver.
  test("captures stderr alongside stdout", async () => {
    const r = await runner.run("echo out; echo err 1>&2", 10_000)
    expect(r.output).toContain("out")
    expect(r.output).toContain("err")
  })

  test("reports a missing command as a nonzero exit, not a rejection", async () => {
    const r = await runner.run("definitely-not-a-real-command-xyz", 10_000)
    expect(r.code).not.toBe(0)
  })

  test("runs the command in the given working directory", async () => {
    const r = await new SpawnCheckRunner(dir).run("pwd", 10_000)
    expect(fs.realpathSync(r.output.trim())).toBe(fs.realpathSync(dir))
  })

  test("kills a command that outruns the timeout and reports failure", async () => {
    const started = Date.now()
    const r = await runner.run("sleep 30", 300)
    expect(r.code).not.toBe(0)
    expect(r.output.toLowerCase()).toContain("timed out")
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test("keeps partial output from a timed-out command", async () => {
    const r = await runner.run("echo partial; sleep 30", 500)
    expect(r.output).toContain("partial")
  })
})

describe("FileConfigSource", () => {
  test("returns undefined when gate.json is absent", () => {
    expect(new FileConfigSource(dir).read()).toBeUndefined()
  })

  test("reads gate.json from the root it was given", () => {
    fs.writeFileSync(path.join(dir, "gate.json"), '{"check":"bun test"}')
    expect(new FileConfigSource(dir).read()).toBe('{"check":"bun test"}')
  })

  // Known issue 4 (docs/known-issues.md): the README told readers to put
  // gate.json "at the repo root". The gate reads it from whatever root it
  // was constructed with — for Claude Code, the hook payload's cwd — and
  // never resolves upward. Launching from a subdirectory therefore finds no
  // config and silently no-ops. This pins that, so the corrected README
  // claim is enforced rather than merely re-worded.
  test("does not walk upward: a gate.json in the parent is invisible from a subdirectory root", () => {
    fs.writeFileSync(path.join(dir, "gate.json"), '{"check":"echo parent"}')
    const sub = path.join(dir, "packages", "web")
    fs.mkdirSync(sub, { recursive: true })
    expect(new FileConfigSource(sub).read()).toBeUndefined()
  })

  // The escape hatch depends on this: no caching, ever.
  test("hits the filesystem on every read", () => {
    const file = path.join(dir, "gate.json")
    const source = new FileConfigSource(dir)

    fs.writeFileSync(file, '{"check":"first"}')
    expect(source.read()).toContain("first")

    fs.writeFileSync(file, '{"check":"second"}')
    expect(source.read()).toContain("second")

    fs.rmSync(file)
    expect(source.read()).toBeUndefined()
  })

  test("returns undefined rather than throwing when the path is a directory", () => {
    fs.mkdirSync(path.join(dir, "gate.json"))
    expect(new FileConfigSource(dir).read()).toBeUndefined()
  })
})

describe("FileStateStore", () => {
  const store = () => new FileStateStore(path.join(dir, ".km", "gate"))

  test("reads initial state for an unknown session", () => {
    expect(store().load("nope")).toEqual(INITIAL_STATE)
  })

  test("round-trips a saved state", () => {
    const s = store()
    const saved: GateState = { ...INITIAL_STATE, edited: true, gating: true, round: 2, outcomes: ["verify-failed", "verify-failed"] }
    s.save("sess-1", saved, 0)
    expect(s.load("sess-1")).toMatchObject({
      edited: true,
      gating: true,
      round: 2,
      outcomes: ["verify-failed", "verify-failed"],
    })
  })

  test("stamps updatedAt on save", () => {
    const s = store()
    s.save("sess-1", { ...INITIAL_STATE, edited: true }, 0)
    expect(s.load("sess-1").updatedAt).toBeGreaterThan(0)
  })

  test("keeps sessions apart", () => {
    const s = store()
    s.save("a", { ...INITIAL_STATE, edited: true }, 0)
    expect(s.load("b")).toEqual(INITIAL_STATE)
  })

  // A broken record must never break a hook.
  test.each([
    ["corrupt JSON", "{not json"],
    ["a wrong-shaped record", '{"v":1,"edited":"yes"}'],
    ["a future version", '{"v":99,"edited":true}'],
    ["an empty file", ""],
  ])("reads initial state when the record is %s", (_label, contents) => {
    const s = store()
    s.save("sess-1", { ...INITIAL_STATE, edited: true }, 0)
    const file = fs.readdirSync(path.join(dir, ".km", "gate")).find((f) => f.endsWith(".json"))!
    fs.writeFileSync(path.join(dir, ".km", "gate", file), contents)
    expect(s.load("sess-1")).toEqual(INITIAL_STATE)
  })

  // Absent means initial, so saving initial state should not litter the dir.
  test("deletes the record when state returns to initial", () => {
    const s = store()
    s.save("sess-1", { ...INITIAL_STATE, edited: true }, 0)
    expect(fs.readdirSync(path.join(dir, ".km", "gate"))).not.toBeEmpty()
    const armed = s.load("sess-1")
    s.save("sess-1", { ...INITIAL_STATE }, armed.updatedAt)
    expect(fs.readdirSync(path.join(dir, ".km", "gate")).filter((f) => f.endsWith(".json"))).toBeEmpty()
  })

  test("persists a disarmed session, which is not initial-equivalent", () => {
    const s = store()
    s.save("sess-1", { ...INITIAL_STATE, disarmed: true, errorStreak: 3 }, 0)
    expect(s.load("sess-1").disarmed).toBe(true)
  })

  test("leaves no temp files behind after a save", () => {
    const s = store()
    s.save("sess-1", { ...INITIAL_STATE, edited: true }, 0)
    expect(fs.readdirSync(path.join(dir, ".km", "gate")).filter((f) => f.endsWith(".tmp"))).toBeEmpty()
  })

  // A harness-supplied session id is untrusted input.
  test("cannot be talked into escaping its directory", () => {
    const s = store()
    s.save("../../escaped", { ...INITIAL_STATE, edited: true }, 0)
    expect(fs.existsSync(path.join(dir, "escaped.json"))).toBe(false)
    expect(s.load("../../escaped").edited).toBe(true)
    const entries = fs.readdirSync(path.join(dir, ".km", "gate"))
    expect(entries).toHaveLength(1)
    expect(entries[0]).not.toContain("/")
  })

  test("does not confuse two ids that sanitise alike", () => {
    const s = store()
    s.save("a/b", { ...INITIAL_STATE, edited: true, round: 1 }, 0)
    s.save("a:b", { ...INITIAL_STATE, edited: true, round: 2 }, 0)
    expect(s.load("a/b").round).toBe(1)
    expect(s.load("a:b").round).toBe(2)
  })

  test("round times survive a save/load round trip", () => {
    const store = new FileStateStore(dir)
    store.save("s", { ...INITIAL_STATE, edited: true, gating: true, round: 1, outcomes: ["verify-failed"], checkMs: [1_234] }, 0)
    expect(store.load("s").checkMs).toEqual([1_234])
  })

  describe("optimistic concurrency (docs/known-issues.md #8)", () => {
    test("refuses a stale write and the newer write survives — the race this fixes", () => {
      const s = store()
      s.save("sess-1", { ...INITIAL_STATE, edited: true }, 0)
      // "Writer A" loads here and is about to sit on a long check.
      const loadedByA = s.load("sess-1")

      // "Writer B" — a second process, or opencode's second concurrent
      // callback — loads the same record and, unlike A, saves quickly.
      const loadedByB = s.load("sess-1")
      s.save(
        "sess-1",
        { ...loadedByB, gating: true, round: 1, outcomes: ["verify-failed"] },
        loadedByB.updatedAt,
      )
      const afterB = s.load("sess-1")

      // A's check finally finishes. Its save is computed from `loadedByA`,
      // now stale — it must be refused, not silently clobber B's write.
      expect(() => s.save("sess-1", { ...loadedByA, disarmed: true }, loadedByA.updatedAt)).toThrow()

      // B's state is exactly what's still on disk.
      expect(s.load("sess-1")).toEqual(afterB)
      expect(s.load("sess-1").disarmed).toBe(false)
    })

    test("a save whose expected version matches the current record succeeds", () => {
      const s = store()
      s.save("sess-1", { ...INITIAL_STATE, edited: true }, 0)
      const loaded = s.load("sess-1")
      s.save("sess-1", { ...loaded, gating: true, round: 1 }, loaded.updatedAt)
      expect(s.load("sess-1")).toMatchObject({ gating: true, round: 1 })
    })

    // Awkward case 1: the record is absent entirely. `0` is the sentinel for
    // "nothing was here at load time" — two writers racing to create the
    // same session's first record must not both succeed.
    test("refuses to arm a session a concurrent writer already created", () => {
      const s = store()
      s.save("sess-1", { ...INITIAL_STATE, edited: true }, 0)
      expect(() => s.save("sess-1", { ...INITIAL_STATE, edited: true, round: 9 }, 0)).toThrow()
      expect(s.load("sess-1").round).toBe(0)
    })

    // Awkward case 2: the state being saved is itself initial-equivalent, so
    // save() deletes rather than writes. A stale reset must not delete a
    // concurrent writer's real progress out from under it.
    test("refuses to delete when a newer, non-initial record landed first", () => {
      const s = store()
      s.save("sess-1", { ...INITIAL_STATE, edited: true, gating: true, round: 1, outcomes: ["verify-failed"] }, 0)
      const loaded = s.load("sess-1")

      // A concurrent writer advances the cycle further.
      s.save("sess-1", { ...loaded, round: 2, outcomes: ["verify-failed", "verify-failed"] }, loaded.updatedAt)

      // A stale accept-branch reset, computed from the pre-advance read,
      // must not wipe it.
      expect(() => s.save("sess-1", { ...INITIAL_STATE }, loaded.updatedAt)).toThrow()
      expect(s.load("sess-1")).toMatchObject({ round: 2, outcomes: ["verify-failed", "verify-failed"] })
      expect(fs.readdirSync(path.join(dir, ".km", "gate")).filter((f) => f.endsWith(".json"))).not.toBeEmpty()
    })

    test("two consecutive saves in the same store never stamp an identical updatedAt", () => {
      const s = store()
      s.save("sess-1", { ...INITIAL_STATE, edited: true }, 0)
      const v1 = s.load("sess-1").updatedAt
      s.save("sess-1", { ...INITIAL_STATE, edited: true, round: 1 }, v1)
      const v2 = s.load("sess-1").updatedAt
      expect(v2).toBeGreaterThan(v1)
    })
  })

  // The advisory lockfile closes the gap the compare-and-swap check alone
  // cannot: the window between save()'s own re-read and its rename, where a
  // second concurrent save() could otherwise still land a write. Acquire
  // timeout and staleness threshold are overridden to small numbers here so
  // these tests run fast without changing the logic under test.
  describe("advisory lock (docs/known-issues.md #8)", () => {
    const lockPathFor = (sessionID: string) =>
      path.join(dir, ".km", "gate", `${recordName(sessionID)}.json.lock`)

    test("leaves no lockfile behind after a save", () => {
      const s = store()
      s.save("sess-1", { ...INITIAL_STATE, edited: true }, 0)
      expect(fs.readdirSync(path.join(dir, ".km", "gate")).filter((f) => f.endsWith(".lock"))).toBeEmpty()
    })

    test("a live lock from another process makes save() degrade to unlocked rather than throw or hang", () => {
      const s = new FileStateStore(path.join(dir, ".km", "gate"), 30, 2_000)
      s.save("sess-1", { ...INITIAL_STATE, edited: true }, 0)
      const loaded = s.load("sess-1")

      // Simulate another process actively holding the lock: fresh mtime, so
      // it must not be reclaimed as stale.
      const lockPath = lockPathFor("sess-1")
      fs.writeFileSync(lockPath, "")

      const started = Date.now()
      expect(() => s.save("sess-1", { ...loaded, round: 1 }, loaded.updatedAt)).not.toThrow()
      // Bounded by the 30ms acquire timeout above, not a hang.
      expect(Date.now() - started).toBeLessThan(1_000)

      // The save still landed — degraded to the CAS-only path, not refused.
      expect(s.load("sess-1").round).toBe(1)
      // The lock this store never acquired is untouched — it does not
      // release a lock it does not own.
      expect(fs.existsSync(lockPath)).toBe(true)
    })

    test("a stale lock from a killed process is reclaimed rather than blocking forever", () => {
      const s = new FileStateStore(path.join(dir, ".km", "gate"), 500, 20)
      s.save("sess-1", { ...INITIAL_STATE, edited: true }, 0)
      const loaded = s.load("sess-1")

      const lockPath = lockPathFor("sess-1")
      // A real, now-exited pid — spawnSync blocks until it's gone, so
      // process.kill(dead, 0) is guaranteed ESRCH below.
      const dead = spawnSync(process.execPath, ["--version"]).pid!
      fs.writeFileSync(lockPath, String(dead))
      const old = new Date(Date.now() - 1_000)
      fs.utimesSync(lockPath, old, old) // older than the 20ms staleness threshold above

      s.save("sess-1", { ...loaded, round: 1 }, loaded.updatedAt)
      expect(s.load("sess-1").round).toBe(1)
      // Reclaimed — old AND its recorded holder confirmed dead — then
      // released again after this store's own use: no leftover, unlike the
      // live-lock case above.
      expect(fs.existsSync(lockPath)).toBe(false)
    })

    // docs/known-issues.md #8, defect 2: age alone is not enough to reclaim
    // a lock — a holder can be merely slow rather than dead (a disk stall,
    // scheduler preemption, a throttled cgroup, all realistic under WSL2).
    // Stealing a live holder's lock on age alone would let two commit()
    // calls run concurrently, both passing their own compare-and-swap —
    // the exact lost update this lock exists to prevent, now masked by an
    // apparently successful lock cycle.
    test("an old lock whose holder is still alive is not reclaimed, even past the staleness threshold", () => {
      const s = new FileStateStore(path.join(dir, ".km", "gate"), 30, 20)
      s.save("sess-1", { ...INITIAL_STATE, edited: true }, 0)
      const loaded = s.load("sess-1")

      const lockPath = lockPathFor("sess-1")
      fs.writeFileSync(lockPath, String(process.pid)) // this test process — definitely alive
      const old = new Date(Date.now() - 1_000)
      fs.utimesSync(lockPath, old, old) // older than the 20ms staleness threshold, but the holder is not dead

      // Still saves — degrades to the CAS-only unlocked path once the 30ms
      // acquire timeout above elapses, exactly like the live-lock test above.
      s.save("sess-1", { ...loaded, round: 1 }, loaded.updatedAt)
      expect(s.load("sess-1").round).toBe(1)
      // Age alone did not win: the lock is untouched, because its recorded
      // holder is still alive. Age-only reclaim would have stolen it here.
      expect(fs.existsSync(lockPath)).toBe(true)
    })

    test("a filesystem that rejects the lock operation outright still saves, unlocked", () => {
      const s = store()
      s.save("sess-1", { ...INITIAL_STATE, edited: true }, 0)
      const loaded = s.load("sess-1")

      // Only the lockfile write is rejected — the real record write (a
      // different path) must still go through unmocked.
      const realWriteFileSync = fs.writeFileSync as (...args: unknown[]) => unknown
      const writeFileSync = spyOn(fs, "writeFileSync").mockImplementation(((file: unknown, ...rest: unknown[]) => {
        if (typeof file === "string" && file.endsWith(".lock")) {
          throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
        }
        return realWriteFileSync(file, ...rest)
      }) as typeof fs.writeFileSync)
      try {
        expect(() => s.save("sess-1", { ...loaded, round: 1 }, loaded.updatedAt)).not.toThrow()
      } finally {
        writeFileSync.mockRestore()
      }
      expect(s.load("sess-1").round).toBe(1)
    })
  })

  // A session in flight across an upgrade must not lose its armed state.
  test("a record written before checkMs existed loads as armed with no round times", () => {
    const store = new FileStateStore(dir)
    const legacy: Record<string, unknown> = { ...INITIAL_STATE, edited: true }
    delete legacy.checkMs
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${recordName("s")}.json`), JSON.stringify(legacy))

    const loaded = store.load("s")
    expect(loaded.edited).toBe(true)
    expect(loaded.checkMs).toEqual([])
  })
})

describe("NdjsonSensorSink", () => {
  const line = (over: Partial<SensorLine> = {}): SensorLine => ({
    ts: 1,
    sessionID: "s",
    check: "bun test",
    accepted: true,
    gateExhausted: false,
    interrupted: false,
    rounds: ["accepted"],
    durationMs: 1,
    host: "h",
    app: "a",
    marker: false,
    ...over,
  })

  test("creates missing directories and appends one JSON line per call", () => {
    const sink = new NdjsonSensorSink(dir)
    sink.append(line({ ts: 1 }), ".km/gate-outcomes.ndjson")
    sink.append(line({ ts: 2 }), ".km/gate-outcomes.ndjson")

    const contents = fs.readFileSync(path.join(dir, ".km", "gate-outcomes.ndjson"), "utf8")
    const lines = contents.trimEnd().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => (JSON.parse(l) as SensorLine).ts)).toEqual([1, 2])
  })

  test("honours the path it is handed", () => {
    new NdjsonSensorSink(dir).append(line(), "logs/nested/deep.ndjson")
    expect(fs.existsSync(path.join(dir, "logs", "nested", "deep.ndjson"))).toBe(true)
  })

  test("refuses a path that escapes the root instead of writing outside it", () => {
    const sink = new NdjsonSensorSink(dir)
    expect(() => sink.append(line(), "../escaped.ndjson")).toThrow()
    expect(fs.existsSync(path.join(path.dirname(dir), "escaped.ndjson"))).toBe(false)
  })

  test("appends to an existing file rather than truncating it", () => {
    const file = path.join(dir, "s.ndjson")
    fs.writeFileSync(file, '{"pre":true}\n')
    new NdjsonSensorSink(dir).append(line(), "s.ndjson")
    expect(fs.readFileSync(file, "utf8").trimEnd().split("\n")).toHaveLength(2)
  })
})

describe("createNodeHost", () => {
  test("assembles a host with the caller's app identity", () => {
    const host = createNodeHost({ root: dir, app: "opencode" })
    expect(host.info.app).toBe("opencode")
    expect(host.info.host).toBeString()
    expect(host.info.host.length).toBeGreaterThan(0)
  })

  test("supplies every port the kernel requires", () => {
    const host = createNodeHost({ root: dir, app: "claude-code" })
    expect(typeof host.config.read).toBe("function")
    expect(typeof host.state.load).toBe("function")
    expect(typeof host.state.save).toBe("function")
    expect(typeof host.sensor.append).toBe("function")
    expect(typeof host.check.run).toBe("function")
    expect(typeof host.clock.now).toBe("function")
    expect(typeof host.logger.log).toBe("function")
  })

  test("wires the clock to real time", () => {
    const host = createNodeHost({ root: dir, app: "x" })
    expect(host.clock.now()).toBeGreaterThan(1_700_000_000_000)
  })

  test("stores state under .km/gate inside the given root", () => {
    const host = createNodeHost({ root: dir, app: "x" })
    host.state.save("sess-1", { ...INITIAL_STATE, edited: true }, 0)
    expect(fs.existsSync(path.join(dir, ".km", "gate"))).toBe(true)
  })

  test("a logger failure is the caller's problem, not the kernel's — it must not throw here", () => {
    const host = createNodeHost({ root: dir, app: "x" })
    // Captured, not silenced: StderrLogger really writes, and letting it
    // write here leaks a bare "hello" into every test run's output where it
    // is indistinguishable from a real diagnostic (docs/known-issues.md #7).
    // Asserting on the spy also makes this test prove delivery, which the
    // not-to-throw assertion alone never did.
    const write = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      expect(() => host.logger.log("hello")).not.toThrow()
      // Assert INSIDE the try: mockRestore() clears the call record, so
      // asserting after the finally sees zero calls and fails.
      expect(write).toHaveBeenCalledTimes(1)
      expect(String(write.mock.calls[0]![0])).toBe("hello\n")
    } finally {
      write.mockRestore()
    }
  })
})
