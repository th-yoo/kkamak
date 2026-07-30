import { afterEach, beforeEach, describe, expect, test } from "bun:test"
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

  test("reads gate.json from the repo root", () => {
    fs.writeFileSync(path.join(dir, "gate.json"), '{"check":"bun test"}')
    expect(new FileConfigSource(dir).read()).toBe('{"check":"bun test"}')
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
    s.save("sess-1", saved)
    expect(s.load("sess-1")).toMatchObject({
      edited: true,
      gating: true,
      round: 2,
      outcomes: ["verify-failed", "verify-failed"],
    })
  })

  test("stamps updatedAt on save", () => {
    const s = store()
    s.save("sess-1", { ...INITIAL_STATE, edited: true })
    expect(s.load("sess-1").updatedAt).toBeGreaterThan(0)
  })

  test("keeps sessions apart", () => {
    const s = store()
    s.save("a", { ...INITIAL_STATE, edited: true })
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
    s.save("sess-1", { ...INITIAL_STATE, edited: true })
    const file = fs.readdirSync(path.join(dir, ".km", "gate")).find((f) => f.endsWith(".json"))!
    fs.writeFileSync(path.join(dir, ".km", "gate", file), contents)
    expect(s.load("sess-1")).toEqual(INITIAL_STATE)
  })

  // Absent means initial, so saving initial state should not litter the dir.
  test("deletes the record when state returns to initial", () => {
    const s = store()
    s.save("sess-1", { ...INITIAL_STATE, edited: true })
    expect(fs.readdirSync(path.join(dir, ".km", "gate"))).not.toBeEmpty()
    s.save("sess-1", { ...INITIAL_STATE })
    expect(fs.readdirSync(path.join(dir, ".km", "gate")).filter((f) => f.endsWith(".json"))).toBeEmpty()
  })

  test("persists a disarmed session, which is not initial-equivalent", () => {
    const s = store()
    s.save("sess-1", { ...INITIAL_STATE, disarmed: true, errorStreak: 3 })
    expect(s.load("sess-1").disarmed).toBe(true)
  })

  test("leaves no temp files behind after a save", () => {
    const s = store()
    s.save("sess-1", { ...INITIAL_STATE, edited: true })
    expect(fs.readdirSync(path.join(dir, ".km", "gate")).filter((f) => f.endsWith(".tmp"))).toBeEmpty()
  })

  // A harness-supplied session id is untrusted input.
  test("cannot be talked into escaping its directory", () => {
    const s = store()
    s.save("../../escaped", { ...INITIAL_STATE, edited: true })
    expect(fs.existsSync(path.join(dir, "escaped.json"))).toBe(false)
    expect(s.load("../../escaped").edited).toBe(true)
    const entries = fs.readdirSync(path.join(dir, ".km", "gate"))
    expect(entries).toHaveLength(1)
    expect(entries[0]).not.toContain("/")
  })

  test("does not confuse two ids that sanitise alike", () => {
    const s = store()
    s.save("a/b", { ...INITIAL_STATE, edited: true, round: 1 })
    s.save("a:b", { ...INITIAL_STATE, edited: true, round: 2 })
    expect(s.load("a/b").round).toBe(1)
    expect(s.load("a:b").round).toBe(2)
  })

  test("round times survive a save/load round trip", () => {
    const store = new FileStateStore(dir)
    store.save("s", { ...INITIAL_STATE, edited: true, gating: true, round: 1, outcomes: ["verify-failed"], checkMs: [1_234] })
    expect(store.load("s").checkMs).toEqual([1_234])
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
    host.state.save("sess-1", { ...INITIAL_STATE, edited: true })
    expect(fs.existsSync(path.join(dir, ".km", "gate"))).toBe(true)
  })

  test("a logger failure is the caller's problem, not the kernel's — it must not throw here", () => {
    const host = createNodeHost({ root: dir, app: "x" })
    expect(() => host.logger.log("hello")).not.toThrow()
  })
})
