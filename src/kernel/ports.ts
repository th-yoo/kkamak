// The adapter contract. This file is the entire surface between a harness and
// the kernel: harnesses translate their own hook payloads into GateEvent, and
// translate GateDecision back into whatever their protocol expects.
//
// Nothing here may import anything. It is types only, so both the pure kernel
// and the harness adapters can depend on it without either depending on the
// other.

/** Result of one gate cycle round. */
export type RoundOutcome = "passed" | "failed"

/** Per-session persisted state. One record per session id. */
export interface GateState {
  v: 1
  /** A file was edited at some point this session. */
  edited: boolean
  /** A gate cycle is currently open (at least one block has been issued). */
  gating: boolean
  /** Blocks issued in the open cycle. */
  round: number
  outcomes: RoundOutcome[]
  /**
   * Wall-clock ms of each round's check run, parallel to `outcomes`. Cycle
   * duration includes agent and human wait time; this does not.
   */
  checkMs: number[]
  cycleStartedAt: number
  /** Consecutive internal errors (check crashed, not check failed). */
  errorStreak: number
  /** Terminal for this session: the gate gave up and allows everything. */
  disarmed: boolean
  updatedAt: number
}

/** Parsed gate.json. */
export interface GateConfig {
  /** Shell command to run. Required; a config without one no-ops the gate. */
  check: string
  /** Maximum blocks per cycle. `rounds + 1` failing checks ends the cycle. */
  rounds: number
  /** Sensor path, relative to the repo root. */
  sensor: string
  /** Hard cap on a single check run. */
  checkTimeoutMs: number
}

/** One append-only sensor line, written once per completed gate cycle. */
export interface SensorLine {
  ts: number
  sessionId: string
  check: string
  /** True whenever the stop was ultimately allowed through. */
  accepted: boolean
  /** True when the rounds budget ran out rather than the check passing. */
  gateExhausted: boolean
  /** True when a new user prompt preempted an open cycle. */
  interrupted: boolean
  rounds: RoundOutcome[]
  durationMs: number
  host: string
  app: string
  /**
   * Per-round check execution time in ms, parallel to `rounds`. Optional: lines
   * written before this field existed do not carry it.
   */
  checkMs?: number[]
  /**
   * Present and true only on a diagnostic line: a new user prompt consumed the
   * turn boundary while the session was armed, so no stop was ever delivered
   * and no check ran. `rounds` is empty on such a line.
   */
  skippedStop?: boolean
}

// ── Events in ───────────────────────────────────────────────────────────────
//
// Which harness tool counts as a file edit is the adapter's business. The
// kernel never sees a tool name, a hook name, or a harness payload.

export type GateEvent =
  | { kind: "file-edited"; sessionId: string }
  | { kind: "stop-requested"; sessionId: string }
  | { kind: "new-user-prompt"; sessionId: string }

// ── Decisions out ───────────────────────────────────────────────────────────

/**
 * `evidence` is the check's raw output and nothing else — framing prose is the
 * adapter's job, since each harness delivers a block differently. `notice`
 * carries allow-path messages that still need to reach the user (exhausted,
 * disarmed).
 */
export type GateDecision =
  | { kind: "allow"; notice?: string }
  | { kind: "block"; evidence: string; round: number; roundsMax: number }

// ── Ports the host supplies ─────────────────────────────────────────────────

export interface CheckResult {
  code: number
  output: string
}

export interface CheckRunner {
  /** Rejecting means an internal error (spawn failed), NOT a failing check. */
  run(command: string, timeoutMs: number): Promise<CheckResult>
}

export interface StateStore {
  /** Never throws: absent, corrupt and wrong-shaped all read as initial state. */
  load(sessionId: string): GateState
  save(sessionId: string, state: GateState): void
}

export interface SensorSink {
  /**
   * `relativePath` comes from the config the kernel just read, so the sink
   * stays dumb about configuration and the escape hatch keeps working: change
   * `sensor` in gate.json and the next line lands in the new file.
   */
  append(line: SensorLine, relativePath: string): void
}

export interface ConfigSource {
  /** Raw gate.json text, or undefined if unreadable. Called once per event. */
  read(): string | undefined
}

export interface Clock {
  now(): number
}

export interface Logger {
  log(message: string): void
}

/** Identity of the running harness. `app` must never be a kernel constant. */
export interface HostInfo {
  /** Harness id, e.g. "claude-code" or "opencode". */
  app: string
  /** Machine hostname. */
  host: string
}

export interface GateHost {
  info: HostInfo
  config: ConfigSource
  state: StateStore
  sensor: SensorSink
  check: CheckRunner
  clock: Clock
  logger: Logger
}

export interface Gate {
  handle(event: GateEvent): Promise<GateDecision>
}
