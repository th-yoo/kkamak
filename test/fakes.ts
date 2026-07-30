// In-memory fakes for every port, so the state machine is tested with no
// filesystem, no subprocess and no harness.
import { INITIAL_STATE } from "../src/kernel/state.ts"
import type {
  CheckResult,
  GateHost,
  GateState,
  HostInfo,
  SensorLine,
} from "../src/kernel/ports.ts"

/** A check runner driven by a scripted sequence of results or thrown errors. */
export class FakeCheck {
  readonly calls: { command: string; timeoutMs: number }[] = []
  private script: (CheckResult | Error)[]
  /** Used once the script runs dry, so tests only script what they care about. */
  constructor(script: (CheckResult | Error)[], private readonly fallback: CheckResult | Error = { code: 0, output: "" }) {
    this.script = [...script]
  }

  async run(command: string, timeoutMs: number): Promise<CheckResult> {
    this.calls.push({ command, timeoutMs })
    const next = this.script.shift() ?? this.fallback
    if (next instanceof Error) throw next
    return next
  }
}

/** Counts reads so a test can prove the kernel re-reads config every event. */
export class FakeConfig {
  reads = 0
  constructor(public raw: string | undefined) {}
  read(): string | undefined {
    this.reads++
    return this.raw
  }
}

export class FakeStore {
  readonly saves: { sessionId: string; state: GateState }[] = []
  private records = new Map<string, GateState>()

  load(sessionId: string): GateState {
    return { ...(this.records.get(sessionId) ?? INITIAL_STATE) }
  }

  save(sessionId: string, state: GateState): void {
    this.records.set(sessionId, { ...state })
    this.saves.push({ sessionId, state: { ...state } })
  }

  /** Test-only peek that does not go through load()'s copying. */
  peek(sessionId: string): GateState | undefined {
    return this.records.get(sessionId)
  }
}

export class FakeSensor {
  readonly lines: SensorLine[] = []
  readonly paths: string[] = []
  append(line: SensorLine, relativePath: string): void {
    this.lines.push(line)
    this.paths.push(relativePath)
  }
}

export class FakeLogger {
  readonly messages: string[] = []
  log(message: string): void {
    this.messages.push(message)
  }
}

/** Advances by `step` on every read, so durations are observable. */
export class FakeClock {
  constructor(private t = 1_000, private readonly step = 0) {}
  now(): number {
    const current = this.t
    this.t += this.step
    return current
  }
  set(t: number): void {
    this.t = t
  }
}

export interface Harness {
  host: GateHost
  config: FakeConfig
  check: FakeCheck
  store: FakeStore
  sensor: FakeSensor
  logger: FakeLogger
  clock: FakeClock
}

export function makeHarness(opts: {
  raw?: string | undefined
  script?: (CheckResult | Error)[]
  fallback?: CheckResult | Error
  clock?: FakeClock
  info?: HostInfo
} = {}): Harness {
  const config = new FakeConfig("raw" in opts ? opts.raw : '{"check":"bun test"}')
  const check = new FakeCheck(opts.script ?? [], opts.fallback)
  const store = new FakeStore()
  const sensor = new FakeSensor()
  const logger = new FakeLogger()
  const clock = opts.clock ?? new FakeClock()

  return {
    config,
    check,
    store,
    sensor,
    logger,
    clock,
    host: {
      info: opts.info ?? { app: "test-app", host: "test-host" },
      config,
      state: store,
      sensor,
      check,
      clock,
      logger,
    },
  }
}

export const PASS: CheckResult = { code: 0, output: "ok\n" }
export const FAIL: CheckResult = { code: 1, output: "2 tests failed\n" }
