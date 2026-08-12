// The adapter contract. This file is the entire surface between a harness and
// the kernel: harnesses translate their own hook payloads into GateEvent, and
// translate GateDecision back into whatever their protocol expects.
//
// Nothing here may import anything. It is types only, so both the pure kernel
// and the harness adapters can depend on it without either depending on the
// other.

/** Result of one gate cycle round. */
export type RoundOutcome = "accepted" | "verify-failed"

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
  /**
   * Distinct paths edited this cycle (A1), as reported by the harness —
   * absent entirely on a harness that reports no paths (opencode). Bounded
   * by `TOUCHED_PATHS_CAP` (state.ts); `touchedTruncated` records that the
   * cap was hit and the set is partial. Paths live ONLY here, in local
   * gitignored state — they are never emitted on a sensor line, only the
   * booleans derived from them (`SensorLine.implOnly`/`sameTurnCoEdit`).
   */
  touchedPaths: string[]
  touchedTruncated: boolean
  updatedAt: number
}

/** Parsed gate.json. */
export interface GateConfig {
  /** Shell command to run. Required; a config without one no-ops the gate. */
  check: string
  /** Maximum blocks per cycle. `rounds + 1` failing checks ends the cycle. */
  rounds: number
  /** Sensor path, relative to the host-supplied root (for Claude Code, the hook payload's cwd). */
  sensor: string
  /** Hard cap on a single check run. */
  checkTimeoutMs: number
  /**
   * Off by default. When on, a clean accept both stamps `SensorLine.marker`
   * and returns a hygiene countermand (`GateDecision.marker`) for the
   * agent's own context — advisory: it counters residue of the just-closed
   * cycle's check evidence without being an instruction for whatever comes
   * next. Never fires on exhaustion or on an interrupted/skipped line, even
   * with this on. Matches the frozen contract's own config field and
   * semantics (meta-harness cc-gate-plugin `GateConfig.marker` /
   * `src/core/stop.ts` / README) — a same-cycle accept-time injection, NOT
   * cross-session persistence.
   */
  marker: boolean
  /**
   * Regex source (case-insensitive) classifying a path as a test path for
   * the A1 cycle-tagging sensors (`implOnly`/`sameTurnCoEdit`) — see
   * `src/kernel/classify.ts`. A HEURISTIC: it never influences a gate
   * decision, only these telemetry booleans. Defaults to
   * `DEFAULT_TEST_PATH_PATTERN`; parsed with the same never-throw discipline
   * as every other field here (a malformed value falls back to the default).
   */
  testPathPattern: string
}

/** One append-only sensor line, written once per completed gate cycle. */
export interface SensorLine {
  ts: number
  sessionID: string
  check: string
  /** True whenever the stop was ultimately allowed through. */
  accepted: boolean
  /**
   * True when the rounds budget ran out rather than the check passing.
   * Also true on an `interrupted` line, even though the budget did not
   * actually run out — deliberate schema parity with the frozen contract
   * (`cc-gate-plugin/src/core/prompt.ts`'s `handleUserPromptSubmit`,
   * whose own comment calls `accepted:true + gateExhausted:true` on
   * preemption "deliberate schema parity, not a bug"), not an oversight
   * in this kernel's `onNewUserPrompt`.
   */
  gateExhausted: boolean
  /**
   * True when a new user prompt preempted an open cycle, OR when it arrived
   * on an armed-but-never-cycled session (see `skippedStop`) — in both cases
   * a prompt is why this line exists rather than a stop.
   */
  interrupted: boolean
  rounds: RoundOutcome[]
  durationMs: number
  host: string
  app: string
  /**
   * The `GateConfig.rounds` budget this cycle was measured against — the
   * denominator `rounds` (the outcomes) was bounded by. Without it, streams
   * from windows with different `rounds` settings pool silently and an
   * exhaustion-rate change cannot be attributed to agent behaviour vs a
   * config edit. Optional on the contract (tolerated-absent, like
   * `pluginVersion`): lines written before this field existed do not carry
   * it. This kernel always has the value in hand, so it stamps every line —
   * including a literal `0` for observe-only configs.
   */
  roundsMax?: number
  /**
   * Per-round check execution time in ms, parallel to `rounds` — except for
   * a cycle already in flight when this field was introduced, whose
   * `checkMs` starts empty and so can be shorter than `rounds` for that one
   * straddling cycle. Optional: lines written before this field existed do
   * not carry it at all.
   */
  checkMs?: number[]
  /**
   * Present and true only on a diagnostic line: a new user prompt consumed the
   * turn boundary while the session was armed, so no stop was ever delivered
   * and no check ran. `rounds` is empty on such a line.
   */
  skippedStop?: boolean
  /**
   * True iff this cycle injected a hygiene marker: `GateConfig.marker` was
   * on and the round was a clean accept. Always false on exhaustion or an
   * interrupted/skipped line, even with the config toggle on — see
   * `GateConfig.marker`'s doc comment for the full rule and `gate.ts` for
   * where each caller sets this.
   *
   * CORRECTION (this kernel's own prior doc comment here, and once a task
   * prompt reflecting it, both described this as a "session-carryover"
   * flag persisted across process boundaries — checked directly against
   * the frozen contract's source, meta-harness `cc-gate-plugin/src/
   * core/stop.ts` and README, and that mechanism does not exist there.
   * `marker` is a same-cycle, same-session accept-time toggle; nothing
   * about it is ever written to or read from disk across sessions.
   */
  marker: boolean
  /**
   * kkamak kernel version that emitted this line, e.g. "0.3.1" — this
   * kernel's own `package.json` version (`KERNEL_VERSION` in sensor.ts),
   * never the harness's. Optional on the frozen contract because a producer
   * may be unable to determine its own version; this kernel always can, so
   * `buildSensorLine` always stamps it. D1 (closed): adopted from the
   * packaging-milestone deferral.
   */
  pluginVersion?: string
  /**
   * Which codebase emitted this line — this kernel's `package.json` name
   * (`KERNEL_PRODUCT` in sensor.ts), always stamped, never configurable.
   * `pluginVersion` cannot carry this: a differently-sourced implementation
   * can declare the same plugin name and overlapping versions while writing
   * to the same sensor path, leaving version alone unable to attribute a
   * line. Optional on the frozen contract (tolerated-absent, like
   * `pluginVersion`); this kernel always stamps it. Presence, not value, is
   * the discriminator against producers that predate the field.
   */
  product?: string
  /**
   * True iff an env override forced this session's reinject arm rather than
   * being chosen normally. The frozen contract's `forced` covers
   * KKAMAK_REINJECT ONLY (cc-gate-plugin/src/types.ts) — this kernel has no
   * reinject-arm mechanism at all, so nothing here can set it today; it is
   * plumbed through `SensorArgs` so a future reinject feature can, matching
   * the contract's optionality (absent means not forced; a stored `false`
   * is never written, same convention as `skippedStop`). D1 (closed):
   * adopted from the packaging-milestone deferral.
   */
  forced?: boolean
  /**
   * The cycle touched source files and no test files, by the heuristic path
   * classifier (`src/kernel/classify.ts`). A1 cycle tagging. Optional:
   * absent when there is nothing to compute it from — no paths known (an
   * opencode line, or a pre-A1 record) or the touched set was hit-and-run
   * before this field could be trusted; see `sameTurnCoEdit`'s doc comment
   * for the truncation reasoning shared by both. Never a raw path: only
   * this derived boolean ever reaches the sensor line — a hard privacy
   * line, since the sensor file is a durable, non-gitignored artifact and
   * file paths are user data.
   */
  implOnly?: boolean
  /**
   * The cycle touched both source and test files in the same turn —
   * implementation and its tests authored together, the exact shape behind
   * both real defects the gate missed (see docs/dogfood-log.md). A1 cycle
   * tagging, by the same heuristic classifier as `implOnly`.
   *
   * Absent, not `false`, whenever the touched-paths set could not be
   * trusted to answer the question: no paths known at all (opencode; a
   * pre-A1 record), or `GateState.touchedTruncated` is set — a truncated
   * set has already dropped touched paths, so no test path seen among what
   * remains cannot be told apart from no test path ever having been
   * touched, and a field that can be silently wrong is worse than one that
   * is absent. Both booleans follow this rule identically since they are
   * computed from the same set.
   *
   * Also absent on a `skippedStop` diagnostic line specifically — not on
   * every `interrupted` line: a cycle preempted mid-flight (`interrupted`
   * true, `skippedStop` absent) still tags from what was touched before
   * preemption, since that reset is the cycle's genuine end. Only the
   * `skippedStop` shape (armed but never reached a stop; see its own doc
   * comment) has a not-yet-final touched set, which is why gate.ts omits
   * `cycleTags()` there specifically. See the callers in gate.ts for the
   * per-line-shape reasoning.
   */
  sameTurnCoEdit?: boolean
}

// ── Events in ───────────────────────────────────────────────────────────────
//
// Which harness tool counts as a file edit is the adapter's business. The
// kernel never sees a tool name, a hook name, or a harness payload.

export type GateEvent =
  | { kind: "file-edited"; sessionID: string; path?: string }
  | { kind: "stop-requested"; sessionID: string }
  | { kind: "new-user-prompt"; sessionID: string }

// ── Decisions out ───────────────────────────────────────────────────────────

/**
 * `evidence` is the check's raw output and nothing else — framing prose is the
 * adapter's job, since each harness delivers a block differently. `notice`
 * carries allow-path messages that still need to reach the user (exhausted,
 * disarmed). `marker` carries a hygiene countermand for the agent's own
 * context — present only when `GateConfig.marker` is on and this cycle just
 * cleanly accepted (see `GateConfig.marker`'s doc comment); never set
 * alongside `notice`, and never on exhaustion.
 */
export type GateDecision =
  | { kind: "allow"; notice?: string; marker?: string }
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
  load(sessionID: string): GateState
  /**
   * Optimistic concurrency control (docs/known-issues.md #8). `expectedUpdatedAt`
   * is the `updatedAt` of the `GateState` the caller's decision was computed
   * from — what `load()` returned right before this call chain began. `0`
   * (`INITIAL_STATE.updatedAt`) doubles as the "no record existed at load
   * time" sentinel, since a real record's `updatedAt` is a wall-clock ms
   * stamp and can never be 0.
   *
   * Implementations MUST verify, immediately before committing, that what is
   * currently persisted still carries that same `updatedAt` (or is still
   * absent, for the `0` sentinel) — and throw rather than commit on a
   * mismatch, so a write based on a stale read can never clobber a write
   * that landed after that read. This is not a new failure mode: `save()`
   * was already allowed to throw (full disk, permissions), and the kernel
   * already treats any `save()` failure as fail-open (`gate.ts`'s
   * `persist`). A version conflict is reported through that same path.
   */
  save(sessionID: string, state: GateState, expectedUpdatedAt: number): void
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
  /**
   * The harness's kill ceiling on the stop-handling process, in ms — for
   * Claude Code, the Stop hook's manifest timeout, after which the whole
   * hook is SIGKILLed. Host-supplied data, not an effect, so kernel purity
   * holds. Absent when the harness has no such ceiling (opencode's
   * session.idle): absent means "never clamp", not "unknown ceiling".
   */
  stopTimeoutMs?: number
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
